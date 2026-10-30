// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! GDTF attribute definitions the editor adds when a channel first uses an attribute.

use gdtf::fixture_type::FixtureType;
use quick_xml::escape::escape;

/// Definition of one GDTF attribute from the specification's attribute list.
pub(super) struct CatalogAttribute {
    /// Attribute name, e.g. `ColorAdd_R`.
    pub name: &'static str,
    /// Short name shown on consoles.
    pub pretty: &'static str,
    /// Feature group the attribute belongs to.
    pub group: &'static str,
    /// Feature within the group.
    pub feature: &'static str,
    /// GDTF physical unit name.
    pub unit: &'static str,
    /// Physical range a new function covers.
    pub physical: (f64, f64),
    /// CIE x, y and Y of an additive color emitter.
    pub color: Option<[f64; 3]>,
}

/// Attributes the editor knows how to define; others become custom control attributes.
pub(super) const CATALOG: &[CatalogAttribute] = &[
    entry("Dimmer", "Dim", "Dimmer", "Dimmer", "None", (0.0, 1.0)),
    entry("Pan", "P", "Position", "PanTilt", "Angle", (-270.0, 270.0)),
    entry("Tilt", "T", "Position", "PanTilt", "Angle", (-135.0, 135.0)),
    color("ColorAdd_R", "R", [0.7347, 0.2653, 100.0]),
    color("ColorAdd_G", "G", [0.1596, 0.8404, 100.0]),
    color("ColorAdd_B", "B", [0.0366, 0.0001, 100.0]),
    color("ColorAdd_W", "W", [0.3127, 0.3290, 100.0]),
    color("ColorAdd_RY", "Amber", [0.5951, 0.4040, 100.0]),
    color("ColorAdd_UV", "UV", [0.1724, 0.0048, 100.0]),
    entry("Color1", "C1", "Color", "Color", "None", (0.0, 0.0)),
    entry(
        "CTO",
        "CTO",
        "Color",
        "Color",
        "Temperature",
        (6500.0, 3200.0),
    ),
    entry("Gobo1", "G1", "Gobo", "Gobo", "None", (0.0, 0.0)),
    entry("Shutter1", "Sh1", "Beam", "Beam", "None", (0.0, 1.0)),
    entry(
        "Shutter1Strobe",
        "Strobe1",
        "Beam",
        "Beam",
        "Frequency",
        (0.0, 20.0),
    ),
    entry("Iris", "Iris", "Beam", "Beam", "None", (0.0, 1.0)),
    entry("Prism1", "Prism1", "Beam", "Beam", "None", (0.0, 1.0)),
    entry("Frost1", "Frost1", "Beam", "Beam", "None", (0.0, 1.0)),
    entry("Zoom", "Zoom", "Focus", "Focus", "Angle", (10.0, 40.0)),
    entry("Focus1", "Focus1", "Focus", "Focus", "None", (0.0, 1.0)),
    entry(
        "Control1",
        "Ctrl1",
        "Control",
        "Control",
        "None",
        (0.0, 1.0),
    ),
];

/// Builds a catalog entry without an emitter color.
const fn entry(
    name: &'static str,
    pretty: &'static str,
    group: &'static str,
    feature: &'static str,
    unit: &'static str,
    physical: (f64, f64),
) -> CatalogAttribute {
    CatalogAttribute {
        name,
        pretty,
        group,
        feature,
        unit,
        physical,
        color: None,
    }
}

/// Builds an additive color mixing entry with its emitter color.
const fn color(name: &'static str, pretty: &'static str, cie: [f64; 3]) -> CatalogAttribute {
    CatalogAttribute {
        name,
        pretty,
        group: "Color",
        feature: "RGB",
        unit: "ColorComponent",
        physical: (0.0, 1.0),
        color: Some(cie),
    }
}

/// Looks up an attribute in the catalog by its GDTF name.
pub(super) fn find(name: &str) -> Option<&'static CatalogAttribute> {
    CATALOG.iter().find(|attribute| attribute.name == name)
}

/// Physical range a new function for `attribute` covers.
pub(super) fn physical_range(attribute: &str) -> (f64, f64) {
    find(attribute).map_or((0.0, 1.0), |attribute| attribute.physical)
}

/// Adds the definition of `attribute`, and its feature group and feature, when the fixture type lacks it.
///
/// Attributes outside the catalog are defined as custom attributes under
/// `Control.Control` with no physical unit.
pub(super) fn ensure_attribute(
    fixture_type: &mut FixtureType,
    attribute: &str,
) -> Result<(), String> {
    if attribute.trim().is_empty() {
        return Err("A function needs an attribute".to_string());
    }
    let name = super::edit::gdtf_name(attribute)?;
    let definitions = &mut fixture_type.attribute_definitions;
    if definitions
        .attributes
        .iter()
        .any(|existing| existing.name.as_ref() == Some(&name))
    {
        return Ok(());
    }
    let catalog = find(attribute);
    let (group, feature) =
        catalog.map_or(("Control", "Control"), |entry| (entry.group, entry.feature));
    ensure_feature(fixture_type, group, feature)?;

    let color = catalog
        .and_then(|entry| entry.color)
        .map(|[x, y, luminance]| format!(r#" Color="{x},{y},{luminance}""#))
        .unwrap_or_default();
    let xml = format!(
        r#"<Attribute Name="{name}" Pretty="{pretty}" Feature="{group}.{feature}" PhysicalUnit="{unit}"{color}/>"#,
        name = escape(attribute),
        pretty = escape(catalog.map_or(attribute, |entry| entry.pretty)),
        unit = catalog.map_or("None", |entry| entry.unit),
    );
    let definition = quick_xml::de::from_str(&xml).map_err(|error| error.to_string())?;
    fixture_type
        .attribute_definitions
        .attributes
        .push(definition);
    Ok(())
}

/// Adds a feature group and feature when the fixture type lacks them.
fn ensure_feature(
    fixture_type: &mut FixtureType,
    group: &str,
    feature: &str,
) -> Result<(), String> {
    let group_name = super::edit::gdtf_name(group)?;
    let feature_name = super::edit::gdtf_name(feature)?;
    let groups = &mut fixture_type.attribute_definitions.feature_groups;
    let index = match groups
        .iter()
        .position(|existing| existing.name.as_ref() == Some(&group_name))
    {
        Some(index) => index,
        None => {
            let xml = format!(r#"<FeatureGroup Name="{group}" Pretty="{group}"/>"#);
            groups.push(quick_xml::de::from_str(&xml).map_err(|error| error.to_string())?);
            groups.len() - 1
        }
    };
    let features = &mut groups[index].features;
    if !features
        .iter()
        .any(|existing| existing.name.as_ref() == Some(&feature_name))
    {
        let xml = format!(r#"<Feature Name="{feature}"/>"#);
        features.push(quick_xml::de::from_str(&xml).map_err(|error| error.to_string())?);
    }
    Ok(())
}
