// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Object library management for Nightfall
//!
//! This crate provides object library management functionality, including:
//! - Scanning user data directory for object bundle files (.robj)
//! - Parsing object definitions (JSON metadata + GLB model)
//! - File system watching for hot-reloading
//! - Bevy plugin integration
//!
//! ## Object Bundle Format (.robj)
//!
//! Object bundles are ZIP files with the `.robj` extension containing:
//! - `object.json` - Metadata describing the object
//! - `model.glb` - GLTF binary 3D model file

#![warn(missing_docs)]

pub mod commands;
pub mod http_routes;
pub mod manager;
pub mod metadata;
pub mod plugin;
pub mod scanner;
pub mod watcher;
pub mod websocket;

/// Prelude for convenient imports
pub mod prelude {
    pub use crate::ObjectLibraryError;
    pub use crate::commands::ObjectLibraryCommand;
    pub use crate::manager::{ObjectLibraryManager, ObjectProfile};
    pub use crate::metadata::ObjectMetadata;
    pub use crate::plugin::ObjectLibraryPlugin;
    pub use crate::watcher::{ObjectLibraryEvent, ObjectLibraryWatcher};
}

pub use manager::{ObjectLibraryManager, ObjectProfile};
pub use metadata::ObjectMetadata;
pub use plugin::ObjectLibraryPlugin;
use thiserror::Error;

/// Errors that can occur in the object library
#[derive(Debug, Error)]
pub enum ObjectLibraryError {
    /// Metadata parsing error
    #[error("Metadata error: {0}")]
    Metadata(String),

    /// ZIP archive error
    #[error("Archive error: {0}")]
    Archive(String),

    /// IO error
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// Object not found
    #[error("Object not found: {name}")]
    NotFound {
        /// Object name
        name: String,
    },

    /// Model file not found in archive
    #[error("Model file not found in archive: {0}")]
    ModelNotFound(String),

    /// Invalid data directory
    #[error("Invalid data directory: {0}")]
    InvalidDataDirectory(String),

    /// JSON parsing error
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Result type for object library operations
pub type Result<T> = std::result::Result<T, ObjectLibraryError>;
