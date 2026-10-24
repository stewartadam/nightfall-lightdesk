// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bundled controller profiles: how to light the LEDs of known hardware families.
//!
//! A profile is matched to a device by its input port name. It decides whether LED feedback
//! is on before the operator chooses, which messages prepare and reset the device, and which
//! LED values the device understands, by name, so the UI can offer colors instead of numbers.
//! Profiles never create mappings.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock, PoisonError};

use serde::{Deserialize, Serialize};

use crate::command::{MidiLedValues, MidiSource};

/// Profile files embedded in the binary, in matching order.
const BUNDLED_PROFILES: &[(&str, &str)] = &[
    (
        "novation-launchpad.json",
        include_str!("../profiles/novation-launchpad.json"),
    ),
    (
        "novation-launchpad-mk2.json",
        include_str!("../profiles/novation-launchpad-mk2.json"),
    ),
    (
        "novation-launchpad-mini-mk3.json",
        include_str!("../profiles/novation-launchpad-mini-mk3.json"),
    ),
    (
        "akai-apc-mini.json",
        include_str!("../profiles/akai-apc-mini.json"),
    ),
    (
        "akai-apc-mini-mk2.json",
        include_str!("../profiles/akai-apc-mini-mk2.json"),
    ),
    (
        "akai-apc40-mkii.json",
        include_str!("../profiles/akai-apc40-mkii.json"),
    ),
    (
        "intech-grid.json",
        include_str!("../profiles/intech-grid.json"),
    ),
];

/// Color palettes embedded in the binary, shared by profiles of controllers whose LEDs
/// understand the same values. `rgb-128` is the velocity table of Novation Launchpads (MK2
/// and later) and Akai's APC mk2 controllers.
const BUNDLED_PALETTES: &[(&str, &str)] = &[(
    "palettes/rgb-128.json",
    include_str!("../profiles/palettes/rgb-128.json"),
)];

/// Named LED values several controller families share, such as a fixed RGB velocity table.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct LedPalette {
    /// Identifier profiles refer to the palette by.
    id: String,
    /// Upstream file the colors were converted from.
    #[serde(default)]
    source: Option<ProfileSource>,
    /// Named LED values, in the order the UI lists them.
    colors: Vec<MidiLedColor>,
}

/// Upstream file a profile's colors were converted from, credited because its license
/// requires the notice to travel with derived files.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileSource {
    /// Project the file comes from, such as `QLC+`.
    project: String,
    /// File name within that project.
    file: String,
    /// Authors the upstream file credits.
    authors: String,
    /// SPDX identifier of the upstream file's license.
    license: String,
}

/// Port name rule a profile matches devices by.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PortMatch {
    /// Lowercase fragments, any of which in the port name selects the profile.
    #[serde(rename = "match")]
    any: Vec<String>,
    /// Lowercase fragments that rule a port out, for later models with another protocol.
    #[serde(default)]
    exclude: Vec<String>,
}

impl PortMatch {
    /// Returns whether a port name contains one of the match fragments and none of the
    /// excluded ones, ignoring case.
    fn matches(&self, port_name: &str) -> bool {
        let name = port_name.to_lowercase();
        self.any
            .iter()
            .any(|fragment| name.contains(fragment.as_str()))
            && !self
                .exclude
                .iter()
                .any(|fragment| name.contains(fragment.as_str()))
    }
}

/// Notes whose LEDs listen on a fixed channel instead of the one the control sends on, such
/// as pads that pick their brightness by channel.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct LedChannel {
    /// First and last note number (inclusive) the rule applies to.
    notes: [u8; 2],
    /// Channel (0-15) LED messages for those notes are sent on.
    channel: u8,
}

/// Returns whether `message` is one complete MIDI message: a channel message with the data
/// bytes its status takes, or a SysEx message from `F0` to `F7`.
fn is_midi_message(message: &[u8]) -> bool {
    let data_only = |data: &[u8]| data.iter().all(|byte| *byte <= 0x7F);
    match message {
        [0xF0, data @ .., 0xF7] => data_only(data),
        [status @ 0x80..=0xEF, data @ ..] => {
            let length = if matches!(status & 0xF0, 0xC0 | 0xD0) {
                1
            } else {
                2
            };
            data.len() == length && data_only(data)
        }
        _ => false,
    }
}

/// One named LED value a device understands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[typeshare::typeshare]
pub struct MidiLedColor {
    /// Name shown in the UI, such as "Amber".
    pub name: String,
    /// Value sent to the control's note or controller (0-127).
    pub value: u8,
    /// CSS color approximating how the LED looks, for swatches.
    pub swatch: String,
    /// Whether the device blinks the LED by itself at this value.
    #[serde(default)]
    pub blink: bool,
    /// Values that show this color at rising brightness, ending at full, so a pad mapped to
    /// a fader can show its level; empty when the color has no dimmer versions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ramp: Vec<u8>,
}

/// Color names a profile uses for mappings that leave their LED values unset.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct DefaultColors {
    /// Shown while the target is idle.
    off: String,
    /// Shown while the target is running or enabled.
    on: String,
    /// Shown while a flash binding holds the target.
    held: String,
}

/// How to light one family of controllers, loaded from a bundled profile file.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MidiProfile {
    /// Stable identifier, such as `novation.launchpad`.
    pub(crate) id: String,
    /// Name shown next to a matching device.
    pub(crate) name: String,
    /// Upstream file the colors were converted from, for profiles that were not written
    /// from scratch.
    #[serde(default)]
    source: Option<ProfileSource>,
    /// Which input port names the profile applies to.
    ports: PortMatch,
    /// Whether LED feedback is on for matching devices until the operator turns it off.
    pub(crate) feedback: bool,
    /// Whether LED values are plain brightness, so a level scales between a mapping's off
    /// and on values instead of stepping through color ramps.
    #[serde(default)]
    pub(crate) dimmable: bool,
    /// Advice shown with the device, such as a setting the hardware needs.
    #[serde(default)]
    pub(crate) hint: Option<String>,
    /// Note ranges whose LEDs are lit on a fixed channel rather than the mapped one.
    #[serde(default, rename = "ledChannels")]
    led_channels: Vec<LedChannel>,
    /// Messages sent before any LED state, when the device connects or feedback turns on.
    pub(crate) init: Vec<Vec<u8>>,
    /// Messages sent when feedback turns off, after each LED is darkened.
    pub(crate) release: Vec<Vec<u8>>,
    /// Shared palette whose colors come before the profile's own, by palette id.
    #[serde(default)]
    palette: Option<String>,
    /// Named LED values, in the order the UI lists them; after loading, a palette's colors
    /// come first.
    #[serde(default)]
    pub(crate) colors: Vec<MidiLedColor>,
    /// Colors for mapping LED values left unset.
    defaults: DefaultColors,
}

impl MidiProfile {
    /// Returns the value of a named color.
    fn color_value(&self, name: &str) -> Option<u8> {
        self.colors
            .iter()
            .find(|color| color.name == name)
            .map(|color| color.value)
    }

    /// Returns the LED values mappings on a matching device use when they set none.
    pub(crate) fn default_led(&self) -> MidiLedValues {
        MidiLedValues {
            on: self.color_value(&self.defaults.on),
            off: self.color_value(&self.defaults.off),
            held: self.color_value(&self.defaults.held),
        }
    }

    /// Returns the brightness ramp of the color shown by `value`, or an empty slice when no
    /// listed color with a ramp uses that value.
    pub(crate) fn ramp(&self, value: u8) -> &[u8] {
        self.colors
            .iter()
            .find(|color| color.value == value && !color.ramp.is_empty())
            .map_or(&[], |color| color.ramp.as_slice())
    }

    /// Returns the address LED feedback for a mapped control is sent to: the control itself,
    /// or for a note in one of the profile's `ledChannels` ranges, that note on the range's
    /// channel.
    pub(crate) fn led_address(&self, source: MidiSource) -> MidiSource {
        let MidiSource::Note { note, .. } = source else {
            return source;
        };
        self.led_channels
            .iter()
            .find(|rule| (rule.notes[0]..=rule.notes[1]).contains(&note))
            .map_or(source, |rule| MidiSource::Note {
                channel: rule.channel,
                note,
            })
    }

    /// Checks that the profile's messages, values and default colors are usable.
    fn validate(&self) -> Result<(), String> {
        if let Some(message) = self
            .init
            .iter()
            .chain(&self.release)
            .find(|message| !is_midi_message(message))
        {
            return Err(format!("malformed message {message:?}"));
        }
        if let Some(rule) = self.led_channels.iter().find(|rule| {
            rule.notes[0] > rule.notes[1] || rule.notes[1] > 0x7F || rule.channel > 0x0F
        }) {
            return Err(format!("malformed LED channel rule {rule:?}"));
        }
        if let Some(color) = self
            .colors
            .iter()
            .find(|color| color.value > 0x7F || color.ramp.iter().any(|value| *value > 0x7F))
        {
            return Err(format!(
                "color {:?} has a value that is not a MIDI data byte",
                color.name
            ));
        }
        for name in [&self.defaults.off, &self.defaults.on, &self.defaults.held] {
            if self.color_value(name).is_none() {
                return Err(format!("default color {name:?} is not listed"));
            }
        }
        if let Some(source) = &self.source
            && [
                &source.project,
                &source.file,
                &source.authors,
                &source.license,
            ]
            .iter()
            .any(|field| field.trim().is_empty())
        {
            return Err("source must name its project, file, authors and license".to_string());
        }
        let mut names = HashSet::new();
        let mut values = HashSet::new();
        for color in &self.colors {
            if !names.insert(color.name.as_str()) {
                return Err(format!("color name {:?} is listed twice", color.name));
            }
            if !values.insert(color.value) {
                return Err(format!(
                    "color {:?} repeats value {}",
                    color.name, color.value
                ));
            }
        }
        if self.ports.any.is_empty() {
            return Err("no port match fragments".to_string());
        }
        let lowercase = |fragment: &String| *fragment == fragment.to_lowercase();
        if !self
            .ports
            .any
            .iter()
            .chain(&self.ports.exclude)
            .all(lowercase)
        {
            return Err("port fragments must be lowercase".to_string());
        }
        Ok(())
    }
}

/// Parses every bundled profile, putting the colors of the palette it names before its own,
/// and panics on a malformed file since they ship with the app and are checked by tests.
fn parse_bundled() -> Vec<MidiProfile> {
    let palettes: Vec<LedPalette> = BUNDLED_PALETTES
        .iter()
        .map(|(file, json)| {
            serde_json::from_str(json)
                .unwrap_or_else(|error| panic!("bundled MIDI palette {file}: {error}"))
        })
        .collect();
    BUNDLED_PROFILES
        .iter()
        .map(|(file, json)| {
            let mut profile: MidiProfile = serde_json::from_str(json)
                .unwrap_or_else(|error| panic!("bundled MIDI profile {file}: {error}"));
            if let Some(id) = &profile.palette {
                let palette = palettes
                    .iter()
                    .find(|palette| palette.id == *id)
                    .unwrap_or_else(|| panic!("bundled MIDI profile {file}: no palette {id:?}"));
                profile.colors = palette
                    .colors
                    .iter()
                    .cloned()
                    .chain(profile.colors)
                    .collect();
                profile.source = profile.source.or_else(|| palette.source.clone());
            }
            if let Err(error) = profile.validate() {
                panic!("bundled MIDI profile {file}: {error}");
            }
            profile
        })
        .collect()
}

/// Returns the bundled profiles, parsed once.
fn bundled() -> &'static [MidiProfile] {
    static PROFILES: OnceLock<Vec<MidiProfile>> = OnceLock::new();
    PROFILES.get_or_init(parse_bundled)
}

/// Returns the first bundled profile matching a device's input port name.
///
/// Feedback looks devices up every frame, so each name's match is remembered.
pub(crate) fn for_device(device: &str) -> Option<&'static MidiProfile> {
    static MATCHES: OnceLock<Mutex<HashMap<String, Option<usize>>>> = OnceLock::new();
    let profiles = bundled();
    let mut matches = MATCHES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let index = *matches.entry(device.to_string()).or_insert_with(|| {
        profiles
            .iter()
            .position(|profile| profile.ports.matches(device))
    });
    index.map(|index| &profiles[index])
}

/// The profile one device matches, sent to the UI so it can name colors and explain defaults.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct MidiDeviceProfile {
    /// Input device name the profile applies to, as stored on mappings.
    pub device: String,
    /// Stable profile identifier.
    pub id: String,
    /// Name of the hardware family.
    pub name: String,
    /// Advice shown with the device, such as a setting the hardware needs.
    pub hint: Option<String>,
    /// Named LED values, in display order.
    pub colors: Vec<MidiLedColor>,
    /// Values used by mappings that leave theirs unset.
    pub default_led: MidiLedValues,
}

impl MidiDeviceProfile {
    /// Copies the parts of a device's profile the UI shows.
    pub(crate) fn new(device: &str, profile: &MidiProfile) -> Self {
        Self {
            device: device.to_string(),
            id: profile.id.clone(),
            name: profile.name.clone(),
            hint: profile.hint.clone(),
            colors: profile.colors.clone(),
            default_led: profile.default_led(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Port names each family publishes on macOS, Windows and Linux (ALSA), with the
    /// profile they should match.
    const SAMPLE_PORTS: &[(&str, Option<&str>)] = &[
        ("Launchpad", Some("novation.launchpad")),
        ("Launchpad S", Some("novation.launchpad")),
        ("Launchpad Mini", Some("novation.launchpad")),
        (
            "Launchpad:Launchpad MIDI 1 20:0",
            Some("novation.launchpad"),
        ),
        ("2- Launchpad Mini", Some("novation.launchpad")),
        ("Launchpad MK2", Some("novation.launchpad-mk2")),
        (
            "Launchpad MK2:Launchpad MK2 MIDI 1 24:0",
            Some("novation.launchpad-mk2"),
        ),
        (
            "Launchpad Mini MK3 LPMiniMK3 MIDI",
            Some("novation.launchpad-mini-mk3"),
        ),
        (
            "Launchpad Mini MK3:Launchpad Mini MK3 LPMiniMK3 MI 20:1",
            Some("novation.launchpad-mini-mk3"),
        ),
        (
            "MIDIIN2 (LPMiniMK3 MIDI)",
            Some("novation.launchpad-mini-mk3"),
        ),
        ("Launchpad Mini MK3 LPMiniMK3 DAW", None),
        ("Launchpad X LPX MIDI", None),
        ("Launchpad Pro", None),
        ("Launchpad Pro MK2", None),
        ("Intech Grid MIDI device", Some("intech.grid")),
        ("Monome Grid", None),
        ("APC MINI", Some("akai.apc-mini")),
        ("APC MINI:APC MINI MIDI 1 28:0", Some("akai.apc-mini")),
        ("APC mini mk2", Some("akai.apc-mini-mk2")),
        ("APC mini mk2 Control", Some("akai.apc-mini-mk2")),
        ("APC mini mk2 Notes", None),
        ("MIDIIN2 (APC mini mk2)", None),
        ("APC40 mkII", Some("akai.apc40-mkii")),
        ("APC40 mkII:APC40 mkII MIDI 1 24:0", Some("akai.apc40-mkii")),
        ("APC40", None),
        ("IAC Driver Bus 1", None),
    ];

    /// Verifies every bundled profile parses and passes validation.
    #[test]
    fn bundled_profiles_are_valid() {
        let profiles = parse_bundled();
        assert_eq!(profiles.len(), BUNDLED_PROFILES.len());
        let mut ids: Vec<_> = profiles.iter().map(|profile| &profile.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), profiles.len(), "profile ids are unique");
    }

    /// Verifies sample port names select the right profile and later models with another
    /// protocol select none, and that no sample matches two profiles.
    #[test]
    fn port_names_select_profiles() {
        for (port, expected) in SAMPLE_PORTS {
            assert_eq!(
                for_device(port).map(|profile| profile.id.as_str()),
                *expected,
                "port {port:?}"
            );
            let matching = bundled()
                .iter()
                .filter(|profile| profile.ports.matches(port))
                .count();
            assert!(matching <= 1, "port {port:?} matches {matching} profiles");
        }
    }

    /// Verifies the Launchpad's defaults use its bit-field values: off keeps the clear and
    /// copy flags, green is full green, and held flashes amber.
    #[test]
    fn launchpad_defaults_use_its_color_values() {
        let profile = for_device("Launchpad").expect("Launchpad profile");

        assert_eq!(
            profile.default_led(),
            MidiLedValues {
                on: Some(60),
                off: Some(12),
                held: Some(59),
            }
        );
    }

    /// Verifies the Launchpad's full colors ramp through its low, medium and full brightness
    /// values while dim and flashing colors have no ramp.
    #[test]
    fn launchpad_full_colors_have_brightness_ramps() {
        let profile = for_device("Launchpad").expect("Launchpad profile");

        assert_eq!(profile.ramp(60), &[28, 44, 60]);
        assert_eq!(profile.ramp(15), &[13, 14, 15]);
        assert_eq!(profile.ramp(63), &[29, 46, 63]);
        assert!(profile.ramp(28).is_empty());
        assert!(profile.ramp(59).is_empty());
    }

    /// Verifies the APC mini profile converted from QLC+ halves QLC+'s doubled color values,
    /// so its steady green is 1 and blinking green 2, and leaves feedback off until the
    /// colors are checked on the hardware.
    #[test]
    fn apc_mini_colors_are_halved_from_qlcplus() {
        let profile = for_device("APC MINI").expect("APC mini profile");

        assert_eq!(
            profile.default_led(),
            MidiLedValues {
                on: Some(1),
                off: Some(0),
                held: Some(2),
            }
        );
        assert!(!profile.feedback);
        assert!(profile.source.is_some());
    }

    /// Verifies the APC mini mk2 lights its pads (notes 0-63) on channel 7, its full
    /// brightness, while its single-color buttons and controllers keep the mapped address.
    #[test]
    fn apc_mini_mk2_pads_light_at_full_brightness() {
        let profile = for_device("APC mini mk2").expect("APC mini mk2 profile");
        let pad = MidiSource::Note {
            channel: 0,
            note: 63,
        };
        let button = MidiSource::Note {
            channel: 0,
            note: 0x64,
        };
        let fader = MidiSource::ControlChange {
            channel: 0,
            controller: 48,
        };

        assert_eq!(
            profile.led_address(pad),
            MidiSource::Note {
                channel: 6,
                note: 63
            }
        );
        assert_eq!(profile.led_address(button), button);
        assert_eq!(profile.led_address(fader), fader);
    }

    /// Verifies profiles naming the shared RGB palette list its 128 colors, with brightness
    /// ramps on the full colors, and credit the palette's QLC+ source.
    #[test]
    fn rgb_profiles_share_the_palette() {
        for port in [
            "Launchpad MK2",
            "LPMiniMK3 MIDI",
            "APC mini mk2",
            "APC40 mkII",
        ] {
            let profile = for_device(port).expect("RGB profile");

            assert_eq!(profile.colors.len(), 128, "{port}");
            assert_eq!(profile.ramp(5), &[7, 6, 5], "{port}");
            assert!(profile.source.is_some(), "{port}");
        }
    }

    /// Verifies init and release messages may be SysEx framed by F0 and F7 or channel
    /// messages with the right number of data bytes, but not messages carrying bytes above
    /// 127, an unterminated SysEx, a lone EOX or a bare data byte.
    #[test]
    fn messages_allow_complete_sysex() {
        assert!(is_midi_message(&[0xF0, 0x00, 0x20, 0x29, 0xF7]));
        assert!(is_midi_message(&[0xB0, 0, 0]));
        assert!(is_midi_message(&[0xC0, 5]));
        assert!(!is_midi_message(&[0xB0, 0]));
        assert!(!is_midi_message(&[0x90, 1, 2, 3]));
        assert!(!is_midi_message(&[0xF7]));
        assert!(!is_midi_message(&[0xF0, 0x00, 0x20]));
        assert!(!is_midi_message(&[0xF0, 0x80, 0xF7]));
        assert!(!is_midi_message(&[0xB0, 0, 0xF7]));
        assert!(!is_midi_message(&[0x40]));
        assert!(!is_midi_message(&[]));
    }

    /// Verifies validation rejects a profile listing two colors under one name or one value,
    /// since defaults pick colors by name and ramps and the UI look them up by value.
    #[test]
    fn validation_rejects_repeated_colors() {
        let launchpad = for_device("Launchpad").expect("Launchpad profile");
        let mut same_name = launchpad.clone();
        let mut repeated = same_name.colors[1].clone();
        repeated.value = 0;
        same_name.colors.push(repeated);
        let mut same_value = launchpad.clone();
        let mut repeated = same_value.colors[1].clone();
        repeated.name = "Another red".to_string();
        same_value.colors.push(repeated);

        assert!(same_name.validate().is_err());
        assert!(same_value.validate().is_err());
    }

    /// Verifies validation rejects a default naming a color the profile does not list.
    #[test]
    fn validation_rejects_unknown_default_color() {
        let mut profile = for_device("Launchpad").expect("Launchpad profile").clone();
        profile.defaults.on = "Purple".to_string();

        assert!(profile.validate().is_err());
    }
}
