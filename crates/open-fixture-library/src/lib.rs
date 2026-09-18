// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Open Fixture Library (OFL) format parser
//!
//! This crate provides Rust data structures and parsing for the Open Fixture Library
//! JSON format. OFL is a community-driven database of DMX fixture definitions.
//!
//! # Example
//!
//! ```no_run
//! use open_fixture_library::OflFixture;
//! use std::path::Path;
//!
//! let fixture = OflFixture::from_file(Path::new("fixture.json"))?;
//! println!("Manufacturer: {}", fixture.manufacturer());
//! println!("Name: {}", fixture.name());
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

#![warn(missing_docs)]

pub mod fixture;
pub mod schema;

pub use fixture::OflFixture;
pub use schema::{OflCapability, OflChannel, OflMode, OflPhysical};
use thiserror::Error;

/// Errors that can occur when parsing OFL fixtures
#[derive(Debug, Error)]
pub enum OflError {
    /// IO error reading fixture file
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// JSON parsing error
    #[error("JSON parsing error: {0}")]
    Json(#[from] serde_json::Error),

    /// Invalid fixture data
    #[error("Invalid fixture data: {0}")]
    InvalidData(String),

    /// Missing required field
    #[error("Missing required field: {0}")]
    MissingField(String),
}

/// Result type for OFL operations
pub type Result<T> = std::result::Result<T, OflError>;
