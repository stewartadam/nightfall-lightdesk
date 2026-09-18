// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Object metadata structure

use serde::{Deserialize, Serialize};

/// Metadata for an object in the library.
///
/// This is stored in `object.json` within the .robj bundle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct ObjectMetadata {
    /// Name of the object (e.g., "Road Case", "Drum Riser")
    pub name: String,

    /// Category for organization (e.g., "Stage", "Rigging", "Props")
    #[serde(default)]
    pub category: String,

    /// Optional description
    #[serde(default)]
    pub description: String,

    /// Default scale factor (1.0 = model units match real-world meters)
    #[serde(default = "default_scale")]
    pub scale: f32,

    /// Optional author/creator
    #[serde(default)]
    pub author: String,

    /// Optional license information
    #[serde(default)]
    pub license: String,

    /// Optional tags for searching
    #[serde(default)]
    pub tags: Vec<String>,
}

fn default_scale() -> f32 {
    1.0
}

impl Default for ObjectMetadata {
    fn default() -> Self {
        Self {
            name: String::new(),
            category: "Custom".to_string(),
            description: String::new(),
            scale: 1.0,
            author: String::new(),
            license: String::new(),
            tags: Vec::new(),
        }
    }
}

impl ObjectMetadata {
    /// Create new metadata with just a name
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Default::default()
        }
    }

    /// Create metadata with name and category
    pub fn with_category(name: impl Into<String>, category: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            category: category.into(),
            ..Default::default()
        }
    }
}
