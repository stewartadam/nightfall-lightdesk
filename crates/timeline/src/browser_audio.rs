// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Transport-neutral timeline audio directives for browser hosts.

use std::collections::HashMap;
use std::time::Duration;

use bevy_ecs::prelude::*;
use bevy_ecs::world::DeferredWorld;
use nightfall_engine::prelude::{ClientEventSink, DISCRIMINATOR_NON_DROPPABLE};
use nightfall_timecode::prelude::TimecodeGenerator;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::components::MaterializedTimeline;

/// Enabled browser media loop bounds.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct TimelineAudioLoopRange {
    /// Inclusive loop start.
    pub start: Duration,
    /// Exclusive loop end.
    pub end: Duration,
}

/// One audio side effect requested by the authoritative timeline domain.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum TimelineAudioDirective {
    /// Load one logical bundled asset for a timeline.
    Load {
        /// Timeline definition requesting playback.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        timeline_uid: Uuid,
        /// Logical asset identifier resolved by the browser host.
        asset_id: String,
    },
    /// Begin or resume playback from the supplied authoritative offset.
    Play {
        /// Timeline definition requesting playback.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        timeline_uid: Uuid,
        /// Requested media offset.
        offset: Duration,
    },
    /// Report where engine playback is now, so playing media can correct its drift.
    Sync {
        /// Timeline definition that is playing.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        timeline_uid: Uuid,
        /// Current authoritative media offset.
        offset: Duration,
    },
    /// Pause playback while retaining the loaded media and position.
    Pause {
        /// Timeline definition requesting the pause.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        timeline_uid: Uuid,
    },
    /// Seek loaded media to the supplied authoritative offset.
    Seek {
        /// Timeline definition requesting the seek.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        timeline_uid: Uuid,
        /// Requested media offset.
        offset: Duration,
    },
    /// Stop playback and return media to the beginning.
    Stop {
        /// Timeline definition requesting the stop.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        timeline_uid: Uuid,
    },
    /// Apply the persisted timeline loop range to browser media.
    SetLoop {
        /// Timeline definition owning the loop.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        timeline_uid: Uuid,
        /// Enabled loop range, or `None` when looping is disabled.
        range: Option<TimelineAudioLoopRange>,
    },
    /// Release loaded media for an inactive timeline.
    Unload {
        /// Timeline definition whose media is no longer needed.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        timeline_uid: Uuid,
    },
}

/// Wrapper that keeps audio directives in the existing client-message framing.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
enum TimelineAudioClientMessage<'a> {
    /// Browser-host audio side effect.
    TimelineAudioDirective(&'a TimelineAudioDirective),
}

/// Emit browser audio effects for timelines whose authoritative state changed, and report
/// the engine clock to playing media every
/// [`AUDIO_CLOCK_REPORT_INTERVAL`](crate::components::AUDIO_CLOCK_REPORT_INTERVAL) of playback.
pub(crate) fn emit_browser_audio_directives(
    mut timelines: Query<&mut MaterializedTimeline>,
    timecodes: Query<&TimecodeGenerator>,
    broadcaster: Res<ClientEventSink>,
) {
    let timecode_info = timecodes
        .iter()
        .map(|timecode| {
            (
                timecode.timecode.identifiers.uid,
                (timecode.state.current_time, timecode.state.is_active),
            )
        })
        .collect::<HashMap<_, _>>();

    for mut timeline in timelines.iter_mut().filter(|timeline| {
        timeline.audio_needs_sync || timeline.audio_clock_reported_offset.is_some()
    }) {
        let timeline_uid = timeline.timeline.identifiers.uid;
        let (current_time, timecode_running) = timecode_info
            .get(&timeline.timeline.timecode_uid)
            .copied()
            .unwrap_or((Duration::ZERO, false));
        let offset = timeline.get_playback_position(current_time);
        let playing = timeline.is_active && timeline.timeline.audio_enabled && timecode_running;

        if !timeline.audio_needs_sync {
            if timeline.take_audio_clock_report(playing, offset) {
                publish(
                    &broadcaster,
                    &TimelineAudioDirective::Sync {
                        timeline_uid,
                        offset,
                    },
                );
            }
            continue;
        }

        timeline.anchor_audio_clock(playing, offset);
        let loop_range = timeline
            .timeline
            .loop_range
            .as_ref()
            .filter(|range| range.enabled)
            .map(|range| TimelineAudioLoopRange {
                start: range.start,
                end: range.end,
            });

        if timeline.is_active && timeline.timeline.audio_enabled {
            publish(
                &broadcaster,
                &TimelineAudioDirective::Load {
                    timeline_uid,
                    asset_id: timeline.timeline.audio_path.clone(),
                },
            );
            publish(
                &broadcaster,
                &TimelineAudioDirective::SetLoop {
                    timeline_uid,
                    range: loop_range,
                },
            );
            publish(
                &broadcaster,
                &TimelineAudioDirective::Seek {
                    timeline_uid,
                    offset,
                },
            );
            if timecode_running {
                publish(
                    &broadcaster,
                    &TimelineAudioDirective::Play {
                        timeline_uid,
                        offset,
                    },
                );
            } else {
                publish(
                    &broadcaster,
                    &TimelineAudioDirective::Pause { timeline_uid },
                );
            }
        } else {
            publish(&broadcaster, &TimelineAudioDirective::Stop { timeline_uid });
            publish(
                &broadcaster,
                &TimelineAudioDirective::Unload { timeline_uid },
            );
        }

        timeline.audio_needs_sync = false;
    }
}

/// Marks that browser hosts play timeline audio from this engine's directives.
#[derive(Resource, Debug, Default)]
pub(crate) struct BrowserTimelineAudio;

/// Tells browser hosts to stop and unload the audio of an active timeline that is going away.
pub(crate) fn release_browser_audio(world: &mut DeferredWorld, timeline_uid: Uuid) {
    if !world.contains_resource::<BrowserTimelineAudio>() {
        return;
    }
    let Some(broadcaster) = world.get_resource::<ClientEventSink>() else {
        return;
    };
    publish(broadcaster, &TimelineAudioDirective::Stop { timeline_uid });
    publish(
        broadcaster,
        &TimelineAudioDirective::Unload { timeline_uid },
    );
}

/// Publish one directive through the shared encoded client bridge.
fn publish(broadcaster: &ClientEventSink, directive: &TimelineAudioDirective) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &TimelineAudioClientMessage::TimelineAudioDirective(directive),
    );
}

#[cfg(test)]
mod tests {
    use nightfall_engine::prelude::OutboundFrame;

    use super::*;
    use crate::prelude::Timeline;

    /// Despawning an active timeline, as deleting it or loading another show does, tells
    /// browser hosts to stop and unload its audio.
    #[test]
    fn despawned_active_timeline_stops_browser_audio() {
        let (tx, rx) = async_channel::unbounded::<OutboundFrame>();
        let mut world = World::new();
        world.init_resource::<BrowserTimelineAudio>();
        world.insert_resource(ClientEventSink::new(tx));
        let mut timeline = MaterializedTimeline::new(Timeline::default());
        timeline.activate();
        let entity = world.spawn(timeline).id();

        world.entity_mut(entity).despawn();

        let directives = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|frame| String::from_utf8_lossy(&frame.bytes).into_owned())
            .collect::<Vec<_>>();
        assert_eq!(directives.len(), 2, "directives: {directives:?}");
        assert!(directives[0].contains("Stop"), "{}", directives[0]);
        assert!(directives[1].contains("Unload"), "{}", directives[1]);
    }
}
