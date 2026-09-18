// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::borrow::Cow;

use bevy_ecs::prelude::Commands;
use nightfall_scene_objects::prelude::*;

use super::{ShowfileContribution, ShowfileLoadContributor, ShowfileSaveContributor};
use crate::{ShowfileLoadDomain, ShowfileLoadPhase};

/// Scene object state used as owned save output or borrowed load input.
pub(crate) struct SceneObjectsSnapshot<'a> {
    pub(super) scene_objects: Cow<'a, [SceneObject]>,
}

/// Save contributor for scene object definitions.
pub(crate) struct SceneObjectsSaveContributor<'a> {
    scene_object_provider: &'a SceneObjectDataProvider,
}

impl<'a> SceneObjectsSaveContributor<'a> {
    /// Build a contributor that snapshots scene object definitions.
    pub(crate) fn new(scene_object_provider: &'a SceneObjectDataProvider) -> Self {
        Self {
            scene_object_provider,
        }
    }
}

impl ShowfileSaveContributor for SceneObjectsSaveContributor<'_> {
    /// Copy scene object definitions into their stable showfile field.
    fn save_contribution(&self) -> ShowfileContribution<'static> {
        let mut scene_objects: Vec<_> = self
            .scene_object_provider
            .iter()
            .map(|entry| (*entry.value()).clone())
            .collect();
        scene_objects.sort_by_key(|a| a.identifiers.id);

        ShowfileContribution::SceneObjects(SceneObjectsSnapshot {
            scene_objects: Cow::Owned(scene_objects),
        })
    }
}

/// Load contributor for scene object definitions.
pub(crate) struct SceneObjectsLoadContributor<'a> {
    scene_object_provider: &'a mut SceneObjectDataProvider,
}

impl<'a> SceneObjectsLoadContributor<'a> {
    /// Build a contributor that restores scene object definitions.
    pub(crate) fn new(scene_object_provider: &'a mut SceneObjectDataProvider) -> Self {
        Self {
            scene_object_provider,
        }
    }
}

impl ShowfileLoadContributor for SceneObjectsLoadContributor<'_> {
    /// Register scene objects as their own load domain.
    fn domain(&self) -> ShowfileLoadDomain {
        ShowfileLoadDomain::SceneObjects
    }

    /// Import scene object definitions during the definition import phase.
    fn contribute_load(
        &mut self,
        phase: ShowfileLoadPhase,
        contribution: &ShowfileContribution<'_>,
        _commands: &mut Commands,
    ) -> Result<(), String> {
        if !matches!(phase, ShowfileLoadPhase::ImportDefs) {
            return Ok(());
        }

        let ShowfileContribution::SceneObjects(contribution) = contribution else {
            return Err(
                "scene objects contributor received an incompatible showfile domain".to_string(),
            );
        };

        for scene_object in contribution.scene_objects.iter() {
            if let Err(error) = self.scene_object_provider.add(scene_object.clone()) {
                tracing::warn!(
                    "Failed to load scene object {} from showfile: {}",
                    scene_object.identifiers.id,
                    error
                );
            }
        }

        Ok(())
    }
}
