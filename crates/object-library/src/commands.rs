// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket commands for object library operations

use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

use crate::metadata::ObjectMetadata;

/// Commands for object library operations
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum ObjectLibraryCommand {
    /// List all available objects in the library
    ListAvailableObjects,

    /// Get detailed information about a specific object
    GetObjectProfile {
        /// Object name
        name: String,
    },

    /// Refresh the object library by rescanning the directory
    RefreshLibrary,

    /// Create an object bundle from a GLB file
    CreateObject {
        /// Object metadata
        metadata: ObjectMetadata,
        /// GLB file content as bytes
        glb_content: Vec<u8>,
    },

    /// Upload an object bundle (.robj) to the library
    UploadObject {
        /// Original filename (used as storage name)
        filename: String,
        /// File content as bytes
        content: Vec<u8>,
    },

    /// Delete objects from the library
    DeleteObjects(Vec<String>),

    /// Create a scene object from the library and add it to the show
    CreateSceneObjectFromLibrary {
        /// Scene object ID
        id: u32,
        /// Object name in the library
        object_name: String,
        /// Optional user-defined label
        #[serde(default)]
        label: Option<String>,
        /// Existing scene object IDs to update to this library asset version
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        update_existing_ids: Vec<u32>,
    },

    /// Update existing scene objects in the showfile using their linked library entries
    UpdateSceneObjectsFromLibrary {
        /// Scene object IDs to update from library definitions
        scene_object_ids: Vec<u32>,
    },
}

impl IngressCommand for ObjectLibraryCommand {}

/// Information about an available object
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct AvailableObjectInfo {
    /// Object name
    pub name: String,
    /// Object category
    pub category: String,
    /// Object description
    #[serde(default)]
    pub description: String,
    /// Default scale
    pub scale: f32,
    /// Tags for searching
    #[serde(default)]
    pub tags: Vec<String>,
    /// Encoded object bundle token for `/api/object-model/{object_path}`
    pub model_path: String,
    /// Deterministic content fingerprint of the object bundle
    pub asset_version: String,
}

/// Response for ListAvailableObjects command
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ListAvailableObjectsResponse {
    /// List of available objects
    pub objects: Vec<AvailableObjectInfo>,
}

/// Response for GetObjectProfile command
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct GetObjectProfileResponse {
    /// Object information
    pub info: AvailableObjectInfo,
    /// Full metadata
    pub metadata: ObjectMetadata,
}
