// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Reindex beat markers and mark downbeats using the selected meter and phase.
pub(super) fn with_downbeat_markers(
    markers: &[BeatMarker],
    beats_per_bar: u8,
    downbeat_offset: u8,
) -> Vec<BeatMarker> {
    let beats_per_bar = beats_per_bar.max(1);
    let downbeat_offset = downbeat_offset % beats_per_bar;
    let beat_index_shift = (beats_per_bar - downbeat_offset) % beats_per_bar;
    markers
        .iter()
        .enumerate()
        .map(|(index, marker)| BeatMarker {
            beat_index: u32::try_from(index.saturating_add(usize::from(beat_index_shift)))
                .unwrap_or(u32::MAX),
            is_downbeat: index % usize::from(beats_per_bar) == usize::from(downbeat_offset),
            ..marker.clone()
        })
        .collect()
}

/// Convert signed nanoseconds to a non-negative duration when representable.
pub(super) fn nanos_to_duration(nanos: i128) -> Option<Duration> {
    if nanos <= 0 {
        return Some(Duration::ZERO);
    }

    let secs = u64::try_from(nanos / 1_000_000_000).ok()?;
    let sub_nanos = u32::try_from(nanos % 1_000_000_000).ok()?;
    Some(Duration::new(secs, sub_nanos))
}

/// Re-space detected markers at the accepted blended tempo while preserving metadata.
pub(super) fn markers_from_blended_bpm(markers: &[BeatMarker], bpm: f32) -> Vec<BeatMarker> {
    if markers.is_empty() || !bpm.is_finite() || bpm <= f32::EPSILON {
        return markers.to_vec();
    }

    let period_nanos = ((60.0_f64 / f64::from(bpm)) * 1_000_000_000.0).round() as i128;
    if period_nanos <= 0 {
        return markers.to_vec();
    }

    let first_nanos = duration_nanos(markers[0].time);
    markers
        .iter()
        .enumerate()
        .map(|(index, marker)| {
            let index_nanos = i128::try_from(index).unwrap_or(i128::MAX);
            let target_nanos = first_nanos.saturating_add(period_nanos.saturating_mul(index_nanos));
            let blended_time = nanos_to_duration(target_nanos).unwrap_or(marker.time);
            BeatMarker {
                time: blended_time,
                beat_index: index as u32,
                ..marker.clone()
            }
        })
        .collect()
}

/// Clamp an accepted beat-grid tempo to the supported timeline range.
pub(super) fn applied_beatgrid_bpm(bpm: f32) -> f32 {
    if bpm.is_nan() {
        return 1.0;
    }

    bpm.clamp(1.0, 300.0)
}

/// Represent a duration as signed nanoseconds for checked marker arithmetic.
pub(super) fn duration_nanos(duration: Duration) -> i128 {
    i128::from(duration.as_secs()) * 1_000_000_000 + i128::from(duration.subsec_nanos())
}

/// Apply a signed nanosecond offset without overflowing the duration range.
pub(super) fn apply_nanos_delta(duration: Duration, delta_nanos: i128) -> Option<Duration> {
    if delta_nanos >= 0 {
        let offset = u64::try_from(delta_nanos).ok()?;
        duration.checked_add(Duration::from_nanos(offset))
    } else {
        let offset = u64::try_from(-delta_nanos).ok()?;
        duration.checked_sub(Duration::from_nanos(offset))
    }
}

/// Apply a millisecond nudge while clamping negative results to the timeline start.
pub(super) fn apply_millis_delta_clamped(duration: Duration, delta_ms: i32) -> Duration {
    if delta_ms >= 0 {
        duration
            .checked_add(Duration::from_millis(delta_ms as u64))
            .unwrap_or(Duration::MAX)
    } else {
        duration
            .checked_sub(Duration::from_millis(delta_ms.unsigned_abs() as u64))
            .unwrap_or(Duration::ZERO)
    }
}

/// Move a bounded region by milliseconds while preserving its original span.
pub(super) fn apply_millis_delta_preserve_span(
    start: Duration,
    end: Duration,
    delta_ms: i32,
) -> (Duration, Duration) {
    let duration = end.checked_sub(start).unwrap_or(Duration::ZERO);
    let new_start = apply_millis_delta_clamped(start, delta_ms);
    let new_end = new_start.checked_add(duration).unwrap_or(Duration::MAX);
    (new_start, new_end)
}

/// Handle beat-grid detection, proposal, and manual alignment commands.
pub(super) fn handle_command(
    context: &mut TimelineMutationContext<'_, '_>,
    event: &CommandEnvelope<TimelineCommand>,
) {
    let TimelineMutationContext {
        timelines,
        timeline_data_provider,
        beatgrid_runtime,
        broadcaster,
        responder,
        ..
    } = context;

    for event in std::iter::once(event) {
        match &event.command {
            TimelineCommand::RequestBeatgridDetection { timeline_id } => {
                let timeline = match timeline_data_provider.from_id(*timeline_id) {
                    Ok(timeline_ref) => (*timeline_ref).clone(),
                    Err(error) => {
                        tracing::warn!(
                            "Failed to request beatgrid detection for timeline {}: {}",
                            timeline_id,
                            error
                        );
                        fail_timeline_command(
                            responder,
                            event.command_id,
                            format!(
                                "Failed to request beatgrid detection for timeline {}: {}",
                                timeline_id, error
                            ),
                        );
                        continue;
                    }
                };

                crate::beatgrid_detection::request_detection_for_timeline(
                    beatgrid_runtime,
                    broadcaster,
                    &timeline,
                    crate::beatgrid_detection::BeatgridDetectionTrigger::Manual,
                );
                succeed_timeline_command(responder, event.command_id);
            }

            TimelineCommand::ApplyBeatgridProposal {
                timeline_id,
                request_id,
                beats_per_bar,
                downbeat_offset,
            } => {
                let mut timeline = match timeline_data_provider.from_id(*timeline_id) {
                    Ok(timeline_ref) => (*timeline_ref).clone(),
                    Err(error) => {
                        tracing::warn!(
                            "Failed to apply beatgrid proposal {} for timeline {}: {}",
                            request_id,
                            timeline_id,
                            error
                        );
                        fail_timeline_command(
                            responder,
                            event.command_id,
                            format!(
                                "Failed to apply beatgrid proposal {} for timeline {}: {}",
                                request_id, timeline_id, error
                            ),
                        );
                        continue;
                    }
                };

                let proposal = match crate::beatgrid_detection::get_proposal_for_timeline(
                    beatgrid_runtime,
                    timeline.identifiers.uid,
                    *request_id,
                ) {
                    Some(proposal) => proposal,
                    None => {
                        tracing::warn!(
                            "No beatgrid proposal {} found for timeline {}",
                            request_id,
                            timeline_id
                        );
                        fail_timeline_command(
                            responder,
                            event.command_id,
                            format!(
                                "No beatgrid proposal {} found for timeline {}",
                                request_id, timeline_id
                            ),
                        );
                        continue;
                    }
                };

                let applied_beats_per_bar = beats_per_bar.unwrap_or(proposal.beats_per_bar).max(1);
                let applied_downbeat_offset = downbeat_offset.unwrap_or(0);
                let source_markers = markers_from_blended_bpm(&proposal.markers, proposal.bpm);
                let markers = with_downbeat_markers(
                    &source_markers,
                    applied_beats_per_bar,
                    applied_downbeat_offset,
                );
                let persisted_markers = markers.first().cloned().into_iter().collect::<Vec<_>>();
                let applied_bpm = applied_beatgrid_bpm(proposal.bpm);
                timeline.use_beat_grid = true;
                timeline.bpm = applied_bpm;
                timeline.beats_per_bar = applied_beats_per_bar;
                timeline.beatgrid = Some(BeatgridData {
                    source: proposal.source,
                    audio_fingerprint: proposal.audio_fingerprint.clone(),
                    bpm: applied_bpm,
                    beats_per_bar: applied_beats_per_bar,
                    markers: persisted_markers,
                    confidence: proposal.confidence,
                });

                if let Err(error) = timeline_data_provider.add(timeline.clone()) {
                    tracing::warn!(
                        "Failed to persist beatgrid proposal {} for timeline {}: {}",
                        request_id,
                        timeline_id,
                        error
                    );
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!(
                            "Failed to persist beatgrid proposal {} for timeline {}: {}",
                            request_id, timeline_id, error
                        ),
                    );
                    continue;
                }

                for (_, mut materialized_timeline) in timelines
                    .iter_mut()
                    .filter(|(_, mtimeline)| mtimeline.timeline.identifiers.id == *timeline_id)
                {
                    materialized_timeline.timeline = timeline.clone();
                }

                let _ = crate::beatgrid_detection::take_proposal_for_timeline(
                    beatgrid_runtime,
                    timeline.identifiers.uid,
                    *request_id,
                );
                succeed_timeline_command(responder, event.command_id);
            }

            TimelineCommand::RejectBeatgridProposal {
                timeline_id,
                request_id,
            } => {
                let timeline_uid = match timeline_data_provider.from_id(*timeline_id) {
                    Ok(timeline_ref) => timeline_ref.identifiers.uid,
                    Err(error) => {
                        tracing::warn!(
                            "Failed to reject beatgrid proposal {} for timeline {}: {}",
                            request_id,
                            timeline_id,
                            error
                        );
                        fail_timeline_command(
                            responder,
                            event.command_id,
                            format!(
                                "Failed to reject beatgrid proposal {} for timeline {}: {}",
                                request_id, timeline_id, error
                            ),
                        );
                        continue;
                    }
                };
                if crate::beatgrid_detection::take_proposal_for_timeline(
                    beatgrid_runtime,
                    timeline_uid,
                    *request_id,
                )
                .is_none()
                {
                    tracing::warn!(
                        "No beatgrid proposal {} found for timeline {}",
                        request_id,
                        timeline_id
                    );
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!(
                            "No beatgrid proposal {} found for timeline {}",
                            request_id, timeline_id
                        ),
                    );
                } else {
                    succeed_timeline_command(responder, event.command_id);
                }
            }

            TimelineCommand::SetBeatgridStart {
                timeline_id,
                audio_fingerprint,
                first_marker_time,
            } => {
                let mut timeline = match timeline_data_provider.from_id(*timeline_id) {
                    Ok(timeline_ref) => (*timeline_ref).clone(),
                    Err(error) => {
                        tracing::warn!(
                            "Failed to set beatgrid start for timeline {}: {}",
                            timeline_id,
                            error
                        );
                        fail_timeline_command(
                            responder,
                            event.command_id,
                            format!("Timeline {timeline_id} was not found: {error}"),
                        );
                        continue;
                    }
                };

                let mut beatgrid = timeline.beatgrid.clone().unwrap_or_else(|| BeatgridData {
                    source: BeatgridSource::Manual,
                    audio_fingerprint: audio_fingerprint.clone(),
                    bpm: timeline.bpm,
                    beats_per_bar: timeline.beats_per_bar.max(1),
                    markers: vec![BeatMarker {
                        time: *first_marker_time,
                        beat_index: 0,
                        is_downbeat: true,
                        confidence: None,
                    }],
                    confidence: 0.0,
                });

                if beatgrid.audio_fingerprint != *audio_fingerprint {
                    tracing::warn!(
                        "Failed to set beatgrid start for timeline {}: audio fingerprint mismatch",
                        timeline_id
                    );
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!("Timeline {timeline_id} has a different audio fingerprint"),
                    );
                    continue;
                }

                let Some(current_first_marker) = beatgrid.markers.first() else {
                    beatgrid.markers = vec![BeatMarker {
                        time: *first_marker_time,
                        beat_index: 0,
                        is_downbeat: true,
                        confidence: None,
                    }];
                    timeline.beatgrid = Some(beatgrid);

                    if let Err(error) = timeline_data_provider.add(timeline.clone()) {
                        tracing::warn!(
                            "Failed to persist beatgrid start for timeline {}: {}",
                            timeline_id,
                            error
                        );
                        fail_timeline_command(
                            responder,
                            event.command_id,
                            format!(
                                "Failed to persist beatgrid start for timeline {timeline_id}: {error}"
                            ),
                        );
                        continue;
                    }

                    for (_, mut materialized_timeline) in timelines
                        .iter_mut()
                        .filter(|(_, mtimeline)| mtimeline.timeline.identifiers.id == *timeline_id)
                    {
                        materialized_timeline.timeline = timeline.clone();
                    }
                    succeed_timeline_command(responder, event.command_id);
                    continue;
                };

                let delta_nanos =
                    duration_nanos(*first_marker_time) - duration_nanos(current_first_marker.time);
                let mut shifted_markers = Vec::with_capacity(beatgrid.markers.len());

                let mut shift_failed = false;
                for marker in &beatgrid.markers {
                    let Some(shifted_time) = apply_nanos_delta(marker.time, delta_nanos) else {
                        shift_failed = true;
                        break;
                    };
                    shifted_markers.push(BeatMarker {
                        time: shifted_time,
                        ..marker.clone()
                    });
                }

                if shift_failed {
                    tracing::warn!(
                        "Failed to set beatgrid start for timeline {}: resulting marker time underflow/overflow",
                        timeline_id
                    );
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!(
                            "Beatgrid shift for timeline {timeline_id} exceeds the supported time range"
                        ),
                    );
                    continue;
                }

                beatgrid.markers = shifted_markers;
                timeline.beatgrid = Some(beatgrid);

                if let Err(error) = timeline_data_provider.add(timeline.clone()) {
                    tracing::warn!(
                        "Failed to persist beatgrid start for timeline {}: {}",
                        timeline_id,
                        error
                    );
                    fail_timeline_command(
                        responder,
                        event.command_id,
                        format!(
                            "Failed to persist beatgrid start for timeline {timeline_id}: {error}"
                        ),
                    );
                    continue;
                }

                for (_, mut materialized_timeline) in timelines
                    .iter_mut()
                    .filter(|(_, mtimeline)| mtimeline.timeline.identifiers.id == *timeline_id)
                {
                    materialized_timeline.timeline = timeline.clone();
                }
                succeed_timeline_command(responder, event.command_id);
            }

            _ => return,
        }
    }
}
