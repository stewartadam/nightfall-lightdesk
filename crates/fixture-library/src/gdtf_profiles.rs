// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Owned, bounded piecewise cubic DMX profiles without an assumed inverse mapping.

use std::collections::HashMap;

use gdtf::physical_descriptions::DmxProfile;
use gdtf::values::Node;
use serde::Serialize;

use crate::gdtf_resolver::ResolveError;

/// Polynomial coefficients relative to a percentage breakpoint.
#[derive(Debug, Serialize)]
struct CurvePoint {
    percentage: f64,
    coefficients: [f64; 4],
}

/// Validated profile whose points are sorted and cannot be mutated after compilation.
#[derive(Debug, Serialize)]
pub struct Profile {
    name: String,
    points: Vec<CurvePoint>,
}

/// Owned profiles with exact source-name lookup for subsequent function compilation.
#[derive(Debug, Serialize)]
pub struct ProfileLibrary {
    profiles: Vec<Profile>,
    #[serde(skip)]
    indices: HashMap<String, usize>,
}

/// Attach a stable diagnostic to a profile or reference link.
fn error(code: &'static str, path: &str, message: &str) -> ResolveError {
    ResolveError {
        code,
        path: path.into(),
        message: message.into(),
    }
}

/// Validate profiles, reject duplicate identities/points, and bound the total point count.
pub fn compile_profiles(
    sources: &[DmxProfile],
    point_limit: usize,
) -> Result<ProfileLibrary, ResolveError> {
    let mut count = 0usize;
    let mut profiles = Vec::with_capacity(sources.len());
    let mut indices = HashMap::new();
    for source in sources {
        let name = source
            .name
            .as_ref()
            .ok_or_else(|| {
                error(
                    "missing_profile_name",
                    "DMXProfiles",
                    "A profile requires a unique name",
                )
            })?
            .to_string();
        if indices.insert(name.clone(), profiles.len()).is_some() {
            return Err(error(
                "duplicate_profile",
                &name,
                "Profile names must be unique",
            ));
        }
        count = count
            .checked_add(source.points.len())
            .filter(|n| *n <= point_limit)
            .ok_or_else(|| {
                error(
                    "profile_point_limit",
                    &name,
                    "DMX profile points exceed the compilation budget",
                )
            })?;
        if source.points.is_empty() {
            return Err(error(
                "empty_profile",
                &name,
                "A profile requires at least one polynomial point",
            ));
        }
        let mut points = Vec::with_capacity(source.points.len());
        for point in &source.points {
            let coefficients = [point.cfc0, point.cfc1, point.cfc2, point.cfc3];
            if !point.dmx_percentage.is_finite()
                || !(0.0..=1.0).contains(&point.dmx_percentage)
                || coefficients.iter().any(|value| !value.is_finite())
            {
                return Err(error(
                    "invalid_profile_point",
                    &name,
                    "Breakpoints must be fractional percentages from 0 to 1 and all coefficients must be finite",
                ));
            }
            points.push(CurvePoint {
                percentage: point.dmx_percentage,
                coefficients,
            });
        }
        points.sort_by(|a, b| a.percentage.total_cmp(&b.percentage));
        if points
            .windows(2)
            .any(|pair| pair[0].percentage == pair[1].percentage)
        {
            return Err(error(
                "duplicate_profile_point",
                &name,
                "Two polynomial points cannot start at the same percentage",
            ));
        }
        profiles.push(Profile { name, points });
    }
    Ok(ProfileLibrary { profiles, indices })
}

impl ProfileLibrary {
    /// Resolve a single-component profile link without substituting a linear fallback.
    pub fn resolve(&self, link: &Node) -> Result<usize, ResolveError> {
        let [name] = link.as_ref() else {
            return Err(error(
                "invalid_profile_link",
                "DMXProfile",
                "A profile link must contain exactly one name",
            ));
        };
        self.indices.get(name.as_ref()).copied().ok_or_else(|| {
            error(
                "missing_profile",
                name.as_ref(),
                "Referenced DMX profile is missing",
            )
        })
    }

    /// Retrieve the immutable profile corresponding to a compiled link.
    pub fn get(&self, index: usize) -> Option<&Profile> {
        self.profiles.get(index)
    }
}

impl Profile {
    /// Normalize an inclusive raw interval through 32 bits before evaluating the curve.
    /// A one-value interval uses its starting point; values outside the interval are rejected.
    pub fn evaluate_raw(&self, raw: u32, from: u32, to: u32) -> Result<f64, ResolveError> {
        if from > to || raw < from || raw > to {
            return Err(error(
                "invalid_profile_raw_range",
                &self.name,
                "Raw value must lie within an ordered inclusive interval",
            ));
        }
        let fraction = if from == to {
            0.0
        } else {
            f64::from(raw - from) / f64::from(to - from)
        };
        self.evaluate_normalized(fraction)
    }

    /// Evaluate the greatest breakpoint at or below x, returning zero before the first point.
    ///
    /// Input uses fractional percentages (0–1); coefficients produce percentage output.
    /// The result is the authored polynomial value without clamping;
    /// physical Min/Max scaling and inversion belong to function mapping, not this curve.
    pub fn evaluate_normalized(&self, x: f64) -> Result<f64, ResolveError> {
        if !x.is_finite() || !(0.0..=1.0).contains(&x) {
            return Err(error(
                "invalid_profile_input",
                &self.name,
                "DMX fraction must be finite and between 0 and 1",
            ));
        }
        let Some(index) = self
            .points
            .partition_point(|point| point.percentage <= x)
            .checked_sub(1)
        else {
            return Ok(0.0);
        };
        let point = &self.points[index];
        let delta = x - point.percentage;
        let [c0, c1, c2, c3] = point.coefficients;
        let output = ((c3 * delta + c2) * delta + c1) * delta + c0;
        if !output.is_finite() {
            return Err(error(
                "profile_output_overflow",
                &self.name,
                "Polynomial evaluation produced a nonfinite value",
            ));
        }
        Ok(output)
    }
}
