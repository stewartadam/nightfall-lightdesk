// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Schema 27 → 28: MIDI mappings refer to saved devices by ID instead of by port name.
//!
//! Mappings stored the port name of their device in `device_name`, and LED feedback choices
//! were kept per port name in `midiFeedbackDevices`. Identical controllers share a port name
//! on some systems, so each controller is now a saved device in `midiDevices` with a model
//! name and a number, and mappings store its ID.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};
use uuid::Uuid;

/// One device built from a port name used by the old schema.
struct LegacyDevice {
    /// ID the device is saved under.
    id: Uuid,
    /// Port name with the instance number or address the OS added removed.
    model: String,
    /// Instance number or address the OS added, which orders identical units.
    instance: String,
    /// LED feedback choice saved for the port name, if any.
    feedback: Option<bool>,
}

/// Turns every port name used by mappings and feedback choices into a saved device and
/// points each mapping at its device.
///
/// Port names of one model are numbered by the instance the OS added to them, so on Windows
/// `MIDIIN2 (APC MINI)` becomes "APC MINI (2)". ALSA addresses changed on every replug, so
/// all ALSA names of one model become one device. Devices start without unit keys and learn
/// them when their controller is next connected.
pub(super) fn migrate_v27_to_v28(showfile: &mut Value) -> Result<(), String> {
    let Some(root) = showfile.as_object_mut() else {
        return Err("showfile must be an object".to_string());
    };
    let feedback = take_feedback_choices(root)?;
    let mut devices: BTreeMap<String, LegacyDevice> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut add = |name: &str, devices: &mut BTreeMap<String, LegacyDevice>| {
        let key = device_key(name);
        let device = devices.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            let (model, instance) = split_port_name(name);
            LegacyDevice {
                id: Uuid::new_v4(),
                model: model.to_string(),
                instance: instance.to_string(),
                feedback: None,
            }
        });
        if device.feedback.is_none() {
            device.feedback = feedback.get(name).copied();
        }
        key
    };

    if let Some(mappings) = root.get_mut("midiMappings") {
        let Some(mappings) = mappings.as_array_mut() else {
            return Err("showfile midiMappings must be an array".to_string());
        };
        for mapping in mappings {
            let Some(mapping) = mapping.as_object_mut() else {
                return Err("showfile MIDI mapping must be an object".to_string());
            };
            let name = match mapping.remove("device_name") {
                Some(Value::String(name)) => name,
                _ => return Err("showfile MIDI mapping must name its device".to_string()),
            };
            let key = add(&name, &mut devices);
            mapping.insert(
                "device".to_string(),
                Value::from(devices[&key].id.simple().to_string()),
            );
        }
    }
    for name in feedback.keys() {
        add(name, &mut devices);
    }

    let mut numbered: Vec<(&String, u32)> = Vec::new();
    let mut by_model: BTreeMap<&str, Vec<&String>> = BTreeMap::new();
    for name in &order {
        by_model.entry(&devices[name].model).or_default().push(name);
    }
    for names in by_model.values_mut() {
        names.sort_by_key(|name| instance_order(&devices[*name].instance));
        numbered.extend(names.iter().zip(1..).map(|(name, number)| (*name, number)));
    }
    let saved: Vec<Value> = order
        .iter()
        .map(|name| {
            let device = &devices[name];
            let number = numbered
                .iter()
                .find(|(numbered_name, _)| *numbered_name == name)
                .map_or(1, |(_, number)| *number);
            let mut saved = json!({
                "id": device.id.simple().to_string(),
                "model": device.model,
                "number": number,
            });
            if let Some(enabled) = device.feedback {
                saved["feedback"] = Value::from(enabled);
            }
            saved
        })
        .collect();
    if !saved.is_empty() {
        root.insert("midiDevices".to_string(), Value::Array(saved));
    }
    Ok(())
}

/// Returns the key one device is built under for a port name: the name itself, or the model
/// for an ALSA name, whose address named no unit for long.
fn device_key(name: &str) -> String {
    match split_alsa_address(name.trim()) {
        Some((model, _)) => format!("alsa:{model}"),
        None => format!("name:{}", name.trim()),
    }
}

/// Removes the per-port-name feedback choices and returns them by port name; the first
/// choice for a name wins.
fn take_feedback_choices(root: &mut Map<String, Value>) -> Result<BTreeMap<String, bool>, String> {
    let mut choices = BTreeMap::new();
    let entries = match root.remove("midiFeedbackDevices") {
        None | Some(Value::Null) => return Ok(choices),
        Some(Value::Array(entries)) => entries,
        Some(_) => return Err("showfile midiFeedbackDevices must be an array".to_string()),
    };
    for entry in entries {
        let device = entry.get("device").and_then(Value::as_str);
        let enabled = entry.get("enabled").and_then(Value::as_bool);
        let (Some(device), Some(enabled)) = (device, enabled) else {
            return Err("showfile MIDI feedback choice needs a device and enabled".to_string());
        };
        choices.entry(device.to_string()).or_insert(enabled);
    }
    Ok(choices)
}

/// Orders instances so the plain name comes first and numbered instances follow by number.
fn instance_order(instance: &str) -> (bool, u64, String) {
    (
        !instance.is_empty(),
        instance.parse().unwrap_or(u64::MAX),
        instance.to_string(),
    )
}

/// Splits a port name as the old schema stored it into the device model and the instance the
/// OS added: Windows wraps later units as `MIDIIN2 (APC MINI)`, and ALSA appends a
/// `client:port` address whose client is the instance.
///
/// This copies the runtime's port-name parsing as it stood at schema 28 on purpose: the
/// migration must keep reading schema 27 names the same way even if the runtime changes.
fn split_port_name(name: &str) -> (&str, &str) {
    let name = name.trim();
    split_windows_wrapper(name)
        .or_else(|| split_alsa_address(name))
        .unwrap_or((name, ""))
}

/// Returns the device name and instance number inside a Windows `MIDIIN<n> (...)` or
/// `MIDIOUT<n> (...)` wrapper.
fn split_windows_wrapper(name: &str) -> Option<(&str, &str)> {
    let rest = name
        .strip_prefix("MIDIIN")
        .or_else(|| name.strip_prefix("MIDIOUT"))?;
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let (index, rest) = rest.split_at(digits);
    let device = rest.strip_prefix(" (")?.strip_suffix(')')?;
    Some((device, index))
}

/// Returns the name without a trailing ALSA ` <client>:<port>` address, plus the client.
fn split_alsa_address(name: &str) -> Option<(&str, &str)> {
    let (head, address) = name.rsplit_once(' ')?;
    let (client, port) = address.split_once(':')?;
    let numeric = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit());
    (numeric(client) && numeric(port)).then_some((head, client))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a schema 27 MIDI mapping on port `device` for note `note`.
    fn v27_mapping(device: &str, note: u8) -> Value {
        json!({
            "id": Uuid::from_u128(u128::from(note)).to_string(),
            "device_name": device,
            "source": { "type": "Note", "data": { "channel": 0, "note": note } },
            "action": { "id": "test.trigger", "arguments": {} }
        })
    }

    /// Verifies each port name becomes one numbered device, identical Windows units are
    /// numbered by instance, mappings point at their device, and feedback choices move onto
    /// the devices, including a device only a choice names.
    #[test]
    fn port_names_become_numbered_devices() {
        let mut showfile = json!({
            "midiMappings": [
                v27_mapping("MIDIIN2 (APC MINI)", 1),
                v27_mapping("APC MINI", 2),
                v27_mapping("MIDIIN2 (APC MINI)", 3),
                v27_mapping("Launchpad", 4),
            ],
            "midiFeedbackDevices": [
                { "device": "APC MINI", "enabled": true },
                { "device": "X-Touch", "enabled": false }
            ]
        });
        migrate_v27_to_v28(&mut showfile).unwrap();

        assert!(showfile.get("midiFeedbackDevices").is_none());
        let devices = showfile["midiDevices"].as_array().unwrap();
        let summary: Vec<_> = devices
            .iter()
            .map(|device| {
                (
                    device["model"].as_str().unwrap(),
                    device["number"].as_u64().unwrap(),
                    device.get("feedback").and_then(Value::as_bool),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("APC MINI", 2, None),
                ("APC MINI", 1, Some(true)),
                ("Launchpad", 1, None),
                ("X-Touch", 1, Some(false)),
            ]
        );

        let mappings = showfile["midiMappings"].as_array().unwrap();
        assert!(
            mappings
                .iter()
                .all(|mapping| mapping.get("device_name").is_none())
        );
        assert_eq!(mappings[0]["device"], devices[0]["id"]);
        assert_eq!(mappings[1]["device"], devices[1]["id"]);
        assert_eq!(mappings[2]["device"], devices[0]["id"]);
        assert_eq!(mappings[3]["device"], devices[2]["id"]);
    }

    /// Verifies every ALSA name of one model, whose address changed on each replug, becomes
    /// one device.
    #[test]
    fn alsa_names_of_one_model_become_one_device() {
        let mut showfile = json!({
            "midiMappings": [
                v27_mapping("APC MINI:APC MINI MIDI 1 20:0", 1),
                v27_mapping("APC MINI:APC MINI MIDI 1 24:0", 2),
            ]
        });
        migrate_v27_to_v28(&mut showfile).unwrap();

        let devices = showfile["midiDevices"].as_array().unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0]["model"], "APC MINI:APC MINI MIDI 1");
        let mappings = showfile["midiMappings"].as_array().unwrap();
        assert_eq!(mappings[0]["device"], devices[0]["id"]);
        assert_eq!(mappings[1]["device"], devices[0]["id"]);
    }

    /// Verifies a show without MIDI mappings gains no devices.
    #[test]
    fn shows_without_midi_are_unchanged() {
        let mut showfile = json!({ "fixtures": [] });
        migrate_v27_to_v28(&mut showfile).unwrap();
        assert_eq!(showfile, json!({ "fixtures": [] }));
    }
}
