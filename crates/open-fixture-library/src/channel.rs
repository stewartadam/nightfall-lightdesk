// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Channel and capability semantics from the OFL fixture format

use crate::schema::{OflCapability, OflChannel, OflDmxValue};

/// Widest DMX value, in bytes, that fits a `u32`.
const MAX_VALUE_BYTES: u8 = 4;

impl OflChannel {
    /// Returns the channel's capabilities, whether the definition wrote a single
    /// `capability` or a `capabilities` list.
    pub fn capabilities(&self) -> &[OflCapability] {
        match &self.capability {
            Some(capability) => std::slice::from_ref(capability),
            None => &self.capabilities,
        }
    }

    /// Returns the channel's full width in bytes: the coarse channel plus one byte per fine alias.
    pub fn max_resolution(&self) -> u8 {
        u8::try_from(1 + self.fine_channel_aliases.len()).unwrap_or(u8::MAX)
    }

    /// Returns the width, in bytes, that `dmxRange`, `defaultValue` and `highlightValue`
    /// are written in: the declared `dmxValueResolution`, or the full width when absent.
    pub fn value_resolution(&self) -> u8 {
        self.dmx_value_resolution
            .map_or_else(|| self.max_resolution(), |resolution| resolution.bytes())
    }

    /// Returns the declared default value scaled to a `bytes`-wide parameter, or `None`
    /// when the definition does not declare one (OFL then rests the channel at 0).
    pub fn default_value_at(&self, bytes: u8) -> Option<u32> {
        let resolution = self.value_resolution();
        let value = self.default_value.as_ref()?.at_resolution(resolution)?;
        Some(scale_dmx_value(value, resolution, bytes))
    }

    /// Returns the declared highlight value scaled to a `bytes`-wide parameter, or `None`
    /// when the definition does not declare one (OFL then highlights at the maximum).
    pub fn highlight_value_at(&self, bytes: u8) -> Option<u32> {
        let resolution = self.value_resolution();
        let value = self.highlight_value.as_ref()?.at_resolution(resolution)?;
        Some(scale_dmx_value(value, resolution, bytes))
    }

    /// Returns the channel a switching channel `alias` becomes while this channel rests
    /// at its default value, as OFL does when nothing else selects one.
    ///
    /// Returns `None` when this channel does not switch `alias`, and `Some(None)` when
    /// the default capability maps `alias` to an unused slot.
    pub fn default_switch_target(&self, alias: &str) -> Option<Option<&str>> {
        let resolution = self.value_resolution();
        let default_value = self
            .default_value
            .as_ref()
            .and_then(|value| value.at_resolution(resolution))
            .unwrap_or(0);
        let capabilities = self.capabilities();
        let capability = capabilities
            .iter()
            .find(|capability| {
                capability
                    .dmx_range
                    .is_some_and(|[start, end]| (start..=end).contains(&default_value))
            })
            .or_else(|| capabilities.first())?;
        capability
            .switch_channels
            .get(alias)
            .map(|target| target.as_deref())
    }
}

impl OflDmxValue {
    /// Returns the value as a raw DMX value in a `bytes`-wide resolution, resolving
    /// percentages against that resolution's maximum. Returns `None` for a malformed percentage.
    pub fn at_resolution(&self, bytes: u8) -> Option<u32> {
        match self {
            Self::Dmx(value) => Some(*value),
            Self::Percent(text) => {
                let percent: f64 = text.strip_suffix('%')?.parse().ok()?;
                let max = f64::from(max_dmx_value(bytes));
                Some(((percent / 100.0) * max).floor().clamp(0.0, max) as u32)
            }
        }
    }
}

impl OflCapability {
    /// Returns the rotation, in degrees, at the start and end of the capability's DMX
    /// range, or `None` when it is not written in degrees (for example as a percentage).
    pub fn angle_range_degrees(&self) -> Option<(f32, f32)> {
        if let (Some(start), Some(end)) = (&self.angle_start, &self.angle_end) {
            return Some((parse_degrees(start)?, parse_degrees(end)?));
        }
        let angle = parse_degrees(self.angle.as_deref()?)?;
        Some((angle, angle))
    }
}

/// Parses an OFL degree value such as `"540deg"` or `"-90.5deg"`.
fn parse_degrees(text: &str) -> Option<f32> {
    text.strip_suffix("deg")?
        .parse()
        .ok()
        .filter(|value: &f32| value.is_finite())
}

/// Returns the largest DMX value of a `bytes`-wide resolution.
fn max_dmx_value(bytes: u8) -> u32 {
    match bytes.clamp(1, MAX_VALUE_BYTES) {
        MAX_VALUE_BYTES => u32::MAX,
        bytes => (1u32 << (8 * u32::from(bytes))) - 1,
    }
}

/// Rescales a DMX value between resolutions the way OFL does: widening repeats the
/// least significant byte (so 255 at 8 bits becomes 65535 at 16 bits) and narrowing
/// drops the least significant bytes.
pub fn scale_dmx_value(value: u32, from_bytes: u8, to_bytes: u8) -> u32 {
    let from_bytes = from_bytes.clamp(1, MAX_VALUE_BYTES);
    let to_bytes = to_bytes.clamp(1, MAX_VALUE_BYTES);
    let value = value.min(max_dmx_value(from_bytes));
    if to_bytes <= from_bytes {
        return value >> (8 * u32::from(from_bytes - to_bytes));
    }
    let last_byte = value & 0xFF;
    (from_bytes..to_bytes).fold(value, |scaled, _| (scaled << 8) | last_byte)
}

#[cfg(test)]
mod tests;
