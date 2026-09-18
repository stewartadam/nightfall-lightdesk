// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Stable group-reference normalization for complete showfile snapshots.

use std::collections::HashMap;

use nightfall::prelude::*;
use nightfall_cues::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_flow::prelude::*;
use nightfall_selection::{
    SelectionDataSource, SelectionFixture, SelectionGroup, SelectionResolver,
};
use uuid::Uuid;

use crate::ShowfileSnapshot;

/// Owned group lookup data used while normalizing a mutable showfile snapshot.
struct SnapshotGroupDataSource {
    groups_by_uid: HashMap<Uuid, SelectionGroup>,
    group_uid_by_id: HashMap<u32, Uuid>,
    group_uid_by_label: HashMap<String, Uuid>,
}

impl SnapshotGroupDataSource {
    /// Build stable group indexes from the definitions carried by one snapshot.
    fn new(groups: &[Group]) -> Self {
        let groups_by_uid = groups
            .iter()
            .map(|group| {
                (
                    group.identifiers.uid,
                    SelectionGroup {
                        uid: group.identifiers.uid,
                        id: group.identifiers.id,
                        label: group.identifiers.label.clone(),
                        selection: group.selection.clone(),
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        let group_uid_by_id = groups
            .iter()
            .map(|group| (group.identifiers.id, group.identifiers.uid))
            .collect();
        let group_uid_by_label = groups
            .iter()
            .map(|group| (group.identifiers.label.clone(), group.identifiers.uid))
            .collect();

        Self {
            groups_by_uid,
            group_uid_by_id,
            group_uid_by_label,
        }
    }
}

impl SelectionDataSource for SnapshotGroupDataSource {
    /// Snapshot normalization does not resolve fixture aliases.
    fn fixture_by_id(&self, _fixture_id: u32) -> Option<SelectionFixture> {
        None
    }

    /// Snapshot normalization does not resolve fixture references.
    fn fixture_by_ref(&self, _fixture_ref: &FixtureRef) -> Option<SelectionFixture> {
        None
    }

    /// Reports that the snapshot-backed group indexes are available.
    fn groups_available(&self) -> bool {
        true
    }

    /// Looks up one snapshot group by stable UID.
    fn group_by_uid(&self, uid: Uuid) -> Option<SelectionGroup> {
        self.groups_by_uid.get(&uid).cloned()
    }

    /// Looks up one snapshot group by user-facing numeric ID.
    fn group_by_id(&self, group_id: u32) -> Option<SelectionGroup> {
        self.group_uid_by_id
            .get(&group_id)
            .and_then(|uid| self.group_by_uid(*uid))
    }

    /// Looks up one snapshot group by exact label.
    fn group_by_label(&self, label: &str) -> Option<SelectionGroup> {
        self.group_uid_by_label
            .get(label)
            .and_then(|uid| self.group_by_uid(*uid))
    }
}

/// Normalize authored group aliases across every selection-bearing showfile object.
pub fn stabilize_showfile_group_refs(snapshot: &mut ShowfileSnapshot) -> Vec<String> {
    let data_source = SnapshotGroupDataSource::new(&snapshot.groups);
    let resolver = SelectionResolver::new(&data_source);
    let mut warnings = Vec::new();

    for cue in &mut snapshot.cues {
        stabilize_cue_group_refs(cue, &resolver, &mut warnings);
    }
    for sequence in &mut snapshot.sequences {
        stabilize_cue_group_refs(&mut sequence.setup_cue, &resolver, &mut warnings);
        stabilize_cue_group_refs(&mut sequence.release_cue, &resolver, &mut warnings);
    }
    for group in &mut snapshot.groups {
        stabilize_spatial_group_refs(&mut group.selection, &resolver, &mut warnings);
    }
    for master in &mut snapshot.masters {
        if let MasterTarget::Fixtures(FixtureMasterTarget::Selection(selection)) =
            &mut master.target
        {
            stabilize_spatial_group_refs(selection, &resolver, &mut warnings);
        }
    }
    for fx in &mut snapshot.fx {
        stabilize_spatial_group_refs(&mut fx.selection, &resolver, &mut warnings);
    }
    for fx_module in &mut snapshot.fx_module {
        stabilize_spatial_group_refs(&mut fx_module.selection, &resolver, &mut warnings);
    }
    for step_fx in &mut snapshot.step_fx {
        stabilize_spatial_group_refs(&mut step_fx.selection, &resolver, &mut warnings);
    }
    for flow in &mut snapshot.flows {
        stabilize_flow_group_refs(flow, &resolver, &mut warnings);
    }

    warnings
}

/// Normalize group aliases stored in cue and cue-part instructions.
fn stabilize_cue_group_refs(
    cue: &mut Cue,
    resolver: &SelectionResolver<'_>,
    warnings: &mut Vec<String>,
) {
    for instruction in &mut cue.instructions {
        stabilize_spatial_group_refs(&mut instruction.selection, resolver, warnings);
    }
    for part in &mut cue.parts {
        for instruction in &mut part.instructions {
            stabilize_spatial_group_refs(&mut instruction.selection, resolver, warnings);
        }
    }
}

/// Normalize group aliases stored in flow port default values.
fn stabilize_flow_group_refs(
    flow: &mut FlowDefinition,
    resolver: &SelectionResolver<'_>,
    warnings: &mut Vec<String>,
) {
    for node in &mut flow.nodes {
        for port in &mut node.ports {
            if let Some(FlowValue::Selection(selection)) = &mut port.default_value {
                stabilize_spatial_group_refs(selection, resolver, warnings);
            }
        }
    }
}

/// Replace resolvable authored aliases in one spatial selection and collect warnings.
fn stabilize_spatial_group_refs(
    selection: &mut SpatialSelection,
    resolver: &SelectionResolver<'_>,
    warnings: &mut Vec<String>,
) {
    let stabilized = resolver.stabilize_group_refs_selection(selection);
    warnings.extend(stabilized.issues);
    *selection = stabilized.value;
}
