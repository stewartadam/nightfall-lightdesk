// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The running playbacks feed: what is running, from which clip, at what level and speed.

use std::time::Duration;

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use nightfall::prelude::{ObjectRef, Priority};
use nightfall_compositor::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_instances::{
    EditorPreviewInstance, HeldButtonEffect, InstanceClock, InstanceControls, InstanceDisplayKind,
    InstanceId, InstanceKind, InstanceMetadata, InstanceStatus, Owner, activation_epoch_ms,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Clip, MaterializedClip};

/// How often the playbacks are sent again while nothing structural changes, so positions and
/// transition progress stay current in client views.
pub(crate) const REFRESH_INTERVAL: Duration = Duration::from_millis(100);

/// One running playback as shown to clients.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct InstanceInfo {
    /// Unique runtime identifier for this playback
    pub instance_id: InstanceId,
    /// What kind of playback (Cue, Sequence, Fx, Flow, Programmer)
    pub kind: InstanceKind,
    /// Operator-facing playback type label.
    pub display_kind: InstanceDisplayKind,
    /// Optional display name
    pub name: Option<String>,
    /// Tags associated with this playback
    pub tags: Vec<String>,
    /// Source object that produced this playback, if known.
    pub object_ref: Option<ObjectRef>,
    /// Whether this playback is owned by an editor preview workflow.
    pub is_preview: bool,
    /// Whether this playback is fading out after a stop/release command.
    pub is_releasing: bool,
    /// Whether this playback clock is currently frozen or held at zero speed.
    pub is_paused: bool,
    /// Wall-clock timestamp when this playback began releasing, if applicable.
    pub release_epoch_ms: Option<f64>,
    /// Wall-clock timestamp when this playback was activated, if available.
    pub activation_epoch_ms: Option<f64>,
    /// Source-local elapsed duration for the currently visible transition segment.
    pub transition_elapsed: Option<Duration>,
    /// Owner component UIDs attached to this playback.
    pub owner_uids: Vec<Uuid>,
    /// Playback priority resolved from the bound clip, if available.
    pub priority: Option<Priority>,
    /// ID of the clip bound to this playback, if any
    pub bound_clip_id: Option<u32>,
    /// Current intensity scale (0.0-1.0)
    pub intensity_scale: f32,
    /// Current speed multiplier
    pub speed: f32,
    /// Runtime master scale applied on top of the current speed.
    pub speed_master_scale: f32,
    /// Current effective speed after master scaling.
    pub effective_speed: f64,
    /// How a held fader Flash or Swop changes this playback, if one does.
    pub held_button: Option<HeldButtonEffect>,
    /// Source-specific runtime status.
    pub status: InstanceStatus,
}

/// Playback messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum PlaybackWsMessage<'a> {
    /// Every running playback.
    ActiveInstances(&'a [InstanceInfo]),
}

/// Playback components projected into [`InstanceInfo`].
type InstanceSnapshotData = (
    &'static InstanceId,
    &'static InstanceMetadata,
    &'static InstanceControls,
    Option<&'static InstanceStatus>,
    Option<&'static InstanceClock>,
    Option<&'static LayerCompositingContext>,
    Option<&'static Owner>,
    Option<&'static ObjectRefMarker>,
    Has<EditorPreviewInstance>,
    Option<&'static ReleaseMarker>,
    Option<&'static HeldButtonEffect>,
);

/// State the playbacks feed is built from.
#[derive(SystemParam)]
pub(crate) struct PlaybacksFeed<'w, 's> {
    playbacks: Query<'w, 's, InstanceSnapshotData>,
    materialized_clips: Query<'w, 's, &'static MaterializedClip>,
    clips: Query<'w, 's, &'static Clip>,
}

impl ClientFeed for PlaybacksFeed<'static, 'static> {
    /// Sends every running playback, with the priority and id of the clip each one plays.
    fn publish(feed: &PlaybacksFeed<'_, '_>, sink: &ClientEventSink) {
        let instances: Vec<InstanceInfo> = feed
            .playbacks
            .iter()
            .map(
                |(
                    instance_id,
                    metadata,
                    controls,
                    status,
                    clock,
                    compositing_context,
                    owner,
                    object_ref,
                    is_preview,
                    release_marker,
                    held_button,
                )| {
                    let bound_clip = feed
                        .materialized_clips
                        .iter()
                        .find(|materialized| materialized.attached_instance == *instance_id)
                        .and_then(|materialized| {
                            feed.clips
                                .iter()
                                .find(|clip| clip.identifiers.id == materialized.clip_id)
                                .map(|clip| (materialized.clip_id, clip.priority))
                        });
                    let status = status.cloned().unwrap_or_default();
                    let transition_elapsed = release_marker
                        .and_then(|_| {
                            compositing_context.and_then(|context| context.elapsed_since_release())
                        })
                        .or(status.transition_elapsed);

                    InstanceInfo {
                        instance_id: *instance_id,
                        kind: metadata.kind.clone(),
                        display_kind: metadata.display_kind.clone(),
                        name: metadata.name.clone(),
                        tags: metadata.tags.clone(),
                        object_ref: object_ref.map(|marker| marker.0.clone()),
                        is_preview,
                        is_releasing: release_marker.is_some(),
                        is_paused: controls.effective_speed() == 0.0
                            || clock.is_some_and(|clock| clock.frozen),
                        release_epoch_ms: release_marker
                            .map(|marker| activation_epoch_ms(marker.start_time)),
                        activation_epoch_ms: clock
                            .and_then(|clock| clock.activation_epoch_ms)
                            .or(status.source_activation_epoch_ms),
                        transition_elapsed,
                        owner_uids: owner.map(|owner| vec![owner.0]).unwrap_or_default(),
                        priority: bound_clip.map(|(_, priority)| priority),
                        bound_clip_id: bound_clip.map(|(clip_id, _)| clip_id),
                        intensity_scale: controls.intensity_scale,
                        speed: controls.speed,
                        speed_master_scale: controls.speed_master_scale,
                        effective_speed: controls.effective_speed(),
                        held_button: held_button.copied(),
                        status,
                    }
                },
            )
            .collect();
        sink.publish(
            DISCRIMINATOR_DROPPABLE,
            &PlaybackWsMessage::ActiveInstances(&instances),
        );
    }
}

/// Playback changes that are sent straight away instead of waiting for the next refresh.
#[derive(SystemParam)]
pub(crate) struct PlaybackChanges<'w, 's> {
    added: Query<'w, 's, (), Added<InstanceId>>,
    removed: RemovedComponents<'w, 's, InstanceId>,
    released: Query<'w, 's, (), (With<InstanceId>, Added<ReleaseMarker>)>,
    controls: Query<'w, 's, (), Changed<InstanceControls>>,
    metadata: Query<'w, 's, (), Changed<InstanceMetadata>>,
    held_buttons: Query<'w, 's, (), Changed<HeldButtonEffect>>,
    held_buttons_removed: RemovedComponents<'w, 's, HeldButtonEffect>,
}

/// Run condition that passes when a playback starts, stops, begins releasing, or changes its
/// level, speed, metadata or held-button effect.
///
/// Runs where removals are still visible, so a stopped playback is never missed, and consumes
/// the removals so one stop does not pass next update too.
pub(crate) fn playbacks_changed(mut changes: PlaybackChanges) -> bool {
    let removed = changes.removed.read().count() > 0;
    let held_buttons_removed = changes.held_buttons_removed.read().count() > 0;
    removed
        || held_buttons_removed
        || !changes.added.is_empty()
        || !changes.released.is_empty()
        || !changes.controls.is_empty()
        || !changes.metadata.is_empty()
        || !changes.held_buttons.is_empty()
}
