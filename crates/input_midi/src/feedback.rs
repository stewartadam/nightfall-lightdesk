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
//! address on the paired output port. Devices matching a controller profile receive
//! feedback unless the operator turns it off; any other device is sent nothing until the
//! operator turns it on, since echoing to an unknown device can disturb its own state.

use std::collections::{BTreeMap, HashMap, HashSet};

use bevy_ecs::prelude::*;
use nightfall_actions::{ActionFeedback, ActionRegistry, FeedbackState};
use serde::{Deserialize, Serialize};

use crate::command::{MidiLedValues, MidiMapping, MidiSource};
use crate::mapping::MidiMappings;
use crate::profile;
use crate::service::MidiOutputClient;

/// The operator's LED feedback choice for one device, as saved in the showfile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiFeedbackSetting {
    /// Input device name, as stored on its mappings.
    pub device: String,
    /// Whether mapped controls on the device are sent their targets' state.
    pub enabled: bool,
}

/// Whether each device is sent LED feedback, by input device name.
///
/// A device follows its controller profile (on for known hardware, off otherwise) until the
/// operator chooses otherwise; only those choices are stored. Kept with the mappings in
/// [`MidiMappings`], since both describe the show's controllers and are saved together.
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct MidiFeedbackDevices(BTreeMap<String, bool>);

impl MidiFeedbackDevices {
    /// Creates the choices from saved settings; when a device appears twice, as after
    /// merging an imported showfile, the first choice wins.
    pub fn new(settings: impl IntoIterator<Item = MidiFeedbackSetting>) -> Self {
        let mut choices = BTreeMap::new();
        for setting in settings {
            choices.entry(setting.device).or_insert(setting.enabled);
        }
        Self(choices)
    }

    /// Returns the operator's choices in device name order, for saving.
    pub fn settings(&self) -> impl Iterator<Item = MidiFeedbackSetting> + '_ {
        self.0.iter().map(|(device, enabled)| MidiFeedbackSetting {
            device: device.clone(),
            enabled: *enabled,
        })
    }

    /// Returns whether feedback is on for a device: the operator's choice, otherwise its
    /// profile's default.
    pub fn is_enabled(&self, device: &str) -> bool {
        self.0
            .get(device)
            .copied()
            .unwrap_or_else(|| profile_default(device))
    }

    /// Turns feedback on or off for a device and reports whether that changed anything.
    ///
    /// Choosing what the profile would choose anyway clears the stored choice, so the
    /// device keeps following its profile.
    pub fn set(&mut self, device: &str, enabled: bool) -> bool {
        let was_enabled = self.is_enabled(device);
        if enabled == profile_default(device) {
            self.0.remove(device);
        } else {
            self.0.insert(device.to_string(), enabled);
        }
        was_enabled != enabled
    }
}

/// Returns whether a device's controller profile turns feedback on before the operator
/// chooses; devices without a profile start off.
fn profile_default(device: &str) -> bool {
    profile::for_device(device).is_some_and(|profile| profile.feedback)
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
    /// Devices that were sent their profile's init messages and are receiving feedback.
    active_devices: HashSet<String>,
    /// Output generation the cache was built against; a change means ports reopened.
    generation: u64,
}

/// How a control shows the level of a target such as a fader.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LevelLook<'a> {
    /// Controllers send the raw level (motor faders, LED rings); notes show on or off.
    Raw,
    /// Notes and controllers light the step of the on color's brightness ramp matching the
    /// level.
    Ramp(&'a [u8]),
    /// LED values are brightness, so notes and controllers scale the level between the
    /// mapping's off and on values.
    Scale,
}

impl<'a> LevelLook<'a> {
    /// Picks how a mapping whose on value is `on` shows levels on a device with `profile`.
    fn for_device(profile: Option<&'a profile::MidiProfile>, on: u8) -> Self {
        match profile {
            Some(profile) if profile.dimmable => Self::Scale,
            Some(profile) if !profile.ramp(on).is_empty() => Self::Ramp(profile.ramp(on)),
            _ => Self::Raw,
        }
    }
}

/// Encodes the message that shows `feedback` on a control address.
///
/// Notes show on/off LED values. Controllers and pitch bend show the target's level when it
/// has one (for faders and LED rings), and controllers otherwise show the on/off values.
/// When `look` is not [`LevelLook::Raw`], an active level instead lights the matching ramp
/// step or scaled brightness on notes and controllers alike, so a pad mapped to a fader
/// brightens with it. Returns `None` when the address cannot show the feedback, such as
/// pitch bend without a level.
fn encode(
    address: MidiSource,
    led: MidiLedValues,
    look: LevelLook,
    feedback: ActionFeedback,
) -> Option<Vec<u8>> {
    let lit = match (feedback.state, feedback.level, look) {
        (FeedbackState::Idle, _, _) => led.off_value(),
        (FeedbackState::Active, Some(level), LevelLook::Ramp(ramp)) => ramp_step(ramp, level),
        (FeedbackState::Active, Some(level), LevelLook::Scale) => scaled(led, level),
        (FeedbackState::Active, _, _) => led.on_value(),
        (FeedbackState::Held, _, _) => led.held_value(),
    };
    match address {
        MidiSource::Note { channel, note } => Some(vec![0x90 | (channel & 0x0F), note, lit]),
        MidiSource::ControlChange {
            channel,
            controller,
        } => {
            let value = match (feedback.level, look) {
                (Some(level), LevelLook::Raw) => seven_bit(level),
                _ => lit,
            };
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
/// Addresses showing on/off state or a level as LED brightness are released with the
/// mapping's own off value. Addresses showing a raw level (motor faders, LED rings) are left
/// where they are.
fn encode_feedback(
    address: MidiSource,
    led: MidiLedValues,
    look: LevelLook,
    feedback: ActionFeedback,
) -> Option<AddressFeedback> {
    let message = encode(address, led, look, feedback)?;
    let release = match (feedback.level, look) {
        (Some(_), LevelLook::Raw) => None,
        _ => encode(address, led, look, ActionFeedback::IDLE),
    };
    Some(AddressFeedback { message, release })
}

/// Converts a normalized level to a 7-bit MIDI value.
fn seven_bit(level: f32) -> u8 {
    (level.clamp(0.0, 1.0) * 127.0).round() as u8
}

/// Scales a normalized level between the off and on values, for LEDs whose value is their
/// brightness, so picking a dimmer on color also caps the brightness a full level reaches.
fn scaled(led: MidiLedValues, level: f32) -> u8 {
    let (off, on) = (f32::from(led.off_value()), f32::from(led.on_value()));
    (off + (on - off) * level.clamp(0.0, 1.0)).round() as u8
}

/// Picks the brightness step showing a normalized level above zero: the ramp is split into
/// equal bands, so any level lights at least the dimmest step and only full lights the last.
fn ramp_step(ramp: &[u8], level: f32) -> u8 {
    let steps = ramp.len();
    let band = (level.clamp(0.0, 1.0) * steps as f32).ceil() as usize;
    ramp[band.clamp(1, steps) - 1]
}

/// Computes the message each control address should show now, one per address.
///
/// When several mappings share an address (a press and a release binding on one pad), the
/// first one in mapping order whose action reports feedback the address can show decides
/// what the LED shows. LED values a mapping leaves unset come from its device's profile.
fn desired_messages(
    world: &World,
    registry: &ActionRegistry,
    mappings: &[MidiMapping],
    enabled: &HashSet<&str>,
) -> HashMap<FeedbackAddress, AddressFeedback> {
    let mut desired = HashMap::new();
    let mut profile_led = HashMap::new();
    for mapping in mappings {
        let device = mapping.device_name.as_str();
        if !enabled.contains(device) {
            continue;
        }
        let key = (mapping.device_name.clone(), mapping.source);
        if desired.contains_key(&key) {
            continue;
        }
        let Some(feedback) = registry.feedback(world, &mapping.action) else {
            continue;
        };
        let (profile, fallback) = *profile_led.entry(device).or_insert_with(|| {
            let profile = profile::for_device(device);
            let fallback = profile
                .map(profile::MidiProfile::default_led)
                .unwrap_or_default();
            (profile, fallback)
        });
        // A mapping choosing its own on value but no held value keeps that color while held.
        let led = MidiLedValues {
            held: mapping.led.held.or(mapping.led.on),
            ..mapping.led
        }
        .or(fallback);
        let look = LevelLook::for_device(profile, led.on_value());
        if let Some(address) = encode_feedback(mapping.source, led, look, feedback) {
            desired.insert(key, address);
        }
    }
    desired
}

/// Sends every message of a device's profile in `pick` (its init or release messages).
fn send_profile_messages(
    output: &MidiOutputClient,
    device: &str,
    pick: impl Fn(&profile::MidiProfile) -> &[Vec<u8>],
) {
    if let Some(profile) = profile::for_device(device) {
        for message in pick(profile) {
            output.send(device, message.clone());
        }
    }
}

/// Sends each mapped control on a feedback-enabled device its target's current state.
///
/// Only messages that differ from the last one sent to an address go out. A device whose
/// feedback starts is first sent its profile's init messages. Addresses that no longer have
/// a mapping, or whose device had feedback turned off, are darkened once, followed by the
/// device's release messages when its feedback stops. When output ports reopen (a replugged
/// controller) everything is sent again.
pub(crate) fn send_midi_feedback(world: &mut World) {
    let Some(output) = world
        .get_resource::<MidiOutput>()
        .map(|output| output.0.clone())
    else {
        return;
    };
    let (enabled, desired): (HashSet<String>, _) = {
        let registry = world.resource::<ActionRegistry>();
        let mappings = world.resource::<MidiMappings>();
        let feedback_devices = mappings.feedback_devices();
        let enabled: HashSet<&str> = mappings
            .mappings()
            .iter()
            .map(|mapping| mapping.device_name.as_str())
            .collect::<HashSet<_>>()
            .into_iter()
            .filter(|device| feedback_devices.is_enabled(device) && output.has_output(device))
            .collect();
        let desired = desired_messages(world, registry, mappings.mappings(), &enabled);
        (enabled.into_iter().map(str::to_string).collect(), desired)
    };

    let mut cache = world.resource_mut::<MidiFeedbackCache>();
    let generation = output.generation();
    if cache.generation != generation {
        cache.sent.clear();
        cache.active_devices.clear();
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
    let stopped: Vec<_> = cache.active_devices.difference(&enabled).cloned().collect();
    for device in stopped {
        send_profile_messages(&output, &device, |profile| &profile.release);
        cache.active_devices.remove(&device);
    }
    for device in enabled {
        if !cache.active_devices.contains(&device) {
            send_profile_messages(&output, &device, |profile| &profile.init);
            cache.active_devices.insert(device);
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
        let (mut app, rx, generation) = device_feedback_app(
            "Pad",
            MidiLedValues {
                on: Some(5),
                off: Some(1),
                held: None,
            },
        );
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .feedback_devices_mut()
            .set("Pad", true);
        (app, rx, generation)
    }

    /// Builds an app with one note-60 mapping on `device` with the given LED values, whose
    /// action reports [`TestRunning`], leaving feedback to the device's profile default.
    fn device_feedback_app(
        device: &str,
        led: MidiLedValues,
    ) -> (App, Receiver<MidiOutputMessage>, Arc<AtomicU64>) {
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
            device_name: device.to_string(),
            source: MidiSource::Note {
                channel: 0,
                note: 60,
            },
            behavior: ControlBehavior::Press,
            led,
            action: ActionReference::new("test.start", serde_json::json!({})),
        }]);
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

    /// Verifies a profiled device gets feedback without being turned on: its init messages
    /// go out before any LED, unset LED values use the profile's colors, and turning
    /// feedback off darkens the pad and then sends the profile's release messages.
    #[test]
    fn profiled_device_initializes_uses_its_colors_and_releases() {
        let (mut app, rx, generation) = device_feedback_app("Launchpad", MidiLedValues::default());

        assert_eq!(
            frame(&mut app, &rx),
            vec![vec![0xB0, 0, 0], vec![0xB0, 0, 40], vec![0x90, 60, 12]]
        );
        app.insert_resource(TestRunning(true));
        assert_eq!(frame(&mut app, &rx), vec![vec![0x90, 60, 60]]);

        generation.fetch_add(1, Ordering::SeqCst);
        assert_eq!(
            frame(&mut app, &rx),
            vec![vec![0xB0, 0, 0], vec![0xB0, 0, 40], vec![0x90, 60, 60]]
        );

        app.world_mut()
            .resource_mut::<MidiMappings>()
            .feedback_devices_mut()
            .set("Launchpad", false);
        assert_eq!(
            frame(&mut app, &rx),
            vec![vec![0x90, 60, 12], vec![0xB0, 0, 0]]
        );
        assert!(frame(&mut app, &rx).is_empty());
    }

    /// Verifies a value the mapping sets wins over the profile's default for that state only.
    #[test]
    fn mapping_values_override_profile_defaults() {
        let led = MidiLedValues {
            on: Some(15),
            ..Default::default()
        };
        let (mut app, rx, _) = device_feedback_app("Launchpad", led);
        app.insert_resource(TestRunning(true));

        assert_eq!(frame(&mut app, &rx).last(), Some(&vec![0x90, 60, 15]));
        app.insert_resource(TestRunning(false));
        assert_eq!(frame(&mut app, &rx), vec![vec![0x90, 60, 12]]);
    }

    /// Verifies on/off addresses release to the mapping's off value while level addresses
    /// such as motor faders are left where they are.
    #[test]
    fn release_uses_off_value_and_leaves_levels() {
        let led = MidiLedValues {
            on: Some(9),
            off: Some(2),
            held: None,
        };
        let pad = MidiSource::Note {
            channel: 0,
            note: 36,
        };
        let fader = MidiSource::ControlChange {
            channel: 0,
            controller: 7,
        };

        let lit = encode_feedback(pad, led, LevelLook::Raw, ActionFeedback::ACTIVE)
            .expect("pad shows state");
        assert_eq!(lit.message, vec![0x90, 36, 9]);
        assert_eq!(lit.release, Some(vec![0x90, 36, 2]));

        let level = encode_feedback(fader, led, LevelLook::Raw, ActionFeedback::level(0.5))
            .expect("fader shows its level");
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
            held: None,
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
            encode(note, led, LevelLook::Raw, ActionFeedback::ACTIVE),
            Some(vec![0x92, 60, 5])
        );
        assert_eq!(
            encode(note, led, LevelLook::Raw, ActionFeedback::IDLE),
            Some(vec![0x92, 60, 1])
        );
        assert_eq!(
            encode(note, led, LevelLook::Raw, ActionFeedback::level(0.5)),
            Some(vec![0x92, 60, 5])
        );
        assert_eq!(
            encode(controller, led, LevelLook::Raw, ActionFeedback::level(0.5)),
            Some(vec![0xB0, 7, 64])
        );
        assert_eq!(
            encode(controller, led, LevelLook::Raw, ActionFeedback::IDLE),
            Some(vec![0xB0, 7, 1])
        );
    }

    /// Verifies pitch bend carries a 14-bit level and has nothing to show without one.
    #[test]
    fn encode_pitch_bend_needs_a_level() {
        let bend = MidiSource::PitchBend { channel: 1 };
        let led = MidiLedValues::default();

        assert_eq!(
            encode(bend, led, LevelLook::Raw, ActionFeedback::level(1.0)),
            Some(vec![0xE1, 0x7F, 0x7F])
        );
        assert_eq!(
            encode(bend, led, LevelLook::Raw, ActionFeedback::ACTIVE),
            None
        );
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
            encode(note, MidiLedValues::default(), LevelLook::Raw, held),
            Some(vec![0x90, 1, 127])
        );
    }

    /// Verifies turning a device on and off reports whether the set changed.
    #[test]
    fn feedback_devices_report_changes() {
        let mut devices = MidiFeedbackDevices::default();

        assert!(devices.set("Pad", true));
        assert!(!devices.set("Pad", true));
        assert!(devices.is_enabled("Pad"));
        assert!(devices.set("Pad", false));
        assert!(!devices.is_enabled("Pad"));
    }

    /// Verifies a profiled device starts on, stores only a choice that differs from its
    /// profile, and goes back to following the profile when turned on again.
    #[test]
    fn feedback_devices_follow_profile_defaults() {
        let mut devices = MidiFeedbackDevices::default();
        assert!(devices.is_enabled("Launchpad"));

        assert!(devices.set("Launchpad", false));
        assert!(!devices.is_enabled("Launchpad"));
        assert_eq!(
            devices.settings().collect::<Vec<_>>(),
            vec![MidiFeedbackSetting {
                device: "Launchpad".to_string(),
                enabled: false,
            }]
        );

        assert!(devices.set("Launchpad", true));
        assert_eq!(devices.settings().count(), 0);
    }

    /// Verifies a held flash shows the mapping's held value when it sets one.
    #[test]
    fn encode_held_uses_the_held_value() {
        let held = ActionFeedback {
            state: FeedbackState::Held,
            level: None,
        };
        let led = MidiLedValues {
            on: Some(60),
            off: Some(12),
            held: Some(59),
        };
        let note = MidiSource::Note {
            channel: 0,
            note: 1,
        };

        assert_eq!(
            encode(note, led, LevelLook::Raw, held),
            Some(vec![0x90, 1, 59])
        );
    }

    /// Verifies a level on a color with a ramp picks the matching brightness step on notes
    /// and controllers, zero shows the off value, a held flash keeps its held value, and the
    /// address is darkened on release instead of left at its level.
    #[test]
    fn encode_levels_step_through_the_ramp() {
        let led = MidiLedValues {
            on: Some(60),
            off: Some(12),
            held: Some(59),
        };
        let ramp = [28, 44, 60];
        let note = MidiSource::Note {
            channel: 0,
            note: 1,
        };
        let controller = MidiSource::ControlChange {
            channel: 0,
            controller: 104,
        };
        let shown = |address, level| {
            encode(
                address,
                led,
                LevelLook::Ramp(&ramp),
                ActionFeedback::level(level),
            )
        };

        assert_eq!(shown(note, 0.0), Some(vec![0x90, 1, 12]));
        assert_eq!(shown(note, 0.01), Some(vec![0x90, 1, 28]));
        assert_eq!(shown(note, 0.34), Some(vec![0x90, 1, 44]));
        assert_eq!(shown(note, 0.67), Some(vec![0x90, 1, 60]));
        assert_eq!(shown(note, 1.0), Some(vec![0x90, 1, 60]));
        assert_eq!(shown(controller, 0.5), Some(vec![0xB0, 104, 44]));

        let held = ActionFeedback {
            state: FeedbackState::Held,
            level: Some(1.0),
        };
        assert_eq!(
            encode(note, led, LevelLook::Ramp(&ramp), held),
            Some(vec![0x90, 1, 59])
        );

        let feedback = encode_feedback(
            note,
            led,
            LevelLook::Ramp(&ramp),
            ActionFeedback::level(0.5),
        )
        .expect("pad shows its level");
        assert_eq!(feedback.release, Some(vec![0x90, 1, 12]));
    }

    /// Level the test fader action reports, read by [`level_feedback_app`]'s feedback.
    #[derive(Resource)]
    struct TestLevel(f32);

    /// Builds [`device_feedback_app`] with its action reporting [`TestLevel`] (initially
    /// half) instead of on/off state, like a fader.
    fn level_feedback_app(device: &str, led: MidiLedValues) -> (App, Receiver<MidiOutputMessage>) {
        let (mut app, rx, _) = device_feedback_app(device, led);
        app.world_mut()
            .resource_mut::<ActionRegistry>()
            .register_feedback::<serde::de::IgnoredAny, _>("test.start", |world, _| {
                Ok(ActionFeedback::level(world.resource::<TestLevel>().0))
            });
        app.insert_resource(TestLevel(0.5));
        (app, rx)
    }

    /// Verifies a Launchpad pad mapped to a level action brightens through the profile's
    /// ramp for the mapping's on color, the profile default green or a chosen red.
    #[test]
    fn profiled_pad_brightens_with_level() {
        let (mut app, rx) = level_feedback_app("Launchpad", MidiLedValues::default());

        assert_eq!(frame(&mut app, &rx).last(), Some(&vec![0x90, 60, 44]));
        app.insert_resource(TestLevel(1.0));
        assert_eq!(frame(&mut app, &rx), vec![vec![0x90, 60, 60]]);
        app.insert_resource(TestLevel(0.0));
        assert_eq!(frame(&mut app, &rx), vec![vec![0x90, 60, 12]]);

        let mut mappings = app.world().resource::<MidiMappings>().mappings().to_vec();
        mappings[0].led.on = Some(15);
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .set_mappings(mappings);
        app.insert_resource(TestLevel(0.2));
        assert_eq!(frame(&mut app, &rx), vec![vec![0x90, 60, 13]]);
    }

    /// Verifies a dimmable device scales the level directly up to the mapping's on value,
    /// full brightness by default or a dimmer chosen color, and darkens at zero.
    #[test]
    fn dimmable_device_scales_level_to_its_on_value() {
        let (mut app, rx) = level_feedback_app("Intech Grid MIDI device", MidiLedValues::default());

        assert_eq!(frame(&mut app, &rx), vec![vec![0x90, 60, 64]]);
        app.insert_resource(TestLevel(0.1));
        assert_eq!(frame(&mut app, &rx), vec![vec![0x90, 60, 13]]);
        app.insert_resource(TestLevel(0.0));
        assert_eq!(frame(&mut app, &rx), vec![vec![0x90, 60, 0]]);

        let mut mappings = app.world().resource::<MidiMappings>().mappings().to_vec();
        mappings[0].led.on = Some(64);
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .set_mappings(mappings);
        app.insert_resource(TestLevel(1.0));
        assert_eq!(frame(&mut app, &rx), vec![vec![0x90, 60, 64]]);
    }

    /// Verifies scaling interpolates between off and on values, so a lit off color stays
    /// the floor.
    #[test]
    fn scaled_runs_from_off_to_on() {
        let led = MidiLedValues {
            on: Some(100),
            off: Some(20),
            held: None,
        };

        assert_eq!(scaled(led, 0.0), 20);
        assert_eq!(scaled(led, 0.5), 60);
        assert_eq!(scaled(led, 1.0), 100);
    }
}
