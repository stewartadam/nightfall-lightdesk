// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Show-wide named variables shared by command evaluation and playback domains.

use std::collections;

use bevy_ecs::prelude::*;
use dashmap::DashMap;
use nightfall::prelude::*;

/// Resource storing named variables available to desk commands.
#[derive(Resource, Default)]
pub struct GlobalVariables(DashMap<String, VariableValue>);

impl GlobalVariables {
    /// Returns a copy of the named variable, or an error naming the missing variable.
    pub fn get(&self, key: &str) -> Result<VariableValue, String> {
        self.0
            .get(key)
            .map(|item| item.value().clone())
            .ok_or_else(|| format!("Variable {} not found", key))
    }

    /// Returns a snapshot of every variable, keyed by name.
    pub fn get_all(&self) -> collections::HashMap<String, VariableValue> {
        self.0
            .iter()
            .map(|item| (item.key().to_string(), item.value().clone()))
            .collect()
    }

    /// Creates or overwrites the named variable.
    pub fn set(&self, key: &str, value: VariableValue) {
        self.0.insert(key.to_owned(), value.clone());
    }

    /// Removes every variable, as when a show is unloaded.
    pub fn clear(&self) {
        self.0.clear();
    }
}
