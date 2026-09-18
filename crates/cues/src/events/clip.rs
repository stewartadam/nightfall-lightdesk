// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Clip-to-cue playback adaptation and lifecycle action handling.

use super::*;

/// Groups playback resources used while translating clip commands.
#[derive(SystemParam)]
pub struct ClipPlaybackParams<'w> {
    pending_buffer: ResMut<'w, PendingEngineActionBuffer>,
    instance_index: Option<Res<'w, InstanceIndex>>,
}

/// Finds an clip by numeric ID using the live ECS query.
pub(super) fn find_clip_by_id<'a>(exec_query: &'a Query<&Clip>, id: u32) -> Option<&'a Clip> {
    exec_query.iter().find(|clip| clip.identifiers.id == id)
}

/// Adds cue-domain terminal response helpers to the shared lifecycle responder.
pub(super) trait CueCommandResponseExt {
    /// Finishes a tracked cue-domain command successfully.
    fn succeed_cue(&mut self, correlation_id: uuid::Uuid);

    /// Finishes a tracked cue-domain command with structured failure details.
    fn fail_cue(&mut self, correlation_id: uuid::Uuid, message: String);

    /// Finishes a tracked cue-domain command with serializable output.
    fn succeed_cue_with_output<T: Serialize>(&mut self, correlation_id: uuid::Uuid, output: T);
}

impl CueCommandResponseExt for CommandResponder<'_> {
    fn succeed_cue(&mut self, correlation_id: uuid::Uuid) {
        let command_id = correlation_id.into();
        if !self.is_active(command_id) {
            return;
        }
        if let Err(error) = self.succeed(command_id) {
            tracing::error!(%command_id, %error, "cue_command_completion_failed");
        }
    }

    fn fail_cue(&mut self, correlation_id: uuid::Uuid, message: String) {
        let command_id = correlation_id.into();
        if !self.is_active(command_id) {
            return;
        }
        if let Err(error) = self.fail(
            command_id,
            CommandError::new("cues.command_failed", message),
        ) {
            tracing::error!(%command_id, %error, "cue_command_failure_failed");
        }
    }

    fn succeed_cue_with_output<T: Serialize>(&mut self, correlation_id: uuid::Uuid, output: T) {
        let command_id = correlation_id.into();
        if !self.is_active(command_id) {
            return;
        }
        if let Err(error) = self.succeed_with_output(command_id, output) {
            tracing::error!(%command_id, %error, "cue_command_output_completion_failed");
        }
    }
}

/// Reports an clip command whose stored sequence target no longer exists.
pub(super) fn report_missing_clip_sequence(
    outbound: &mut CommandResponder,
    correlation_id: uuid::Uuid,
    clip: &Clip,
    sequence_uid: uuid::Uuid,
    command_name: &'static str,
    error: &impl std::fmt::Display,
) {
    tracing::warn!(
        clip = %clip.identifiers().uid,
        clip_label = %clip.identifiers().label,
        sequence_uid = %sequence_uid,
        command = command_name,
        error = %error,
        "Clip references a missing sequence target"
    );
    outbound.fail_cue(
        correlation_id,
        format!(
            "Clip '{}' references missing sequence {}",
            clip.identifiers().label,
            sequence_uid
        ),
    );
}

/// Resolves one user-facing cue release reference to concrete cue identities.
pub(super) fn cue_release_uids(
    object_ref: &ObjectRef,
    cue_data_provider: &DataProvider<Cue>,
) -> Result<Vec<Uuid>, CommandError> {
    match object_ref {
        ObjectRef::ById { object_type, id } if *object_type == ObjectType::Cue => cue_data_provider
            .from_id(*id)
            .map(|cue| vec![cue.identifiers.uid])
            .map_err(|error| {
                CommandError::new(
                    "cue.release_not_found",
                    format!("Unable to release cue {id}: {error}"),
                )
            }),
        ObjectRef::ByUid { object_type, uid } if *object_type == ObjectType::Cue => Ok(vec![*uid]),
        _ => Err(CommandError::new(
            "cue.release_unsupported_object",
            format!("Cue release does not support {object_ref}"),
        )),
    }
}

/// Marks materialized instances of the supplied cue identities for release.
pub(super) fn release_cue_instances(
    uids: &[Uuid],
    materialized_cues: &Query<(Entity, &MaterializedCue)>,
    commands: &mut Commands,
) {
    materialized_cues
        .iter()
        .filter(|(_, cue)| uids.contains(&cue.identifiers().uid))
        .for_each(|(entity, cue)| {
            tracing::debug!(uid = %cue.identifiers().uid, "Releasing materialized cue");
            commands.entity(entity).insert(ReleaseMarker::default());
        });
}

/// Couples cue lifecycle action input with its typed internal result channel.
#[derive(SystemParam)]
pub struct CueLifecycleIo<'w, 's> {
    actions: MessageReader<'w, 's, EngineActionEnvelope<CueLifecycleAction>>,
    results: MessageWriter<'w, OperationResult<(), CommandError>>,
}

/// Runtime sequence playback components inspected while adapting clip commands.
type ClipSequencePlaybackView = (
    Entity,
    &'static MaterializedSequence,
    Option<&'static ReleaseMarker>,
    &'static InstanceId,
);

/// Returns whether an clip still owns a materialized sequence playback.
fn clip_has_sequence_playback(
    clip_id: u32,
    materialized_clips: &Query<(Entity, &MaterializedClip)>,
    msequences: &Query<ClipSequencePlaybackView>,
) -> bool {
    materialized_clips.iter().any(|(_, materialized_clip)| {
        materialized_clip.clip_id == clip_id
            && msequences
                .iter()
                .any(|(_, _, _, instance_id)| *instance_id == materialized_clip.attached_instance)
    })
}

/// Encapsulates the complete dependency set for clip-to-cue event adaptation.
#[derive(SystemParam)]
pub struct CueClipEventContext<'w, 's> {
    exec_query: Query<'w, 's, &'static Clip>,
    seq_data_provider: Res<'w, DataProvider<Sequence>>,
    cue_data_provider: Res<'w, DataProvider<Cue>>,
    color_path_data_provider: Option<Res<'w, DataProvider<ColorPath>>>,
    blueprint_data_provider: Option<Res<'w, DataProvider<Blueprint>>>,
    fixture_data_provider: Res<'w, FixtureDataProviderExt>,
    selection_resolver: SpatialSelectionResolver<'w>,
    desk_events: MessageReader<'w, 's, CommandEnvelope<DeskCommand>>,
    cue_lifecycle: CueLifecycleIo<'w, 's>,
    clip_events: MessageReader<'w, 's, EngineActionEnvelope<ClipAction>>,
    outbound: CommandResponder<'w>,
    materialized_cues_for_release: Query<'w, 's, (Entity, &'static MaterializedCue)>,
    msequences: Query<'w, 's, ClipSequencePlaybackView>,
    parameter_query: Query<'w, 's, InstanceRef<'static, Parameter>>,
    materialized_clips: Query<'w, 's, (Entity, &'static MaterializedClip)>,
    clip_playback: ClipPlaybackParams<'w>,
}

/// Adapts clip and cue lifecycle actions into materialized cue-domain playback.
pub fn handle_events(context: CueClipEventContext, mut commands: Commands) {
    let CueClipEventContext {
        exec_query,
        seq_data_provider,
        cue_data_provider,
        color_path_data_provider,
        blueprint_data_provider,
        fixture_data_provider,
        selection_resolver,
        mut desk_events,
        mut cue_lifecycle,
        mut clip_events,
        mut outbound,
        materialized_cues_for_release,
        msequences,
        parameter_query,
        materialized_clips,
        mut clip_playback,
    } = context;
    let playback_is_indexed = |instance_id: &InstanceId| match clip_playback.instance_index.as_ref()
    {
        Some(index) => index.get(instance_id).is_some(),
        None => true,
    };
    let mut detaching_instances = HashSet::new();

    /// Ordered operation to apply when a deferred clip start is flushed.
    enum DeferredClipOperation {
        Go {
            playback_position: Option<Duration>,
        },
        Back {
            playback_position: Option<Duration>,
        },
        Goto {
            position: u32,
            timing: Option<PlaybackReconstructionTiming>,
        },
        RenderAt {
            position: u32,
            timing: PlaybackReconstructionTiming,
        },
    }

    /// Deferred request to start an clip after cue handling completes.
    struct DeferredClipAutostart {
        sequence_uid: uuid::Uuid,
        clip_uid: uuid::Uuid,
        clip_priority: Priority,
        start_timing: Option<PlaybackReconstructionTiming>,
        instance_clock_timing: Option<PlaybackReconstructionTiming>,
        lookahead_enabled: Option<bool>,
        operations: Vec<DeferredClipOperation>,
    }

    let mut deferred_autostarts: HashMap<u32, DeferredClipAutostart> = HashMap::new();
    let mut deferred_releases: Vec<(u32, DeferredClipAutostart, PlaybackReconstructionTiming)> =
        Vec::new();

    for event in clip_events.read() {
        let correlation_id = event
            .command_id
            .map(uuid::Uuid::from)
            .unwrap_or_else(|| event.operation_id.into());
        let undo_id = event
            .undo_id
            .map(uuid::Uuid::from)
            .unwrap_or(correlation_id);
        match &event.action {
            ClipAction::Start(id_expr)
            | ClipAction::StartAtTiming {
                clip_id: id_expr, ..
            } => {
                let start_timing = match &event.action {
                    ClipAction::StartAtTiming { timing, .. } => {
                        Some(sequence_start_timing_from_timeline(*timing))
                    }
                    _ => None,
                };
                let start_lookahead_enabled = match &event.action {
                    ClipAction::StartAtTiming {
                        instance_options, ..
                    } => instance_options.and_then(|options| options.lookahead_enabled),
                    _ => None,
                };
                for id in id_expr.expand() {
                    let Some(clip) = find_clip_by_id(&exec_query, id) else {
                        log_clip_lookup_failure(id, "NoEntities", &exec_query, "StartClip");
                        outbound
                            .fail_cue(correlation_id, format!("Failed to find clip with id: {id}"));
                        continue;
                    };

                    if clip.source.is_none() {
                        tracing::warn!(
                            clip = %clip.identifiers().uid,
                            "Tried to start an clip with no target"
                        );
                        outbound.fail_cue(
                            correlation_id,
                            format!("Clip '{}' has no playback target", clip.identifiers().label),
                        );
                        continue;
                    }
                    let target = clip.source.as_ref().unwrap();

                    if let Source::Sequence(sequence_uid) = target {
                        let sequence = match seq_data_provider.get(*sequence_uid) {
                            Ok(sequence) => sequence,
                            Err(err) => {
                                report_missing_clip_sequence(
                                    &mut outbound,
                                    correlation_id,
                                    clip,
                                    *sequence_uid,
                                    "StartClip",
                                    &err,
                                );
                                continue;
                            }
                        };

                        tracing::debug!(
                            uid = %sequence.identifiers().uid,
                            clip = %clip.identifiers().uid,
                            "Materializing sequence '{}' for clip '{}'",
                            sequence.identifiers().label,
                            clip.identifiers().label
                        );

                        let existing_sequence_playback = materialized_clips
                            .iter()
                            .find(|(_, mexec)| {
                                mexec.clip_id == id
                                    && !detaching_instances.contains(&mexec.attached_instance)
                            })
                            .and_then(|(_, mexec)| {
                                msequences
                                    .iter()
                                    .find(|(_, existing, release_marker, instance_id)| {
                                        **instance_id == mexec.attached_instance
                                            && existing.identifiers().uid == *sequence_uid
                                            && release_marker.is_none()
                                    })
                                    .map(|(entity, _, _, instance_id)| (entity, *instance_id))
                            });

                        if let Some((msequence_entity, instance_id)) = existing_sequence_playback {
                            let mut msequence =
                                MaterializedSequence::materialize_initial_with_sources(
                                    &sequence,
                                    &cue_data_provider,
                                    color_path_data_provider.as_deref(),
                                    blueprint_data_provider.as_deref(),
                                    &fixture_data_provider,
                                    &parameter_query.as_readonly(),
                                    &selection_resolver,
                                );
                            msequence.set_priority(clip.priority);
                            if let Some(timing) = start_timing {
                                msequence.set_sequence_start_timing(timing);
                            }
                            let instance_options =
                                instance_options_for_sequence(&sequence, start_lookahead_enabled);
                            tracing::debug!(
                                uid = %sequence.identifiers().uid,
                                clip = %clip.identifiers().uid,
                                "Updating materialization sequence '{}' on clip '{}'",
                                sequence.identifiers().label,
                                clip.identifiers().label
                            );

                            let instance_clock = start_timing
                                .map(instance_clock_from_reconstruction_timing)
                                .unwrap_or_default();
                            commands
                                .entity(msequence_entity)
                                .insert(msequence)
                                .insert(instance_options)
                                .insert(instance_clock)
                                .remove::<ReleaseMarker>()
                                .remove::<PlaybackReleaseTiming>();

                            let existing_materialized_clip = materialized_clips
                                .iter()
                                .find(|(_, mexec)| mexec.clip_id == id)
                                .map(|(entity, mexec)| (entity, mexec.attached_instance));
                            let has_materialized_clip = existing_materialized_clip.is_some();
                            let should_respawn_materialized_clip = !has_materialized_clip;

                            if let Some((mexec_entity, attached_instance)) =
                                existing_materialized_clip
                            {
                                commands.entity(mexec_entity).try_insert(MaterializedClip {
                                    clip_id: id,
                                    attached_instance,
                                    auto_release_on_stop: false,
                                });
                            }

                            if should_respawn_materialized_clip {
                                tracing::debug!(
                                    clip_id = %id,
                                    instance_id = ?instance_id,
                                    "Spawning MaterializedClip for restarted sequence clip"
                                );
                                commands.spawn(MaterializedClip {
                                    clip_id: id,
                                    attached_instance: instance_id,
                                    auto_release_on_stop: false,
                                });
                            }
                        } else {
                            // If not, defer creation to end-of-system so any same-tick
                            // GoClip commands can be coalesced into one materialization.
                            tracing::debug!(
                                uid = %sequence.identifiers().uid,
                                clip = %clip.identifiers().uid,
                                "Deferring materialization sequence '{}' on clip '{}'",
                                sequence.identifiers().label,
                                clip.identifiers().label
                            );

                            deferred_autostarts
                                .entry(id)
                                .and_modify(|deferred| {
                                    deferred.sequence_uid = sequence.identifiers().uid;
                                    deferred.clip_uid = clip.identifiers().uid;
                                    deferred.clip_priority = clip.priority;
                                    deferred.start_timing = start_timing;
                                    deferred.instance_clock_timing = start_timing;
                                    deferred.lookahead_enabled = start_lookahead_enabled;
                                })
                                .or_insert(DeferredClipAutostart {
                                    sequence_uid: sequence.identifiers().uid,
                                    clip_uid: clip.identifiers().uid,
                                    clip_priority: clip.priority,
                                    start_timing,
                                    instance_clock_timing: start_timing,
                                    lookahead_enabled: start_lookahead_enabled,
                                    operations: Vec::new(),
                                });
                        }
                        outbound.succeed_cue(correlation_id);
                    }
                }
            }

            ClipAction::Stop(id_expr)
            | ClipAction::StopAtTiming {
                clip_id: id_expr, ..
            } => {
                let stop_timing = match &event.action {
                    ClipAction::StopAtTiming { timing, .. } => Some(*timing),
                    _ => None,
                };
                for id in id_expr.expand() {
                    let Some(clip) = find_clip_by_id(&exec_query, id) else {
                        log_clip_lookup_failure(id, "NoEntities", &exec_query, "StopClip");
                        outbound
                            .fail_cue(correlation_id, format!("Failed to find clip with id: {id}"));
                        continue;
                    };
                    let owns_sequence_playback =
                        clip_has_sequence_playback(id, &materialized_clips, &msequences);
                    if !matches!(clip.source, Some(Source::Sequence(_))) && !owns_sequence_playback
                    {
                        continue;
                    }

                    if let Some(deferred) = deferred_autostarts.remove(&id) {
                        if let Some(timing) = stop_timing {
                            tracing::debug!(
                                clip_id = %id,
                                "Materializing deferred autostart/go as releasing sequence due to timed stop in same tick"
                            );
                            deferred_releases.push((id, deferred, timing));
                        } else {
                            tracing::debug!(
                                clip_id = %id,
                                "Cancelling deferred autostart/go due to stop in same tick"
                            );
                        }
                    }

                    let instance_ids_to_cancel: HashSet<InstanceId> = materialized_clips
                        .iter()
                        .filter_map(|(_, mexec)| {
                            if mexec.clip_id == id && playback_is_indexed(&mexec.attached_instance)
                            {
                                Some(mexec.attached_instance)
                            } else {
                                None
                            }
                        })
                        .collect();
                    detaching_instances.extend(instance_ids_to_cancel.iter().copied());
                    if !instance_ids_to_cancel.is_empty() {
                        let retained = clip_playback
                            .pending_buffer
                            .drain()
                            .into_iter()
                            .filter(|pending_cmd| {
                                let should_cancel = pending_cmd
                                    .action
                                    .as_any()
                                    .downcast_ref::<SequencePlaybackAction>()
                                    .is_some_and(|sequence_cmd| match sequence_cmd {
                                        SequencePlaybackAction::Go { instance_id }
                                        | SequencePlaybackAction::Back { instance_id }
                                        | SequencePlaybackAction::Goto { instance_id, .. }
                                        | SequencePlaybackAction::RenderAt {
                                            instance_id, ..
                                        }
                                        | SequencePlaybackAction::Stop { instance_id } => {
                                            instance_ids_to_cancel.contains(instance_id)
                                        }
                                    });
                                !should_cancel
                            })
                            .collect::<Vec<_>>();
                        for cmd in retained {
                            clip_playback.pending_buffer.push(cmd);
                        }
                    }

                    for (entity, _, _, instance_id) in msequences.iter() {
                        if instance_ids_to_cancel.contains(instance_id) {
                            tracing::debug!(
                                instance_id = ?instance_id,
                                clip = %clip.identifiers().uid,
                                "Releasing materialized sequence for clip"
                            );

                            commands.entity(entity).insert(ReleaseMarker::default());
                            if let Some(timing) = stop_timing {
                                commands
                                    .entity(entity)
                                    .insert(instance_clock_from_reconstruction_timing(timing))
                                    .insert(PlaybackReleaseTiming {
                                        released_at: timing.started_at,
                                    });
                            }
                        }
                    }

                    for (mexec_entity, mexec) in materialized_clips.iter() {
                        if mexec.clip_id == id && playback_is_indexed(&mexec.attached_instance) {
                            if clip.options.auto_release {
                                commands.spawn(ClipReleaseAfterInstance {
                                    clip_id: mexec.clip_id,
                                    attached_instance: mexec.attached_instance,
                                });
                            }
                            commands.entity(mexec_entity).despawn();
                        }
                    }
                    outbound.succeed_cue(correlation_id);
                }
            }

            ClipAction::Go(id_expr) => {
                for id in id_expr.expand() {
                    if let Some(deferred) = deferred_autostarts.get_mut(&id) {
                        let playback_position = deferred.start_timing.map(|timing| timing.position);
                        deferred
                            .operations
                            .push(DeferredClipOperation::Go { playback_position });
                        tracing::debug!(
                            clip_id = %id,
                            operation_count = deferred.operations.len(),
                            "Coalescing GoClip into deferred autostart in this tick"
                        );
                        outbound.succeed_cue(correlation_id);
                        continue;
                    }

                    let Some(clip) = find_clip_by_id(&exec_query, id) else {
                        log_clip_lookup_failure(id, "NoEntities", &exec_query, "GoClip");
                        outbound.fail_cue(
                            correlation_id,
                            format!("Failed to find clip with id: {:?}", id),
                        );
                        continue;
                    };

                    // Check that clip has a sequence source
                    let sequence_uid = match &clip.source {
                        Some(Source::Sequence(uid)) => *uid,
                        Some(other_executable) => {
                            tracing::error!(
                                clip_label = %clip.identifiers.label,
                                target = ?other_executable,
                                "Cannot use 'go' on clip because it is not targeting a sequence"
                            );
                            outbound.fail_cue(
                                correlation_id,
                                format!(
                                    "Clip '{}' is not targeting a sequence",
                                    clip.identifiers.label
                                ),
                            );
                            continue;
                        }
                        None => {
                            tracing::error!(
                                "Cannot use 'go' on clip '{}': clip has no target",
                                clip.identifiers.label
                            );
                            outbound.fail_cue(
                                correlation_id,
                                format!("Clip '{}' has no target assigned", clip.identifiers.label),
                            );
                            continue;
                        }
                    };

                    // Find the MaterializedClip to get the instance_id
                    let instance_id = materialized_clips
                        .iter()
                        .find(|(_, mexec)| {
                            mexec.clip_id == id
                                && playback_is_indexed(&mexec.attached_instance)
                                && !detaching_instances.contains(&mexec.attached_instance)
                        })
                        .map(|(entity, mexec)| {
                            commands.entity(entity).try_insert(MaterializedClip {
                                clip_id: id,
                                attached_instance: mexec.attached_instance,
                                auto_release_on_stop: false,
                            });
                            mexec.attached_instance
                        });

                    match instance_id {
                        Some(instance_id) => {
                            // Delegate to SequencePlaybackAction with same undo_id for unified undo
                            let delegated_cmd = DynEngineActionEnvelope::with_context(
                                OperationId::new(),
                                event.command_id,
                                event.undo_id,
                                Box::new(SequencePlaybackAction::Go { instance_id }),
                            );
                            clip_playback.pending_buffer.push(delegated_cmd);

                            tracing::debug!(
                                clip_id = %id,
                                instance_id = ?instance_id,
                                undo_id = ?undo_id,
                                "Delegating GoClip to SequencePlaybackAction::Go"
                            );
                        }
                        None => {
                            if let Err(err) = seq_data_provider.get(sequence_uid) {
                                report_missing_clip_sequence(
                                    &mut outbound,
                                    correlation_id,
                                    clip,
                                    sequence_uid,
                                    "GoClip",
                                    &err,
                                );
                                continue;
                            }
                            deferred_autostarts.insert(
                                id,
                                DeferredClipAutostart {
                                    sequence_uid,
                                    clip_uid: clip.identifiers().uid,
                                    clip_priority: clip.priority,
                                    start_timing: None,
                                    instance_clock_timing: None,
                                    lookahead_enabled: None,
                                    operations: vec![DeferredClipOperation::Go {
                                        playback_position: None,
                                    }],
                                },
                            );

                            tracing::debug!(
                                clip_id = %id,
                                "Clip was not running; deferred autostart/go for end-of-system flush"
                            );
                            outbound.succeed_cue(correlation_id);
                        }
                    }
                }
            }

            ClipAction::Back(clip_id_expr) => {
                for clip_id in clip_id_expr.expand() {
                    if let Some(deferred) = deferred_autostarts.get_mut(&clip_id) {
                        deferred.operations.push(DeferredClipOperation::Back {
                            playback_position: deferred.start_timing.map(|timing| timing.position),
                        });
                        tracing::debug!(
                            clip_id = %clip_id,
                            operation_count = deferred.operations.len(),
                            "Coalescing back into deferred autostart in this tick"
                        );
                        outbound.succeed_cue(correlation_id);
                        continue;
                    }

                    let Some(clip) = find_clip_by_id(&exec_query, clip_id) else {
                        log_clip_lookup_failure(clip_id, "NoEntities", &exec_query, "BackClip");
                        outbound.fail_cue(
                            correlation_id,
                            format!("Failed to find clip with id: {:?}", clip_id),
                        );
                        continue;
                    };

                    let sequence_uid = match &clip.source {
                        Some(Source::Sequence(uid)) => *uid,
                        Some(other_executable) => {
                            tracing::error!(
                                clip_label = %clip.identifiers.label,
                                target = ?other_executable,
                                "Cannot use 'back' on clip because it is not targeting a sequence"
                            );
                            outbound.fail_cue(
                                correlation_id,
                                format!(
                                    "Clip '{}' is not targeting a sequence",
                                    clip.identifiers.label
                                ),
                            );
                            continue;
                        }
                        None => {
                            tracing::error!(
                                "Cannot use 'back' on clip '{}': clip has no target",
                                clip.identifiers.label
                            );
                            outbound.fail_cue(
                                correlation_id,
                                format!("Clip '{}' has no target assigned", clip.identifiers.label),
                            );
                            continue;
                        }
                    };

                    let instance_id = materialized_clips
                        .iter()
                        .find(|(_, mexec)| {
                            mexec.clip_id == clip_id
                                && playback_is_indexed(&mexec.attached_instance)
                                && !detaching_instances.contains(&mexec.attached_instance)
                        })
                        .map(|(_, mexec)| mexec.attached_instance);

                    match instance_id {
                        Some(instance_id) => {
                            let delegated_cmd = DynEngineActionEnvelope::with_context(
                                OperationId::new(),
                                event.command_id,
                                event.undo_id,
                                Box::new(SequencePlaybackAction::Back { instance_id }),
                            );
                            clip_playback.pending_buffer.push(delegated_cmd);

                            tracing::debug!(
                                clip_id = %clip_id,
                                instance_id = ?instance_id,
                                undo_id = ?undo_id,
                                "Delegating BackClip to SequencePlaybackAction::Back"
                            );
                        }
                        None => {
                            if let Err(err) = seq_data_provider.get(sequence_uid) {
                                report_missing_clip_sequence(
                                    &mut outbound,
                                    correlation_id,
                                    clip,
                                    sequence_uid,
                                    "BackClip",
                                    &err,
                                );
                                continue;
                            }
                            deferred_autostarts.insert(
                                clip_id,
                                DeferredClipAutostart {
                                    sequence_uid,
                                    clip_uid: clip.identifiers().uid,
                                    clip_priority: clip.priority,
                                    start_timing: None,
                                    instance_clock_timing: None,
                                    lookahead_enabled: None,
                                    operations: vec![DeferredClipOperation::Back {
                                        playback_position: None,
                                    }],
                                },
                            );

                            tracing::debug!(
                                clip_id = %clip_id,
                                "Clip was not running; deferred autostart/back for end-of-system flush"
                            );
                            outbound.succeed_cue(correlation_id);
                        }
                    }
                }
            }

            ClipAction::Goto {
                clip_id: clip_id_expr,
                position,
                timing,
            } => {
                for clip_id in clip_id_expr.expand() {
                    let Some(clip) = find_clip_by_id(&exec_query, clip_id) else {
                        log_clip_lookup_failure(clip_id, "NoEntities", &exec_query, "GotoClip");
                        outbound.fail_cue(
                            correlation_id,
                            format!("Failed to find clip with id: {:?}", clip_id),
                        );
                        continue;
                    };

                    // Check that clip has a sequence source and validate position bounds
                    let (sequence_uid, sequence_label) = match &clip.source {
                        Some(Source::Sequence(uid)) => {
                            let sequence = match seq_data_provider.get(*uid) {
                                Ok(sequence) => sequence,
                                Err(err) => {
                                    report_missing_clip_sequence(
                                        &mut outbound,
                                        correlation_id,
                                        clip,
                                        *uid,
                                        "GotoClip",
                                        &err,
                                    );
                                    continue;
                                }
                            };
                            let num_cues = sequence.steps.len() as u32;
                            if *position < 1 || *position > num_cues {
                                tracing::error!(
                                    "Cannot jump sequence '{}' to position {} (sequence has {} cues)",
                                    sequence.identifiers.label,
                                    position,
                                    num_cues
                                );
                                outbound.fail_cue(
                                    correlation_id,
                                    format!(
                                        "Position {} is out of bounds (sequence '{}' has {} cues)",
                                        position, sequence.identifiers.label, num_cues
                                    ),
                                );
                                continue;
                            }
                            (*uid, sequence.identifiers.label.clone())
                        }
                        Some(other_executable) => {
                            tracing::error!(
                                clip_label = %clip.identifiers.label,
                                target = ?other_executable,
                                "Cannot use 'goto' on clip because it is not targeting a sequence"
                            );
                            outbound.fail_cue(
                                correlation_id,
                                format!(
                                    "Clip '{}' is not targeting a sequence",
                                    clip.identifiers.label
                                ),
                            );
                            continue;
                        }
                        None => {
                            tracing::error!(
                                "Cannot use 'goto' on clip '{}': clip has no target",
                                clip.identifiers.label
                            );
                            outbound.fail_cue(
                                correlation_id,
                                format!("Clip '{}' has no target assigned", clip.identifiers.label),
                            );
                            continue;
                        }
                    };

                    if let Some(deferred) = deferred_autostarts.get_mut(&clip_id) {
                        deferred.operations.push(DeferredClipOperation::Goto {
                            position: *position,
                            timing: *timing,
                        });
                        if let Some(timing) = timing {
                            deferred.instance_clock_timing = Some(*timing);
                        }
                        tracing::debug!(
                            clip_id = %clip_id,
                            position = %position,
                            operation_count = deferred.operations.len(),
                            "Coalescing GotoClip into deferred autostart in this tick"
                        );
                        outbound.succeed_cue(correlation_id);
                        continue;
                    }

                    // Find the MaterializedClip to get the instance_id
                    let instance_id = materialized_clips
                        .iter()
                        .find(|(_, mexec)| {
                            mexec.clip_id == clip_id
                                && playback_is_indexed(&mexec.attached_instance)
                                && !detaching_instances.contains(&mexec.attached_instance)
                        })
                        .map(|(_, mexec)| mexec.attached_instance);

                    match instance_id {
                        Some(instance_id) => {
                            // Delegate to SequencePlaybackAction with same undo_id for unified undo
                            let delegated_cmd = DynEngineActionEnvelope::with_context(
                                OperationId::new(),
                                event.command_id,
                                event.undo_id,
                                Box::new(SequencePlaybackAction::Goto {
                                    instance_id,
                                    position: *position,
                                    timing: *timing,
                                }),
                            );
                            clip_playback.pending_buffer.push(delegated_cmd);

                            tracing::debug!(
                                clip_id = %clip_id,
                                instance_id = ?instance_id,
                                position = %position,
                                undo_id = ?undo_id,
                                "Delegating GotoClip to SequencePlaybackAction::Goto for sequence '{}'",
                                sequence_label
                            );
                        }
                        None => {
                            deferred_autostarts.insert(
                                clip_id,
                                DeferredClipAutostart {
                                    sequence_uid,
                                    clip_uid: clip.identifiers().uid,
                                    clip_priority: clip.priority,
                                    start_timing: None,
                                    instance_clock_timing: *timing,
                                    lookahead_enabled: None,
                                    operations: vec![DeferredClipOperation::Goto {
                                        position: *position,
                                        timing: *timing,
                                    }],
                                },
                            );

                            tracing::debug!(
                                clip_id = %clip_id,
                                position = %position,
                                "Clip was not running; deferred autostart/goto for sequence '{}'",
                                sequence_label
                            );
                            outbound.succeed_cue(correlation_id);
                        }
                    }
                }
            }

            ClipAction::RenderAt {
                clip_id: clip_id_expr,
                position,
                timing,
                instance_options,
            } => {
                let render_lookahead_enabled =
                    instance_options.and_then(|options| options.lookahead_enabled);
                for clip_id in clip_id_expr.expand() {
                    let Some(clip) = find_clip_by_id(&exec_query, clip_id) else {
                        log_clip_lookup_failure(clip_id, "NoEntities", &exec_query, "RenderClipAt");
                        outbound.fail_cue(
                            correlation_id,
                            format!("Failed to find clip with id: {:?}", clip_id),
                        );
                        continue;
                    };

                    let (sequence_uid, sequence_label) = match &clip.source {
                        Some(Source::Sequence(uid)) => {
                            let sequence = match seq_data_provider.get(*uid) {
                                Ok(sequence) => sequence,
                                Err(err) => {
                                    report_missing_clip_sequence(
                                        &mut outbound,
                                        correlation_id,
                                        clip,
                                        *uid,
                                        "RenderClipAt",
                                        &err,
                                    );
                                    continue;
                                }
                            };
                            let num_cues = sequence.steps.len() as u32;
                            if *position < 1 || *position > num_cues {
                                tracing::error!(
                                    "Cannot render sequence '{}' at position {} (sequence has {} cues)",
                                    sequence.identifiers.label,
                                    position,
                                    num_cues
                                );
                                outbound.fail_cue(
                                    correlation_id,
                                    format!(
                                        "Position {} is out of bounds (sequence '{}' has {} cues)",
                                        position, sequence.identifiers.label, num_cues
                                    ),
                                );
                                continue;
                            }
                            (*uid, sequence.identifiers.label.clone())
                        }
                        Some(other_executable) => {
                            tracing::error!(
                                clip_label = %clip.identifiers.label,
                                target = ?other_executable,
                                "Cannot render clip because it is not targeting a sequence"
                            );
                            outbound.fail_cue(
                                correlation_id,
                                format!(
                                    "Clip '{}' is not targeting a sequence",
                                    clip.identifiers.label
                                ),
                            );
                            continue;
                        }
                        None => {
                            tracing::error!(
                                "Cannot render clip '{}': clip has no target",
                                clip.identifiers.label
                            );
                            outbound.fail_cue(
                                correlation_id,
                                format!("Clip '{}' has no target assigned", clip.identifiers.label),
                            );
                            continue;
                        }
                    };

                    if let Some(deferred) = deferred_autostarts.get_mut(&clip_id) {
                        if render_lookahead_enabled.is_some() {
                            deferred.lookahead_enabled = render_lookahead_enabled;
                        }
                        deferred.operations.push(DeferredClipOperation::RenderAt {
                            position: *position,
                            timing: *timing,
                        });
                        deferred.instance_clock_timing = Some(*timing);
                        tracing::debug!(
                            clip_id = %clip_id,
                            position = %position,
                            operation_count = deferred.operations.len(),
                            "Coalescing RenderClipAt into deferred autostart in this tick"
                        );
                        outbound.succeed_cue(correlation_id);
                        continue;
                    }

                    let instance_id = materialized_clips
                        .iter()
                        .find(|(_, mexec)| {
                            mexec.clip_id == clip_id
                                && playback_is_indexed(&mexec.attached_instance)
                                && !detaching_instances.contains(&mexec.attached_instance)
                        })
                        .map(|(_, mexec)| mexec.attached_instance);

                    match instance_id {
                        Some(instance_id) => {
                            let delegated_cmd = DynEngineActionEnvelope::with_context(
                                OperationId::new(),
                                event.command_id,
                                event.undo_id,
                                Box::new(SequencePlaybackAction::RenderAt {
                                    instance_id,
                                    position: *position,
                                    timing: *timing,
                                }),
                            );
                            clip_playback.pending_buffer.push(delegated_cmd);

                            tracing::debug!(
                                clip_id = %clip_id,
                                instance_id = ?instance_id,
                                position = %position,
                                undo_id = ?undo_id,
                                "Delegating RenderClipAt to SequencePlaybackAction::RenderAt for sequence '{}'",
                                sequence_label
                            );
                        }
                        None => {
                            deferred_autostarts.insert(
                                clip_id,
                                DeferredClipAutostart {
                                    sequence_uid,
                                    clip_uid: clip.identifiers().uid,
                                    clip_priority: clip.priority,
                                    start_timing: None,
                                    instance_clock_timing: Some(*timing),
                                    lookahead_enabled: render_lookahead_enabled,
                                    operations: vec![DeferredClipOperation::RenderAt {
                                        position: *position,
                                        timing: *timing,
                                    }],
                                },
                            );

                            tracing::debug!(
                                clip_id = %clip_id,
                                position = %position,
                                "Clip was not running; deferred autostart/render for sequence '{}'",
                                sequence_label
                            );
                            outbound.succeed_cue(correlation_id);
                        }
                    }
                }
            }

            _ => {}
        }
    }

    for (clip_id, deferred) in deferred_autostarts {
        let sequence = match seq_data_provider.get(deferred.sequence_uid) {
            Ok(sequence) => sequence,
            Err(err) => {
                tracing::warn!(
                    clip_id = %clip_id,
                    sequence_uid = %deferred.sequence_uid,
                    error = %err,
                    "Skipping deferred clip autostart because the sequence target is missing"
                );
                continue;
            }
        };
        let mut msequence = MaterializedSequence::materialize_initial_with_sources(
            &sequence,
            &cue_data_provider,
            color_path_data_provider.as_deref(),
            blueprint_data_provider.as_deref(),
            &fixture_data_provider,
            &parameter_query.as_readonly(),
            &selection_resolver,
        );
        msequence.set_priority(deferred.clip_priority);
        if let Some(timing) = deferred.start_timing {
            msequence.set_sequence_start_timing(timing);
        }
        let instance_options = instance_options_for_sequence(&sequence, deferred.lookahead_enabled);

        for operation in &deferred.operations {
            match operation {
                DeferredClipOperation::Go { playback_position } => {
                    msequence.materialize_next_step_with_sources(
                        color_path_data_provider.as_deref(),
                        blueprint_data_provider.as_deref(),
                        &fixture_data_provider,
                        &parameter_query.as_readonly(),
                        &selection_resolver,
                    );
                    msequence.next_at_playback_position(*playback_position);
                }
                DeferredClipOperation::Back { playback_position } => {
                    msequence.materialize_previous_step_with_sources(
                        color_path_data_provider.as_deref(),
                        blueprint_data_provider.as_deref(),
                        &fixture_data_provider,
                        &parameter_query.as_readonly(),
                        &selection_resolver,
                    );
                    msequence.prev_at_playback_position(*playback_position);
                }
                DeferredClipOperation::Goto { position, timing } => {
                    msequence.materialize_through_position_with_sources(
                        *position,
                        color_path_data_provider.as_deref(),
                        blueprint_data_provider.as_deref(),
                        &fixture_data_provider,
                        &parameter_query.as_readonly(),
                        &selection_resolver,
                    );
                    if let Some(timing) = timing {
                        msequence
                            .set_position_at_playback_position(*position, Some(timing.started_at));
                    } else {
                        msequence.set_position(*position);
                    }
                }
                DeferredClipOperation::RenderAt { position, timing } => {
                    msequence.materialize_through_position_with_sources(
                        *position,
                        color_path_data_provider.as_deref(),
                        blueprint_data_provider.as_deref(),
                        &fixture_data_provider,
                        &parameter_query.as_readonly(),
                        &selection_resolver,
                    );
                    msequence.set_position_at_playback_position(*position, Some(timing.started_at));
                }
            }
        }

        let marker = ObjectRefMarker(ObjectRef::ByUid {
            object_type: ObjectType::Sequence,
            uid: msequence.identifiers().uid,
        });
        let owner = Owner(deferred.clip_uid);
        let instance_id = InstanceId::new();
        let instance_metadata = InstanceMetadata::new(InstanceKind::Sequence)
            .with_name(sequence.identifiers().label.clone());
        let instance_controls = InstanceControls::default();
        let instance_clock = deferred
            .instance_clock_timing
            .map(instance_clock_from_reconstruction_timing)
            .unwrap_or_default();
        let instance_status = msequence.runtime_status_at_clock(Some(&instance_clock));

        commands.spawn((
            msequence,
            marker,
            owner,
            instance_id,
            instance_metadata,
            instance_controls,
            instance_options,
            instance_status,
            instance_clock,
        ));
        commands.spawn(MaterializedClip {
            clip_id,
            attached_instance: instance_id,
            auto_release_on_stop: false,
        });

        tracing::debug!(
            clip_id = %clip_id,
            instance_id = ?instance_id,
            operation_count = deferred.operations.len(),
            "Flushed deferred autostart/go for clip"
        );
    }

    for (clip_id, deferred, stop_timing) in deferred_releases {
        let sequence = match seq_data_provider.get(deferred.sequence_uid) {
            Ok(sequence) => sequence,
            Err(err) => {
                tracing::warn!(
                    clip_id = %clip_id,
                    sequence_uid = %deferred.sequence_uid,
                    error = %err,
                    "Skipping deferred clip release because the sequence target is missing"
                );
                continue;
            }
        };
        let mut msequence = MaterializedSequence::materialize_initial_with_sources(
            &sequence,
            &cue_data_provider,
            color_path_data_provider.as_deref(),
            blueprint_data_provider.as_deref(),
            &fixture_data_provider,
            &parameter_query.as_readonly(),
            &selection_resolver,
        );
        msequence.set_priority(deferred.clip_priority);
        if let Some(timing) = deferred.start_timing {
            msequence.set_current_transition_position(timing.started_at);
        }
        let instance_options = instance_options_for_sequence(&sequence, deferred.lookahead_enabled);

        for operation in &deferred.operations {
            match operation {
                DeferredClipOperation::Go { playback_position } => {
                    msequence.materialize_next_step_with_sources(
                        color_path_data_provider.as_deref(),
                        blueprint_data_provider.as_deref(),
                        &fixture_data_provider,
                        &parameter_query.as_readonly(),
                        &selection_resolver,
                    );
                    msequence.next_at_playback_position(*playback_position);
                }
                DeferredClipOperation::Back { playback_position } => {
                    msequence.materialize_previous_step_with_sources(
                        color_path_data_provider.as_deref(),
                        blueprint_data_provider.as_deref(),
                        &fixture_data_provider,
                        &parameter_query.as_readonly(),
                        &selection_resolver,
                    );
                    msequence.prev_at_playback_position(*playback_position);
                }
                DeferredClipOperation::Goto { position, timing } => {
                    msequence.materialize_through_position_with_sources(
                        *position,
                        color_path_data_provider.as_deref(),
                        blueprint_data_provider.as_deref(),
                        &fixture_data_provider,
                        &parameter_query.as_readonly(),
                        &selection_resolver,
                    );
                    if let Some(timing) = timing {
                        msequence
                            .set_position_at_playback_position(*position, Some(timing.started_at));
                    } else {
                        msequence.set_position(*position);
                    }
                }
                DeferredClipOperation::RenderAt { position, timing } => {
                    msequence.materialize_through_position_with_sources(
                        *position,
                        color_path_data_provider.as_deref(),
                        blueprint_data_provider.as_deref(),
                        &fixture_data_provider,
                        &parameter_query.as_readonly(),
                        &selection_resolver,
                    );
                    msequence.set_position_at_playback_position(*position, Some(timing.started_at));
                }
            }
        }

        let marker = ObjectRefMarker(ObjectRef::ByUid {
            object_type: ObjectType::Sequence,
            uid: msequence.identifiers().uid,
        });
        let owner = Owner(deferred.clip_uid);
        let instance_id = InstanceId::new();
        let instance_metadata = InstanceMetadata::new(InstanceKind::Sequence)
            .with_name(sequence.identifiers().label.clone());
        let instance_controls = InstanceControls::default();
        let instance_clock = instance_clock_from_reconstruction_timing(stop_timing);
        let instance_status = msequence.runtime_status_at_clock(Some(&instance_clock));

        commands.spawn((
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
                released_at: stop_timing.started_at,
            },
        ));

        tracing::debug!(
            clip_id = %clip_id,
            instance_id = ?instance_id,
            operation_count = deferred.operations.len(),
            "Flushed deferred autostart/go as releasing sequence for clip"
        );
    }

    for event in desk_events.read() {
        let DeskCommand::Release(object_ref) = &event.command else {
            continue;
        };
        let result = cue_release_uids(object_ref, &cue_data_provider).map(|uids| {
            release_cue_instances(&uids, &materialized_cues_for_release, &mut commands);
        });
        let completion = match result {
            Ok(()) => outbound.succeed(event.command_id),
            Err(error) => outbound.fail(event.command_id, error),
        };
        if let Err(error) = completion {
            tracing::error!(command_id = %event.command_id, %error, "cue_release_completion_failed");
        }
    }

    for event in cue_lifecycle.actions.read() {
        let CueLifecycleAction::ReleaseCueInstances { uids } = &event.action;
        release_cue_instances(uids, &materialized_cues_for_release, &mut commands);
        cue_lifecycle
            .results
            .write(OperationResult::succeeded(event.operation_id, ()));
    }
}
