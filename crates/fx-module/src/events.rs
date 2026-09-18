// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use bevy_ecs::{prelude::*, system::SystemParam};
use nightfall::prelude::{ObjectRef, ObjectType, SpatialSelection};
use nightfall_compositor::prelude::{ObjectRefMarker, ReleaseMarker};
use nightfall_engine::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_fx::prelude::{Fx, FxCommand, StepFx};
use nightfall_instances::{
    ClipInstanceStartContext, DomainInstanceReconstructionRequest, InstanceClock,
    instance_clock_from_reconstruction_timing,
};
use nightfall_playback_planner::{PlannedPlaybackSource, PlaybackReconstructionTiming};
use nightfall_undo::prelude::{UndoEntry, UndoManager, UndoableOperation};
use uuid::Uuid;

use crate::{
    ActiveFxModuleIds, ActiveFxModuleTimings, ForwardedFxModuleCommands, FxModuleClipBinding,
    FxModuleClipBindings, FxModuleCommand, FxModuleControlAction, FxModulePreviewUpdate,
    StoredFxModule, instances::FxModuleRuntimeStates, list_available_fx_modules,
    websocket::send_available_fx_modules,
};

/// Marker component for active fx module preview entities.
#[derive(Component)]
pub struct PreviewFxModule(pub StoredFxModule);

/// Builds the fx-module runtime clock represented by raw reconstruction timing.
fn fx_module_clock_from_reconstruction_timing(
    timing: PlaybackReconstructionTiming,
) -> InstanceClock {
    instance_clock_from_reconstruction_timing(PlaybackReconstructionTiming {
        started_at: Duration::ZERO,
        position: timing.elapsed(),
        source: timing.source,
    })
}

/// Clip-routed playback actions owned by the fx-module domain.
#[derive(Debug, Clone, EnginePayload)]
pub enum FxModulePlaybackAction {
    /// Start or refresh a stored fx module playback for an clip.
    Start {
        /// Stored fx module source UID to activate.
        fx_module_uid: Uuid,
        /// Shared clip metadata for the routed start.
        context: ClipInstanceStartContext,
    },
    /// Stop a stored fx module playback for an clip.
    Stop {
        /// Numeric clip ID whose playback slot requested the action.
        clip_id: u32,
        /// Stored fx module source UID to deactivate.
        fx_module_uid: Uuid,
    },
}

impl EngineAction for FxModulePlaybackAction {}

/// Stored definitions and runtime indexes mutated by FX module management commands.
#[derive(SystemParam)]
pub struct FxModuleManagement<'w, 's> {
    modules: ResMut<'w, DataProvider<StoredFxModule>>,
    regular_fx: Res<'w, DataProvider<Fx>>,
    step_fx: Query<'w, 's, &'static StepFx>,
    selection_resolver: SpatialSelectionResolver<'w>,
    active_ids: ResMut<'w, ActiveFxModuleIds>,
    active_timings: Option<ResMut<'w, ActiveFxModuleTimings>>,
    clip_bindings: ResMut<'w, FxModuleClipBindings>,
    forwarded_commands: ResMut<'w, ForwardedFxModuleCommands>,
    undo_manager: ResMut<'w, UndoManager>,
    runtime_states: NonSendMut<'w, FxModuleRuntimeStates>,
}

/// Route generic FX move and remove commands to stored module FX when no regular FX matches.
pub(crate) fn forward_generic_fx_management_commands(
    regular_fx_provider: Res<DataProvider<Fx>>,
    mut forwarded_commands: ResMut<ForwardedFxModuleCommands>,
    mut events: MessageReader<CommandEnvelope<FxCommand>>,
    mut module_commands: MessageWriter<CommandEnvelope<FxModuleCommand>>,
) {
    for event in events.read() {
        let command = match &event.command {
            FxCommand::RenameFx { id, new_id } if regular_fx_provider.from_id(*id).is_err() => {
                Some(FxModuleCommand::MoveFxModule {
                    id: *id,
                    new_id: *new_id,
                })
            }
            FxCommand::DeleteFx(id) if regular_fx_provider.from_id(*id).is_err() => {
                Some(FxModuleCommand::DeleteFxModule(*id))
            }
            FxCommand::StoreFx(_) | FxCommand::RenameFx { .. } | FxCommand::DeleteFx(_) => None,
        };

        if let Some(command) = command {
            forwarded_commands.0.insert(event.command_id);
            module_commands.write(CommandEnvelope::with_context(
                event.command_id,
                event.undo_id,
                event.origin.clone(),
                event.reply_target.clone(),
                command,
            ));
        }
    }
}

/// Adds an undo entry for a successfully forwarded generic FX command.
fn push_forwarded_undo(
    management: &mut FxModuleManagement,
    event: &CommandEnvelope<FxModuleCommand>,
    command: FxModuleCommand,
    description: String,
) {
    management.undo_manager.push(
        UndoEntry {
            command: Box::new(command) as Box<dyn UndoableOperation>,
            description,
            command_id: Some(event.command_id),
        },
        event.undo_id,
        true,
    );
}

/// Publishes a structured failure for one FX module command.
fn fail_fx_module_command(
    responder: &mut CommandResponder,
    command_id: CommandId,
    code: &'static str,
    message: String,
) {
    if let Err(error) = responder.fail(command_id, CommandError::new(code, message)) {
        tracing::error!(%command_id, %error, "fx_module_command_completion_failed");
    }
}

/// Rewrites dynamic group references in a stored FX module selection to stable UID references.
fn stabilized_fx_module_selection(
    selection: &SpatialSelection,
    selection_resolver: &SpatialSelectionResolver,
) -> SpatialSelection {
    let stabilized = selection_resolver.stabilize_group_refs_selection(selection);
    for warning in &stabilized.issues {
        tracing::warn!("{}", warning);
    }
    stabilized.value
}

/// Handle stored fx module CRUD and playback control commands.
pub fn handle_events(
    mut management: FxModuleManagement,
    mut events: MessageReader<CommandEnvelope<FxModuleCommand>>,
    mut responder: CommandResponder,
    broadcaster: Res<ClientEventSink>,
) {
    for event in events.read() {
        match &event.command {
            FxModuleCommand::StoreFxModule(request) => {
                let existing = management
                    .modules
                    .from_id(request.identifiers.id)
                    .ok()
                    .map(|fx_module| fx_module.clone());

                if existing.is_none() && request.selection.is_none() {
                    fail_fx_module_command(
                        &mut responder,
                        event.command_id,
                        "fx_module.selection_required",
                        "fx module selection is required when creating a new fx module".to_string(),
                    );
                    continue;
                }

                let mut stored = existing.unwrap_or_else(|| StoredFxModule {
                    identifiers: request.identifiers.clone(),
                    module_name: request.module_name.clone(),
                    selection: request
                        .selection
                        .clone()
                        .unwrap_or_else(SpatialSelection::default),
                    config: Default::default(),
                });

                stored.identifiers.id = request.identifiers.id;
                stored.identifiers.label = request.identifiers.label.clone();
                stored.module_name = request.module_name.clone();

                if let Some(selection) = &request.selection {
                    stored.selection =
                        stabilized_fx_module_selection(selection, &management.selection_resolver);
                }

                if request.merge {
                    stored.config.extend(request.config.clone());
                } else {
                    stored.config = request.config.clone();
                }

                if let Err(error) = management.modules.add(stored) {
                    fail_fx_module_command(
                        &mut responder,
                        event.command_id,
                        "fx_module.store_failed",
                        format!(
                            "failed to store fx module {}: {}",
                            request.identifiers.id, error
                        ),
                    );
                    continue;
                }
            }
            FxModuleCommand::RestoreDeletedFxModule(definition) => {
                let id_in_use = management
                    .modules
                    .from_id(definition.identifiers.id)
                    .is_ok();
                let uid_in_use = management.modules.get(definition.identifiers.uid).is_ok();
                if id_in_use || uid_in_use {
                    fail_fx_module_command(
                        &mut responder,
                        event.command_id,
                        "fx_module.restore_conflict",
                        format!(
                            "failed to restore deleted fx module {}: ID or UUID is already in use",
                            definition.identifiers.id
                        ),
                    );
                    continue;
                }

                if let Err(error) = management.modules.add(definition.clone()) {
                    fail_fx_module_command(
                        &mut responder,
                        event.command_id,
                        "fx_module.restore_failed",
                        format!(
                            "failed to restore deleted fx module {}: {}",
                            definition.identifiers.id, error
                        ),
                    );
                    continue;
                }
            }
            FxModuleCommand::MoveFxModule { id, new_id } => {
                let capture_undo = management.forwarded_commands.0.remove(&event.command_id);
                let destination_exists = management.modules.from_id(*new_id).is_ok()
                    || management.regular_fx.from_id(*new_id).is_ok()
                    || management
                        .step_fx
                        .iter()
                        .any(|step_fx| step_fx.identifiers.id == *new_id);
                if destination_exists {
                    fail_fx_module_command(
                        &mut responder,
                        event.command_id,
                        "fx_module.destination_exists",
                        format!(
                            "failed to move fx module {} to {}: destination already exists",
                            id, new_id
                        ),
                    );
                    continue;
                }

                let Ok(mut definition) = management
                    .modules
                    .from_id(*id)
                    .map(|definition| definition.clone())
                else {
                    fail_fx_module_command(
                        &mut responder,
                        event.command_id,
                        "fx_module.not_found",
                        format!(
                            "failed to move fx module {} to {}: source does not exist",
                            id, new_id
                        ),
                    );
                    continue;
                };

                definition.identifiers.id = *new_id;
                if let Err(error) = management.modules.add(definition) {
                    fail_fx_module_command(
                        &mut responder,
                        event.command_id,
                        "fx_module.move_failed",
                        format!("failed to move fx module {} to {}: {}", id, new_id, error),
                    );
                    continue;
                }

                if management.active_ids.0.remove(id) {
                    management.active_ids.0.insert(*new_id);
                }
                if let Some(timings) = management.active_timings.as_deref_mut()
                    && let Some(clock) = timings.0.remove(id)
                {
                    timings.0.insert(*new_id, clock);
                }
                for binding in management.clip_bindings.0.values_mut() {
                    if binding.fx_module_id == *id {
                        binding.fx_module_id = *new_id;
                    }
                }
                management.runtime_states.move_id(*id, *new_id);
                if capture_undo {
                    push_forwarded_undo(
                        &mut management,
                        event,
                        FxModuleCommand::MoveFxModule {
                            id: *new_id,
                            new_id: *id,
                        },
                        format!("Move Fx Module {} → {}", id, new_id),
                    );
                }
            }
            FxModuleCommand::DeleteFxModule(id) => {
                let capture_undo = management.forwarded_commands.0.remove(&event.command_id);
                let Ok(definition) = management
                    .modules
                    .from_id(*id)
                    .map(|definition| definition.clone())
                else {
                    fail_fx_module_command(
                        &mut responder,
                        event.command_id,
                        "fx_module.not_found",
                        format!("failed to delete fx module {}: source does not exist", id),
                    );
                    continue;
                };

                if let Err(error) = management.modules.remove(&definition.identifiers.uid) {
                    fail_fx_module_command(
                        &mut responder,
                        event.command_id,
                        "fx_module.delete_failed",
                        format!("failed to delete fx module {}: {}", id, error),
                    );
                    continue;
                }

                management.active_ids.0.remove(id);
                if let Some(timings) = management.active_timings.as_deref_mut() {
                    timings.0.remove(id);
                }
                management
                    .clip_bindings
                    .0
                    .retain(|_, binding| binding.fx_module_id != *id);
                if capture_undo {
                    push_forwarded_undo(
                        &mut management,
                        event,
                        FxModuleCommand::RestoreDeletedFxModule(definition),
                        format!("Delete Fx Module {}", id),
                    );
                }
            }
            FxModuleCommand::ControlFxModule(action) => {
                let (fx_id, start) = match action {
                    FxModuleControlAction::Start(fx_id) => (*fx_id, true),
                    FxModuleControlAction::Stop(fx_id) => (*fx_id, false),
                };

                if management.modules.from_id(fx_id).is_err() {
                    fail_fx_module_command(
                        &mut responder,
                        event.command_id,
                        "fx_module.not_found",
                        format!("fx module {} does not exist", fx_id),
                    );
                    continue;
                }

                if start {
                    management.active_ids.0.insert(fx_id);
                    if let Some(timings) = management.active_timings.as_deref_mut() {
                        timings.0.remove(&fx_id);
                    }
                } else {
                    management.active_ids.0.remove(&fx_id);
                    if let Some(timings) = management.active_timings.as_deref_mut() {
                        timings.0.remove(&fx_id);
                    }
                }
            }
            FxModuleCommand::ListAvailableFxModules => match list_available_fx_modules() {
                Ok(response) => {
                    send_available_fx_modules(&response, &broadcaster);
                    if let Err(error) = responder.succeed_with_output(event.command_id, response) {
                        tracing::error!(
                            command_id = %event.command_id,
                            %error,
                            "fx_module_command_completion_failed"
                        );
                    }
                    continue;
                }
                Err(error) => {
                    fail_fx_module_command(
                        &mut responder,
                        event.command_id,
                        "fx_module.list_failed",
                        error,
                    );
                    continue;
                }
            },
        }

        if let Err(error) = responder.succeed(event.command_id) {
            tracing::error!(
                command_id = %event.command_id,
                %error,
                "fx_module_command_completion_failed"
            );
        }
    }
}

/// Reconciles timeline-requested FX module playback through FX Module-owned state.
pub fn handle_domain_playback_reconstruction_requests(
    mut events: MessageReader<DomainInstanceReconstructionRequest>,
    fx_module_data_provider: Res<DataProvider<StoredFxModule>>,
    mut active_fx_module_ids: ResMut<ActiveFxModuleIds>,
    mut active_fx_module_timings: Option<ResMut<ActiveFxModuleTimings>>,
) {
    for event in events.read() {
        let PlannedPlaybackSource::FxModule(fx_module_uid) = event.source else {
            continue;
        };
        let Ok(definition) = fx_module_data_provider.get(fx_module_uid) else {
            tracing::warn!(
                fx_module_uid = %fx_module_uid,
                clip_uid = %event.clip_uid,
                "Skipping FX module reconstruction for missing source"
            );
            continue;
        };
        active_fx_module_ids.0.insert(definition.identifiers.id);
        if let Some(timings) = active_fx_module_timings.as_deref_mut() {
            timings
                .0
                .insert(definition.identifiers.id, event.clock.clone());
        }
    }
}

/// Handle clip commands that target stored fx modules.
pub fn handle_clip_commands(
    fx_module_data_provider: Res<DataProvider<StoredFxModule>>,
    mut active_fx_module_ids: ResMut<ActiveFxModuleIds>,
    mut active_fx_module_timings: Option<ResMut<ActiveFxModuleTimings>>,
    mut clip_bindings: ResMut<FxModuleClipBindings>,
    mut events: MessageReader<EngineActionEnvelope<FxModulePlaybackAction>>,
) {
    for event in events.read() {
        match &event.action {
            FxModulePlaybackAction::Start {
                fx_module_uid,
                context,
            } => {
                let context = *context;
                let Ok(definition) = fx_module_data_provider.get(*fx_module_uid) else {
                    tracing::warn!(
                        clip_id = context.clip_id,
                        fx_module_uid = %fx_module_uid,
                        "Failed to start clip: fx module source not found"
                    );
                    continue;
                };

                active_fx_module_ids.0.insert(definition.identifiers.id);
                clip_bindings.0.insert(
                    context.clip_id,
                    FxModuleClipBinding {
                        fx_module_id: definition.identifiers.id,
                        start_context: context,
                    },
                );
                if let Some(timings) = active_fx_module_timings.as_deref_mut() {
                    if let Some(timing) = context.timing {
                        timings.0.insert(
                            definition.identifiers.id,
                            fx_module_clock_from_reconstruction_timing(timing),
                        );
                    } else {
                        timings.0.remove(&definition.identifiers.id);
                    }
                }
            }
            FxModulePlaybackAction::Stop {
                clip_id,
                fx_module_uid,
            } => {
                clip_bindings.0.remove(clip_id);
                match fx_module_data_provider.get(*fx_module_uid) {
                    Ok(definition) => {
                        active_fx_module_ids.0.remove(&definition.identifiers.id);
                        if let Some(timings) = active_fx_module_timings.as_deref_mut() {
                            timings.0.remove(&definition.identifiers.id);
                        }
                    }
                    Err(_) => {
                        tracing::warn!(
                            clip_id,
                            fx_module_uid = %fx_module_uid,
                            "Failed to stop clip: fx module source not found"
                        );
                    }
                }
            }
        }
    }
}

/// Applies isolated FX module preview updates.
pub fn handle_preview_commands(
    mut commands: Commands,
    mut events: MessageReader<FxModulePreviewUpdate>,
    preview_query: Query<Entity, With<PreviewFxModule>>,
) {
    for event in events.read() {
        match event {
            FxModulePreviewUpdate::StartPreview(definition)
            | FxModulePreviewUpdate::UpdatePreview(definition) => {
                for entity in preview_query.iter() {
                    commands
                        .entity(entity)
                        .remove::<PreviewFxModule>()
                        .insert(ReleaseMarker::default());
                }

                let marker = ObjectRefMarker(ObjectRef::ByUid {
                    object_type: ObjectType::FxModule,
                    uid: definition.identifiers.uid,
                });
                commands.spawn((
                    PreviewFxModule(definition.clone()),
                    crate::instances::ActiveFxModuleLayer {
                        fx_module_uid: definition.identifiers.uid,
                    },
                    InstanceClock::default(),
                    marker,
                ));
            }
            FxModulePreviewUpdate::StopPreview => {
                for entity in preview_query.iter() {
                    commands
                        .entity(entity)
                        .remove::<PreviewFxModule>()
                        .insert(ReleaseMarker::default());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use nightfall::prelude::{Group, GroupRefExpr, Identifiers, SelectionExpr};
    use nightfall_fixtures::prelude::FixtureDataProviderExt;
    use nightfall_fx::prelude::FxCommand;
    use uuid::Uuid;

    use super::*;

    /// Build clip start context for fx module clip command tests.
    fn test_start_context(clip_id: u32, auto_release_on_stop: bool) -> ClipInstanceStartContext {
        ClipInstanceStartContext {
            clip_id,
            clip_uid: Uuid::from_u128(0x200),
            priority: Default::default(),
            timing: None,
            instance_options: None,
            attached_instance: None,
            auto_release_on_stop,
        }
    }

    /// Build a stored fx module for clip command tests.
    fn test_module(module_uid: Uuid) -> StoredFxModule {
        StoredFxModule {
            identifiers: Identifiers {
                id: 6,
                label: "Hook Riser".to_owned(),
                uid: module_uid,
            },
            module_name: "hook-riser".to_owned(),
            selection: SpatialSelection::default(),
            config: Default::default(),
        }
    }

    /// Registers and wraps a semantic command for focused management handler tests.
    fn tracked_command<C>(app: &mut App, command: C) -> CommandEnvelope<C> {
        let envelope = CommandEnvelope::new(command, CommandOrigin::Cli, ReplyTarget::Detached);
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("test command should register");
        envelope
    }

    /// Set up an app with the fx module clip command handler.
    fn setup_app(module_uid: Uuid) -> App {
        let mut app = App::new();
        app.insert_resource(DataProvider::<StoredFxModule>::default());
        app.insert_resource(ActiveFxModuleIds::default());
        app.insert_resource(FxModuleClipBindings::default());
        app.add_message::<EngineActionEnvelope<FxModulePlaybackAction>>();
        app.add_systems(Update, handle_clip_commands);
        app.world_mut()
            .resource_mut::<DataProvider<StoredFxModule>>()
            .add(test_module(module_uid))
            .expect("test module should insert cleanly");
        app
    }

    /// Set up generic FX command routing for stored module mutation tests.
    fn setup_management_app(module_uid: Uuid) -> App {
        let (tx, _rx) = async_channel::unbounded::<Vec<u8>>();
        let mut app = App::new();
        app.insert_resource(DataProvider::<Fx>::default());
        app.insert_resource(DataProvider::<StoredFxModule>::default());
        app.insert_resource(DataProvider::<Group>::default());
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(ActiveFxModuleIds::default());
        app.insert_resource(ActiveFxModuleTimings::default());
        app.insert_resource(FxModuleClipBindings::default());
        app.insert_resource(ForwardedFxModuleCommands::default());
        app.insert_resource(UndoManager::default());
        app.insert_resource(CommandTracker::default());
        app.insert_resource(ClientEventSink::new(tx));
        app.insert_non_send(FxModuleRuntimeStates::default());
        app.add_message::<CommandEnvelope<FxCommand>>();
        app.add_message::<CommandEnvelope<FxModuleCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.add_systems(
            Update,
            (
                forward_generic_fx_management_commands,
                nightfall_fx::events::crud_events,
                handle_events,
                nightfall_undo::systems::finish_command_undo_groups,
            )
                .chain(),
        );
        app.world_mut()
            .resource_mut::<DataProvider<StoredFxModule>>()
            .add(test_module(module_uid))
            .expect("test module should insert cleanly");
        app
    }

    /// Inserts one group alias used by persistence normalization tests.
    fn insert_selection_group(app: &mut App, id: u32, uid: Uuid) {
        app.world_mut()
            .resource_mut::<DataProvider<Group>>()
            .add(Group {
                identifiers: Identifiers {
                    id,
                    uid,
                    label: format!("Group {id}"),
                },
                selection: SpatialSelection::default(),
                description: String::new(),
            })
            .expect("group should store");
    }

    /// Verify clip start activates the referenced stored fx module.
    #[test]
    fn start_clip_activates_fx_module_source() {
        let module_uid = Uuid::from_u128(0x100);
        let mut app = setup_app(module_uid);

        app.world_mut()
            .write_message(EngineActionEnvelope::detached(
                FxModulePlaybackAction::Start {
                    fx_module_uid: module_uid,
                    context: test_start_context(31, true),
                },
            ));
        app.update();

        assert!(app.world().resource::<ActiveFxModuleIds>().0.contains(&6));
        assert_eq!(
            app.world().resource::<FxModuleClipBindings>().0.get(&31),
            Some(&FxModuleClipBinding {
                fx_module_id: 6,
                start_context: test_start_context(31, true),
            })
        );
    }

    /// Verify clip stop deactivates the module and clears local clip bindings.
    #[test]
    fn stop_clip_deactivates_fx_module_source() {
        let module_uid = Uuid::from_u128(0x101);
        let mut app = setup_app(module_uid);
        app.world_mut()
            .resource_mut::<ActiveFxModuleIds>()
            .0
            .insert(6);
        app.world_mut()
            .resource_mut::<FxModuleClipBindings>()
            .0
            .insert(
                31,
                FxModuleClipBinding {
                    fx_module_id: 6,
                    start_context: test_start_context(31, true),
                },
            );

        app.world_mut()
            .write_message(EngineActionEnvelope::detached(
                FxModulePlaybackAction::Stop {
                    clip_id: 31,
                    fx_module_uid: module_uid,
                },
            ));
        app.update();

        assert!(!app.world().resource::<ActiveFxModuleIds>().0.contains(&6));
        assert!(
            !app.world()
                .resource::<FxModuleClipBindings>()
                .0
                .contains_key(&31)
        );
    }

    /// Verify generic FX move commands update stored module and active runtime IDs together.
    #[test]
    fn generic_move_fx_command_moves_stored_module_state() {
        let module_uid = Uuid::from_u128(0x102);
        let mut app = setup_management_app(module_uid);
        app.world_mut()
            .resource_mut::<ActiveFxModuleIds>()
            .0
            .insert(6);
        app.world_mut()
            .resource_mut::<ActiveFxModuleTimings>()
            .0
            .insert(6, InstanceClock::default());
        app.world_mut()
            .resource_mut::<FxModuleClipBindings>()
            .0
            .insert(
                31,
                FxModuleClipBinding {
                    fx_module_id: 6,
                    start_context: test_start_context(31, true),
                },
            );

        let command = tracked_command(&mut app, FxCommand::RenameFx { id: 6, new_id: 9 });
        app.world_mut().write_message(command);
        app.update();

        let modules = app.world().resource::<DataProvider<StoredFxModule>>();
        assert!(modules.from_id(6).is_err());
        assert_eq!(
            modules
                .from_id(9)
                .expect("module should move")
                .identifiers
                .uid,
            module_uid
        );
        let active_ids = &app.world().resource::<ActiveFxModuleIds>().0;
        assert!(!active_ids.contains(&6));
        assert!(active_ids.contains(&9));
        let timings = &app.world().resource::<ActiveFxModuleTimings>().0;
        assert!(!timings.contains_key(&6));
        assert!(timings.contains_key(&9));
        assert_eq!(
            app.world()
                .resource::<FxModuleClipBindings>()
                .0
                .get(&31)
                .expect("clip binding should remain")
                .fx_module_id,
            9
        );
        let results = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(
            results.len(),
            1,
            "delegated move should finish exactly once"
        );
        assert!(matches!(
            results[0].outcome,
            CommandOutcome::Succeeded { .. }
        ));
        app.world_mut()
            .resource_mut::<UndoManager>()
            .finalize_detached_groups();
        let undo_group = app
            .world()
            .resource::<UndoManager>()
            .peek_undo()
            .expect("module move should create an undo group");
        let inverse = undo_group.entries[0]
            .command
            .as_any()
            .downcast_ref::<FxModuleCommand>()
            .expect("module move inverse should use the module command channel");
        assert!(matches!(
            inverse,
            FxModuleCommand::MoveFxModule { id: 9, new_id: 6 }
        ));
    }

    /// Verify generic FX remove commands delete stored modules and clear active runtime state.
    #[test]
    fn generic_delete_fx_command_removes_stored_module_state() {
        let module_uid = Uuid::from_u128(0x103);
        let mut app = setup_management_app(module_uid);
        app.world_mut()
            .resource_mut::<ActiveFxModuleIds>()
            .0
            .insert(6);
        app.world_mut()
            .resource_mut::<ActiveFxModuleTimings>()
            .0
            .insert(6, InstanceClock::default());
        app.world_mut()
            .resource_mut::<FxModuleClipBindings>()
            .0
            .insert(
                31,
                FxModuleClipBinding {
                    fx_module_id: 6,
                    start_context: test_start_context(31, true),
                },
            );

        let command = tracked_command(&mut app, FxCommand::DeleteFx(6));
        app.world_mut().write_message(command);
        app.update();

        assert!(
            app.world()
                .resource::<DataProvider<StoredFxModule>>()
                .get(module_uid)
                .is_err()
        );
        assert!(!app.world().resource::<ActiveFxModuleIds>().0.contains(&6));
        assert!(
            !app.world()
                .resource::<ActiveFxModuleTimings>()
                .0
                .contains_key(&6)
        );
        assert!(
            !app.world()
                .resource::<FxModuleClipBindings>()
                .0
                .contains_key(&31)
        );
        app.world_mut()
            .resource_mut::<UndoManager>()
            .finalize_detached_groups();
        let undo_group = app
            .world()
            .resource::<UndoManager>()
            .peek_undo()
            .expect("module deletion should create an undo group");
        let inverse = undo_group.entries[0]
            .command
            .as_any()
            .downcast_ref::<FxModuleCommand>()
            .expect("module deletion inverse should use the module command channel");
        let FxModuleCommand::RestoreDeletedFxModule(definition) = inverse else {
            panic!("module deletion inverse should restore the stored definition");
        };
        assert_eq!(definition.identifiers.id, 6);
        assert_eq!(definition.identifiers.uid, module_uid);
    }

    /// Verify an unowned generic FX command is failed once by the extension workflow.
    #[test]
    fn missing_generic_fx_delete_returns_one_failure() {
        let module_uid = Uuid::from_u128(0x10c);
        let mut app = setup_management_app(module_uid);
        let command = tracked_command(&mut app, FxCommand::DeleteFx(99));
        let command_id = command.command_id;
        app.world_mut().write_message(command);

        app.update();

        let results = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(
            results.len(),
            1,
            "delegated failure should finish exactly once"
        );
        assert_eq!(results[0].command_id, command_id);
        assert!(matches!(
            &results[0].outcome,
            CommandOutcome::Failed(error) if error.code == "fx_module.not_found"
        ));
    }

    /// Verify regular FX mutations are not reclassified after their provider changes.
    #[test]
    fn regular_fx_delete_is_not_forwarded_to_module_management() {
        let module_uid = Uuid::from_u128(0x104);
        let mut app = setup_management_app(module_uid);
        let regular_uid = Uuid::from_u128(0x105);
        app.world_mut()
            .resource_mut::<DataProvider<Fx>>()
            .add(Fx {
                identifiers: Identifiers {
                    id: 7,
                    uid: regular_uid,
                    label: "Regular".to_owned(),
                },
                ..Default::default()
            })
            .expect("regular fx should insert cleanly");

        let command = tracked_command(&mut app, FxCommand::DeleteFx(7));
        let command_id = command.command_id;
        app.world_mut().write_message(command);
        app.update();

        assert!(
            app.world()
                .resource::<DataProvider<Fx>>()
                .get(regular_uid)
                .is_err()
        );
        assert!(
            app.world()
                .resource::<DataProvider<StoredFxModule>>()
                .get(module_uid)
                .is_ok()
        );
        assert!(
            !app.world()
                .resource::<ForwardedFxModuleCommands>()
                .0
                .contains(&command_id)
        );
    }

    /// Verify terminal-style stores with fresh UUIDs still update an existing numeric ID.
    #[test]
    fn store_with_fresh_uid_updates_existing_module() {
        let module_uid = Uuid::from_u128(0x10a);
        let mut app = setup_management_app(module_uid);
        let mut config = std::collections::HashMap::new();
        config.insert("speed".to_string(), "2".to_string());
        let command = tracked_command(
            &mut app,
            FxModuleCommand::StoreFxModule(crate::StoredFxModuleRequest {
                identifiers: Identifiers {
                    id: 6,
                    uid: Uuid::from_u128(0x10b),
                    label: "Updated module".to_string(),
                },
                module_name: "updated-module".to_string(),
                selection: None,
                config,
                merge: true,
            }),
        );
        app.world_mut().write_message(command);

        app.update();

        let modules = app.world().resource::<DataProvider<StoredFxModule>>();
        let updated = modules
            .get(module_uid)
            .expect("existing module UUID should remain stable");
        assert_eq!(updated.identifiers.label, "Updated module");
        assert_eq!(updated.module_name, "updated-module");
        assert_eq!(updated.config.get("speed"), Some(&"2".to_string()));
        assert!(modules.get(Uuid::from_u128(0x10b)).is_err());
    }

    /// Verifies regular FX stores bind authored group aliases to stable group identities.
    #[test]
    fn regular_fx_store_stabilizes_group_selection() {
        let module_uid = Uuid::from_u128(0x10c);
        let group_uid = Uuid::from_u128(0x10d);
        let mut app = setup_management_app(module_uid);
        insert_selection_group(&mut app, 4, group_uid);
        let command = tracked_command(
            &mut app,
            FxCommand::StoreFx(Fx {
                identifiers: Identifiers {
                    id: 7,
                    uid: Uuid::from_u128(0x10e),
                    label: "Stable group FX".to_owned(),
                },
                selection: SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ById(4))),
                ..Default::default()
            }),
        );
        app.world_mut().write_message(command);

        app.update();

        let stored = app
            .world()
            .resource::<DataProvider<Fx>>()
            .from_id(7)
            .expect("FX should store");
        assert_eq!(
            stored.selection.source,
            SelectionExpr::Group(GroupRefExpr::ByUid { uid: group_uid })
        );
    }

    /// Verifies stored FX modules bind authored group aliases to stable group identities.
    #[test]
    fn fx_module_store_stabilizes_group_selection() {
        let module_uid = Uuid::from_u128(0x10f);
        let group_uid = Uuid::from_u128(0x110);
        let mut app = setup_management_app(module_uid);
        insert_selection_group(&mut app, 4, group_uid);
        let command = tracked_command(
            &mut app,
            FxModuleCommand::StoreFxModule(crate::StoredFxModuleRequest {
                identifiers: Identifiers {
                    id: 6,
                    uid: Uuid::new_v4(),
                    label: "Stable module".to_owned(),
                },
                module_name: "stable-module".to_owned(),
                selection: Some(SpatialSelection::identity(SelectionExpr::Group(
                    GroupRefExpr::ById(4),
                ))),
                config: Default::default(),
                merge: false,
            }),
        );
        app.world_mut().write_message(command);

        app.update();

        let stored = app
            .world()
            .resource::<DataProvider<StoredFxModule>>()
            .get(module_uid)
            .expect("module should update in place");
        assert_eq!(
            stored.selection.source,
            SelectionExpr::Group(GroupRefExpr::ByUid { uid: group_uid })
        );
    }

    /// Verify domain-specific module deletion remains correct when another FX type shares its ID.
    #[test]
    fn module_delete_does_not_delete_regular_fx_with_same_id() {
        let module_uid = Uuid::from_u128(0x106);
        let regular_uid = Uuid::from_u128(0x107);
        let mut app = setup_management_app(module_uid);
        app.world_mut()
            .resource_mut::<DataProvider<Fx>>()
            .add(Fx {
                identifiers: Identifiers {
                    id: 6,
                    uid: regular_uid,
                    label: "Regular collision".to_owned(),
                },
                ..Default::default()
            })
            .expect("cross-domain collision should reproduce legacy state");

        let command = tracked_command(&mut app, FxModuleCommand::DeleteFxModule(6));
        app.world_mut().write_message(command);
        app.update();

        assert!(
            app.world()
                .resource::<DataProvider<StoredFxModule>>()
                .get(module_uid)
                .is_err()
        );
        assert!(
            app.world()
                .resource::<DataProvider<Fx>>()
                .get(regular_uid)
                .is_ok()
        );

        let command = tracked_command(
            &mut app,
            FxModuleCommand::RestoreDeletedFxModule(test_module(module_uid)),
        );
        app.world_mut().write_message(command);
        app.update();
        assert!(
            app.world()
                .resource::<DataProvider<StoredFxModule>>()
                .get(module_uid)
                .is_ok()
        );
        assert!(
            app.world()
                .resource::<DataProvider<Fx>>()
                .get(regular_uid)
                .is_ok()
        );
    }

    /// Verify restoring a deleted module cannot overwrite a replacement that reused its ID.
    #[test]
    fn module_restore_rejects_reused_numeric_id() {
        let deleted_uid = Uuid::from_u128(0x108);
        let replacement_uid = Uuid::from_u128(0x109);
        let mut app = setup_management_app(deleted_uid);

        let command = tracked_command(&mut app, FxCommand::DeleteFx(6));
        app.world_mut().write_message(command);
        app.update();
        app.world_mut()
            .resource_mut::<UndoManager>()
            .finalize_detached_groups();
        let restore_definition = {
            let undo_group = app
                .world()
                .resource::<UndoManager>()
                .peek_undo()
                .expect("module deletion should capture a restore command");
            let inverse = undo_group.entries[0]
                .command
                .as_any()
                .downcast_ref::<FxModuleCommand>()
                .expect("module deletion inverse should use the module command channel");
            let FxModuleCommand::RestoreDeletedFxModule(definition) = inverse else {
                panic!("module deletion inverse should restore the stored definition");
            };
            definition.clone()
        };

        let mut replacement = test_module(replacement_uid);
        replacement.identifiers.label = "Replacement".to_owned();
        app.world_mut()
            .resource_mut::<DataProvider<StoredFxModule>>()
            .add(replacement)
            .expect("replacement module should reuse the deleted numeric ID");
        let command = tracked_command(
            &mut app,
            FxModuleCommand::RestoreDeletedFxModule(restore_definition),
        );
        app.world_mut().write_message(command);
        app.update();

        let modules = app.world().resource::<DataProvider<StoredFxModule>>();
        assert!(modules.get(deleted_uid).is_err());
        let replacement = modules
            .get(replacement_uid)
            .expect("replacement identity should remain intact");
        assert_eq!(replacement.identifiers.id, 6);
        assert_eq!(replacement.identifiers.label, "Replacement");
    }
}
