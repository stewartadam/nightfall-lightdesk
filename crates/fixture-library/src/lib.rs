// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Fixture library management for Nightfall
//!
//! This crate provides fixture library management functionality, including:
//! - Scanning user data directory for GDTF and OFL fixture files
//! - Parsing fixture definitions using gdtf and open-fixture-library crates
//! - Converting fixture definitions to nightfall-fixtures types
//! - File system watching for hot-reloading
//! - Bevy plugin integration

#![warn(missing_docs)]

pub mod commands;
pub mod converters;
pub mod gdtf_metadata;
pub mod http_routes;
pub mod manager;
pub mod mesh;
pub mod plugin;
pub mod scanner;
pub mod watcher;
pub mod websocket;

pub use gdtf_metadata::GdtfMetadata;
pub use manager::{FixtureLibraryManager, FixtureProfile, FixtureSource};
pub use plugin::FixtureLibraryPlugin;
use thiserror::Error;

/// Errors that can occur in the fixture library
#[derive(Debug, Error)]
pub enum FixtureLibraryError {
    /// GDTF parsing error
    #[error("GDTF error: {0}")]
    Gdtf(String),

    /// OFL parsing error
    #[error("OFL error: {0}")]
    Ofl(#[from] open_fixture_library::OflError),

    /// IO error
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// Fixture not found
    #[error("Fixture not found: {make} {model}")]
    NotFound {
        /// Manufacturer name
        make: String,
        /// Model name
        model: String,
    },

    /// Mode not found
    #[error("Mode '{mode}' not found for {make} {model}")]
    ModeNotFound {
        /// Manufacturer name
        make: String,
        /// Model name
        model: String,
        /// Mode name
        mode: String,
    },

    /// Conversion error
    #[error("Conversion error: {0}")]
    Conversion(String),

    /// Invalid data directory
    #[error("Invalid data directory: {0}")]
    InvalidDataDirectory(String),
}

/// Result type for fixture library operations
pub type Result<T> = std::result::Result<T, FixtureLibraryError>;

/// Prelude for convenient imports
pub mod prelude {
    pub use crate::FixtureLibraryError;
    pub use crate::commands::FixtureLibraryCommand;
    pub use crate::gdtf_metadata::GdtfMetadata;
    pub use crate::manager::{FixtureLibraryManager, FixtureProfile, FixtureSource};
    pub use crate::plugin::FixtureLibraryPlugin;
    pub use crate::watcher::{FixtureLibraryEvent, FixtureLibraryWatcher};
}
