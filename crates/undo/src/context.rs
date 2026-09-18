// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::world::World;

/// Provides read-only access to ECS state for inverse generation.
///
/// Used by `UndoableOperation::inverse()` to query current state before a command
/// executes, enabling capture of data needed to restore on undo.
///
/// This struct holds a reference to the ECS World, allowing implementations
/// to query any resources they need for inverse generation.
pub struct UndoContext<'a> {
    /// Reference to the ECS World for querying resources
    pub world: &'a World,
}
