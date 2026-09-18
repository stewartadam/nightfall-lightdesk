// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Active playback and backend-owned control projection.

use super::*;

/// Playback components projected into websocket instance snapshots.
pub(super) type InstanceSnapshotData = (
    &'static InstanceId,
    &'static InstanceMetadata,
    &'static InstanceControls,
    Option<&'static InstanceStatus>,
    Option<&'static InstanceClock>,
    Option<&'static LayerCompositingContext>,
    Option<&'static Owner>,
    Option<&'static ObjectRefMarker>,
    Option<&'static EditorPreviewInstance>,
    Option<&'static ReleaseMarker>,
    Option<&'static ActiveStepFx>,
    Option<&'static StepFxPreviewSessionId>,
    Option<&'static StepFxLanePhaseOffsets>,
);

/// Send active instances to UI
pub fn send_instances(
    instance_query: Query<InstanceSnapshotData>,
    materialized_clips: Query<&MaterializedClip>,
    clips: Query<&Clip>,
    broadcaster: &ClientEventSink,
) {
    let sampled_at_epoch_ms = current_epoch_ms();
    let instances: Vec<InstanceInfo> = instance_query
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
                preview,
                release_marker,
                active_step_fx,
                step_fx_preview_session,
                step_fx_phase_offsets,
            )| {
                // Find if any MaterializedClip is bound to this playback
                let bound_clip = materialized_clips
                    .iter()
                    .find(|mexec| mexec.attached_instance == *instance_id)
                    .and_then(|mexec| {
                        clips
                            .iter()
                            .find(|clip| clip.identifiers.id == mexec.clip_id)
                            .map(|clip| (mexec.clip_id, clip.priority))
                    });
                let (bound_clip_id, priority) = bound_clip
                    .map(|(clip_id, priority)| (Some(clip_id), Some(priority)))
                    .unwrap_or((None, None));
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
                    is_preview: preview.is_some(),
                    is_releasing: release_marker.is_some(),
                    is_paused: controls.effective_rate() == 0.0
                        || clock.is_some_and(|clock| clock.frozen),
                    release_epoch_ms: release_marker
                        .map(|marker| activation_epoch_ms(marker.start_time)),
                    activation_epoch_ms: clock
                        .and_then(|clock| clock.activation_epoch_ms)
                        .or(status.source_activation_epoch_ms),
                    transition_elapsed,
                    owner_uids: owner.map(|owner| vec![owner.0]).unwrap_or_default(),
                    priority,
                    bound_clip_id,
                    intensity_scale: controls.intensity_scale,
                    rate: controls.rate,
                    rate_master_scale: controls.rate_master_scale,
                    effective_rate: controls.effective_rate(),
                    step_fx_preview: step_fx_preview_status(
                        preview,
                        active_step_fx,
                        step_fx_preview_session,
                        clock,
                        step_fx_phase_offsets,
                        controls,
                        sampled_at_epoch_ms,
                    ),
                    status,
                }
            },
        )
        .collect();
    broadcaster.publish(
        DISCRIMINATOR_DROPPABLE,
        &DeskWsMessage::ActiveInstances(&instances),
    );
    tracing::trace!(
        "Sending {} active instances to websocket clients",
        instances.len()
    );
}

/// Send backend-owned controls to UI
pub fn send_controls(
    controls: &Controls,
    clips: &Query<&Clip>,
    masters: &DataProvider<Master>,
    materialized_clips: &Query<&MaterializedClip>,
    instance_index: &InstanceIndex,
    controls_query: &Query<&InstanceControls>,
    broadcaster: &ClientEventSink,
) {
    let snapshots = controls.snapshots(
        clips,
        masters,
        materialized_clips,
        instance_index,
        controls_query,
    );
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::Controls(&snapshots),
    );
    tracing::trace!("Sending {} controls to websocket clients", snapshots.len());
}

/// Send instances when they spawn, despawn, stop, or update metadata/controls.
pub fn send_instances_on_change(
    instance_query: Query<InstanceSnapshotData>,
    materialized_clips: Query<&MaterializedClip>,
    clips: Query<&Clip>,
    added_instances: Query<&InstanceId, Added<InstanceId>>,
    removed_instances: RemovedComponents<InstanceId>,
    added_release_markers: Query<(), (With<InstanceId>, Added<ReleaseMarker>)>,
    changed_controls: Query<&InstanceControls, Changed<InstanceControls>>,
    changed_metadata: Query<&InstanceMetadata, Changed<InstanceMetadata>>,
    changed_step_fx_previews: Query<(), Changed<PreviewStepFxDefinition>>,
    broadcaster: Res<ClientEventSink>,
) {
    // Send if any instances were added, removed, stopped, or had metadata/control changes.
    if added_instances.is_empty()
        && removed_instances.is_empty()
        && added_release_markers.is_empty()
        && changed_controls.is_empty()
        && changed_metadata.is_empty()
        && changed_step_fx_previews.is_empty()
    {
        return;
    }
    tracing::trace!("Sending instances due to spawn/despawn/release/control/metadata change");
    send_instances(instance_query, materialized_clips, clips, &broadcaster);
}

/// Send controls when backend-owned state or linked playback state changes.
pub fn send_controls_on_change(
    controls: Res<Controls>,
    clips: Query<&Clip>,
    masters: Res<DataProvider<Master>>,
    materialized_clips: Query<&MaterializedClip>,
    added_materialized_clips: Query<(), Added<MaterializedClip>>,
    mut removed_materialized_clips: RemovedComponents<MaterializedClip>,
    instance_index: Res<InstanceIndex>,
    changed_instance_controls: Query<(), Changed<InstanceControls>>,
    controls_query: Query<&InstanceControls>,
    broadcaster: Res<ClientEventSink>,
) {
    let materialized_changed =
        !added_materialized_clips.is_empty() || removed_materialized_clips.read().next().is_some();

    if !controls.is_changed()
        && !masters.is_changed()
        && changed_instance_controls.is_empty()
        && !materialized_changed
    {
        return;
    }

    send_controls(
        &controls,
        &clips,
        &masters,
        &materialized_clips,
        &instance_index,
        &controls_query,
        &broadcaster,
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
