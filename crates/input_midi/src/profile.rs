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

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};

use serde::{Deserialize, Serialize};

use crate::command::MidiLedValues;

/// Profile files embedded in the binary, in matching order.
const BUNDLED_PROFILES: &[(&str, &str)] = &[
    (
        "novation-launchpad.json",
        include_str!("../profiles/novation-launchpad.json"),
    ),
    (
        "intech-grid.json",
        include_str!("../profiles/intech-grid.json"),
    ),
];

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
    /// Which input port names the profile applies to.
    ports: PortMatch,
    /// Whether LED feedback is on for matching devices until the operator turns it off.
    pub(crate) feedback: bool,
    /// Advice shown with the device, such as a setting the hardware needs.
    #[serde(default)]
    pub(crate) hint: Option<String>,
    /// Messages sent before any LED state, when the device connects or feedback turns on.
    pub(crate) init: Vec<Vec<u8>>,
    /// Messages sent when feedback turns off, after each LED is darkened.
    pub(crate) release: Vec<Vec<u8>>,
    /// Named LED values, in the order the UI lists them.
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

    /// Checks that the profile's messages, values and default colors are usable.
    fn validate(&self) -> Result<(), String> {
        for message in self.init.iter().chain(&self.release) {
            let Some((status, data)) = message.split_first() else {
                return Err("empty message".to_string());
            };
            if *status < 0x80 || data.iter().any(|byte| *byte > 0x7F) {
                return Err(format!("malformed message {message:?}"));
            }
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

/// Parses every bundled profile, panicking on a malformed file since they ship with the app
/// and are checked by tests.
fn parse_bundled() -> Vec<MidiProfile> {
    BUNDLED_PROFILES
        .iter()
        .map(|(file, json)| {
            let profile: MidiProfile = serde_json::from_str(json)
                .unwrap_or_else(|error| panic!("bundled MIDI profile {file}: {error}"));
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
        ("Launchpad MK2", None),
        ("Launchpad Mini MK3 LPMiniMK3 MIDI", None),
        ("Launchpad X LPX MIDI", None),
        ("Launchpad Pro", None),
        ("Intech Grid MIDI device", Some("intech.grid")),
        ("Monome Grid", None),
        ("APC mini mk2", None),
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

    /// Verifies validation rejects a default naming a color the profile does not list.
    #[test]
    fn validation_rejects_unknown_default_color() {
        let mut profile = for_device("Launchpad").expect("Launchpad profile").clone();
        profile.defaults.on = "Purple".to_string();

        assert!(profile.validate().is_err());
    }
}
