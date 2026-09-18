// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_lookahead::Lookahead;

use super::navigation::MAX_AUTONOMOUS_SEQUENCE_ADVANCES_PER_TICK;
use super::*;

/// Sequence instances and output state used to advance playback.
type SequencePlaybackData = (
    Entity,
    &'static mut MaterializedSequence,
    &'static InstanceId,
    Option<&'static OutputLayer>,
    Option<&'static ReleaseMarker>,
    Option<&'static InstanceClock>,
);

/// Sequence instances and authored release clocks used during cleanup.
type ReleasingSequenceData = (
    Entity,
    &'static mut MaterializedSequence,
    Option<&'static InstanceClock>,
    Option<&'static PlaybackReleaseTiming>,
);

/// Releasing sequence instances used to prepare release layers.
type SequenceReleaseLayerData = (
    Entity,
    &'static mut MaterializedSequence,
    &'static ReleaseMarker,
    Option<&'static InstanceClock>,
    Option<&'static InstanceId>,
    Option<&'static PlaybackReleaseTiming>,
);

/// Advances or terminates materialized sequences based on cue trigger metadata.
pub fn advance_sequences(
    mut commands: Commands,
    mut msequences: Query<SequencePlaybackData>,
    materialized_clips: Query<(Entity, &MaterializedClip)>,
    clips: Query<&Clip>,
    materialization: SequenceMaterializationParams,
    mut manual_assertion_layers: Query<&mut Layer, With<ManualAssertionLayer>>,
    preview_controls: Query<
        &nightfall_instances::InstanceControls,
        With<nightfall_instances::EditorPreviewInstance>,
    >,
) {
    for (sequence_entity, mut sequence, instance_id, output_layer, release_marker, clock) in
        msequences.iter_mut()
    {
        if release_marker.is_some() {
            continue;
        }

        if preview_controls
            .get(sequence_entity)
            .is_ok_and(|controls| controls.effective_rate() == 0.0)
        {
            continue;
        }

        if sequence.mcues.is_empty() {
            continue;
        }

        let mut autonomous_advances = 0;
        while autonomous_advances < MAX_AUTONOMOUS_SEQUENCE_ADVANCES_PER_TICK {
            let Some(next_activation_position) =
                sequence.next_autonomous_activation_position(clock)
            else {
                break;
            };
            if let Err(error) = materialization.materialize_next(&mut sequence) {
                tracing::error!(entity=%sequence_entity, %error, "Unable to advance lazy sequence");
                break;
            }
            sequence.next_at_playback_position(next_activation_position);
            autonomous_advances += 1;
        }
        if autonomous_advances > 0 {
            continue;
        }

        if !sequence.auto_end_release_due_at_clock(clock) {
            continue;
        }

        let attached_clips = materialized_clips
            .iter()
            .filter(|(_, mexec)| mexec.attached_instance == *instance_id)
            .collect::<Vec<_>>();
        let deactivating_clips = attached_clips
            .iter()
            .filter_map(|(mexec_entity, mexec)| {
                let clip = clips
                    .iter()
                    .find(|clip| clip.identifiers.id == mexec.clip_id)?;
                clip.options.deactivate_on_sequence_end.then_some((
                    *mexec_entity,
                    mexec.clip_id,
                    clip.options.auto_release,
                ))
            })
            .collect::<Vec<_>>();

        if deactivating_clips.is_empty() {
            continue;
        }

        if deactivating_clips.len() == attached_clips.len() {
            let should_latch_output = deactivating_clips
                .iter()
                .all(|(_, _, auto_release)| !auto_release);
            if should_latch_output {
                if output_layer.is_none() {
                    continue;
                }
                latch_sequence_output(output_layer, &mut manual_assertion_layers);
            }

            let mut entity_commands = commands.entity(sequence_entity);
            entity_commands.insert(ReleaseMarker::default());
            if clock.is_some()
                && let Some(released_at) = sequence.auto_end_release_position()
            {
                entity_commands.insert(PlaybackReleaseTiming { released_at });
            }
        }

        for (mexec_entity, clip_id, auto_release) in deactivating_clips {
            if auto_release {
                commands.spawn(ClipReleaseAfterInstance {
                    clip_id,
                    attached_instance: *instance_id,
                });
            }
            commands.entity(mexec_entity).despawn();
        }
    }
}

/// Latches computed sequence output into the persistent manual assertion layer.
fn latch_sequence_output(
    output_layer: Option<&OutputLayer>,
    manual_assertion_layers: &mut Query<&mut Layer, With<ManualAssertionLayer>>,
) {
    let Some(output_layer) = output_layer else {
        return;
    };
    let Ok(mut manual_layer) = manual_assertion_layers.single_mut() else {
        return;
    };

    for (parameter, value) in output_layer.0.absolute.iter() {
        manual_layer.absolute.insert(
            parameter,
            (ParameterValue::Absolute { value: *value }, None),
        );
    }
}

/// Bevy system that reads materialized sequences and generates rendering instructions layer
pub fn paint_materialized_sequences(
    mut msequence_query: Query<(
        Entity,
        &mut MaterializedSequence,
        Option<&InstanceClock>,
        Option<&InstanceOptions>,
    )>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    mut parameter_queries: ParamSet<(Query<InstanceMut<Parameter>>, SequenceMaterializationParams)>,
    mut commands: Commands,
) {
    for (entity, mut msequence, clock, instance_options) in msequence_query.iter_mut() {
        let instance_options = instance_options.copied().unwrap_or_default();
        if msequence.requires_full_materialization_for_lookahead(
            instance_options,
            parameter_queries.p1().blueprints.as_deref(),
        ) {
            let materialization = parameter_queries.p1();
            if let Err(error) = materialization.materialize_all(&mut msequence) {
                tracing::error!(entity=%entity, %error, "Unable to materialize sequence lookahead");
            }
        }

        let mut param_query = parameter_queries.p0();
        let mut new_layer = msequence.to_layer_at_clock(&mut param_query, clock);
        let lookahead_assertions = msequence.lookahead_assertions(
            Some(&new_layer),
            &fixture_data_provider,
            &param_query,
            instance_options,
        );
        lookahead_assertions.apply_to_layer(&mut new_layer);
        let mut entity_commands = commands.entity(entity);
        entity_commands
            .insert(new_layer)
            .insert(lookahead_assertions);
        if let Some(clock) = clock {
            entity_commands.insert(LayerCompositingContext {
                position: clock.position,
                released_at: msequence.release_started_position(),
            });
        } else {
            entity_commands.remove::<LayerCompositingContext>();
        }
    }
}

/// Keeps generic playback runtime status in sync with sequence cue position.
pub fn sync_sequence_playback_runtime_status(
    mut commands: Commands,
    mut query: Query<(
        Entity,
        &MaterializedSequence,
        Option<&InstanceClock>,
        Option<&mut InstanceStatus>,
    )>,
) {
    for (entity, sequence, clock, status) in query.iter_mut() {
        let next_status = sequence.runtime_status_at_clock(clock);
        if let Some(mut status) = status {
            *status = next_status;
        } else {
            commands.entity(entity).insert(next_status);
        }
    }
}

/// Prepares cues for release when marked
pub fn release_materialized_sequences(
    mut msequences: Query<ReleasingSequenceData, With<ReleaseMarker>>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    mut parameter_queries: ParamSet<(Query<InstanceMut<Parameter>>, SequenceMaterializationParams)>,
) {
    for (entity, mut msequence, clock, release_timing) in msequences.iter_mut() {
        if !msequence.has_release_anchor_for_clock(clock) {
            tracing::debug!(entity=%entity, uid=%msequence.identifiers().uid, "Releasing sequence '{}'", msequence.identifiers().label);
            let has_source_position = release_timing.is_some() || clock.is_some();
            let release_position = release_timing
                .map(|timing| timing.released_at)
                .or_else(|| clock.map(|clock| clock.position))
                .unwrap_or_default();
            if !msequence.is_releasing()
                && (has_source_position || msequence.last_rendered_layer.is_none())
            {
                let materialization = parameter_queries.p1();
                if let Err(error) = materialization
                    .materialize_autonomous_through_position(&mut msequence, release_position)
                {
                    tracing::error!(entity=%entity, %error, "Unable to materialize sequence release position");
                }
                msequence.render_release_snapshot_at_current_position(
                    &mut parameter_queries.p0(),
                    release_position,
                );
            }
            msequence.release_from_rendered_assertions_at_position(
                &fixture_data_provider,
                &parameter_queries.p1().parameters,
                Some(release_position),
            );
        }
    }
}

/// Despawns cues that are due done releasing.
pub fn despawn_materialized_sequences(
    mut commands: Commands,
    mut msequences: Query<SequenceReleaseLayerData, With<ReleaseMarker>>,
    materialized_clips: Query<&MaterializedClip>,
) {
    let release_grace = std::time::Duration::from_millis(10);
    for (entity, msequence, release_marker, clock, instance_id, release_timing) in
        msequences.iter_mut()
    {
        let playback_is_attached = instance_id.is_some_and(|instance_id| {
            materialized_clips
                .iter()
                .any(|materialized_clip| materialized_clip.attached_instance == *instance_id)
        });
        let playback_should_use_marker_elapsed = instance_id.is_some()
            && (clock.is_none() || (!playback_is_attached && release_timing.is_none()));
        let clock_release_elapsed = clock.and_then(|clock| {
            if playback_should_use_marker_elapsed && !playback_is_attached {
                return None;
            }
            msequence
                .release_started_position()
                .map(|released_at| clock.position.saturating_sub(released_at))
        });
        let marker_release_elapsed =
            playback_should_use_marker_elapsed.then(|| release_marker.start_time.elapsed());
        let release_elapsed = match (clock_release_elapsed, marker_release_elapsed) {
            (Some(clock_elapsed), Some(marker_elapsed)) => clock_elapsed.max(marker_elapsed),
            (Some(clock_elapsed), None) => clock_elapsed,
            (None, Some(marker_elapsed)) => marker_elapsed,
            (None, None) => Duration::ZERO,
        };

        // FIXME: std::time::Duration::from_millis(10) is to prevent a race condition that left some fading out parameters at value 1.
        // We should really release a layer in its entirety instead of relying on specific timing.
        if msequence.release_complete(release_grace, release_elapsed) {
            tracing::debug!(entity=%entity, uid=%msequence.identifiers().uid, "Despawning sequence '{}'", msequence.identifiers().label);
            commands.entity(entity).despawn();
        }
    }
}
