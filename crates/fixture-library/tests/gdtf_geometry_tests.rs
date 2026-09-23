// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Owned geometry and channel coherence with independent transform and reference expectations.

use nightfall_fixture_library::gdtf_compiler::{CompileLimits, CompiledMode, compile_mode};
use nightfall_fixture_library::gdtf_geometry::GeometryKind;
use nightfall_fixture_library::gdtf_resolver::ResolveError;

/// Parse two nested joints and repeated references without external archive assets.
fn description() -> gdtf::Description {
    include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap()
}

/// Drop parser objects before exposing a compiled mode to each test.
fn compile(source: gdtf::Description) -> Result<CompiledMode, ResolveError> {
    compile_mode(
        &source.fixture_types[0],
        "Nested sparse",
        CompileLimits::default(),
    )
}

/// Every joint and repeated control retains the matching owned geometry index and authored rest placement.
#[test]
fn owned_mode_preserves_nested_joints_and_reference_identity() {
    let mode = compile(description()).unwrap();
    assert_eq!(mode.name(), "Nested sparse");
    let geometry = mode.geometry();
    assert_eq!(geometry.nodes().len(), 5);
    assert_eq!(
        geometry
            .nodes()
            .iter()
            .map(|node| node.parent)
            .collect::<Vec<_>>(),
        [None, Some(0), Some(1), Some(2), Some(2)]
    );
    assert_eq!(
        geometry.nodes()[2].rest,
        [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 1.0],
            [0.0, 0.0, 0.0, 1.0]
        ]
    );
    assert_eq!(geometry.nodes()[4].rest[0][3], 1.0);
    assert_eq!(geometry.nodes()[3].name, "Pixel 1");
    assert_eq!(geometry.nodes()[4].name, "Pixel 2");
    assert_eq!(geometry.nodes()[3].source_name, "Pixel");
    assert_ne!(geometry.nodes()[3].id, geometry.nodes()[4].id);
    assert_eq!(geometry.joints().len(), 2);
    for (joint, expected) in geometry.joints().iter().zip([1, 2]) {
        assert_eq!(joint.geometry, expected);
        assert_eq!(
            mode.channels().channels()[joint.channel].geometry,
            joint.geometry
        );
        assert_eq!(geometry.nodes()[expected].kind, GeometryKind::Axis);
    }
}

/// An asymmetric reflected and rotated matrix must survive numerically without transposition or unit changes.
#[test]
fn numeric_rest_matrix_preserves_rows_and_handedness() {
    let source = include_str!("fixtures/gdtf/nested-sparse.xml")
        .replace(
            "{1,0,0,0}{0,1,0,0}{0,0,1,1}{0,0,0,1}",
            "{0,-2,0,3}{-1,0,0,4}{0,0,0.5,5}{0,0,0,1}",
        )
        .parse()
        .unwrap();
    let mode = compile(source).unwrap();
    assert_eq!(
        mode.geometry().nodes()[2].rest,
        [
            [0.0, -2.0, 0.0, 3.0],
            [-1.0, 0.0, 0.0, 4.0],
            [0.0, 0.0, 0.5, 5.0],
            [0.0, 0.0, 0.0, 1.0]
        ]
    );
}

/// Reference model overrides and per-instance beam properties survive without selecting a fixture-wide beam.
#[test]
fn effective_models_and_independent_beams_are_owned() {
    let identity = "{1,0,0,0}{0,1,0,0}{0,0,1,0}{0,0,0,1}";
    let xml = include_str!("fixtures/gdtf/nested-sparse.xml")
        .replace("<Geometries>", "<Models><Model Name=\"Inner\" Length=\"1\" Width=\"2\" Height=\"3\" PrimitiveType=\"Cube\" File=\"inner\"/><Model Name=\"Outer\" Length=\"4\" Width=\"5\" Height=\"6\" PrimitiveType=\"Cylinder\"/></Models><Geometries>")
        .replace("Name=\"Pixel 1\" Geometry=\"Pixel\"", "Name=\"Pixel 1\" Geometry=\"Pixel\" Model=\"Outer\"")
        .replace(&format!("<Geometry Name=\"Pixel\" Position=\"{identity}\"/>"), &format!("<Beam Name=\"Pixel\" Model=\"Inner\" Position=\"{identity}\" LuminousFlux=\"100\" BeamAngle=\"12\" FieldAngle=\"20\" BeamType=\"Spot\"/>"))
        .replacen("</Axis>", &format!("<Beam Name=\"Glow\" Position=\"{identity}\" LuminousFlux=\"900\" BeamType=\"Glow\"/></Axis>"), 1);
    let mode = compile(xml.parse().unwrap()).unwrap();
    let geometry = mode.geometry();
    assert_eq!(geometry.nodes()[3].model, Some(1));
    assert_eq!(geometry.nodes()[4].model, Some(0));
    assert_eq!(geometry.models()[0].dimensions, [1.0, 2.0, 3.0]);
    assert_eq!(geometry.models()[0].file.as_deref(), Some("inner"));
    assert_eq!(
        geometry.nodes()[3].beam.as_ref().unwrap().luminous_flux,
        100.0
    );
    assert_eq!(geometry.nodes()[4].beam.as_ref().unwrap().beam_angle, 12.0);
    assert_eq!(
        geometry.nodes()[5].beam.as_ref().unwrap().luminous_flux,
        900.0
    );
    assert_eq!(
        geometry.nodes()[5].beam.as_ref().unwrap().beam_type,
        gdtf::geometry::BeamType::Glow
    );
    assert_eq!(
        serde_json::to_value(&mode).unwrap()["geometry"]["nodes"][3]["model"],
        1
    );
}

/// Broken model links, model budgets and invalid dimensions cannot become silent generic meshes.
#[test]
fn malformed_model_contracts_fail_compilation() {
    let mut source = description();
    source.fixture_types[0].models = serde_json::from_value(serde_json::json!([
        {"@Name":"Body", "@Length":1.0, "@Width":2.0, "@Height":3.0}
    ]))
    .unwrap();
    assert_eq!(
        compile_mode(
            &source.fixture_types[0],
            "Nested sparse",
            CompileLimits {
                models: 0,
                ..CompileLimits::default()
            }
        )
        .unwrap_err()
        .code,
        "model_limit"
    );
    source.fixture_types[0].models[0].width = -1.0;
    assert_eq!(
        compile(source.clone()).unwrap_err().code,
        "invalid_model_dimensions"
    );
    source.fixture_types[0].models[0].width = 2.0;
    let duplicate = source.fixture_types[0].models[0].clone();
    source.fixture_types[0].models.push(duplicate);
    assert_eq!(compile(source).unwrap_err().code, "duplicate_model");
    let source = include_str!("fixtures/gdtf/nested-sparse.xml")
        .replace(
            "Name=\"Base\" Position",
            "Name=\"Base\" Model=\"Missing\" Position",
        )
        .parse()
        .unwrap();
    assert_eq!(compile(source).unwrap_err().code, "missing_model");
}

/// Invalid optical values are rejected on the instantiated emitter before entering render state.
#[test]
fn nonfinite_beam_properties_are_diagnosed() {
    let mut source: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .replace("<Geometry Name=\"Pixel\"", "<Beam Name=\"Pixel\"")
        .parse()
        .unwrap();
    let gdtf::geometry::Geometry::Beam(beam) = &mut source.fixture_types[0].geometries[1] else {
        panic!("expected source beam template");
    };
    beam.luminous_flux = f64::NAN;
    let error = compile(source).unwrap_err();
    assert_eq!(error.code, "invalid_beam_properties");
    assert_eq!(error.path, "g/0/0/0/0");
}
