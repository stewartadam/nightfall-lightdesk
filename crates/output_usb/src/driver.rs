// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The USB DMX protocols the output worker speaks, and the open connection for each.
//!
//! A device's USB vendor and product ID pick its interface family. Some families carry more
//! than one protocol, such as the FTDI serial chip shared by several interfaces, so opening a
//! device may probe it first. Each protocol module opens its own devices and writes universes
//! in its own wire format; the worker only sees [`UsbDmxConnection`].

use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
use nightfall_io::prelude::{
    FTDI_FT232R_PRODUCT_ID, FTDI_VENDOR_ID, UDMX_PRODUCT_ID, UDMX_VENDOR_ID,
};

use crate::discovery::DiscoveredDevice;
use crate::open_dmx::OpenDmxPort;
use crate::udmx::UdmxInterface;
use crate::usb_pro::UsbProPort;

/// One universe of DMX channel values.
pub(crate) type Universe = [u8; MAX_CHANNELS_PER_UNIVERSE];

/// USB DMX interface families the output worker can drive, told apart by USB vendor and
/// product ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UsbDmxFamily {
    /// uDMX interfaces, driven with vendor control transfers.
    Udmx,
    /// FTDI USB serial chips, driven through the OS serial driver. The chip appears in
    /// interfaces speaking different protocols, so the device is probed when opened.
    FtdiSerial,
}

impl UsbDmxFamily {
    /// Returns the family a USB vendor and product ID belong to, if any.
    pub(crate) fn from_usb_id(vendor_id: u16, product_id: u16) -> Option<Self> {
        match (vendor_id, product_id) {
            (UDMX_VENDOR_ID, UDMX_PRODUCT_ID) => Some(Self::Udmx),
            (FTDI_VENDOR_ID, FTDI_FT232R_PRODUCT_ID) => Some(Self::FtdiSerial),
            _ => None,
        }
    }
}

/// Why a device could not be opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenError {
    /// The device or its OS port could not be reached now, for example while the OS driver is
    /// still binding to a freshly attached device.
    Unavailable,
    /// The device answered as none of the protocols its family carries.
    Unsupported,
}

/// Result of writing one universe to a device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteOutcome {
    /// The device now holds the universe.
    Written,
    /// The write failed, so what the device holds is unknown; the device stays open.
    Failed,
    /// The device is gone and must be opened again.
    Disconnected,
}

/// An open USB DMX device, driven by the protocol it speaks.
pub(crate) enum UsbDmxConnection {
    /// uDMX interface.
    Udmx(UdmxInterface),
    /// Enttec DMX USB Pro, or a clone speaking its protocol.
    EnttecUsbPro(UsbProPort),
    /// Open DMX dongle: a bare FTDI chip the host generates the DMX signal through.
    OpenDmx(OpenDmxPort),
}

impl UsbDmxConnection {
    /// Opens a discovered device with the driver for the protocol it speaks.
    ///
    /// An FTDI device that does not answer the USB Pro probe is driven as an Open DMX dongle,
    /// which has no firmware to answer one. `skip_usb_pro_probe` opens it as Open DMX straight
    /// away, for a device that already failed the probe since it was plugged in.
    pub(crate) fn open(
        device: &DiscoveredDevice,
        skip_usb_pro_probe: bool,
    ) -> Result<Self, OpenError> {
        match device.family {
            UsbDmxFamily::Udmx => UdmxInterface::open(&device.info)
                .map(Self::Udmx)
                .ok_or(OpenError::Unavailable),
            UsbDmxFamily::FtdiSerial if skip_usb_pro_probe => {
                OpenDmxPort::open(&device.info).map(Self::OpenDmx)
            }
            UsbDmxFamily::FtdiSerial => match UsbProPort::open(&device.info) {
                Err(OpenError::Unsupported) => {
                    tracing::info!(
                        "USB serial device did not answer as an Enttec DMX USB Pro; driving it as \
                         Open DMX until it is unplugged"
                    );
                    OpenDmxPort::open(&device.info).map(Self::OpenDmx)
                }
                result => result.map(Self::EnttecUsbPro),
            },
        }
    }

    /// Returns the name of the protocol driving the device, for logs.
    pub(crate) fn protocol_name(&self) -> &'static str {
        match self {
            Self::Udmx(_) => "uDMX",
            Self::EnttecUsbPro(_) => "Enttec DMX USB Pro",
            Self::OpenDmx(_) => "Open DMX",
        }
    }

    /// Writes `next` to the device, which is known to hold `written` when that is set.
    pub(crate) fn write(&mut self, written: Option<&Universe>, next: &Universe) -> WriteOutcome {
        match self {
            Self::Udmx(interface) => interface.write(written, next),
            Self::EnttecUsbPro(port) => port.write(next),
            Self::OpenDmx(port) => port.write(next),
        }
    }
}
