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

/// Reserved keywords rejected for custom Network DMX output target IDs.
pub const RESERVED_NETWORK_DMX_TARGET_KEYWORDS: &[&str] =
    &["artnet", "console", "disabled", "fix", "fixture", "udmx"];

/// Reserved keywords rejected for custom USB DMX output target IDs.
pub const RESERVED_USB_DMX_TARGET_KEYWORDS: &[&str] =
    &["artnet", "console", "disabled", "fix", "fixture", "sacn"];

/// Interval between DMX transmissions on network outputs (44 Hz, the full-universe DMX512 rate).
///
/// Equal to the engine's 44 fps frame period, so output workers and regular engine frames tick
/// together on the shared grid.
pub const DMX_REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_nanos(22_727_273);
