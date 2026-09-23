// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Preserve declared attribute units and labels independently of geometry naming.

use std::collections::{HashMap, HashSet};

use gdtf::attribute::{AttributeDefinitions, PhysicalUnit, SubPhysicalUnitType};
use gdtf::values::Node;
use serde::Serialize;

use crate::gdtf_resolver::ResolveError;

/// An attribute's auxiliary physical quantity, before function-specific subchannel overrides.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledSubPhysicalUnit {
    /// Authored purpose, such as duration or placement offset.
    pub kind: SubPhysicalUnitType,
    /// Unit declared for this auxiliary quantity.
    pub unit: PhysicalUnit,
    /// Default start value; descending and constant intervals remain valid.
    pub physical_from: f64,
    /// Default end value.
    pub physical_to: f64,
}

/// A named attribute declaration shared by all instantiated functions using it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledAttribute {
    /// Exact source identifier; not a geometry label or an inferred semantic alias.
    pub name: String,
    /// Operator-facing label, independent of channel and geometry identity.
    pub pretty: String,
    /// Physical unit authored in the definition; no guessing from attribute spelling.
    pub unit: PhysicalUnit,
    /// Default auxiliary quantities in authored order.
    pub subphysical_units: Vec<CompiledSubPhysicalUnit>,
}

/// Immutable declaration table with exact, unambiguous link resolution.
#[derive(Debug, Serialize)]
pub struct AttributeLibrary {
    attributes: Vec<CompiledAttribute>,
    #[serde(skip)]
    indices: HashMap<String, usize>,
}

/// Attach a malformed declaration or link to its source identity.
fn error(code: &'static str, path: &str, message: &str) -> ResolveError {
    ResolveError {
        code,
        path: path.into(),
        message: message.into(),
    }
}

/// Compile a bounded attribute table without retaining parser objects or flattening auxiliary units.
pub fn compile_attributes(
    source: &AttributeDefinitions,
    attribute_limit: usize,
    subunit_limit: usize,
) -> Result<AttributeLibrary, ResolveError> {
    if source.attributes.len() > attribute_limit {
        return Err(error(
            "attribute_limit",
            "attributes",
            "Attribute count exceeds the compilation budget",
        ));
    }
    let mut attributes = Vec::with_capacity(source.attributes.len());
    let mut indices = HashMap::new();
    let mut count = 0usize;
    for source in &source.attributes {
        let name = source
            .name
            .as_ref()
            .map(ToString::to_string)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                error(
                    "missing_attribute_name",
                    "attributes",
                    "An attribute must have a linkable name",
                )
            })?;
        if indices.insert(name.clone(), attributes.len()).is_some() {
            return Err(error(
                "duplicate_attribute",
                &name,
                "Attribute names must be unique",
            ));
        }
        count = count
            .checked_add(source.subphysical_units.len())
            .filter(|count| *count <= subunit_limit)
            .ok_or_else(|| {
                error(
                    "subunit_limit",
                    &name,
                    "Subphysical units exceed the compilation budget",
                )
            })?;
        let mut seen = HashSet::new();
        let mut subphysical_units = Vec::with_capacity(source.subphysical_units.len());
        for unit in &source.subphysical_units {
            if !seen.insert(unit.type_) {
                return Err(error(
                    "duplicate_subphysical_unit",
                    &name,
                    "A subphysical unit type must be unique within its attribute",
                ));
            }
            if !unit.physical_from.is_finite()
                || !unit.physical_to.is_finite()
                || !(unit.physical_to - unit.physical_from).is_finite()
            {
                return Err(error(
                    "invalid_subphysical_range",
                    &name,
                    "Subphysical endpoints and span must be finite",
                ));
            }
            subphysical_units.push(CompiledSubPhysicalUnit {
                kind: unit.type_,
                unit: unit.physical_unit,
                physical_from: unit.physical_from,
                physical_to: unit.physical_to,
            });
        }
        attributes.push(CompiledAttribute {
            name,
            pretty: source.pretty.clone(),
            unit: source.physical_unit,
            subphysical_units,
        });
    }
    Ok(AttributeLibrary {
        attributes,
        indices,
    })
}

impl AttributeLibrary {
    /// Inspect declarations by their stable index within this compiled definition.
    pub fn attributes(&self) -> &[CompiledAttribute] {
        &self.attributes
    }

    /// Resolve an exact single-component attribute link without taking a first or partial match.
    pub fn resolve(&self, link: &Node) -> Result<usize, ResolveError> {
        let index = match link.as_ref() {
            [name] => self.indices.get(name.as_ref()).copied(),
            _ => None,
        };
        index.ok_or_else(|| {
            error(
                "invalid_attribute_link",
                &link.to_string(),
                "Attribute link must name one declared attribute",
            )
        })
    }
}
