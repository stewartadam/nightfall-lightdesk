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

/// Macro definitions used as owned save output or borrowed load input.
pub(crate) struct MacrosSnapshot<'a> {
    pub(super) macros: Cow<'a, [Macro]>,
}

/// Save contributor for macro definitions.
pub(crate) struct MacrosSaveContributor<'a> {
    macro_data_provider: &'a DataProvider<Macro>,
}

impl<'a> MacrosSaveContributor<'a> {
    /// Build a contributor that snapshots macro definitions.
    pub(crate) fn new(macro_data_provider: &'a DataProvider<Macro>) -> Self {
        Self {
            macro_data_provider,
        }
    }
}

impl ShowfileSaveContributor for MacrosSaveContributor<'_> {
    /// Copy macro definitions into their stable showfile field in ID order.
    fn save_contribution(&self) -> ShowfileContribution<'static> {
        ShowfileContribution::Macros(MacrosSnapshot {
            macros: Cow::Owned(sorted_provider_values(self.macro_data_provider)),
        })
    }
}

/// Load contributor for macro definitions.
pub(crate) struct MacrosLoadContributor<'a> {
    macro_data_provider: &'a mut DataProvider<Macro>,
}

impl<'a> MacrosLoadContributor<'a> {
    /// Build a contributor that restores macro definitions.
    pub(crate) fn new(macro_data_provider: &'a mut DataProvider<Macro>) -> Self {
        Self {
            macro_data_provider,
        }
    }
}

impl ShowfileLoadContributor for MacrosLoadContributor<'_> {
    /// Register macros as their own load domain.
    fn domain(&self) -> ShowfileLoadDomain {
        ShowfileLoadDomain::Macros
    }

    /// Replace the stored macros with the showfile's macros.
    fn contribute_load(
        &mut self,
        phase: ShowfileLoadPhase,
        contribution: &ShowfileContribution<'_>,
        _commands: &mut Commands,
    ) -> Result<(), String> {
        if !matches!(phase, ShowfileLoadPhase::ImportDefs) {
            return Ok(());
        }

        let ShowfileContribution::Macros(contribution) = contribution else {
            return Err("macros contributor received an incompatible showfile domain".to_string());
        };

        self.macro_data_provider.clear();
        self.macro_data_provider
            .extend(contribution.macros.to_vec());
        Ok(())
    }
}
