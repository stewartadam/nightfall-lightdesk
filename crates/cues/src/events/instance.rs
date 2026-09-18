// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Sequence reconstruction, playback actions, and runtime metadata synchronization.

use super::*;

/// Context from directly materializing a reconstructed sequence playback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MaterializedSequenceReconstructionHandle {
    /// Entity containing the reconstructed `MaterializedSequence`.
    pub sequence_entity: Entity,
    /// Runtime instance ID attached to the reconstructed sequence.
    pub instance_id: InstanceId,
}

/// Resolves runtime playback options from authored sequence data and caller overrides.
pub(super) fn instance_options_for_sequence(
    _sequence: &Sequence,
    lookahead_enabled: Option<bool>,
) -> InstanceOptions {
    InstanceOptions { lookahead_enabled }
}

/// Directly materializes sequence playback reconstruction for a clip.
pub fn spawn_reconstructed_sequence_for_clip(
    commands: &mut Commands,
    clip: &Clip,
    sequence: &Sequence,
    cue_data_provider: &Res<DataProvider<Cue>>,
    color_path_data_provider: Option<&DataProvider<ColorPath>>,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
    fixture_data_provider: &Res<FixtureDataProviderExt>,
    parameter_query: &Query<InstanceRef<Parameter>>,
    selection_resolver: &SpatialSelectionResolver,
    position: u32,
    timing: PlaybackReconstructionTiming,
    lookahead_enabled: Option<bool>,
) -> MaterializedSequenceReconstructionHandle {
    let mut msequence = MaterializedSequence::materialize_with_sources(
        sequence,
        cue_data_provider,
        color_path_data_provider,
        blueprint_data_provider,
        fixture_data_provider,
        &parameter_query.as_readonly(),
        selection_resolver,
    );
    msequence.set_priority(clip.priority);
    msequence.set_position_reconstructing_prefix_at_playback_position(position, timing.started_at);

    let marker = ObjectRefMarker(ObjectRef::ByUid {
        object_type: ObjectType::Sequence,
        uid: sequence.identifiers().uid,
    });
    let owner = Owner(clip.identifiers().uid);
    let instance_id = InstanceId::new();
    let instance_metadata = InstanceMetadata::new(InstanceKind::Sequence)
        .with_name(sequence.identifiers().label.clone());
    let instance_controls = InstanceControls::default();
    let instance_options = instance_options_for_sequence(sequence, lookahead_enabled);
    let instance_clock = instance_clock_from_reconstruction_timing(timing);
    let instance_status = msequence.runtime_status_at_clock(Some(&instance_clock));

    let sequence_entity = commands
        .spawn((
            msequence,
            marker,
            owner,
            instance_id,
            instance_metadata,
            instance_controls,
            instance_options,
            instance_status,
            instance_clock,
        ))
        .id();
    commands.spawn(MaterializedClip {
        clip_id: clip.identifiers.id,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    MaterializedSequenceReconstructionHandle {
        sequence_entity,
        instance_id,
    }
}

/// Directly materializes released sequence playback reconstruction for a clip.
pub fn spawn_released_reconstructed_sequence_for_clip(
    commands: &mut Commands,
    clip: &Clip,
    sequence: &Sequence,
    cue_data_provider: &Res<DataProvider<Cue>>,
    color_path_data_provider: Option<&DataProvider<ColorPath>>,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
    fixture_data_provider: &Res<FixtureDataProviderExt>,
    parameter_mut_query: &mut Query<InstanceMut<Parameter>>,
    parameter_query: &Query<InstanceRef<Parameter>>,
    selection_resolver: &SpatialSelectionResolver,
    position: u32,
    active_started_at: Duration,
    release_timing: PlaybackReconstructionTiming,
    lookahead_enabled: Option<bool>,
) -> MaterializedSequenceReconstructionHandle {
    let mut msequence = MaterializedSequence::materialize_with_sources(
        sequence,
        cue_data_provider,
        color_path_data_provider,
        blueprint_data_provider,
        fixture_data_provider,
        &parameter_query.as_readonly(),
        selection_resolver,
    );
    msequence.set_priority(clip.priority);
    msequence.set_position_reconstructing_prefix_at_playback_position(position, active_started_at);
    msequence.render_release_snapshot_at_position(parameter_mut_query, release_timing.started_at);
    msequence.release_from_rendered_assertions_at_position(
        fixture_data_provider,
        parameter_query,
        Some(release_timing.started_at),
    );

    let marker = ObjectRefMarker(ObjectRef::ByUid {
        object_type: ObjectType::Sequence,
        uid: sequence.identifiers().uid,
    });
    let owner = Owner(clip.identifiers().uid);
    let instance_id = InstanceId::new();
    let instance_metadata = InstanceMetadata::new(InstanceKind::Sequence)
        .with_name(sequence.identifiers().label.clone());
    let instance_controls = InstanceControls::default();
    let instance_options = instance_options_for_sequence(sequence, lookahead_enabled);
    let instance_clock = instance_clock_from_reconstruction_timing(release_timing);
    let instance_status = msequence.runtime_status_at_clock(Some(&instance_clock));

    let sequence_entity = commands
        .spawn((
            msequence,
            marker,
            owner,
            instance_id,
            instance_metadata,
            instance_controls,
            instance_options,
            instance_status,
            ReleaseMarker::default(),
            instance_clock,
            PlaybackReleaseTiming {
                released_at: release_timing.started_at,
            },
        ))
        .id();

    MaterializedSequenceReconstructionHandle {
        sequence_entity,
        instance_id,
    }
}

/// Converts timeline-owned start timing into sequence source-local timing.
pub(super) fn sequence_start_timing_from_timeline(
    timing: PlaybackReconstructionTiming,
) -> PlaybackReconstructionTiming {
    if !matches!(timing.source, PlaybackPositionSource::Timeline { .. }) {
        return timing;
    }

    PlaybackReconstructionTiming {
        started_at: Duration::ZERO,
        position: timing.elapsed(),
        source: timing.source,
    }
}

/// Sequence instance components inspected while deriving display metadata.
type SequenceInstanceMetadataView = (
    Entity,
    &'static MaterializedSequence,
    &'static InstanceMetadata,
    Option<&'static EditorPreviewInstance>,
);

/// Encapsulates mutually exclusive metadata read and write queries.
#[derive(SystemParam)]
pub struct SequenceInstanceMetadataContext<'w, 's> {
    sequence_instances: ParamSet<
        'w,
        's,
        (
            Query<'w, 's, SequenceInstanceMetadataView>,
            Query<'w, 's, &'static mut InstanceMetadata>,
        ),
    >,
}

/// Applies sequence playback actions to materialized sequence instances.
///
/// These actions operate directly on instances by `InstanceId`, preserving the
/// originating undo context when delegated from an `ClipCommand`.
pub fn handle_sequence_playback_actions(
    mut commands: Commands,
    mut events: MessageReader<EngineActionEnvelope<SequencePlaybackAction>>,
    instance_index: Res<InstanceIndex>,
    materialization: SequenceMaterializationParams,
    mut msequence_query: Query<(&mut MaterializedSequence, Option<&mut InstanceClock>)>,
    mut outbound: CommandResponder,
) {
    for event in events.read() {
        let correlation_id = event
            .command_id
            .map(uuid::Uuid::from)
            .unwrap_or_else(|| event.operation_id.into());
        match &event.action {
            SequencePlaybackAction::Go { instance_id } => {
                let Some(entity) = instance_index.get(instance_id) else {
                    tracing::error!(
                        ?instance_id,
                        "SequencePlaybackAction::Go: playback not found"
                    );
                    outbound.fail_cue(
                        correlation_id,
                        format!("Playback not found: {:?}", instance_id),
                    );
                    continue;
                };

                let Ok((mut msequence, clock)) = msequence_query.get_mut(entity) else {
                    tracing::error!(
                        ?instance_id,
                        "SequencePlaybackAction::Go: entity is not a MaterializedSequence"
                    );
                    outbound.fail_cue(
                        correlation_id,
                        format!("Playback is not a sequence: {:?}", instance_id),
                    );
                    continue;
                };

                if let Err(error) = materialization.materialize_next(&mut msequence) {
                    outbound.fail_cue(correlation_id, error.to_owned());
                    continue;
                }
                msequence.next_at_playback_position(clock.as_ref().map(|clock| clock.position));
                tracing::debug!(
                    "SequencePlaybackAction::Go: advanced sequence '{}' to position {}",
                    msequence.sequence.identifiers.label,
                    msequence.position()
                );

                outbound.succeed_cue(correlation_id);
            }

            SequencePlaybackAction::Back { instance_id } => {
                let Some(entity) = instance_index.get(instance_id) else {
                    tracing::error!(
                        ?instance_id,
                        "SequencePlaybackAction::Back: playback not found"
                    );
                    outbound.fail_cue(
                        correlation_id,
                        format!("Playback not found: {:?}", instance_id),
                    );
                    continue;
                };

                let Ok((mut msequence, clock)) = msequence_query.get_mut(entity) else {
                    tracing::error!(
                        ?instance_id,
                        "SequencePlaybackAction::Back: entity is not a MaterializedSequence"
                    );
                    outbound.fail_cue(
                        correlation_id,
                        format!("Playback is not a sequence: {:?}", instance_id),
                    );
                    continue;
                };

                if let Err(error) = materialization.materialize_previous(&mut msequence) {
                    outbound.fail_cue(correlation_id, error.to_owned());
                    continue;
                }
                msequence.prev_at_playback_position(clock.as_ref().map(|clock| clock.position));
                tracing::debug!(
                    "SequencePlaybackAction::Back: moved sequence '{}' to position {}",
                    msequence.sequence.identifiers.label,
                    msequence.position()
                );

                outbound.succeed_cue(correlation_id);
            }

            SequencePlaybackAction::Goto {
                instance_id,
                position,
                timing,
            } => {
                let Some(entity) = instance_index.get(instance_id) else {
                    tracing::error!(
                        ?instance_id,
                        "SequencePlaybackAction::Goto: playback not found"
                    );
                    outbound.fail_cue(
                        correlation_id,
                        format!("Playback not found: {:?}", instance_id),
                    );
                    continue;
                };

                let Ok((mut msequence, clock)) = msequence_query.get_mut(entity) else {
                    tracing::error!(
                        ?instance_id,
                        "SequencePlaybackAction::Goto: entity is not a MaterializedSequence"
                    );
                    outbound.fail_cue(
                        correlation_id,
                        format!("Playback is not a sequence: {:?}", instance_id),
                    );
                    continue;
                };

                if let Err(error) = materialization.materialize_through(&mut msequence, *position) {
                    outbound.fail_cue(correlation_id, error.to_owned());
                    continue;
                }

                if let Some(timing) = timing {
                    msequence.set_position_at_playback_position(*position, Some(timing.started_at));
                    if let Some(mut clock) = clock {
                        *clock = instance_clock_from_reconstruction_timing(*timing);
                    } else {
                        commands
                            .entity(entity)
                            .insert(instance_clock_from_reconstruction_timing(*timing));
                    }
                } else {
                    msequence.set_position_at_playback_position(
                        *position,
                        clock.as_ref().map(|clock| clock.position),
                    );
                }
                tracing::debug!(
                    "SequencePlaybackAction::Goto: set sequence '{}' to position {}",
                    msequence.sequence.identifiers.label,
                    position
                );

                outbound.succeed_cue(correlation_id);
            }

            SequencePlaybackAction::RenderAt {
                instance_id,
                position,
                timing,
            } => {
                let Some(entity) = instance_index.get(instance_id) else {
                    tracing::error!(
                        ?instance_id,
                        "SequencePlaybackAction::RenderAt: playback not found"
                    );
                    outbound.fail_cue(
                        correlation_id,
                        format!("Playback not found: {:?}", instance_id),
                    );
                    continue;
                };

                let Ok((mut msequence, clock)) = msequence_query.get_mut(entity) else {
                    tracing::error!(
                        ?instance_id,
                        "SequencePlaybackAction::RenderAt: entity is not a MaterializedSequence"
                    );
                    outbound.fail_cue(
                        correlation_id,
                        format!("Playback is not a sequence: {:?}", instance_id),
                    );
                    continue;
                };

                if let Err(error) = materialization.materialize_through(&mut msequence, *position) {
                    outbound.fail_cue(correlation_id, error.to_owned());
                    continue;
                }

                msequence.set_position_at_playback_position(*position, Some(timing.started_at));
                if let Some(mut clock) = clock {
                    *clock = instance_clock_from_reconstruction_timing(*timing);
                } else {
                    commands
                        .entity(entity)
                        .insert(instance_clock_from_reconstruction_timing(*timing));
                }
                tracing::debug!(
                    "SequencePlaybackAction::RenderAt: rendered sequence '{}' at position {}",
                    msequence.sequence.identifiers.label,
                    position
                );

                outbound.succeed_cue(correlation_id);
            }

            SequencePlaybackAction::Stop { instance_id } => {
                let Some(entity) = instance_index.get(instance_id) else {
                    tracing::error!(
                        ?instance_id,
                        "SequencePlaybackAction::Stop: playback not found"
                    );
                    outbound.fail_cue(
                        correlation_id,
                        format!("Playback not found: {:?}", instance_id),
                    );
                    continue;
                };

                // Mark the playback for release
                commands.entity(entity).insert(ReleaseMarker::default());
                tracing::debug!(
                    ?instance_id,
                    "SequencePlaybackAction::Stop: marked playback for release"
                );

                outbound.succeed_cue(correlation_id);
            }
        }
    }
}

/// Synchronize sequence playback display metadata from its materialized sequence.
pub fn sync_sequence_instance_metadata(mut context: SequenceInstanceMetadataContext) {
    let sequence_instances = &mut context.sequence_instances;
    let mut pending_updates: Vec<(Entity, String)> = Vec::new();

    for (entity, msequence, metadata, preview) in sequence_instances.p0().iter() {
        let sequence_label = msequence.identifiers().label.clone();
        let desired_name = if preview.is_some() {
            format!("Sequence Preview: {sequence_label}")
        } else {
            sequence_label
        };

        if metadata.name.as_deref() != Some(desired_name.as_str()) {
            pending_updates.push((entity, desired_name));
            tracing::trace!(
                sequence_uid = %msequence.identifiers().uid,
                "Updated sequence playback display metadata"
            );
        }
    }

    let mut instance_metadata = sequence_instances.p1();
    for (entity, desired_name) in pending_updates {
        let Ok(mut metadata) = instance_metadata.get_mut(entity) else {
            continue;
        };
        metadata.name = Some(desired_name);
    }
}
