// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Hidden module to define typeshare types that we do not want compiled.
//!
//! Typeshare does its own source code parsing and does not depend on the
//! compiler, so this file will get included by TypeShare but is intentionally
//! omitted from the lib.rs to avoid naming conflicts with existing types.
//!
//! Unlike schemars which generates schemas from the compiled code at runtime,
//! because TypeShare does its own source file parsing, it cannot serialize
//! arbitrary types we use in our codebase.
//!
//! Instead, we must define the shape of these dependent types here.

#[typeshare::typeshare]
struct Instant {
    secs_since_epoch: u32,
    nanos_since_epoch: u32,
}

/// TypeScript-facing shape for Rust `Duration` values.
#[typeshare::typeshare]
struct Duration {
    pub secs: u32,
    pub nanos: u32,
}

#[typeshare::typeshare]
type Uuid = String;

#[typeshare::typeshare]
type Percentage = f64;

#[typeshare::typeshare]
type Ipv4Addr = String;

// We define this manually but keep the original defined via partially because
// partially has helper methods to convert to/from Transition.
/// TypeScript-facing shape for partially specified transition updates.
#[typeshare::typeshare]
struct PartialTransition {
    delay_in: Option<TransitionMode>,
    fade_in: Option<TransitionMode>,
    curve_in: Option<FadeCurve>,
    delay_out: Option<TransitionMode>,
    fade_out: Option<TransitionMode>,
    curve_out: Option<FadeCurve>,
}
