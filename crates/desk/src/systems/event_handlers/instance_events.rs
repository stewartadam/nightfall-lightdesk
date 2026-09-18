// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::selection::SelectionResolver;
#[cfg(test)]
use nightfall_instances::InstanceKind;
use nightfall_instances::{
    InstanceClock, InstanceCommand, InstanceControlUpdate, InstanceControls, InstanceId,
    InstanceMetadata, PlaybackAction, PlaybackReleaseAction, PlaybackScope,
};

use crate::prelude::*;

/// Applies typed playback actions to materialized parameters and DMX state.
pub fn handle_events(
    data_provider: Res<FixtureDataProviderExt>,
    mut events: MessageReader<EngineActionEnvelope<PlaybackAction>>,
    mut results: MessageWriter<OperationResult<(), CommandError>>,
    mut parameter_query: Query<InstanceMut<Parameter>>,
    selection_resolver: SelectionResolver,
    mut dmx_universes: Option<ResMut<ConsoleDmxUniverses>>,
) {
    for event in events.read() {
        let PlaybackAction::ReleaseParameters { scope } = &event.action;
        if let PlaybackScope::Selection(selection_expression) = scope {
            let selection = selection_resolver
                .resolve_expr(selection_expression)
                .into_value();
            tracing::trace!(?selection, "Releasing parameters in selection");
            selection
                .iter()
                .flat_map(|fixture_ref| data_provider.parameter_entities_for_element(fixture_ref))
                .for_each(|parameter_instance| {
                    let mut parameter = parameter_query
                        .get_mut(parameter_instance.entity())
                        .unwrap();
                    parameter.values.current_value = parameter.values.default_value;
                });
        } else {
            // Reset every parameter
            tracing::trace!("Releasing all parameters");
            for mut parameter in &mut parameter_query {
                parameter.values.current_value = parameter.values.default_value;
            }
            if let Some(universes) = dmx_universes.as_deref_mut() {
                universes.clear_values();
            }
        }

        results.write(OperationResult::succeeded(event.operation_id, ()));
    }
}

/// Handles InstanceCommand events for non-clip control paths
pub fn handle_playback_commands(
    mut commands: Commands,
    mut commands_from_ingress: MessageReader<CommandEnvelope<InstanceCommand>>,
    mut release_actions: MessageReader<EngineActionEnvelope<PlaybackReleaseAction>>,
    instance_index: Res<InstanceIndex>,
    instance_query: Query<(
        Entity,
        &InstanceId,
        &InstanceMetadata,
        &InstanceControls,
        Option<&ReleaseMarker>,
    )>,
    mut responder: CommandResponder,
) {
    for event in commands_from_ingress.read() {
        let outcome = apply_playback_command(
            &event.command,
            &mut commands,
            &instance_index,
            &instance_query,
        );
        let result = match outcome {
            Ok(()) => responder.succeed(event.command_id),
            Err(error) => responder.fail(event.command_id, error),
        };
        if let Err(error) = result {
            tracing::error!(command_id = %event.command_id, %error, "playback_command_completion_failed");
        }
    }

    for event in release_actions.read() {
        if let Err(error) = apply_playback_release(
            &event.action,
            &mut commands,
            &instance_index,
            &instance_query,
        ) {
            tracing::warn!(
                operation_id = %event.operation_id,
                code = %error.code,
                message = %error.message,
                "playback_release_action_failed"
            );
        }
    }
}

/// Applies one instance request and reports whether all requested mutations were accepted.
fn apply_playback_command(
    command: &InstanceCommand,
    commands: &mut Commands,
    instance_index: &InstanceIndex,
    instance_query: &Query<(
        Entity,
        &InstanceId,
        &InstanceMetadata,
        &InstanceControls,
        Option<&ReleaseMarker>,
    )>,
) -> Result<(), CommandError> {
    match command {
        InstanceCommand::Stop(instance_id) => apply_playback_release(
            &PlaybackReleaseAction::One(*instance_id),
            commands,
            instance_index,
            instance_query,
        ),
        InstanceCommand::StopAll => apply_playback_release(
            &PlaybackReleaseAction::All,
            commands,
            instance_index,
            instance_query,
        ),
        InstanceCommand::StopByKind(kind) => apply_playback_release(
            &PlaybackReleaseAction::ByKind(kind.clone()),
            commands,
            instance_index,
            instance_query,
        ),
        InstanceCommand::StopByTag(tag) => apply_playback_release(
            &PlaybackReleaseAction::ByTag(tag.clone()),
            commands,
            instance_index,
            instance_query,
        ),

        // Go and Goto need to delegate to the appropriate handler
        // since MaterializedSequence has the actual cue position logic
        InstanceCommand::Go(_instance_id) => Err(CommandError::new(
            "playback.unsupported",
            "Playback Go is not implemented; use clip Go",
        )),

        InstanceCommand::Goto {
            instance_id: _,
            position: _,
        } => Err(CommandError::new(
            "playback.unsupported",
            "Playback Goto is not implemented; use clip Goto",
        )),

        // StartSequence and StartFx spawn new instances without a clip
        InstanceCommand::StartSequence {
            sequence_id: _,
            priority: _,
        } => Err(CommandError::new(
            "playback.unsupported",
            "Direct sequence playback is not implemented",
        )),

        InstanceCommand::StartFx {
            fx_id: _,
            priority: _,
        } => Err(CommandError::new(
            "playback.unsupported",
            "Direct FX playback is not implemented",
        )),
    }
}

/// Applies one concrete playback release action.
fn apply_playback_release(
    action: &PlaybackReleaseAction,
    commands: &mut Commands,
    instance_index: &InstanceIndex,
    instance_query: &Query<(
        Entity,
        &InstanceId,
        &InstanceMetadata,
        &InstanceControls,
        Option<&ReleaseMarker>,
    )>,
) -> Result<(), CommandError> {
    match action {
        PlaybackReleaseAction::One(instance_id) => {
            let playback = instance_index
                .get(instance_id)
                .and_then(|entity| instance_query.get(entity).ok())
                .or_else(|| {
                    instance_query.iter().find(
                        |(_entity, id, _metadata, _controls, _release_marker)| *id == instance_id,
                    )
                });
            if let Some((entity, _id, _metadata, controls, release_marker)) = playback {
                tracing::debug!(instance_id = ?instance_id, "Stopping playback by InstanceId");
                release_playback_now(commands, entity, Some(controls), release_marker);
                Ok(())
            } else {
                tracing::warn!(instance_id = ?instance_id, "Playback not found for Stop command");
                Err(CommandError::new(
                    "playback.not_found",
                    format!("Playback {instance_id:?} does not exist"),
                ))
            }
        }

        PlaybackReleaseAction::All => {
            tracing::debug!("Stopping all instances");
            for (entity, instance_id, _metadata, controls, release_marker) in instance_query.iter()
            {
                tracing::trace!(instance_id = ?instance_id, "Stopping playback");
                release_playback_now(commands, entity, Some(controls), release_marker);
            }
            Ok(())
        }

        PlaybackReleaseAction::ByKind(kind) => {
            tracing::debug!(kind = ?kind, "Stopping instances by kind");
            for (entity, instance_id, metadata, controls, release_marker) in instance_query.iter() {
                if &metadata.kind == kind {
                    tracing::trace!(instance_id = ?instance_id, kind = ?kind, "Stopping playback by kind");
                    release_playback_now(commands, entity, Some(controls), release_marker);
                }
            }
            Ok(())
        }

        PlaybackReleaseAction::ByTag(tag) => {
            tracing::debug!(tag = %tag, "Stopping instances by tag");
            for (entity, instance_id, metadata, controls, release_marker) in instance_query.iter() {
                if metadata.tags.contains(tag) {
                    tracing::trace!(instance_id = ?instance_id, tag = %tag, "Stopping playback by tag");
                    release_playback_now(commands, entity, Some(controls), release_marker);
                }
            }
            Ok(())
        }
    }
}

/// Marks a playback for release and restores zero-rate controls so release can progress.
fn release_playback_now(
    commands: &mut Commands,
    entity: Entity,
    controls: Option<&InstanceControls>,
    release_marker: Option<&ReleaseMarker>,
) {
    if release_marker.is_none() {
        commands.entity(entity).insert(ReleaseMarker::default());
    }

    if let Some(controls) = controls.filter(|controls| controls.rate == 0.0) {
        let mut resumed_controls = controls.clone();
        resumed_controls.rate = 1.0;
        commands.entity(entity).insert(resumed_controls);
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use nightfall::prelude::Group;

    use super::*;

    /// Verifies parameter release actions report their internal completion identity.
    #[test]
    fn parameter_release_action_reports_completion() {
        let mut app = App::new();
        app.add_message::<EngineActionEnvelope<PlaybackAction>>();
        app.add_message::<OperationResult<(), CommandError>>();
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(DataProvider::<Group>::default());
        app.add_systems(Update, handle_events);
        let action = EngineActionEnvelope::detached(PlaybackAction::ReleaseParameters {
            scope: PlaybackScope::All,
        });
        let operation_id = action.operation_id;

        app.world_mut().write_message(action);
        app.update();

        let results: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<OperationResult<(), CommandError>>>()
            .drain()
            .collect();
        assert!(matches!(
            results.as_slice(),
            [OperationResult {
                operation_id: result_operation_id,
                result: Ok(()),
            }] if *result_operation_id == operation_id
        ));
    }

    /// Installs lifecycle resources required by semantic playback command tests.
    fn add_command_lifecycle(app: &mut App) {
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<InstanceCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
    }

    /// Registers and submits one semantic playback command.
    fn submit(app: &mut App, command: InstanceCommand) -> CommandId {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let command_id = envelope.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("playback command should register");
        app.world_mut().write_message(envelope);
        command_id
    }

    /// Verifies stop-by-id can release instances before InstanceIndex catches up.
    #[test]
    fn stop_command_falls_back_to_instance_query_when_index_is_stale() {
        let mut app = App::new();
        add_command_lifecycle(&mut app);
        app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
        app.insert_resource(InstanceIndex::default());
        app.add_systems(Update, handle_playback_commands);

        let instance_id = InstanceId::new();
        let playback = app
            .world_mut()
            .spawn((
                instance_id,
                InstanceMetadata::new(InstanceKind::Cue).with_name("Preview"),
                InstanceControls::default(),
            ))
            .id();

        app.world_mut()
            .resource_mut::<Messages<EngineActionEnvelope<PlaybackReleaseAction>>>()
            .write(EngineActionEnvelope::detached(PlaybackReleaseAction::One(
                instance_id,
            )));
        app.update();

        assert!(
            app.world().get::<ReleaseMarker>(playback).is_some(),
            "expected stale-index playback stop to mark the queried playback for release"
        );
    }

    /// Verifies stopping a zero-rate playback resumes it so release can advance immediately.
    #[test]
    fn stop_command_resumes_paused_playback_for_release() {
        let mut app = App::new();
        add_command_lifecycle(&mut app);
        app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
        let instance_id = InstanceId::new();
        let playback = app
            .world_mut()
            .spawn((
                instance_id,
                InstanceMetadata::new(InstanceKind::Cue),
                InstanceControls {
                    intensity_scale: 1.0,
                    rate: 0.0,
                    ..Default::default()
                },
            ))
            .id();
        let mut index = InstanceIndex::default();
        index.insert(instance_id, playback);
        app.insert_resource(index);
        app.add_systems(Update, handle_playback_commands);

        app.world_mut()
            .resource_mut::<Messages<EngineActionEnvelope<PlaybackReleaseAction>>>()
            .write(EngineActionEnvelope::detached(PlaybackReleaseAction::One(
                instance_id,
            )));
        app.update();

        let controls = app
            .world()
            .get::<InstanceControls>(playback)
            .expect("playback controls should remain present");
        assert_eq!(controls.rate, 1.0);
        assert!(app.world().get::<ReleaseMarker>(playback).is_some());
    }

    /// Verifies an unknown playback returns a structured terminal failure.
    #[test]
    fn missing_playback_stop_returns_failure() {
        let mut app = App::new();
        add_command_lifecycle(&mut app);
        app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
        app.insert_resource(InstanceIndex::default());
        app.add_systems(Update, handle_playback_commands);
        let command_id = submit(&mut app, InstanceCommand::Stop(InstanceId::new()));

        app.update();

        let result = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("missing playback should return a result");
        assert_eq!(result.command_id, command_id);
        assert!(matches!(
            result.outcome,
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "playback.not_found"
        ));
    }

    /// Verifies per-playback rate commands update the active clock multiplier.
    #[test]
    fn set_rate_command_updates_instance_clock_rate() {
        let mut app = App::new();
        app.add_message::<InstanceControlUpdate>();
        app.insert_resource(InstanceIndex::default());
        app.add_systems(Update, handle_playback_control_updates);

        let instance_id = InstanceId::new();
        let playback = app
            .world_mut()
            .spawn((
                instance_id,
                InstanceControls::default(),
                InstanceClock::default(),
            ))
            .id();
        let mut index = InstanceIndex::default();
        index.insert(instance_id, playback);
        app.insert_resource(index);

        app.world_mut()
            .resource_mut::<Messages<InstanceControlUpdate>>()
            .write(InstanceControlUpdate::SetRate {
                instance_id,
                value: 2.0,
            });
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
        assert_eq!(clock.delta, std::time::Duration::from_millis(500));
    }

    /// Verifies rate commands can address instances before InstanceIndex catches up.
    #[test]
    fn set_rate_command_falls_back_to_instance_query_when_index_is_stale() {
        let mut app = App::new();
        app.add_message::<InstanceControlUpdate>();
        app.insert_resource(InstanceIndex::default());
        app.add_systems(Update, handle_playback_control_updates);

        let instance_id = InstanceId::new();
        let playback = app
            .world_mut()
            .spawn((
                instance_id,
                InstanceControls::default(),
                InstanceClock::default(),
            ))
            .id();

        app.world_mut()
            .resource_mut::<Messages<InstanceControlUpdate>>()
            .write(InstanceControlUpdate::SetRate {
                instance_id,
                value: 1.5,
            });
        app.update();

        let controls = app
            .world()
            .get::<InstanceControls>(playback)
            .expect("playback controls should remain present");
        assert_eq!(controls.rate, 1.5);
        let clock = app
            .world()
            .get::<InstanceClock>(playback)
            .expect("playback clock should remain present");
        assert_eq!(clock.rate, 1.5);
    }
}

/// Applies high-frequency playback control updates without command tracking.
pub fn handle_playback_control_updates(
    mut events: MessageReader<InstanceControlUpdate>,
    instance_index: Res<InstanceIndex>,
    mut instance_query: Query<(
        &InstanceId,
        &mut InstanceControls,
        Option<&mut InstanceClock>,
    )>,
) {
    for event in events.read() {
        match event {
            InstanceControlUpdate::SetIntensityScale { instance_id, value } => {
                if let Some(entity) = instance_index.get(instance_id) {
                    if let Ok((_id, mut controls, _clock)) = instance_query.get_mut(entity) {
                        tracing::debug!(
                            instance_id = ?instance_id,
                            value = %value,
                            "Setting playback intensity scale"
                        );
                        controls.intensity_scale = value.clamp(0.0, 1.0);
                    }
                } else {
                    tracing::warn!(
                        instance_id = ?instance_id,
                        "Playback not found for SetIntensityScale command"
                    );
                }
            }

            InstanceControlUpdate::SetRate { instance_id, value } => {
                let mut handled = false;
                if let Some(entity) = instance_index.get(instance_id) {
                    if let Ok((_id, mut controls, mut clock)) = instance_query.get_mut(entity) {
                        tracing::debug!(
                            instance_id = ?instance_id,
                            value = %value,
                            "Setting playback rate"
                        );
                        controls.set_rate(*value);
                        if let Some(clock) = clock.as_deref_mut() {
                            clock.set_rate(controls.effective_rate());
                        }
                        handled = true;
                    }
                }
                if handled {
                    continue;
                }

                for (candidate_id, mut controls, mut clock) in instance_query.iter_mut() {
                    if candidate_id != instance_id {
                        continue;
                    }
                    tracing::debug!(
                        instance_id = ?instance_id,
                        value = %value,
                        "Setting playback rate after falling back to playback query"
                    );
                    controls.set_rate(*value);
                    if let Some(clock) = clock.as_deref_mut() {
                        clock.set_rate(controls.effective_rate());
                    }
                    handled = true;
                    break;
                }
                if !handled {
                    tracing::warn!(instance_id = ?instance_id, "Playback not found for SetRate command");
                }
            }
        }
    }
}
