// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Shared authored definitions for event system tests.

use nightfall::prelude::*;
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use uuid::Uuid;

use crate::prelude::*;

/// Builds a valid two-step intensity chase for command tests.
pub(super) fn valid_step_fx(id: u32, uid: Uuid, selection: SpatialSelection) -> StepFx {
    StepFx {
        color_lane: None,
        identifiers: Identifiers {
            id,
            uid,
            label: format!("Step FX {id}"),
        },
        selection,
        timing: StepFxTiming::default(),
        phase: StepFxPhase::default(),
        direction: FxDirection::Forward,
        cycle_scale: Default::default(),
        lanes: vec![FxLane {
            attribute: Attribute::Intensity,
            timing_override: None,
            phase_override: None,
            absolute: Some(FxTrack {
                steps: vec![
                    FxStep::new(
                        ParameterValue::AbsolutePercent { value: 1.0.into() },
                        1.0,
                        0.0.into(),
                        CurveType::Snap(Snap {}),
                    ),
                    FxStep::new(
                        ParameterValue::AbsolutePercent { value: 0.0.into() },
                        1.0,
                        0.0.into(),
                        CurveType::Snap(Snap {}),
                    ),
                ],
            }),
            relative: None,
        }],
    }
}
