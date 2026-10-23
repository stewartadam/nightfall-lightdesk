// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::borrow::Cow;

use bevy_ecs::prelude::Commands;
use nightfall::prelude::*;
use nightfall_fixtures::library::instantiate::add_fixture_parameters;
use nightfall_fixtures::library::normalize_fixture_profile;
use nightfall_fixtures::prelude::*;
#[cfg(feature = "midi")]
use nightfall_input_midi::prelude::*;
#[cfg(feature = "osc")]
use nightfall_input_osc::prelude::*;

use super::{ShowfileContribution, ShowfileLoadContributor, ShowfileSaveContributor};
use crate::{RoutesSnapshot, ShowfileLoadDomain, ShowfileLoadPhase};

/// Fixture patch state used as owned save output or borrowed load input.
pub(crate) struct FixturesPatchSnapshot<'a> {
    pub(super) fixtures: Cow<'a, [Fixture]>,
    pub(super) color_path_defaults: Cow<'a, [ColorPathDefault]>,
    pub(super) routes: Cow<'a, RoutesSnapshot>,
    #[cfg(feature = "midi")]
    pub(super) midi_mappings: Cow<'a, [MidiMapping]>,
    #[cfg(feature = "midi")]
    pub(super) midi_feedback_devices: Cow<'a, [MidiFeedbackSetting]>,
    #[cfg(feature = "osc")]
    pub(super) osc_mappings: Cow<'a, [OscMapping]>,
}

/// Save contributor for fixture patch data and input/output routes.
pub(crate) struct FixturesPatchSaveContributor<'a> {
    fixture_data_provider: &'a FixtureDataProviderExt,
    input_routes: &'a InputRoutes,
    output_routes: &'a OutputRoutes,
    disabled_routes: &'a DisabledRoutes,
    #[cfg(feature = "midi")]
    midi_mappings: &'a MidiMappings,
    #[cfg(feature = "osc")]
    osc_mappings: &'a OscMappings,
}

impl<'a> FixturesPatchSaveContributor<'a> {
    /// Build a contributor that snapshots fixtures, DMX routes, and IO mappings.
    pub(crate) fn new(
        fixture_data_provider: &'a FixtureDataProviderExt,
        input_routes: &'a InputRoutes,
        output_routes: &'a OutputRoutes,
        disabled_routes: &'a DisabledRoutes,
        #[cfg(feature = "midi")] midi_mappings: &'a MidiMappings,
        #[cfg(feature = "osc")] osc_mappings: &'a OscMappings,
    ) -> Self {
        Self {
            fixture_data_provider,
            input_routes,
            output_routes,
            disabled_routes,
            #[cfg(feature = "midi")]
            midi_mappings,
            #[cfg(feature = "osc")]
            osc_mappings,
        }
    }
}

impl ShowfileSaveContributor for FixturesPatchSaveContributor<'_> {
    /// Copy fixture patch state into the stable showfile fixture and route fields.
    fn save_contribution(&self) -> ShowfileContribution<'static> {
        let mut fixtures: Vec<_> = self
            .fixture_data_provider
            .inner
            .iter()
            .map(|entry| (*entry.value()).clone())
            .collect();
        fixtures.sort_by_key(|a| a.identifiers.id);

        ShowfileContribution::FixturesPatch(FixturesPatchSnapshot {
            fixtures: Cow::Owned(fixtures),
            color_path_defaults: Cow::Owned(Vec::new()),
            routes: Cow::Owned(RoutesSnapshot {
                input: self.input_routes.routes.clone(),
                output: self.output_routes.routes.clone(),
                disabled: self.disabled_routes.routes.clone(),
            }),
            #[cfg(feature = "midi")]
            midi_mappings: Cow::Owned(self.midi_mappings.mappings().to_vec()),
            #[cfg(feature = "midi")]
            midi_feedback_devices: Cow::Owned(
                self.midi_mappings.feedback_devices().settings().collect(),
            ),
            #[cfg(feature = "osc")]
            osc_mappings: Cow::Owned(self.osc_mappings.mappings().to_vec()),
        })
    }
}

/// Load contributor for fixture patch data and input/output routes.
pub(crate) struct FixturesPatchLoadContributor<'a> {
    fixture_data_provider: &'a mut FixtureDataProviderExt,
    input_routes: &'a mut InputRoutes,
    output_routes: &'a mut OutputRoutes,
    disabled_routes: &'a mut DisabledRoutes,
    #[cfg(feature = "midi")]
    midi_mappings: &'a mut MidiMappings,
    #[cfg(feature = "osc")]
    osc_mappings: &'a mut OscMappings,
}

impl<'a> FixturesPatchLoadContributor<'a> {
    /// Build a contributor that restores fixtures, DMX routes, and IO mappings.
    pub(crate) fn new(
        fixture_data_provider: &'a mut FixtureDataProviderExt,
        input_routes: &'a mut InputRoutes,
        output_routes: &'a mut OutputRoutes,
        disabled_routes: &'a mut DisabledRoutes,
        #[cfg(feature = "midi")] midi_mappings: &'a mut MidiMappings,
        #[cfg(feature = "osc")] osc_mappings: &'a mut OscMappings,
    ) -> Self {
        Self {
            fixture_data_provider,
            input_routes,
            output_routes,
            disabled_routes,
            #[cfg(feature = "midi")]
            midi_mappings,
            #[cfg(feature = "osc")]
            osc_mappings,
        }
    }

    /// Spawn runtime parameter entities for all fixture elements in a loaded snapshot.
    fn materialize_fixture_parameters(
        &mut self,
        contribution: &FixturesPatchSnapshot<'_>,
        commands: &mut Commands,
    ) {
        for stored_fixture in contribution.fixtures.iter() {
            let mut fixture = stored_fixture.clone();
            normalize_fixture_profile(&mut fixture);
            add_fixture_parameters(commands, self.fixture_data_provider, &fixture);
        }
    }
}

impl ShowfileLoadContributor for FixturesPatchLoadContributor<'_> {
    /// Register fixtures and routes as the fixture patch load domain.
    fn domain(&self) -> ShowfileLoadDomain {
        ShowfileLoadDomain::FixturesPatch
    }

    /// Apply fixture patch work during import and materialization phases.
    fn contribute_load(
        &mut self,
        phase: ShowfileLoadPhase,
        contribution: &ShowfileContribution<'_>,
        commands: &mut Commands,
    ) -> Result<(), String> {
        let ShowfileContribution::FixturesPatch(contribution) = contribution else {
            return Err(
                "fixtures patch contributor received an incompatible showfile domain".to_string(),
            );
        };

        match phase {
            ShowfileLoadPhase::ImportDefs => {
                for stored_fixture in contribution.fixtures.iter() {
                    let mut fixture = stored_fixture.clone();
                    normalize_fixture_profile(&mut fixture);
                    if let Err(error) = self.fixture_data_provider.inner.add(fixture.clone()) {
                        tracing::warn!("Failed to load fixture from showfile: {}", error);
                    }
                }

                self.input_routes.routes = contribution.routes.input.clone();
                self.output_routes.routes = contribution.routes.output.clone();
                self.disabled_routes.routes = contribution.routes.disabled.clone();
                self.fixture_data_provider
                    .replace_color_path_defaults(contribution.color_path_defaults.to_vec());
                #[cfg(feature = "midi")]
                {
                    self.midi_mappings
                        .set_mappings(contribution.midi_mappings.to_vec());
                    self.midi_mappings
                        .set_feedback_devices(MidiFeedbackDevices::new(
                            contribution.midi_feedback_devices.iter().cloned(),
                        ));
                }
                #[cfg(feature = "osc")]
                self.osc_mappings
                    .set_mappings(contribution.osc_mappings.to_vec());
            }
            ShowfileLoadPhase::ResolveLinks => {}
            ShowfileLoadPhase::MaterializeRuntime => {
                self.materialize_fixture_parameters(contribution, commands);
            }
        }

        Ok(())
    }
}
