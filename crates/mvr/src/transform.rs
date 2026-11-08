// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! MVR transformation matrices.
//!
//! MVR space is right-handed with Z up, and one unit is one millimetre. An object's
//! `Matrix` places it in its parent's coordinate system; the world transform is the
//! composition of every ancestor's matrix with the object's own.

use std::fmt;

/// An affine transform written as MVR's 4x3 `{u}{v}{w}{o}` matrix.
///
/// `u`, `v` and `w` are the object's local X, Y and Z axes expressed in the parent space
/// (they may carry scale), and `o` is the local origin in parent space, in millimetres. A
/// local point `p` maps to `p.x * u + p.y * v + p.z * w + o`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transform {
    /// Local X, Y and Z axes in parent space, in that order.
    pub axes: [[f64; 3]; 3],
    /// Local origin in parent space, in millimetres.
    pub origin: [f64; 3],
}

impl Default for Transform {
    /// Returns the identity transform, which MVR assumes when `Matrix` is missing.
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Transform {
    /// Transform that leaves every point where it is.
    pub const IDENTITY: Self = Self {
        axes: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        origin: [0.0, 0.0, 0.0],
    };

    /// Parses MVR matrix text such as `{1,0,0}{0,1,0}{0,0,1}{100,200,300}`.
    ///
    /// Whitespace anywhere in the text is ignored. Returns `None` when the text does not
    /// hold exactly four groups of three finite numbers.
    pub fn parse(text: &str) -> Option<Self> {
        let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        let inner = compact.strip_prefix('{')?.strip_suffix('}')?;
        let mut rows = [[0.0; 3]; 4];
        let mut count = 0;
        for group in inner.split("}{") {
            let row = rows.get_mut(count)?;
            let mut values = group.split(',');
            for slot in row.iter_mut() {
                let value: f64 = values.next()?.parse().ok()?;
                if !value.is_finite() {
                    return None;
                }
                *slot = value;
            }
            if values.next().is_some() {
                return None;
            }
            count += 1;
        }
        if count != 4 {
            return None;
        }
        Some(Self {
            axes: [rows[0], rows[1], rows[2]],
            origin: rows[3],
        })
    }

    /// Maps a direction from local space to parent space, ignoring the origin.
    pub fn apply_vector(&self, vector: [f64; 3]) -> [f64; 3] {
        let [u, v, w] = self.axes;
        std::array::from_fn(|i| vector[0] * u[i] + vector[1] * v[i] + vector[2] * w[i])
    }

    /// Maps a point from local space to parent space.
    pub fn apply_point(&self, point: [f64; 3]) -> [f64; 3] {
        let moved = self.apply_vector(point);
        std::array::from_fn(|i| moved[i] + self.origin[i])
    }

    /// Returns the transform of a child placed by `local` inside an object placed by `self`.
    ///
    /// The result maps the child's local space straight to `self`'s parent space, so
    /// folding this over a chain of ancestors from the outermost inwards yields world space.
    pub fn then(&self, local: &Transform) -> Transform {
        Transform {
            axes: local.axes.map(|axis| self.apply_vector(axis)),
            origin: self.apply_point(local.origin),
        }
    }

    /// Returns the length of each local axis, which is the scale along that axis.
    pub fn scale(&self) -> [f64; 3] {
        self.axes
            .map(|axis| axis.iter().map(|c| c * c).sum::<f64>().sqrt())
    }
}

impl fmt::Display for Transform {
    /// Writes the transform back in MVR matrix notation.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for row in self.axes.iter().chain(std::iter::once(&self.origin)) {
            write!(f, "{{{},{},{}}}", row[0], row[1], row[2])?;
        }
        Ok(())
    }
}
