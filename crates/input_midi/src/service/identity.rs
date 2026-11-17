// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Tells MIDI ports of identical devices apart, the same way on every OS.
//!
//! Operating systems name identical controllers inconsistently: CoreMIDI gives both units the
//! same name, Windows wraps the second one as `MIDIIN2 (APC MINI)`, and ALSA appends a
//! `client:port` address that changes on every replug. Port names also differ between OSes,
//! so a show moved to another computer cannot rely on them.
//!
//! Each OS can name the USB device behind a port, though, so a [`PortIdentity`] keys a USB
//! port by what the device itself reports: its vendor and product IDs name the model, and its
//! serial names the unit. Units without a serial, or sharing one, fall back to the USB port
//! they are plugged into, and ports with no USB device behind them to the OS's own port ID.

/// What sets one MIDI port's device apart from other ports with the same name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PortIdentity {
    /// Device name without the instance number or address the OS adds to tell units apart.
    pub(crate) base: String,
    /// Key that stays with one physical unit on every OS where the device reports a USB
    /// serial, and across replugs and restarts on this OS otherwise. Ports the OS cannot
    /// tell apart persistently get a session key (see [`is_session_key`]).
    pub(crate) unit: String,
    /// Key naming the USB port the unit is plugged into, which tells apart units that share
    /// a serial; `None` without a USB device behind the port.
    pub(crate) location: Option<String>,
    /// Key naming the model and which of its ports this is, from the USB vendor and product
    /// IDs, so a model matches across OSes that name it differently; `None` without a USB
    /// device behind the port.
    pub(crate) hardware: Option<String>,
    /// Key shared by one unit's input and output ports, so feedback reaches the same unit.
    pub(crate) pairing: String,
}

/// The USB device behind a MIDI port, as the OS reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UsbPort {
    /// USB vendor ID.
    pub(crate) vendor: u16,
    /// USB product ID.
    pub(crate) product: u16,
    /// Serial the device reports, if any.
    pub(crate) serial: Option<String>,
    /// Where the device is plugged in, in the OS's own terms: the sysfs port path on Linux,
    /// the location ID on macOS, and the device instance ID on Windows.
    pub(crate) location: String,
    /// Index of this port among the device's MIDI ports, where the OS reports it; Windows
    /// does not, so the service numbers a unit's ports in discovery order instead.
    pub(crate) index: Option<u32>,
}

impl UsbPort {
    /// Returns the unit key: the serial, which follows the unit to any port and any OS, or
    /// the USB port when the device has none.
    ///
    /// The serial is upper-cased, since Windows only reports it upper-cased.
    pub(crate) fn unit_key(&self) -> String {
        match self
            .serial
            .as_deref()
            .map(str::trim)
            .filter(|serial| !serial.is_empty())
        {
            Some(serial) => format!(
                "usb:{:04x}:{:04x}:serial:{}",
                self.vendor,
                self.product,
                serial.to_ascii_uppercase()
            ),
            None => self.location_key(),
        }
    }

    /// Returns the key naming the USB port the unit is plugged into.
    pub(crate) fn location_key(&self) -> String {
        format!(
            "usb:{:04x}:{:04x}:port:{}",
            self.vendor, self.product, self.location
        )
    }
}

/// Returns the hardware key of port `index` of a USB model.
pub(crate) fn hardware_key(vendor: u16, product: u16, index: u32) -> String {
    format!("usb:{vendor:04x}:{product:04x}:{index}")
}

/// Describes the port with OS port ID `id` and name `name`.
///
/// The OS lookups behind the keys fall back to the port ID and the instance in the name when
/// no USB device answers, which keeps ports apart for this session. A USB port whose index
/// the OS does not report gets index 0; [`number_unit_ports`] corrects it.
pub(crate) fn port_identity(id: &str, name: &str) -> PortIdentity {
    let (_, instance) = pairing_key(name);
    let usb = platform::usb_port(id, name, instance);
    let (base, pairing) = port_pairing(id, name);
    match usb {
        Some(usb) => PortIdentity {
            base,
            unit: usb.unit_key(),
            location: Some(usb.location_key()),
            hardware: Some(hardware_key(
                usb.vendor,
                usb.product,
                usb.index.unwrap_or(0),
            )),
            pairing,
        },
        None => PortIdentity {
            base,
            unit: platform::fallback_unit_key(id),
            location: None,
            hardware: None,
            pairing,
        },
    }
}

/// Numbers the ports of each USB unit in discovery order, for an OS that does not report a
/// port's index within its device, so a unit's second port keeps its own hardware key.
///
/// `identities` are in discovery order; ports of one unit share a location key.
pub(crate) fn number_unit_ports(identities: &mut [PortIdentity]) {
    if platform::REPORTS_PORT_INDEX {
        return;
    }
    let mut seen: Vec<(String, u32)> = Vec::new();
    for identity in identities {
        let (Some(location), Some(hardware)) = (&identity.location, &mut identity.hardware) else {
            continue;
        };
        let index = match seen.iter_mut().find(|(known, _)| known == location) {
            Some((_, count)) => {
                *count += 1;
                *count
            }
            None => {
                seen.push((location.clone(), 0));
                0
            }
        };
        if let Some((model, _)) = hardware.rsplit_once(':') {
            *hardware = format!("{model}:{index}");
        }
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
        .or_else(|| split_alsa_address(name).map(|(head, client, _)| (head, client)))
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

/// Returns the name without a trailing ALSA ` <client>:<port>` address, plus the client and
/// the port.
fn split_alsa_address(name: &str) -> Option<(&str, &str, &str)> {
    let (head, address) = name.rsplit_once(' ')?;
    let (client, port) = address.split_once(':')?;
    let numeric = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit());
    (numeric(client) && numeric(port)).then_some((head, client, port))
}

/// Reads a Windows USB device instance ID such as `USB\VID_09E8&PID_004F\S123` into the
/// device's IDs, serial and location.
///
/// Windows uses the serial as the last part of the ID when the device reports a valid one,
/// and otherwise generates one from the USB port, which always contains `&`.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn parse_windows_usb_instance(instance: &str) -> Option<UsbPort> {
    let mut parts = instance.split('\\');
    if !parts.next()?.eq_ignore_ascii_case("USB") {
        return None;
    }
    let ids = parts.next()?.to_ascii_uppercase();
    let last = parts.next()?;
    if ids.contains("&MI_") {
        return None;
    }
    let hex = |prefix: &str| {
        let start = ids.find(prefix)? + prefix.len();
        u16::from_str_radix(ids.get(start..start + 4)?, 16).ok()
    };
    Some(UsbPort {
        vendor: hex("VID_")?,
        product: hex("PID_")?,
        serial: (!last.contains('&')).then(|| last.to_string()),
        location: last.to_string(),
        index: None,
    })
}

/// Linux: ALSA sequencer clients map to sound cards, whose USB device sysfs describes.
#[cfg(target_os = "linux")]
mod platform {
    use std::path::Path;

    use super::{UsbPort, split_alsa_address};

    /// Root of the sysfs sound class, where each card links to its device.
    const SOUND_CLASS: &str = "/sys/class/sound";

    /// ALSA numbers a USB device's ports in the order the device lists them.
    pub(super) const REPORTS_PORT_INDEX: bool = true;

    /// Returns the USB device behind the card of ALSA client `instance`, with the port number
    /// from the address in `name` as the port's index.
    pub(super) fn usb_port(_id: &str, name: &str, instance: &str) -> Option<UsbPort> {
        let client = instance.parse().ok()?;
        let card = alsa_client_card(client)?;
        let index = split_alsa_address(name.trim()).and_then(|(_, _, port)| port.parse().ok());
        let mut usb = usb_port_from_sysfs(Path::new(SOUND_CLASS), card)?;
        usb.index = index;
        Some(usb)
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

    /// Reads the USB device behind sound card `card` from a sysfs sound class directory.
    ///
    /// The card's `device` link points at its USB interface; the parent directory is the USB
    /// device, named after its port path and holding its IDs and optional serial.
    pub(super) fn usb_port_from_sysfs(sound_class: &Path, card: i32) -> Option<UsbPort> {
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
        let hex = |file: &str| u16::from_str_radix(&read(file)?, 16).ok();
        Some(UsbPort {
            vendor: hex("idVendor")?,
            product: hex("idProduct")?,
            serial: read("serial"),
            location: device.file_name()?.to_str()?.to_string(),
            index: None,
        })
    }
}

/// macOS: a CoreMIDI device reports its USB location and IDs, and a unit's endpoints share
/// one entity.
#[cfg(target_os = "macos")]
mod platform {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use coremidi_sys::{
        MIDIDeviceGetEntity, MIDIDeviceGetNumberOfEntities, MIDIEndpointGetEntity,
        MIDIEntityGetDevice, MIDIObjectFindByUniqueID, MIDIObjectGetIntegerProperty, MIDIObjectRef,
        MIDIObjectType, kMIDIPropertyUniqueID,
    };
    use nusb::MaybeFuture;

    use super::UsbPort;

    /// CoreMIDI lists a device's entities, one per port pair, in the order the device does.
    pub(super) const REPORTS_PORT_INDEX: bool = true;

    /// Returns the USB device behind endpoint `id`, with the entity's place in its device as
    /// the port's index.
    ///
    /// CoreMIDI reports the device's USB location and IDs but not its serial, which comes
    /// from the USB device at that location.
    pub(super) fn usb_port(id: &str, _name: &str, _instance: &str) -> Option<UsbPort> {
        let entity = endpoint_entity(id)?;
        let mut device: MIDIObjectRef = 0;
        // SAFETY: `entity` is a live entity reference and `device` a valid out pointer.
        if unsafe { MIDIEntityGetDevice(entity, &mut device) } != 0 || device == 0 {
            return None;
        }
        let location = integer_property(device, "USBLocationID").filter(|id| *id != 0)? as u32;
        let vendor_product = integer_property(device, "USBVendorProduct")? as u32;
        // SAFETY: `device` is a live device reference.
        let count = unsafe { MIDIDeviceGetNumberOfEntities(device) };
        let index = (0..count)
            // SAFETY: `device` is a live device reference and `index` is below its count.
            .position(|index| unsafe { MIDIDeviceGetEntity(device, index) } == entity)
            .and_then(|index| u32::try_from(index).ok());
        let serial = nusb::list_devices().wait().ok().and_then(|mut devices| {
            devices
                .find(|usb| usb.location_id() == location)
                .and_then(|usb| usb.serial_number().map(str::to_string))
        });
        Some(UsbPort {
            vendor: (vendor_product >> 16) as u16,
            product: (vendor_product & 0xffff) as u16,
            serial,
            location: format!("{location:08x}"),
            index,
        })
    }

    /// Returns the unique ID of the entity owning endpoint `id`, shared by its source and
    /// destination.
    pub(super) fn pairing_key(id: &str) -> Option<String> {
        let entity = endpoint_entity(id)?;
        let mut entity_id: i32 = 0;
        // SAFETY: `entity` is a live object reference and the property key a CoreMIDI constant.
        let status =
            unsafe { MIDIObjectGetIntegerProperty(entity, kMIDIPropertyUniqueID, &mut entity_id) };
        (status == 0).then(|| format!("entity:{entity_id}"))
    }

    /// CoreMIDI keeps an endpoint's unique ID across replugs and restarts, so a port with no
    /// USB device behind it, such as a network session, is keyed by it.
    pub(super) fn fallback_unit_key(id: &str) -> String {
        format!("coremidi:{id}")
    }

    /// Returns the entity owning the endpoint with unique ID `id`.
    fn endpoint_entity(id: &str) -> Option<MIDIObjectRef> {
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
        Some(entity)
    }

    /// Reads integer property `name` of a CoreMIDI object, if it has it.
    fn integer_property(object: MIDIObjectRef, name: &'static str) -> Option<i32> {
        let key = CFString::from_static_string(name);
        let mut value: i32 = 0;
        // SAFETY: `object` is a live object reference, `key` outlives the call and `value` is
        // a valid out pointer.
        let status =
            unsafe { MIDIObjectGetIntegerProperty(object, key.as_concrete_TypeRef(), &mut value) };
        (status == 0).then_some(value)
    }
}

/// Windows: a port's interface path leads to the USB device it belongs to.
#[cfg(target_os = "windows")]
mod platform {
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
        CM_Get_Device_IDW, CM_Get_Device_Interface_PropertyW, CM_Get_Parent,
        CM_LOCATE_DEVNODE_NORMAL, CM_Locate_DevNodeW, CR_SUCCESS, MAX_DEVICE_ID_LEN,
    };
    use windows_sys::Win32::Devices::Properties::{DEVPKEY_Device_InstanceId, DEVPROPTYPE};

    use super::{UsbPort, parse_windows_usb_instance};

    /// Windows does not report which of its device's ports a port is.
    pub(super) const REPORTS_PORT_INDEX: bool = false;

    /// How far up the device tree the USB device is looked for: past the USB interface of a
    /// composite device and any software device the MIDI driver adds.
    const MAX_ANCESTORS: usize = 8;

    /// Returns the USB device the port with interface path `id` belongs to, found by walking
    /// up from the interface's device node.
    pub(super) fn usb_port(id: &str, _name: &str, _instance: &str) -> Option<UsbPort> {
        let mut node = interface_device_node(id)?;
        for _ in 0..MAX_ANCESTORS {
            if let Some(usb) = parse_windows_usb_instance(&device_instance_id(node)?) {
                return Some(usb);
            }
            let mut parent = 0;
            // SAFETY: `node` is a device node CfgMgr returned and `parent` a valid out pointer.
            if unsafe { CM_Get_Parent(&mut parent, node, 0) } != CR_SUCCESS {
                return None;
            }
            node = parent;
        }
        None
    }

    /// The instance number in the port name pairs ports.
    pub(super) fn pairing_key(_id: &str) -> Option<String> {
        None
    }

    /// Port IDs are device interface paths, which persist for a device on one USB port.
    pub(super) fn fallback_unit_key(id: &str) -> String {
        format!("port:{id}")
    }

    /// Returns `text` as a nul-terminated UTF-16 string.
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    /// Returns the device node exposing device interface `path`.
    fn interface_device_node(path: &str) -> Option<u32> {
        let path = wide(path);
        let mut kind: DEVPROPTYPE = 0;
        let mut instance = vec![0u16; MAX_DEVICE_ID_LEN as usize + 1];
        let mut size = u32::try_from(instance.len() * 2).ok()?;
        // SAFETY: `path` is nul-terminated, and `instance` holds `size` bytes.
        let status = unsafe {
            CM_Get_Device_Interface_PropertyW(
                path.as_ptr(),
                &DEVPKEY_Device_InstanceId,
                &mut kind,
                instance.as_mut_ptr().cast(),
                &mut size,
                0,
            )
        };
        if status != CR_SUCCESS {
            return None;
        }
        let mut node = 0;
        // SAFETY: CfgMgr wrote a nul-terminated instance ID into `instance`.
        let status =
            unsafe { CM_Locate_DevNodeW(&mut node, instance.as_ptr(), CM_LOCATE_DEVNODE_NORMAL) };
        (status == CR_SUCCESS).then_some(node)
    }

    /// Returns the instance ID of device node `node`.
    fn device_instance_id(node: u32) -> Option<String> {
        let mut buffer = vec![0u16; MAX_DEVICE_ID_LEN as usize + 1];
        let length = u32::try_from(buffer.len()).ok()?;
        // SAFETY: `buffer` holds `length` UTF-16 units.
        let status = unsafe { CM_Get_Device_IDW(node, buffer.as_mut_ptr(), length, 0) };
        if status != CR_SUCCESS {
            return None;
        }
        let end = buffer
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..end]))
    }
}

/// Other platforms: no USB lookup, so the port ID is the most stable key available.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod platform {
    use super::UsbPort;

    /// No USB lookup, so no index either.
    pub(super) const REPORTS_PORT_INDEX: bool = true;

    /// No USB lookup is available.
    pub(super) fn usb_port(_id: &str, _name: &str, _instance: &str) -> Option<UsbPort> {
        None
    }

    /// The instance in the port name pairs ports.
    pub(super) fn pairing_key(_id: &str) -> Option<String> {
        None
    }

    /// The port ID is the only key available.
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

    /// Builds a USB port of an APC mini with optional serial `serial` at `location`.
    fn apc(serial: Option<&str>, location: &str) -> UsbPort {
        UsbPort {
            vendor: 0x09e8,
            product: 0x004f,
            serial: serial.map(str::to_string),
            location: location.to_string(),
            index: None,
        }
    }

    /// Verifies a USB unit key prefers the serial, which does not depend on the OS, and falls
    /// back to the USB port.
    #[test]
    fn usb_unit_key_prefers_the_serial() {
        assert_eq!(
            apc(Some(" S123 "), "1-1.2").unit_key(),
            "usb:09e8:004f:serial:S123"
        );
        assert_eq!(
            apc(Some(""), "1-1.2").unit_key(),
            "usb:09e8:004f:port:1-1.2"
        );
        assert_eq!(apc(None, "1-1.3").unit_key(), "usb:09e8:004f:port:1-1.3");
        assert_eq!(
            apc(Some("S123"), "1-1.2").location_key(),
            "usb:09e8:004f:port:1-1.2"
        );
        assert_eq!(hardware_key(0x09e8, 0x004f, 1), "usb:09e8:004f:1");
    }

    /// Verifies a Windows USB device instance ID yields the device's IDs, its serial when
    /// Windows used one, and nothing for a composite device's interface or a hub.
    #[test]
    fn windows_instance_ids_name_the_usb_device() {
        assert_eq!(
            parse_windows_usb_instance(r"USB\VID_09E8&PID_004F\S123"),
            Some(apc(Some("S123"), "S123"))
        );
        assert_eq!(
            parse_windows_usb_instance(r"USB\VID_09E8&PID_004F\5&2A1B3C&0&3"),
            Some(apc(None, "5&2A1B3C&0&3"))
        );
        assert_eq!(
            parse_windows_usb_instance(r"USB\VID_09E8&PID_004F&MI_01\7&1&0&0001"),
            None
        );
        assert_eq!(parse_windows_usb_instance(r"USB\ROOT_HUB30\4&1&0&0"), None);
        assert_eq!(parse_windows_usb_instance(r"SWD\MMDEVAPI\X"), None);
    }

    /// Verifies a unit's ports are numbered in discovery order on an OS that does not report
    /// the index, while other units and ports without USB keep their keys.
    #[test]
    fn unit_ports_are_numbered_in_discovery_order() {
        let identity = |location: Option<&str>| PortIdentity {
            base: "Launchpad".to_string(),
            unit: "unit".to_string(),
            location: location.map(str::to_string),
            hardware: location.map(|_| hardware_key(0x1235, 0x0051, 0)),
            pairing: String::new(),
        };
        let mut identities = vec![
            identity(Some("a")),
            identity(Some("b")),
            identity(Some("a")),
            identity(None),
        ];
        number_unit_ports(&mut identities);
        let hardware: Vec<_> = identities
            .iter()
            .map(|identity| identity.hardware.as_deref())
            .collect();
        if platform::REPORTS_PORT_INDEX {
            assert_eq!(hardware[2], Some("usb:1235:0051:0"));
        } else {
            assert_eq!(
                hardware,
                vec![
                    Some("usb:1235:0051:0"),
                    Some("usb:1235:0051:0"),
                    Some("usb:1235:0051:1"),
                    None
                ]
            );
        }
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
            platform::usb_port_from_sysfs(&sound, 1),
            Some(apc(Some("S123"), "1-1.2"))
        );
        assert_eq!(
            platform::usb_port_from_sysfs(&sound, 2),
            Some(apc(None, "1-1.3"))
        );
        assert_eq!(platform::usb_port_from_sysfs(&sound, 3), None);
    }
}
