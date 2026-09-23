// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Compile one exact mode into an owned, coherently indexed geometry and channel program.

use gdtf::fixture_type::FixtureType;
use serde::Serialize;

use crate::gdtf_channels::{ChannelLimits, CompiledChannels, compile_channels};
use crate::gdtf_geometry::{CompiledGeometry, compile_geometry};
use crate::gdtf_resolver::{ResolveError, ResolveLimits, resolve_mode};

/// Bounds for source expansion and owned mode construction.
#[derive(Debug, Clone, Copy)]
pub struct CompileLimits {
    /// Hierarchy and instantiated channel limits.
    pub resolution: ResolveLimits,
    /// Semantic table and mapping limits.
    pub channels: ChannelLimits,
    /// Maximum model declarations in the fixture.
    pub models: usize,
}

impl Default for CompileLimits {
    /// Use established corpus budgets for each compiler stage.
    fn default() -> Self {
        Self {
            resolution: ResolveLimits::default(),
            channels: ChannelLimits::default(),
            models: 100_000,
        }
    }
}

/// Owned mode data; immutable geometry and channel indices are compiled from the same expansion.
/// Archive identity, resolved resources and serialization versioning must wrap this before caching
/// or persisting it as a production fixture definition.
#[derive(Debug, Serialize)]
pub struct CompiledMode {
    name: String,
    geometry: CompiledGeometry,
    channels: CompiledChannels,
}

/// Resolve one selected root once, then publish geometry and channels only if all passes succeed.
pub fn compile_mode(
    fixture: &FixtureType,
    mode: &str,
    limits: CompileLimits,
) -> Result<CompiledMode, ResolveError> {
    let resolved = resolve_mode(fixture, mode, limits.resolution)?;
    let geometry = compile_geometry(&resolved, &fixture.models, limits.models)?;
    let channels = compile_channels(
        &resolved,
        &fixture.attribute_definitions,
        &fixture.physical_descriptions.dmx_profiles,
        limits.channels,
    )?;
    Ok(CompiledMode {
        name: resolved.name,
        geometry,
        channels,
    })
}

impl CompiledMode {
    /// Return the exact authored mode name, including significant whitespace.
    pub fn name(&self) -> &str {
        &self.name
    }
    /// Inspect expanded physical parts, effective models and joint links.
    pub fn geometry(&self) -> &CompiledGeometry {
        &self.geometry
    }
    /// Inspect and evaluate channel semantics with geometry indices from this same mode.
    pub fn channels(&self) -> &CompiledChannels {
        &self.channels
    }
}
