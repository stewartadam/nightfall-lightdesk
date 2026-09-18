// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Command payloads and terminal results for Step FX authoring.

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::prelude::*;

/// Commands for step-based FX operations.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum StepFxCommand {
    /// Create a Step FX from command-authored values whose Blueprint addresses
    /// still need to be resolved against current engine state.
    Create(StepFxDraft),
    /// Create or replace one complete valid Step FX definition.
    Store(StepFx),
    /// Delete a stored Step FX by numeric ID.
    Delete(u32),
    /// Start a step FX
    Start(u32),
    /// Stop a step FX
    Stop(u32),
    /// Set rate multiplier for a step FX
    SetRate {
        /// ID of the FX
        fx_id: u32,
        /// Rate multiplier
        rate: f32,
    },
}

/// Command-time Step FX definition containing unresolved Blueprint addresses.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct StepFxDraft {
    /// Stable and operator-facing identifiers assigned to the stored effect.
    pub identifiers: Identifiers,
    /// Fixture membership, order, grouping, and inversion operations.
    pub selection: SpatialSelection,
    /// Canonical effect-wide beat timing.
    pub timing: StepFxTiming,
    /// Effect-wide phase defaults.
    pub phase: StepFxPhase,
    /// Authored traversal direction.
    pub direction: FxDirection,
    /// Optional normalization of the complete repeating cycle.
    pub cycle_scale: StepFxCycleScale,
    /// Per-attribute sequences converted into canonical lanes after resolution.
    pub sequences: Vec<FxStepSequenceDraft>,
}

/// Command-time sequence whose Blueprint-backed values have not been resolved.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FxStepSequenceDraft {
    /// Logical attribute controlled by the resulting lane.
    pub attribute: Attribute,
    /// Optional absolute baseline paired with relative targets.
    pub base_value: Option<StepFxCommandValueSource>,
    /// Ordered targets forming the lane's dynamic contribution track.
    pub steps: Vec<FxStepDraft>,
}

/// Command-time target step whose scalar source may reference a Blueprint address.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FxStepDraft {
    /// Stable identity independent of the step's current position.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub uid: Uuid,
    /// Direct value or Blueprint address supplying the target.
    pub target: StepFxCommandValueSource,
    /// Time from this step's start to the following step's start, in beats.
    pub width_beats: f32,
    /// Interpolation window within the step.
    pub transition: StepFxTransition,
    /// Curve used during the transition portion of the step.
    pub curve: CurveType,
}

/// Scalar source accepted while creating a Step FX from a command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum StepFxCommandValueSource {
    /// A scalar value authored directly in the command.
    Direct(ParameterValue),
    /// An operator address resolved when the command executes.
    Blueprint {
        /// Mutable numeric ID or label used by the operator.
        address: BlueprintAddress,
        /// Whether to retain a live reference or copy the current value.
        resolution: BlueprintResolution,
    },
}

impl IngressCommand for StepFxCommand {}

/// Domain-local terminal state produced after a step FX command has applied.
#[derive(Clone, Debug, Message)]
pub struct StepFxCommandResult {
    pub(super) command_id: CommandId,
    pub(super) result: Result<(), CommandError>,
}
