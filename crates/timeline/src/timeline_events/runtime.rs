// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Apply direct and registered timeline start or stop requests to materialized timelines.
pub fn handle_timeline_events(
    mut timeline_query: Query<(Entity, &mut MaterializedTimeline)>,
    mut event_reader: MessageReader<CommandEnvelope<TimelineCommand>>,
    mut action_reader: MessageReader<EngineActionEnvelope<TimelineAction>>,
    mut responder: CommandResponder,
) {
    for event in event_reader.read() {
        match &event.command {
            TimelineCommand::StartTimeline(id) => {
                tracing::debug!("Starting timeline with ID {}", id);
                let found = apply_timeline_action(&TimelineAction::Start(*id), &mut timeline_query);
                finish_timeline_runtime_command(
                    &mut responder,
                    event.command_id,
                    found,
                    format!("Timeline {id} was not found"),
                );
            }

            TimelineCommand::StopTimeline(id) => {
                tracing::debug!("Stopping timeline with ID {}", id);
                let found = apply_timeline_action(&TimelineAction::Stop(*id), &mut timeline_query);
                finish_timeline_runtime_command(
                    &mut responder,
                    event.command_id,
                    found,
                    format!("Timeline {id} was not found"),
                );
            }

            _ => {}
        }
    }

    for event in action_reader.read() {
        if !apply_timeline_action(&event.action, &mut timeline_query) {
            tracing::warn!(
                operation_id = %event.operation_id,
                action = ?event.action,
                "timeline_action_target_not_found"
            );
        }
    }
}

/// Applies one concrete timeline runtime action and returns whether its target existed.
fn apply_timeline_action(
    action: &TimelineAction,
    timeline_query: &mut Query<(Entity, &mut MaterializedTimeline)>,
) -> bool {
    let (timeline_id, activate) = match action {
        TimelineAction::Start(id) => (*id, true),
        TimelineAction::Stop(id) => (*id, false),
        TimelineAction::InsertRecordedActions { .. } => return true,
    };
    let mut found = false;
    for (_, mut timeline) in timeline_query
        .iter_mut()
        .filter(|(_, timeline)| timeline.timeline.identifiers.id == timeline_id)
    {
        found = true;
        if activate {
            timeline.activate();
        } else {
            timeline.deactivate();
        }
    }
    found
}

/// Finishes a tracked runtime command according to whether its target existed.
fn finish_timeline_runtime_command(
    responder: &mut CommandResponder,
    command_id: CommandId,
    found: bool,
    missing_message: String,
) {
    if found {
        succeed_timeline_command(responder, command_id);
    } else {
        fail_timeline_command(responder, command_id, missing_message);
    }
}
