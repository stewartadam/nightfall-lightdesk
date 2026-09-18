// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Flow command event handlers.

use std::time::Duration;

use bevy_ecs::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_instances::{
    ClipInstanceAttachment, ClipInstanceStartContext, DomainInstanceReconstructionRequest,
    InstanceClock, InstanceControls, InstanceDisplayKind, InstanceId, InstanceKind,
    InstanceMetadata, InstanceStatus, Owner, PlaybackReleaseAction,
    instance_clock_from_reconstruction_timing, reconcile_instance_options,
};
use nightfall_playback_planner::{PlannedPlaybackSource, PlaybackReconstructionTiming};

use crate::FlowCommand;
use crate::definition::FlowDefinition;
use crate::nodes::FlowNodeRegistry;
use crate::protocol::{FlowAck, FlowDelta, FlowDeltaError, FlowDeltaOp};
use crate::runtime::{FlowInstance, FlowRuntime};
use crate::types::FlowValue;

#[derive(Clone, Debug)]
enum FlowCommandSuccess {
    Applied,
    DeltaApplied(FlowAck),
}

#[derive(Clone, Debug)]
enum FlowCommandFailure {
    NotFound(u32),
    NotRunning(u32),
    StoreFailed(String),
    RenameFailed { id: u32, new_id: u32, error: String },
    DeleteFailed { id: u32, error: String },
    DeltaRejected(FlowAck),
    DeltaStoreFailed(FlowAck),
    GoNotSupported,
}

/// Flow instances and mutable clocks used by playback controls.
type FlowControlData = (
    Entity,
    &'static mut FlowInstance,
    Option<&'static InstanceId>,
    Option<&'static InstanceControls>,
    Option<&'static mut InstanceClock>,
);

/// Flow layers and clocks used to update release compositing.
type ReleasingFlowData = (
    Entity,
    &'static FlowInstance,
    Option<&'static Layer>,
    Option<&'static InstanceClock>,
    Option<&'static mut LayerCompositingContext>,
);

impl FlowCommandFailure {
    /// Converts a typed flow failure into its safe transport-facing representation.
    fn into_command_error(self) -> CommandError {
        match self {
            Self::NotFound(id) => {
                CommandError::new("flow.not_found", format!("Flow {id} does not exist"))
            }
            Self::NotRunning(id) => {
                CommandError::new("flow.not_running", format!("Flow {id} is not running"))
            }
            Self::StoreFailed(error) => CommandError::new(
                "flow.store_failed",
                format!("Unable to store flow: {error}"),
            ),
            Self::RenameFailed { id, new_id, error } => CommandError::new(
                "flow.rename_failed",
                format!("Unable to rename flow {id} to {new_id}: {error}"),
            ),
            Self::DeleteFailed { id, error } => CommandError::new(
                "flow.delete_failed",
                format!("Unable to delete flow {id}: {error}"),
            ),
            Self::DeltaRejected(ack) => CommandError::new(
                "flow.delta_rejected",
                "The flow delta contains invalid operations",
            )
            .with_details(serde_json::to_value(ack).unwrap_or_default()),
            Self::DeltaStoreFailed(ack) => CommandError::new(
                "flow.delta_store_failed",
                "Unable to persist the flow delta",
            )
            .with_details(serde_json::to_value(ack).unwrap_or_default()),
            Self::GoNotSupported => CommandError::new(
                "flow.go_not_supported",
                "Flow advancement is not implemented",
            ),
        }
    }
}

/// Completes every admitted flow command with an actionable error when flows are disabled.
pub fn reject_disabled_commands(
    mut events: MessageReader<CommandEnvelope<FlowCommand>>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        if let Err(error) = responder.fail(event.command_id, CommandError::new(
            "flow.feature_disabled",
            "Flows are experimental and disabled. Restart the backend with NIGHTFALL_EXPERIMENTAL_FLOWS=1 to enable them.",
        )) {
            tracing::error!(command_id = %event.command_id, %error, "flow_command_completion_failed");
        }
    }
}

/// Domain-local outcome emitted after one flow command has applied its mutations.
#[derive(Clone, Debug, Message)]
pub struct FlowCommandResult {
    /// User command whose flow work finished.
    command_id: CommandId,
    /// Optional delta acknowledgement or a structured command failure.
    result: Result<FlowCommandSuccess, FlowCommandFailure>,
}

/// Rewrites dynamic group references in one flow value before it is persisted.
fn stabilize_flow_value_group_refs(
    value: &mut FlowValue,
    selection_resolver: &SpatialSelectionResolver,
) {
    let FlowValue::Selection(selection) = value else {
        return;
    };

    let stabilized = selection_resolver.stabilize_group_refs_selection(selection);
    for warning in &stabilized.issues {
        tracing::warn!("{}", warning);
    }
    *selection = stabilized.value;
}

/// Rewrites dynamic group references in flow node default selections before storage.
fn stabilize_flow_definition_group_refs(
    flow: &mut FlowDefinition,
    selection_resolver: &SpatialSelectionResolver,
) {
    for node in &mut flow.nodes {
        for port in &mut node.ports {
            let Some(value) = &mut port.default_value else {
                continue;
            };
            stabilize_flow_value_group_refs(value, selection_resolver);
        }
    }
}

/// Rewrites dynamic group references in a flow delta before applying and broadcasting it.
fn stabilize_flow_delta_group_refs(
    delta: &mut FlowDelta,
    selection_resolver: &SpatialSelectionResolver,
) {
    for op in &mut delta.ops {
        match op {
            FlowDeltaOp::AddNode(node) => {
                for port in &mut node.ports {
                    let Some(value) = &mut port.default_value else {
                        continue;
                    };
                    stabilize_flow_value_group_refs(value, selection_resolver);
                }
            }
            FlowDeltaOp::UpdatePortConfig(port_update) => {
                let Some(value) = &mut port_update.default_value else {
                    continue;
                };
                stabilize_flow_value_group_refs(value, selection_resolver);
            }
            FlowDeltaOp::UpdateNode(_)
            | FlowDeltaOp::RemoveNode { .. }
            | FlowDeltaOp::AddEdge(_)
            | FlowDeltaOp::RemoveEdge(_) => {}
        }
    }
}

/// Converts reconstruction timing into a start clock position.
fn playback_start_timing(timing: PlaybackReconstructionTiming) -> PlaybackReconstructionTiming {
    PlaybackReconstructionTiming {
        started_at: Duration::ZERO,
        position: timing.elapsed(),
        source: timing.source,
    }
}

/// Context from directly materializing a reconstructed flow playback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MaterializedFlowReconstructionHandle {
    /// Entity containing the reconstructed `FlowInstance`.
    pub flow_entity: Entity,
    /// Runtime instance ID attached to the reconstructed flow.
    pub instance_id: InstanceId,
}

/// Clip-routed playback actions owned by the flow domain.
#[derive(Debug, Clone, EnginePayload)]
pub enum FlowPlaybackAction {
    /// Start or refresh a flow playback for a clip.
    Start {
        /// Flow source UID to materialize.
        flow_uid: uuid::Uuid,
        /// Shared clip metadata for the routed start.
        context: ClipInstanceStartContext,
    },
    /// Release flow instances attached to a clip.
    Stop {
        /// Numeric clip ID whose playback slot requested the action.
        clip_id: u32,
        /// Runtime instances currently attached to the clip.
        attached_instances: Vec<InstanceId>,
        /// Optional source-local release timing.
        timing: Option<PlaybackReconstructionTiming>,
    },
}

impl EngineAction for FlowPlaybackAction {}

/// Directly materializes flow playback reconstruction for a clip.
pub fn spawn_reconstructed_flow_for_clip(
    commands: &mut Commands,
    clip_uid: uuid::Uuid,
    flow: &FlowDefinition,
    registry: &FlowNodeRegistry,
    instances: &mut Query<(
        Entity,
        &mut FlowInstance,
        Option<&InstanceId>,
        Option<&InstanceControls>,
    )>,
    instance_clock: InstanceClock,
) -> MaterializedFlowReconstructionHandle {
    for (entity, mut instance, instance_id, controls) in instances.iter_mut() {
        if instance.flow_id != flow.identifiers.id {
            continue;
        }

        *instance = FlowInstance::new(
            flow.identifiers.id,
            FlowRuntime::new(flow.clone()),
            registry,
        );
        let instance_id = instance_id.copied().unwrap_or_else(InstanceId::new);
        commands
            .entity(entity)
            .insert((
                instance_id,
                InstanceMetadata::new(InstanceKind::Flow)
                    .with_display_kind(InstanceDisplayKind::FlowFx)
                    .with_name(flow.identifiers.label.clone()),
                controls.cloned().unwrap_or_default(),
                instance_clock,
                InstanceStatus::default(),
                Owner(clip_uid),
            ))
            .remove::<ReleaseMarker>()
            .remove::<LayerCompositingContext>();

        return MaterializedFlowReconstructionHandle {
            flow_entity: entity,
            instance_id,
        };
    }

    let instance_id = InstanceId::new();
    let instance = FlowInstance::new(
        flow.identifiers.id,
        FlowRuntime::new(flow.clone()),
        registry,
    );
    let flow_entity = commands
        .spawn((
            instance,
            instance_id,
            InstanceMetadata::new(InstanceKind::Flow)
                .with_display_kind(InstanceDisplayKind::FlowFx)
                .with_name(flow.identifiers.label.clone()),
            InstanceControls::default(),
            instance_clock,
            InstanceStatus::default(),
            Owner(clip_uid),
        ))
        .id();

    MaterializedFlowReconstructionHandle {
        flow_entity,
        instance_id,
    }
}

/// Reconstructs timeline-requested flow playback while keeping Flow-owned semantics local.
pub fn handle_domain_playback_reconstruction_requests(
    mut events: MessageReader<DomainInstanceReconstructionRequest>,
    flow_data_provider: Res<DataProvider<FlowDefinition>>,
    registry: Res<FlowNodeRegistry>,
    mut instances: Query<(
        Entity,
        &mut FlowInstance,
        Option<&InstanceId>,
        Option<&InstanceControls>,
    )>,
    mut commands: Commands,
) {
    for event in events.read() {
        let PlannedPlaybackSource::Flow(flow_uid) = event.source else {
            continue;
        };
        let Ok(flow) = flow_data_provider.get(flow_uid) else {
            tracing::warn!(
                flow_uid = %flow_uid,
                clip_uid = %event.clip_uid,
                "Skipping Flow reconstruction for missing source"
            );
            continue;
        };
        spawn_reconstructed_flow_for_clip(
            &mut commands,
            event.clip_uid,
            &flow,
            &registry,
            &mut instances,
            event.clock.clone(),
        );
    }
}

/// Handle control commands (start/stop/go).
pub fn handle_events(
    mut commands: Commands,
    flow_data_provider: Res<DataProvider<FlowDefinition>>,
    registry: Res<FlowNodeRegistry>,
    mut instances: Query<FlowControlData>,
    mut layers: Query<&mut Layer>,
    mut flow_events: MessageReader<CommandEnvelope<FlowCommand>>,
    mut command_results: MessageWriter<FlowCommandResult>,
    playback_actions: Option<MessageReader<EngineActionEnvelope<FlowPlaybackAction>>>,
    attachments: Option<MessageWriter<EventEnvelope<ClipInstanceAttachment>>>,
) {
    for event in flow_events.read() {
        let result = match &event.command {
            FlowCommand::StartFlow(id) => {
                let mut restarted = false;
                for (entity, mut instance, instance_id, controls, _) in instances.iter_mut() {
                    if instance.flow_id == *id {
                        if instance.is_running() {
                            tracing::debug!("Flow {} already running", id);
                        } else {
                            instance.restart();
                            tracing::debug!("Restarted flow {}", id);
                        }
                        let instance_id = instance_id.copied().unwrap_or_else(InstanceId::new);
                        commands
                            .entity(entity)
                            .insert((
                                instance_id,
                                InstanceMetadata::new(InstanceKind::Flow)
                                    .with_display_kind(InstanceDisplayKind::FlowFx)
                                    .with_name(
                                        instance.runtime.definition.identifiers.label.clone(),
                                    ),
                                controls.cloned().unwrap_or_default(),
                                InstanceClock::default(),
                                InstanceStatus::default(),
                            ))
                            .remove::<ReleaseMarker>()
                            .remove::<LayerCompositingContext>();
                        restarted = true;
                        break;
                    }
                }
                if restarted {
                    Ok(FlowCommandSuccess::Applied)
                } else {
                    match flow_data_provider.from_id(*id).map(|flow| flow.clone()) {
                        Ok(definition) => {
                            let label = definition.identifiers.label.clone();
                            let runtime = FlowRuntime::new(definition);
                            commands.spawn((
                                FlowInstance::new(*id, runtime, &registry),
                                InstanceId::new(),
                                InstanceMetadata::new(InstanceKind::Flow)
                                    .with_display_kind(InstanceDisplayKind::FlowFx)
                                    .with_name(label),
                                InstanceControls::default(),
                                InstanceClock::default(),
                                InstanceStatus::default(),
                            ));
                            tracing::debug!("Started flow {}", id);
                            Ok(FlowCommandSuccess::Applied)
                        }
                        Err(_) => Err(FlowCommandFailure::NotFound(*id)),
                    }
                }
            }
            FlowCommand::StopFlow(id) => {
                let mut found = false;
                for (entity, mut instance, instance_id, _, clock) in instances.iter_mut() {
                    if instance.flow_id == *id {
                        stop_flow_instance(
                            &mut commands,
                            entity,
                            &mut instance,
                            instance_id,
                            clock.as_deref(),
                            None,
                            &mut layers,
                        );
                        found = true;
                    }
                }
                if !found {
                    tracing::warn!("Failed to stop flow {}: not running", id);
                    Err(FlowCommandFailure::NotRunning(*id))
                } else {
                    Ok(FlowCommandSuccess::Applied)
                }
            }
            FlowCommand::GoFlow(id) => {
                tracing::debug!("Go flow requested: {}", id);
                Err(FlowCommandFailure::GoNotSupported)
            }
            _ => continue,
        };
        command_results.write(FlowCommandResult {
            command_id: event.command_id,
            result,
        });
    }

    let (Some(mut playback_actions), Some(mut attachments)) = (playback_actions, attachments)
    else {
        return;
    };

    for event in playback_actions.read() {
        match &event.action {
            FlowPlaybackAction::Start { flow_uid, context } => {
                let context = *context;
                let Ok(flow) = flow_data_provider.get(*flow_uid).map(|flow| flow.clone()) else {
                    tracing::warn!(
                        clip_id = context.clip_id,
                        flow_uid = %flow_uid,
                        "Failed to start clip: flow source not found"
                    );
                    continue;
                };

                let mut attached_instance = None;
                let mut restarted = false;

                for (entity, mut instance, instance_id, controls, clock) in instances.iter_mut() {
                    if instance.flow_id != flow.identifiers.id {
                        continue;
                    }

                    if instance.is_running() {
                        tracing::debug!("Flow {} already running", flow.identifiers.id);
                    } else {
                        instance.restart();
                        commands.entity(entity).remove::<ReleaseMarker>();
                        tracing::debug!("Restarted flow {}", flow.identifiers.id);
                    }
                    let instance_id = instance_id.copied().unwrap_or_else(InstanceId::new);
                    attached_instance = Some(instance_id);
                    let instance_clock = context
                        .timing
                        .map(playback_start_timing)
                        .map(instance_clock_from_reconstruction_timing)
                        .unwrap_or_default();

                    let mut entity_commands = commands.entity(entity);
                    entity_commands.insert((
                        instance_id,
                        InstanceMetadata::new(InstanceKind::Flow)
                            .with_display_kind(InstanceDisplayKind::FlowFx)
                            .with_name(flow.identifiers.label.clone()),
                        controls.cloned().unwrap_or_default(),
                        InstanceStatus::default(),
                        Owner(context.clip_uid),
                    ));
                    reconcile_instance_options(&mut entity_commands, context.instance_options);
                    if let Some(mut clock) = clock {
                        *clock = instance_clock;
                    } else {
                        entity_commands.insert(instance_clock);
                    }
                    restarted = true;
                    break;
                }

                if !restarted {
                    let instance_id = InstanceId::new();
                    let runtime = FlowRuntime::new(flow.clone());
                    let instance = FlowInstance::new(flow.identifiers.id, runtime, &registry);
                    let instance_clock = context
                        .timing
                        .map(playback_start_timing)
                        .map(instance_clock_from_reconstruction_timing)
                        .unwrap_or_default();
                    let flow_entity = commands
                        .spawn((
                            instance,
                            instance_id,
                            InstanceMetadata::new(InstanceKind::Flow)
                                .with_display_kind(InstanceDisplayKind::FlowFx)
                                .with_name(flow.identifiers.label.clone()),
                            InstanceControls::default(),
                            instance_clock,
                            InstanceStatus::default(),
                            Owner(context.clip_uid),
                        ))
                        .id();
                    if let Some(instance_options) = context.instance_options {
                        commands.entity(flow_entity).insert(instance_options);
                    }
                    attached_instance = Some(instance_id);
                    tracing::debug!(
                        "Started flow {} from clip {}",
                        flow.identifiers.id,
                        context.clip_id
                    );
                }

                if let Some(instance_id) = attached_instance {
                    attachments.write(EventEnvelope::for_action(
                        event,
                        ClipInstanceAttachment {
                            clip_id: context.clip_id,
                            instance_id,
                            auto_release_on_stop: context.auto_release_on_stop,
                        },
                    ));
                }
            }
            FlowPlaybackAction::Stop {
                clip_id,
                attached_instances,
                timing,
            } => {
                let attached_instances = attached_instances
                    .iter()
                    .copied()
                    .collect::<std::collections::HashSet<_>>();
                let mut found = false;
                for (entity, mut instance, instance_id, _, clock) in instances.iter_mut() {
                    if !instance_id
                        .as_ref()
                        .is_some_and(|instance_id| attached_instances.contains(instance_id))
                    {
                        continue;
                    }

                    stop_flow_instance(
                        &mut commands,
                        entity,
                        &mut instance,
                        instance_id,
                        clock.as_deref(),
                        *timing,
                        &mut layers,
                    );
                    found = true;
                }

                if !found {
                    tracing::warn!("Failed to stop flow from clip {}: not running", clip_id);
                }
            }
        }
    }
}

/// Handle playback-level stop commands for active flow playback entities.
pub fn handle_playback_commands(
    mut commands: Commands,
    mut instance_events: MessageReader<EngineActionEnvelope<PlaybackReleaseAction>>,
    mut instances: Query<(
        Entity,
        &mut FlowInstance,
        &InstanceId,
        &InstanceMetadata,
        Option<&InstanceClock>,
    )>,
    mut layers: Query<&mut Layer>,
) {
    for event in instance_events.read() {
        match &event.action {
            PlaybackReleaseAction::One(target_instance_id) => {
                for (entity, mut instance, instance_id, _, clock) in instances.iter_mut() {
                    if instance_id == target_instance_id {
                        stop_flow_instance(
                            &mut commands,
                            entity,
                            &mut instance,
                            Some(instance_id),
                            clock,
                            None,
                            &mut layers,
                        );
                    }
                }
            }
            PlaybackReleaseAction::All => {
                for (entity, mut instance, instance_id, _, clock) in instances.iter_mut() {
                    stop_flow_instance(
                        &mut commands,
                        entity,
                        &mut instance,
                        Some(instance_id),
                        clock,
                        None,
                        &mut layers,
                    );
                }
            }
            PlaybackReleaseAction::ByKind(kind) => {
                for (entity, mut instance, instance_id, metadata, clock) in instances.iter_mut() {
                    if metadata.kind == *kind {
                        stop_flow_instance(
                            &mut commands,
                            entity,
                            &mut instance,
                            Some(instance_id),
                            clock,
                            None,
                            &mut layers,
                        );
                    }
                }
            }
            PlaybackReleaseAction::ByTag(tag) => {
                for (entity, mut instance, instance_id, metadata, clock) in instances.iter_mut() {
                    if metadata.tags.contains(tag) {
                        stop_flow_instance(
                            &mut commands,
                            entity,
                            &mut instance,
                            Some(instance_id),
                            clock,
                            None,
                            &mut layers,
                        );
                    }
                }
            }
        }
    }
}

fn stop_flow_instance(
    commands: &mut Commands,
    entity: Entity,
    instance: &mut FlowInstance,
    instance_id: Option<&InstanceId>,
    clock: Option<&InstanceClock>,
    release_timing: Option<PlaybackReconstructionTiming>,
    layers: &mut Query<&mut Layer>,
) {
    instance.stop();
    let release_position = release_timing
        .map(|timing| timing.started_at)
        .or_else(|| clock.map(|clock| clock.position))
        .unwrap_or_default();
    let compositing_context_position = release_timing
        .map(|timing| timing.position)
        .or_else(|| clock.map(|clock| clock.position))
        .unwrap_or(release_position);
    if let Ok(mut layer) = layers.get_mut(entity) {
        mark_layer_transitions_for_release(&mut layer, release_position);
    }
    let mut entity_commands = commands.entity(entity);
    entity_commands.insert(ReleaseMarker::default());
    if let Some(timing) = release_timing {
        entity_commands.insert(instance_clock_from_reconstruction_timing(timing));
    }
    entity_commands.insert(LayerCompositingContext {
        position: compositing_context_position,
        released_at: Some(release_position),
    });
    entity_commands.remove::<InstanceId>();
    entity_commands.remove::<InstanceMetadata>();
    entity_commands.remove::<InstanceControls>();
    entity_commands.remove::<Owner>();

    let _ = instance_id;
}

fn mark_layer_transitions_for_release(layer: &mut Layer, release_position: Duration) {
    for (_, transition) in layer.absolute.values_mut() {
        if let Some(transition) = transition {
            transition.mark_released_at_position_if_unset(release_position);
        }
    }

    for (_, transition) in layer.relative.values_mut() {
        if let Some(transition) = transition {
            transition.mark_released_at_position_if_unset(release_position);
        }
    }
}

fn max_layer_release_duration(layer: &Layer) -> std::time::Duration {
    layer
        .absolute
        .values()
        .chain(layer.relative.values())
        .filter_map(|(_, transition)| {
            transition
                .as_ref()
                .map(|transition| transition.delay_out.saturating_add(transition.fade_out))
        })
        .max()
        .unwrap_or_default()
}

/// Remove release markers and stale compositor components once flow release is complete.
pub fn cleanup_released_flow_instances(
    mut commands: Commands,
    mut instances: Query<ReleasingFlowData, With<ReleaseMarker>>,
) {
    for (entity, instance, layer, clock, compositing_context) in instances.iter_mut() {
        if instance.is_running() {
            continue;
        }

        let release_duration = layer.map(max_layer_release_duration).unwrap_or_default();
        let release_elapsed = if let Some(mut compositing_context) = compositing_context {
            if let Some(clock) = clock {
                compositing_context.position = clock.position;
            }
            compositing_context
                .elapsed_since_release()
                .unwrap_or_default()
        } else {
            Duration::ZERO
        };
        if release_elapsed < release_duration {
            continue;
        }

        commands.entity(entity).remove::<Layer>();
        commands.entity(entity).remove::<ObjectRefMarker>();
        commands.entity(entity).remove::<BaseLayer>();
        commands.entity(entity).remove::<OutputLayer>();
        commands.entity(entity).remove::<ReleaseMarker>();
        commands.entity(entity).remove::<InstanceClock>();
        commands.entity(entity).remove::<LayerCompositingContext>();
    }
}

/// CRUD operations and delta application for flow definitions.
pub fn crud_events(
    mut commands: Commands,
    mut flow_data_provider: ResMut<DataProvider<FlowDefinition>>,
    registry: Res<FlowNodeRegistry>,
    mut events: MessageReader<CommandEnvelope<FlowCommand>>,
    mut command_results: MessageWriter<FlowCommandResult>,
    broadcaster: Res<ClientEventSink>,
    mut instances: Query<(Entity, &mut FlowInstance)>,
    selection_resolver: SpatialSelectionResolver,
) {
    for event in events.read() {
        let result = match &event.command {
            FlowCommand::StoreFlow(flow) => {
                let mut flow = flow.clone();
                tracing::debug!("Storing flow with ID: {}", flow.identifiers.id);
                stabilize_flow_definition_group_refs(&mut flow, &selection_resolver);
                if let Err(e) = flow_data_provider.add(flow.clone()) {
                    tracing::warn!("Failed to store flow: {}", e);
                    Err(FlowCommandFailure::StoreFailed(e.to_string()))
                } else {
                    for (_, mut instance) in instances.iter_mut() {
                        if instance.flow_id == flow.identifiers.id {
                            instance.runtime = FlowRuntime::new(flow.clone());
                            instance.rebuild_nodes(&registry);
                            instance.last_sent_ports.clear();
                            instance.last_sent_triggers.clear();
                            instance.reset_timing();
                        }
                    }
                    Ok(FlowCommandSuccess::Applied)
                }
            }
            FlowCommand::RenameFlow { id, new_id } => {
                tracing::debug!("Renaming flow with ID: {} to {}", id, new_id);
                match flow_data_provider.from_id(*id).map(|flow| flow.clone()) {
                    Ok(mut flow) => {
                        flow.identifiers.id = *new_id;
                        match flow_data_provider.add(flow) {
                            Ok(()) => {
                                for (_, mut instance) in instances.iter_mut() {
                                    if instance.flow_id == *id {
                                        instance.flow_id = *new_id;
                                        instance.runtime.definition.identifiers.id = *new_id;
                                    }
                                }
                                Ok(FlowCommandSuccess::Applied)
                            }
                            Err(error) => Err(FlowCommandFailure::RenameFailed {
                                id: *id,
                                new_id: *new_id,
                                error: error.to_string(),
                            }),
                        }
                    }
                    Err(_) => Err(FlowCommandFailure::NotFound(*id)),
                }
            }
            FlowCommand::DeleteFlow(id) => {
                tracing::debug!("Deleting flow with ID: {}", id);
                match flow_data_provider
                    .from_id(*id)
                    .map(|flow| flow.identifiers.uid)
                {
                    Ok(uid) => match flow_data_provider.remove(&uid) {
                        Ok(_) => {
                            for (entity, instance) in instances.iter_mut() {
                                if instance.flow_id == *id {
                                    commands.entity(entity).despawn();
                                }
                            }
                            Ok(FlowCommandSuccess::Applied)
                        }
                        Err(error) => Err(FlowCommandFailure::DeleteFailed {
                            id: *id,
                            error: error.to_string(),
                        }),
                    },
                    Err(_) => Err(FlowCommandFailure::NotFound(*id)),
                }
            }
            FlowCommand::ApplyDelta(delta) => {
                let mut delta = delta.clone();
                stabilize_flow_delta_group_refs(&mut delta, &selection_resolver);
                let (ack, result) = match flow_data_provider
                    .from_id(delta.flow_id)
                    .map(|flow| flow.clone())
                {
                    Ok(mut candidate) => {
                        let application = candidate.apply_delta(&delta);
                        let mut ack = FlowAck {
                            flow_id: delta.flow_id,
                            base_version: delta.base_version,
                            applied_version: delta.base_version,
                            errors: application.errors,
                        };
                        if ack.errors.is_empty() {
                            match flow_data_provider.add(candidate) {
                                Ok(()) => {
                                    ack.applied_version = application.applied_version;
                                    broadcaster.publish(
                                        DISCRIMINATOR_NON_DROPPABLE,
                                        &crate::websocket::FlowWsMessage::FlowDelta(&delta),
                                    );

                                    for (_, mut instance) in instances.iter_mut() {
                                        if instance.flow_id == delta.flow_id {
                                            let runtime_result =
                                                instance.runtime.apply_delta(&delta);
                                            if runtime_result.applied_version != delta.base_version
                                            {
                                                instance.rebuild_nodes(&registry);
                                                instance.last_sent_ports.clear();
                                                instance.last_sent_triggers.clear();
                                            }
                                        }
                                    }
                                    (ack.clone(), Ok(FlowCommandSuccess::DeltaApplied(ack)))
                                }
                                Err(error) => {
                                    ack.errors.push(FlowDeltaError {
                                        op_index: None,
                                        message: error.to_string(),
                                    });
                                    (ack.clone(), Err(FlowCommandFailure::DeltaStoreFailed(ack)))
                                }
                            }
                        } else {
                            (ack.clone(), Err(FlowCommandFailure::DeltaRejected(ack)))
                        }
                    }
                    Err(_) => {
                        let ack = FlowAck {
                            flow_id: delta.flow_id,
                            base_version: delta.base_version,
                            applied_version: delta.base_version,
                            errors: vec![FlowDeltaError {
                                op_index: None,
                                message: format!("flow {} not found", delta.flow_id),
                            }],
                        };
                        (ack, Err(FlowCommandFailure::NotFound(delta.flow_id)))
                    }
                };
                broadcaster.publish(
                    DISCRIMINATOR_NON_DROPPABLE,
                    &crate::websocket::FlowWsMessage::FlowAck(&ack),
                );
                result
            }
            _ => continue,
        };
        command_results.write(FlowCommandResult {
            command_id: event.command_id,
            result,
        });
    }
}

/// Publishes terminal command results after flow mutations and deferred commands apply.
pub fn finish_flow_commands(
    mut events: MessageReader<FlowCommandResult>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let response = match &event.result {
            Ok(FlowCommandSuccess::DeltaApplied(ack)) => {
                responder.succeed_with_output(event.command_id, ack)
            }
            Ok(FlowCommandSuccess::Applied) => responder.succeed(event.command_id),
            Err(error) => responder.fail(event.command_id, error.clone().into_command_error()),
        };
        if let Err(error) = response {
            tracing::error!(command_id = %event.command_id, %error, "flow_command_completion_failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use bevy_app::{App, Update};
    use bevy_ecs::{message::Messages, schedule::Schedule, world::World};
    use moonshine_kind::Instance;
    use nightfall::prelude::{
        FadeCurve, FixtureRef, Group, GroupRefExpr, Identifiers, MaterializedTransition, ObjectRef,
        ObjectType, Priority, SelectionExpr, SpatialSelection,
    };
    use nightfall_clips::MaterializedClip;
    use nightfall_dmx::prelude::{Attribute, ParameterValue};
    use nightfall_fixtures::prelude::{
        Fixture, FixtureDataProviderExt, FixtureElement, Parameter, ParameterMetadata,
        ParameterValues,
    };
    use nightfall_instances::{
        InstanceClock, InstanceClockSource, InstanceControls, InstanceDisplayKind, InstanceId,
        InstanceKind, InstanceMetadata, InstanceStatus,
    };
    use nightfall_playback_planner::PlaybackReconstructionTiming;
    use uuid::Uuid;

    use super::*;

    /// Build clip start context for flow playback action tests.
    fn test_start_context(
        clip_id: u32,
        clip_uid: Uuid,
        timing: Option<PlaybackReconstructionTiming>,
        auto_release_on_stop: bool,
    ) -> ClipInstanceStartContext {
        ClipInstanceStartContext {
            clip_id,
            clip_uid,
            priority: Priority::default(),
            timing,
            instance_options: None,
            attached_instance: None,
            auto_release_on_stop,
        }
    }

    /// Initializes semantic flow command messages used by focused schedule tests.
    fn init_flow_command_messages(world: &mut World) {
        world.insert_resource(Messages::<CommandEnvelope<FlowCommand>>::default());
        world.insert_resource(Messages::<FlowCommandResult>::default());
    }

    /// Writes one detached semantic command for focused handler tests.
    fn write_flow_command(world: &mut World, command: FlowCommand) {
        world
            .resource_mut::<Messages<CommandEnvelope<FlowCommand>>>()
            .write(CommandEnvelope::new(
                command,
                CommandOrigin::Cli,
                ReplyTarget::Detached,
            ));
    }

    /// Creates an app containing the complete semantic flow command lifecycle.
    fn flow_command_app() -> App {
        let mut app = App::new();
        app.insert_resource(RuntimeCapabilities {
            experimental_flows: true,
            ..Default::default()
        });
        app.init_resource::<DataProvider<FlowDefinition>>();
        app.init_resource::<DataProvider<Group>>();
        app.insert_resource(FixtureDataProviderExt::default());
        app.init_resource::<FlowNodeRegistry>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<FlowCommand>>();
        app.add_message::<FlowCommandResult>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        let (sender, _receiver) = async_channel::unbounded();
        app.insert_resource(ClientEventSink::new(sender));
        app.add_systems(
            Update,
            (
                (handle_events, crud_events)
                    .chain()
                    .run_if(crate::experimental_flows_enabled),
                reject_disabled_commands.run_if(not(crate::experimental_flows_enabled)),
                finish_flow_commands,
            )
                .chain(),
        );
        app
    }

    /// Registers and submits one flow command to the semantic test app.
    fn submit_flow_command(app: &mut App, command: FlowCommand) -> CommandId {
        let envelope =
            CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::ClientBroadcast);
        let command_id = envelope.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .unwrap();
        app.world_mut().write_message(envelope);
        command_id
    }

    /// Drains the one terminal result expected after a semantic flow command.
    fn take_flow_result(app: &mut App) -> CommandResult {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("flow command should publish one terminal result")
    }

    /// Verifies disabled commands finish with a feature error and leave stored definitions intact.
    #[test]
    fn disabled_flows_preserve_data_and_reject_commands() {
        let mut app = flow_command_app();
        app.world_mut()
            .resource_mut::<RuntimeCapabilities>()
            .experimental_flows = false;
        let flow = FlowDefinition::new(Identifiers {
            id: 1,
            label: "Saved flow".into(),
            ..Default::default()
        });
        app.world_mut()
            .resource_mut::<DataProvider<FlowDefinition>>()
            .add(flow)
            .unwrap();
        submit_flow_command(&mut app, FlowCommand::DeleteFlow(1));
        app.update();
        let result = take_flow_result(&mut app);
        assert!(
            matches!(result.outcome, CommandOutcome::Failed(ref error) if error.code == "flow.feature_disabled")
        );
        assert!(
            app.world()
                .resource::<DataProvider<FlowDefinition>>()
                .iter()
                .any(|entry| entry.value().identifiers.id == 1)
        );
        submit_flow_command(&mut app, FlowCommand::StartFlow(1));
        app.update();
        let result = take_flow_result(&mut app);
        assert!(
            matches!(result.outcome, CommandOutcome::Failed(ref error) if error.code == "flow.feature_disabled")
        );
        assert_eq!(
            app.world_mut()
                .query::<&FlowInstance>()
                .iter(app.world())
                .count(),
            0
        );
    }

    /// Verifies that a flow store reports success only after the definition is persisted.
    #[test]
    fn store_flow_persists_and_returns_success() {
        let mut app = flow_command_app();
        let flow = FlowDefinition::new(Identifiers {
            id: 42,
            label: "Lifecycle Flow".to_string(),
            ..Default::default()
        });
        let command_id = submit_flow_command(&mut app, FlowCommand::StoreFlow(flow));

        app.update();

        assert!(
            app.world()
                .resource::<DataProvider<FlowDefinition>>()
                .from_id(42)
                .is_ok()
        );
        let result = take_flow_result(&mut app);
        assert_eq!(result.command_id, command_id);
        assert_eq!(result.outcome, CommandOutcome::succeeded());
    }

    /// Verifies flow storage stabilizes authored group IDs in selection defaults.
    #[test]
    fn store_flow_stabilizes_group_refs_before_persistence() {
        let mut app = flow_command_app();
        app.world_mut()
            .resource_mut::<DataProvider<Group>>()
            .add(Group {
                identifiers: Identifiers {
                    id: 7,
                    uid: Uuid::from_u128(0x707),
                    label: "Key lights".to_string(),
                },
                selection: SpatialSelection::default(),
                description: String::new(),
            })
            .expect("group should insert cleanly");
        let mut flow = FlowDefinition::new(Identifiers {
            id: 43,
            label: "Stable Selection Flow".to_string(),
            ..Default::default()
        });
        flow.nodes.push(crate::types::FlowNodeDefinition {
            node_id: 1,
            kind: "constant_selection".to_string(),
            label: "Selection".to_string(),
            ports: vec![crate::types::FlowPortDefinition {
                port_id: 1,
                name: "Selection".to_string(),
                direction: crate::types::FlowPortDirection::Input,
                port_type: crate::types::FlowPortType::Selection,
                is_optional: false,
                default_value: Some(FlowValue::Selection(SpatialSelection::identity(
                    SelectionExpr::Group(GroupRefExpr::ById(7)),
                ))),
                enum_options: None,
            }],
            position: None,
        });
        submit_flow_command(&mut app, FlowCommand::StoreFlow(flow));

        app.update();

        let stored = app
            .world()
            .resource::<DataProvider<FlowDefinition>>()
            .from_id(43)
            .expect("flow should be stored");
        let Some(FlowValue::Selection(selection)) = &stored.nodes[0].ports[0].default_value else {
            panic!("stored port should keep a selection default");
        };
        assert!(matches!(
            &selection.source,
            SelectionExpr::Group(GroupRefExpr::ByUid { uid }) if *uid == Uuid::from_u128(0x707)
        ));
    }

    /// Verifies flow deltas stabilize authored group IDs before mutating stored definitions.
    #[test]
    fn apply_flow_delta_stabilizes_group_refs_before_persistence() {
        let mut app = flow_command_app();
        let group_uid = Uuid::from_u128(0x708);
        app.world_mut()
            .resource_mut::<DataProvider<Group>>()
            .add(Group {
                identifiers: Identifiers {
                    id: 8,
                    uid: group_uid,
                    label: "Delta target".to_owned(),
                },
                selection: SpatialSelection::default(),
                description: String::new(),
            })
            .expect("group should insert cleanly");
        app.world_mut()
            .resource_mut::<DataProvider<FlowDefinition>>()
            .add(FlowDefinition::new(Identifiers {
                id: 44,
                label: "Delta Selection Flow".to_owned(),
                ..Default::default()
            }))
            .expect("flow should insert cleanly");
        submit_flow_command(
            &mut app,
            FlowCommand::ApplyDelta(FlowDelta {
                flow_id: 44,
                base_version: 0,
                ops: vec![FlowDeltaOp::AddNode(crate::types::FlowNodeDefinition {
                    node_id: 1,
                    kind: "constant_selection".to_owned(),
                    label: "Selection".to_owned(),
                    ports: vec![crate::types::FlowPortDefinition {
                        port_id: 1,
                        name: "Selection".to_owned(),
                        direction: crate::types::FlowPortDirection::Input,
                        port_type: crate::types::FlowPortType::Selection,
                        is_optional: false,
                        default_value: Some(FlowValue::Selection(SpatialSelection::identity(
                            SelectionExpr::Group(GroupRefExpr::ById(8)),
                        ))),
                        enum_options: None,
                    }],
                    position: None,
                })],
            }),
        );

        app.update();

        let stored = app
            .world()
            .resource::<DataProvider<FlowDefinition>>()
            .from_id(44)
            .expect("flow should remain stored");
        let Some(FlowValue::Selection(selection)) = &stored.nodes[0].ports[0].default_value else {
            panic!("stored port should keep a selection default");
        };
        assert_eq!(
            selection.source,
            SelectionExpr::Group(GroupRefExpr::ByUid { uid: group_uid })
        );
    }

    /// Verifies that starting an unknown flow returns a stable domain failure.
    #[test]
    fn start_missing_flow_returns_failure() {
        let mut app = flow_command_app();
        submit_flow_command(&mut app, FlowCommand::StartFlow(404));

        app.update();

        assert!(matches!(
            take_flow_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "flow.not_found"
        ));
    }

    /// Verifies that a rejected multi-op delta leaves the stored flow unchanged.
    #[test]
    fn rejected_flow_delta_is_atomic() {
        let mut app = flow_command_app();
        let flow = FlowDefinition::new(Identifiers {
            id: 9,
            label: "Atomic Flow".to_string(),
            ..Default::default()
        });
        app.world_mut()
            .resource_mut::<DataProvider<FlowDefinition>>()
            .add(flow)
            .unwrap();
        let delta = crate::protocol::FlowDelta {
            flow_id: 9,
            base_version: 0,
            ops: vec![
                crate::protocol::FlowDeltaOp::AddNode(crate::types::FlowNodeDefinition {
                    node_id: 1,
                    kind: "test".to_string(),
                    label: "Valid node".to_string(),
                    ports: Vec::new(),
                    position: None,
                }),
                crate::protocol::FlowDeltaOp::RemoveNode { node_id: 999 },
            ],
        };
        submit_flow_command(&mut app, FlowCommand::ApplyDelta(delta));

        app.update();

        let stored = app
            .world()
            .resource::<DataProvider<FlowDefinition>>()
            .from_id(9)
            .unwrap();
        assert_eq!(stored.flow_version, 0);
        assert!(stored.nodes.is_empty());
        drop(stored);
        assert!(matches!(
            take_flow_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. })
                if code == "flow.delta_rejected"
        ));
    }

    #[test]
    fn stop_flow_marks_layer_transition_release_position() {
        let mut world = World::new();
        world.insert_resource(DataProvider::<FlowDefinition>::default());
        init_flow_command_messages(&mut world);
        world.insert_resource(Messages::<EngineActionEnvelope<FlowPlaybackAction>>::default());
        world.insert_resource(Messages::<EventEnvelope<ClipInstanceAttachment>>::default());

        let registry = FlowNodeRegistry::default();
        let definition = FlowDefinition::new(Identifiers {
            id: 1,
            label: "Flow 1".to_string(),
            ..Default::default()
        });
        let instance = FlowInstance::new(1, FlowRuntime::new(definition), &registry);
        world.insert_resource(registry);

        let parameter =
            unsafe { Instance::<Parameter>::from_entity_unchecked(world.spawn_empty().id()) };
        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_millis(100),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_millis(100),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        let mut layer = Layer::new("flow-layer".to_string(), Priority::default());
        layer.absolute.insert(
            parameter,
            (ParameterValue::Absolute { value: 255.0 }, Some(transition)),
        );

        let mut clock = InstanceClock {
            source: InstanceClockSource::ExternalPosition,
            ..Default::default()
        };
        clock.seek_to(Duration::from_millis(450));

        world.spawn((instance, layer, clock));

        write_flow_command(&mut world, FlowCommand::StopFlow(1));

        let mut schedule = Schedule::default();
        schedule.add_systems(handle_events);
        schedule.run(&mut world);

        let mut query = world.query::<(
            &FlowInstance,
            &Layer,
            &ReleaseMarker,
            &LayerCompositingContext,
        )>();
        let (instance, layer, _release_marker, compositing_context) = query.single(&world).expect(
            "expected a single flow instance with layer and release marker after handling StopFlow",
        );
        assert!(!instance.is_running());
        assert_eq!(compositing_context.position, Duration::from_millis(450));
        assert_eq!(
            compositing_context.released_at,
            Some(Duration::from_millis(450))
        );
        let (_, transition) = layer
            .absolute
            .values()
            .next()
            .expect("expected one absolute parameter value");
        assert!(transition.as_ref().is_some_and(|transition| {
            transition.release_position == Some(Duration::from_millis(450))
        }));
    }

    /// Verifies unclocked flow release records deterministic zero instead of wall-clock time.
    #[test]
    fn stop_flow_without_clock_uses_zero_release_position() {
        let mut world = World::new();
        world.insert_resource(DataProvider::<FlowDefinition>::default());
        init_flow_command_messages(&mut world);
        world.insert_resource(Messages::<EngineActionEnvelope<FlowPlaybackAction>>::default());
        world.insert_resource(Messages::<EventEnvelope<ClipInstanceAttachment>>::default());

        let registry = FlowNodeRegistry::default();
        let definition = FlowDefinition::new(Identifiers {
            id: 1,
            label: "Flow 1".to_string(),
            ..Default::default()
        });
        let instance = FlowInstance::new(1, FlowRuntime::new(definition), &registry);
        world.insert_resource(registry);

        let parameter =
            unsafe { Instance::<Parameter>::from_entity_unchecked(world.spawn_empty().id()) };
        let mut layer = Layer::new("flow-layer".to_string(), Priority::default());
        layer.absolute.insert(
            parameter,
            (
                ParameterValue::Absolute { value: 255.0 },
                Some(MaterializedTransition {
                    delay_in: Duration::ZERO,
                    fade_in: Duration::from_millis(100),
                    curve_in: FadeCurve::Linear,
                    delay_out: Duration::ZERO,
                    fade_out: Duration::from_millis(100),
                    curve_out: FadeCurve::Linear,
                    start_position: Duration::ZERO,
                    release_position: None,
                }),
            ),
        );

        world.spawn((instance, layer));
        write_flow_command(&mut world, FlowCommand::StopFlow(1));

        let mut schedule = Schedule::default();
        schedule.add_systems(handle_events);
        schedule.run(&mut world);

        let mut query = world.query::<(
            &FlowInstance,
            &Layer,
            &ReleaseMarker,
            &LayerCompositingContext,
        )>();
        let (instance, layer, _release_marker, compositing_context) = query
            .single(&world)
            .expect("expected a single unclocked flow instance with release timing after StopFlow");
        assert!(!instance.is_running());
        assert_eq!(compositing_context.position, Duration::ZERO);
        assert_eq!(compositing_context.released_at, Some(Duration::ZERO));
        let (_, transition) = layer
            .absolute
            .values()
            .next()
            .expect("expected one absolute parameter value");
        assert!(
            transition
                .as_ref()
                .is_some_and(|transition| transition.release_position == Some(Duration::ZERO))
        );
    }

    /// Verifies flow release cleanup includes release delay before removing stale layers.
    #[test]
    fn flow_release_duration_includes_delay_out() {
        let mut world = World::new();
        let parameter =
            unsafe { Instance::<Parameter>::from_entity_unchecked(world.spawn_empty().id()) };
        let mut layer = Layer::new("flow-layer".to_string(), Priority::default());
        layer.absolute.insert(
            parameter,
            (
                ParameterValue::Absolute { value: 255.0 },
                Some(MaterializedTransition {
                    delay_in: Duration::ZERO,
                    fade_in: Duration::ZERO,
                    curve_in: FadeCurve::Linear,
                    delay_out: Duration::from_millis(25),
                    fade_out: Duration::from_millis(75),
                    curve_out: FadeCurve::Linear,
                    start_position: Duration::ZERO,
                    release_position: None,
                }),
            ),
        );

        assert_eq!(
            max_layer_release_duration(&layer),
            Duration::from_millis(100)
        );
    }

    #[test]
    fn cleanup_released_flow_instances_removes_stale_layer_components() {
        let mut world = World::new();

        let registry = FlowNodeRegistry::default();
        let definition = FlowDefinition::new(Identifiers {
            id: 1,
            label: "Flow 1".to_string(),
            ..Default::default()
        });
        let mut instance = FlowInstance::new(1, FlowRuntime::new(definition), &registry);
        instance.stop();

        let parameter =
            unsafe { Instance::<Parameter>::from_entity_unchecked(world.spawn_empty().id()) };
        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_millis(50),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_millis(50),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        let mut layer = Layer::new("flow-layer".to_string(), Priority::default());
        layer.absolute.insert(
            parameter,
            (ParameterValue::Absolute { value: 255.0 }, Some(transition)),
        );

        let mut clock = InstanceClock::default();
        clock.seek_to(Duration::from_millis(100));

        let entity = world
            .spawn((
                instance,
                layer,
                ObjectRefMarker(ObjectRef::ById {
                    object_type: ObjectType::Flow,
                    id: 1,
                }),
                BaseLayer(ComputedLayer::default()),
                OutputLayer(ComputedLayer::default()),
                ReleaseMarker {
                    start_time: Instant::now(),
                },
                clock,
                LayerCompositingContext {
                    position: Duration::ZERO,
                    released_at: Some(Duration::ZERO),
                },
            ))
            .id();

        let mut schedule = Schedule::default();
        schedule.add_systems(cleanup_released_flow_instances);
        schedule.run(&mut world);

        let entity_ref = world
            .get_entity(entity)
            .expect("flow instance should remain after cleanup");
        assert!(entity_ref.get::<Layer>().is_none());
        assert!(entity_ref.get::<ObjectRefMarker>().is_none());
        assert!(entity_ref.get::<BaseLayer>().is_none());
        assert!(entity_ref.get::<OutputLayer>().is_none());
        assert!(entity_ref.get::<ReleaseMarker>().is_none());
        assert!(entity_ref.get::<InstanceClock>().is_none());
        assert!(entity_ref.get::<LayerCompositingContext>().is_none());
        assert!(entity_ref.get::<FlowInstance>().is_some());
    }

    /// Verifies unclocked flow release cleanup does not advance from ReleaseMarker wall time.
    #[test]
    fn cleanup_released_flow_instances_without_clock_uses_zero_release_elapsed() {
        let mut world = World::new();

        let registry = FlowNodeRegistry::default();
        let definition = FlowDefinition::new(Identifiers {
            id: 1,
            label: "Flow 1".to_string(),
            ..Default::default()
        });
        let mut instance = FlowInstance::new(1, FlowRuntime::new(definition), &registry);
        instance.stop();

        let parameter =
            unsafe { Instance::<Parameter>::from_entity_unchecked(world.spawn_empty().id()) };
        let mut layer = Layer::new("flow-layer".to_string(), Priority::default());
        layer.absolute.insert(
            parameter,
            (
                ParameterValue::Absolute { value: 255.0 },
                Some(MaterializedTransition {
                    delay_in: Duration::ZERO,
                    fade_in: Duration::ZERO,
                    curve_in: FadeCurve::Linear,
                    delay_out: Duration::ZERO,
                    fade_out: Duration::from_millis(100),
                    curve_out: FadeCurve::Linear,
                    start_position: Duration::ZERO,
                    release_position: None,
                }),
            ),
        );

        let entity = world
            .spawn((
                instance,
                layer,
                ObjectRefMarker(ObjectRef::ById {
                    object_type: ObjectType::Flow,
                    id: 1,
                }),
                ReleaseMarker {
                    start_time: Instant::now() - Duration::from_secs(10),
                },
            ))
            .id();

        let mut schedule = Schedule::default();
        schedule.add_systems(cleanup_released_flow_instances);
        schedule.run(&mut world);

        let entity_ref = world
            .get_entity(entity)
            .expect("unclocked flow release should not clean up from wall-clock elapsed");
        assert!(entity_ref.get::<Layer>().is_some());
        assert!(entity_ref.get::<ReleaseMarker>().is_some());
    }

    #[test]
    fn cleanup_released_flow_instances_runs_after_release_is_composited() {
        let mut app = App::new();
        app.insert_resource(FixtureDataProviderExt::default());
        app.init_resource::<FinalLayerAttributedAssertions>();
        app.configure_sets(
            Update,
            (
                LayerGeneration,
                Compositing.after(LayerGeneration),
                VdimProcessing.after(Compositing),
            ),
        );
        app.add_systems(
            Update,
            (
                compositor::<Parameter>.in_set(Compositing),
                cleanup_released_flow_instances.in_set(VdimProcessing),
            ),
        );

        let registry = FlowNodeRegistry::default();
        let definition = FlowDefinition::new(Identifiers {
            id: 1,
            label: "Flow 1".to_string(),
            ..Default::default()
        });
        let mut instance = FlowInstance::new(1, FlowRuntime::new(definition), &registry);
        instance.stop();

        let metadata = ParameterMetadata::default();
        let parameter_entity = app
            .world_mut()
            .spawn(Parameter {
                metadata: metadata.clone(),
                values: ParameterValues {
                    current_value: 120.0,
                    ..Default::default()
                },
            })
            .id();
        let parameter = unsafe { Instance::<Parameter>::from_entity_unchecked(parameter_entity) };
        let fixture = Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "test fixture".to_string(),
            },
            make: "test".to_string(),
            model: "test".to_string(),
            elements: vec![FixtureElement {
                label: "test fixture".to_string(),
                parameters: vec![metadata],
            }],
            ..Default::default()
        };
        {
            let mut data_provider = app
                .world_mut()
                .get_resource_mut::<FixtureDataProviderExt>()
                .unwrap();
            let _ = data_provider.inner.add(fixture.clone());
            data_provider.add_parameter(
                FixtureRef {
                    fixture_uid: fixture.identifiers.uid,
                    index: Some(1),
                },
                Attribute::Intensity,
                parameter,
            );
        }

        let mut layer = Layer::new("flow-layer".to_string(), Priority::default());
        layer
            .absolute
            .insert(parameter, (ParameterValue::Absolute { value: 120.0 }, None));

        let flow_entity = app
            .world_mut()
            .spawn((
                instance,
                layer,
                ObjectRefMarker(ObjectRef::ById {
                    object_type: ObjectType::Flow,
                    id: 1,
                }),
                ReleaseMarker::default(),
            ))
            .id();

        app.update();

        let parameter = app.world().get::<Parameter>(parameter_entity).unwrap();
        assert_eq!(
            parameter.values.current_value, parameter.values.default_value,
            "release must be composited once before cleanup removes the flow layer"
        );

        let flow_entity = app
            .world()
            .get_entity(flow_entity)
            .expect("flow entity should remain after layer cleanup");
        assert!(flow_entity.get::<Layer>().is_none());
        assert!(flow_entity.get::<ReleaseMarker>().is_none());
    }

    #[test]
    fn start_clip_for_flow_spawns_materialized_clip_and_playback() {
        let mut world = World::new();
        world.insert_resource(DataProvider::<FlowDefinition>::default());
        init_flow_command_messages(&mut world);
        world.insert_resource(Messages::<EngineActionEnvelope<FlowPlaybackAction>>::default());
        world.insert_resource(Messages::<EventEnvelope<ClipInstanceAttachment>>::default());

        let registry = FlowNodeRegistry::default();
        world.insert_resource(registry);

        let flow = FlowDefinition::new(Identifiers {
            id: 7,
            label: "Clip Flow".to_string(),
            uid: Uuid::new_v4(),
        });
        let flow_uid = flow.identifiers.uid;
        world
            .resource_mut::<DataProvider<FlowDefinition>>()
            .add(flow)
            .expect("store flow definition");

        let clip_uid = Uuid::new_v4();
        world
            .resource_mut::<Messages<EngineActionEnvelope<FlowPlaybackAction>>>()
            .write(EngineActionEnvelope::detached(FlowPlaybackAction::Start {
                flow_uid,
                context: test_start_context(12, clip_uid, None, true),
            }));

        let mut schedule = Schedule::default();
        schedule.add_systems(handle_events);
        schedule.run(&mut world);

        let mut instance_query =
            world.query::<(&FlowInstance, &InstanceMetadata, &InstanceControls)>();
        let (instance, metadata, _controls) = instance_query
            .single(&world)
            .expect("expected one clip-started flow instance");
        assert!(instance.is_running());
        assert_eq!(metadata.kind, InstanceKind::Flow);
        assert_eq!(metadata.display_kind, InstanceDisplayKind::FlowFx);
        assert_eq!(metadata.name.as_deref(), Some("Clip Flow"));

        let attachment = world
            .resource_mut::<Messages<EventEnvelope<ClipInstanceAttachment>>>()
            .drain()
            .next()
            .expect("expected one clip playback attachment");
        assert_eq!(attachment.event.clip_id, 12);
    }

    /// Verifies timeline reconstruction starts flow playback with a source-local clock.
    #[test]
    fn timed_start_clip_for_flow_seeds_instance_clock() {
        let mut world = World::new();
        world.insert_resource(DataProvider::<FlowDefinition>::default());
        init_flow_command_messages(&mut world);
        world.insert_resource(Messages::<EngineActionEnvelope<FlowPlaybackAction>>::default());
        world.insert_resource(Messages::<EventEnvelope<ClipInstanceAttachment>>::default());

        let registry = FlowNodeRegistry::default();
        world.insert_resource(registry);

        let flow = FlowDefinition::new(Identifiers {
            id: 21,
            label: "Timed Clip Flow".to_string(),
            uid: Uuid::new_v4(),
        });
        let flow_uid = flow.identifiers.uid;
        world
            .resource_mut::<DataProvider<FlowDefinition>>()
            .add(flow)
            .expect("store flow definition");

        let clip_uid = Uuid::new_v4();
        let timeline_uid = Uuid::from_u128(0x2200);

        world
            .resource_mut::<Messages<EngineActionEnvelope<FlowPlaybackAction>>>()
            .write(EngineActionEnvelope::detached(FlowPlaybackAction::Start {
                flow_uid,
                context: test_start_context(
                    22,
                    clip_uid,
                    Some(PlaybackReconstructionTiming::timeline(
                        Duration::from_secs(10),
                        Duration::from_millis(11_250),
                        timeline_uid,
                        Duration::from_secs(4),
                    )),
                    true,
                ),
            }));

        let mut schedule = Schedule::default();
        schedule.add_systems(handle_events);
        schedule.run(&mut world);

        let mut clock_query = world.query::<&InstanceClock>();
        let clock = clock_query
            .single(&world)
            .expect("timed flow start should attach a playback clock");
        assert_eq!(
            clock.source,
            InstanceClockSource::Timeline {
                timeline_uid,
                started_at_timeline: Duration::from_secs(4)
            }
        );
        assert_eq!(clock.position, Duration::from_millis(1_250));
        assert_eq!(clock.delta, Duration::ZERO);
    }

    /// Verifies timeline reconstruction stops flow playback with source-local release anchors.
    #[test]
    fn timed_stop_clip_for_flow_seeds_release_clock() {
        let mut world = World::new();
        world.insert_resource(DataProvider::<FlowDefinition>::default());
        init_flow_command_messages(&mut world);
        world.insert_resource(Messages::<EngineActionEnvelope<FlowPlaybackAction>>::default());
        world.insert_resource(Messages::<EventEnvelope<ClipInstanceAttachment>>::default());

        let registry = FlowNodeRegistry::default();
        let flow = FlowDefinition::new(Identifiers {
            id: 31,
            label: "Timed Stop Flow".to_string(),
            uid: Uuid::new_v4(),
        });
        let instance = FlowInstance::new(
            flow.identifiers.id,
            FlowRuntime::new(flow.clone()),
            &registry,
        );
        world.insert_resource(registry);
        world
            .resource_mut::<DataProvider<FlowDefinition>>()
            .add(flow)
            .expect("store flow definition");

        let parameter =
            unsafe { Instance::<Parameter>::from_entity_unchecked(world.spawn_empty().id()) };
        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_millis(100),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_millis(100),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };
        let mut layer = Layer::new("flow-layer".to_string(), Priority::default());
        layer.absolute.insert(
            parameter,
            (ParameterValue::Absolute { value: 255.0 }, Some(transition)),
        );

        let mut stale_clock = InstanceClock {
            source: InstanceClockSource::ExternalPosition,
            ..Default::default()
        };
        stale_clock.seek_to(Duration::from_millis(9_000));

        let instance_id = InstanceId::new();
        world.spawn((instance, layer, stale_clock, instance_id));

        let timeline_uid = Uuid::from_u128(0x3200);
        world
            .resource_mut::<Messages<EngineActionEnvelope<FlowPlaybackAction>>>()
            .write(EngineActionEnvelope::detached(FlowPlaybackAction::Stop {
                clip_id: 32,
                attached_instances: vec![instance_id],
                timing: PlaybackReconstructionTiming::timeline_source_local(
                    Duration::from_millis(700),
                    Duration::from_millis(1_200),
                    timeline_uid,
                    Duration::from_millis(300),
                )
                .into(),
            }));

        let mut schedule = Schedule::default();
        schedule.add_systems(handle_events);
        schedule.run(&mut world);

        let mut query = world.query::<(
            &FlowInstance,
            &Layer,
            &ReleaseMarker,
            &LayerCompositingContext,
            &InstanceClock,
        )>();
        let (instance, layer, _release_marker, compositing_context, clock) = query
            .single(&world)
            .expect("expected stopped flow with release timing components");

        assert!(!instance.is_running());
        assert_eq!(compositing_context.position, Duration::from_millis(1_200));
        assert_eq!(
            compositing_context.released_at,
            Some(Duration::from_millis(700))
        );
        assert_eq!(
            clock.source,
            InstanceClockSource::Timeline {
                timeline_uid,
                started_at_timeline: Duration::from_millis(300)
            }
        );
        assert_eq!(clock.position, Duration::from_millis(1_200));
        assert_eq!(clock.delta, Duration::ZERO);

        let (_, transition) = layer
            .absolute
            .values()
            .next()
            .expect("expected one absolute parameter value");
        assert!(transition.as_ref().is_some_and(|transition| {
            transition.release_position == Some(Duration::from_millis(700))
        }));
    }

    #[test]
    fn start_flow_command_spawns_playback_without_clip() {
        let mut world = World::new();
        world.insert_resource(DataProvider::<FlowDefinition>::default());
        init_flow_command_messages(&mut world);
        world.insert_resource(Messages::<EngineActionEnvelope<FlowPlaybackAction>>::default());
        world.insert_resource(Messages::<EventEnvelope<ClipInstanceAttachment>>::default());

        let registry = FlowNodeRegistry::default();
        world.insert_resource(registry);

        let flow = FlowDefinition::new(Identifiers {
            id: 8,
            label: "Direct Flow".to_string(),
            uid: Uuid::new_v4(),
        });
        world
            .resource_mut::<DataProvider<FlowDefinition>>()
            .add(flow)
            .expect("store flow definition");

        write_flow_command(&mut world, FlowCommand::StartFlow(8));

        let mut schedule = Schedule::default();
        schedule.add_systems(handle_events);
        schedule.run(&mut world);

        let mut instance_query = world.query::<(
            &FlowInstance,
            &InstanceId,
            &InstanceMetadata,
            &InstanceControls,
            &InstanceStatus,
        )>();
        let (instance, _instance_id, metadata, _controls, _status) = instance_query
            .single(&world)
            .expect("expected one direct-started flow instance");
        assert!(instance.is_running());
        assert_eq!(metadata.kind, InstanceKind::Flow);
        assert_eq!(metadata.display_kind, InstanceDisplayKind::FlowFx);
        assert_eq!(metadata.name.as_deref(), Some("Direct Flow"));

        let mexec_count = world.query::<&MaterializedClip>().iter(&world).count();
        assert_eq!(
            mexec_count, 0,
            "direct flow start should not create a clip binding"
        );
    }

    #[test]
    fn start_flow_command_preserves_controls_on_running_playback() {
        let mut world = World::new();
        world.insert_resource(DataProvider::<FlowDefinition>::default());
        init_flow_command_messages(&mut world);
        world.insert_resource(Messages::<EngineActionEnvelope<FlowPlaybackAction>>::default());
        world.insert_resource(Messages::<EventEnvelope<ClipInstanceAttachment>>::default());

        let registry = FlowNodeRegistry::default();
        world.insert_resource(registry);

        let flow = FlowDefinition::new(Identifiers {
            id: 11,
            label: "Direct Flow".to_string(),
            uid: Uuid::new_v4(),
        });
        world
            .resource_mut::<DataProvider<FlowDefinition>>()
            .add(flow)
            .expect("store flow definition");

        let mut schedule = Schedule::default();
        schedule.add_systems(handle_events);

        write_flow_command(&mut world, FlowCommand::StartFlow(11));
        schedule.run(&mut world);

        {
            let mut controls_query = world.query::<&mut InstanceControls>();
            let mut controls = controls_query
                .single_mut(&mut world)
                .expect("expected controls on started flow");
            controls.intensity_scale = 0.25;
            controls.rate = 0.5;
        }

        write_flow_command(&mut world, FlowCommand::StartFlow(11));
        schedule.run(&mut world);

        let mut controls_query = world.query::<&InstanceControls>();
        let controls = controls_query
            .single(&world)
            .expect("expected controls on restarted flow");
        assert_eq!(controls.intensity_scale, 0.25);
        assert_eq!(controls.rate, 0.5);
    }

    #[test]
    fn stop_all_instances_stops_direct_flow_and_removes_playback_components() {
        let mut world = World::new();
        world.insert_resource(DataProvider::<FlowDefinition>::default());
        init_flow_command_messages(&mut world);
        world.insert_resource(Messages::<EngineActionEnvelope<PlaybackReleaseAction>>::default());

        let registry = FlowNodeRegistry::default();
        world.insert_resource(registry);

        let flow = FlowDefinition::new(Identifiers {
            id: 10,
            label: "Direct Flow".to_string(),
            uid: Uuid::new_v4(),
        });
        world
            .resource_mut::<DataProvider<FlowDefinition>>()
            .add(flow)
            .expect("store flow definition");

        let mut schedule = Schedule::default();
        schedule.add_systems((handle_events, handle_playback_commands).chain());

        write_flow_command(&mut world, FlowCommand::StartFlow(10));
        schedule.run(&mut world);

        let mut started_query = world.query::<(&FlowInstance, &InstanceId)>();
        let (instance, _instance_id) = started_query
            .single(&world)
            .expect("expected one direct-started flow instance");
        assert!(instance.is_running());

        world
            .resource_mut::<Messages<EngineActionEnvelope<PlaybackReleaseAction>>>()
            .write(EngineActionEnvelope::detached(PlaybackReleaseAction::All));
        schedule.run(&mut world);

        let mut stopped_query = world.query::<(
            &FlowInstance,
            Option<&InstanceId>,
            Option<&InstanceMetadata>,
            Option<&InstanceControls>,
            &ReleaseMarker,
        )>();
        let (instance, instance_id, metadata, controls, _release_marker) = stopped_query
            .single(&world)
            .expect("expected one stopped flow instance");
        assert!(!instance.is_running());
        assert!(instance_id.is_none());
        assert!(metadata.is_none());
        assert!(controls.is_none());
    }

    #[test]
    fn stop_clip_for_flow_removes_playback_binding_and_keeps_release_clock() {
        let mut world = World::new();
        world.insert_resource(DataProvider::<FlowDefinition>::default());
        init_flow_command_messages(&mut world);
        world.insert_resource(Messages::<EngineActionEnvelope<FlowPlaybackAction>>::default());
        world.insert_resource(Messages::<EventEnvelope<ClipInstanceAttachment>>::default());

        let registry = FlowNodeRegistry::default();
        world.insert_resource(registry);

        let flow = FlowDefinition::new(Identifiers {
            id: 9,
            label: "Clip Flow".to_string(),
            uid: Uuid::new_v4(),
        });
        let flow_uid = flow.identifiers.uid;
        world
            .resource_mut::<DataProvider<FlowDefinition>>()
            .add(flow)
            .expect("store flow definition");

        let clip_uid = Uuid::new_v4();

        let mut schedule = Schedule::default();
        schedule.add_systems(handle_events);

        world
            .resource_mut::<Messages<EngineActionEnvelope<FlowPlaybackAction>>>()
            .write(EngineActionEnvelope::detached(FlowPlaybackAction::Start {
                flow_uid,
                context: test_start_context(14, clip_uid, None, true),
            }));
        schedule.run(&mut world);
        let instance_id = world
            .resource_mut::<Messages<EventEnvelope<ClipInstanceAttachment>>>()
            .drain()
            .next()
            .expect("expected flow attachment")
            .event
            .instance_id;

        world
            .resource_mut::<Messages<EngineActionEnvelope<FlowPlaybackAction>>>()
            .write(EngineActionEnvelope::detached(FlowPlaybackAction::Stop {
                clip_id: 14,
                attached_instances: vec![instance_id],
                timing: None,
            }));
        schedule.run(&mut world);

        let mut instance_query = world.query::<(
            &FlowInstance,
            Option<&InstanceId>,
            Option<&InstanceMetadata>,
            Option<&InstanceControls>,
            Option<&InstanceClock>,
            &ReleaseMarker,
        )>();
        let (instance, instance_id, metadata, controls, clock, _release_marker) = instance_query
            .single(&world)
            .expect("expected one stopped flow instance");
        assert!(!instance.is_running());
        assert!(instance_id.is_none());
        assert!(metadata.is_none());
        assert!(controls.is_none());
        assert!(
            clock.is_some(),
            "stopped flow keeps its playback clock while release transitions complete"
        );

        assert!(
            world
                .resource_mut::<Messages<EventEnvelope<ClipInstanceAttachment>>>()
                .is_empty(),
            "stopping flow should not emit a new attachment"
        );
    }
}
