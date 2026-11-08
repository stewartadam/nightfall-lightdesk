// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Blank fixture types, body shapes and the ready-made generic fixtures drafts start from.
//!
//! Templates are built by applying ordinary draft edits to a blank fixture
//! type, so they follow the same rules as fixtures built by hand.

use gdtf::fixture_type::FixtureType;
use gdtf::geometry::Geometry;
use gdtf::model::Model;
use quick_xml::escape::escape;

use super::commands::{
    BodyShape, DraftEdit, DraftFunctionFields, DraftSetFields, DraftSlotFields, DraftTemplate,
};
use super::draft::DraftState;
use super::edit::apply_edit;
use super::view::footprint;

/// Manufacturer of blank and template fixtures.
const GENERIC_MANUFACTURER: &str = "Generic";

/// Models and geometry tree of a body shape, as GDTF XML.
fn body_xml(shape: BodyShape) -> &'static str {
    match shape {
        BodyShape::Par => concat!(
            r#"<Models><Model Name="Body" Length="0.25" Width="0.25" Height="0.3" PrimitiveType="Cylinder"/></Models>"#,
            r#"<Geometries><Geometry Name="Body" Model="Body" Position="{1,0,0,0}{0,1,0,0}{0,0,1,0}{0,0,0,1}">"#,
            r#"<Beam Name="Beam" Position="{1,0,0,0}{0,1,0,0}{0,0,1,-0.15}{0,0,0,1}" LampType="LED" BeamType="Wash" BeamAngle="25" FieldAngle="35" LuminousFlux="2000" ColorTemperature="6500" BeamRadius="0.1"/>"#,
            r#"</Geometry></Geometries>"#,
        ),
        BodyShape::Bar => concat!(
            r#"<Models><Model Name="Body" Length="1" Width="0.1" Height="0.1" PrimitiveType="Cube"/></Models>"#,
            r#"<Geometries><Geometry Name="Body" Model="Body" Position="{1,0,0,0}{0,1,0,0}{0,0,1,0}{0,0,0,1}">"#,
            r#"<Beam Name="Beam" Position="{1,0,0,0}{0,1,0,0}{0,0,1,-0.05}{0,0,0,1}" LampType="LED" BeamType="Wash" BeamAngle="30" FieldAngle="40" LuminousFlux="2000" ColorTemperature="6500" BeamRadius="0.04"/>"#,
            r#"</Geometry></Geometries>"#,
        ),
        BodyShape::MovingHead => concat!(
            r#"<Models>"#,
            r#"<Model Name="Base" Length="0.35" Width="0.35" Height="0.12" PrimitiveType="Base"/>"#,
            r#"<Model Name="Yoke" Length="0.35" Width="0.12" Height="0.3" PrimitiveType="Yoke"/>"#,
            r#"<Model Name="Head" Length="0.25" Width="0.25" Height="0.3" PrimitiveType="Head"/>"#,
            r#"</Models>"#,
            r#"<Geometries><Geometry Name="Base" Model="Base" Position="{1,0,0,0}{0,1,0,0}{0,0,1,0}{0,0,0,1}">"#,
            r#"<Axis Name="Yoke" Model="Yoke" Position="{1,0,0,0}{0,1,0,0}{0,0,1,-0.06}{0,0,0,1}">"#,
            r#"<Axis Name="Head" Model="Head" Position="{1,0,0,0}{0,1,0,0}{0,0,1,-0.2}{0,0,0,1}">"#,
            r#"<Beam Name="Beam" Position="{1,0,0,0}{0,1,0,0}{0,0,1,-0.15}{0,0,0,1}" LampType="Discharge" BeamType="Spot" BeamAngle="15" FieldAngle="20" LuminousFlux="10000" ColorTemperature="6500" BeamRadius="0.06"/>"#,
            r#"</Axis></Axis></Geometry></Geometries>"#,
        ),
    }
}

/// Builds a fixture type with a body shape, one empty mode and no channels.
fn fixture_type(name: &str, manufacturer: &str, shape: BodyShape) -> Result<FixtureType, String> {
    let root = match shape {
        BodyShape::Par | BodyShape::Bar => "Body",
        BodyShape::MovingHead => "Base",
    };
    let xml = format!(
        concat!(
            r#"<GDTF DataVersion="1.2"><FixtureType Name="{name}" ShortName="{name}" LongName="{name}" "#,
            r#"Manufacturer="{manufacturer}" Description="" FixtureTypeID="{id}" RefFT="" Thumbnail="">"#,
            r#"<AttributeDefinitions><FeatureGroups/><Attributes/></AttributeDefinitions><Wheels/><PhysicalDescriptions/>"#,
            r#"{body}<DMXModes><DMXMode Name="Default" Geometry="{root}"><DMXChannels/></DMXMode></DMXModes>"#,
            r#"<Revisions/></FixtureType></GDTF>"#,
        ),
        name = escape(name),
        manufacturer = escape(manufacturer),
        id = uuid::Uuid::new_v4(),
        body = body_xml(shape),
        root = root,
    );
    let mut description: gdtf::Description = xml
        .parse()
        .map_err(|error: gdtf::GdtfError| error.to_string())?;
    description
        .fixture_types
        .pop()
        .ok_or_else(|| "The blank fixture has no fixture type".to_string())
}

/// Builds the blank fixture type a new draft starts from.
pub(super) fn blank_fixture_type(name: &str, manufacturer: &str) -> Result<FixtureType, String> {
    fixture_type(name, manufacturer, BodyShape::Par)
}

/// Models and geometry of a body shape.
pub(super) fn body(shape: BodyShape) -> Result<(Vec<Model>, Vec<Geometry>), String> {
    let fixture_type = fixture_type("Body", GENERIC_MANUFACTURER, shape)?;
    Ok((fixture_type.models, fixture_type.geometries))
}

/// State of a blank draft: a par body with one empty mode.
pub(super) fn blank_state() -> Result<DraftState, String> {
    let mut description = gdtf::Description::new();
    description
        .fixture_types
        .push(blank_fixture_type("New fixture", GENERIC_MANUFACTURER)?);
    Ok(DraftState {
        description,
        body: Some(BodyShape::Par),
    })
}

/// State of a draft started from a template, with its mode named after its footprint.
pub(super) fn template_state(template: DraftTemplate) -> Result<DraftState, String> {
    let (name, shape, channels): (&str, BodyShape, &[(&str, u8)]) = match template {
        DraftTemplate::Dimmer => ("Dimmer", BodyShape::Par, &[("Dimmer", 1)]),
        DraftTemplate::Rgb => (
            "RGB",
            BodyShape::Par,
            &[("ColorAdd_R", 1), ("ColorAdd_G", 1), ("ColorAdd_B", 1)],
        ),
        DraftTemplate::Rgbw => (
            "RGBW",
            BodyShape::Par,
            &[
                ("ColorAdd_R", 1),
                ("ColorAdd_G", 1),
                ("ColorAdd_B", 1),
                ("ColorAdd_W", 1),
            ],
        ),
        DraftTemplate::Rgbawuv => (
            "RGBAW UV",
            BodyShape::Par,
            &[
                ("ColorAdd_R", 1),
                ("ColorAdd_G", 1),
                ("ColorAdd_B", 1),
                ("ColorAdd_RY", 1),
                ("ColorAdd_W", 1),
                ("ColorAdd_UV", 1),
            ],
        ),
        DraftTemplate::DimmerRgbStrobe => (
            "Dimmer RGB Strobe",
            BodyShape::Par,
            &[
                ("Dimmer", 1),
                ("ColorAdd_R", 1),
                ("ColorAdd_G", 1),
                ("ColorAdd_B", 1),
                ("Shutter1Strobe", 1),
            ],
        ),
        DraftTemplate::MovingHead => (
            "Moving Head",
            BodyShape::MovingHead,
            &[
                ("Pan", 2),
                ("Tilt", 2),
                ("Dimmer", 1),
                ("Shutter1", 1),
                ("Color1", 1),
            ],
        ),
    };

    let mut state = blank_state()?;
    let mut edits = vec![DraftEdit::SetInfo(super::view::DraftInfo {
        name: name.to_string(),
        short_name: name.to_string(),
        long_name: format!("{GENERIC_MANUFACTURER} {name}"),
        manufacturer: GENERIC_MANUFACTURER.to_string(),
        description: String::new(),
    })];
    if shape != BodyShape::Par {
        edits.push(DraftEdit::SetBody(shape));
    }
    edits.extend(
        channels
            .iter()
            .map(|(attribute, resolution)| DraftEdit::AddChannel {
                mode: 0,
                index: None,
                attribute: (*attribute).to_string(),
                resolution: *resolution,
            }),
    );
    if template == DraftTemplate::MovingHead {
        edits.extend(moving_head_wheel_and_shutter());
    }
    for edit in &edits {
        apply_edit(&mut state, edit)?;
    }

    let mode = &state.description.fixture_types[0].dmx_modes[0];
    let mode_name = format!("{}-channel", footprint(mode));
    apply_edit(
        &mut state,
        &DraftEdit::RenameMode {
            mode: 0,
            name: mode_name,
        },
    )?;
    Ok(state)
}

/// Edits giving the moving head template a color wheel and named shutter ranges.
///
/// Channel positions follow the template's channel list: the shutter is
/// channel 3 and the color wheel channel 4.
fn moving_head_wheel_and_shutter() -> Vec<DraftEdit> {
    let slots = [
        ("Open", [0.3127, 0.3290, 100.0]),
        ("Red", [0.7, 0.29, 20.0]),
        ("Green", [0.17, 0.7, 40.0]),
        ("Blue", [0.14, 0.05, 10.0]),
    ];
    vec![
        DraftEdit::SetFunctionSets {
            mode: 0,
            channel: 3,
            function: 0,
            sets: vec![set("Closed", 0, None), set("Open", 32, None)],
        },
        DraftEdit::AddWheel {
            name: "Color1".to_string(),
        },
        DraftEdit::SetWheelSlots {
            wheel: 0,
            slots: slots
                .iter()
                .map(|(name, color)| DraftSlotFields {
                    name: (*name).to_string(),
                    color: Some(*color),
                })
                .collect(),
        },
        DraftEdit::UpdateFunction {
            mode: 0,
            channel: 4,
            function: 0,
            fields: DraftFunctionFields {
                name: "Color1 1".to_string(),
                attribute: "Color1".to_string(),
                dmx_from: 0,
                default: 0,
                physical_from: 0.0,
                physical_to: 0.0,
                wheel: Some("Color1".to_string()),
            },
        },
        DraftEdit::SetFunctionSets {
            mode: 0,
            channel: 4,
            function: 0,
            sets: slots
                .iter()
                .enumerate()
                .map(|(index, (name, _))| set(name, index as u32 * 32, Some(index as i32 + 1)))
                .collect(),
        },
    ]
}

/// Builds the fields of a named range.
fn set(name: &str, dmx_from: u32, wheel_slot: Option<i32>) -> DraftSetFields {
    DraftSetFields {
        name: name.to_string(),
        dmx_from,
        wheel_slot,
    }
}
