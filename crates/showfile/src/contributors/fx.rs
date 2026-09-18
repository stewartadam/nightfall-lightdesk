// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::borrow::Cow;

use bevy_ecs::prelude::{Commands, Query};
use nightfall_engine::prelude::*;
use nightfall_fx::prelude::*;

use super::snapshot_values::sorted_provider_values;
use super::{ShowfileContribution, ShowfileLoadContributor, ShowfileSaveContributor};
use crate::{ShowfileLoadDomain, ShowfileLoadPhase};

/// FX state used as owned save output or borrowed load input.
pub(crate) struct FxSnapshot<'a> {
    pub(super) fx: Cow<'a, [Fx]>,
    pub(super) fx_module: Cow<'a, [StoredFxModule]>,
    pub(super) step_fx: Cow<'a, [StepFx]>,
}

/// Save contributor for FX definitions and ECS-backed step FX.
pub(crate) struct FxSaveContributor<'a, 'w, 's> {
    fx_data_provider: &'a DataProvider<Fx>,
    fx_module_data_provider: &'a DataProvider<StoredFxModule>,
    step_fx_query: &'a Query<'w, 's, &'static StepFx>,
}

impl<'a, 'w, 's> FxSaveContributor<'a, 'w, 's> {
    /// Build a contributor that snapshots FX definitions and step FX runtime data.
    pub(crate) fn new(
        fx_data_provider: &'a DataProvider<Fx>,
        fx_module_data_provider: &'a DataProvider<StoredFxModule>,
        step_fx_query: &'a Query<'w, 's, &'static StepFx>,
    ) -> Self {
        Self {
            fx_data_provider,
            fx_module_data_provider,
            step_fx_query,
        }
    }
}

impl ShowfileSaveContributor for FxSaveContributor<'_, '_, '_> {
    /// Copy FX definitions and step FX into their stable showfile fields.
    fn save_contribution(&self) -> ShowfileContribution<'static> {
        let mut step_fx: Vec<_> = self.step_fx_query.iter().cloned().collect();
        step_fx.sort_by_key(|a| a.identifiers.id);

        ShowfileContribution::Fx(FxSnapshot {
            fx: Cow::Owned(sorted_provider_values(self.fx_data_provider)),
            fx_module: Cow::Owned(sorted_provider_values(self.fx_module_data_provider)),
            step_fx: Cow::Owned(step_fx),
        })
    }
}

/// Load contributor for FX definitions and ECS-backed step FX.
pub(crate) struct FxLoadContributor<'a> {
    fx_data_provider: &'a mut DataProvider<Fx>,
    fx_module_data_provider: &'a mut DataProvider<StoredFxModule>,
}

impl<'a> FxLoadContributor<'a> {
    /// Build a contributor that restores FX definitions and step FX runtime data.
    pub(crate) fn new(
        fx_data_provider: &'a mut DataProvider<Fx>,
        fx_module_data_provider: &'a mut DataProvider<StoredFxModule>,
    ) -> Self {
        Self {
            fx_data_provider,
            fx_module_data_provider,
        }
    }
}

impl ShowfileLoadContributor for FxLoadContributor<'_> {
    /// Register FX as its own load domain.
    fn domain(&self) -> ShowfileLoadDomain {
        ShowfileLoadDomain::Fx
    }

    /// Import FX definitions and materialize step FX in the runtime phase.
    fn contribute_load(
        &mut self,
        phase: ShowfileLoadPhase,
        contribution: &ShowfileContribution<'_>,
        commands: &mut Commands,
    ) -> Result<(), String> {
        let ShowfileContribution::Fx(contribution) = contribution else {
            return Err("fx contributor received an incompatible showfile domain".to_string());
        };

        match phase {
            ShowfileLoadPhase::ImportDefs => {
                self.fx_data_provider.extend(contribution.fx.to_vec());
                self.fx_module_data_provider
                    .extend(contribution.fx_module.to_vec());
            }
            ShowfileLoadPhase::ResolveLinks => {}
            ShowfileLoadPhase::MaterializeRuntime => {
                for step_fx in contribution.step_fx.iter() {
                    commands.spawn(step_fx.clone());
                }
            }
        }

        Ok(())
    }
}
