// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Sends each mapped control the state of its action's target, lighting pad LEDs.
//!
//! Feedback reads every mapping in reverse: the action registry reports what the mapping's
//! action reference looks like now, and the result is sent to the control's own MIDI
//! address on the paired output port. Only devices the operator turned feedback on for are
//! sent anything, since echoing to an unknown device can disturb its own state.

use std::collections::{BTreeSet, HashMap, HashSet};

use bevy_ecs::prelude::*;
use nightfall_actions::{ActionFeedback, ActionRegistry, FeedbackState};

use crate::command::{MidiLedValues, MidiMapping, MidiSource};
use crate::mapping::MidiMappings;
use crate::service::MidiOutputClient;

/// Devices that mapped controls send feedback to, by input device name.
///
/// Kept with the mappings in [`MidiMappings`], since both describe the show's controllers and
/// are saved together.
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct MidiFeedbackDevices(BTreeSet<String>);

impl MidiFeedbackDevices {
    /// Creates the set from saved device names.
    pub fn new(devices: impl IntoIterator<Item = String>) -> Self {
        Self(devices.into_iter().collect())
    }

    /// Returns the device names in sorted order.
    pub fn devices(&self) -> impl Iterator<Item = &String> {
        self.0.iter()
    }

    /// Returns whether feedback is on for a device.
    pub fn contains(&self, device: &str) -> bool {
        self.0.contains(device)
    }

    /// Turns feedback on or off for a device and reports whether that changed anything.
    pub fn set(&mut self, device: &str, enabled: bool) -> bool {
        if enabled {
            self.0.insert(device.to_string())
        } else {
            self.0.remove(device)
        }
    }
}

/// Output client the feedback system writes through.
#[derive(Resource, Clone)]
pub(crate) struct MidiOutput(pub(crate) MidiOutputClient);

/// Device name and control address one feedback message is sent to.
type FeedbackAddress = (String, MidiSource);

/// What one control address should show, and how to release it once nothing maps it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AddressFeedback {
    /// Message showing the target's current state.
    message: Vec<u8>,
    /// Message that darkens the address when its mapping is removed or feedback is turned
    /// off; `None` leaves the control as it is, so a motor fader does not drop to zero.
    release: Option<Vec<u8>>,
}

/// Last message sent to each control address, so only changes are sent.
#[derive(Resource, Default, Debug)]
pub(crate) struct MidiFeedbackCache {
    /// Last feedback per device and control address.
    sent: HashMap<FeedbackAddress, AddressFeedback>,
    /// Output generation the cache was built against; a change means ports reopened.
    generation: u64,
}

/// Encodes the message that shows `feedback` on a control address.
///
/// Notes show on/off LED values. Controllers and pitch bend show the target's level when it
/// has one (for faders and LED rings), and controllers otherwise show the on/off values.
/// Returns `None` when the address cannot show the feedback, such as pitch bend without a
/// level.
fn encode(address: MidiSource, led: MidiLedValues, feedback: ActionFeedback) -> Option<Vec<u8>> {
    let lit = match feedback.state {
        FeedbackState::Idle => led.off_value(),
        FeedbackState::Active | FeedbackState::Held => led.on_value(),
    };
    match address {
        MidiSource::Note { channel, note } => Some(vec![0x90 | (channel & 0x0F), note, lit]),
        MidiSource::ControlChange {
            channel,
            controller,
        } => {
            let value = feedback.level.map_or(lit, seven_bit);
            Some(vec![0xB0 | (channel & 0x0F), controller, value])
        }
        MidiSource::PitchBend { channel } => {
            let value = (feedback.level?.clamp(0.0, 1.0) * 16_383.0).round() as u16;
            Some(vec![
                0xE0 | (channel & 0x0F),
                (value & 0x7F) as u8,
                (value >> 7) as u8,
            ])
        }
    }
}

/// Encodes what an address shows now, plus the message that releases it later.
///
/// Addresses showing on/off state are released with the mapping's own off value. Addresses
/// showing a level (motor faders, LED rings) are left where they are.
fn encode_feedback(
    address: MidiSource,
    led: MidiLedValues,
    feedback: ActionFeedback,
) -> Option<AddressFeedback> {
    let message = encode(address, led, feedback)?;
    let release = match feedback.level {
        Some(_) => None,
        None => encode(address, led, ActionFeedback::IDLE),
    };
    Some(AddressFeedback { message, release })
}

/// Converts a normalized level to a 7-bit MIDI value.
fn seven_bit(level: f32) -> u8 {
    (level.clamp(0.0, 1.0) * 127.0).round() as u8
}

/// Computes the message each control address should show now, one per address.
///
/// When several mappings share an address (a press and a release binding on one pad), the
/// first one in mapping order whose action reports feedback the address can show decides
/// what the LED shows.
fn desired_messages(
    world: &World,
    registry: &ActionRegistry,
    mappings: &[MidiMapping],
    enabled: &HashSet<&str>,
) -> HashMap<FeedbackAddress, AddressFeedback> {
    let mut desired = HashMap::new();
    for mapping in mappings {
        if !enabled.contains(mapping.device_name.as_str()) {
            continue;
        }
        let key = (mapping.device_name.clone(), mapping.source);
        if desired.contains_key(&key) {
            continue;
        }
        let Some(feedback) = registry.feedback(world, &mapping.action) else {
            continue;
        };
        if let Some(address) = encode_feedback(mapping.source, mapping.led, feedback) {
            desired.insert(key, address);
        }
    }
    desired
}

/// Sends each mapped control on a feedback-enabled device its target's current state.
///
/// Only messages that differ from the last one sent to an address go out. Addresses that no
/// longer have a mapping, or whose device had feedback turned off, are darkened once. When
/// output ports reopen (a replugged controller) everything is sent again.
pub(crate) fn send_midi_feedback(world: &mut World) {
    let Some(output) = world
        .get_resource::<MidiOutput>()
        .map(|output| output.0.clone())
    else {
        return;
    };
    let desired = {
        let registry = world.resource::<ActionRegistry>();
        let mappings = world.resource::<MidiMappings>();
        let enabled = mappings
            .feedback_devices()
            .devices()
            .map(String::as_str)
            .filter(|device| output.has_output(device))
            .collect();
        desired_messages(world, registry, mappings.mappings(), &enabled)
    };

    let mut cache = world.resource_mut::<MidiFeedbackCache>();
    let generation = output.generation();
    if cache.generation != generation {
        cache.sent.clear();
        cache.generation = generation;
    }
    let stale: Vec<_> = cache
        .sent
        .keys()
        .filter(|key| !desired.contains_key(*key))
        .cloned()
        .collect();
    for key in stale {
        if let Some(release) = cache.sent.remove(&key).and_then(|sent| sent.release) {
            output.send(&key.0, release);
        }
    }
    for (key, address) in desired {
        let changed = cache
            .sent
            .get(&key)
            .is_none_or(|sent| sent.message != address.message);
        if changed {
            output.send(&key.0, address.message.clone());
        }
        cache.sent.insert(key, address);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc::Receiver;

    use bevy_app::{App, Update};
    use nightfall_actions::{ActionDescriptor, ActionReference, ControlBehavior};
    use uuid::Uuid;

    use super::*;
    use crate::service::MidiOutputMessage;

    /// Whether the test target is running, read by the test action's feedback.
    #[derive(Resource)]
    struct TestRunning(bool);

    /// Builds an app with one note mapping on "Pad" whose action reports [`TestRunning`],
    /// sending feedback through a capturing output.
    fn feedback_app() -> (App, Receiver<MidiOutputMessage>, Arc<AtomicU64>) {
        let mut app = App::new();
        let mut registry = ActionRegistry::default();
        registry.register::<serde::de::IgnoredAny, _>(
            ActionDescriptor::new("test.start", "Start", "Tests"),
            |_world, _arguments, _invocation| {
                Ok(nightfall_actions::InvocationDispatch::succeeded())
            },
        );
        registry.register_feedback::<serde::de::IgnoredAny, _>("test.start", |world, _| {
            Ok(ActionFeedback::active_if(world.resource::<TestRunning>().0))
        });
        let mut mappings = MidiMappings::new();
        mappings.set_mappings(vec![MidiMapping {
            id: Uuid::from_u128(1),
            device_name: "Pad".to_string(),
            source: MidiSource::Note {
                channel: 0,
                note: 60,
            },
            behavior: ControlBehavior::Press,
            led: MidiLedValues {
                on: Some(5),
                off: Some(1),
            },
            action: ActionReference::new("test.start", serde_json::json!({})),
        }]);
        mappings.feedback_devices_mut().set("Pad", true);
        let (client, rx, generation) = MidiOutputClient::capturing();
        app.insert_resource(registry)
            .insert_resource(mappings)
            .insert_resource(TestRunning(false))
            .insert_resource(MidiOutput(client))
            .init_resource::<MidiFeedbackCache>()
            .add_systems(Update, send_midi_feedback);
        (app, rx, generation)
    }

    /// Runs a frame and returns the bytes sent during it.
    fn frame(app: &mut App, rx: &Receiver<MidiOutputMessage>) -> Vec<Vec<u8>> {
        app.update();
        rx.try_iter().map(|message| message.bytes).collect()
    }

    /// Verifies feedback is sent once per change, resent after outputs reopen, and released
    /// with the mapping's own off value when the device's feedback is turned off.
    #[test]
    fn feedback_sends_changes_resyncs_and_darkens() {
        let (mut app, rx, generation) = feedback_app();

        assert_eq!(frame(&mut app, &rx), vec![vec![0x90, 60, 1]]);
        assert!(frame(&mut app, &rx).is_empty());

        app.insert_resource(TestRunning(true));
        assert_eq!(frame(&mut app, &rx), vec![vec![0x90, 60, 5]]);

        generation.fetch_add(1, Ordering::SeqCst);
        assert_eq!(frame(&mut app, &rx), vec![vec![0x90, 60, 5]]);

        app.world_mut()
            .resource_mut::<MidiMappings>()
            .feedback_devices_mut()
            .set("Pad", false);
        assert_eq!(frame(&mut app, &rx), vec![vec![0x90, 60, 1]]);
        assert!(frame(&mut app, &rx).is_empty());
    }

    /// Verifies on/off addresses release to the mapping's off value while level addresses
    /// such as motor faders are left where they are.
    #[test]
    fn release_uses_off_value_and_leaves_levels() {
        let led = MidiLedValues {
            on: Some(9),
            off: Some(2),
        };
        let pad = MidiSource::Note {
            channel: 0,
            note: 36,
        };
        let fader = MidiSource::ControlChange {
            channel: 0,
            controller: 7,
        };

        let lit = encode_feedback(pad, led, ActionFeedback::ACTIVE).expect("pad shows state");
        assert_eq!(lit.message, vec![0x90, 36, 9]);
        assert_eq!(lit.release, Some(vec![0x90, 36, 2]));

        let level =
            encode_feedback(fader, led, ActionFeedback::level(0.5)).expect("fader shows its level");
        assert_eq!(level.message, vec![0xB0, 7, 64]);
        assert_eq!(level.release, None);
    }

    /// Verifies a device without feedback turned on is never sent anything.
    #[test]
    fn feedback_skips_devices_without_feedback() {
        let (mut app, rx, _) = feedback_app();
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .feedback_devices_mut()
            .set("Pad", false);

        assert!(frame(&mut app, &rx).is_empty());
    }

    /// Verifies notes show the on/off values by state and controllers prefer the level.
    #[test]
    fn encode_shows_state_on_notes_and_level_on_controllers() {
        let led = MidiLedValues {
            on: Some(5),
            off: Some(1),
        };
        let note = MidiSource::Note {
            channel: 2,
            note: 60,
        };
        let controller = MidiSource::ControlChange {
            channel: 0,
            controller: 7,
        };

        assert_eq!(
            encode(note, led, ActionFeedback::ACTIVE),
            Some(vec![0x92, 60, 5])
        );
        assert_eq!(
            encode(note, led, ActionFeedback::IDLE),
            Some(vec![0x92, 60, 1])
        );
        assert_eq!(
            encode(note, led, ActionFeedback::level(0.5)),
            Some(vec![0x92, 60, 5])
        );
        assert_eq!(
            encode(controller, led, ActionFeedback::level(0.5)),
            Some(vec![0xB0, 7, 64])
        );
        assert_eq!(
            encode(controller, led, ActionFeedback::IDLE),
            Some(vec![0xB0, 7, 1])
        );
    }

    /// Verifies pitch bend carries a 14-bit level and has nothing to show without one.
    #[test]
    fn encode_pitch_bend_needs_a_level() {
        let bend = MidiSource::PitchBend { channel: 1 };
        let led = MidiLedValues::default();

        assert_eq!(
            encode(bend, led, ActionFeedback::level(1.0)),
            Some(vec![0xE1, 0x7F, 0x7F])
        );
        assert_eq!(encode(bend, led, ActionFeedback::ACTIVE), None);
    }

    /// Verifies a held flash lights the LED like an active target.
    #[test]
    fn encode_held_lights_the_led() {
        let held = ActionFeedback {
            state: FeedbackState::Held,
            level: None,
        };
        let note = MidiSource::Note {
            channel: 0,
            note: 1,
        };

        assert_eq!(
            encode(note, MidiLedValues::default(), held),
            Some(vec![0x90, 1, 127])
        );
    }

    /// Verifies turning a device on and off reports whether the set changed.
    #[test]
    fn feedback_devices_report_changes() {
        let mut devices = MidiFeedbackDevices::default();

        assert!(devices.set("Pad", true));
        assert!(!devices.set("Pad", true));
        assert!(devices.contains("Pad"));
        assert!(devices.set("Pad", false));
        assert!(!devices.contains("Pad"));
    }
}
