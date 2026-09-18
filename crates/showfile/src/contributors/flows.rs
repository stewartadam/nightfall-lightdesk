// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::borrow::Cow;

use bevy_ecs::prelude::Commands;
use nightfall_engine::prelude::*;
use nightfall_flow::prelude::*;

use super::snapshot_values::sorted_provider_values;
use super::{ShowfileContribution, ShowfileLoadContributor, ShowfileSaveContributor};
use crate::{ShowfileLoadDomain, ShowfileLoadPhase};

/// Flow state used as owned save output or borrowed load input.
pub(crate) struct FlowsSnapshot<'a> {
    pub(super) flows: Cow<'a, [FlowDefinition]>,
}

/// Save contributor for flow definitions.
pub(crate) struct FlowsSaveContributor<'a> {
    flow_data_provider: &'a DataProvider<FlowDefinition>,
}

impl<'a> FlowsSaveContributor<'a> {
    /// Build a contributor that snapshots flow definitions.
    pub(crate) fn new(flow_data_provider: &'a DataProvider<FlowDefinition>) -> Self {
        Self { flow_data_provider }
    }
}

impl ShowfileSaveContributor for FlowsSaveContributor<'_> {
    /// Copy flow definitions into their stable showfile field.
    fn save_contribution(&self) -> ShowfileContribution<'static> {
        ShowfileContribution::Flows(FlowsSnapshot {
            flows: Cow::Owned(sorted_provider_values(self.flow_data_provider)),
        })
    }
}

/// Load contributor for flow definitions.
pub(crate) struct FlowsLoadContributor<'a> {
    flow_data_provider: &'a mut DataProvider<FlowDefinition>,
}

impl<'a> FlowsLoadContributor<'a> {
    /// Build a contributor that restores flow definitions.
    pub(crate) fn new(flow_data_provider: &'a mut DataProvider<FlowDefinition>) -> Self {
        Self { flow_data_provider }
    }
}

impl ShowfileLoadContributor for FlowsLoadContributor<'_> {
    /// Register flows as their own load domain.
    fn domain(&self) -> ShowfileLoadDomain {
        ShowfileLoadDomain::Flows
    }

    /// Import flow definitions during the definition import phase.
    fn contribute_load(
        &mut self,
        phase: ShowfileLoadPhase,
        contribution: &ShowfileContribution<'_>,
        _commands: &mut Commands,
    ) -> Result<(), String> {
        if !matches!(phase, ShowfileLoadPhase::ImportDefs) {
            return Ok(());
        }

        let ShowfileContribution::Flows(contribution) = contribution else {
            return Err("flows contributor received an incompatible showfile domain".to_string());
        };

        self.flow_data_provider.extend(contribution.flows.to_vec());

        Ok(())
    }
}
