// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::borrow::Cow;

use bevy_ecs::prelude::{Commands, Query};
use moonshine_kind::prelude::*;
use nightfall_clips::Clip;

use super::{ShowfileContribution, ShowfileLoadContributor, ShowfileSaveContributor};
use crate::{ShowfileLoadDomain, ShowfileLoadPhase};

/// Clip state used as owned save output or borrowed load input.
pub(crate) struct ClipsSnapshot<'a> {
    pub(super) clips: Cow<'a, [Clip]>,
}

/// Save contributor for clip runtime data.
pub(crate) struct ClipsSaveContributor<'a, 'w, 's> {
    clip_query: &'a Query<'w, 's, &'static Clip>,
}

impl<'a, 'w, 's> ClipsSaveContributor<'a, 'w, 's> {
    /// Build a contributor that snapshots clip runtime data.
    pub(crate) fn new(clip_query: &'a Query<'w, 's, &'static Clip>) -> Self {
        Self { clip_query }
    }
}

impl ShowfileSaveContributor for ClipsSaveContributor<'_, '_, '_> {
    /// Copy clips into their stable showfile field.
    fn save_contribution(&self) -> ShowfileContribution<'static> {
        let mut clips: Vec<_> = self.clip_query.iter().cloned().collect();
        clips.sort_by_key(|a| a.identifiers.id);

        ShowfileContribution::Clips(ClipsSnapshot {
            clips: Cow::Owned(clips),
        })
    }
}

/// Load contributor for clip runtime data.
pub(crate) struct ClipsLoadContributor;

impl ClipsLoadContributor {
    /// Build a contributor that restores clip runtime data.
    pub(crate) fn new() -> Self {
        Self
    }
}

impl ShowfileLoadContributor for ClipsLoadContributor {
    /// Register clips as their own load domain.
    fn domain(&self) -> ShowfileLoadDomain {
        ShowfileLoadDomain::Clips
    }

    /// Materialize clips during the runtime materialization phase.
    fn contribute_load(
        &mut self,
        phase: ShowfileLoadPhase,
        contribution: &ShowfileContribution<'_>,
        commands: &mut Commands,
    ) -> Result<(), String> {
        if !matches!(phase, ShowfileLoadPhase::MaterializeRuntime) {
            return Ok(());
        }

        let ShowfileContribution::Clips(contribution) = contribution else {
            return Err("clips contributor received an incompatible showfile domain".to_string());
        };

        for clip in contribution.clips.iter() {
            commands.spawn_instance(clip.clone());
        }

        Ok(())
    }
}
