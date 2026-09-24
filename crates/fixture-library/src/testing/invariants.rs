// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Structural invariants every converted fixture mode must satisfy.
//!
//! These checks need no per-fixture expectations, so they apply equally to
//! synthetic archives, the curated bench, and a full-collection sweep. A
//! violation means either the converter or the source file is wrong; both are
//! worth reporting.

use std::collections::{HashMap, HashSet};

use nightfall_fixtures::prelude::*;

use crate::converters::gdtf_resolve::MAX_GEOMETRY_INSTANCES;

/// A broken invariant in a converted fixture mode.
#[derive(Debug, Clone, PartialEq)]
pub enum InvariantViolation {
    /// Two parameters write the same footprint slot.
    SlotOverlap {
        /// 1-based footprint slot.
        slot: u16,
        /// Element labels of the colliding parameters.
        elements: (String, String),
    },
    /// The primary footprint exceeds one DMX universe.
    FootprintTooLarge {
        /// Footprint in slots.
        footprint: u16,
    },
    /// The geometry tree has no roots or a root has a parent.
    InvalidRoots,
    /// A node's parent or child index is out of range or inconsistent.
    BrokenLink {
        /// Node index.
        node: usize,
    },
    /// A node is unreachable from the roots or reachable more than once.
    NotATree {
        /// Node index.
        node: usize,
    },
    /// Two geometry nodes share a name.
    DuplicateNodeName {
        /// Repeated name.
        name: String,
    },
    /// A node transform contains NaN or infinity.
    NonFiniteTransform {
        /// Node name.
        name: String,
    },
    /// The geometry exceeds the instance limit.
    TooManyNodes {
        /// Node count.
        count: usize,
    },
    /// A beam claims a controlling element that does not exist.
    UnknownControlledElement {
        /// Beam node name.
        node: String,
        /// Missing element label.
        element: String,
    },
    /// An element label does not name any geometry node.
    ElementWithoutGeometry {
        /// Element label.
        element: String,
    },
}

/// Checks all invariants and returns every violation found.
pub fn check_invariants(
    fixture: &Fixture,
    geometry: Option<&FixtureGeometry>,
) -> Vec<InvariantViolation> {
    let mut violations = check_wire(fixture);
    if let Some(geometry) = geometry {
        violations.extend(check_geometry(geometry));
        violations.extend(check_bindings(fixture, geometry));
    }
    violations
}

/// Checks that parameters never share bytes and the footprint fits a universe.
fn check_wire(fixture: &Fixture) -> Vec<InvariantViolation> {
    let mut violations = Vec::new();
    let layout = WireLayout::new(fixture.elements.iter().flat_map(|element| {
        element
            .parameters
            .iter()
            .map(move |metadata| (element.label.as_str(), metadata))
    }));

    let mut owners: HashMap<u16, &str> = HashMap::new();
    for placed in &layout.parameters {
        for slot in &placed.slots {
            if let Some(existing) = owners.insert(*slot, placed.target) {
                violations.push(InvariantViolation::SlotOverlap {
                    slot: slot + 1,
                    elements: (existing.to_string(), placed.target.to_string()),
                });
            }
        }
    }
    if layout.footprint() > 512 {
        violations.push(InvariantViolation::FootprintTooLarge {
            footprint: layout.footprint(),
        });
    }
    violations
}

/// Checks that the geometry is a well-formed, finite, uniquely named forest.
fn check_geometry(geometry: &FixtureGeometry) -> Vec<InvariantViolation> {
    let mut violations = Vec::new();
    let count = geometry.nodes.len();
    if count > MAX_GEOMETRY_INSTANCES {
        violations.push(InvariantViolation::TooManyNodes { count });
    }
    if geometry.roots.is_empty()
        || geometry.roots.iter().any(|root| {
            geometry
                .nodes
                .get(*root as usize)
                .is_none_or(|node| node.parent_index != -1)
        })
    {
        violations.push(InvariantViolation::InvalidRoots);
    }

    for (index, node) in geometry.nodes.iter().enumerate() {
        let parent_ok = node.parent_index == -1
            || geometry
                .nodes
                .get(node.parent_index as usize)
                .is_some_and(|parent| parent.children.contains(&(index as u32)));
        let children_ok = node.children.iter().all(|child| {
            geometry
                .nodes
                .get(*child as usize)
                .is_some_and(|child| child.parent_index == index as i32)
        });
        if !parent_ok || !children_ok {
            violations.push(InvariantViolation::BrokenLink { node: index });
        }
        if node
            .transform
            .elements
            .iter()
            .any(|value| !value.is_finite())
        {
            violations.push(InvariantViolation::NonFiniteTransform {
                name: node.name.clone(),
            });
        }
    }

    let mut visits = vec![0usize; count];
    let mut stack: Vec<usize> = geometry.roots.iter().map(|root| *root as usize).collect();
    while let Some(index) = stack.pop() {
        let Some(visit) = visits.get_mut(index) else {
            continue;
        };
        *visit += 1;
        if *visit == 1 {
            stack.extend(
                geometry.nodes[index]
                    .children
                    .iter()
                    .map(|child| *child as usize),
            );
        }
    }
    for (node, visit) in visits.iter().enumerate() {
        if *visit != 1 {
            violations.push(InvariantViolation::NotATree { node });
        }
    }

    let mut names = HashSet::new();
    for node in &geometry.nodes {
        if !names.insert(node.name.as_str()) {
            violations.push(InvariantViolation::DuplicateNodeName {
                name: node.name.clone(),
            });
        }
    }
    violations
}

/// Checks that elements, beams and axes refer to each other consistently.
fn check_bindings(fixture: &Fixture, geometry: &FixtureGeometry) -> Vec<InvariantViolation> {
    let mut violations = Vec::new();
    let labels: HashSet<&str> = fixture
        .elements
        .iter()
        .map(|element| element.label.as_str())
        .collect();
    let node_names: HashSet<&str> = geometry
        .nodes
        .iter()
        .map(|node| node.name.as_str())
        .collect();

    for node in &geometry.nodes {
        if let Some(element) = &node.controlled_element
            && !labels.contains(element.as_str())
        {
            violations.push(InvariantViolation::UnknownControlledElement {
                node: node.name.clone(),
                element: element.clone(),
            });
        }
    }

    for element in &fixture.elements {
        if !node_names.contains(element.label.as_str()) {
            violations.push(InvariantViolation::ElementWithoutGeometry {
                element: element.label.clone(),
            });
        }
    }
    violations
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::converters::gdtf::convert_gdtf_to_fixture;
    use crate::testing::{BreakSpec, ChannelSpec, GdtfBuilder, GeometrySpec, ModeSpec};

    /// Converts the first mode of a synthetic archive.
    fn convert(builder: &GdtfBuilder) -> (Fixture, Option<FixtureGeometry>) {
        let dir = tempfile::tempdir().unwrap();
        let metadata = builder.write_metadata(dir.path());
        let mode = metadata.modes[0].clone();
        convert_gdtf_to_fixture(&metadata, &mode, 1).unwrap()
    }

    /// Builds a well-formed moving head with a referenced pixel ring.
    fn valid_fixture() -> GdtfBuilder {
        GdtfBuilder::new("Test", "Valid")
            .geometry(
                GeometrySpec::generic("Base").child(
                    GeometrySpec::axis("Yoke").child(
                        GeometrySpec::axis("Head")
                            .child(GeometrySpec::beam("Beam"))
                            .child(GeometrySpec::reference("Ring 1", "Ring Pixel", &[(1, 5)]))
                            .child(GeometrySpec::reference("Ring 2", "Ring Pixel", &[(1, 6)])),
                    ),
                ),
            )
            .geometry(GeometrySpec::beam("Ring Pixel"))
            .mode(
                ModeSpec::new("Mode", "Base")
                    .channel(ChannelSpec::new("Yoke", "Pan", &[1, 2]))
                    .channel(ChannelSpec::new("Head", "Tilt", &[3, 4]))
                    .channel(
                        ChannelSpec::new("Ring Pixel", "Dimmer", &[1])
                            .on_break(BreakSpec::Overwrite),
                    )
                    .channel(ChannelSpec::new("Beam", "Dimmer", &[7])),
            )
    }

    /// Verifies a well-formed synthetic fixture has no violations.
    #[test]
    fn valid_fixture_has_no_violations() {
        let (fixture, geometry) = convert(&valid_fixture());
        assert_eq!(check_invariants(&fixture, geometry.as_ref()), vec![]);
    }

    /// Verifies references whose break offsets collide are reported as slot overlaps.
    #[test]
    fn colliding_reference_offsets_are_detected() {
        let builder = GdtfBuilder::new("Test", "Colliding")
            .geometry(
                GeometrySpec::generic("Body")
                    .child(GeometrySpec::reference("Pixel 1", "Pixel", &[(1, 1)]))
                    .child(GeometrySpec::reference("Pixel 2", "Pixel", &[(1, 2)])),
            )
            .geometry(GeometrySpec::beam("Pixel"))
            .mode(
                ModeSpec::new("Mode", "Body")
                    .channel(ChannelSpec::new("Pixel", "ColorAdd_R", &[1]))
                    .channel(ChannelSpec::new("Pixel", "ColorAdd_G", &[2])),
            );
        let (fixture, geometry) = convert(&builder);
        assert_eq!(
            check_invariants(&fixture, geometry.as_ref()),
            vec![InvariantViolation::SlotOverlap {
                slot: 2,
                elements: ("Pixel 1".to_string(), "Pixel 2".to_string()),
            }]
        );
    }

    /// Verifies corrupted trees, names and transforms are all reported.
    #[test]
    fn broken_geometry_is_detected() {
        let (fixture, geometry) = convert(&valid_fixture());
        let mut geometry = geometry.unwrap();
        geometry.nodes[1].name = geometry.nodes[0].name.clone();
        geometry.nodes[2].transform.elements[12] = f32::NAN;
        geometry.nodes[3].parent_index = 0;
        let violations = check_invariants(&fixture, Some(&geometry));
        assert!(violations.contains(&InvariantViolation::DuplicateNodeName {
            name: "Base".to_string()
        }));
        assert!(
            violations.contains(&InvariantViolation::NonFiniteTransform {
                name: "Head".to_string()
            })
        );
        assert!(violations.contains(&InvariantViolation::BrokenLink { node: 3 }));
    }

    /// Verifies a child listed under two parents is not accepted as a tree.
    #[test]
    fn shared_children_are_detected() {
        let (fixture, geometry) = convert(&valid_fixture());
        let mut geometry = geometry.unwrap();
        let child = geometry.nodes[2].children[0];
        geometry.nodes[0].children.push(child);
        let violations = check_invariants(&fixture, Some(&geometry));
        assert!(violations.contains(&InvariantViolation::NotATree {
            node: child as usize
        }));
    }
}
