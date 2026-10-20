// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use bevy_ecs::prelude::*;
use nightfall_clips::{ClipReleaseAfterInstance, InstanceIndex};
use nightfall_engine::prelude::*;
use nightfall_instances::{
    InstanceClock, InstanceClockSource, InstanceControls, InstanceId, PlaybackOperation,
    PlaybackScope, Timebase,
};
use nightfall_tempo::prelude::*;
use web_time::Instant;

use crate::clips::{Clip, MaterializedClip};

/// Adds default real-time playback clocks to playback entities that do not have one yet.
pub fn add_missing_instance_clocks(
    mut commands: Commands,
    query: Query<Entity, (With<InstanceId>, Without<InstanceClock>)>,
) {
    for entity in query.iter() {
        commands.entity(entity).insert(InstanceClock::default());
    }
}

/// Query data for playback clocks advanced by [`advance_realtime_instance_clocks`].
type AdvancedClockData = (
    &'static mut InstanceClock,
    Option<&'static InstanceControls>,
    Option<&'static Timebase>,
);

/// Advances playback clocks that are driven by wall-clock frame deltas or the show tempo.
///
/// Beat-timed playbacks move onto the show tempo and seconds-timed ones back onto the clock;
/// timeline-owned and externally driven clocks keep their source. A playback that starts
/// beat-timed is placed at the progress of the beat in progress, so it lands on the beat grid
/// the moment it is launched instead of waiting for the next beat. One switched between
/// timebases while running keeps how far through it is, converted at the current tempo.
///
/// Tempo-driven clocks advance by the beats the show tempo moved this frame, read as seconds,
/// so speed changes scale from the current position without jumping.
pub fn advance_realtime_instance_clocks(
    mut clocks: Query<AdvancedClockData>,
    tempo: Option<Res<ShowTempo>>,
    mut last_update: Local<Option<Instant>>,
    mut last_beat_position: Local<Option<f64>>,
) {
    let now = Instant::now();
    let real_delta = last_update
        .map(|last_update| now.saturating_duration_since(last_update))
        .unwrap_or_default();
    *last_update = Some(now);

    let snapshot = tempo.map(|tempo| tempo.snapshot());
    let beat_position = snapshot.as_ref().map(|snapshot| snapshot.beat_position);
    let beats_per_second = snapshot
        .as_ref()
        .map_or(1.0, |snapshot| snapshot.bpm / 60.0);
    let beat_delta = match (*last_beat_position, beat_position) {
        (Some(last), Some(current)) => Duration::from_secs_f64((current - last).max(0.0)),
        _ => Duration::ZERO,
    };
    *last_beat_position = beat_position;

    for (mut clock, controls, timebase) in clocks.iter_mut() {
        if let Some(controls) = controls {
            clock.set_speed(controls.effective_speed());
        }

        match (timebase.copied().unwrap_or_default(), clock.source) {
            (Timebase::Beats, InstanceClockSource::Realtime) => {
                clock.source = InstanceClockSource::Tempo;
                if clock.position.is_zero() {
                    let beat_phase = beat_position.unwrap_or_default().fract();
                    let start = Duration::from_secs_f64(beat_phase * clock.speed);
                    clock.seek_to(start);
                } else {
                    // A playback already partway through was placed in seconds; carry it into beats.
                    let elapsed_beats = clock.position.mul_f64(beats_per_second);
                    clock.seek_to(elapsed_beats);
                    clock.advance_by_source_delta(beat_delta);
                }
            }
            (Timebase::Seconds, InstanceClockSource::Tempo) => {
                clock.source = InstanceClockSource::Realtime;
                let elapsed_seconds = clock.position.div_f64(beats_per_second);
                clock.seek_to(elapsed_seconds);
                clock.advance_by_realtime_delta(real_delta);
            }
            (_, InstanceClockSource::Realtime) => clock.advance_by_realtime_delta(real_delta),
            (_, InstanceClockSource::Tempo) => clock.advance_by_source_delta(beat_delta),
            _ => {}
        }
    }
}

/// System to despawn orphaned MaterializedClip entities when their playback despawns.
/// This handles the case where a playback is stopped via InstanceCommand::Stop rather than
/// ClipCommand::StopClip - the playback despawns but the separate MaterializedClip
/// entity would otherwise remain orphaned.
pub fn sync_active_state_on_instance_despawn(
    mut commands: Commands,
    instance_index: Res<InstanceIndex>,
    clips: Query<&Clip>,
    materialized_clips: Query<(Entity, &MaterializedClip)>,
    added_materialized_clips: Query<(), Added<MaterializedClip>>,
    release_watchers: Query<(Entity, &ClipReleaseAfterInstance)>,
    mut action_writer: MessageWriter<EngineOperationEnvelope<PlaybackOperation>>,
) {
    for (materialized_clip_entity, materialized_clip) in materialized_clips.iter() {
        if added_materialized_clips.contains(materialized_clip_entity) {
            continue;
        }

        // If the attached playback no longer exists in the index, despawn this MaterializedClip
        if instance_index
            .get(&materialized_clip.attached_instance)
            .is_none()
        {
            tracing::debug!(
                clip_id = %materialized_clip.clip_id,
                instance_id = ?materialized_clip.attached_instance,
                "Despawning orphaned MaterializedClip (playback despawned externally)"
            );
            commands.entity(materialized_clip_entity).despawn();
        }
    }

    for (watcher_entity, watcher) in release_watchers.iter() {
        if instance_index.get(&watcher.attached_instance).is_some() {
            continue;
        }

        if clips
            .iter()
            .any(|clip| clip.identifiers.id == watcher.clip_id)
        {
            action_writer.write(EngineOperationEnvelope::detached(
                PlaybackOperation::ReleaseParameters {
                    scope: PlaybackScope::All,
                },
            ));
        }

        tracing::debug!(
            clip_id = %watcher.clip_id,
            instance_id = ?watcher.attached_instance,
            "Despawning clip release watcher after playback despawn"
        );
        commands.entity(watcher_entity).despawn();
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::prelude::*;
    use nightfall::prelude::Identifiers;
    use nightfall_clips::ClipOptions;
    use uuid::Uuid;

    use super::*;

    /// Verifies playback index insertion, lookup, and removal behavior.
    #[test]
    fn instance_index_crud() {
        let mut index = InstanceIndex::default();
        let id = InstanceId::new();
        let entity = Entity::from_bits(42);

        assert!(index.is_empty());
        index.insert(id, entity);
        assert_eq!(index.len(), 1);
        assert_eq!(index.get(&id), Some(entity));

        let removed = index.remove(&id);
        assert_eq!(removed, Some(entity));
        assert!(index.is_empty());
    }

    /// Verifies clip release watchers emit global release after playback despawn.
    #[test]
    fn sync_active_state_emits_release_after_auto_release_playback_despawns() {
        let mut app = App::new();
        app.add_message::<EngineOperationEnvelope<PlaybackOperation>>();
        app.insert_resource(InstanceIndex::default());
        app.add_systems(Update, sync_active_state_on_instance_despawn);

        let instance_id = InstanceId::new();
        app.world_mut().spawn(Clip {
            identifiers: Identifiers {
                id: 7,
                uid: Uuid::new_v4(),
                label: "exec-7".to_owned(),
            },
            options: ClipOptions {
                auto_release: true,
                deactivate_on_sequence_end: false,
            },
            ..Default::default()
        });
        app.world_mut().spawn(ClipReleaseAfterInstance {
            clip_id: 7,
            attached_instance: instance_id,
        });

        app.update();

        let remaining_watchers = app
            .world_mut()
            .query::<&ClipReleaseAfterInstance>()
            .iter(app.world())
            .count();
        assert_eq!(remaining_watchers, 0, "expected release watcher to despawn");

        let action_events: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<EngineOperationEnvelope<PlaybackOperation>>>()
            .drain()
            .collect();
        assert!(
            action_events.iter().any(|event| {
                matches!(
                    &event.operation,
                    PlaybackOperation::ReleaseParameters {
                        scope: PlaybackScope::All
                    }
                )
            }),
            "expected auto_release clip to emit playback release after despawn"
        );
    }

    /// Verifies unarmed clip bindings do not emit global release after cleanup.
    #[test]
    fn sync_active_state_does_not_emit_release_without_auto_release_marker() {
        let mut app = App::new();
        app.add_message::<EngineOperationEnvelope<PlaybackOperation>>();
        app.insert_resource(InstanceIndex::default());
        app.add_systems(Update, sync_active_state_on_instance_despawn);

        app.world_mut().spawn(Clip {
            identifiers: Identifiers {
                id: 8,
                uid: Uuid::new_v4(),
                label: "exec-8".to_owned(),
            },
            options: ClipOptions {
                auto_release: true,
                deactivate_on_sequence_end: false,
            },
            ..Default::default()
        });
        app.world_mut().spawn(MaterializedClip {
            clip_id: 8,
            attached_instance: InstanceId::new(),
            auto_release_on_stop: false,
        });

        app.update();

        let action_events: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<EngineOperationEnvelope<PlaybackOperation>>>()
            .drain()
            .collect();
        assert!(
            action_events.is_empty(),
            "expected no playback release when auto_release_on_stop is not armed"
        );
    }

    /// Verifies newly spawned clip bindings survive until InstanceIndex can observe their playback.
    #[test]
    fn sync_active_state_preserves_new_materialized_clip_before_indexing() {
        let mut app = App::new();
        app.add_message::<EngineOperationEnvelope<PlaybackOperation>>();
        app.insert_resource(InstanceIndex::default());
        app.add_systems(Update, sync_active_state_on_instance_despawn);

        let instance_id = InstanceId::new();
        app.world_mut().spawn(MaterializedClip {
            clip_id: 9,
            attached_instance: instance_id,
            auto_release_on_stop: false,
        });

        app.update();

        let remaining_routes = app
            .world_mut()
            .query::<&MaterializedClip>()
            .iter(app.world())
            .filter(|materialized_clip| materialized_clip.attached_instance == instance_id)
            .count();
        assert_eq!(
            remaining_routes, 1,
            "expected newly added MaterializedClip to survive its first cleanup frame"
        );

        app.update();

        let remaining_routes = app
            .world_mut()
            .query::<&MaterializedClip>()
            .iter(app.world())
            .filter(|materialized_clip| materialized_clip.attached_instance == instance_id)
            .count();
        assert_eq!(
            remaining_routes, 0,
            "expected stale MaterializedClip to despawn after the added frame"
        );
    }

    /// Builds an app that advances the show tempo and then the playback clocks each update.
    fn tempo_clock_app() -> App {
        let mut app = App::new();
        app.init_resource::<ShowTempo>();
        app.add_systems(
            Update,
            (
                |mut tempo: ResMut<ShowTempo>| tempo.advance(),
                advance_realtime_instance_clocks,
            )
                .chain(),
        );
        app
    }

    /// Returns the show tempo's beat counter.
    fn beat_position(app: &App) -> f64 {
        app.world().resource::<ShowTempo>().snapshot().beat_position
    }

    /// Returns the clock on `entity`.
    fn clock(app: &App, entity: Entity) -> &InstanceClock {
        app.world()
            .entity(entity)
            .get::<InstanceClock>()
            .expect("playback keeps its clock")
    }

    /// Verifies a beat-timed playback starts on the beat in progress and then advances by
    /// exactly the beats the show tempo moved, scaled by its speed.
    #[test]
    fn beat_timed_clock_follows_show_tempo_beats() {
        let mut app = tempo_clock_app();
        app.update();
        std::thread::sleep(Duration::from_millis(20));

        let playback = app
            .world_mut()
            .spawn((
                InstanceClock::default(),
                InstanceControls {
                    speed: 2.0,
                    ..Default::default()
                },
                Timebase::Beats,
            ))
            .id();
        app.update();
        let started_beat = beat_position(&app);
        let started_position = clock(&app, playback).position.as_secs_f64();
        assert_eq!(clock(&app, playback).source, InstanceClockSource::Tempo);
        assert!(
            (started_position - started_beat.fract() * 2.0).abs() < 1e-6,
            "a beat-timed playback starts at the progress of the current beat"
        );

        std::thread::sleep(Duration::from_millis(20));
        app.update();
        let moved_beats = beat_position(&app) - started_beat;
        let moved_position = clock(&app, playback).position.as_secs_f64() - started_position;
        assert!(moved_beats > 0.0);
        assert!(
            (moved_position - moved_beats * 2.0).abs() < 1e-6,
            "moved {moved_position} for {moved_beats} beats at x2"
        );
    }

    /// Verifies a playback already partway through converts its position between seconds and
    /// beats at the show tempo when its timebase changes, and swaps its clock source.
    #[test]
    fn switching_timebase_converts_position_at_show_tempo() {
        let mut app = tempo_clock_app();
        let playback = app
            .world_mut()
            .spawn((
                InstanceClock {
                    position: Duration::from_secs(3),
                    ..Default::default()
                },
                Timebase::Beats,
            ))
            .id();
        app.update();
        assert_eq!(clock(&app, playback).source, InstanceClockSource::Tempo);
        // Three seconds at the default 120 BPM is six beats.
        let beats = clock(&app, playback).position;
        assert!(beats >= Duration::from_secs(6) && beats < Duration::from_millis(6_100));

        app.world_mut()
            .entity_mut(playback)
            .insert(Timebase::Seconds);
        app.update();
        assert_eq!(clock(&app, playback).source, InstanceClockSource::Realtime);
        let seconds = clock(&app, playback).position;
        assert!(seconds >= Duration::from_secs(3) && seconds < Duration::from_millis(3_100));
    }
}
