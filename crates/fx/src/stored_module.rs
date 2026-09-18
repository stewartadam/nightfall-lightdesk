// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;

use nightfall::prelude::{HasIdentifiers, Identifiers, SpatialSelection};
use serde::{Deserialize, Serialize};

/// Stored component FX definition owned by a showfile independently of its runtime host.
#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct StoredFxModule {
    /// Stable numeric and UUID identifiers for the stored component FX object.
    pub identifiers: Identifiers,
    /// Component module name resolved by the active runtime host.
    pub module_name: String,
    /// Spatial selection owned by the stored component FX object.
    pub selection: SpatialSelection,
    /// Component-owned configuration key/value pairs.
    #[typeshare(serialized_as = "Record<String, String>")]
    pub config: HashMap<String, String>,
}

impl HasIdentifiers for StoredFxModule {
    /// Return the stable identifiers used by showfile providers and references.
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}
