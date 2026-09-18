// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Fixture placement component for 3D positioning in the visualizer.

use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};

/// 3D position vector for fixture placement.
#[derive(Default, Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct PlacementPosition {
    /// X coordinate in meters (stage right is positive)
    pub x: f32,
    /// Y coordinate in meters (up is positive)
    pub y: f32,
    /// Z coordinate in meters (downstage is positive)
    pub z: f32,
}

/// Rotation as Euler angles in degrees.
#[derive(Default, Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct PlacementRotation {
    /// Rotation around X axis in degrees (pitch)
    pub x: f32,
    /// Rotation around Y axis in degrees (yaw)
    pub y: f32,
    /// Rotation around Z axis in degrees (roll)
    pub z: f32,
}

/// Per-instance 3D placement in the venue (user-defined, not from fixture profile).
/// Position and rotation define where the fixture exists in world space.
#[derive(Component, Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct FixturePlacement {
    /// World position in meters
    pub position: PlacementPosition,
    /// Base orientation as Euler angles in degrees (not pan/tilt - those come from DMX)
    pub rotation: PlacementRotation,
}

impl FixturePlacement {
    /// Create placement at specific position with identity rotation.
    pub fn at_position(x: f32, y: f32, z: f32) -> Self {
        Self {
            position: PlacementPosition { x, y, z },
            rotation: PlacementRotation::default(),
        }
    }
}
