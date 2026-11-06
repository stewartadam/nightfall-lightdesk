// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Step FX editor preview status projected from authoritative runtime state, and the feed that
//! sends it to the editor.
//!
//! Each status is a clock anchor the editor interpolates from, so it is sent when a preview
//! starts, stops or changes speed, and re-anchored a few times a second while one runs.

use std::time::Duration;

use bevy_ecs::prelude::*;
use nightfall_dmx::prelude::Attribute;
use nightfall_engine::prelude::*;
use nightfall_instances::{EditorPreviewInstance, InstanceClock, InstanceControls, InstanceId};
use serde::{Deserialize, Serialize};

use crate::events::{PreviewStepFxDefinition, StepFxPreviewSessionId};
use crate::step_fx::{ActiveStepFx, StepFxLanePhaseOffsets};

/// How often a running preview's clock anchor is sent again, so the editor's playhead never
/// drifts far from the backend clock.
const REANCHOR_INTERVAL: Duration = Duration::from_millis(100);

/// Backend-authored runtime anchor for one Step FX editor preview session.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct StepFxPreviewPlaybackStatus {
    /// Playback running the preview.
    pub instance_id: InstanceId,
    /// Stable editor session identity used to reject unrelated preview playbacks.
    pub session_id: StepFxPreviewSessionId,
    /// Wall-clock epoch when the backend sampled this state.
    pub sampled_at_epoch_ms: f64,
    /// Effective Step FX elapsed time at the sample epoch.
    pub elapsed: Duration,
    /// Effective Step FX elapsed seconds advanced per wall-clock second.
    pub elapsed_speed: f64,
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

/// Step FX preview messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum StepFxPreviewWsMessage<'a> {
    /// Clock anchor of every running Step FX editor preview.
    StepFxPreviews(&'a [StepFxPreviewPlaybackStatus]),
}

/// Playback components a Step FX editor preview status is built from.
type StepFxPreviewPlayback = (
    &'static InstanceId,
    &'static ActiveStepFx,
    &'static StepFxPreviewSessionId,
    &'static InstanceClock,
    Option<&'static StepFxLanePhaseOffsets>,
    &'static InstanceControls,
);

/// Builds the runtime anchor for a Step FX editor preview playback sampled at
/// `sampled_at_epoch_ms`.
pub fn step_fx_preview_status(
    (instance_id, active_step_fx, session_id, clock, phase_offsets, controls): (
        &InstanceId,
        &ActiveStepFx,
        &StepFxPreviewSessionId,
        &InstanceClock,
        Option<&StepFxLanePhaseOffsets>,
        &InstanceControls,
    ),
    sampled_at_epoch_ms: f64,
) -> StepFxPreviewPlaybackStatus {
    let active_speed = f64::from(active_step_fx.speed.max(0.0));
    let elapsed = Duration::from_secs_f64(clock.position.as_secs_f64() * active_speed);
    let elapsed_speed = if active_step_fx.is_playing && !clock.frozen {
        controls.effective_speed() * active_speed
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
    StepFxPreviewPlaybackStatus {
        instance_id: *instance_id,
        session_id: *session_id,
        sampled_at_epoch_ms,
        elapsed,
        elapsed_speed,
        track_phase_offsets,
    }
}

/// The Step FX editor preview anchors feed; ordinary playbacks are never included.
#[derive(bevy_ecs::system::SystemParam)]
pub(crate) struct StepFxPreviewsFeed<'w, 's> {
    previews: Query<'w, 's, StepFxPreviewPlayback, With<EditorPreviewInstance>>,
}

impl ClientFeed for StepFxPreviewsFeed<'static, 'static> {
    /// Publishes the anchor of every running editor preview, sampled now. Each list is complete,
    /// so a newer one replaces one still queued.
    fn publish(feed: &StepFxPreviewsFeed<'_, '_>, sink: &ClientEventSink) {
        let sampled_at_epoch_ms = current_epoch_ms();
        let statuses: Vec<_> = feed
            .previews
            .iter()
            .map(|preview| step_fx_preview_status(preview, sampled_at_epoch_ms))
            .collect();
        sink.publish(
            DISCRIMINATOR_DROPPABLE,
            &StepFxPreviewWsMessage::StepFxPreviews(&statuses),
        );
    }
}

/// Changes that move a preview's clock anchor straight away. Phase offset corrections are left
/// out because the evaluator touches them every frame; the next re-anchor carries them.
#[derive(bevy_ecs::system::SystemParam)]
pub(crate) struct StepFxPreviewChanges<'w, 's> {
    added: Query<'w, 's, (), (Added<StepFxPreviewSessionId>, With<EditorPreviewInstance>)>,
    removed: RemovedComponents<'w, 's, StepFxPreviewSessionId>,
    controls: Query<'w, 's, (), (Changed<InstanceControls>, With<StepFxPreviewSessionId>)>,
    active: Query<'w, 's, (), (Changed<ActiveStepFx>, With<StepFxPreviewSessionId>)>,
    definitions: Query<'w, 's, (), Changed<PreviewStepFxDefinition>>,
}

/// Run condition that passes when a preview starts, stops or changes what its anchor is built
/// from.
///
/// Runs where removals are still visible, so a stop sends the remaining previews, often none,
/// and consumes the removals so one stop does not pass next update too.
pub(crate) fn step_fx_previews_changed(mut changes: StepFxPreviewChanges) -> bool {
    let removed = changes.removed.read().count() > 0;
    removed
        || !changes.added.is_empty()
        || !changes.controls.is_empty()
        || !changes.active.is_empty()
        || !changes.definitions.is_empty()
}

/// Registers the preview feed: sent on change, and re-anchored every [`REANCHOR_INTERVAL`]
/// while a preview runs, after this frame's clocks advanced, so the editor's playhead never
/// drifts far from the backend clock.
pub(crate) fn register(app: &mut bevy_app::App) {
    app.add_client_feed::<StepFxPreviewsFeed>()
        .on_change(step_fx_previews_changed);
    app.add_systems(
        Render,
        publish_client_feed::<StepFxPreviewsFeed>
            .run_if(any_match_filter::<(With<StepFxPreviewSessionId>, With<EditorPreviewInstance>)>)
            .run_if(every(REANCHOR_INTERVAL))
            .in_set(ClientOutput),
    );
}

/// Returns the current Unix epoch in milliseconds for browser interpolation anchors.
fn current_epoch_ms() -> f64 {
    web_time::SystemTime::now()
        .duration_since(web_time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1_000.0
}

#[cfg(test)]
mod tests {
    use bevy_ecs::prelude::Entity;
    use nightfall::prelude::Priority;
    use uuid::Uuid;

    use super::*;

    /// Verifies preview projection reports backend elapsed time, speed, identity, and offsets.
    #[test]
    fn step_fx_preview_status_projects_authoritative_runtime_anchor() {
        let instance_id = InstanceId::new();
        let session_id = StepFxPreviewSessionId(Uuid::from_u128(0x730));
        let active_step_fx = ActiveStepFx {
            fx_entity: Entity::PLACEHOLDER,
            priority: Priority::default(),
            speed: 2.0,
            is_playing: true,
        };
        let clock = InstanceClock {
            position: Duration::from_millis(750),
            ..Default::default()
        };
        let controls = InstanceControls {
            speed: 0.5,
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
            (
                &instance_id,
                &active_step_fx,
                &session_id,
                &clock,
                Some(&phase_offsets),
                &controls,
            ),
            42_000.0,
        );

        assert_eq!(status.instance_id, instance_id);
        assert_eq!(status.session_id, session_id);
        assert_eq!(status.sampled_at_epoch_ms, 42_000.0);
        assert_eq!(status.elapsed, Duration::from_millis(1500));
        assert_eq!(status.elapsed_speed, 1.0);
        assert_eq!(status.track_phase_offsets.len(), 1);
        assert_eq!(status.track_phase_offsets[0].attribute, Attribute::Pan);
        assert_eq!(status.track_phase_offsets[0].absolute, 0.25);
        assert_eq!(status.track_phase_offsets[0].relative, 0.75);
    }

    /// Spawns a running Step FX playback for session `session`, marked as an editor preview
    /// when `preview` is set, and returns its playback id.
    fn spawn_step_fx_playback(world: &mut World, session: u128, preview: bool) -> InstanceId {
        let instance_id = InstanceId::new();
        let mut entity = world.spawn((
            instance_id,
            ActiveStepFx::default(),
            StepFxPreviewSessionId(Uuid::from_u128(session)),
            InstanceClock::default(),
            InstanceControls::default(),
        ));
        if preview {
            entity.insert(EditorPreviewInstance);
        }
        instance_id
    }

    /// Decodes every buffered `StepFxPreviews` message into its list of statuses.
    fn sent_previews(
        receiver: &async_channel::Receiver<OutboundFrame>,
    ) -> Vec<Vec<serde_json::Value>> {
        std::iter::from_fn(|| receiver.try_recv().ok())
            .map(|frame| {
                let message: serde_json::Value = minicbor_serde::from_slice(&frame.bytes[1..])
                    .expect("client message should decode");
                assert_eq!(message["type"], "StepFxPreviews");
                message["data"].as_array().expect("a status list").clone()
            })
            .collect()
    }

    /// Verifies the feed reports only editor previews, keyed by their playback, sends an empty
    /// list once the last preview stops, and stops re-anchoring then.
    #[test]
    fn preview_feed_reports_editor_previews_until_they_stop() {
        let mut app = bevy_app::App::new();
        let (sender, receiver) = async_channel::unbounded();
        app.insert_resource(ClientEventSink::new(sender));
        app.add_systems(
            bevy_app::Update,
            publish_client_feed::<StepFxPreviewsFeed>.run_if(step_fx_previews_changed),
        );
        app.add_systems(
            bevy_app::PostUpdate,
            publish_client_feed::<StepFxPreviewsFeed>
                .run_if(
                    any_match_filter::<(With<StepFxPreviewSessionId>, With<EditorPreviewInstance>)>,
                )
                .run_if(every(REANCHOR_INTERVAL)),
        );

        let preview = spawn_step_fx_playback(app.world_mut(), 0x740, true);
        spawn_step_fx_playback(app.world_mut(), 0x741, false);
        app.update();
        let sent = sent_previews(&receiver);
        assert_eq!(
            sent.len(),
            2,
            "the start and the first re-anchor are both sent"
        );
        assert!(sent.iter().all(|statuses| statuses.len() == 1));
        assert_eq!(
            sent[0][0]["instance_id"],
            serde_json::to_value(preview).expect("playback id serializes")
        );

        let entity = app
            .world_mut()
            .query::<(Entity, &InstanceId)>()
            .iter(app.world())
            .find_map(|(entity, id)| (*id == preview).then_some(entity))
            .expect("preview playback exists");
        app.world_mut().despawn(entity);
        app.update();
        assert_eq!(
            sent_previews(&receiver),
            vec![Vec::<serde_json::Value>::new()]
        );

        app.update();
        assert!(sent_previews(&receiver).is_empty());
    }
}
