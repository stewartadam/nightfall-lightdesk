// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Conversion of GDTF channel functions, channel sets, defaults and highlight.
//!
//! GDTF gives each function and set only a start value; a range ends where
//! the next one begins, and the last range ends at the channel's maximum.
//! All DMX values are converted to the parameter's byte resolution.

use gdtf::dmx_mode::{ChannelFunction, DmxChannel, LogicalChannel};
use gdtf::fixture_type::FixtureType;
use gdtf::physical_descriptions::EmitterOptic;
use gdtf::values::{ColorCie, DmxValue};
use gdtf::wheel::WheelSlotOptic;
use nightfall_dmx::prelude::DmxValueResolution;
use nightfall_fixtures::prelude::{CieColor, ParameterFunction, ParameterFunctionSet};
use nightfall_fixtures::wire_layout::dmx_max;

/// DMX values a parameter declares beyond its byte placement.
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct ChannelSemantics {
    /// Functions in ascending DMX order.
    pub functions: Vec<ParameterFunction>,
    /// Resting DMX value.
    pub default_dmx: Option<u32>,
    /// Highlight DMX value.
    pub highlight_dmx: Option<u32>,
}

/// Converts a GDTF DMX value to the parameter's resolution.
fn scaled(value: DmxValue, resolution: DmxValueResolution) -> u32 {
    let bytes = resolution.channel_width() as u8;
    value.to(bytes).min(dmx_max(resolution) as u64) as u32
}

/// Converts a GDTF CIE color.
fn cie(color: &ColorCie) -> CieColor {
    CieColor {
        x: color.x as f32,
        y: color.y as f32,
        luminance: color.z as f32,
    }
}

/// Returns the measured color of the emitter a function drives, if it declares one.
fn emitter_color(fixture_type: &FixtureType, function: &ChannelFunction) -> Option<CieColor> {
    match &function.emitter(fixture_type)?.optic {
        EmitterOptic::Color { color, .. } => Some(cie(color)),
        EmitterOptic::WaveLength { .. } => None,
    }
}

/// Returns inclusive `(from, to)` bounds for ascending start values ending at `last`.
fn ranges(starts: &[u32], last: u32) -> Vec<(u32, u32)> {
    starts
        .iter()
        .enumerate()
        .map(|(index, from)| {
            let to = starts
                .get(index + 1)
                .map_or(last, |next| next.saturating_sub(1).max(*from));
            (*from, to)
        })
        .collect()
}

/// Converts a logical channel's functions and the channel's default and highlight.
///
/// The default comes from the channel's initial function, or the first
/// function when none is named. Virtual channels keep their functions for
/// display but have no DMX default or highlight to output.
pub(super) fn channel_semantics(
    fixture_type: &FixtureType,
    channel: &DmxChannel,
    logical: &LogicalChannel,
    resolution: DmxValueResolution,
) -> ChannelSemantics {
    let max = dmx_max(resolution);
    let mut functions: Vec<&ChannelFunction> = logical.channel_functions.iter().collect();
    functions.sort_by_key(|function| scaled(function.dmx_from, resolution));
    let starts: Vec<u32> = functions
        .iter()
        .map(|function| scaled(function.dmx_from, resolution))
        .collect();

    let converted = functions
        .iter()
        .zip(ranges(&starts, max))
        .map(|(function, (dmx_from, dmx_to))| {
            let mut sets: Vec<_> = function
                .channel_sets
                .iter()
                .map(|set| (scaled(set.dmx_from, resolution), set))
                .filter(|(from, _)| (dmx_from..=dmx_to).contains(from))
                .collect();
            sets.sort_by_key(|(from, _)| *from);
            let set_starts: Vec<u32> = sets.iter().map(|(from, _)| *from).collect();
            let wheel = function.wheel(fixture_type);
            ParameterFunction {
                name: function
                    .name
                    .as_ref()
                    .map(|name| name.to_string())
                    .unwrap_or_default(),
                attribute: function.attribute.to_string(),
                dmx_from,
                dmx_to,
                physical_from: function.physical_from as f32,
                physical_to: function.physical_to as f32,
                wheel: function.wheel.as_ref().map(|wheel| wheel.to_string()),
                emitter_color: emitter_color(fixture_type, function),
                sets: sets
                    .iter()
                    .zip(ranges(&set_starts, dmx_to))
                    .map(|((_, set), (from, to))| {
                        let slot = wheel.and_then(|wheel| set.wheel_slot(wheel));
                        ParameterFunctionSet {
                            name: set
                                .name
                                .as_ref()
                                .map(|name| name.to_string())
                                .unwrap_or_default(),
                            dmx_from: from,
                            dmx_to: to,
                            wheel_slot: set.wheel_slot_index.map(|index| index as u32 + 1),
                            color: slot.and_then(|slot| match &slot.optic {
                                WheelSlotOptic::Color(color) => Some(cie(color)),
                                WheelSlotOptic::Filter(_) => {
                                    slot.filter(fixture_type).map(|filter| cie(&filter.color))
                                }
                            }),
                            media: slot
                                .and_then(|slot| slot.media_name.clone())
                                .filter(|media| !media.is_empty()),
                        }
                    })
                    .collect(),
            }
        })
        .collect();

    let is_virtual = channel.offset.is_none();
    let default_function = channel
        .initial_function()
        .map(|(_, function)| function)
        .or_else(|| logical.channel_functions.first());
    ChannelSemantics {
        functions: converted,
        default_dmx: default_function
            .filter(|_| !is_virtual)
            .map(|function| scaled(function.default, resolution)),
        highlight_dmx: channel
            .highlight
            .filter(|_| !is_virtual)
            .map(|value| scaled(value, resolution)),
    }
}

#[cfg(test)]
mod tests {
    use nightfall_fixtures::prelude::*;

    use crate::converters::gdtf::convert_gdtf_to_fixture;
    use crate::testing::{ChannelSpec, FunctionSpec, GdtfBuilder, GeometrySpec, ModeSpec};

    /// Converts the first parameter of a single-channel synthetic mode.
    fn parameter(channel: ChannelSpec) -> ParameterMetadata {
        let dir = tempfile::tempdir().unwrap();
        let metadata = GdtfBuilder::new("Test", "Functions")
            .geometry(GeometrySpec::generic("Base"))
            .mode(ModeSpec::new("Mode", "Base").channel(channel))
            .write_metadata(dir.path());
        let (fixture, _) = convert_gdtf_to_fixture(&metadata, "Mode", 1).unwrap();
        fixture.elements[0].parameters[0].clone()
    }

    /// Verifies functions and sets get contiguous inclusive ranges from their start values.
    #[test]
    fn functions_and_sets_get_contiguous_ranges() {
        let gobo = parameter(
            ChannelSpec::new("Base", "Gobo1", &[1])
                .function(
                    FunctionSpec::new("Gobo1")
                        .named("Select")
                        .wheel("Gobo Wheel")
                        .set("Open", 0, Some(1))
                        .set("Gobo 1", 10, Some(2))
                        .set("Gobo 2", 20, Some(3)),
                )
                .function(
                    FunctionSpec::new("Gobo1PosRotate")
                        .named("Spin")
                        .from_dmx(128)
                        .physical(-100.0, 100.0),
                ),
        );
        assert_eq!(gobo.functions.len(), 2);
        let select = &gobo.functions[0];
        assert_eq!((select.dmx_from, select.dmx_to), (0, 127));
        assert_eq!(select.wheel.as_deref(), Some("Gobo Wheel"));
        let sets: Vec<(&str, u32, u32, Option<u32>)> = select
            .sets
            .iter()
            .map(|set| (set.name.as_str(), set.dmx_from, set.dmx_to, set.wheel_slot))
            .collect();
        assert_eq!(
            sets,
            [
                ("Open", 0, 9, Some(1)),
                ("Gobo 1", 10, 19, Some(2)),
                ("Gobo 2", 20, 127, Some(3)),
            ]
        );
        let spin = &gobo.functions[1];
        assert_eq!((spin.dmx_from, spin.dmx_to), (128, 255));
        assert_eq!((spin.physical_from, spin.physical_to), (-100.0, 100.0));
        assert_eq!(gobo.function_at(200).unwrap().attribute, "Gobo1PosRotate");
    }

    /// Verifies defaults and highlight are read at the channel's resolution.
    #[test]
    fn default_and_highlight_use_channel_resolution() {
        let tilt = parameter(
            ChannelSpec::new("Base", "Tilt", &[1, 2])
                .highlight(65_535)
                .function(
                    FunctionSpec::new("Tilt")
                        .physical(-125.0, 125.0)
                        .default_dmx(32_768),
                ),
        );
        assert_eq!(tilt.default_dmx, Some(32_768));
        assert_eq!(tilt.highlight_dmx, Some(65_535));
        let values = ParameterValues::from_metadata(&tilt);
        assert!(values.default_value.abs() < 0.01, "tilt rests centred");
    }

    /// Verifies virtual channels keep functions but declare no DMX default or highlight.
    #[test]
    fn virtual_channels_have_no_dmx_default() {
        let dimmer = parameter(
            ChannelSpec::virtual_channel("Base", "Dimmer")
                .function(FunctionSpec::new("Dimmer").default_dmx(255)),
        );
        assert_eq!(dimmer.functions.len(), 1);
        assert_eq!(dimmer.default_dmx, None);
    }

    /// Verifies additive functions carry their linked emitter's measured color.
    #[test]
    fn emitter_links_carry_measured_color() {
        let dir = tempfile::tempdir().unwrap();
        let metadata = GdtfBuilder::new("Test", "Emitters")
            .emitter("Lime", [0.405, 0.54, 60.0])
            .geometry(GeometrySpec::generic("Base"))
            .mode(
                ModeSpec::new("Mode", "Base").channel(
                    ChannelSpec::new("Base", "ColorAdd_Lime", &[1])
                        .function(FunctionSpec::new("ColorAdd_Lime").emitter("Lime")),
                ),
            )
            .write_metadata(dir.path());
        let (fixture, _) = convert_gdtf_to_fixture(&metadata, "Mode", 1).unwrap();
        let color = fixture.elements[0].parameters[0].functions[0]
            .emitter_color
            .unwrap();
        assert_eq!((color.x, color.y, color.luminance), (0.405, 0.54, 60.0));
    }

    /// Verifies color wheel sets carry their slot's filter color and open slots stay uncolored-white.
    #[test]
    fn wheel_sets_carry_slot_colors() {
        use crate::testing::{SlotSpec, WheelSpec};

        let dir = tempfile::tempdir().unwrap();
        let metadata = GdtfBuilder::new("Test", "Wheel")
            .wheel(
                WheelSpec::new("Color Wheel")
                    .slot(SlotSpec::new("Open"))
                    .slot(SlotSpec::new("Red").color(0.64, 0.33, 21.0)),
            )
            .geometry(GeometrySpec::generic("Base"))
            .mode(
                ModeSpec::new("Mode", "Base").channel(
                    ChannelSpec::new("Base", "Color1", &[1]).function(
                        FunctionSpec::new("Color1")
                            .wheel("Color Wheel")
                            .set("Open", 0, Some(1))
                            .set("Red", 10, Some(2)),
                    ),
                ),
            )
            .write_metadata(dir.path());
        let (fixture, _) = convert_gdtf_to_fixture(&metadata, "Mode", 1).unwrap();
        let sets = &fixture.elements[0].parameters[0].functions[0].sets;
        assert_eq!(sets[1].color.map(|c| (c.x, c.y)), Some((0.64, 0.33)));
        let open = sets[0].color.unwrap();
        assert!(
            (open.x - 0.3127).abs() < 0.01,
            "open slot defaults to white"
        );
    }

    /// Verifies gobo wheel sets carry their slot image name.
    #[test]
    fn wheel_sets_carry_slot_media() {
        use crate::testing::WheelSlotSpec;

        let dir = tempfile::tempdir().unwrap();
        let metadata = GdtfBuilder::new("Test", "Gobos")
            .wheel(
                "Gobo Wheel",
                vec![
                    WheelSlotSpec {
                        name: "Open".to_string(),
                        color: None,
                        media: None,
                    },
                    WheelSlotSpec {
                        name: "Stars".to_string(),
                        color: None,
                        media: Some("stars".to_string()),
                    },
                ],
            )
            .geometry(GeometrySpec::generic("Base"))
            .mode(
                ModeSpec::new("Mode", "Base").channel(
                    ChannelSpec::new("Base", "Gobo1", &[1]).function(
                        FunctionSpec::new("Gobo1")
                            .wheel("Gobo Wheel")
                            .set("Open", 0, Some(1))
                            .set("Stars", 10, Some(2)),
                    ),
                ),
            )
            .write_metadata(dir.path());
        let (fixture, _) = convert_gdtf_to_fixture(&metadata, "Mode", 1).unwrap();
        let sets = &fixture.elements[0].parameters[0].functions[0].sets;
        assert_eq!(sets[0].media, None);
        assert_eq!(sets[1].media.as_deref(), Some("stars"));
    }
}
