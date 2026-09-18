// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::borrow::Cow;

use bevy_ecs::prelude::Commands;
use nightfall::prelude::*;
use nightfall_cues::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_engine::prelude::*;

use super::snapshot_values::sorted_provider_values;
use super::{ShowfileContribution, ShowfileLoadContributor, ShowfileSaveContributor};
use crate::{ShowfileLoadDomain, ShowfileLoadPhase};

/// Cue structure state used as owned save output or borrowed load input.
pub(crate) struct CueStructureSnapshot<'a> {
    pub(super) cues: Cow<'a, [Cue]>,
    pub(super) sequences: Cow<'a, [Sequence]>,
    pub(super) groups: Cow<'a, [Group]>,
    pub(super) masters: Cow<'a, [Master]>,
    pub(super) blueprints: Cow<'a, [Blueprint]>,
}

/// Save contributor for cue, sequence, group, and blueprint definitions.
pub(crate) struct CueStructureSaveContributor<'a> {
    cue_data_provider: &'a DataProvider<Cue>,
    seq_data_provider: &'a DataProvider<Sequence>,
    group_data_provider: &'a DataProvider<Group>,
    master_data_provider: &'a DataProvider<Master>,
    blueprint_data_provider: &'a DataProvider<Blueprint>,
}

impl<'a> CueStructureSaveContributor<'a> {
    /// Build a contributor that snapshots cue structure definitions.
    pub(crate) fn new(
        cue_data_provider: &'a DataProvider<Cue>,
        seq_data_provider: &'a DataProvider<Sequence>,
        group_data_provider: &'a DataProvider<Group>,
        master_data_provider: &'a DataProvider<Master>,
        blueprint_data_provider: &'a DataProvider<Blueprint>,
    ) -> Self {
        Self {
            cue_data_provider,
            seq_data_provider,
            group_data_provider,
            master_data_provider,
            blueprint_data_provider,
        }
    }
}

impl ShowfileSaveContributor for CueStructureSaveContributor<'_> {
    /// Copy cue structure definitions into their stable showfile fields.
    fn save_contribution(&self) -> ShowfileContribution<'static> {
        ShowfileContribution::CueStructure(CueStructureSnapshot {
            cues: Cow::Owned(sorted_provider_values(self.cue_data_provider)),
            sequences: Cow::Owned(sorted_provider_values(self.seq_data_provider)),
            groups: Cow::Owned(sorted_provider_values(self.group_data_provider)),
            masters: Cow::Owned(sorted_provider_values(self.master_data_provider)),
            blueprints: Cow::Owned(sorted_provider_values(self.blueprint_data_provider)),
        })
    }
}

/// Load contributor for cue, sequence, group, and blueprint definitions.
pub(crate) struct CueStructureLoadContributor<'a> {
    cue_data_provider: &'a mut DataProvider<Cue>,
    seq_data_provider: &'a mut DataProvider<Sequence>,
    group_data_provider: &'a mut DataProvider<Group>,
    master_data_provider: &'a mut DataProvider<Master>,
    blueprint_data_provider: &'a mut DataProvider<Blueprint>,
}

impl<'a> CueStructureLoadContributor<'a> {
    /// Build a contributor that restores cue structure definitions.
    pub(crate) fn new(
        cue_data_provider: &'a mut DataProvider<Cue>,
        seq_data_provider: &'a mut DataProvider<Sequence>,
        group_data_provider: &'a mut DataProvider<Group>,
        master_data_provider: &'a mut DataProvider<Master>,
        blueprint_data_provider: &'a mut DataProvider<Blueprint>,
    ) -> Self {
        Self {
            cue_data_provider,
            seq_data_provider,
            group_data_provider,
            master_data_provider,
            blueprint_data_provider,
        }
    }
}

impl ShowfileLoadContributor for CueStructureLoadContributor<'_> {
    /// Register cue structure as its own load domain.
    fn domain(&self) -> ShowfileLoadDomain {
        ShowfileLoadDomain::CueStructure
    }

    /// Import cue structure definitions during the definition import phase.
    fn contribute_load(
        &mut self,
        phase: ShowfileLoadPhase,
        contribution: &ShowfileContribution<'_>,
        _commands: &mut Commands,
    ) -> Result<(), String> {
        if !matches!(phase, ShowfileLoadPhase::ImportDefs) {
            return Ok(());
        }

        let ShowfileContribution::CueStructure(contribution) = contribution else {
            return Err(
                "cue structure contributor received an incompatible showfile domain".to_string(),
            );
        };

        self.cue_data_provider.extend(contribution.cues.to_vec());
        self.seq_data_provider
            .extend(contribution.sequences.to_vec());
        self.group_data_provider
            .extend(contribution.groups.to_vec());
        self.master_data_provider
            .extend(contribution.masters.to_vec());
        self.blueprint_data_provider
            .extend(contribution.blueprints.to_vec());

        Ok(())
    }
}
