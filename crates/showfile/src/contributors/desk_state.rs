// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    borrow::Cow,
    collections::{BTreeMap, HashMap},
};

use bevy_ecs::prelude::{Commands, World};
use nightfall::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_tempo::prelude::*;
use serde_json::Value;

use super::{ShowfileContribution, ShowfileLoadContributor, ShowfileSaveContributor};
use crate::{ShowfileLoadDomain, ShowfileLoadPhase};

/// Desk-level state used as owned save output or borrowed load input.
pub(crate) struct DeskStateSnapshot<'a> {
    pub(super) variables: Cow<'a, HashMap<String, VariableValue>>,
    pub(super) faders: Cow<'a, [FaderConfig]>,
    pub(super) settings: Cow<'a, BTreeMap<String, Value>>,
    pub(super) tempo: Cow<'a, TempoSettings>,
}

/// Save contributor for settings sections, faders, tempo and global variables.
pub(crate) struct DeskStateSaveContributor<'a> {
    global_variables: &'a GlobalVariables,
    faders: &'a Faders,
    settings: Option<&'a SettingsValues>,
    tempo: Option<&'a ShowTempo>,
}

impl<'a> DeskStateSaveContributor<'a> {
    /// Build a contributor that copies the current desk state into a save snapshot.
    pub(crate) fn new(
        global_variables: &'a GlobalVariables,
        faders: &'a Faders,
        settings: Option<&'a SettingsValues>,
        tempo: Option<&'a ShowTempo>,
    ) -> Self {
        Self {
            global_variables,
            faders,
            settings,
            tempo,
        }
    }
}

impl ShowfileSaveContributor for DeskStateSaveContributor<'_> {
    /// Copy global variables, faders, tempo and every settings section in its saved form into
    /// their stable showfile fields.
    fn save_contribution(&self) -> ShowfileContribution<'static> {
        ShowfileContribution::DeskState(Box::new(DeskStateSnapshot {
            faders: Cow::Owned(self.faders.fader_configs()),
            variables: Cow::Owned(self.global_variables.get_all()),
            settings: Cow::Owned(self.settings.map(SettingsValues::saved).unwrap_or_default()),
            tempo: Cow::Owned(self.tempo.map(ShowTempo::settings).unwrap_or_default()),
        }))
    }
}

/// Load contributor for settings sections, faders, tempo and global variables.
pub(crate) struct DeskStateLoadContributor<'a> {
    global_variables: &'a GlobalVariables,
}

impl<'a> DeskStateLoadContributor<'a> {
    /// Build a contributor that restores the runtime desk state from a snapshot.
    pub(crate) fn new(global_variables: &'a GlobalVariables) -> Self {
        Self { global_variables }
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

        commands.insert_resource(Faders::from_configs(&contribution.faders));
        let settings = contribution.settings.clone().into_owned();
        let tempo = contribution.tempo.clone().into_owned();
        commands.queue(move |world: &mut World| {
            load_saved_settings(world, &settings);
            world.get_resource_or_init::<ShowTempo>().restore(&tempo);
        });

        Ok(())
    }
}
