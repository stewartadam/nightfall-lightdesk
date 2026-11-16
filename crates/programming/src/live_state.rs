// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The shared programmer's contents, as live state a backup copies from its primary, so a
//! takeover keeps whatever the operator had set up by hand.

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_engine::prelude::{BoundAssertionSet, LiveStateRestore};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::resources::{
    Programmer, ProgrammerInstructions, ProgrammerMode, RecalledCueTimingDefaults,
};

/// Live state section key of the programmer.
pub const PROGRAMMER_LIVE_STATE: &str = "programmer";

/// The programmer's contents on the primary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveProgrammer {
    /// Whether edits render live or blind.
    pub mode: ProgrammerMode,
    /// Instructions rendered on stage, in order.
    pub live: Vec<(Uuid, BoundAssertionSet)>,
    /// Instructions kept blind, in order.
    pub blind: Vec<(Uuid, BoundAssertionSet)>,
    /// The selection edits apply to.
    pub selection: SpatialSelection,
    /// Programmer-wide transition timing.
    pub transitions: Transition,
    /// Per-attribute transition timing.
    pub attribute_transitions: AttributeTransitions,
    /// Cue timing defaults from the last recalled cue, which later edits fade with.
    pub recalled_cue_timing_defaults: Option<RecalledCueTimingDefaults>,
}

impl LiveProgrammer {
    /// Reads the contents of `programmer`.
    fn of(programmer: &Programmer) -> Self {
        Self {
            mode: programmer.mode,
            live: instructions(&programmer.live_instructions),
            blind: instructions(&programmer.blind_instructions),
            selection: programmer.active_selection.clone(),
            transitions: programmer.transitions.clone(),
            attribute_transitions: programmer.attribute_transitions.clone(),
            recalled_cue_timing_defaults: programmer.recalled_cue_timing_defaults.clone(),
        }
    }
}

/// Lists instructions in order.
fn instructions(instructions: &ProgrammerInstructions) -> Vec<(Uuid, BoundAssertionSet)> {
    instructions
        .iter()
        .map(|(id, instruction)| (*id, instruction.clone()))
        .collect()
}

/// Rebuilds an instruction buffer from an ordered list.
fn instruction_buffer(list: Vec<(Uuid, BoundAssertionSet)>) -> ProgrammerInstructions {
    let mut buffer = ProgrammerInstructions::new();
    for (id, instruction) in list {
        buffer.insert(id, instruction);
    }
    buffer
}

/// Captures the programmer's contents.
pub(crate) fn capture_live_programmer(world: &mut World) -> Option<LiveProgrammer> {
    world.get_resource::<Programmer>().map(LiveProgrammer::of)
}

/// Replaces this engine's programmer contents with the primary's when they differ.
///
/// The comparison runs on the serialized form, so an unchanged programmer is not marked
/// changed and is not repainted or resent to clients on every checkpoint.
pub(crate) fn restore_live_programmer(
    world: &mut World,
    live: Option<LiveProgrammer>,
    _context: LiveStateRestore,
) {
    let Some(live) = live else {
        return;
    };
    let Some(programmer) = world.get_resource::<Programmer>() else {
        return;
    };
    if serde_json::to_value(LiveProgrammer::of(programmer)).ok() == serde_json::to_value(&live).ok()
    {
        return;
    }
    let mut programmer = world.resource_mut::<Programmer>();
    programmer.mode = live.mode;
    programmer.live_instructions = instruction_buffer(live.live);
    programmer.blind_instructions = instruction_buffer(live.blind);
    programmer.active_selection = live.selection;
    programmer.transitions = live.transitions;
    programmer.attribute_transitions = live.attribute_transitions;
    programmer.recalled_cue_timing_defaults = live.recalled_cue_timing_defaults;
    programmer.transition_anchor_aliases.clear();
}

#[cfg(test)]
mod tests {
    use bevy_ecs::change_detection::DetectChanges;

    use super::*;

    /// A backup's programmer takes the primary's instructions, selection and mode, and a repeated
    /// checkpoint leaves it unchanged.
    #[test]
    fn programmer_contents_follow_the_primary_once() {
        let mut primary = World::new();
        let mut programmer = Programmer {
            mode: ProgrammerMode::Live,
            ..Default::default()
        };
        programmer
            .live_instructions
            .insert(Uuid::from_u128(1), BoundAssertionSet::default());
        primary.insert_resource(programmer);
        let live = capture_live_programmer(&mut primary);

        let mut backup = World::new();
        backup.insert_resource(Programmer::default());
        backup.clear_trackers();
        restore_live_programmer(&mut backup, live.clone(), LiveStateRestore::default());
        let restored = backup.resource_ref::<Programmer>();
        assert!(restored.is_changed());
        assert_eq!(restored.mode, ProgrammerMode::Live);
        assert_eq!(restored.live_instructions.len(), 1);
        assert!(
            restored
                .live_instructions
                .get(&Uuid::from_u128(1))
                .is_some()
        );

        backup.clear_trackers();
        restore_live_programmer(&mut backup, live, LiveStateRestore::default());
        assert!(!backup.resource_ref::<Programmer>().is_changed());
    }
}
