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
use nightfall_fixtures::prelude::FixtureDataProviderExt;

use super::snapshot_values::sorted_provider_values;
use super::{ShowfileContribution, ShowfileLoadContributor, ShowfileSaveContributor};
use crate::{ShowfileLoadDomain, ShowfileLoadPhase};

/// Color path state used as owned save output or borrowed load input.
pub(crate) struct ColorPathsSnapshot<'a> {
    pub(super) color_paths: Cow<'a, [ColorPath]>,
    pub(super) color_path_defaults: Cow<'a, [ColorPathDefault]>,
}

/// Save contributor for color path definitions and fixture default assignments.
pub(crate) struct ColorPathsSaveContributor<'a> {
    color_path_data_provider: &'a DataProvider<ColorPath>,
    fixture_data_provider: &'a FixtureDataProviderExt,
}

impl<'a> ColorPathsSaveContributor<'a> {
    /// Build a contributor that snapshots color path definitions and defaults.
    pub(crate) fn new(
        color_path_data_provider: &'a DataProvider<ColorPath>,
        fixture_data_provider: &'a FixtureDataProviderExt,
    ) -> Self {
        Self {
            color_path_data_provider,
            fixture_data_provider,
        }
    }
}

impl ShowfileSaveContributor for ColorPathsSaveContributor<'_> {
    /// Copy color path definitions and fixture defaults into their stable showfile fields.
    fn save_contribution(&self) -> ShowfileContribution<'static> {
        let mut color_path_defaults = self.fixture_data_provider.color_path_default_entries();
        color_path_defaults.sort_by_key(|default| {
            (
                default.fixture.fixture_uid,
                default.fixture.index.unwrap_or_default(),
            )
        });

        ShowfileContribution::ColorPaths(ColorPathsSnapshot {
            color_paths: Cow::Owned(sorted_provider_values(self.color_path_data_provider)),
            color_path_defaults: Cow::Owned(color_path_defaults),
        })
    }
}

/// Load contributor for color path definitions and fixture default assignments.
pub(crate) struct ColorPathsLoadContributor<'a> {
    color_path_data_provider: &'a mut DataProvider<ColorPath>,
}

impl<'a> ColorPathsLoadContributor<'a> {
    /// Build a contributor that restores color path definitions and defaults.
    pub(crate) fn new(color_path_data_provider: &'a mut DataProvider<ColorPath>) -> Self {
        Self {
            color_path_data_provider,
        }
    }
}

impl ShowfileLoadContributor for ColorPathsLoadContributor<'_> {
    /// Register color paths as their own load domain.
    fn domain(&self) -> ShowfileLoadDomain {
        ShowfileLoadDomain::ColorPaths
    }

    /// Import color path definitions and default assignments.
    fn contribute_load(
        &mut self,
        phase: ShowfileLoadPhase,
        contribution: &ShowfileContribution<'_>,
        _commands: &mut Commands,
    ) -> Result<(), String> {
        if !matches!(phase, ShowfileLoadPhase::ImportDefs) {
            return Ok(());
        }

        let ShowfileContribution::ColorPaths(contribution) = contribution else {
            return Err(
                "color paths contributor received an incompatible showfile domain".to_string(),
            );
        };

        self.color_path_data_provider.clear();
        if contribution.color_paths.is_empty() {
            self.color_path_data_provider.extend(builtin_color_paths());
        } else {
            self.color_path_data_provider
                .extend(contribution.color_paths.to_vec());
        }

        Ok(())
    }
}
