// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Attribute labels, units and exact links are independent of geometry and UI naming.

use gdtf::attribute::{AttributeDefinitions, PhysicalUnit, SubPhysicalUnit, SubPhysicalUnitType};
use nightfall_fixture_library::gdtf_attributes::compile_attributes;

/// Extract declarations from the resource-free compiler fixture.
fn attributes() -> AttributeDefinitions {
    let mut description: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap();
    description.fixture_types.remove(0).attribute_definitions
}

/// Build an auxiliary declaration with independently specified endpoints.
fn subunit(from: f64, to: f64) -> SubPhysicalUnit {
    SubPhysicalUnit {
        type_: SubPhysicalUnitType::Value,
        physical_unit: PhysicalUnit::Time,
        physical_from: from,
        physical_to: to,
    }
}

/// Source-declared units and labels survive source disposal and are never inferred from names.
#[test]
fn units_and_labels_remain_authored_data() {
    let library = {
        let mut source = attributes();
        source.attributes[0].pretty = "Independent arm".into();
        source.attributes[0].physical_unit = PhysicalUnit::Time;
        source.attributes[0].subphysical_units = vec![subunit(3.0, -2.0)];
        compile_attributes(&source, 5, 1).unwrap()
    };
    let link = serde_json::from_value(serde_json::json!("Tilt")).unwrap();
    let tilt = &library.attributes()[library.resolve(&link).unwrap()];
    assert_eq!(tilt.name, "Tilt");
    assert_eq!(tilt.pretty, "Independent arm");
    assert_eq!(tilt.unit, PhysicalUnit::Time);
    assert_eq!(tilt.subphysical_units[0].unit, PhysicalUnit::Time);
    assert_eq!(
        (
            tilt.subphysical_units[0].physical_from,
            tilt.subphysical_units[0].physical_to
        ),
        (3.0, -2.0)
    );
    assert_eq!(library.attributes()[2].unit, PhysicalUnit::Percent);
}

/// Missing or partial links cannot select an arbitrary attribute with a similar name.
#[test]
fn links_require_exact_single_component_names() {
    let library = compile_attributes(&attributes(), 5, 0).unwrap();
    for value in ["Missing", "Tilt.Extra", "tilt"] {
        let link = serde_json::from_value(serde_json::json!(value)).unwrap();
        assert_eq!(
            library.resolve(&link).unwrap_err().code,
            "invalid_attribute_link"
        );
    }
}

/// Declaration identity and budgets fail before an incomplete table can escape compilation.
#[test]
fn invalid_declarations_and_budgets_are_rejected() {
    assert_eq!(
        compile_attributes(&attributes(), 4, 0).unwrap_err().code,
        "attribute_limit"
    );
    let mut source = attributes();
    source.attributes.push(source.attributes[0].clone());
    assert_eq!(
        compile_attributes(&source, 6, 0).unwrap_err().code,
        "duplicate_attribute"
    );
    source.attributes.pop();
    source.attributes[0].name = None;
    assert_eq!(
        compile_attributes(&source, 5, 0).unwrap_err().code,
        "missing_attribute_name"
    );
    let mut source = attributes();
    source.attributes[0]
        .subphysical_units
        .push(subunit(0.0, 1.0));
    assert_eq!(
        compile_attributes(&source, 5, 0).unwrap_err().code,
        "subunit_limit"
    );
    source.attributes[0]
        .subphysical_units
        .push(subunit(0.0, 1.0));
    assert_eq!(
        compile_attributes(&source, 5, 2).unwrap_err().code,
        "duplicate_subphysical_unit"
    );
}

/// Nonfinite auxiliary data cannot enter serialized contracts or physical arithmetic.
#[test]
fn auxiliary_endpoints_require_finite_values_and_span() {
    for (from, to) in [(f64::NAN, 1.0), (0.0, f64::INFINITY), (-f64::MAX, f64::MAX)] {
        let mut source = attributes();
        source.attributes[0].subphysical_units = vec![subunit(from, to)];
        assert_eq!(
            compile_attributes(&source, 5, 1).unwrap_err().code,
            "invalid_subphysical_range"
        );
    }
}
