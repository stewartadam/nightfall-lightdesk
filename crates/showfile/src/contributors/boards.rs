// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::borrow::Cow;

use bevy_ecs::prelude::Commands;
use nightfall::prelude::*;
use nightfall_engine::prelude::*;

use super::snapshot_values::sorted_provider_values;
use super::{ShowfileContribution, ShowfileLoadContributor, ShowfileSaveContributor};
use crate::{ShowfileLoadDomain, ShowfileLoadPhase};

/// Board definitions used as owned save output or borrowed load input.
pub(crate) struct BoardsSnapshot<'a> {
    pub(super) boards: Cow<'a, [Board]>,
}

/// Save contributor for board definitions.
pub(crate) struct BoardsSaveContributor<'a> {
    board_data_provider: &'a DataProvider<Board>,
}

impl<'a> BoardsSaveContributor<'a> {
    /// Build a contributor that snapshots board definitions.
    pub(crate) fn new(board_data_provider: &'a DataProvider<Board>) -> Self {
        Self {
            board_data_provider,
        }
    }
}

impl ShowfileSaveContributor for BoardsSaveContributor<'_> {
    /// Copy board definitions into their stable showfile field in ID order.
    fn save_contribution(&self) -> ShowfileContribution<'static> {
        ShowfileContribution::Boards(BoardsSnapshot {
            boards: Cow::Owned(sorted_provider_values(self.board_data_provider)),
        })
    }
}

/// Load contributor for board definitions.
pub(crate) struct BoardsLoadContributor<'a> {
    board_data_provider: &'a mut DataProvider<Board>,
}

impl<'a> BoardsLoadContributor<'a> {
    /// Build a contributor that restores board definitions.
    pub(crate) fn new(board_data_provider: &'a mut DataProvider<Board>) -> Self {
        Self {
            board_data_provider,
        }
    }
}

impl ShowfileLoadContributor for BoardsLoadContributor<'_> {
    /// Register boards as their own load domain.
    fn domain(&self) -> ShowfileLoadDomain {
        ShowfileLoadDomain::Boards
    }

    /// Replace the stored boards with the showfile's boards.
    fn contribute_load(
        &mut self,
        phase: ShowfileLoadPhase,
        contribution: &ShowfileContribution<'_>,
        _commands: &mut Commands,
    ) -> Result<(), String> {
        if !matches!(phase, ShowfileLoadPhase::ImportDefs) {
            return Ok(());
        }

        let ShowfileContribution::Boards(contribution) = contribution else {
            return Err("boards contributor received an incompatible showfile domain".to_string());
        };

        self.board_data_provider.clear();
        self.board_data_provider
            .extend(contribution.boards.to_vec());
        Ok(())
    }
}
