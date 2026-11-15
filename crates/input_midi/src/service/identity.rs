// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Tells MIDI ports of identical devices apart.
//!
//! Operating systems name identical controllers inconsistently: CoreMIDI gives both units the
//! same name, Windows wraps the second one as `MIDIIN2 (APC MINI)`, and ALSA appends a
//! `client:port` address that changes on every replug. A [`PortIdentity`] reduces a port to the
//! device's plain name, a key that stays with one physical unit, and a pairing key that groups
//! one unit's input and output ports.

/// What sets one MIDI port's device apart from other ports with the same name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PortIdentity {
    /// Device name without the instance number or address the OS adds to tell units apart.
    pub(crate) base: String,
    /// Key that stays with one physical unit across replugs and restarts where the OS allows:
    /// the USB serial or USB port on Linux, and the OS's own persistent port ID elsewhere.
    /// Ports the OS cannot tell apart persistently get a session key (see [`is_session_key`]).
    pub(crate) unit: String,
    /// Key shared by one unit's input and output ports, so feedback reaches the same unit.
    pub(crate) pairing: String,
}

/// Describes the port with OS port ID `id` and name `name`.
///
/// The OS lookups behind the unit and pairing keys fall back to the port ID and the instance
/// in the name when the OS cannot answer, which keeps ports apart for this session.
pub(crate) fn port_identity(id: &str, name: &str) -> PortIdentity {
    let (_, instance) = pairing_key(name);
    let unit = platform::unit_key(id, instance).unwrap_or_else(|| platform::fallback_unit_key(id));
    let (base, pairing) = port_pairing(id, name);
    PortIdentity {
        base,
        unit,
        pairing,
    }
}

/// Prefix of unit keys that only hold for the current session, such as a Linux port with no
/// USB device behind it, whose ALSA address changes on every replug and is later reused.
const SESSION_KEY_PREFIX: &str = "session:";

/// Returns whether a unit key only holds for the current session, so it must not be saved or
/// trusted to name the same unit later.
pub(crate) fn is_session_key(unit: &str) -> bool {
    unit.starts_with(SESSION_KEY_PREFIX)
}

/// Returns the device name and pairing key of a port, without the unit lookup, for output
/// ports that only need to be matched to an input.
pub(crate) fn port_pairing(id: &str, name: &str) -> (String, String) {
    let (base, instance) = pairing_key(name);
    let pairing = platform::pairing_key(id).unwrap_or_else(|| instance.to_string());
    (base.to_string(), pairing)
}

/// Reduces a port name to the device it belongs to and that device's instance, so an
/// input and output of one device compare equal while two identical devices stay apart.
///
/// - Windows numbers duplicate devices as `MIDIIN2 (APC MINI)` / `MIDIOUT2 (APC MINI)`; the
///   first unit's ports carry the plain name. The number is the instance.
/// - ALSA appends the `client:port` address, as in `APC MINI:APC MINI MIDI 1 20:0`. A
///   device's input and output share its client but can sit on different ports, so the
///   client number is the instance.
///
/// CoreMIDI names a device's source and destination identically, so they need no change.
pub(crate) fn pairing_key(name: &str) -> (&str, &str) {
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

/// Builds a unit key from a USB device's IDs and its serial, or its port when it has none.
///
/// The serial follows the unit to any port. Units without one, or clones sharing one, are
/// told apart by the USB port they are plugged into instead.
fn usb_unit_key(vendor: &str, product: &str, serial: Option<&str>, port: &str) -> String {
    match serial.map(str::trim).filter(|serial| !serial.is_empty()) {
        Some(serial) => format!("usb:{vendor}:{product}:serial:{serial}"),
        None => format!("usb:{vendor}:{product}:port:{port}"),
    }
}

/// Linux: ALSA sequencer clients map to sound cards, whose USB device sysfs describes.
#[cfg(target_os = "linux")]
mod platform {
    use std::path::Path;

    use super::usb_unit_key;

    /// Root of the sysfs sound class, where each card links to its device.
    const SOUND_CLASS: &str = "/sys/class/sound";

    /// Returns the USB unit key of the card behind ALSA client `instance`, if it is a USB card.
    pub(super) fn unit_key(_id: &str, instance: &str) -> Option<String> {
        let client = instance.parse().ok()?;
        let card = alsa_client_card(client)?;
        usb_unit_from_sysfs(Path::new(SOUND_CLASS), card)
    }

    /// ALSA's client number already pairs a device's ports, so no lookup is needed.
    pub(super) fn pairing_key(_id: &str) -> Option<String> {
        None
    }

    /// ALSA addresses change on every replug and are reused, so a port without a USB device
    /// behind it, such as a virtual or Bluetooth port, only gets a session key.
    pub(super) fn fallback_unit_key(id: &str) -> String {
        format!("{}{id}", super::SESSION_KEY_PREFIX)
    }

    /// Returns the sound card number an ALSA sequencer client belongs to.
    fn alsa_client_card(client: i32) -> Option<i32> {
        let seq = alsa::Seq::open(None, None, true).ok()?;
        let card = seq.get_any_client_info(client).ok()?.get_card().ok()?;
        (card >= 0).then_some(card)
    }

    /// Reads the USB unit key of sound card `card` from a sysfs sound class directory.
    ///
    /// The card's `device` link points at its USB interface; the parent directory is the USB
    /// device, named after its port path and holding its IDs and optional serial.
    pub(super) fn usb_unit_from_sysfs(sound_class: &Path, card: i32) -> Option<String> {
        let interface = sound_class
            .join(format!("card{card}"))
            .join("device")
            .canonicalize()
            .ok()?;
        let device = interface.parent()?;
        let read = |file: &str| {
            std::fs::read_to_string(device.join(file))
                .ok()
                .map(|value| value.trim().to_string())
        };
        let vendor = read("idVendor")?;
        let product = read("idProduct")?;
        let port = device.file_name()?.to_str()?;
        Some(usb_unit_key(
            &vendor,
            &product,
            read("serial").as_deref(),
            port,
        ))
    }
}

/// macOS: CoreMIDI IDs persist per unit, and a unit's endpoints share one entity.
#[cfg(target_os = "macos")]
mod platform {
    use coremidi_sys::{
        MIDIEndpointGetEntity, MIDIObjectFindByUniqueID, MIDIObjectGetIntegerProperty,
        MIDIObjectRef, MIDIObjectType, kMIDIPropertyUniqueID,
    };

    /// CoreMIDI keeps an endpoint's unique ID across replugs and restarts, so it is the key.
    pub(super) fn unit_key(id: &str, _instance: &str) -> Option<String> {
        Some(format!("coremidi:{id}"))
    }

    /// Returns the unique ID of the entity owning endpoint `id`, shared by its source and
    /// destination.
    pub(super) fn pairing_key(id: &str) -> Option<String> {
        let unique_id = id.parse::<i32>().ok()?;
        let mut endpoint: MIDIObjectRef = 0;
        let mut object_type: MIDIObjectType = 0;
        // SAFETY: CoreMIDI writes the found object and its type through valid out pointers.
        let status =
            unsafe { MIDIObjectFindByUniqueID(unique_id, &mut endpoint, &mut object_type) };
        if status != 0 || endpoint == 0 {
            return None;
        }
        let mut entity: MIDIObjectRef = 0;
        // SAFETY: `endpoint` is a live endpoint reference and `entity` a valid out pointer.
        if unsafe { MIDIEndpointGetEntity(endpoint, &mut entity) } != 0 || entity == 0 {
            return None;
        }
        let mut entity_id: i32 = 0;
        // SAFETY: `entity` is a live object reference and the property key a CoreMIDI constant.
        let status =
            unsafe { MIDIObjectGetIntegerProperty(entity, kMIDIPropertyUniqueID, &mut entity_id) };
        (status == 0).then(|| format!("entity:{entity_id}"))
    }

    /// CoreMIDI always answers the unit key, so this only covers an unparsable port ID.
    pub(super) fn fallback_unit_key(id: &str) -> String {
        format!("port:{id}")
    }
}

/// Windows and other platforms: the port ID is the most stable key available.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod platform {
    /// Windows interface paths name the USB serial or port, so the port ID is kept as is.
    pub(super) fn unit_key(_id: &str, _instance: &str) -> Option<String> {
        None
    }

    /// The instance number in the port name pairs ports.
    pub(super) fn pairing_key(_id: &str) -> Option<String> {
        None
    }

    /// Windows port IDs are interface paths naming the USB serial or port, so they persist.
    pub(super) fn fallback_unit_key(id: &str) -> String {
        format!("port:{id}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies port names reduce to their device and instance on each platform's naming
    /// scheme, while distinct devices stay distinct.
    #[test]
    fn pairing_key_splits_device_and_instance() {
        assert_eq!(pairing_key("APC mini mk2"), ("APC mini mk2", ""));
        assert_eq!(pairing_key("MIDIIN2 (APC MINI)"), ("APC MINI", "2"));
        assert_eq!(
            pairing_key("MIDIIN2 (APC MINI)"),
            pairing_key("MIDIOUT2 (APC MINI)")
        );
        assert_eq!(pairing_key("MIDIOUT (X-Touch)"), ("X-Touch", ""));
        assert_eq!(
            pairing_key("APC mini mk2:APC mini mk2 MIDI 1 20:0"),
            ("APC mini mk2:APC mini mk2 MIDI 1", "20")
        );
        assert_ne!(pairing_key("E2E Pad").0, pairing_key("E2E Pad 2").0);
        assert_eq!(pairing_key("Pad 1:2b"), ("Pad 1:2b", ""));
    }

    /// Verifies a USB unit key prefers the serial and falls back to the USB port.
    #[test]
    fn usb_unit_key_prefers_the_serial() {
        assert_eq!(
            usb_unit_key("09e8", "004f", Some(" S123 "), "1-1.2"),
            "usb:09e8:004f:serial:S123"
        );
        assert_eq!(
            usb_unit_key("09e8", "004f", Some(""), "1-1.2"),
            "usb:09e8:004f:port:1-1.2"
        );
        assert_eq!(
            usb_unit_key("09e8", "004f", None, "1-1.3"),
            "usb:09e8:004f:port:1-1.3"
        );
    }

    /// Verifies the sysfs lookup follows a card's device link to its USB device and reads the
    /// serial, or the port path when the device has no serial.
    #[cfg(target_os = "linux")]
    #[test]
    fn sysfs_lookup_reads_the_usb_device_behind_a_card() {
        let root = tempfile::tempdir().expect("temp dir should be created");
        let usb = root.path().join("devices/usb1");
        for (card, port, serial) in [(1, "1-1.2", Some("S123")), (2, "1-1.3", None)] {
            let device = usb.join(port);
            let interface = device.join(format!("{port}:1.0"));
            std::fs::create_dir_all(&interface).unwrap();
            std::fs::write(device.join("idVendor"), "09e8\n").unwrap();
            std::fs::write(device.join("idProduct"), "004f\n").unwrap();
            if let Some(serial) = serial {
                std::fs::write(device.join("serial"), format!("{serial}\n")).unwrap();
            }
            let card_dir = root.path().join(format!("sound/card{card}"));
            std::fs::create_dir_all(&card_dir).unwrap();
            std::os::unix::fs::symlink(&interface, card_dir.join("device")).unwrap();
        }
        let sound = root.path().join("sound");

        assert_eq!(
            platform::usb_unit_from_sysfs(&sound, 1).as_deref(),
            Some("usb:09e8:004f:serial:S123")
        );
        assert_eq!(
            platform::usb_unit_from_sysfs(&sound, 2).as_deref(),
            Some("usb:09e8:004f:port:1-1.3")
        );
        assert_eq!(platform::usb_unit_from_sysfs(&sound, 3), None);
    }
}
