// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Value types written as text in MVR files: DMX addresses, UUIDs, booleans and colors.

use uuid::Uuid;

/// Number of channels in one DMX universe.
pub const CHANNELS_PER_UNIVERSE: u32 = 512;

/// A DMX start address split into universe and channel, both counted from 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DmxAddress {
    /// Universe number, starting at 1.
    pub universe: u32,
    /// Channel within the universe, from 1 to 512.
    pub channel: u16,
}

impl DmxAddress {
    /// Parses the text of an MVR `Address` node.
    ///
    /// MVR writes either an absolute address (`513` is universe 2, channel 1) or
    /// `universe.channel` (`2.1`). Returns `Ok(None)` for `0`, which exporters such as
    /// Vectorworks write for fixtures that are not patched, and for an empty node. Returns
    /// `Err` with the trimmed text for anything else that is not a valid address.
    pub fn parse(text: &str) -> Result<Option<Self>, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let invalid = || trimmed.to_string();
        if let Some((universe, channel)) = trimmed.split_once('.') {
            let universe: u32 = universe.trim().parse().map_err(|_| invalid())?;
            let channel: u16 = channel.trim().parse().map_err(|_| invalid())?;
            if universe == 0 || channel == 0 || u32::from(channel) > CHANNELS_PER_UNIVERSE {
                return Err(invalid());
            }
            return Ok(Some(Self { universe, channel }));
        }
        let absolute: u64 = trimmed.parse().map_err(|_| invalid())?;
        if absolute == 0 {
            return Ok(None);
        }
        let zero_based = absolute - 1;
        let universe = u32::try_from(zero_based / u64::from(CHANNELS_PER_UNIVERSE) + 1)
            .map_err(|_| invalid())?;
        let channel = (zero_based % u64::from(CHANNELS_PER_UNIVERSE)) as u16 + 1;
        Ok(Some(Self { universe, channel }))
    }

    /// Returns the absolute address MVR writes for this universe and channel.
    pub fn absolute(&self) -> u64 {
        (u64::from(self.universe) - 1) * u64::from(CHANNELS_PER_UNIVERSE) + u64::from(self.channel)
    }
}

/// The DMX address of one break of a fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixtureAddress {
    /// DMX break the address belongs to; 0 is the fixture's first break.
    pub dmx_break: u32,
    /// Start address, or `None` when the fixture is not patched on this break.
    pub address: Option<DmxAddress>,
}

/// A CIE 1931 xyY color, as MVR writes fixture and object colors.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CieColor {
    /// Chromaticity x.
    pub x: f64,
    /// Chromaticity y.
    pub y: f64,
    /// Luminance Y.
    pub luminance: f64,
}

impl CieColor {
    /// Parses `x,y,Y` text, returning `None` unless it holds three finite numbers.
    pub fn parse(text: &str) -> Option<Self> {
        let mut values = text.split(',').map(|value| value.trim().parse::<f64>());
        let mut next = || values.next()?.ok().filter(|value| value.is_finite());
        let color = Self {
            x: next()?,
            y: next()?,
            luminance: next()?,
        };
        if values.next().is_some() {
            return None;
        }
        Some(color)
    }
}

/// Parses an MVR UUID, accepting both the hyphenated form used in attributes and the
/// space-separated hex bytes some exporters write in references
/// (`4A B1 94 62 A6 E3 4C 3B B2 5A D8 09 9F 78 17 0C`).
pub fn parse_uuid(text: &str) -> Option<Uuid> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    Uuid::parse_str(&compact).ok()
}

/// Parses an MVR boolean. Accepts `true`/`false` as the spec says, plus `1`/`0` and the
/// `on`/`off` the spec's own DHCP example uses, ignoring case.
pub fn parse_bool(text: &str) -> Option<bool> {
    match text.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" => Some(true),
        "false" | "0" | "off" | "no" => Some(false),
        _ => None,
    }
}
