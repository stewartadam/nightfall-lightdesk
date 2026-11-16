// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::borrow::Cow;

use bevy_ecs::message::Messages;
use bevy_ecs::prelude::{Commands, World};
use nightfall_engine::prelude::{ToastLevel, UiNotification};
use nightfall_fixtures::prelude::FixtureDataProviderExt;
use nightfall_park::prelude::{ParkedParameter, ParkedParameters};

use super::{ShowfileContribution, ShowfileLoadContributor, ShowfileSaveContributor};
use crate::{ShowfileLoadDomain, ShowfileLoadPhase};

/// Parked parameters used as owned save output or borrowed load input.
pub(crate) struct ParkSnapshot<'a> {
    pub(super) parked: Cow<'a, [ParkedParameter]>,
}

/// Save contributor for parked parameters.
pub(crate) struct ParkSaveContributor<'a> {
    parked: Option<&'a ParkedParameters>,
    fixtures: &'a FixtureDataProviderExt,
}

impl<'a> ParkSaveContributor<'a> {
    /// Build a contributor that snapshots parked parameters, saving none in hosts without park.
    pub(crate) fn new(
        parked: Option<&'a ParkedParameters>,
        fixtures: &'a FixtureDataProviderExt,
    ) -> Self {
        Self { parked, fixtures }
    }
}

impl ShowfileSaveContributor for ParkSaveContributor<'_> {
    /// Copy the parked parameters of fixtures in the show, ordered by fixture, element and
    /// attribute.
    ///
    /// A deleted fixture's entries stay parked while the show is open, so undoing the delete
    /// brings the fixture back parked, but they are not saved.
    fn save_contribution(&self) -> ShowfileContribution<'static> {
        let parked = self
            .parked
            .map(ParkedParameters::entries)
            .unwrap_or_default()
            .into_iter()
            .filter(|entry| self.fixtures.inner.get(entry.element.fixture_uid).is_ok())
            .collect::<Vec<_>>();
        ShowfileContribution::Park(ParkSnapshot {
            parked: Cow::Owned(parked),
        })
    }
}

/// Load contributor for parked parameters.
pub(crate) struct ParkLoadContributor<'a> {
    parked: Option<&'a mut ParkedParameters>,
}

impl<'a> ParkLoadContributor<'a> {
    /// Build a contributor that restores parked parameters, ignoring them in hosts without park.
    pub(crate) fn new(parked: Option<&'a mut ParkedParameters>) -> Self {
        Self { parked }
    }
}

impl ShowfileLoadContributor for ParkLoadContributor<'_> {
    /// Register parked parameters as their own load domain.
    fn domain(&self) -> ShowfileLoadDomain {
        ShowfileLoadDomain::Park
    }

    /// Replace the parked set with the showfile's parked parameters, and warn clients when the
    /// show opens with parameters parked, since they ignore playback until unparked.
    ///
    /// Loading the set that is already parked, as an import does, changes nothing and doesn't
    /// warn again.
    fn contribute_load(
        &mut self,
        phase: ShowfileLoadPhase,
        contribution: &ShowfileContribution<'_>,
        commands: &mut Commands,
    ) -> Result<(), String> {
        if !matches!(phase, ShowfileLoadPhase::ImportDefs) {
            return Ok(());
        }

        let ShowfileContribution::Park(contribution) = contribution else {
            return Err("park contributor received an incompatible showfile domain".to_string());
        };
        let Some(parked) = self.parked.as_deref_mut() else {
            return Ok(());
        };
        let loaded = ParkedParameters::from_entries(contribution.parked.iter().cloned());
        if *parked == loaded {
            return Ok(());
        }
        *parked = loaded;
        if !parked.is_empty() {
            let message = parked_on_load_message(parked.len());
            commands.queue(move |world: &mut World| {
                if world.contains_resource::<Messages<UiNotification>>() {
                    world.write_message(UiNotification::toast(ToastLevel::Warning, message));
                }
            });
        }
        Ok(())
    }
}

/// Describes the parked parameters a show opened with.
fn parked_on_load_message(count: usize) -> String {
    let parameters = if count == 1 {
        "1 parked parameter".to_string()
    } else {
        format!("{count} parked parameters")
    };
    format!("This show has {parameters}. They hold their values until you unpark them.")
}
