// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections;

use bevy_ecs::prelude::*;
use dashmap::DashMap;
use nightfall::prelude::*;

/// Resource storing named variables available to desk commands.
#[derive(Resource, Default)]
pub struct GlobalVariables(DashMap<String, VariableValue>);

impl GlobalVariables {
    pub fn get(&self, key: &str) -> Result<VariableValue, String> {
        self.0
            .get(key)
            .map(|item| item.value().clone())
            .ok_or_else(|| format!("Variable {} not found", key))
    }

    pub fn get_all(&self) -> collections::HashMap<String, VariableValue> {
        self.0
            .iter()
            .map(|item| (item.key().to_string(), item.value().clone()))
            .collect()
    }

    pub fn set(&self, key: &str, value: VariableValue) {
        self.0.insert(key.to_owned(), value.clone());
    }

    pub fn clear(&self) {
        self.0.clear();
    }
}
