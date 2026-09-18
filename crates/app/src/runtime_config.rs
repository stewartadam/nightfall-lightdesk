// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_config::{ConfigError, RuntimeConfig, RuntimeConfigLoader};

/// Loads typed startup configuration without modifying the process environment.
///
/// Desktop development builds may start outside the workspace, so debug builds
/// fall back to the workspace `.env` located from this crate's manifest path.
pub fn load_runtime_config() -> Result<RuntimeConfig, ConfigError> {
    let loader = RuntimeConfigLoader::new();

    #[cfg(debug_assertions)]
    let loader = loader.fallback_dotenv_path(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".env"),
    );

    loader.load()
}
