// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Converting MVR world transforms into Nightfall fixture placements.
//!
//! MVR is right-handed with Z up, in millimetres. Nightfall places fixtures in the
//! visualizer's space: right-handed with Y up, in metres, with +X to the audience's right
//! and +Z towards the audience. The axes map as `x = X`, `y = Z`, `z = -Y`.
//!
//! The visualizer builds a GDTF fixture in its own Z-up space and turns it upright with a
//! fixed -90 degree rotation about X, which is the same axis change. So a fixture whose
//! MVR rotation is `R` gets the placement rotation `C R Cᵀ`, where `C` is the axis change,
//! written as XYZ Euler angles in degrees.

use nightfall_fixtures::placement::{FixturePlacement, PlacementPosition, PlacementRotation};
use nightfall_mvr::prelude::Transform;

/// Matrix taking an MVR vector to Nightfall axes, row by row.
const AXIS_CHANGE: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]];

/// How far an axis length may stray from 1 before the transform counts as scaled.
const SCALE_TOLERANCE: f64 = 1e-3;

/// A converted placement and whether the source transform had to be adjusted.
#[derive(Debug, Clone, PartialEq)]
pub struct ConvertedPlacement {
    /// Position and rotation in Nightfall space.
    pub placement: FixturePlacement,
    /// Why the rotation is only an approximation of the source transform, if it is.
    pub warning: Option<String>,
}

/// Converts an object's MVR world transform into a Nightfall placement.
///
/// Scale is removed from the rotation because fixtures are drawn at their real size. A
/// scaled or mirrored transform still yields the nearest rotation, with a warning.
pub fn convert_transform(world: &Transform) -> ConvertedPlacement {
    let origin = world.origin;
    let position = PlacementPosition {
        x: (origin[0] / 1000.0) as f32,
        y: (origin[2] / 1000.0) as f32,
        z: (-origin[1] / 1000.0) as f32,
    };

    let scale = world.scale();
    let mut problems = Vec::new();
    if scale
        .iter()
        .any(|length| (length - 1.0).abs() > SCALE_TOLERANCE)
    {
        problems.push(format!(
            "scaled by {:.3} x {:.3} x {:.3}; the scale was ignored",
            scale[0], scale[1], scale[2]
        ));
    }
    let mut rotation = column_matrix(world, scale);
    if determinant(&rotation) < 0.0 {
        problems.push("mirrored; placed without the mirroring".to_string());
        for row in &mut rotation {
            row[0] = -row[0];
        }
    }

    let nightfall = multiply(&multiply(&AXIS_CHANGE, &rotation), &transpose(&AXIS_CHANGE));
    let [x, y, z] = euler_xyz_degrees(&nightfall);
    ConvertedPlacement {
        placement: FixturePlacement {
            position,
            rotation: PlacementRotation {
                x: x as f32,
                y: y as f32,
                z: z as f32,
            },
        },
        warning: (!problems.is_empty()).then(|| problems.join(", and ")),
    }
}

/// Returns the rotation part of a transform as a matrix whose columns are the unit-length
/// local axes. A zero-length axis keeps the identity column.
fn column_matrix(world: &Transform, scale: [f64; 3]) -> [[f64; 3]; 3] {
    let mut matrix = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for (column, axis) in world.axes.iter().enumerate() {
        if scale[column] <= f64::EPSILON {
            continue;
        }
        for (row, value) in axis.iter().enumerate() {
            matrix[row][column] = value / scale[column];
        }
    }
    matrix
}

/// Multiplies two 3x3 matrices.
fn multiply(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    std::array::from_fn(|row| {
        std::array::from_fn(|column| (0..3).map(|k| a[row][k] * b[k][column]).sum())
    })
}

/// Transposes a 3x3 matrix.
fn transpose(matrix: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    std::array::from_fn(|row| std::array::from_fn(|column| matrix[column][row]))
}

/// Returns the determinant of a 3x3 matrix.
fn determinant(m: &[[f64; 3]; 3]) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

/// Decomposes a rotation matrix into XYZ Euler angles in degrees, the order three.js uses
/// for `Euler(x, y, z, "XYZ")` (the matrix is `Rx · Ry · Rz`).
///
/// At gimbal lock (Y at ±90 degrees) the Z angle is set to 0 and X takes the whole
/// remaining rotation, as three.js does.
fn euler_xyz_degrees(m: &[[f64; 3]; 3]) -> [f64; 3] {
    let y = m[0][2].clamp(-1.0, 1.0).asin();
    let (x, z) = if m[0][2].abs() < 0.999_999_9 {
        ((-m[1][2]).atan2(m[2][2]), (-m[0][1]).atan2(m[0][0]))
    } else {
        (m[2][1].atan2(m[1][1]), 0.0)
    };
    [x, y, z].map(|angle| clean_degrees(angle.to_degrees()))
}

/// Rounds away floating-point noise so axis-aligned rigs read as whole degrees, and folds
/// -180 to 180.
fn clean_degrees(degrees: f64) -> f64 {
    let rounded = (degrees * 1e6).round() / 1e6;
    if rounded == -180.0 {
        180.0
    } else if rounded == 0.0 {
        0.0
    } else {
        rounded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a transform from its local axes and origin in MVR notation.
    fn transform(axes: [[f64; 3]; 3], origin: [f64; 3]) -> Transform {
        Transform { axes, origin }
    }

    /// Rotates an MVR rotation matrix given as columns into Nightfall space and back into
    /// a three.js `Rx · Ry · Rz` matrix, checking the Euler angles reproduce it.
    fn assert_round_trip(axes: [[f64; 3]; 3]) {
        let converted = convert_transform(&transform(axes, [0.0; 3]));
        let rotation = converted.placement.rotation;
        let [x, y, z] = [rotation.x, rotation.y, rotation.z].map(|d| f64::from(d).to_radians());
        let rx = [
            [1.0, 0.0, 0.0],
            [0.0, x.cos(), -x.sin()],
            [0.0, x.sin(), x.cos()],
        ];
        let ry = [
            [y.cos(), 0.0, y.sin()],
            [0.0, 1.0, 0.0],
            [-y.sin(), 0.0, y.cos()],
        ];
        let rz = [
            [z.cos(), -z.sin(), 0.0],
            [z.sin(), z.cos(), 0.0],
            [0.0, 0.0, 1.0],
        ];
        let rebuilt = multiply(&multiply(&rx, &ry), &rz);
        let source = transpose(&axes);
        let expected = multiply(&multiply(&AXIS_CHANGE, &source), &transpose(&AXIS_CHANGE));
        for row in 0..3 {
            for column in 0..3 {
                assert!(
                    (rebuilt[row][column] - expected[row][column]).abs() < 1e-5,
                    "{rebuilt:?} != {expected:?}"
                );
            }
        }
    }

    /// Millimetres become metres with MVR's Z up as Nightfall's Y and MVR's +Y (away from
    /// the audience) as Nightfall's -Z.
    #[test]
    fn converts_position_axes_and_units() {
        let converted = convert_transform(&transform(
            [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            [2000.0, 3000.0, 6500.0],
        ));
        assert_eq!(
            converted.placement.position,
            PlacementPosition {
                x: 2.0,
                y: 6.5,
                z: -3.0
            }
        );
        assert_eq!(converted.placement.rotation, PlacementRotation::default());
        assert_eq!(converted.warning, None);
    }

    /// A moving head hung upside down from a truss (turned 180 degrees about X in
    /// Vectorworks) is turned 180 degrees about X in Nightfall too, so its base points up.
    #[test]
    fn hung_fixture_is_upside_down() {
        let converted = convert_transform(&transform(
            [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]],
            [0.0, 0.0, 6000.0],
        ));
        assert_eq!(
            converted.placement.rotation,
            PlacementRotation {
                x: 180.0,
                y: 0.0,
                z: 0.0
            }
        );
    }

    /// A fixture turned 90 degrees in plan (about MVR's vertical Z axis) turns about
    /// Nightfall's vertical Y axis.
    #[test]
    fn plan_rotation_turns_about_vertical() {
        let converted = convert_transform(&transform(
            [[0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
            [0.0; 3],
        ));
        assert_eq!(
            converted.placement.rotation,
            PlacementRotation {
                x: 0.0,
                y: 90.0,
                z: 0.0
            }
        );
    }

    /// Arbitrary and gimbal-locked rotations decompose into angles that rebuild the same
    /// orientation.
    #[test]
    fn euler_angles_rebuild_the_rotation() {
        let (s, c) = (0.5_f64, 0.75_f64.sqrt());
        assert_round_trip([[c, s, 0.0], [-s * c, c * c, s], [s * s, -s * c, c]]);
        assert_round_trip([[0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]]);
        assert_round_trip([[0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]]);
    }

    /// Scale is dropped from the rotation and reported.
    #[test]
    fn scaled_transform_warns() {
        let converted = convert_transform(&transform(
            [[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]],
            [0.0; 3],
        ));
        assert_eq!(converted.placement.rotation, PlacementRotation::default());
        assert!(converted.warning.is_some());
    }
}
