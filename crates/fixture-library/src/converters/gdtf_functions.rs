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
use nightfall_fixture_model::prelude::*;

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

/// Converts a GDTF DMX value to the parameter's resolution, honoring the GDTF shift flag.
///
/// Per the GDTF spec, values are byte-mirrored when widened (`255/1` on a 16-bit channel is
/// 65535) and zero-padded only with the shift operator (`255/1s` is 65280). Narrowing keeps
/// the most significant bytes. gdtf-rs's `DmxValue::to` zero-pads unshifted values too, so it
/// cannot be used here.
pub(super) fn scaled(value: DmxValue, resolution: DmxValueResolution) -> u32 {
    let source_bytes = value.bytes().get();
    let mut result = 0u32;
    for index in 0..resolution.channel_width() as u8 {
        let byte = if index >= source_bytes && value.shifting() {
            0
        } else {
            (value.value() >> (8 * u32::from(source_bytes - 1 - index % source_bytes))) as u8
        };
        result = (result << 8) | u32::from(byte);
    }
    result
}

/// Converts a GDTF CIE color.
fn cie(color: &ColorCie) -> CieColor {
    CieColor {
        x: color.x as f32,
        y: color.y as f32,
        luminance: color.z as f32,
    }
}

/// Maps a GDTF attribute definition's unit onto the unit carried by parameter functions.
pub(super) fn map_gdtf_physical_unit(unit: gdtf::attribute::PhysicalUnit) -> PhysicalUnit {
    use gdtf::attribute::PhysicalUnit as Gdtf;
    match unit {
        Gdtf::None => PhysicalUnit::None,
        Gdtf::Percent => PhysicalUnit::Percent,
        Gdtf::Length => PhysicalUnit::Length,
        Gdtf::Mass => PhysicalUnit::Mass,
        Gdtf::Time => PhysicalUnit::Time,
        Gdtf::Temperature => PhysicalUnit::Temperature,
        Gdtf::LuminousIntensity => PhysicalUnit::LuminousIntensity,
        Gdtf::Angle => PhysicalUnit::Angle,
        Gdtf::Force => PhysicalUnit::Force,
        Gdtf::Frequency => PhysicalUnit::Frequency,
        Gdtf::Current => PhysicalUnit::Current,
        Gdtf::Voltage => PhysicalUnit::Voltage,
        Gdtf::Power => PhysicalUnit::Power,
        Gdtf::Energy => PhysicalUnit::Energy,
        Gdtf::Area => PhysicalUnit::Area,
        Gdtf::Volume => PhysicalUnit::Volume,
        Gdtf::Speed => PhysicalUnit::Speed,
        Gdtf::Acceleration => PhysicalUnit::Acceleration,
        Gdtf::AngularSpeed => PhysicalUnit::AngularSpeed,
        Gdtf::AngularAccc => PhysicalUnit::AngularAcceleration,
        Gdtf::WaveLength => PhysicalUnit::WaveLength,
        Gdtf::ColorComponent => PhysicalUnit::ColorComponent,
    }
}

/// Converts a prism facet, or returns `None` when its rotation is not a finite 3x3 matrix.
///
/// gdtf-rs exposes the rotation only through its serializer, which writes the `{…}{…}{…}`
/// groups in file order. Each GDTF group is a column of a homogeneous 2D transform, the
/// third holding the translation (e.g. `{0.97,0,0}{0,0.97,0}{0.5,0.5,1}`), so the groups
/// are copied straight into the column-major array without transposing.
fn prism_facet(facet: &gdtf::wheel::PrismFacet) -> Option<PrismFacet> {
    let encoded = serde_json::to_value(facet.rotation).ok()?;
    let columns: Vec<Vec<f32>> = encoded
        .as_str()?
        .split('{')
        .filter(|column| !column.is_empty())
        .map(|column| {
            column
                .trim_end_matches('}')
                .split(',')
                .map(|value| value.trim().parse::<f32>())
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if columns.len() != 3
        || columns
            .iter()
            .any(|column| column.len() != 3 || column.iter().any(|value| !value.is_finite()))
    {
        return None;
    }
    let mut transform = [0.0; 9];
    for (slot, value) in transform.iter_mut().zip(columns.into_iter().flatten()) {
        *slot = value;
    }
    Some(PrismFacet {
        transform,
        color: cie(&facet.color),
    })
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

/// Returns a logical channel's functions in ascending DMX order, the order
/// of [`ChannelSemantics::functions`].
pub(super) fn ordered_functions(
    logical: &LogicalChannel,
    resolution: DmxValueResolution,
) -> Vec<&ChannelFunction> {
    let mut functions: Vec<&ChannelFunction> = logical.channel_functions.iter().collect();
    functions.sort_by_key(|function| scaled(function.dmx_from, resolution));
    functions
}

/// Returns each function's inclusive DMX range.
///
/// A function ends just before the next higher start of a function that can
/// be active at the same time: one under the same mode master condition, or
/// either of the two having no condition. Functions under different
/// conditions are alternatives for the same DMX values, so they do not end
/// each other, while an unconditional function gives way to every function
/// that starts after it.
fn function_ranges(
    functions: &[&ChannelFunction],
    resolution: DmxValueResolution,
) -> Vec<(u32, u32)> {
    let max = resolution.dmx_max();
    let condition = |function: &ChannelFunction| {
        function.mode_master.as_ref().map(|master| {
            (
                master.node.to_string(),
                scaled(master.from, DmxValueResolution::Uber),
                scaled(master.to, DmxValueResolution::Uber),
            )
        })
    };
    let conditions: Vec<_> = functions
        .iter()
        .map(|function| condition(function))
        .collect();
    let starts: Vec<u32> = functions
        .iter()
        .map(|function| scaled(function.dmx_from, resolution))
        .collect();
    (0..functions.len())
        .map(|index| {
            let from = starts[index];
            let to = (0..functions.len())
                .filter(|other| {
                    starts[*other] > from
                        && (conditions[*other].is_none()
                            || conditions[index].is_none()
                            || conditions[*other] == conditions[index])
                })
                .map(|other| starts[other] - 1)
                .min()
                .unwrap_or(max);
            (from, to)
        })
        .collect()
}

/// Converts a DMX profile's points, or returns an empty (linear) curve.
fn profile_points(fixture_type: &FixtureType, function: &ChannelFunction) -> Vec<ProfilePoint> {
    let Some(profile) = function.dmx_profile(fixture_type) else {
        return Vec::new();
    };
    let mut points: Vec<ProfilePoint> = profile
        .points
        .iter()
        .map(|point| ProfilePoint {
            dmx_percent: point.dmx_percentage as f32,
            cfc0: point.cfc0 as f32,
            cfc1: point.cfc1 as f32,
            cfc2: point.cfc2 as f32,
            cfc3: point.cfc3 as f32,
        })
        .collect();
    points.sort_by(|a, b| a.dmx_percent.total_cmp(&b.dmx_percent));
    points
}

/// Converts a logical channel's functions and the channel's default and highlight.
///
/// The default comes from the channel's initial function, or the first
/// function when none is named. Virtual channels keep their default and
/// highlight too: they reach the output through the relations they master,
/// so a highlighted pixel needs its virtual dimmer raised. Mode master
/// conditions and relations name other channels, so they are linked after
/// all parameters exist.
pub(super) fn channel_semantics(
    fixture_type: &FixtureType,
    channel: &DmxChannel,
    logical: &LogicalChannel,
    resolution: DmxValueResolution,
) -> ChannelSemantics {
    let functions = ordered_functions(logical, resolution);
    let converted = functions
        .iter()
        .zip(function_ranges(&functions, resolution))
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
                physical_unit: function
                    .attribute(fixture_type)
                    .map_or(PhysicalUnit::None, |attribute| {
                        map_gdtf_physical_unit(attribute.physical_unit)
                    }),
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
                            facets: slot.map_or_else(Vec::new, |slot| {
                                slot.facets.iter().filter_map(prism_facet).collect()
                            }),
                            physical_from: set.physical_from.map(|value| value as f32),
                            physical_to: set.physical_to.map(|value| value as f32),
                        }
                    })
                    .collect(),
                profile: profile_points(fixture_type, function),
                ..Default::default()
            }
        })
        .collect();

    let default_function = channel
        .initial_function()
        .map(|(_, function)| function)
        .or_else(|| logical.channel_functions.first());
    ChannelSemantics {
        functions: converted,
        default_dmx: default_function.map(|function| scaled(function.default, resolution)),
        highlight_dmx: channel.highlight.map(|value| scaled(value, resolution)),
    }
}

#[cfg(test)]
mod tests {
    use nightfall_fixture_model::prelude::*;
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

    /// Verifies virtual channels keep their functions, default and highlight,
    /// which reach the output through the relations they master.
    #[test]
    fn virtual_channels_keep_default_and_highlight() {
        let dimmer = parameter(
            ChannelSpec::virtual_channel("Base", "Dimmer")
                .highlight(255)
                .function(FunctionSpec::new("Dimmer").default_dmx(128)),
        );
        assert_eq!(dimmer.functions.len(), 1);
        assert_eq!(dimmer.dmx_slots, DmxSlots::Virtual);
        assert_eq!(dimmer.default_dmx, Some(128));
        assert_eq!(dimmer.highlight_dmx, Some(255));
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
        use crate::testing::{SlotSpec, WheelSpec};

        let dir = tempfile::tempdir().unwrap();
        let metadata = GdtfBuilder::new("Test", "Gobos")
            .wheel(
                WheelSpec::new("Gobo Wheel")
                    .slot(SlotSpec::new("Open"))
                    .slot(SlotSpec::new("Stars").media("stars")),
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

    /// Verifies DMX values are byte-mirrored when widened, zero-padded only with the GDTF
    /// shift operator, and truncated to their most significant bytes when narrowed.
    #[test]
    fn test_scaled_mirrors_unshifted_values() {
        use nightfall_dmx::prelude::DmxValueResolution;

        use super::scaled;

        let value = |source: &str| -> gdtf::values::DmxValue {
            serde_json::from_value(serde_json::json!(source)).unwrap()
        };
        assert_eq!(scaled(value("255/1"), DmxValueResolution::Fine), 65535);
        assert_eq!(scaled(value("128/1"), DmxValueResolution::Fine), 32896);
        assert_eq!(scaled(value("255/1s"), DmxValueResolution::Fine), 65280);
        assert_eq!(scaled(value("32896/2"), DmxValueResolution::Coarse), 128);
        assert_eq!(
            scaled(value("4660/2"), DmxValueResolution::Uber),
            0x1234_1234
        );
        assert_eq!(scaled(value("255/1"), DmxValueResolution::Uber), u32::MAX);
    }

    /// Verifies functions carry the physical unit of their attribute definition, so angular
    /// zoom is distinguishable from unitless ranges.
    #[test]
    fn functions_carry_attribute_physical_units() {
        let zoom = parameter(
            ChannelSpec::new("Base", "Zoom", &[1])
                .function(FunctionSpec::new("Zoom").physical(5.0, 40.0)),
        );
        assert_eq!(zoom.functions[0].physical_unit, PhysicalUnit::Angle);
        let custom = parameter(
            ChannelSpec::new("Base", "Control1", &[1]).function(FunctionSpec::new("Control1")),
        );
        assert_eq!(custom.functions[0].physical_unit, PhysicalUnit::None);
    }

    /// Verifies prism sets carry each facet's column-major transform (GDTF groups kept in
    /// file order, translation in the third column) and color, and that slots without
    /// facets carry none.
    #[test]
    fn prism_sets_carry_slot_facets() {
        use crate::testing::{SlotSpec, WheelSpec};

        let dir = tempfile::tempdir().unwrap();
        let metadata = GdtfBuilder::new("Test", "Prism")
            .wheel(
                WheelSpec::new("Prism Wheel")
                    .slot(SlotSpec::new("Open"))
                    .slot(SlotSpec::new("Prism").facet(
                        [0.3, 0.4, 100.0],
                        [[0.97, 0.0, 0.0], [0.0, 0.97, 0.0], [0.5, 0.5, 1.0]],
                    )),
            )
            .geometry(GeometrySpec::generic("Base"))
            .mode(
                ModeSpec::new("Mode", "Base").channel(
                    ChannelSpec::new("Base", "Prism1", &[1]).function(
                        FunctionSpec::new("Prism1")
                            .wheel("Prism Wheel")
                            .set("Open", 0, Some(1))
                            .set("Prism", 10, Some(2)),
                    ),
                ),
            )
            .write_metadata(dir.path());
        let (fixture, _) = convert_gdtf_to_fixture(&metadata, "Mode", 1).unwrap();
        let sets = &fixture.elements[0].parameters[0].functions[0].sets;
        assert!(sets[0].facets.is_empty());
        assert_eq!(sets[1].facets.len(), 1);
        let facet = sets[1].facets[0];
        assert_eq!(
            facet.transform,
            [0.97, 0.0, 0.0, 0.0, 0.97, 0.0, 0.5, 0.5, 1.0]
        );
        assert_eq!((facet.transform[6], facet.transform[7]), (0.5, 0.5));
        assert_eq!((facet.transform[2], facet.transform[5]), (0.0, 0.0));
        assert_eq!(
            (facet.color.x, facet.color.y, facet.color.luminance),
            (0.3, 0.4, 100.0)
        );
    }
}
