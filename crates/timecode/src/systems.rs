// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Timecode system logic
use std::time::Duration;

use bevy_ecs::prelude::*;
use bevy_time::Time;

use crate::components::TimecodeGenerator;

/// System that updates all timecode generators
pub fn update_timecode_system(
    time: Option<Res<Time>>,
    mut timecode_generators: Query<(Entity, &mut TimecodeGenerator)>,
) {
    for (entity, mut generator) in timecode_generators.iter_mut() {
        tracing::trace!(
            %entity,
            timecode_id = generator.timecode.identifiers.id,
            before_active = generator.state.is_active,
            before_current_time = ?generator.state.current_time,
            "Updating timecode generator"
        );
        generator.update(time.as_ref().map_or(Duration::ZERO, |time| time.delta()));
    }
}
