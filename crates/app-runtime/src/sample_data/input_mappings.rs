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
        id: uuid::Uuid::from_u128(0x5a3d_0001),
        device_name: "Grid".to_string(),
        source: MidiSource::ControlChange {
            channel: 0,
            controller: 36,
        },
        edge: nightfall_actions::SourceEdge::Press,
        action: control_level_action(1),
    }]);
}

/// Leave sample population unchanged when MIDI support is not compiled.
#[cfg(not(feature = "midi"))]
pub(super) fn add_midi_mappings(_world: &mut World) {}
