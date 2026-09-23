// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Stable selectable control groups distinct from physical geometry traversal and labels.

use std::collections::HashMap;

use serde::Serialize;

use crate::gdtf_channels::CompiledChannels;
use crate::gdtf_geometry::CompiledGeometry;
use crate::gdtf_resolver::ResolveError;

/// A selectable part whose channels may control several logical functions without duplicating wire ownership.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlGroup {
    /// Structural group identity independent of its display label and operator number.
    pub id: String,
    /// One-based element number within this pinned mode, suitable for fixture.element addressing.
    pub element: u32,
    /// Geometry label for operator display; changing it does not change identity or numbering.
    pub label: String,
    /// Controlled geometry instance index; uncontrolled housings do not create groups.
    pub geometry: usize,
    /// Instantiated channel indices in source order. Each channel belongs to exactly one group.
    pub channels: Vec<usize>,
}

/// One eligible attribute function target; matching is explicit and never silently chooses the first one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ControlTarget {
    /// Index of the owning physical or virtual channel.
    pub channel: usize,
    /// Function index within that channel.
    pub function: usize,
}

/// Immutable operator ordering and reverse channel ownership for one compiled mode.
#[derive(Debug, Serialize)]
pub struct ControlGroups {
    groups: Vec<ControlGroup>,
    channel_groups: Vec<usize>,
    /// Per-group attribute-name index; skipped in diagnostics because targets are recoverable from channels.
    #[serde(skip)]
    attributes: Vec<HashMap<String, Vec<ControlTarget>>>,
}

/// Build groups from first channel occurrence, keeping repeated references and independently controlled joints distinct.
pub fn compile_controls(
    geometry: &CompiledGeometry,
    channels: &CompiledChannels,
) -> Result<ControlGroups, ResolveError> {
    let mut by_geometry = HashMap::new();
    let mut groups: Vec<ControlGroup> = Vec::new();
    let mut channel_groups = Vec::with_capacity(channels.channels().len());
    let mut attributes: Vec<HashMap<String, Vec<ControlTarget>>> = Vec::new();
    for (index, channel) in channels.channels().iter().enumerate() {
        let node = geometry
            .nodes()
            .get(channel.geometry)
            .ok_or_else(|| ResolveError {
                code: "invalid_control_geometry",
                path: channel.id.clone(),
                message: "Control channel has no matching geometry instance".into(),
            })?;
        let group = if let Some(&group) = by_geometry.get(&channel.geometry) {
            group
        } else {
            let group = groups.len();
            let element = u32::try_from(group)
                .ok()
                .and_then(|group| group.checked_add(1))
                .ok_or_else(|| ResolveError {
                    code: "element_number_overflow",
                    path: channel.id.clone(),
                    message: "Selectable group count exceeds operator addressing".into(),
                })?;
            groups.push(ControlGroup {
                id: format!("e/{}", node.id),
                element,
                label: if node.name.is_empty() {
                    format!("Part {element}")
                } else {
                    node.name.clone()
                },
                geometry: channel.geometry,
                channels: Vec::new(),
            });
            attributes.push(HashMap::new());
            by_geometry.insert(channel.geometry, group);
            group
        };
        groups[group].channels.push(index);
        channel_groups.push(group);
        for (function, metadata) in channel.functions.iter().enumerate() {
            let name = &channels.attributes().attributes()[metadata.attribute].name;
            attributes[group]
                .entry(name.clone())
                .or_default()
                .push(ControlTarget {
                    channel: index,
                    function,
                });
        }
    }
    Ok(ControlGroups {
        groups,
        channel_groups,
        attributes,
    })
}

impl ControlGroups {
    /// Inspect deterministic selectable order without relying on alphabetical names or mesh traversal.
    pub fn groups(&self) -> &[ControlGroup] {
        &self.groups
    }

    /// Resolve a one-based fixture.element suffix, rejecting zero and out-of-range values.
    pub fn element(&self, element: u32) -> Option<&ControlGroup> {
        self.groups
            .get(usize::try_from(element.checked_sub(1)?).ok()?)
    }

    /// Return the selectable group index owning an instantiated channel.
    pub fn channel_group(&self, channel: usize) -> Option<usize> {
        self.channel_groups.get(channel).copied()
    }

    /// Return all exact attribute candidates within an element, including alternative functions on shared channels.
    /// Callers must apply activation and ambiguity policies before writing; this is not an output-selection algorithm.
    pub fn attribute_targets(&self, element: u32, attribute: &str) -> &[ControlTarget] {
        let Some(index) = element
            .checked_sub(1)
            .and_then(|index| usize::try_from(index).ok())
        else {
            return &[];
        };
        self.attributes
            .get(index)
            .and_then(|attributes| attributes.get(attribute))
            .map(Vec::as_slice)
            .unwrap_or_default()
    }
}
