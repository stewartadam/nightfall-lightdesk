// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Timeline-owned transport operations shared by UI and controller bindings.

use std::collections::HashSet;

use bevy_app::{App, Update};
use bevy_ecs::prelude::*;
use nightfall_actions::{
    ActionDescriptor, ActionId, ActionInputKind, ActionRegistry, ActionSurface,
};
use nightfall_engine::prelude::*;
use nightfall_timecode::{TimecodeEvent, components::TimecodeGenerator};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{components::MaterializedTimeline, timeline::TimelineTriggerMode};

/// Toggles the linked clock and the manual timeline's activation together.
pub const TIMELINE_TOGGLE_ACTION_ID: &str = "timeline.toggle-playback";

/// Persistent target independent of the panel and the timeline's numeric ID.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TimelineArguments {
    timeline_uid: Uuid,
}

/// One tracked playback operation; runtime transport changes have no undo inverse.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data", deny_unknown_fields)]
pub enum TimelineTransportCommand {
    /// Chooses play or pause from the linked clock at execution time.
    Toggle {
        /// Persistent timeline identity.
        timeline_uid: Uuid,
    },
    /// Requests an explicit playback state from the ordinary timeline UI.
    SetPlaying {
        /// Persistent timeline identity.
        timeline_uid: Uuid,
        /// Whether the linked clock should run.
        playing: bool,
    },
}
impl IngressCommand for TimelineTransportCommand {}

/// Manual timeline stops applied this frame, consumed by existing release and reset systems.
#[derive(Resource, Default)]
pub(crate) struct TimelineTransportStops(pub HashSet<u32>);

/// Registers the command, live-only action, and execution order before timeline observers.
pub(crate) fn install(app: &mut App) {
    app.init_resource::<ActionRegistry>();
    app.init_resource::<TimelineTransportStops>();
    register_ingress_command::<TimelineTransportCommand>(app);
    register_command_deserializer::<TimelineTransportCommand>(app, deserialize);
    app.world_mut().resource_mut::<ActionRegistry>().register::<TimelineArguments, _>(
        ActionDescriptor {
            capabilities: Vec::new(),
            id: ActionId::new(TIMELINE_TOGGLE_ACTION_ID), label: "Start / pause timeline".into(),
            allowed_surfaces: vec![ActionSurface::Midi, ActionSurface::Osc, ActionSurface::Websocket],
            input_kind: ActionInputKind::Trigger,
            argument_schema: serde_json::json!({"type":"object", "required":["timeline_uid"], "properties":{"timeline_uid":{"type":"string", "format":"uuid"}}, "additionalProperties":false}),
        },
        |world, args, invocation| nightfall_engine::action_commands::invoke_action_command(world, invocation,
            TimelineTransportCommand::Toggle { timeline_uid: args.timeline_uid }),
    );
    app.world_mut()
        .resource_mut::<ActionRegistry>()
        .register_target_validator::<TimelineArguments, _>(
            TIMELINE_TOGGLE_ACTION_ID,
            validate_timeline_target,
        );
    app.add_systems(
        Update,
        handle_transport
            .in_set(EventHandling)
            .after(nightfall_timecode::events::handle_events)
            .before(crate::timeline_events::handle_timecode_events),
    );
}

/// Resolves persistent timeline and linked-clock identities without requiring runtime playback.
fn validate_timeline_target(
    world: &World,
    arguments: TimelineArguments,
) -> Result<(), nightfall_actions::InvocationError> {
    use nightfall_actions::InvocationError;
    let timelines = world
        .get_resource::<DataProvider<crate::timeline::Timeline>>()
        .ok_or_else(|| {
            InvocationError::new("timeline.unavailable", "Timeline storage is unavailable")
        })?;
    let timeline = timelines.get(arguments.timeline_uid).map_err(|_| {
        InvocationError::new("timeline.not_found", "The mapped timeline no longer exists")
    })?;
    let clocks = world
        .get_resource::<DataProvider<nightfall_timecode::prelude::Timecode>>()
        .ok_or_else(|| {
            InvocationError::new(
                "timeline.clock_unavailable",
                "Timecode storage is unavailable",
            )
        })?;
    clocks.get(timeline.timecode_uid).map(|_| ()).map_err(|_| {
        InvocationError::new(
            "timeline.clock_unavailable",
            "The linked timecode no longer exists",
        )
    })
}

/// Admits UI commands through normal tracked dispatch without duplicating domain behavior.
fn deserialize(
    world: &mut World,
    value: serde_json::Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: TimelineTransportCommand =
        serde_json::from_value(value).map_err(|error| error.to_string())?;
    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));
    Ok(())
}

/// Resolves both UIDs before mutation, preserving pause position and manual stop cleanup.
fn handle_transport(
    mut events: MessageReader<CommandEnvelope<TimelineTransportCommand>>,
    mut timelines: Query<(Entity, &mut MaterializedTimeline)>,
    mut clocks: Query<(Entity, &mut TimecodeGenerator)>,
    mut facts: MessageWriter<TimecodeEvent>,
    mut stops: ResMut<TimelineTransportStops>,
    mut responder: CommandResponder,
) {
    stops.0.clear();
    for event in events.read() {
        let (uid, requested) = match event.command {
            TimelineTransportCommand::Toggle { timeline_uid } => (timeline_uid, None),
            TimelineTransportCommand::SetPlaying {
                timeline_uid,
                playing,
            } => (timeline_uid, Some(playing)),
        };
        let matching: Vec<_> = timelines
            .iter()
            .filter(|(_, timeline)| timeline.timeline.identifiers.uid == uid)
            .map(|(entity, _)| entity)
            .collect();
        let result = if let [entity] = matching.as_slice() {
            let (_, mut timeline) = timelines
                .get_mut(*entity)
                .expect("resolved timeline exists");
            let linked: Vec<_> = clocks
                .iter()
                .filter(|(_, clock)| {
                    clock.timecode.identifiers.uid == timeline.timeline.timecode_uid
                })
                .map(|(entity, _)| entity)
                .collect();
            if let [clock_entity] = linked.as_slice() {
                let (_, mut clock) = clocks
                    .get_mut(*clock_entity)
                    .expect("resolved clock exists");
                let playing = requested.unwrap_or(!clock.state.is_active);
                if timeline.timeline.trigger_mode == TimelineTriggerMode::Manual {
                    if playing {
                        timeline.activate();
                    } else {
                        timeline.deactivate();
                        stops.0.insert(timeline.timeline.identifiers.id);
                    }
                }
                if playing {
                    clock.start();
                } else {
                    clock.pause();
                }
                facts.write(if playing {
                    TimecodeEvent::Started(clock.timecode.identifiers.id)
                } else {
                    TimecodeEvent::Paused(clock.timecode.identifiers.id)
                });
                responder.succeed(event.command_id)
            } else {
                responder.fail(
                    event.command_id,
                    CommandError::new(
                        "timeline.clock_unavailable",
                        "The linked timecode is missing or ambiguous",
                    ),
                )
            }
        } else {
            responder.fail(
                event.command_id,
                CommandError::new(
                    "timeline.target_unavailable",
                    "The mapped timeline is missing or ambiguous",
                ),
            )
        };
        if let Err(error) = result {
            tracing::error!(%error, "timeline_transport_completion_failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::{TimelineAction, timeline::Timeline};

    /// Builds transport and lifecycle observers without loading playback or audio services.
    fn app() -> App {
        let mut app = App::new();
        app.init_resource::<TimelineTransportStops>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<TimelineTransportCommand>>();
        app.add_message::<EngineActionEnvelope<TimelineAction>>();
        app.add_message::<TimecodeEvent>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.add_systems(
            Update,
            (
                handle_transport,
                crate::timeline_events::handle_timecode_events,
            )
                .chain(),
        );
        app
    }

    /// Submits one tracked transport command and returns its terminal result after observers run.
    fn submit(app: &mut App, command: TimelineTransportCommand) -> CommandOutcome {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .unwrap();
        app.world_mut().write_message(envelope);
        app.update();
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .unwrap()
            .outcome
    }

    /// Validation needs no playback entity and cannot retarget a reused timeline number.
    #[test]
    fn binding_validation_requires_persistent_timeline_and_linked_clock() {
        use nightfall_timecode::prelude::Timecode;
        let mut world = World::new();
        world.init_resource::<DataProvider<Timeline>>();
        world.init_resource::<DataProvider<Timecode>>();
        let clock = Timecode::default();
        let clock_uid = clock.identifiers.uid;
        let mut timeline = Timeline {
            timecode_uid: clock_uid,
            ..Default::default()
        };
        let uid = timeline.identifiers.uid;
        world
            .resource_mut::<DataProvider<Timeline>>()
            .add(timeline.clone())
            .unwrap();
        let validate = |world: &World| {
            validate_timeline_target(world, TimelineArguments { timeline_uid: uid })
        };
        assert_eq!(
            validate(&world).unwrap_err().code,
            "timeline.clock_unavailable"
        );
        world
            .resource_mut::<DataProvider<Timecode>>()
            .add(clock)
            .unwrap();
        assert!(validate(&world).is_ok());
        world
            .resource_mut::<DataProvider<Timeline>>()
            .remove(&uid)
            .unwrap();
        timeline.identifiers.uid = Uuid::new_v4();
        world
            .resource_mut::<DataProvider<Timeline>>()
            .add(timeline)
            .unwrap();
        assert_eq!(validate(&world).unwrap_err().code, "timeline.not_found");
    }

    /// Manual playback stops the timeline; follow-timecode playback pauses while retaining activation.
    #[test]
    fn toggle_preserves_manual_and_follow_timecode_pause_behavior() {
        for mode in [
            TimelineTriggerMode::Manual,
            TimelineTriggerMode::FollowTimecode,
        ] {
            let mut app = app();
            let mut clock = TimecodeGenerator::default();
            clock.seek(Duration::from_secs(12));
            let timeline = Timeline {
                trigger_mode: mode,
                timecode_uid: clock.timecode.identifiers.uid,
                ..Default::default()
            };
            let uid = timeline.identifiers.uid;
            let timeline_id = timeline.identifiers.id;
            let timeline_entity = app
                .world_mut()
                .spawn(MaterializedTimeline::new(timeline))
                .id();
            let clock_entity = app.world_mut().spawn(clock).id();
            assert_eq!(
                submit(
                    &mut app,
                    TimelineTransportCommand::Toggle { timeline_uid: uid }
                ),
                CommandOutcome::succeeded()
            );
            assert!(
                app.world()
                    .get::<MaterializedTimeline>(timeline_entity)
                    .unwrap()
                    .is_active
            );
            assert!(
                app.world()
                    .get::<TimecodeGenerator>(clock_entity)
                    .unwrap()
                    .state
                    .is_active
            );
            assert_eq!(
                submit(
                    &mut app,
                    TimelineTransportCommand::Toggle { timeline_uid: uid }
                ),
                CommandOutcome::succeeded()
            );
            let clock = app.world().get::<TimecodeGenerator>(clock_entity).unwrap();
            assert!(!clock.state.is_active);
            assert_eq!(clock.state.current_time, Duration::from_secs(12));
            assert_eq!(
                app.world()
                    .get::<MaterializedTimeline>(timeline_entity)
                    .unwrap()
                    .is_active,
                mode == TimelineTriggerMode::FollowTimecode
            );
            assert_eq!(
                app.world()
                    .resource::<TimelineTransportStops>()
                    .0
                    .contains(&timeline_id),
                mode == TimelineTriggerMode::Manual
            );
            app.update();
            assert!(
                app.world()
                    .resource::<TimelineTransportStops>()
                    .0
                    .is_empty()
            );
        }
    }

    /// Missing linked clocks and deleted UIDs fail before either runtime object is changed.
    #[test]
    fn missing_clock_and_reused_numeric_id_do_not_retarget_or_partially_activate() {
        let mut app = app();
        let timeline = Timeline {
            trigger_mode: TimelineTriggerMode::Manual,
            ..Default::default()
        };
        let old_uid = timeline.identifiers.uid;
        let entity = app
            .world_mut()
            .spawn(MaterializedTimeline::new(timeline.clone()))
            .id();
        assert!(
            matches!(submit(&mut app, TimelineTransportCommand::Toggle { timeline_uid: old_uid }), CommandOutcome::Failed(error) if error.code == "timeline.clock_unavailable")
        );
        assert!(
            !app.world()
                .get::<MaterializedTimeline>(entity)
                .unwrap()
                .is_active
        );
        app.world_mut().despawn(entity);
        let mut replacement = timeline;
        replacement.identifiers.uid = Uuid::new_v4();
        let replacement_entity = app
            .world_mut()
            .spawn(MaterializedTimeline::new(replacement))
            .id();
        assert!(
            matches!(submit(&mut app, TimelineTransportCommand::Toggle { timeline_uid: old_uid }), CommandOutcome::Failed(error) if error.code == "timeline.target_unavailable")
        );
        assert!(
            !app.world()
                .get::<MaterializedTimeline>(replacement_entity)
                .unwrap()
                .is_active
        );
    }
}
