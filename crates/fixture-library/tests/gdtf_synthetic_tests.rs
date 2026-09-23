// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Establish parser inputs for compiler, wire, and articulation acceptance tests.

use gdtf::geometry::{AnyGeometry, Geometry};

/// Keep two identically attributed nested joints, sparse bytes, and reference overrides intact.
#[test]
fn nested_sparse_description_preserves_compiler_inputs() {
    let description: gdtf::Description = include_str!("fixtures/gdtf/nested-sparse.xml")
        .parse()
        .unwrap();
    let fixture = &description.fixture_types[0];
    let mode = &fixture.dmx_modes[0];
    assert_eq!(mode.name.as_ref().unwrap().as_ref(), "Nested sparse");
    assert_eq!(mode.dmx_channels[0].offset.as_deref(), Some(&[1, 4][..]));
    assert_eq!(mode.dmx_channels[1].offset.as_deref(), Some(&[2, 5][..]));
    assert!(mode.dmx_channels[2].offset.is_none());
    let arm = &fixture.geometries[0].children()[0];
    let head = &arm.children()[0];
    assert_eq!(arm.name().unwrap().as_ref(), "Arm");
    assert_eq!(head.name().unwrap().as_ref(), "Head");
    assert_eq!(head.children().len(), 2);
    for (child, expected_offset) in head.children().iter().zip([10, 20]) {
        let Geometry::Reference(reference) = child else {
            panic!("Expected independently placed pixel references");
        };
        assert_eq!(reference.breaks[0].dmx_break, 2);
        assert_eq!(reference.breaks[0].dmx_offset.absolute(), expected_offset);
        assert_eq!(reference.geometry.as_ref().unwrap().as_ref(), "Pixel");
    }
    assert_eq!(fixture.geometries.len(), 3);
}
