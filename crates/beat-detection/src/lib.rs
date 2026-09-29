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
//!
//! It deliberately stays free of Bevy, HTTP, and networking dependencies so it
//! can compile early and in parallel with the domain crates. Related code lives
//! elsewhere for that reason:
//! - Timeline (`beatgrid_detection`) schedules detection and turns results into
//!   beatgrid proposals through the `BeatgridDetector` hook.
//! - App-runtime (`beat_model_http`) serves the model download and installation
//!   routes, which need axum, reqwest, and the websocket route registry.
//! - App-runtime (`beat_detection_backend`) connects this crate to the timeline
//!   hook.

#![warn(missing_docs)]

pub mod beat_this;
mod estimate;
pub mod model;

pub use estimate::{BeatgridEstimate, EstimatedBeat, estimate};
