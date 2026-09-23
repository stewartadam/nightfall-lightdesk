// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Reports invalid retained timeline bindings without deleting user-authored actions.

use bevy_ecs::prelude::*;
use nightfall_actions::ActionRegistry;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{ActionKind, Timeline};

/// A saved action that cannot currently execute or provide its advertised timeline capability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TimelineActionDiagnostic {
    /// Persistent timeline identity, independent of its display number.
    pub timeline_uid: Uuid,
    /// Track containing the saved action, including muted tracks.
    pub track_id: String,
    /// Saved action identity within its track.
    pub action_id: String,
    /// Domain or contract explanation suitable for display beside the action.
    pub message: String,
}

/// Reliable complete replacement of the client's timeline validation diagnostics.
#[derive(Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum TimelineActionValidationMessage {
    /// Invalid bindings across all stored timelines, including inactive ones.
    TimelineActionDiagnostics(Vec<TimelineActionDiagnostic>),
}

/// Checks stored definitions rather than playback entities so loading and closed panels are covered.
fn collect_diagnostics(
    world: &World,
    timelines: &DataProvider<Timeline>,
    registry: Option<&ActionRegistry>,
) -> Vec<TimelineActionDiagnostic> {
    let mut diagnostics = Vec::new();
    for timeline in timelines.iter() {
        for track in &timeline.tracks {
            for action in &track.actions {
                let ActionKind::RegisteredAction(reference) = &action.action else {
                    continue;
                };
                let result = crate::timeline_events::validation::validate_actions(
                    std::iter::once(action),
                    registry,
                )
                .and_then(|()| {
                    registry
                        .expect("structural validation requires registry")
                        .validate_target(world, reference)
                        .map_err(|error| error.message)
                });
                if let Err(message) = result {
                    diagnostics.push(TimelineActionDiagnostic {
                        timeline_uid: timeline.identifiers.uid,
                        track_id: track.id.clone(),
                        action_id: action.id.clone(),
                        message,
                    });
                }
            }
        }
    }
    diagnostics.sort_by(|left, right| {
        (left.timeline_uid, &left.track_id, &left.action_id).cmp(&(
            right.timeline_uid,
            &right.track_id,
            &right.action_id,
        ))
    });
    diagnostics
}

/// Publishes changes and resync snapshots, including target deletion or restoration outside timelines.
pub(crate) fn publish_diagnostics(
    world: &World,
    timelines: Res<DataProvider<Timeline>>,
    registry: Option<Res<ActionRegistry>>,
    mut resync: MessageReader<ResyncRequested>,
    mut previous: Local<Option<Vec<TimelineActionDiagnostic>>>,
    sink: Res<ClientEventSink>,
) {
    let requested = resync.read().count() > 0;
    let diagnostics = collect_diagnostics(world, &timelines, registry.as_deref());
    if requested || previous.as_ref() != Some(&diagnostics) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &TimelineActionValidationMessage::TimelineActionDiagnostics(diagnostics.clone()),
        );
        *previous = Some(diagnostics);
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use nightfall_actions::{
        ActionDescriptor, ActionId, ActionInputKind, ActionReference, ActionSurface,
        InvocationDispatch, InvocationError,
    };
    use serde_json::Value;

    use super::*;

    /// Stored muted actions are diagnosed without playback, and target restoration clears errors.
    #[test]
    fn retained_actions_publish_target_changes_and_resync() {
        #[derive(Resource)]
        struct Available;
        let (sender, receiver) = async_channel::unbounded();
        let mut app = App::new();
        app.insert_resource(ClientEventSink::new(sender));
        app.init_resource::<ActionRegistry>();
        app.init_resource::<DataProvider<Timeline>>();
        app.add_message::<ResyncRequested>();
        let mut registry = app.world_mut().resource_mut::<ActionRegistry>();
        registry.register::<Value, _>(
            ActionDescriptor {
                id: ActionId::new("test.live"),
                label: "Live test".into(),
                allowed_surfaces: vec![ActionSurface::Timeline],
                input_kind: ActionInputKind::Trigger,
                argument_schema: serde_json::json!({}),
                capabilities: vec![],
            },
            |_, _, _| Ok(InvocationDispatch::succeeded()),
        );
        registry.register_target_validator::<Value, _>("test.live", |world, _| {
            if world.contains_resource::<Available>() {
                Ok(())
            } else {
                Err(InvocationError::new(
                    "test.missing",
                    "Target is unavailable",
                ))
            }
        });
        let timeline = Timeline {
            tracks: vec![crate::Track {
                id: "muted".into(),
                label: "Muted track".into(),
                muted: true,
                solo: false,
                expanded: false,
                automation_lanes: vec![],
                actions: vec![crate::Action {
                    id: "saved".into(),
                    label: "Saved action".into(),
                    position: std::time::Duration::ZERO,
                    duration: std::time::Duration::ZERO,
                    action: ActionKind::RegisteredAction(ActionReference::new(
                        "test.live",
                        serde_json::json!({}),
                    )),
                }],
            }],
            ..Default::default()
        };
        let uid = timeline.identifiers.uid;
        app.world_mut()
            .resource_mut::<DataProvider<Timeline>>()
            .add(timeline)
            .unwrap();
        app.add_systems(Update, publish_diagnostics);
        for available in [false, true] {
            if available {
                app.world_mut().insert_resource(Available);
            }
            app.update();
            let bytes = receiver.try_recv().unwrap();
            assert_eq!(bytes[0], DISCRIMINATOR_NON_DROPPABLE);
            let TimelineActionValidationMessage::TimelineActionDiagnostics(diagnostics) =
                minicbor_serde::from_slice(&bytes[1..]).unwrap();
            if available {
                assert!(diagnostics.is_empty());
            } else {
                assert_eq!(
                    diagnostics,
                    vec![TimelineActionDiagnostic {
                        timeline_uid: uid,
                        track_id: "muted".into(),
                        action_id: "saved".into(),
                        message: "Target is unavailable".into(),
                    }]
                );
            }
            app.update();
            assert!(receiver.try_recv().is_err());
            app.world_mut()
                .write_message(ResyncRequested { command_id: None });
            app.update();
            assert_eq!(receiver.try_recv().unwrap(), bytes);
            assert_eq!(
                app.world()
                    .resource::<DataProvider<Timeline>>()
                    .get(uid)
                    .unwrap()
                    .tracks[0]
                    .actions
                    .len(),
                1
            );
        }
    }
}
