// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/// uDMX-compatible USB vendor ID.
pub const UDMX_VENDOR_ID: u16 = 0x16c0;

/// uDMX-compatible USB product ID.
pub const UDMX_PRODUCT_ID: u16 = 0x05dc;

/// FTDI USB vendor ID used by Open DMX style interfaces.
pub const OPEN_DMX_VENDOR_ID: u16 = 0x0403;

/// FTDI FT232R/FT245R USB product ID used by Open DMX style interfaces.
pub const OPEN_DMX_PRODUCT_ID: u16 = 0x6001;

/// Returns whether a USB vendor and product ID belong to a supported USB DMX interface.
pub fn is_usb_dmx_device_id(vendor_id: u16, product_id: u16) -> bool {
    matches!(
        (vendor_id, product_id),
        (UDMX_VENDOR_ID, UDMX_PRODUCT_ID) | (OPEN_DMX_VENDOR_ID, OPEN_DMX_PRODUCT_ID)
    )
}

/// Reserved keywords rejected for custom Network DMX output target IDs.
pub const RESERVED_NETWORK_DMX_TARGET_KEYWORDS: &[&str] =
    &["artnet", "console", "disabled", "fix", "fixture", "udmx"];

/// Reserved keywords rejected for custom USB DMX output target IDs.
pub const RESERVED_USB_DMX_TARGET_KEYWORDS: &[&str] =
    &["artnet", "console", "disabled", "fix", "fixture", "sacn"];
