// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Whether each timecode runs and where it stands, as live state a backup copies from its
//! primary. Timelines follow their timecode, so this also keeps timeline playback in step.

use std::time::Duration;

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{TimecodeOperation, components::TimecodeGenerator};

/// Live state section key of timecode transports.
pub const TIMECODES_LIVE_STATE: &str = "timecodes";

/// Position difference a backup tolerates before seeking its timecode.
const POSITION_TOLERANCE: Duration = Duration::from_millis(100);

/// One timecode's transport on the primary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTimecode {
    /// Timecode slot ID.
    pub id: u32,
    /// Stable timecode UID, so a backup with another timecode in the slot leaves it alone.
    pub uid: Uuid,
    /// Whether the timecode is started.
    pub running: bool,
    /// Timecode position.
    pub position: Duration,
}

/// Captures every timecode's transport.
pub(crate) fn capture_live_timecodes(world: &mut World) -> Vec<LiveTimecode> {
    let mut timecodes: Vec<LiveTimecode> = world
        .query::<&TimecodeGenerator>()
        .iter(world)
        .map(|generator| LiveTimecode {
            id: generator.timecode.identifiers.id,
            uid: generator.timecode.identifiers.uid,
            running: generator.is_started(),
            position: generator.state.current_time,
        })
        .collect();
    timecodes.sort_by_key(|timecode| timecode.id);
    timecodes
}

/// Starts, pauses and seeks this engine's timecodes to match the primary's.
///
/// Timecodes that follow an external source keep following it: only whether they are started is
/// copied, since their position comes from that source on each computer.
pub(crate) fn restore_live_timecodes(
    world: &mut World,
    timecodes: Vec<LiveTimecode>,
    context: LiveStateRestore,
) {
    let local: Vec<(u32, Uuid, bool, bool, Duration)> = world
        .query::<&TimecodeGenerator>()
        .iter(world)
        .map(|generator| {
            (
                generator.timecode.identifiers.id,
                generator.timecode.identifiers.uid,
                generator.is_internal(),
                generator.is_started(),
                generator.state.current_time,
            )
        })
        .collect();
    for timecode in timecodes {
        let Some(&(id, _, internal, running, position)) = local
            .iter()
            .find(|(id, uid, ..)| *id == timecode.id && *uid == timecode.uid)
        else {
            continue;
        };
        let mut operations = Vec::new();
        if internal {
            let target = if timecode.running {
                timecode.position.saturating_add(context.age)
            } else {
                timecode.position
            };
            if position.abs_diff(target) > POSITION_TOLERANCE {
                operations.push(TimecodeOperation::Seek {
                    id,
                    position: target,
                });
            }
        }
        if timecode.running != running {
            operations.push(if timecode.running {
                TimecodeOperation::Start(id)
            } else {
                TimecodeOperation::Pause(id)
            });
        }
        for operation in operations {
            world.write_message(EngineOperationEnvelope::detached(operation));
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::message::Messages;

    use super::*;

    /// Builds a world holding one stopped internal timecode and returns it with its UID.
    fn world_with_timecode() -> (World, Uuid) {
        let mut world = World::new();
        world.init_resource::<Messages<EngineOperationEnvelope<TimecodeOperation>>>();
        let generator = TimecodeGenerator::default();
        let uid = generator.timecode.identifiers.uid;
        world.spawn(generator);
        (world, uid)
    }

    /// Drains the timecode operations the restore requested.
    fn operations(world: &mut World) -> Vec<String> {
        world
            .resource_mut::<Messages<EngineOperationEnvelope<TimecodeOperation>>>()
            .drain()
            .map(|envelope| format!("{:?}", envelope.operation))
            .collect()
    }

    /// A running primary timecode seeks and starts the backup's, counting the checkpoint's age,
    /// and a matching one requests nothing.
    #[test]
    fn running_primary_timecode_starts_the_backup_at_its_position() {
        let (mut world, uid) = world_with_timecode();
        restore_live_timecodes(
            &mut world,
            vec![LiveTimecode {
                id: 1,
                uid,
                running: true,
                position: Duration::from_secs(10),
            }],
            LiveStateRestore {
                age: Duration::from_millis(500),
            },
        );
        assert_eq!(
            operations(&mut world),
            vec![
                "Seek { id: 1, position: 10.5s }".to_string(),
                "Start(1)".to_string()
            ]
        );

        let captured = capture_live_timecodes(&mut world);
        restore_live_timecodes(&mut world, captured, LiveStateRestore::default());
        assert!(operations(&mut world).is_empty());
    }

    /// A timecode in the same slot with another UID is a different timecode and is left alone.
    #[test]
    fn other_timecode_in_the_slot_is_left_alone() {
        let (mut world, _) = world_with_timecode();
        restore_live_timecodes(
            &mut world,
            vec![LiveTimecode {
                id: 1,
                uid: Uuid::new_v4(),
                running: true,
                position: Duration::from_secs(10),
            }],
            LiveStateRestore::default(),
        );
        assert!(operations(&mut world).is_empty());
    }
}
