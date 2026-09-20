// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{borrow::Cow, collections::HashMap};

use bevy_ecs::prelude::Commands;
use nightfall::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_io::IoRuntimeSettings;

use super::{ShowfileContribution, ShowfileLoadContributor, ShowfileSaveContributor};
use crate::{ShowfileLoadDomain, ShowfileLoadPhase};

/// Desk-level state used as owned save output or borrowed load input.
pub(crate) struct DeskStateSnapshot<'a> {
    pub(super) variables: Cow<'a, HashMap<String, VariableValue>>,
    pub(super) control_assignments: Cow<'a, Vec<Option<ControlAssignment>>>,
    pub(super) settings: Cow<'a, DeskSettings>,
    pub(super) io_settings: Cow<'a, IoRuntimeSettings>,
}

/// Save contributor for desk-level settings and global variables.
pub(crate) struct DeskStateSaveContributor<'a> {
    global_variables: &'a GlobalVariables,
    controls: &'a Controls,
    desk_settings: &'a DeskSettings,
    io_settings: &'a IoRuntimeSettings,
}

impl<'a> DeskStateSaveContributor<'a> {
    /// Build a contributor that copies the current desk state into a save snapshot.
    pub(crate) fn new(
        global_variables: &'a GlobalVariables,
        controls: &'a Controls,
        desk_settings: &'a DeskSettings,
        io_settings: &'a IoRuntimeSettings,
    ) -> Self {
        Self {
            global_variables,
            controls,
            desk_settings,
            io_settings,
        }
    }
}

impl ShowfileSaveContributor for DeskStateSaveContributor<'_> {
    /// Copy global variables and desk settings into their stable showfile fields.
    fn save_contribution(&self) -> ShowfileContribution<'static> {
        ShowfileContribution::DeskState(DeskStateSnapshot {
            control_assignments: Cow::Owned(self.controls.assignments()),
            variables: Cow::Owned(self.global_variables.get_all()),
            settings: Cow::Owned(self.desk_settings.clone()),
            io_settings: Cow::Owned(self.io_settings.clone()),
        })
    }
}

/// Load contributor for desk-level settings and global variables.
pub(crate) struct DeskStateLoadContributor<'a> {
    global_variables: &'a GlobalVariables,
    desk_settings: &'a mut DeskSettings,
    io_settings: &'a mut IoRuntimeSettings,
}

impl<'a> DeskStateLoadContributor<'a> {
    /// Build a contributor that restores the runtime desk state from a snapshot.
    pub(crate) fn new(
        global_variables: &'a GlobalVariables,
        desk_settings: &'a mut DeskSettings,
        io_settings: &'a mut IoRuntimeSettings,
    ) -> Self {
        Self {
            global_variables,
            desk_settings,
            io_settings,
        }
    }
}

impl ShowfileLoadContributor for DeskStateLoadContributor<'_> {
    /// Register desk state as its own phase-aware load domain.
    fn domain(&self) -> ShowfileLoadDomain {
        ShowfileLoadDomain::DeskState
    }

    /// Import serialized desk state during the definition import phase.
    fn contribute_load(
        &mut self,
        phase: ShowfileLoadPhase,
        contribution: &ShowfileContribution<'_>,
        commands: &mut Commands,
    ) -> Result<(), String> {
        if !matches!(phase, ShowfileLoadPhase::ImportDefs) {
            return Ok(());
        }

        let ShowfileContribution::DeskState(contribution) = contribution else {
            return Err(
                "desk state contributor received an incompatible showfile domain".to_string(),
            );
        };

        for (key, value) in contribution.variables.iter() {
            self.global_variables.set(key, value.clone());
        }

        commands.insert_resource(Controls::from_assignments(
            &contribution.control_assignments,
        ));
        *self.desk_settings = contribution.settings.clone().into_owned();
        *self.io_settings = contribution.io_settings.clone().into_owned();

        Ok(())
    }
}
