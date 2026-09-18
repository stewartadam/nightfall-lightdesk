// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Step FX editor preview status projected from authoritative runtime state.

use std::time::Duration;

use nightfall_dmx::prelude::Attribute;
use nightfall_instances::{EditorPreviewInstance, InstanceClock, InstanceControls};
use serde::{Deserialize, Serialize};

use crate::events::StepFxPreviewSessionId;
use crate::step_fx::{ActiveStepFx, StepFxLanePhaseOffsets};

/// Backend-authored runtime anchor for one Step FX editor preview session.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct StepFxPreviewPlaybackStatus {
    /// Stable editor session identity used to reject unrelated preview playbacks.
    pub session_id: StepFxPreviewSessionId,
    /// Wall-clock epoch when the backend sampled this state.
    pub sampled_at_epoch_ms: f64,
    /// Effective Step FX elapsed time at the sample epoch.
    pub elapsed: Duration,
    /// Effective Step FX elapsed seconds advanced per wall-clock second.
    pub elapsed_rate: f64,
    /// Continuity corrections retained for each lane contribution after live edits.
    pub track_phase_offsets: Vec<StepFxPreviewTrackPhaseOffsets>,
}

/// Runtime phase corrections for one Step FX lane's absolute and relative tracks.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct StepFxPreviewTrackPhaseOffsets {
    /// Logical fixture attribute identifying the lane.
    pub attribute: Attribute,
    /// Normalized correction subtracted from the absolute track cycle.
    pub absolute: f32,
    /// Normalized correction subtracted from the relative track cycle.
    pub relative: f32,
}

/// Builds the source-specific runtime anchor for a Step FX editor preview playback.
pub fn step_fx_preview_status(
    preview: Option<&EditorPreviewInstance>,
    active_step_fx: Option<&ActiveStepFx>,
    session_id: Option<&StepFxPreviewSessionId>,
    clock: Option<&InstanceClock>,
    phase_offsets: Option<&StepFxLanePhaseOffsets>,
    controls: &InstanceControls,
    sampled_at_epoch_ms: f64,
) -> Option<StepFxPreviewPlaybackStatus> {
    let (Some(_), Some(active_step_fx), Some(session_id), Some(clock)) =
        (preview, active_step_fx, session_id, clock)
    else {
        return None;
    };
    let active_rate = f64::from(active_step_fx.rate.max(0.0));
    let elapsed = Duration::from_secs_f64(clock.position.as_secs_f64() * active_rate);
    let elapsed_rate = if active_step_fx.is_playing && !clock.frozen {
        controls.effective_rate() * active_rate
    } else {
        0.0
    };
    let track_phase_offsets = phase_offsets
        .into_iter()
        .flat_map(|offsets| offsets.offsets.iter())
        .map(|(attribute, offsets)| StepFxPreviewTrackPhaseOffsets {
            attribute: attribute.clone(),
            absolute: offsets.absolute,
            relative: offsets.relative,
        })
        .collect();
    Some(StepFxPreviewPlaybackStatus {
        session_id: *session_id,
        sampled_at_epoch_ms,
        elapsed,
        elapsed_rate,
        track_phase_offsets,
    })
}

#[cfg(test)]
mod tests {
    use bevy_ecs::prelude::Entity;
    use nightfall::prelude::Priority;
    use uuid::Uuid;

    use super::*;

    /// Verifies preview projection reports backend elapsed time, rate, identity, and offsets.
    #[test]
    fn step_fx_preview_status_projects_authoritative_runtime_anchor() {
        let preview = EditorPreviewInstance;
        let session_id = StepFxPreviewSessionId(Uuid::from_u128(0x730));
        let active_step_fx = ActiveStepFx {
            fx_entity: Entity::PLACEHOLDER,
            priority: Priority::default(),
            rate: 2.0,
            is_playing: true,
        };
        let clock = InstanceClock {
            position: Duration::from_millis(750),
            ..Default::default()
        };
        let controls = InstanceControls {
            rate: 0.5,
            ..Default::default()
        };
        let phase_offsets = StepFxLanePhaseOffsets::new(
            vec![(
                Attribute::Pan,
                crate::prelude::StepFxTrackPhaseOffsets {
                    absolute: 0.25,
                    relative: 0.75,
                },
            )],
            clock.position,
        );

        let status = step_fx_preview_status(
            Some(&preview),
            Some(&active_step_fx),
            Some(&session_id),
            Some(&clock),
            Some(&phase_offsets),
            &controls,
            42_000.0,
        )
        .expect("preview runtime should project");

        assert_eq!(status.session_id, session_id);
        assert_eq!(status.sampled_at_epoch_ms, 42_000.0);
        assert_eq!(status.elapsed, Duration::from_millis(1500));
        assert_eq!(status.elapsed_rate, 1.0);
        assert_eq!(status.track_phase_offsets.len(), 1);
        assert_eq!(status.track_phase_offsets[0].attribute, Attribute::Pan);
        assert_eq!(status.track_phase_offsets[0].absolute, 0.25);
        assert_eq!(status.track_phase_offsets[0].relative, 0.75);
    }

    /// Verifies ordinary playbacks cannot be mistaken for an editor preview clock source.
    #[test]
    fn step_fx_preview_status_requires_editor_preview_marker() {
        let active_step_fx = ActiveStepFx::default();
        let session_id = StepFxPreviewSessionId(Uuid::from_u128(0x731));
        let clock = InstanceClock::default();
        let controls = InstanceControls::default();

        assert!(
            step_fx_preview_status(
                None,
                Some(&active_step_fx),
                Some(&session_id),
                Some(&clock),
                None,
                &controls,
                42_000.0,
            )
            .is_none()
        );
    }
}
