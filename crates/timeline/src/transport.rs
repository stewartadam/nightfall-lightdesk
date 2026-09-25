// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Timeline transport commands expanded into the timeline and timecode commands they coordinate.

use bevy_app::App;
use bevy_ecs::prelude::*;
use nightfall_actions::{
    ActionAppExt, ActionDescriptor, ActionParameter, ActionParameterKind, ActionReference,
    ActionSurface, InvocationError,
};
use nightfall_engine::prelude::*;
use nightfall_playback_planner::{TimelinePlaybackActionKind, TimelinePlaybackActionPlan};
use nightfall_timecode::TimecodeCommand;
use nightfall_timecode::prelude::{Timecode, TimecodeGenerator};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::prelude::{Timeline, TimelineCommand, TimelineTriggerMode};

/// Transport change requested for one timeline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TransportRequest {
    /// Start playback from the current position, or from an enabled loop's start.
    Play,
    /// Pause playback at the current position.
    Pause,
    /// Pause when the linked timecode is running, otherwise play.
    Toggle,
}

/// Replaces queued timeline transport commands with the commands they coordinate.
///
/// Play seeks to an enabled loop's start, starts manually triggered timelines, and starts the
/// linked timecode; pause stops manually triggered timelines and pauses the timecode. The
/// concrete commands inherit the transport command's identity, and its lifecycle completes
/// once all of them succeed.
pub fn expand_timeline_transport_commands(
    mut pending: ResMut<PendingCommandBuffer>,
    timelines: Res<DataProvider<Timeline>>,
    timecodes: Res<DataProvider<Timecode>>,
    generators: Query<&TimecodeGenerator>,
    mut responder: CommandResponder,
) {
    for envelope in pending.drain() {
        let request = envelope
            .payload
            .as_any()
            .downcast_ref::<TimelineCommand>()
            .and_then(|command| match command {
                TimelineCommand::PlayTimeline(id) => Some((*id, TransportRequest::Play)),
                TimelineCommand::PauseTimeline(id) => Some((*id, TransportRequest::Pause)),
                TimelineCommand::TogglePlayback(id) => Some((*id, TransportRequest::Toggle)),
                _ => None,
            });
        let Some((timeline_id, request)) = request else {
            pending.push(envelope);
            continue;
        };
        let commands =
            match transport_commands(timeline_id, request, &timelines, &timecodes, &generators) {
                Ok(commands) => commands,
                Err(error) => {
                    if let Err(error) = responder.fail(envelope.command_id, error) {
                        tracing::error!(%error, "timeline_transport_failure_response_failed");
                    }
                    continue;
                }
            };
        if let Err(error) = responder.expect_completions(envelope.command_id, commands.len()) {
            tracing::error!(%error, "timeline_transport_completion_join_failed");
            continue;
        }
        for command in commands {
            pending.push(PayloadEnvelope::with_context(
                envelope.command_id,
                envelope.undo_id,
                command,
            ));
        }
    }
}

/// Resolves the ordered commands that realize one transport request for a timeline.
fn transport_commands(
    timeline_id: u32,
    request: TransportRequest,
    timelines: &DataProvider<Timeline>,
    timecodes: &DataProvider<Timecode>,
    generators: &Query<&TimecodeGenerator>,
) -> Result<Vec<DynEnginePayload>, CommandError> {
    let timeline = timelines.from_id(timeline_id).map_err(|_| {
        CommandError::new(
            "timeline.not_found",
            format!("Timeline {timeline_id} was not found"),
        )
    })?;
    let timecode = timecodes.get(timeline.timecode_uid).map_err(|_| {
        CommandError::new(
            "timeline.timecode_not_found",
            format!("Timeline {timeline_id} has no linked timecode"),
        )
    })?;
    let timecode_id = timecode.identifiers.id;
    let is_running = generators.iter().any(|generator| {
        generator.timecode.identifiers.uid == timecode.identifiers.uid && generator.state.is_active
    });
    let play = match request {
        TransportRequest::Play => true,
        TransportRequest::Pause => false,
        TransportRequest::Toggle => !is_running,
    };
    let manual = timeline.trigger_mode == TimelineTriggerMode::Manual;
    let mut commands: Vec<DynEnginePayload> = Vec::new();
    if play {
        if let Some(loop_range) = timeline.loop_range.as_ref().filter(|range| range.enabled) {
            commands.push(Box::new(TimecodeCommand::SeekTimecode {
                id: timecode_id,
                position: loop_range.start,
            }));
        }
        if manual {
            commands.push(Box::new(TimelineCommand::StartTimeline(timeline_id)));
        }
        commands.push(Box::new(TimecodeCommand::StartTimecode(timecode_id)));
    } else {
        if manual {
            commands.push(Box::new(TimelineCommand::StopTimeline(timeline_id)));
        }
        commands.push(Box::new(TimecodeCommand::PauseTimecode(timecode_id)));
    }
    Ok(commands)
}

/// Stable action ID for starting timeline playback.
pub const TIMELINE_PLAY_ACTION_ID: &str = "timeline.play";

/// Stable action ID for pausing timeline playback.
pub const TIMELINE_PAUSE_ACTION_ID: &str = "timeline.pause";

/// Stable action ID for toggling timeline playback.
pub const TIMELINE_TOGGLE_PLAYBACK_ACTION_ID: &str = "timeline.toggle-playback";

/// Persisted arguments for actions addressing one timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TimelineActionArguments {
    /// Persistent UID of the addressed timeline.
    #[typeshare(serialized_as = "String")]
    pub timeline: Uuid,
}

/// Creates a persisted timeline transport action reference.
pub fn timeline_transport_action(action_id: &str, timeline: Uuid) -> ActionReference {
    ActionReference::with_arguments(action_id, &TimelineActionArguments { timeline })
        .expect("timeline action arguments should serialize")
}

/// Registers the bindable timeline transport actions.
pub fn register_timeline_actions(app: &mut App) {
    register_fire_cue_action(app);
    let transports: [(&str, &str, fn(u32) -> TimelineCommand); 3] = [
        (
            TIMELINE_PLAY_ACTION_ID,
            "Play timeline",
            TimelineCommand::PlayTimeline,
        ),
        (
            TIMELINE_PAUSE_ACTION_ID,
            "Pause timeline",
            TimelineCommand::PauseTimeline,
        ),
        (
            TIMELINE_TOGGLE_PLAYBACK_ACTION_ID,
            "Play/pause timeline",
            TimelineCommand::TogglePlayback,
        ),
    ];
    for (action_id, label, command) in transports {
        app.register_command_action::<TimelineActionArguments, TimelineCommand, _>(
            ActionDescriptor::new(action_id, label, "Timeline").with_parameter(
                ActionParameter::required("timeline", "Timeline", ActionParameterKind::Timeline),
            ),
            move |world, arguments| {
                let timeline_id = world
                    .get_resource::<DataProvider<Timeline>>()
                    .and_then(|timelines| timelines.get(arguments.timeline).ok())
                    .map(|timeline| timeline.identifiers.id)
                    .ok_or_else(|| {
                        InvocationError::new(
                            "timeline.not_found",
                            format!("Timeline with UID {} does not exist", arguments.timeline),
                        )
                    })?;
                Ok(command(timeline_id))
            },
        );
    }
}

/// Stable action ID for playing a cue as a transient timeline playback.
pub const TIMELINE_FIRE_CUE_ACTION_ID: &str = "timeline.fire-cue";

/// Persisted arguments for firing a cue from the timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TimelineFireCueArguments {
    /// Persistent UID of the cue to play.
    #[typeshare(serialized_as = "String")]
    pub cue: Uuid,
}

/// Creates a persisted fire-cue action reference.
pub fn fire_cue_action(cue: Uuid) -> ActionReference {
    ActionReference::with_arguments(
        TIMELINE_FIRE_CUE_ACTION_ID,
        &TimelineFireCueArguments { cue },
    )
    .expect("fire cue arguments should serialize")
}

/// Registers the timeline-owned fire-cue action.
///
/// Firing a cue creates a transient playback owned by the timeline action that placed it,
/// lasting the action's duration, so it is restricted to the timeline surface. Timeline
/// playback materializes the cue through the planning capability rather than the live
/// invoker, which only reports that path.
fn register_fire_cue_action(app: &mut App) {
    app.register_action::<TimelineFireCueArguments, _>(
        ActionDescriptor::new(TIMELINE_FIRE_CUE_ACTION_ID, "Fire cue", "Timeline")
            .with_description("Plays a cue as a transient playback for the action's duration")
            .with_parameter(ActionParameter::required(
                "cue",
                "Cue",
                ActionParameterKind::Cue,
            ))
            .with_surfaces([ActionSurface::Timeline]),
        |_world, _arguments, _invocation| {
            Err(InvocationError::new(
                "timeline.fire_cue_planned",
                "Fire cue runs through timeline playback planning",
            ))
        },
    )
    .register_action_capability::<TimelineFireCueArguments, TimelinePlaybackActionPlan, _>(
        TIMELINE_FIRE_CUE_ACTION_ID,
        TimelinePlaybackActionPlan::CAPABILITY,
        |arguments| {
            Ok(TimelinePlaybackActionPlan {
                owner_uid: arguments.cue,
                kind: TimelinePlaybackActionKind::FireCue,
            })
        },
    );
}
