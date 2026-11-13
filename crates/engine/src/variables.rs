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

    /// Returns a snapshot of every variable, sorted by name so serialized output is stable.
    pub fn get_all(&self) -> collections::BTreeMap<String, VariableValue> {
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

/// Live state section holding every variable's value, which timeline parameter lanes change
/// while the show runs.
pub(crate) const VARIABLES_LIVE_STATE: &str = "variables";

/// Captures every variable's current value for a backup checkpoint.
pub(crate) fn capture_live_variables(
    world: &mut World,
) -> collections::HashMap<String, VariableValue> {
    world.resource::<GlobalVariables>().get_all()
}

/// Replaces every variable with the primary's set and values, since the show revision ignores
/// variables and a reload would never remove one the primary no longer has.
pub(crate) fn follow_live_variables(
    world: &mut World,
    values: collections::HashMap<String, VariableValue>,
    _restore: crate::live_state::LiveStateRestore,
) {
    let variables = world.resource::<GlobalVariables>();
    variables.0.retain(|key, _| values.contains_key(key));
    for (key, value) in values {
        variables.set(&key, value);
    }
}
