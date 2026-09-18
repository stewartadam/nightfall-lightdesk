// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    collections::HashMap,
    sync::{Arc, RwLock, RwLockWriteGuard},
};

use bevy_ecs::prelude::*;
use tracing_subscriber::{EnvFilter, reload};

/// Log target configuration that can be adjusted at runtime.
#[derive(Debug, Clone)]
pub struct TracingTarget {
    // Map of field names to optional field values
    // None means "match any value for this field"
    pub filter_str: String,
    pub field_matchers: HashMap<String, Option<String>>,
}

impl Default for TracingTarget {
    /// Builds the default Nightfall tracing target without reading process-global configuration.
    fn default() -> Self {
        Self::new(None)
    }
}

impl TracingTarget {
    /// Builds a tracing target from an optional typed startup filter.
    pub fn new(filter: Option<&str>) -> Self {
        // Determine default level for our logs depending on build config
        #[cfg(debug_assertions)]
        let nightfall_default_level = "debug";

        #[cfg(not(debug_assertions))]
        let nightfall_default_level = "info";

        Self {
            filter_str: filter
                .map(str::to_owned)
                .unwrap_or_else(|| format!("info,nightfall={nightfall_default_level}")),
            field_matchers: HashMap::new(),
        }
    }
}

/// A resource that holds the log filter reload handle
#[derive(Resource, Clone)]
pub struct LogConfig {
    env_filter_fn: Arc<dyn Fn(EnvFilter) -> Result<(), reload::Error> + Send + Sync>,
    tracing_target: Arc<RwLock<TracingTarget>>,
}

impl LogConfig {
    /// Build a log configuration without a process-level subscriber reload handle.
    pub fn disconnected() -> Self {
        Self::new(|_| Ok(()), Arc::new(RwLock::new(TracingTarget::default())))
    }

    /// Create a new LogReloadHandle from a reload::Handle
    pub fn new(
        env_filter_fn: impl Fn(EnvFilter) -> Result<(), reload::Error> + Send + Sync + 'static,
        tracing_target: Arc<RwLock<TracingTarget>>,
    ) -> Self {
        Self {
            env_filter_fn: Arc::new(env_filter_fn),
            tracing_target,
        }
    }

    /// Reload the log filter with a new filter string
    pub fn reload_env(
        &self,
        filter: Option<&str>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync + 'static>> {
        let mut tracing_target = self.tracing_target.write().unwrap();

        if let Some(filter) = filter {
            tracing_target.filter_str = filter.to_owned();
        }

        let mut new_filter = tracing_target.filter_str.parse::<EnvFilter>()?;

        // Inject fields from stored tracing target
        let matchers = tracing_target.field_matchers.clone();
        for (field, value) in matchers {
            let directive = if let Some(value) = value {
                format!("[{{{field}={value}}}]=trace")
            } else {
                format!("[{{{field}}}]=trace")
            };
            tracing::debug!("Adding env filter directive: {}", directive);
            new_filter = new_filter.add_directive(directive.parse().unwrap());
        }
        (self.env_filter_fn)(new_filter).map_err(|e| Box::new(e) as _)
    }

    pub fn tracing_target_mut(&self) -> RwLockWriteGuard<'_, TracingTarget> {
        self.tracing_target.write().unwrap()
    }
}
