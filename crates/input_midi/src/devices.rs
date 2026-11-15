// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The controllers a show knows, and which connected port each one is plugged in through.
//!
//! The show saves one [`MidiDeviceSetting`] per controller its mappings or feedback choices
//! refer to, and mappings store that device's ID. Identical units of one model are numbered,
//! so two APC minis show as "APC mini" and "APC mini (2)".
//!
//! Each connected port is assigned to a device by [`resolve`]:
//!
//! 1. A saved device of the same model that has seen the port's unit key (its USB serial, its
//!    USB port, or the OS's persistent port ID).
//! 2. Otherwise, when a model has one unassigned port and one saved device not plugged in,
//!    that device, which then learns the new key unless it only holds for the session. A lone
//!    controller moved to another USB port or another computer keeps its mappings this way.
//! 3. Otherwise the port is a new unit, numbered after the model's other devices, and saved
//!    once it is first mapped or its feedback is changed, so plugging a controller in alone
//!    never changes the show.

use std::collections::HashSet;

use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::profile;
use crate::service::{MidiPortInfo, is_session_key};

/// One controller the show saves, which mappings refer to by ID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct MidiDeviceSetting {
    /// Stable identity mappings store.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub id: Uuid,
    /// Device model name, without the instance number or address the OS adds.
    pub model: String,
    /// Number telling identical units of the model apart, from 1.
    pub number: u32,
    /// Unit keys the device has been seen with, such as its USB serial or USB port.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub units: Vec<String>,
    /// The operator's LED feedback choice; unset follows the model's controller profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<bool>,
}

impl MidiDeviceSetting {
    /// Returns the name the device is shown under: its model, numbered from the second unit.
    pub fn display_name(&self) -> String {
        display_name(&self.model, self.number)
    }

    /// Returns whether mapped controls on the device are sent their targets' state.
    pub fn feedback_enabled(&self) -> bool {
        self.feedback
            .unwrap_or_else(|| profile_default(&self.model))
    }
}

/// Returns the name unit `number` of `model` is shown under; the first unit keeps the plain
/// model name.
pub(crate) fn display_name(model: &str, number: u32) -> String {
    if number <= 1 {
        model.to_string()
    } else {
        format!("{model} ({number})")
    }
}

/// Returns whether a model's controller profile turns feedback on before the operator
/// chooses; models without a profile start off.
pub(crate) fn profile_default(model: &str) -> bool {
    profile::for_device(model).is_some_and(|profile| profile.feedback)
}

/// The devices a show saves, in the order they were added.
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct MidiDeviceRegistry(Vec<MidiDeviceSetting>);

impl MidiDeviceRegistry {
    /// Creates the registry from saved devices.
    ///
    /// A device ID that appears twice, as after merging an imported showfile, keeps its first
    /// entry, and a device repeating an earlier device's model and number gets the model's
    /// next free number.
    pub fn new(settings: impl IntoIterator<Item = MidiDeviceSetting>) -> Self {
        let mut registry = Self::default();
        for mut setting in settings {
            if registry.get(setting.id).is_some() {
                continue;
            }
            let taken = registry
                .0
                .iter()
                .any(|device| device.model == setting.model && device.number == setting.number);
            if setting.number == 0 || taken {
                setting.number = registry.next_number(&setting.model, &[]);
            }
            registry.0.push(setting);
        }
        registry
    }

    /// Returns the saved devices, for saving and for clients.
    pub fn settings(&self) -> &[MidiDeviceSetting] {
        &self.0
    }

    /// Returns the saved device with ID `id`.
    pub fn get(&self, id: Uuid) -> Option<&MidiDeviceSetting> {
        self.0.iter().find(|device| device.id == id)
    }

    /// Returns whether a saved device receives feedback; unknown devices do not.
    pub fn feedback_enabled(&self, id: Uuid) -> bool {
        self.get(id)
            .is_some_and(MidiDeviceSetting::feedback_enabled)
    }

    /// Turns feedback on or off for a saved device and reports whether that changed anything.
    ///
    /// Choosing what the model's profile would choose anyway clears the stored choice, so the
    /// device keeps following its profile.
    pub fn set_feedback(&mut self, id: Uuid, enabled: bool) -> bool {
        let Some(device) = self.0.iter_mut().find(|device| device.id == id) else {
            return false;
        };
        let was_enabled = device.feedback_enabled();
        device.feedback = (enabled != profile_default(&device.model)).then_some(enabled);
        was_enabled != enabled
    }

    /// Saves a new device, giving it the model's next free number when a saved device of the
    /// same model already uses its number.
    pub(crate) fn insert(&mut self, mut device: MidiDeviceSetting) {
        let taken = self
            .0
            .iter()
            .any(|saved| saved.model == device.model && saved.number == device.number);
        if device.number == 0 || taken {
            device.number = self.next_number(&device.model, &[]);
        }
        self.0.push(device);
    }

    /// Records that saved device `id` was seen with unit key `unit`; returns whether the key
    /// was new. Session keys are never recorded, since they name another unit later.
    pub(crate) fn learn_unit(&mut self, id: Uuid, unit: &str) -> bool {
        if is_session_key(unit) {
            return false;
        }
        let Some(device) = self.0.iter_mut().find(|device| device.id == id) else {
            return false;
        };
        if device.units.iter().any(|known| known == unit) {
            return false;
        }
        device.units.push(unit.to_string());
        true
    }

    /// Returns the lowest number from 1 that no saved device of `model` uses and that is not
    /// in `taken`.
    fn next_number(&self, model: &str, taken: &[u32]) -> u32 {
        (1..)
            .find(|number| {
                !taken.contains(number)
                    && !self
                        .0
                        .iter()
                        .any(|device| device.model == model && device.number == *number)
            })
            .unwrap_or(1)
    }
}

/// One connected input port and the device it is assigned to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConnectedDevice {
    /// OS port ID events and feedback are addressed by.
    pub(crate) port: String,
    /// Device model name.
    pub(crate) model: String,
    /// Key that stays with the physical unit, such as its USB serial.
    pub(crate) unit: String,
    /// Whether an output is paired with the port for feedback.
    pub(crate) has_output: bool,
    /// Saved device the port is assigned to, or the ID the unit will be saved under.
    pub(crate) device: Uuid,
    /// Name the device is shown under.
    pub(crate) name: String,
    /// Number of a unit the show does not save yet; `None` once it is saved.
    pub(crate) unsaved_number: Option<u32>,
}

impl ConnectedDevice {
    /// Returns the setting a unit the show does not save yet is saved as.
    pub(crate) fn unsaved_setting(&self) -> Option<MidiDeviceSetting> {
        self.unsaved_number.map(|number| MidiDeviceSetting {
            id: self.device,
            model: self.model.clone(),
            number,
            units: (!is_session_key(&self.unit))
                .then(|| self.unit.clone())
                .into_iter()
                .collect(),
            feedback: None,
        })
    }
}

/// Connected MIDI ports, in discovery order, each assigned to a device.
#[derive(Resource, Default, Debug, Clone, PartialEq, Eq)]
pub struct MidiDevices(Vec<ConnectedDevice>);

impl MidiDevices {
    /// Creates the list from already assigned ports.
    #[cfg(test)]
    pub(crate) fn new(devices: Vec<ConnectedDevice>) -> Self {
        Self(devices)
    }

    /// Returns the connected ports.
    pub(crate) fn iter(&self) -> impl Iterator<Item = &ConnectedDevice> {
        self.0.iter()
    }

    /// Returns the device connected through input port `port`.
    pub(crate) fn by_port(&self, port: &str) -> Option<&ConnectedDevice> {
        self.0.iter().find(|connected| connected.port == port)
    }

    /// Returns the port device `id` is connected through.
    pub(crate) fn by_device(&self, id: Uuid) -> Option<&ConnectedDevice> {
        self.0.iter().find(|connected| connected.device == id)
    }

    /// Returns whether device `id` is connected.
    pub(crate) fn is_connected(&self, id: Uuid) -> bool {
        self.by_device(id).is_some()
    }
}

/// One discovered port and whether an output is paired with it.
pub(crate) type DiscoveredPort = (MidiPortInfo, bool);

/// Assigns each connected port to a device, following the rules in the module docs.
///
/// A new unit that was already connected in `previous` keeps the ID and number it had there,
/// so a client can map it by that ID. Returns the assignments and the unit keys saved devices
/// learned, which the caller records in the registry.
pub(crate) fn resolve(
    ports: &[DiscoveredPort],
    registry: &MidiDeviceRegistry,
    previous: &MidiDevices,
) -> (MidiDevices, Vec<(Uuid, String)>) {
    let mut assigned: Vec<Option<Uuid>> = vec![None; ports.len()];
    let mut taken: HashSet<Uuid> = HashSet::new();
    for (index, (port, _)) in ports.iter().enumerate() {
        let known = registry.settings().iter().find(|device| {
            device.model == port.model
                && !taken.contains(&device.id)
                && device.units.contains(&port.unit)
        });
        if let Some(device) = known {
            assigned[index] = Some(device.id);
            taken.insert(device.id);
        }
    }

    let mut learned = Vec::new();
    let mut models: Vec<&str> = Vec::new();
    for (index, (port, _)) in ports.iter().enumerate() {
        if assigned[index].is_none() && !models.contains(&port.model.as_str()) {
            models.push(&port.model);
        }
    }
    for model in models {
        let waiting: Vec<usize> = (0..ports.len())
            .filter(|index| assigned[*index].is_none() && ports[*index].0.model == model)
            .collect();
        let free: Vec<&MidiDeviceSetting> = registry
            .settings()
            .iter()
            .filter(|device| device.model == model && !taken.contains(&device.id))
            .collect();
        if let ([index], [device]) = (waiting.as_slice(), free.as_slice()) {
            assigned[*index] = Some(device.id);
            taken.insert(device.id);
            let unit = &ports[*index].0.unit;
            if !is_session_key(unit) {
                learned.push((device.id, unit.clone()));
            }
        }
    }

    // New units that were already connected keep their ID and number unless a saved device
    // now uses it; the rest take the lowest free numbers afterwards.
    let mut unsaved: Vec<Option<(Uuid, u32)>> = vec![None; ports.len()];
    let mut unsaved_numbers: Vec<(&str, u32)> = Vec::new();
    for (index, (port, _)) in ports.iter().enumerate() {
        if assigned[index].is_some() {
            continue;
        }
        let kept = previous
            .by_port(&port.port)
            .filter(|earlier| earlier.unit == port.unit)
            .and_then(|earlier| Some((earlier.device, earlier.unsaved_number?)))
            .filter(|(id, number)| {
                registry.get(*id).is_none()
                    && !unsaved_numbers.contains(&(port.model.as_str(), *number))
                    && !registry
                        .settings()
                        .iter()
                        .any(|device| device.model == port.model && device.number == *number)
            });
        if let Some((id, number)) = kept {
            unsaved[index] = Some((id, number));
            unsaved_numbers.push((&port.model, number));
        }
    }
    for (index, (port, _)) in ports.iter().enumerate() {
        if assigned[index].is_some() || unsaved[index].is_some() {
            continue;
        }
        let taken_numbers: Vec<u32> = unsaved_numbers
            .iter()
            .filter(|(model, _)| *model == port.model)
            .map(|(_, number)| *number)
            .collect();
        let number = registry.next_number(&port.model, &taken_numbers);
        unsaved[index] = Some((Uuid::new_v4(), number));
        unsaved_numbers.push((&port.model, number));
    }

    let devices = ports
        .iter()
        .zip(assigned.into_iter().zip(unsaved))
        .map(|((port, has_output), (assigned, unsaved))| {
            let (device, unsaved_number, name) = match (assigned, unsaved) {
                (Some(device), _) => {
                    let name = registry
                        .get(device)
                        .map(MidiDeviceSetting::display_name)
                        .unwrap_or_default();
                    (device, None, name)
                }
                (None, Some((id, number))) => (id, Some(number), display_name(&port.model, number)),
                (None, None) => unreachable!("every unassigned port is numbered above"),
            };
            ConnectedDevice {
                port: port.port.clone(),
                model: port.model.clone(),
                unit: port.unit.clone(),
                has_output: *has_output,
                device,
                name,
                unsaved_number,
            }
        })
        .collect();
    (MidiDevices(devices), learned)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a discovered port with an output.
    fn port(port: &str, model: &str, unit: &str) -> DiscoveredPort {
        (
            MidiPortInfo {
                port: port.to_string(),
                model: model.to_string(),
                unit: unit.to_string(),
            },
            true,
        )
    }

    /// Builds a saved device with a deterministic ID.
    fn device(id: u128, model: &str, number: u32, units: &[&str]) -> MidiDeviceSetting {
        MidiDeviceSetting {
            id: Uuid::from_u128(id),
            model: model.to_string(),
            number,
            units: units.iter().map(|unit| (*unit).to_string()).collect(),
            feedback: None,
        }
    }

    /// Returns each port's device ID and, for new units, their number.
    fn assignments(devices: &MidiDevices) -> Vec<(Uuid, Option<u32>)> {
        devices
            .iter()
            .map(|connected| (connected.device, connected.unsaved_number))
            .collect()
    }

    /// Verifies two identical units go to the saved devices that know their unit keys, in
    /// whichever order the OS lists them.
    #[test]
    fn units_go_to_the_devices_that_know_them() {
        let registry = MidiDeviceRegistry::new([
            device(1, "APC mini", 1, &["usb:a"]),
            device(2, "APC mini", 2, &["usb:b"]),
        ]);
        let ports = [
            port("p1", "APC mini", "usb:b"),
            port("p2", "APC mini", "usb:a"),
        ];

        let (devices, learned) = resolve(&ports, &registry, &MidiDevices::default());

        assert_eq!(
            assignments(&devices),
            vec![(Uuid::from_u128(2), None), (Uuid::from_u128(1), None)]
        );
        assert!(learned.is_empty());
    }

    /// Verifies a lone unit with an unknown key takes the model's only free saved device and
    /// learns the key, while several unknown units of one model stay new.
    #[test]
    fn a_lone_unit_takes_the_free_device_of_its_model() {
        let registry = MidiDeviceRegistry::new([device(1, "Grid", 1, &["usb:old-port"])]);

        let (devices, learned) = resolve(
            &[port("p1", "Grid", "usb:new-port")],
            &registry,
            &MidiDevices::default(),
        );
        assert_eq!(assignments(&devices), vec![(Uuid::from_u128(1), None)]);
        assert_eq!(
            learned,
            vec![(Uuid::from_u128(1), "usb:new-port".to_string())]
        );

        let (devices, learned) = resolve(
            &[port("p1", "Grid", "usb:x"), port("p2", "Grid", "usb:y")],
            &registry,
            &MidiDevices::default(),
        );
        assert!(learned.is_empty());
        assert_eq!(
            devices
                .iter()
                .map(|connected| connected.unsaved_number)
                .collect::<Vec<_>>(),
            vec![Some(2), Some(3)]
        );
    }

    /// Verifies a new unit keeps its ID and number while it stays connected, so a client can
    /// map it by that ID, and takes a fresh number when a saved device claims its old one.
    #[test]
    fn new_units_keep_their_id_while_connected() {
        let ports = [port("p1", "Pad", "usb:a"), port("p2", "Pad", "usb:b")];
        let (first, _) = resolve(
            &ports,
            &MidiDeviceRegistry::default(),
            &MidiDevices::default(),
        );
        let (second, _) = resolve(&ports, &MidiDeviceRegistry::default(), &first);
        assert_eq!(assignments(&first), assignments(&second));
        assert_eq!(
            first
                .iter()
                .map(|connected| connected.unsaved_number)
                .collect::<Vec<_>>(),
            vec![Some(1), Some(2)]
        );

        let registry = MidiDeviceRegistry::new([device(9, "Pad", 1, &["usb:elsewhere"])]);
        let (third, _) = resolve(&ports, &registry, &second);
        assert_eq!(
            third
                .iter()
                .map(|connected| connected.unsaved_number)
                .collect::<Vec<_>>(),
            vec![Some(3), Some(2)]
        );
    }

    /// Verifies a lone unit with a session key still takes the free device of its model, but
    /// the device does not learn the key, since it names another unit after a replug.
    #[test]
    fn session_keys_are_not_learned() {
        let registry = MidiDeviceRegistry::new([device(1, "Pad", 1, &[])]);

        let (devices, learned) = resolve(
            &[port("128:0", "Pad", "session:128:0")],
            &registry,
            &MidiDevices::default(),
        );

        assert_eq!(assignments(&devices), vec![(Uuid::from_u128(1), None)]);
        assert!(learned.is_empty());
    }

    /// Verifies saving a unit whose number a saved device of its model took meanwhile gives
    /// it the next free number.
    #[test]
    fn inserting_a_taken_number_renumbers() {
        let mut registry = MidiDeviceRegistry::new([device(1, "Pad", 2, &[])]);
        registry.insert(device(2, "Pad", 2, &["usb:b"]));

        assert_eq!(registry.get(Uuid::from_u128(2)).unwrap().number, 1);
    }

    /// Verifies loading devices drops repeated IDs and renumbers a repeated model number.
    #[test]
    fn registry_keeps_ids_and_numbers_unique() {
        let registry = MidiDeviceRegistry::new([
            device(1, "Pad", 1, &[]),
            device(1, "Pad", 3, &[]),
            device(2, "Pad", 1, &[]),
        ]);

        assert_eq!(
            registry
                .settings()
                .iter()
                .map(|device| (device.id, device.number))
                .collect::<Vec<_>>(),
            vec![(Uuid::from_u128(1), 1), (Uuid::from_u128(2), 2)]
        );
        assert_eq!(
            registry.get(Uuid::from_u128(2)).unwrap().display_name(),
            "Pad (2)"
        );
    }

    /// Verifies a profiled model starts with feedback on, stores only a choice that differs
    /// from its profile, and an unprofiled model starts off.
    #[test]
    fn feedback_follows_the_profile_until_chosen() {
        let mut registry =
            MidiDeviceRegistry::new([device(1, "Launchpad", 1, &[]), device(2, "Pad", 1, &[])]);
        let launchpad = Uuid::from_u128(1);
        assert!(registry.feedback_enabled(launchpad));
        assert!(!registry.feedback_enabled(Uuid::from_u128(2)));

        assert!(registry.set_feedback(launchpad, false));
        assert_eq!(registry.get(launchpad).unwrap().feedback, Some(false));
        assert!(!registry.set_feedback(launchpad, false));
        assert!(registry.set_feedback(launchpad, true));
        assert_eq!(registry.get(launchpad).unwrap().feedback, None);
    }
}
