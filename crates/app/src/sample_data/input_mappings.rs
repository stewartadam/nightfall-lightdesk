// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Install the deterministic MIDI controller mapping used by the sample show.
#[cfg(feature = "midi")]
pub(super) fn add_midi_mappings(world: &mut World) {
    let Some(mut midi_mappings) = world.get_resource_mut::<MidiMappings>() else {
        return;
    };

    midi_mappings.set_mappings(vec![MidiMapping {
        device_name: "Grid".to_string(),
        id: uuid::Uuid::from_u128(1),
        input: nightfall_input_midi::command::MidiBindingInput::Continuous,
        channel: 176,
        note: 36,
        velocity: None,
        action: set_control_action(1),
    }]);
}

/// Leave sample population unchanged when MIDI support is not compiled.
#[cfg(not(feature = "midi"))]
pub(super) fn add_midi_mappings(_world: &mut World) {}
