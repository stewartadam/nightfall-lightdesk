// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Blueprint command, action, and dependency-tracking contracts shared across domains.

use std::collections::{HashMap, HashSet};

use bevy_ecs::prelude::*;
use nightfall::prelude::Blueprint;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::prelude::*;

/// Describes a committed Blueprint definition mutation.
#[derive(Clone, Debug, Message)]
pub struct BlueprintDefinitionChange {
    /// Stable identity of the Blueprint that changed.
    pub uid: Uuid,
}

/// Tracks authored objects that currently contain live Blueprint references.
#[derive(Debug, Default, Resource)]
pub struct BlueprintReferenceIndex {
    references: HashMap<Uuid, HashSet<String>>,
}

impl BlueprintReferenceIndex {
    /// Replaces every dependency reported by one indexing subsystem.
    pub fn replace_source(
        &mut self,
        source: &str,
        references: impl IntoIterator<Item = (Uuid, String)>,
    ) {
        let prefix = format!("{source}:");
        self.references.retain(|_, dependents| {
            dependents.retain(|dependent| !dependent.starts_with(&prefix));
            !dependents.is_empty()
        });
        for (uid, dependent) in references {
            self.references
                .entry(uid)
                .or_default()
                .insert(format!("{prefix}{dependent}"));
        }
    }

    /// Returns sorted descriptions of objects that reference one Blueprint.
    pub fn dependents(&self, uid: Uuid) -> Vec<String> {
        let mut dependents = self
            .references
            .get(&uid)
            .into_iter()
            .flatten()
            .cloned()
            .collect::<Vec<_>>();
        dependents.sort();
        dependents
    }

    /// Returns every indexed Blueprint dependency in stable UUID and description order.
    pub fn snapshot(&self) -> Vec<(Uuid, Vec<String>)> {
        let mut entries = self
            .references
            .keys()
            .copied()
            .map(|uid| (uid, self.dependents(uid)))
            .collect::<Vec<_>>();
        entries.sort_by_key(|(uid, _)| *uid);
        entries
    }
}

/// Commands for blueprint CRUD operations
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum BlueprintCommand {
    /// Store or update a blueprint
    StoreBlueprint(Blueprint),

    /// Rename a blueprint (change numeric ID)
    RenameBlueprint {
        /// ID of the blueprint
        id: u32,
        /// New ID for the blueprint
        new_id: u32,
    },
    /// Delete a blueprint by ID
    DeleteBlueprint(u32),
}

impl IngressCommand for BlueprintCommand {}

/// Runtime actions for blueprint operations derived from user command plans.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
pub enum BlueprintAction {
    /// Store or update a blueprint payload prepared by planner/runtime handlers.
    StoreBlueprint(Blueprint),
}

impl EngineAction for BlueprintAction {}
