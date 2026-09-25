// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Mode master, relation, DMX profile and channel-set physical conversion tests.

use nightfall_dmx::prelude::Attribute;
use nightfall_fixtures::prelude::*;

use super::gdtf_resolve::GdtfDiagnostic;
use crate::testing::invariants::check_invariants;
use crate::testing::{BreakSpec, ChannelSpec, FunctionSpec, GdtfBuilder, GeometrySpec, ModeSpec};

/// Converts the first mode, asserting invariants, and returns the fixture with its diagnostics.
fn convert(builder: &GdtfBuilder) -> (Fixture, Vec<GdtfDiagnostic>) {
    let dir = tempfile::tempdir().unwrap();
    let metadata = builder.write_metadata(dir.path());
    let mut gdtf = metadata.reparse().unwrap();
    let mode = metadata.modes[0].clone();
    let converted = super::gdtf::convert_gdtf_mode(&mut gdtf, &metadata, &mode, 1).unwrap();
    assert_eq!(
        check_invariants(&converted.fixture, converted.geometry.as_ref()),
        vec![]
    );
    (converted.fixture, converted.diagnostics)
}

/// Returns the parameter of `element` with `attribute`.
fn parameter<'a>(
    fixture: &'a Fixture,
    element: &str,
    attribute: &Attribute,
) -> &'a ParameterMetadata {
    fixture
        .elements
        .iter()
        .find(|candidate| candidate.label == element)
        .and_then(|element| {
            element
                .parameters
                .iter()
                .find(|parameter| &parameter.attribute == attribute)
        })
        .unwrap_or_else(|| panic!("{element} has no {attribute:?} parameter"))
}

/// Verifies functions under different mode master conditions each span the
/// channel and carry their master's DMX range.
#[test]
fn mode_master_functions_range_per_condition() {
    let builder = GdtfBuilder::new("Test", "Modes")
        .geometry(GeometrySpec::generic("Base"))
        .mode(
            ModeSpec::new("Mode", "Base")
                .channel(ChannelSpec::new("Base", "Control", &[1]))
                .channel(
                    ChannelSpec::new("Base", "Shutter1", &[2])
                        .function(FunctionSpec::new("Shutter1").named("Open").mode_master(
                            "Base_Control",
                            0,
                            127,
                        ))
                        .function(
                            FunctionSpec::new("Shutter1")
                                .named("Closed")
                                .from_dmx(200)
                                .mode_master("Base_Control", 0, 127),
                        )
                        .function(
                            FunctionSpec::new("Shutter1Strobe")
                                .named("Strobe")
                                .physical(1.0, 25.0)
                                .mode_master("Base_Control", 128, 255),
                        ),
                ),
        );
    let (fixture, diagnostics) = convert(&builder);
    assert_eq!(diagnostics, vec![]);
    let shutter = parameter(&fixture, "Base", &Attribute::StrobeShutter);
    type Range<'a> = (&'a str, u32, u32, Option<(u32, u32)>);
    let ranges: Vec<Range> = shutter
        .functions
        .iter()
        .map(|function| {
            (
                function.name.as_str(),
                function.dmx_from,
                function.dmx_to,
                function
                    .mode_master
                    .as_ref()
                    .map(|master| (master.dmx_from, master.dmx_to)),
            )
        })
        .collect();
    assert_eq!(
        ranges,
        [
            ("Open", 0, 199, Some((0, 127))),
            ("Strobe", 0, 255, Some((128, 255))),
            ("Closed", 200, 255, Some((0, 127))),
        ]
    );
    let master = &shutter.functions[0].mode_master.as_ref().unwrap().master;
    assert_eq!(
        master,
        &ElementParameterRef {
            element: 0,
            attribute: Attribute::Custom {
                label: "Control".to_string()
            },
        }
    );
}

/// Verifies a relation from a body dimmer to a templated pixel color links
/// every pixel instance to the single body dimmer.
#[test]
fn relations_link_every_template_instance_to_a_shared_master() {
    let builder = GdtfBuilder::new("Test", "Bar")
        .geometry(
            GeometrySpec::generic("Body")
                .child(GeometrySpec::reference("Pixel 1", "Pixel", &[(1, 2)]))
                .child(GeometrySpec::reference("Pixel 2", "Pixel", &[(1, 3)])),
        )
        .geometry(GeometrySpec::beam("Pixel"))
        .mode(
            ModeSpec::new("Mode", "Body")
                .channel(ChannelSpec::virtual_channel("Body", "Dimmer"))
                .channel(
                    ChannelSpec::new("Pixel", "ColorAdd_R", &[1]).on_break(BreakSpec::Overwrite),
                )
                .relation(
                    "Body_Dimmer",
                    "Pixel_ColorAdd_R.ColorAdd_R.ColorAdd_R",
                    "Multiply",
                ),
        );
    let (fixture, diagnostics) = convert(&builder);
    assert_eq!(diagnostics, vec![]);
    let body = fixture
        .elements
        .iter()
        .position(|element| element.label == "Body")
        .unwrap() as u32;
    for pixel in ["Pixel 1", "Pixel 2"] {
        let red = parameter(&fixture, pixel, &Attribute::Red);
        assert_eq!(
            red.functions[0].relations,
            vec![FunctionRelation {
                master: ElementParameterRef {
                    element: body,
                    attribute: Attribute::Intensity,
                },
                kind: RelationKind::Multiply,
            }],
            "{pixel}"
        );
    }
    assert!(
        parameter(&fixture, "Body", &Attribute::Intensity).functions[0]
            .relations
            .is_empty()
    );
}

/// Verifies a mode master inside a template resolves to the same reference's channel.
#[test]
fn template_mode_masters_stay_within_their_reference() {
    let builder = GdtfBuilder::new("Test", "Cells")
        .geometry(
            GeometrySpec::generic("Body")
                .child(GeometrySpec::reference("Cell 1", "Cell", &[(1, 1)]))
                .child(GeometrySpec::reference("Cell 2", "Cell", &[(1, 3)])),
        )
        .geometry(GeometrySpec::beam("Cell"))
        .mode(
            ModeSpec::new("Mode", "Body")
                .channel(ChannelSpec::new("Cell", "Control", &[1]).on_break(BreakSpec::Overwrite))
                .channel(
                    ChannelSpec::new("Cell", "Dimmer", &[2])
                        .on_break(BreakSpec::Overwrite)
                        .function(FunctionSpec::new("Dimmer").mode_master("Cell_Control", 0, 9)),
                ),
        );
    let (fixture, _) = convert(&builder);
    for (index, element) in fixture.elements.iter().enumerate() {
        let dimmer = parameter(&fixture, &element.label, &Attribute::Intensity);
        let master = &dimmer.functions[0].mode_master.as_ref().unwrap().master;
        assert_eq!(master.element, index as u32, "{}", element.label);
    }
}

/// Verifies DMX profiles and channel-set physical overrides are carried on functions.
#[test]
fn profiles_and_set_physical_ranges_are_kept() {
    let builder = GdtfBuilder::new("Test", "Profiles")
        .dmx_profile("Square", &[[0.0, 0.0, 0.0, 0.01, 0.0]])
        .geometry(GeometrySpec::generic("Base"))
        .mode(
            ModeSpec::new("Mode", "Base").channel(
                ChannelSpec::new("Base", "Dimmer", &[1]).function(
                    FunctionSpec::new("Dimmer")
                        .dmx_profile("Square")
                        .physical_set("Low", 0, 0.0, 0.2)
                        .set("Rest", 128, None),
                ),
            ),
        );
    let (fixture, _) = convert(&builder);
    let function = &parameter(&fixture, "Base", &Attribute::Intensity).functions[0];
    assert_eq!(
        function.profile,
        vec![ProfilePoint {
            dmx_percent: 0.0,
            cfc0: 0.0,
            cfc1: 0.0,
            cfc2: 0.01,
            cfc3: 0.0,
        }]
    );
    assert_eq!(evaluate_profile(&function.profile, 50.0), 25.0);
    assert_eq!(
        (function.sets[0].physical_from, function.sets[0].physical_to),
        (Some(0.0), Some(0.2))
    );
    assert_eq!(
        (function.sets[1].physical_from, function.sets[1].physical_to),
        (None, None)
    );
}

/// Verifies links to channels that produced no parameter are dropped with a diagnostic.
#[test]
fn unresolved_links_are_reported() {
    let builder =
        GdtfBuilder::new("Test", "Dangling")
            .geometry(GeometrySpec::generic("Base").child(GeometrySpec::generic("Detached")))
            .geometry(GeometrySpec::generic("Elsewhere"))
            .mode(
                ModeSpec::new("Mode", "Base")
                    .channel(ChannelSpec::new("Elsewhere", "Control", &[1]))
                    .channel(ChannelSpec::new("Base", "Dimmer", &[2]).function(
                        FunctionSpec::new("Dimmer").mode_master("Elsewhere_Control", 0, 9),
                    )),
            );
    let (fixture, diagnostics) = convert(&builder);
    assert!(
        parameter(&fixture, "Base", &Attribute::Intensity).functions[0]
            .mode_master
            .is_none()
    );
    assert!(diagnostics.contains(&GdtfDiagnostic::UnresolvedLink {
        link: "Elsewhere_Control".to_string()
    }));
}
