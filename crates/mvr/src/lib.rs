// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Reader for My Virtual Rig (MVR, DIN SPEC 15801) scene files.
//!
//! An `.mvr` file is a zip archive holding `GeneralSceneDescription.xml` and every GDTF
//! file, 3D model and texture the scene references. CAD and previsualization tools such as
//! Vectorworks, Capture and grandMA3 export the lighting rig in this format: fixture types
//! and modes, fixture IDs, DMX addresses and each object's position in the venue.
//!
//! This crate only reads the format. It knows nothing about Nightfall shows; turning a rig
//! into fixtures, patch and placements is the importer's job.
//!
//! # Example
//!
//! ```no_run
//! use nightfall_mvr::prelude::*;
//!
//! let file = std::fs::File::open("rig.mvr")?;
//! let archive = MvrArchive::open(file)?;
//! for placed in archive.scene().placed_fixtures() {
//!     let fixture = placed.fixture().expect("placed_fixtures yields fixtures");
//!     let origin = placed.world.origin;
//!     println!("{} at {:?} mm, patched at {:?}", fixture.name, origin, fixture.addresses());
//! }
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

#![warn(missing_docs)]

#[cfg(not(target_arch = "wasm32"))]
// Leaf crate: mark the cargo-hakari workspace-hack as used so cargo's unused_dependencies lint passes.
use nightfall_workspace_hack as _;

pub mod archive;
mod de;
pub mod error;
pub mod scene;
pub mod transform;
pub mod values;
pub mod walk;

#[cfg(test)]
mod tests;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::archive::{ArchiveLimits, ArchiveWarning, MvrArchive};
    pub use crate::error::MvrError;
    pub use crate::scene::*;
    pub use crate::transform::Transform;
    pub use crate::values::{CieColor, DmxAddress, FixtureAddress};
    pub use crate::walk::PlacedObject;
}
