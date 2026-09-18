// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Handles clip events

use std::collections::{HashMap, HashSet};

use bevy_ecs::{prelude::*, system::SystemState};
use nightfall_clips::ClipSourceRef;
use nightfall_clips::{
    Clip, ClipAction, ClipCommand, ClipLookup, ClipLookupError, MaterializedClip,
    RestoreClipSource, Source, clip_action_from_command, log_clip_lookup_failure,
};
use nightfall_compositor::prelude::ReleaseMarker;
use nightfall_engine::object_registry::{ObjectLookupError, resolve_object};
use nightfall_engine::prelude::*;
use nightfall_flow::events::FlowPlaybackAction;
use nightfall_fx::events::FxPlaybackAction;
#[cfg(feature = "fx-module-host")]
use nightfall_fx_module::events::FxModulePlaybackAction;
use nightfall_instances::{
    ClipInstanceAttachment, ClipInstanceRequest, ClipInstanceStartContext, InstanceClock,
    InstanceControls, InstanceId, InstanceKind, InstanceMetadata, InstanceOptions,
};
use nightfall_playback_planner::PlaybackReconstructionTiming;

use crate::prelude::*;

/// Playback identity and control state used to resolve clip actions.
type ClipPlaybackData = (
    Entity,
    &'static InstanceId,
    &'static InstanceMetadata,
    Option<&'static InstanceControls>,
    Option<&'static ReleaseMarker>,
);

/// Rate commands waiting for their target clip playback to materialize.
#[derive(Default, Resource)]
pub struct PendingClipPlaybackRates(HashMap<u32, f32>);

/// Handles clip source assignment and option updates.
pub fn handle_configuration_commands(
    world: &mut World,
    reader: &mut SystemState<MessageReader<CommandEnvelope<ClipCommand>>>,
    configuration: &mut SystemState<(
        ParamSet<(ClipLookup, Query<&Clip>, Query<&mut Clip>)>,
        CommandResponder,
    )>,
) {
    let events: Vec<_> = reader
        .get_mut(world)
        .expect("clip command messages must be installed")
        .read()
        .cloned()
        .collect();
    for mut event in events {
        if let ClipCommand::AssignSourceById {
            clip_id,
            ref source,
        } = event.command
        {
            match resolve_clip_source(world, source) {
                Ok(source) => event.command = ClipCommand::AssignSource { clip_id, source },
                Err(error) => {
                    let (_, mut responder) = configuration
                        .get_mut(world)
                        .expect("clip command lifecycle must be installed");
                    finish_clip_configuration(&mut responder, event.command_id, Err(error));
                    continue;
                }
            }
        }
        let (mut exec_params, mut responder) = configuration
            .get_mut(world)
            .expect("clip command lifecycle must be installed");
        let result = match &event.command {
            ClipCommand::AssignSource { clip_id, source } => {
                let entity = match exec_params.p0().by_id(*clip_id) {
                    Ok((entity, _)) => entity,
                    Err(error) => {
                        log_clip_lookup_failure(*clip_id, error, &exec_params.p1(), "AssignSource");
                        finish_clip_configuration(
                            &mut responder,
                            event.command_id,
                            Err(CommandError::new(
                                "clip.configuration_not_found",
                                format!("Clip {clip_id} was not found"),
                            )),
                        );
                        continue;
                    }
                };
                tracing::debug!(
                    source = ?source,
                    clip_id,
                    "Assigning source to clip"
                );
                exec_params
                    .p2()
                    .get_mut(entity)
                    .map(|mut clip| clip.source = Some(source.clone()))
                    .map_err(|error| {
                        CommandError::new(
                            "clip.configuration_failed",
                            format!("Failed to update clip {clip_id}: {error}"),
                        )
                    })
            }

            ClipCommand::ClearSource(clip_id) => {
                let entity = match exec_params.p0().by_id(*clip_id) {
                    Ok((entity, _)) => entity,
                    Err(error) => {
                        log_clip_lookup_failure(*clip_id, error, &exec_params.p1(), "ClearSource");
                        finish_clip_configuration(
                            &mut responder,
                            event.command_id,
                            Err(CommandError::new(
                                "clip.configuration_not_found",
                                format!("Clip {clip_id} was not found"),
                            )),
                        );
                        continue;
                    }
                };
                tracing::debug!("Clearing source from clip {}", clip_id);
                exec_params
                    .p2()
                    .get_mut(entity)
                    .map(|mut clip| clip.source = None)
                    .map_err(|error| {
                        CommandError::new(
                            "clip.configuration_failed",
                            format!("Failed to update clip {clip_id}: {error}"),
                        )
                    })
            }

            ClipCommand::UpdateClipOptions { clip_id, options } => {
                let entity = match exec_params.p0().by_id(*clip_id) {
                    Ok((entity, _)) => entity,
                    Err(error) => {
                        log_clip_lookup_failure(
                            *clip_id,
                            error,
                            &exec_params.p1(),
                            "UpdateClipOptions",
                        );
                        finish_clip_configuration(
                            &mut responder,
                            event.command_id,
                            Err(CommandError::new(
                                "clip.configuration_not_found",
                                format!("Clip {clip_id} was not found"),
                            )),
                        );
                        continue;
                    }
                };
                tracing::debug!(
                    clip_id,
                    options = ?options,
                    "Updating clip options"
                );
                exec_params
                    .p2()
                    .get_mut(entity)
                    .map(|mut clip| clip.options = options.clone())
                    .map_err(|error| {
                        CommandError::new(
                            "clip.configuration_failed",
                            format!("Failed to update clip {clip_id}: {error}"),
                        )
                    })
            }

            _ => continue,
        };

        finish_clip_configuration(&mut responder, event.command_id, result);
    }
}

/// Resolves object identity through engine infrastructure, then applies clip source eligibility.
fn resolve_clip_source(
    world: &mut World,
    reference: &ClipSourceRef,
) -> Result<Source, CommandError> {
    let identity = resolve_object(world, &reference.into()).map_err(|error| {
        let code = match error {
            ObjectLookupError::Unsupported => "clip.source_kind_unsupported",
            ObjectLookupError::Missing => "clip.source_not_found",
            ObjectLookupError::Ambiguous => "clip.source_ambiguous",
            ObjectLookupError::Unavailable => "clip.source_resolver_unavailable",
        };
        CommandError::new(code, format!("Cannot resolve {reference:?}: {error:?}"))
    })?;
    Source::try_from(identity).map_err(|error| {
        CommandError::new(
            "clip.source_kind_unsupported",
            format!("Object kind {:?} cannot be assigned to a clip", error.0),
        )
    })
}

/// Publishes one clip configuration outcome through the command lifecycle.
fn finish_clip_configuration(
    responder: &mut CommandResponder,
    command_id: CommandId,
    result: Result<(), CommandError>,
) {
    let completion = match result {
        Ok(()) => responder.succeed(command_id),
        Err(error) => responder.fail(command_id, error),
    };
    if let Err(error) = completion {
        tracing::error!(%command_id, %error, "clip_configuration_completion_failed");
    }
}

/// Handles CRUD events for clips
pub fn crud_events(
    mut commands: Commands,
    mut execs: ParamSet<(ClipLookup, Query<&mut Clip>)>,
    mut materialized_clips: Query<(Entity, &mut MaterializedClip)>,
    instances: Query<(
        Entity,
        &InstanceId,
        Option<&InstanceControls>,
        Option<&ReleaseMarker>,
    )>,
    mut events: MessageReader<CommandEnvelope<ClipCommand>>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        use crate::object_crud::ObjectCrud;

        // Handle Store
        if let Some(clip) = Clip::extract_store(&event.command) {
            tracing::debug!("Storing clip with ID: {}", clip.identifiers.id);

            if let Ok((entity, _)) = execs.p0().by_uid(clip.identifiers.uid) {
                let id_collision = match execs.p0().by_id(clip.identifiers.id) {
                    Ok((id_entity, _)) => id_entity != entity,
                    Err(ClipLookupError::NoEntities) => false,
                    Err(ClipLookupError::MultipleEntities) => true,
                };
                if id_collision {
                    tracing::warn!(
                        "Failed to store clip {}: ID already exists",
                        clip.identifiers.id
                    );
                    fail_clip_crud(
                        &mut responder,
                        event.command_id,
                        "clip.store_id_exists",
                        format!(
                            "Failed to store clip {}: ID already exists",
                            clip.identifiers.id
                        ),
                    );
                    continue;
                }

                let mut exec_query = execs.p1();
                if let Ok(mut existing_clip) = exec_query.get_mut(entity) {
                    *existing_clip = clip;
                }
                succeed_clip_crud(&mut responder, event.command_id);
                continue;
            }

            if !matches!(
                execs.p0().by_id(clip.identifiers.id),
                Err(ClipLookupError::NoEntities)
            ) {
                tracing::warn!(
                    "Failed to store clip {}: ID already exists",
                    clip.identifiers.id
                );
                fail_clip_crud(
                    &mut responder,
                    event.command_id,
                    "clip.store_id_exists",
                    format!(
                        "Failed to store clip {}: ID already exists",
                        clip.identifiers.id
                    ),
                );
                continue;
            }

            commands.spawn(clip);
            succeed_clip_crud(&mut responder, event.command_id);
            continue;
        }

        // Handle Rename
        if let Some((id, new_id)) = Clip::extract_rename(&event.command) {
            tracing::debug!("Renaming clip {} -> {}", id, new_id);
            if !matches!(execs.p0().by_id(new_id), Err(ClipLookupError::NoEntities)) {
                tracing::warn!("Failed to rename clip {} -> {}: already exists", id, new_id);
                fail_clip_crud(
                    &mut responder,
                    event.command_id,
                    "clip.rename_destination_exists",
                    format!("Failed to rename clip {} to {}: already exists", id, new_id),
                );
                continue;
            }
            if let Ok((entity, _)) = execs.p0().by_id(id) {
                let mut exec_query = execs.p1();
                if let Ok(mut clip) = exec_query.get_mut(entity) {
                    clip.set_id(new_id);
                    reassign_materialized_clips_for_renamed_clip(
                        id,
                        new_id,
                        &mut materialized_clips,
                    );
                }
                succeed_clip_crud(&mut responder, event.command_id);
            } else {
                tracing::warn!("Failed to rename clip {} -> {}: not found", id, new_id);
                fail_clip_crud(
                    &mut responder,
                    event.command_id,
                    "clip.rename_not_found",
                    format!("Failed to rename clip {} to {}: not found", id, new_id),
                );
            }
            continue;
        }

        // Handle Delete
        if let Some(id) = Clip::extract_delete(&event.command) {
            tracing::debug!("Deleting clip with ID: {}", id);
            if let Ok((entity, _)) = execs.p0().by_id(id) {
                release_materialized_clips_for_deleted_clip(
                    &mut commands,
                    id,
                    &mut materialized_clips,
                    &instances,
                );
                commands.entity(entity).despawn();
                succeed_clip_crud(&mut responder, event.command_id);
            } else {
                tracing::warn!("Failed to delete clip {}: not found", id);
                fail_clip_crud(
                    &mut responder,
                    event.command_id,
                    "clip.delete_not_found",
                    format!("Failed to delete clip {}: not found", id),
                );
            }
        }
    }
}

/// Reports successful completion for one clip CRUD command.
fn succeed_clip_crud(responder: &mut CommandResponder, command_id: CommandId) {
    if let Err(error) = responder.succeed(command_id) {
        tracing::error!(%error, "clip_crud_completion_failed");
    }
}

/// Reports a structured clip CRUD failure.
fn fail_clip_crud(
    responder: &mut CommandResponder,
    command_id: CommandId,
    code: &'static str,
    message: String,
) {
    if let Err(error) = responder.fail(command_id, CommandError::new(code, message)) {
        tracing::error!(%error, "clip_crud_failure_failed");
    }
}

/// Updates running clip runtime state after its owning clip ID changes.
fn reassign_materialized_clips_for_renamed_clip(
    old_clip_id: u32,
    new_clip_id: u32,
    materialized_clips: &mut Query<(Entity, &mut MaterializedClip)>,
) {
    for (_, mut materialized_clip) in materialized_clips
        .iter_mut()
        .filter(|(_, materialized_clip)| materialized_clip.clip_id == old_clip_id)
    {
        materialized_clip.clip_id = new_clip_id;
    }
}

/// Releases runtime playback state for a deleted clip ID.
fn release_materialized_clips_for_deleted_clip(
    commands: &mut Commands,
    clip_id: u32,
    materialized_clips: &mut Query<(Entity, &mut MaterializedClip)>,
    instances: &Query<(
        Entity,
        &InstanceId,
        Option<&InstanceControls>,
        Option<&ReleaseMarker>,
    )>,
) {
    for (entity, materialized_clip) in materialized_clips
        .iter_mut()
        .filter(|(_, materialized_clip)| materialized_clip.clip_id == clip_id)
    {
        release_playback_by_id(commands, materialized_clip.attached_instance, instances);
        commands.entity(entity).despawn();
    }
}

/// Releases a playback by runtime playback ID and resumes it if it was paused.
fn release_playback_by_id(
    commands: &mut Commands,
    instance_id: InstanceId,
    instances: &Query<(
        Entity,
        &InstanceId,
        Option<&InstanceControls>,
        Option<&ReleaseMarker>,
    )>,
) -> bool {
    for (entity, candidate_id, controls, release_marker) in instances {
        if *candidate_id != instance_id || release_marker.is_some() {
            continue;
        }

        commands.entity(entity).insert(ReleaseMarker::default());
        if let Some(controls) = controls.filter(|controls| controls.rate == 0.0) {
            let mut resumed_controls = controls.clone();
            resumed_controls.rate = 1.0;
            commands.entity(entity).insert(resumed_controls);
        }
        return true;
    }
    false
}

// ============================================================================
// Undo Helper Event Handlers
// ============================================================================

/// Handles RestoreClipSource commands for undo.
pub fn handle_restore_clip_source(
    mut events: MessageReader<EngineActionEnvelope<RestoreClipSource>>,
    mut exec_params: ParamSet<(ClipLookup, Query<&mut Clip>)>,
    mut responder: CommandResponder,
) {
    let mut restorations: Vec<(Entity, Option<Source>, Option<CommandId>)> = Vec::new();

    for event in events.read() {
        let snapshot = &event.action.0;
        tracing::debug!("Restoring clip {} source", snapshot.clip_id);

        if let Ok((entity, _)) = exec_params.p0().by_id(snapshot.clip_id) {
            restorations.push((entity, snapshot.source.clone(), event.command_id));
        } else {
            tracing::warn!(
                "Failed to restore clip source: clip {} not found",
                snapshot.clip_id
            );
            if let Some(command_id) = event.command_id
                && let Err(error) = responder.fail(
                    command_id,
                    CommandError::new(
                        "desk.restore_clip_source_failed",
                        format!("Clip {} was not found", snapshot.clip_id),
                    ),
                )
            {
                tracing::error!(%command_id, %error, "clip_restore_failure_failed");
            }
        }
    }

    // Apply restorations
    for (entity, source, command_id) in restorations {
        if let Ok(mut clip) = exec_params.p1().get_mut(entity) {
            clip.source = source;
            if let Some(command_id) = command_id
                && let Err(error) = responder.succeed(command_id)
            {
                tracing::error!(%command_id, %error, "clip_restore_completion_failed");
            }
        } else if let Some(command_id) = command_id
            && let Err(error) = responder.fail(
                command_id,
                CommandError::new(
                    "desk.restore_clip_source_failed",
                    "Clip disappeared before its source could be restored",
                ),
            )
        {
            tracing::error!(%command_id, %error, "clip_restore_failure_failed");
        }
    }
}

/// Plans live clip ingress commands as concrete runtime actions.
pub fn forward_clip_ingress_actions(
    mut commands: MessageReader<CommandEnvelope<ClipCommand>>,
    mut runtime_actions: MessageWriter<EngineActionEnvelope<ClipAction>>,
) {
    for envelope in commands.read() {
        let Some(action) = clip_action_from_command(&envelope.command) else {
            continue;
        };

        runtime_actions.write(EngineActionEnvelope::for_command(envelope, action));
    }
}

/// Handles clip runtime commands that directly control attached playback rate.
pub fn handle_clip_rate_commands(
    mut events: MessageReader<EngineActionEnvelope<ClipAction>>,
    mut pending_rates: ResMut<PendingClipPlaybackRates>,
    instance_index: Res<InstanceIndex>,
    materialized_clips: Query<&MaterializedClip>,
    mut instances: Query<(
        &InstanceId,
        &mut InstanceControls,
        Option<&mut InstanceClock>,
    )>,
) {
    let pending = std::mem::take(&mut pending_rates.0);
    for (id, rate) in pending {
        if !set_clip_playback_rate(
            id,
            rate,
            &materialized_clips,
            &instance_index,
            &mut instances,
        ) {
            tracing::warn!(
                clip_id = id,
                rate,
                "Dropping queued clip rate command because playback did not materialize"
            );
        }
    }

    let event_batch = events.read().collect::<Vec<_>>();
    let start_batches = event_batch
        .iter()
        .flat_map(|event| {
            clip_start_ids(&event.action)
                .into_iter()
                .map(|id| (event.undo_id, id))
        })
        .collect::<HashSet<_>>();

    for event in event_batch {
        let ClipAction::SetRate { clip_id, rate } = &event.action else {
            continue;
        };

        for id in clip_id.expand() {
            if set_clip_playback_rate(
                id,
                *rate,
                &materialized_clips,
                &instance_index,
                &mut instances,
            ) {
                pending_rates.0.remove(&id);
            } else if start_batches.contains(&(event.undo_id, id)) {
                pending_rates.0.insert(id, *rate);
                tracing::debug!(
                    clip_id = id,
                    rate,
                    undo_id = ?event.undo_id,
                    "Clip rate command queued for same-batch playback materialization"
                );
            } else {
                tracing::warn!(
                    clip_id = id,
                    rate,
                    "Clip rate command ignored because clip has no active playback"
                );
            }
        }
    }
}

fn clip_start_ids(action: &ClipAction) -> Vec<u32> {
    match action {
        ClipAction::Start(clip_id) | ClipAction::StartAtTiming { clip_id, .. } => clip_id.expand(),
        _ => Vec::new(),
    }
}

/// Resolves non-desk clip playback requests into desk-owned runtime actions.
pub fn forward_clip_playback_requests(
    mut requests: MessageReader<RequestEnvelope<ClipInstanceRequest>>,
    mut clip_events: MessageWriter<EngineActionEnvelope<ClipAction>>,
) {
    for request in requests.read() {
        let action = match &request.request {
            ClipInstanceRequest::Start(id_expr) => ClipAction::Start(id_expr.clone()),
            ClipInstanceRequest::Stop(id_expr) => ClipAction::Stop(id_expr.clone()),
            ClipInstanceRequest::Go(id_expr) => ClipAction::Go(id_expr.clone()),
        };
        clip_events.write(EngineActionEnvelope::with_context(
            OperationId::new(),
            request.command_id,
            request.undo_id,
            action,
        ));
    }
}

/// Resolves desk-owned clip commands into domain-owned playback actions.
pub fn route_clip_playback_actions(
    mut commands: Commands,
    mut clip_events: MessageReader<EngineActionEnvelope<ClipAction>>,
    exec_query: Query<&Clip>,
    materialized_clips: Query<(Entity, &MaterializedClip)>,
    instance_query: Query<ClipPlaybackData>,
    mut fx_actions: MessageWriter<EngineActionEnvelope<FxPlaybackAction>>,
    mut flow_actions: MessageWriter<EngineActionEnvelope<FlowPlaybackAction>>,
    #[cfg(feature = "fx-module-host")] mut fx_module_actions: Option<
        MessageWriter<EngineActionEnvelope<FxModulePlaybackAction>>,
    >,
) {
    for event in clip_events.read() {
        match &event.action {
            ClipAction::Start(id_expr)
            | ClipAction::StartAtTiming {
                clip_id: id_expr, ..
            } => {
                let (timing, instance_options) = match &event.action {
                    ClipAction::StartAtTiming {
                        timing,
                        instance_options,
                        ..
                    } => (Some(*timing), *instance_options),
                    _ => (None, None),
                };
                for id in id_expr.expand() {
                    let Some(clip) = exec_query.iter().find(|clip| clip.identifiers.id == id)
                    else {
                        log_clip_lookup_failure(id, "NoEntities", &exec_query, "StartClip");
                        continue;
                    };
                    let attached_instance = attached_instance_for_clip(id, &materialized_clips);
                    release_cross_domain_retarget_playback(
                        &mut commands,
                        clip,
                        attached_instance,
                        &instance_query,
                    );
                    route_start_action(
                        event,
                        clip,
                        timing,
                        instance_options,
                        attached_instance,
                        &mut fx_actions,
                        &mut flow_actions,
                        #[cfg(feature = "fx-module-host")]
                        fx_module_actions.as_mut(),
                    );
                }
            }
            ClipAction::Go(id_expr) => {
                for id in id_expr.expand() {
                    let Some(clip) = exec_query.iter().find(|clip| clip.identifiers.id == id)
                    else {
                        log_clip_lookup_failure(id, "NoEntities", &exec_query, "GoClip");
                        continue;
                    };
                    #[cfg(not(feature = "fx-module-host"))]
                    let _ = clip;
                    #[cfg(feature = "fx-module-host")]
                    if matches!(clip.source, Some(Source::FxModule(_))) {
                        let attached_instance = attached_instance_for_clip(id, &materialized_clips);
                        release_cross_domain_retarget_playback(
                            &mut commands,
                            clip,
                            attached_instance,
                            &instance_query,
                        );
                        route_start_action(
                            event,
                            clip,
                            None,
                            None,
                            attached_instance,
                            &mut fx_actions,
                            &mut flow_actions,
                            #[cfg(feature = "fx-module-host")]
                            fx_module_actions.as_mut(),
                        );
                    }
                }
            }
            ClipAction::Stop(id_expr)
            | ClipAction::StopAtTiming {
                clip_id: id_expr, ..
            } => {
                let timing = match &event.action {
                    ClipAction::StopAtTiming { timing, .. } => Some(*timing),
                    _ => None,
                };
                for id in id_expr.expand() {
                    let Some(clip) = exec_query.iter().find(|clip| clip.identifiers.id == id)
                    else {
                        log_clip_lookup_failure(id, "NoEntities", &exec_query, "StopClip");
                        continue;
                    };
                    #[cfg(not(feature = "fx-module-host"))]
                    let _ = clip;
                    let attached_instances = attached_instances_for_clip(id, &materialized_clips);
                    for (entity, mexec) in materialized_clips
                        .iter()
                        .filter(|(_, mexec)| mexec.clip_id == id)
                    {
                        if mexec.auto_release_on_stop {
                            commands.spawn(ClipReleaseAfterInstance {
                                clip_id: mexec.clip_id,
                                attached_instance: mexec.attached_instance,
                            });
                        }
                        commands.entity(entity).despawn();
                    }
                    fx_actions.write(routed_playback_action(
                        event,
                        FxPlaybackAction::Stop {
                            clip_id: id,
                            attached_instances: attached_instances.clone(),
                            timing,
                        },
                    ));
                    flow_actions.write(routed_playback_action(
                        event,
                        FlowPlaybackAction::Stop {
                            clip_id: id,
                            attached_instances,
                            timing,
                        },
                    ));
                    #[cfg(feature = "fx-module-host")]
                    if let (Some(Source::FxModule(fx_module_uid)), Some(fx_module_actions)) =
                        (clip.source.clone(), fx_module_actions.as_mut())
                    {
                        fx_module_actions.write(routed_playback_action(
                            event,
                            FxModulePlaybackAction::Stop {
                                clip_id: id,
                                fx_module_uid,
                            },
                        ));
                    }
                }
            }
            _ => {}
        }
    }
}

/// Applies domain playback attachment results to desk-owned materialized clip state.
pub fn handle_clip_playback_attachments(
    mut commands: Commands,
    mut attachments: MessageReader<EventEnvelope<ClipInstanceAttachment>>,
    materialized_clips: Query<(Entity, &MaterializedClip)>,
) {
    let mut latest_by_clip = HashMap::new();
    for event in attachments.read() {
        latest_by_clip.insert(event.event.clip_id, event.event);
    }

    for attachment in latest_by_clip.into_values() {
        let mut existing = materialized_clips
            .iter()
            .filter(|(_, mexec)| mexec.clip_id == attachment.clip_id);
        if let Some((entity, _)) = existing.next() {
            commands.entity(entity).insert(MaterializedClip {
                clip_id: attachment.clip_id,
                attached_instance: attachment.instance_id,
                auto_release_on_stop: attachment.auto_release_on_stop,
            });
            for (extra_entity, _) in existing {
                commands.entity(extra_entity).despawn();
            }
        } else {
            commands.spawn(MaterializedClip {
                clip_id: attachment.clip_id,
                attached_instance: attachment.instance_id,
                auto_release_on_stop: attachment.auto_release_on_stop,
            });
        }
    }
}

/// Sends a start action to the domain that owns the clip source.
fn route_start_action(
    event: &EngineActionEnvelope<ClipAction>,
    clip: &Clip,
    timing: Option<PlaybackReconstructionTiming>,
    instance_options: Option<InstanceOptions>,
    attached_instance: Option<InstanceId>,
    fx_actions: &mut MessageWriter<EngineActionEnvelope<FxPlaybackAction>>,
    flow_actions: &mut MessageWriter<EngineActionEnvelope<FlowPlaybackAction>>,
    #[cfg(feature = "fx-module-host")] fx_module_actions: Option<
        &mut MessageWriter<EngineActionEnvelope<FxModulePlaybackAction>>,
    >,
) {
    let context = ClipInstanceStartContext {
        clip_id: clip.identifiers.id,
        clip_uid: clip.identifiers.uid,
        priority: clip.priority,
        timing,
        instance_options,
        attached_instance,
        auto_release_on_stop: clip.options.auto_release,
    };

    match clip.source {
        Some(Source::Fx(fx_uid)) => {
            fx_actions.write(routed_playback_action(
                event,
                FxPlaybackAction::StartFx { fx_uid, context },
            ));
        }
        Some(Source::StepFx(step_fx_uid)) => {
            fx_actions.write(routed_playback_action(
                event,
                FxPlaybackAction::StartStepFx {
                    step_fx_uid,
                    context,
                },
            ));
        }
        Some(Source::Flow(flow_uid)) => {
            flow_actions.write(routed_playback_action(
                event,
                FlowPlaybackAction::Start { flow_uid, context },
            ));
        }
        #[cfg(feature = "fx-module-host")]
        Some(Source::FxModule(fx_module_uid)) if fx_module_actions.is_some() => {
            let fx_module_actions =
                fx_module_actions.expect("fx module action messages were checked");
            fx_module_actions.write(routed_playback_action(
                event,
                FxModulePlaybackAction::Start {
                    fx_module_uid,
                    context,
                },
            ));
        }
        #[cfg(not(feature = "fx-module-host"))]
        Some(Source::FxModule(_)) => {}
        _ => {}
    }
}

/// Wraps one routed playback action with fresh operation identity and inherited lifecycle context.
fn routed_playback_action<T>(
    event: &EngineActionEnvelope<ClipAction>,
    action: T,
) -> EngineActionEnvelope<T> {
    EngineActionEnvelope::with_context(OperationId::new(), event.command_id, event.undo_id, action)
}

/// Marks an attached playback for release when an clip start retargets across domains.
fn release_cross_domain_retarget_playback(
    commands: &mut Commands,
    clip: &Clip,
    attached_instance: Option<InstanceId>,
    instance_query: &Query<ClipPlaybackData>,
) {
    let Some(attached_instance) = attached_instance else {
        return;
    };
    let Some(target_kind) = clip_source_playback_kind(clip.source.clone()) else {
        return;
    };
    let Some((entity, _instance_id, metadata, controls, release_marker)) =
        instance_query.iter().find(
            |(_entity, instance_id, _metadata, _controls, _release_marker)| {
                **instance_id == attached_instance
            },
        )
    else {
        return;
    };
    if metadata.kind == target_kind {
        return;
    }
    let mut entity_commands = commands.entity(entity);
    if release_marker.is_none() {
        entity_commands.insert(ReleaseMarker::default());
    }
    if let Some(controls) = controls.filter(|controls| controls.rate == 0.0) {
        let mut resumed_controls = controls.clone();
        resumed_controls.rate = 1.0;
        entity_commands.insert(resumed_controls);
    }
}

/// Returns the playback kind produced by an clip source domain.
fn clip_source_playback_kind(source: Option<Source>) -> Option<InstanceKind> {
    match source {
        Some(Source::Fx(_)) | Some(Source::StepFx(_)) | Some(Source::FxModule(_)) => {
            Some(InstanceKind::Fx)
        }
        Some(Source::Flow(_)) => Some(InstanceKind::Flow),
        Some(Source::Sequence(_)) => Some(InstanceKind::Sequence),
        _ => None,
    }
}

/// Returns the first playback attached to an clip.
fn attached_instance_for_clip(
    clip_id: u32,
    materialized_clips: &Query<(Entity, &MaterializedClip)>,
) -> Option<InstanceId> {
    materialized_clips
        .iter()
        .find(|(_, mexec)| mexec.clip_id == clip_id)
        .map(|(_, mexec)| mexec.attached_instance)
}

/// Returns all instances attached to an clip.
fn attached_instances_for_clip(
    clip_id: u32,
    materialized_clips: &Query<(Entity, &MaterializedClip)>,
) -> Vec<InstanceId> {
    materialized_clips
        .iter()
        .filter(|(_, mexec)| mexec.clip_id == clip_id)
        .map(|(_, mexec)| mexec.attached_instance)
        .collect()
}

/// Applies a rate to all active instances attached to an clip.
fn set_clip_playback_rate(
    clip_id: u32,
    rate: f32,
    materialized_clips: &Query<&MaterializedClip>,
    instance_index: &InstanceIndex,
    instances: &mut Query<(
        &InstanceId,
        &mut InstanceControls,
        Option<&mut InstanceClock>,
    )>,
) -> bool {
    let mut applied = false;
    for materialized_clip in materialized_clips
        .iter()
        .filter(|mexec| mexec.clip_id == clip_id)
    {
        if set_attached_instance_rate(
            materialized_clip.attached_instance,
            rate,
            instance_index,
            instances,
        ) {
            applied = true;
        } else {
            tracing::warn!(
                clip_id,
                instance_id = ?materialized_clip.attached_instance,
                "Clip rate command could not find attached playback"
            );
        }
    }
    applied
}

/// Applies a rate to a playback, falling back to a query scan if the index is stale.
fn set_attached_instance_rate(
    instance_id: InstanceId,
    rate: f32,
    instance_index: &InstanceIndex,
    instances: &mut Query<(
        &InstanceId,
        &mut InstanceControls,
        Option<&mut InstanceClock>,
    )>,
) -> bool {
    if let Some(entity) = instance_index.get(&instance_id)
        && let Ok((_id, mut controls, mut clock)) = instances.get_mut(entity)
    {
        controls.set_rate(rate);
        if let Some(clock) = clock.as_deref_mut() {
            clock.set_rate(controls.effective_rate());
        }
        return true;
    }

    for (candidate_id, mut controls, mut clock) in instances.iter_mut() {
        if *candidate_id != instance_id {
            continue;
        }
        controls.set_rate(rate);
        if let Some(clock) = clock.as_deref_mut() {
            clock.set_rate(controls.effective_rate());
        }
        return true;
    }

    false
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use bevy_ecs::schedule::ApplyDeferred;
    use nightfall::prelude::{IdExpr, Identifiers, ObjectRef, ObjectType};
    use uuid::Uuid;

    use super::*;

    /// Build a minimal clip for CRUD event tests.
    fn clip(id: u32, uid: Uuid, label: &str) -> Clip {
        Clip {
            identifiers: Identifiers {
                id,
                uid,
                label: label.to_string(),
            },
            ..Default::default()
        }
    }

    /// Build an app with clip CRUD messages and systems installed.
    fn setup_clip_crud_app() -> App {
        let mut app = App::new();
        app.add_message::<CommandEnvelope<ClipCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.init_resource::<CommandTracker>();
        app.add_systems(Update, (crud_events, ApplyDeferred).chain());
        app
    }

    /// Builds an app with semantic clip configuration handling installed.
    fn setup_clip_configuration_app() -> App {
        let mut app = App::new();
        app.add_message::<CommandEnvelope<ClipCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.init_resource::<CommandTracker>();
        app.add_systems(Update, handle_configuration_commands);
        app
    }

    /// Registers and submits one clip command through its semantic envelope.
    fn submit_clip_command(app: &mut App, command: ClipCommand) -> CommandId {
        let command_id = CommandId::new();
        let undo_id = UndoId::from(command_id);
        if let Some(mut tracker) = app.world_mut().get_resource_mut::<CommandTracker>() {
            tracker
                .register_context(
                    command_id,
                    undo_id,
                    CommandOrigin::WebUi,
                    ReplyTarget::Detached,
                )
                .expect("clip command should register");
        }
        if app
            .world()
            .contains_resource::<Messages<CommandEnvelope<ClipCommand>>>()
        {
            app.world_mut().write_message(CommandEnvelope::with_context(
                command_id,
                undo_id,
                CommandOrigin::WebUi,
                ReplyTarget::Detached,
                command,
            ));
        } else if let Some(action) = clip_action_from_command(&command) {
            app.world_mut()
                .write_message(EngineActionEnvelope::for_command_context(
                    command_id, undo_id, action,
                ));
        }
        command_id
    }

    /// Returns all clips currently spawned in the test world.
    fn clip_snapshots(app: &mut App) -> Vec<Clip> {
        app.world_mut()
            .query::<&Clip>()
            .iter(app.world())
            .cloned()
            .collect()
    }

    /// Verifies source assignment mutates the clip before reporting success.
    #[test]
    fn assign_clip_source_returns_success_after_mutation() {
        let mut app = setup_clip_configuration_app();
        let clip_uid = Uuid::from_u128(10);
        let source_uid = Uuid::from_u128(20);
        let entity = app.world_mut().spawn(clip(10, clip_uid, "Clip")).id();

        let command_id = submit_clip_command(
            &mut app,
            ClipCommand::AssignSource {
                clip_id: 10,
                source: Source::Fx(source_uid),
            },
        );
        app.update();

        assert!(matches!(
            app.world()
                .get::<Clip>(entity)
                .and_then(|clip| clip.source.as_ref()),
            Some(Source::Fx(uid)) if *uid == source_uid
        ));
        let results = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].command_id, command_id);
        assert!(matches!(
            results[0].outcome,
            CommandOutcome::Succeeded { .. }
        ));
    }

    /// Resolves a test source without coupling the desk to its owning domain.
    fn test_source_lookup(
        In(reference): In<ObjectRef>,
    ) -> nightfall_engine::object_registry::ObjectLookupResult {
        let ObjectRef::ById { id, .. } = reference else {
            return Err(ObjectLookupError::Missing);
        };
        match id {
            1 => Ok(Uuid::from_u128(20)),
            2 => Err(ObjectLookupError::Ambiguous),
            _ => Err(ObjectLookupError::Missing),
        }
    }

    /// Numeric assignment completes once after mutation and preserves same-batch command order.
    #[test]
    fn numeric_source_assignment_completes_after_mutation() {
        let mut app = setup_clip_configuration_app();
        nightfall_engine::object_registry::register_object_lookup(
            app.world_mut(),
            ObjectType::Sequence,
            test_source_lookup,
        );
        let entity = app
            .world_mut()
            .spawn(clip(10, Uuid::from_u128(10), "Clip"))
            .id();
        let id = submit_clip_command(
            &mut app,
            ClipCommand::AssignSourceById {
                clip_id: 10,
                source: ClipSourceRef::Sequence(1),
            },
        );
        app.update();
        assert!(
            matches!(app.world().get::<Clip>(entity).unwrap().source, Some(Source::Sequence(uid)) if uid == Uuid::from_u128(20))
        );
        let results: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].command_id, id);
        assert!(matches!(
            results[0].outcome,
            CommandOutcome::Succeeded { .. }
        ));
        submit_clip_command(
            &mut app,
            ClipCommand::AssignSourceById {
                clip_id: 10,
                source: ClipSourceRef::Sequence(1),
            },
        );
        submit_clip_command(&mut app, ClipCommand::ClearSource(10));
        app.update();
        assert!(app.world().get::<Clip>(entity).unwrap().source.is_none());
        assert_eq!(
            app.world_mut()
                .resource_mut::<Messages<CommandResult>>()
                .drain()
                .count(),
            2
        );
        app.update();
        assert_eq!(
            app.world_mut()
                .resource_mut::<Messages<CommandResult>>()
                .drain()
                .count(),
            0
        );
    }

    /// Missing and ambiguous lookups each fail once without overwriting an existing assignment.
    #[test]
    fn numeric_source_failures_preserve_assignment() {
        for (source_id, code) in [(2, "clip.source_ambiguous"), (404, "clip.source_not_found")] {
            let mut app = setup_clip_configuration_app();
            nightfall_engine::object_registry::register_object_lookup(
                app.world_mut(),
                ObjectType::Sequence,
                test_source_lookup,
            );
            let mut original = clip(10, Uuid::from_u128(10), "Clip");
            original.source = Some(Source::Fx(Uuid::from_u128(30)));
            let entity = app.world_mut().spawn(original).id();
            let id = submit_clip_command(
                &mut app,
                ClipCommand::AssignSourceById {
                    clip_id: 10,
                    source: ClipSourceRef::Sequence(source_id),
                },
            );
            app.update();
            assert!(
                matches!(app.world().get::<Clip>(entity).unwrap().source, Some(Source::Fx(uid)) if uid == Uuid::from_u128(30))
            );
            let results: Vec<_> = app
                .world_mut()
                .resource_mut::<Messages<CommandResult>>()
                .drain()
                .collect();
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].command_id, id);
            assert!(
                matches!(&results[0].outcome, CommandOutcome::Failed(error) if error.code == code)
            );
        }
    }

    /// Verifies a missing clip produces one structured terminal failure.
    #[test]
    fn configure_missing_clip_returns_failure() {
        let mut app = setup_clip_configuration_app();
        let command_id = submit_clip_command(&mut app, ClipCommand::ClearSource(404));
        app.update();

        let results = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].command_id, command_id);
        let CommandOutcome::Failed(error) = &results[0].outcome else {
            panic!("missing clip should fail");
        };
        assert_eq!(error.code, "clip.configuration_not_found");
    }

    /// Verifies unresolved numeric source references fail instead of hanging indefinitely.
    #[test]
    fn unresolved_clip_source_reference_returns_failure() {
        let mut app = setup_clip_configuration_app();
        app.world_mut().spawn(clip(10, Uuid::from_u128(10), "Clip"));
        let command_id = submit_clip_command(
            &mut app,
            ClipCommand::AssignSourceById {
                clip_id: 10,
                source: ClipSourceRef::Sequence(1),
            },
        );
        app.update();

        let results = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].command_id, command_id);
        let CommandOutcome::Failed(error) = &results[0].outcome else {
            panic!("unresolved source reference should fail");
        };
        assert_eq!(error.code, "clip.source_kind_unsupported");
    }

    /// Verifies live ingress commands retain command and undo identity at the runtime boundary.
    #[test]
    fn live_clip_command_forwards_with_lifecycle_context() {
        let mut app = App::new();
        app.add_message::<CommandEnvelope<ClipCommand>>();
        app.add_message::<EngineActionEnvelope<ClipAction>>();
        app.add_systems(Update, forward_clip_ingress_actions);
        let command_id = CommandId::new();
        let undo_id = UndoId::new();

        app.world_mut().write_message(CommandEnvelope::with_context(
            command_id,
            undo_id,
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
            ClipCommand::GoClip(IdExpr::Single(7)),
        ));
        app.update();

        let actions = app
            .world_mut()
            .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].command_id, Some(command_id));
        assert_eq!(actions[0].undo_id, Some(undo_id));
        assert!(matches!(
            actions[0].action,
            ClipAction::Go(IdExpr::Single(7))
        ));
    }

    /// Verifies cross-domain playback requests preserve inherited lifecycle context.
    #[test]
    fn clip_playback_request_resolves_with_lifecycle_context() {
        let mut app = App::new();
        app.add_message::<RequestEnvelope<ClipInstanceRequest>>();
        app.add_message::<EngineActionEnvelope<ClipAction>>();
        app.add_systems(Update, forward_clip_playback_requests);
        let command_id = CommandId::new();
        let undo_id = UndoId::new();

        app.world_mut().write_message(RequestEnvelope::with_context(
            OperationId::new(),
            Some(command_id),
            Some(undo_id),
            ClipInstanceRequest::Start(IdExpr::Single(9)),
        ));
        app.update();

        let actions = app
            .world_mut()
            .resource_mut::<Messages<EngineActionEnvelope<ClipAction>>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].command_id, Some(command_id));
        assert_eq!(actions[0].undo_id, Some(undo_id));
        assert!(matches!(
            actions[0].action,
            ClipAction::Start(IdExpr::Single(9))
        ));
    }

    /// Verifies storing an existing clip UID updates the entity instead of duplicating it.
    #[test]
    fn store_clip_updates_existing_uid_without_duplicate() {
        let uid = Uuid::from_u128(10);
        let mut app = setup_clip_crud_app();
        app.world_mut().spawn(clip(10, uid, "Before"));

        submit_clip_command(&mut app, ClipCommand::StoreClip(clip(10, uid, "After")));
        app.update();

        let clips = clip_snapshots(&mut app);
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].identifiers.id, 10);
        assert_eq!(clips[0].identifiers.uid, uid);
        assert_eq!(clips[0].identifiers.label, "After");
    }

    /// Verifies a new clip cannot be stored with another clip's numeric ID.
    #[test]
    fn store_clip_rejects_new_uid_with_existing_numeric_id() {
        let mut app = setup_clip_crud_app();
        app.world_mut()
            .spawn(clip(10, Uuid::from_u128(10), "Existing"));

        submit_clip_command(
            &mut app,
            ClipCommand::StoreClip(clip(10, Uuid::from_u128(11), "Colliding")),
        );
        app.update();

        let clips = clip_snapshots(&mut app);
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].identifiers.label, "Existing");

        let command_results: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect();
        assert_eq!(command_results.len(), 1);
        assert!(matches!(
            command_results[0].outcome,
            CommandOutcome::Failed(_)
        ));
    }

    /// Verifies edit-dialog rename plus store commands update one clip entity.
    #[test]
    fn rename_then_store_clip_updates_without_duplicate() {
        let uid = Uuid::from_u128(10);
        let mut app = setup_clip_crud_app();
        app.world_mut().spawn(clip(10, uid, "Before"));

        submit_clip_command(&mut app, ClipCommand::RenameClip { id: 10, new_id: 11 });
        submit_clip_command(&mut app, ClipCommand::StoreClip(clip(11, uid, "After")));
        app.update();

        let clips = clip_snapshots(&mut app);
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].identifiers.id, 11);
        assert_eq!(clips[0].identifiers.uid, uid);
        assert_eq!(clips[0].identifiers.label, "After");
    }

    /// Verifies renaming a running clip preserves its existing materialized playback.
    #[test]
    fn rename_clip_keeps_materialized_clip_playback() {
        let uid = Uuid::from_u128(10);
        let mut app = setup_clip_crud_app();
        app.world_mut().spawn(clip(10, uid, "Before"));
        let instance_id = InstanceId::new();
        let playback = app
            .world_mut()
            .spawn((instance_id, InstanceControls::default()))
            .id();
        let materialized_clip = app
            .world_mut()
            .spawn(MaterializedClip {
                clip_id: 10,
                attached_instance: instance_id,
                auto_release_on_stop: false,
            })
            .id();

        submit_clip_command(&mut app, ClipCommand::RenameClip { id: 10, new_id: 11 });
        app.update();

        assert!(app.world().entities().contains(materialized_clip));
        assert_eq!(
            app.world()
                .get::<MaterializedClip>(materialized_clip)
                .expect("materialized clip should remain attached")
                .clip_id,
            11
        );
        assert!(app.world().get::<ReleaseMarker>(playback).is_none());
    }

    /// Verifies deleting a renamed running clip releases its attached playback.
    #[test]
    fn delete_renamed_clip_releases_materialized_clip_playback() {
        let uid = Uuid::from_u128(10);
        let mut app = setup_clip_crud_app();
        app.world_mut().spawn(clip(10, uid, "Before"));
        let instance_id = InstanceId::new();
        let playback = app
            .world_mut()
            .spawn((
                instance_id,
                InstanceControls {
                    intensity_scale: 1.0,
                    rate: 0.0,
                    ..Default::default()
                },
            ))
            .id();
        let materialized_clip = app
            .world_mut()
            .spawn(MaterializedClip {
                clip_id: 10,
                attached_instance: instance_id,
                auto_release_on_stop: false,
            })
            .id();

        submit_clip_command(&mut app, ClipCommand::RenameClip { id: 10, new_id: 11 });
        app.update();
        submit_clip_command(&mut app, ClipCommand::DeleteClip(11));
        app.update();

        assert!(!app.world().entities().contains(materialized_clip));
        assert!(app.world().get::<ReleaseMarker>(playback).is_some());
        assert_eq!(
            app.world()
                .get::<InstanceControls>(playback)
                .expect("controls should remain attached")
                .rate,
            1.0
        );
    }

    /// Verifies deleting a running clip releases its attached playback.
    #[test]
    fn delete_clip_releases_materialized_clip_playback() {
        let uid = Uuid::from_u128(10);
        let mut app = setup_clip_crud_app();
        app.world_mut().spawn(clip(10, uid, "Before"));
        let instance_id = InstanceId::new();
        let playback = app
            .world_mut()
            .spawn((
                instance_id,
                InstanceControls {
                    intensity_scale: 1.0,
                    rate: 0.0,
                    ..Default::default()
                },
            ))
            .id();
        let materialized_clip = app
            .world_mut()
            .spawn(MaterializedClip {
                clip_id: 10,
                attached_instance: instance_id,
                auto_release_on_stop: false,
            })
            .id();

        submit_clip_command(&mut app, ClipCommand::DeleteClip(10));
        app.update();

        assert!(!app.world().entities().contains(materialized_clip));
        assert!(app.world().get::<ReleaseMarker>(playback).is_some());
        assert_eq!(
            app.world()
                .get::<InstanceControls>(playback)
                .expect("controls should remain attached")
                .rate,
            1.0
        );
    }

    /// Verifies a failed rename cannot be bypassed by the following store command.
    #[test]
    fn rename_collision_then_store_keeps_existing_clip_ids() {
        let uid = Uuid::from_u128(10);
        let colliding_uid = Uuid::from_u128(11);
        let mut app = setup_clip_crud_app();
        app.world_mut().spawn(clip(10, uid, "Before"));
        app.world_mut().spawn(clip(11, colliding_uid, "Colliding"));

        submit_clip_command(&mut app, ClipCommand::RenameClip { id: 10, new_id: 11 });
        submit_clip_command(&mut app, ClipCommand::StoreClip(clip(11, uid, "After")));
        app.update();

        let mut clips = clip_snapshots(&mut app);
        clips.sort_by_key(|clip| clip.identifiers.id);
        assert_eq!(clips.len(), 2);
        assert_eq!(clips[0].identifiers.id, 10);
        assert_eq!(clips[0].identifiers.uid, uid);
        assert_eq!(clips[0].identifiers.label, "Before");
        assert_eq!(clips[1].identifiers.id, 11);
        assert_eq!(clips[1].identifiers.uid, colliding_uid);
        assert_eq!(clips[1].identifiers.label, "Colliding");

        let command_results: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect();
        assert_eq!(command_results.len(), 2);
    }

    /// Verifies clip rate commands apply to the clip's active playback clock.
    #[test]
    fn clip_rate_command_updates_attached_instance_rate() {
        let mut app = App::new();
        app.add_message::<EngineActionEnvelope<ClipAction>>();
        app.insert_resource(InstanceIndex::default());
        app.insert_resource(PendingClipPlaybackRates::default());
        app.add_systems(Update, handle_clip_rate_commands);

        let instance_id = InstanceId::new();
        let playback = app
            .world_mut()
            .spawn((
                instance_id,
                InstanceControls::default(),
                InstanceClock::default(),
            ))
            .id();
        app.world_mut().spawn(MaterializedClip {
            clip_id: 7,
            attached_instance: instance_id,
            auto_release_on_stop: false,
        });
        let mut index = InstanceIndex::default();
        index.insert(instance_id, playback);
        app.insert_resource(index);

        submit_clip_command(
            &mut app,
            ClipCommand::SetRate {
                clip_id: IdExpr::Single(7),
                rate: 2.0,
            },
        );
        app.update();

        let controls = app
            .world()
            .get::<InstanceControls>(playback)
            .expect("playback controls should remain present");
        assert_eq!(controls.rate, 2.0);
        let mut clock = app
            .world_mut()
            .get_mut::<InstanceClock>(playback)
            .expect("playback clock should remain present");
        assert_eq!(clock.rate, 2.0);
        clock.advance_by_realtime_delta(std::time::Duration::from_millis(250));
        assert_eq!(clock.position, std::time::Duration::from_millis(500));
    }

    /// Verifies clip rate commands wait for deferred playback materialization.
    #[test]
    fn clip_rate_command_applies_after_playback_materializes() {
        let mut app = App::new();
        app.add_message::<EngineActionEnvelope<ClipAction>>();
        app.insert_resource(InstanceIndex::default());
        app.insert_resource(PendingClipPlaybackRates::default());
        app.add_systems(Update, handle_clip_rate_commands);

        let undo_id = Uuid::new_v4();
        app.world_mut()
            .write_message(EngineActionEnvelope::with_context(
                OperationId::new(),
                None,
                Some(undo_id.into()),
                ClipAction::Start(IdExpr::Single(7)),
            ));
        app.world_mut()
            .write_message(EngineActionEnvelope::with_context(
                OperationId::new(),
                None,
                Some(undo_id.into()),
                ClipAction::SetRate {
                    clip_id: IdExpr::Single(7),
                    rate: 2.0,
                },
            ));
        app.update();
        assert_eq!(
            app.world().resource::<PendingClipPlaybackRates>().0.get(&7),
            Some(&2.0)
        );

        let instance_id = InstanceId::new();
        let playback = app
            .world_mut()
            .spawn((
                instance_id,
                InstanceControls::default(),
                InstanceClock::default(),
            ))
            .id();
        app.world_mut().spawn(MaterializedClip {
            clip_id: 7,
            attached_instance: instance_id,
            auto_release_on_stop: false,
        });
        let mut index = InstanceIndex::default();
        index.insert(instance_id, playback);
        app.insert_resource(index);

        app.update();

        assert!(
            app.world()
                .resource::<PendingClipPlaybackRates>()
                .0
                .is_empty()
        );
        let controls = app
            .world()
            .get::<InstanceControls>(playback)
            .expect("playback controls should remain present");
        assert_eq!(controls.rate, 2.0);
        let clock = app
            .world()
            .get::<InstanceClock>(playback)
            .expect("playback clock should remain present");
        assert_eq!(clock.rate, 2.0);
    }

    /// Verifies inactive standalone rate commands do not leak into future starts.
    #[test]
    fn clip_rate_command_without_same_batch_start_is_not_persisted() {
        let mut app = App::new();
        app.add_message::<EngineActionEnvelope<ClipAction>>();
        app.insert_resource(InstanceIndex::default());
        app.insert_resource(PendingClipPlaybackRates::default());
        app.add_systems(Update, handle_clip_rate_commands);

        submit_clip_command(
            &mut app,
            ClipCommand::SetRate {
                clip_id: IdExpr::Single(7),
                rate: 2.0,
            },
        );
        app.update();
        assert!(
            app.world()
                .resource::<PendingClipPlaybackRates>()
                .0
                .is_empty()
        );

        let instance_id = InstanceId::new();
        let playback = app
            .world_mut()
            .spawn((
                instance_id,
                InstanceControls::default(),
                InstanceClock::default(),
            ))
            .id();
        app.world_mut().spawn(MaterializedClip {
            clip_id: 7,
            attached_instance: instance_id,
            auto_release_on_stop: false,
        });
        let mut index = InstanceIndex::default();
        index.insert(instance_id, playback);
        app.insert_resource(index);

        app.update();

        let controls = app
            .world()
            .get::<InstanceControls>(playback)
            .expect("playback controls should remain present");
        assert_eq!(controls.rate, 1.0);
    }

    /// Verifies routed domain actions inherit command and undo context while receiving fresh operation identity.
    #[test]
    fn routed_playback_action_preserves_lifecycle_context() {
        let undo_id = Uuid::from_u128(2);
        let command_id = CommandId::new();
        let event = EngineActionEnvelope::with_context(
            OperationId::new(),
            Some(command_id),
            Some(UndoId::from(undo_id)),
            ClipAction::Start(IdExpr::Single(7)),
        );

        let action = routed_playback_action(&event, "start playback");

        assert_eq!(action.command_id, Some(command_id));
        assert_eq!(action.undo_id, Some(UndoId::from(undo_id)));
        assert_ne!(action.operation_id, event.operation_id);
        assert_eq!(action.action, "start playback");
    }
}
