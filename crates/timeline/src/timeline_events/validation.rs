// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Side-effect-free validation of registered actions entering timeline storage.

use nightfall_actions::{ActionInputKind, ActionRegistry, ActionSurface};
use nightfall_playback_planner::{TIMELINE_PLAYBACK_CAPABILITY_ID, TimelinePlaybackActionPlan};

use crate::{Action, ActionKind, TimelineCommand};

/// Checks every new binding before a command can alter storage or materialized playback.
pub(super) fn validate_command(
    command: &TimelineCommand,
    registry: Option<&ActionRegistry>,
) -> Result<(), String> {
    match command {
        TimelineCommand::StoreTimeline(timeline)
        | TimelineCommand::CreateTimeline { timeline, .. }
        | TimelineCommand::RestoreTimelineCreation { timeline, .. } => validate_actions(
            timeline.tracks.iter().flat_map(|track| &track.actions),
            registry,
        ),
        TimelineCommand::InsertRecordedActions { actions, .. } => {
            validate_actions(actions.iter(), registry)
        }
        _ => Ok(()),
    }
}

/// Validates typed arguments and any advertised deterministic plan without invoking the action.
pub(crate) fn validate_actions<'a>(
    actions: impl Iterator<Item = &'a Action>,
    registry: Option<&ActionRegistry>,
) -> Result<(), String> {
    for action in actions {
        let ActionKind::RegisteredAction(reference) = &action.action else {
            continue;
        };
        let describe = |message: &str| {
            format!(
                "Timeline action {} ({}): {message}",
                action.id,
                reference.id.as_str()
            )
        };
        let registry = registry.ok_or_else(|| describe("action registry is unavailable"))?;
        registry
            .validate_binding(reference, ActionSurface::Timeline, ActionInputKind::Trigger)
            .map_err(|error| describe(&error.message))?;
        let descriptor = registry
            .get(&reference.id)
            .expect("validated action exists");
        if descriptor.capabilities.iter().any(|capability| {
            capability.id == TIMELINE_PLAYBACK_CAPABILITY_ID
                && capability.surface == ActionSurface::Timeline
        }) {
            registry
                .resolve_capability::<TimelinePlaybackActionPlan>(
                    reference,
                    ActionSurface::Timeline,
                )
                .map_err(|error| describe(&error.message))?
                .ok_or_else(|| describe("deterministic timeline planner is unavailable"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use bevy_app::App;
    use nightfall_actions::ActionReference;
    use nightfall_desk::automation_actions::{
        ClipTarget, desk_eval_action, go_clip_action, register_desk_actions,
    };
    use nightfall_timecode::prelude::Timecode;
    use uuid::Uuid;

    use super::*;
    use crate::{Timeline, Track};

    /// Constructs all public mutation paths that can introduce an action reference.
    fn commands_with_reference(reference: ActionReference) -> Vec<TimelineCommand> {
        let action = Action {
            id: "saved-action".to_owned(),
            label: "Saved action".to_owned(),
            position: std::time::Duration::ZERO,
            duration: std::time::Duration::ZERO,
            action: ActionKind::RegisteredAction(reference),
        };
        let timeline = Timeline {
            tracks: vec![Track {
                id: "track".to_owned(),
                label: "Track".to_owned(),
                muted: true,
                solo: false,
                expanded: false,
                actions: vec![action.clone()],
                automation_lanes: Vec::new(),
            }],
            ..Default::default()
        };
        vec![
            TimelineCommand::StoreTimeline(timeline.clone()),
            TimelineCommand::CreateTimeline {
                timeline: timeline.clone(),
                timecode: Timecode::default(),
            },
            TimelineCommand::RestoreTimelineCreation {
                timeline,
                owned_timecode: None,
            },
            TimelineCommand::InsertRecordedActions {
                timeline_id: 1,
                track_id: "track".to_owned(),
                actions: vec![action],
            },
        ]
    }

    /// Each storage entry point rejects invalid references, even on muted tracks.
    #[test]
    fn all_binding_mutations_validate_registration_arguments_surface_and_plan() {
        let mut app = App::new();
        app.init_resource::<ActionRegistry>();
        register_desk_actions(&mut app);
        let registry = app.world().resource::<ActionRegistry>();
        for reference in [
            ActionReference::new("missing.action", serde_json::json!({})),
            ActionReference::new("desk.eval", serde_json::json!({"command": 42})),
            ActionReference::new("control.go", serde_json::json!({"control_index": 1})),
            go_clip_action(ClipTarget::Id(1)),
        ] {
            for command in commands_with_reference(reference) {
                let error = validate_command(&command, Some(registry)).unwrap_err();
                assert!(error.contains("saved-action"), "{error}");
            }
        }
        for reference in [
            desk_eval_action("clear"),
            go_clip_action(ClipTarget::Uid(Uuid::new_v4())),
        ] {
            for command in commands_with_reference(reference) {
                assert!(validate_command(&command, Some(registry)).is_ok());
                assert!(validate_command(&command, None).is_err());
            }
        }
    }

    /// Failed preflight must leave both persisted objects and materialized playback untouched.
    #[test]
    fn rejected_commands_finish_without_mutating_timeline_or_timecode_storage() {
        use bevy_app::Update;
        use bevy_ecs::message::Messages;
        use nightfall_engine::prelude::*;

        use crate::recording::{
            TimelineCommandOrigins, TimelineRecordingSessions, TimelineRecordingStates,
        };
        use crate::{MaterializedTimeline, TimelineAction};

        let mut app = App::new();
        app.add_plugins(EnginePlugin);
        app.init_resource::<PendingCommandBuffer>();
        app.add_plugins(ClientBridgePlugin);
        app.init_resource::<ActionRegistry>();
        register_desk_actions(&mut app);
        app.init_resource::<DataProvider<Timeline>>();
        app.init_resource::<DataProvider<Timecode>>();
        app.init_resource::<TimelineRecordingStates>();
        app.init_resource::<TimelineRecordingSessions>();
        app.init_resource::<TimelineCommandOrigins>();
        app.init_resource::<crate::beatgrid_detection::BeatgridDetectionRuntime>();
        app.add_message::<CommandEnvelope<TimelineCommand>>();
        app.add_message::<EngineActionEnvelope<TimelineAction>>();
        app.add_message::<EngineActionEnvelope<nightfall_clips::ClipAction>>();
        app.add_systems(Update, super::super::crud_events);

        let mut command_ids = Vec::new();
        for command in commands_with_reference(go_clip_action(ClipTarget::Id(1))) {
            let envelope =
                CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
            command_ids.push(envelope.command_id);
            app.world_mut()
                .resource_mut::<CommandTracker>()
                .register(&envelope)
                .unwrap();
            app.world_mut().write_message(envelope);
        }
        app.update();

        let results: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect();
        assert_eq!(results.len(), command_ids.len());
        for command_id in command_ids {
            let result = results
                .iter()
                .find(|result| result.command_id == command_id)
                .unwrap();
            assert!(matches!(result.outcome, CommandOutcome::Failed(_)));
        }
        assert_eq!(
            app.world()
                .resource::<DataProvider<Timeline>>()
                .iter()
                .count(),
            0
        );
        assert_eq!(
            app.world()
                .resource::<DataProvider<Timecode>>()
                .iter()
                .count(),
            0
        );
        assert_eq!(
            app.world_mut()
                .query::<&MaterializedTimeline>()
                .iter(app.world())
                .count(),
            0
        );
    }
}
