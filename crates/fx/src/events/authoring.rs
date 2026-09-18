// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! FX persistence, draft resolution, and ordered Step FX command handling.

use std::collections::HashMap;

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_instances::{
    InstanceClock, InstanceControls, InstanceDisplayKind, InstanceId, InstanceKind,
    InstanceMetadata, PlaybackReleaseAction,
};
use uuid::Uuid;

use super::commands::StepFxCommandResult;
use super::continuity::{reanchored_step_fx_runtime, refreshed_step_fx_playback_metadata};
use crate::prelude::*;

/// Runtime components needed to replace an authored definition without losing continuity.
type StepFxAuthoringData = (
    Entity,
    &'static ActiveStepFx,
    Option<&'static InstanceId>,
    Option<&'static InstanceControls>,
    Option<&'static ReleaseMarker>,
    Option<&'static InstanceClock>,
    Option<&'static StepFxLanePhaseOffsets>,
    Option<&'static InstanceMetadata>,
);

/// Rewrites dynamic group references in an FX selection to stable UID references before storage.
fn stabilized_fx_selection(
    selection: &SpatialSelection,
    selection_resolver: &SpatialSelectionResolver,
) -> SpatialSelection {
    let stabilized = selection_resolver.stabilize_group_refs_selection(selection);
    for warning in &stabilized.issues {
        tracing::warn!("{}", warning);
    }
    stabilized.value
}

/// Handles CRUD events for FX
pub fn crud_events(
    mut fx_data_provider: ResMut<DataProvider<Fx>>,
    mut events: MessageReader<CommandEnvelope<FxCommand>>,
    mut responder: CommandResponder,
    selection_resolver: SpatialSelectionResolver,
) {
    for event in events.read() {
        let result = match &event.command {
            FxCommand::StoreFx(fx) => {
                tracing::debug!("Storing fx with ID: {}", fx.identifiers().uid);
                let mut fx = fx.clone();
                fx.selection = stabilized_fx_selection(&fx.selection, &selection_resolver);
                fx_data_provider.add(fx).map_err(|error| {
                    tracing::warn!("Failed to store fx: {}", error);
                    CommandError::new("fx.store_failed", format!("Failed to store fx: {error}"))
                })
            }

            FxCommand::RenameFx { id, new_id } => {
                tracing::debug!("Renaming fx with ID: {} to {}", id, new_id);
                let Ok(mut fx) = fx_data_provider.from_id(*id).map(|fx| fx.clone()) else {
                    tracing::debug!(
                        "No regular fx matched rename {} -> {}; trying extension domains",
                        id,
                        new_id
                    );
                    continue;
                };

                if fx_data_provider.from_id(*new_id).is_ok() {
                    tracing::warn!("Failed to rename fx {} -> {}: already exists", id, new_id);
                    Err(CommandError::new(
                        "fx.destination_exists",
                        format!("Failed to rename fx {} to {}: already exists", id, new_id),
                    ))
                } else {
                    fx.identifiers.id = *new_id;
                    fx_data_provider.add(fx).map_err(|error| {
                        CommandError::new(
                            "fx.rename_failed",
                            format!("Failed to rename fx {id} to {new_id}: {error}"),
                        )
                    })
                }
            }

            FxCommand::DeleteFx(id) => {
                tracing::debug!("Deleting fx with ID: {}", id);
                if let Ok(uid) = fx_data_provider.from_id(*id).map(|fx| fx.identifiers.uid) {
                    fx_data_provider.remove(&uid).map(|_| ()).map_err(|error| {
                        tracing::warn!("Failed to delete fx {}: {}", id, error);
                        CommandError::new(
                            "fx.delete_failed",
                            format!("Failed to delete fx {id}: {error}"),
                        )
                    })
                } else {
                    tracing::debug!(
                        "No regular fx matched delete {}; trying extension domains",
                        id
                    );
                    continue;
                }
            }
        };

        let response = match result {
            Ok(()) => responder.succeed(event.command_id),
            Err(error) => responder.fail(event.command_id, error),
        };
        if let Err(error) = response {
            tracing::error!(
                command_id = %event.command_id,
                %error,
                "fx_command_completion_failed"
            );
        }
    }
}

/// Resolves one operator-facing Blueprint address to a stable definition.
fn resolve_step_fx_blueprint_address(
    provider: &DataProvider<Blueprint>,
    address: &BlueprintAddress,
) -> Result<Blueprint, CommandError> {
    match address {
        BlueprintAddress::Id(id) => provider
            .from_id(*id)
            .map(|blueprint| blueprint.clone())
            .map_err(|_| {
                CommandError::new(
                    "blueprint.not_found",
                    format!("Blueprint {id} was not found"),
                )
            }),
        BlueprintAddress::Label(label) => {
            let mut matches = provider
                .iter()
                .filter(|blueprint| {
                    blueprint
                        .identifiers
                        .label
                        .trim()
                        .eq_ignore_ascii_case(label.trim())
                })
                .collect::<Vec<_>>();
            matches.sort_by_key(|blueprint| blueprint.identifiers.id);
            match matches.as_slice() {
                [] => Err(CommandError::new(
                    "blueprint.not_found",
                    format!("Blueprint labeled \"{label}\" was not found"),
                )),
                [blueprint] => Ok((*blueprint).clone()),
                blueprints => Err(CommandError::new(
                    "blueprint.label_ambiguous",
                    format!(
                        "Blueprint label \"{label}\" matches IDs {}; use a numeric ID",
                        blueprints
                            .iter()
                            .map(|blueprint| blueprint.identifiers.id.to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                )),
            }
        }
    }
}

/// Resolves one command-time scalar source for a specific lane attribute.
fn resolve_step_fx_command_value(
    source: StepFxCommandValueSource,
    attribute: &Attribute,
    provider: &DataProvider<Blueprint>,
) -> Result<(ParameterValue, Option<Uuid>), CommandError> {
    match source {
        StepFxCommandValueSource::Direct(value) => Ok((value, None)),
        StepFxCommandValueSource::Blueprint {
            address,
            resolution,
        } => {
            let blueprint = resolve_step_fx_blueprint_address(provider, &address)?;
            let value = blueprint.values.get(attribute).ok_or_else(|| {
                CommandError::new(
                    "blueprint.attribute_missing",
                    format!(
                        "Blueprint {} contains no value for {attribute}",
                        blueprint.identifiers.id
                    ),
                )
            })?;
            let ValueSource::Inline(value) = value else {
                return Err(CommandError::new(
                    "blueprint.scalar_required",
                    format!(
                        "Blueprint {} value for {attribute} is not scalar",
                        blueprint.identifiers.id
                    ),
                ));
            };
            let blueprint_uid =
                (resolution == BlueprintResolution::Reference).then_some(blueprint.identifiers.uid);
            Ok((*value, blueprint_uid))
        }
    }
}

/// Resolves all Blueprint addresses in one draft before replacing stored state.
fn resolve_step_fx_draft(
    draft: StepFxDraft,
    provider: &DataProvider<Blueprint>,
) -> Result<StepFx, CommandError> {
    let lanes = draft
        .sequences
        .into_iter()
        .map(|sequence| {
            let base_value = sequence
                .base_value
                .map(|source| resolve_step_fx_command_value(source, &sequence.attribute, provider))
                .transpose()?;
            let steps = sequence
                .steps
                .into_iter()
                .map(|step| {
                    let (target, blueprint_uid) =
                        resolve_step_fx_command_value(step.target, &sequence.attribute, provider)?;
                    Ok(FxStep {
                        uid: step.uid,
                        target,
                        blueprint_uid,
                        width_beats: step.width_beats,
                        transition: step.transition,
                        curve: step.curve,
                    })
                })
                .collect::<Result<Vec<_>, CommandError>>()?;
            let relative = steps.first().is_some_and(|step| step.target.is_relative());
            if steps
                .iter()
                .any(|step| step.target.is_relative() != relative)
            {
                return Err(CommandError::new(
                    "fx.step_mixed_modes",
                    format!(
                        "Step FX values for {} must all be absolute or all be relative",
                        sequence.attribute
                    ),
                ));
            }
            let dynamic_track = FxTrack { steps };
            let base_track = relative
                .then_some(base_value)
                .flatten()
                .filter(|(target, _)| !target.is_relative())
                .map(|(target, blueprint_uid)| FxTrack {
                    steps: vec![FxStep {
                        uid: Uuid::new_v4(),
                        target,
                        blueprint_uid,
                        width_beats: 1.0,
                        transition: StepFxTransition::from(0.0),
                        curve: CurveType::Snap(Snap {}),
                    }],
                });
            Ok(FxLane {
                attribute: sequence.attribute,
                timing_override: None,
                phase_override: None,
                absolute: if relative {
                    base_track
                } else {
                    Some(dynamic_track.clone())
                },
                relative: relative.then_some(dynamic_track),
            })
        })
        .collect::<Result<Vec<_>, CommandError>>()?;
    Ok(StepFx {
        identifiers: draft.identifiers,
        selection: draft.selection,
        timing: draft.timing,
        phase: draft.phase,
        direction: draft.direction,
        cycle_scale: draft.cycle_scale,
        lanes,
    })
}

/// Stores one resolved definition and reconnects active playbacks to its replacement entity.
#[allow(clippy::too_many_arguments)]
fn store_step_fx_definition(
    mut step_fx: StepFx,
    selection_resolver: &SpatialSelectionResolver,
    step_fx_query: &Query<(Entity, &StepFx)>,
    active_fx_query: &Query<StepFxAuthoringData>,
    definitions_by_id: &mut HashMap<u32, (Entity, StepFx)>,
    definitions_by_uid: &mut HashMap<Uuid, (Entity, StepFx)>,
    original_entities_by_current: &mut HashMap<Entity, Vec<Entity>>,
    commands: &mut Commands,
) -> Result<(), CommandError> {
    step_fx.selection = stabilized_fx_selection(&step_fx.selection, selection_resolver);
    let fx_id = step_fx.identifiers.id;
    let validation_issues = step_fx.validate();
    if !validation_issues.is_empty() {
        let summary = validation_issues
            .iter()
            .map(|issue| format!("{}: {}", issue.path, issue.message))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(CommandError::new(
            "fx.step_invalid",
            format!("Step FX is invalid: {summary}"),
        ));
    }

    tracing::debug!(
        fx_id,
        beat_duration = ?step_fx.timing.beat_duration,
        lanes = step_fx.lanes.len(),
        selection = ?step_fx.selection,
        "Storing step FX"
    );

    let existing_by_uid = definitions_by_uid.get(&step_fx.identifiers.uid).cloned();
    let id_collision = definitions_by_id
        .get(&fx_id)
        .is_some_and(|(_, existing)| existing.identifiers.uid != step_fx.identifiers.uid);
    if id_collision {
        return Err(CommandError::new(
            "fx.step_id_exists",
            format!("Step FX {fx_id} already exists"),
        ));
    }

    let new_entity = commands.spawn(step_fx.clone()).id();
    if let Some((old_entity, old_step_fx)) = existing_by_uid {
        let original_entities = original_entities_by_current
            .remove(&old_entity)
            .unwrap_or_default();
        for (active_entity, active, _, _, _, clock, offsets, metadata) in active_fx_query.iter() {
            if !original_entities.contains(&active.fx_entity) {
                continue;
            }
            let original_step_fx = step_fx_query
                .get(active.fx_entity)
                .map(|(_, step_fx)| step_fx)
                .unwrap_or(&old_step_fx);
            let mut updated = active.clone();
            updated.fx_entity = new_entity;
            let (clock, offsets) =
                reanchored_step_fx_runtime(clock, offsets, active.rate, original_step_fx, &step_fx);
            commands
                .entity(active_entity)
                .insert((
                    updated,
                    clock,
                    offsets,
                    refreshed_step_fx_playback_metadata(
                        metadata,
                        step_fx.identifiers.label.clone(),
                    ),
                ))
                .remove::<ReleaseMarker>();
        }
        definitions_by_id.remove(&old_step_fx.identifiers.id);
        definitions_by_uid.remove(&old_step_fx.identifiers.uid);
        original_entities_by_current.insert(new_entity, original_entities);
        commands.entity(old_entity).despawn();
    } else {
        original_entities_by_current.insert(new_entity, Vec::new());
    }
    definitions_by_id.insert(fx_id, (new_entity, step_fx.clone()));
    definitions_by_uid.insert(step_fx.identifiers.uid, (new_entity, step_fx));
    Ok(())
}

/// Handles step FX commands
pub fn handle_step_fx_commands(
    step_fx_query: Query<(Entity, &StepFx)>,
    active_fx_query: Query<StepFxAuthoringData>,
    mut events: MessageReader<CommandEnvelope<StepFxCommand>>,
    mut instance_events: MessageWriter<EngineActionEnvelope<PlaybackReleaseAction>>,
    mut results: MessageWriter<StepFxCommandResult>,
    mut commands: Commands,
    selection_resolver: SpatialSelectionResolver,
    blueprint_data_provider: Option<Res<DataProvider<Blueprint>>>,
) {
    let mut definitions_by_id = step_fx_query
        .iter()
        .map(|(entity, step_fx)| (step_fx.identifiers.id, (entity, step_fx.clone())))
        .collect::<HashMap<_, _>>();
    let mut definitions_by_uid = step_fx_query
        .iter()
        .map(|(entity, step_fx)| (step_fx.identifiers.uid, (entity, step_fx.clone())))
        .collect::<HashMap<_, _>>();
    let mut original_entities_by_current = step_fx_query
        .iter()
        .map(|(entity, _)| (entity, vec![entity]))
        .collect::<HashMap<_, _>>();

    for event in events.read() {
        let result = match &event.command {
            StepFxCommand::Create(step_fx_draft) => {
                let Some(blueprint_data_provider) = blueprint_data_provider.as_deref() else {
                    results.write(StepFxCommandResult {
                        command_id: event.command_id,
                        result: Err(CommandError::new(
                            "blueprint.provider_unavailable",
                            "Blueprint state is unavailable",
                        )),
                    });
                    continue;
                };
                match resolve_step_fx_draft(step_fx_draft.clone(), blueprint_data_provider) {
                    Ok(step_fx) => store_step_fx_definition(
                        step_fx,
                        &selection_resolver,
                        &step_fx_query,
                        &active_fx_query,
                        &mut definitions_by_id,
                        &mut definitions_by_uid,
                        &mut original_entities_by_current,
                        &mut commands,
                    ),
                    Err(error) => Err(error),
                }
            }
            StepFxCommand::Store(step_fx) => store_step_fx_definition(
                step_fx.clone(),
                &selection_resolver,
                &step_fx_query,
                &active_fx_query,
                &mut definitions_by_id,
                &mut definitions_by_uid,
                &mut original_entities_by_current,
                &mut commands,
            ),

            StepFxCommand::Delete(fx_id) => {
                let fx_id = *fx_id;
                let Some((fx_entity, step_fx)) = definitions_by_id.remove(&fx_id) else {
                    results.write(StepFxCommandResult {
                        command_id: event.command_id,
                        result: Err(CommandError::new(
                            "fx.step_not_found",
                            format!("Step FX {fx_id} does not exist"),
                        )),
                    });
                    continue;
                };
                definitions_by_uid.remove(&step_fx.identifiers.uid);
                let original_entities = original_entities_by_current
                    .remove(&fx_entity)
                    .unwrap_or_default();
                for (active_entity, active, instance_id, _, _, _, _, _) in active_fx_query.iter() {
                    if active.fx_entity == fx_entity
                        || original_entities.contains(&active.fx_entity)
                    {
                        stop_active_step_fx(
                            active_entity,
                            instance_id,
                            event,
                            &mut commands,
                            &mut instance_events,
                        );
                    }
                }
                commands.entity(fx_entity).despawn();
                Ok(())
            }

            StepFxCommand::Start(fx_id) => {
                let fx_id = *fx_id;

                let fx_definition = definitions_by_id.get(&fx_id).cloned();

                if let Some((fx_entity, step_fx)) = fx_definition {
                    let original_entities = original_entities_by_current.get(&fx_entity);
                    if let Some((active_entity, _, instance_id, controls, _, clock, _, metadata)) =
                        active_fx_query
                            .iter()
                            .find(|(_, active, _, _, _, _, _, _)| {
                                (active.fx_entity == fx_entity
                                    || original_entities.is_some_and(|entities| {
                                        entities.contains(&active.fx_entity)
                                    }))
                                    && active.is_playing
                            })
                    {
                        let instance_id = instance_id.copied().unwrap_or_else(InstanceId::new);
                        commands
                            .entity(active_entity)
                            .insert((
                                instance_id,
                                refreshed_step_fx_playback_metadata(
                                    metadata,
                                    step_fx.identifiers.label.clone(),
                                ),
                                controls.cloned().unwrap_or_default(),
                                clock.cloned().unwrap_or_default(),
                            ))
                            .remove::<ReleaseMarker>();
                        tracing::debug!(fx_id = fx_id, "Step FX already active");
                    } else {
                        tracing::debug!(fx_id = fx_id, "Starting step FX");
                        commands.spawn((
                            ActiveStepFx {
                                fx_entity,
                                priority: Priority(50),
                                rate: 1.0,
                                is_playing: true,
                            },
                            InstanceId::new(),
                            InstanceMetadata::new(InstanceKind::Fx)
                                .with_display_kind(InstanceDisplayKind::StepFx)
                                .with_name(step_fx.identifiers.label.clone()),
                            InstanceControls::default(),
                            InstanceClock::default(),
                        ));
                    }
                } else {
                    tracing::warn!(fx_id = fx_id, "Step FX not found");
                    results.write(StepFxCommandResult {
                        command_id: event.command_id,
                        result: Err(CommandError::new(
                            "fx.step_not_found",
                            format!("Step FX {fx_id} does not exist"),
                        )),
                    });
                    continue;
                }
                Ok(())
            }

            StepFxCommand::Stop(fx_id) => {
                let fx_id = *fx_id;

                // Find the StepFx entity by ID
                let fx_entity = step_fx_query
                    .iter()
                    .find(|(_, fx)| fx.identifiers.id == fx_id)
                    .map(|(entity, _)| entity);

                if let Some(fx_entity) = fx_entity {
                    // Find and mark for release matching ActiveStepFx entities
                    for (active_entity, active, instance_id, _, _, _, _, _) in
                        active_fx_query.iter()
                    {
                        if active.fx_entity == fx_entity {
                            tracing::debug!(fx_id = fx_id, "Stopping step FX");
                            stop_active_step_fx(
                                active_entity,
                                instance_id,
                                event,
                                &mut commands,
                                &mut instance_events,
                            );
                        }
                    }
                } else {
                    tracing::warn!(fx_id = fx_id, "Step FX not found");
                    results.write(StepFxCommandResult {
                        command_id: event.command_id,
                        result: Err(CommandError::new(
                            "fx.step_not_found",
                            format!("Step FX {fx_id} does not exist"),
                        )),
                    });
                    continue;
                }
                Ok(())
            }

            StepFxCommand::SetRate { fx_id, rate } => {
                let fx_id = *fx_id;
                let rate = *rate;

                // Find the StepFx entity by ID
                let fx_entity = step_fx_query
                    .iter()
                    .find(|(_, fx)| fx.identifiers.id == fx_id)
                    .map(|(entity, _)| entity);

                if let Some(fx_entity) = fx_entity {
                    // Find and update matching ActiveStepFx
                    let mut updated = false;
                    for (active_entity, active, _, _, _, _, _, _) in active_fx_query.iter() {
                        if active.fx_entity == fx_entity && active.is_playing {
                            tracing::debug!(fx_id = fx_id, rate = rate, "Setting step FX rate");
                            commands.entity(active_entity).insert(ActiveStepFx {
                                fx_entity,
                                priority: active.priority,
                                rate,
                                is_playing: true,
                            });
                            updated = true;
                            break;
                        }
                    }
                    if !updated {
                        Err(CommandError::new(
                            "fx.step_not_active",
                            format!("Step FX {fx_id} is not active"),
                        ))
                    } else {
                        Ok(())
                    }
                } else {
                    tracing::warn!(fx_id = fx_id, "Step FX not found or not active");
                    Err(CommandError::new(
                        "fx.step_not_found",
                        format!("Step FX {fx_id} does not exist"),
                    ))
                }
            }
        };

        results.write(StepFxCommandResult {
            command_id: event.command_id,
            result,
        });
    }
}

/// Publishes terminal outcomes after deferred step FX mutations have applied.
pub fn finish_step_fx_commands(
    mut events: MessageReader<StepFxCommandResult>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let response = match &event.result {
            Ok(()) => responder.succeed(event.command_id),
            Err(error) => responder.fail(event.command_id, error.clone()),
        };
        if let Err(error) = response {
            tracing::error!(
                command_id = %event.command_id,
                %error,
                "step_fx_command_completion_failed"
            );
        }
    }
}

/// Releases a command-targeted playback through its instance identity when available.
fn stop_active_step_fx(
    active_entity: Entity,
    instance_id: Option<&InstanceId>,
    event: &CommandEnvelope<StepFxCommand>,
    commands: &mut Commands,
    instance_events: &mut MessageWriter<EngineActionEnvelope<PlaybackReleaseAction>>,
) {
    if let Some(instance_id) = instance_id {
        instance_events.write(EngineActionEnvelope::for_command(
            event,
            PlaybackReleaseAction::One(*instance_id),
        ));
    } else {
        commands
            .entity(active_entity)
            .insert(ReleaseMarker::default());
    }
}

#[cfg(test)]
mod tests;
