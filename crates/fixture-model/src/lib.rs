// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Profile-level model of fixture parameters and how a fixture interprets them.
//!
//! This crate has no ECS or engine dependencies so the console and the web
//! visualizer (through WebAssembly) share one implementation of parameter
//! value mappings, mode masters, relations and DMX profiles.

pub mod evaluation;
pub mod parameter;

/// Prelude for ergonomic imports.
pub mod prelude {
    pub use crate::evaluation::{
        ChannelReading, FixtureEvaluator, FixtureModel, MAX_RELATION_DEPTH, RelationScope,
    };
    pub use crate::parameter::{
        CieColor, DmxSlots, ElementParameterRef, FunctionRelation, MergeStrategy,
        ModeMasterCondition, ParameterFunction, ParameterFunctionSet, ParameterMetadata,
        ProfilePoint, RelationKind, evaluate_profile,
    };
}
