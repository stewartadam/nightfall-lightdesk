// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Beat and downbeat detection from audio with the Beat This model.
//!
//! This crate owns the RTen inference stack so that crates which only schedule
//! detection (such as the timeline) do not compile or wait on it.

#![warn(missing_docs)]

pub mod beat_this;
mod estimate;
pub mod model;

pub use estimate::{BeatgridEstimate, EstimatedBeat, estimate};
