// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Samples automation and sends clip-rate changes through the shared playback action path.
pub fn process_parameters_system(
    mut timeline_query: Query<(Entity, &mut MaterializedTimeline)>,
    timecode_query: Query<(Entity, &TimecodeGenerator)>,
    global_vars: ResMut<GlobalVariables>,
    clip_lookup: ClipLookup,
    materialized_clips: Query<&MaterializedClip>,
    mut clip_actions: MessageWriter<EngineActionEnvelope<ClipAction>>,
    mut origins: ResMut<TimelineCommandOrigins>,
    mut applied_rate_targets: Local<HashMap<Uuid, Uuid>>,
) {
    let clip_snapshot = clip_lookup.snapshot();
    // Preserve shared targets until their last populated lane is removed, including while paused.
    let retained_targets: std::collections::HashSet<_> = timeline_query
        .iter()
        .flat_map(|(_, timeline)| &timeline.timeline.tracks)
        .flat_map(|track| &track.automation_lanes)
        .filter(|lane| !lane.points.is_empty())
        .filter_map(|lane| match lane.parameter_type {
            ParameterType::RateMaster(uid) => Some(uid),
            ParameterType::GlobalVariable(_) => None,
        })
        .collect();
    applied_rate_targets.retain(|uid, timecode_uid| {
        if retained_targets.contains(uid) {
            return true;
        }
        // Defer release until resume so pause restoration cannot overwrite the reset action.
        if timecode_query.iter().any(|(_, timecode)| {
            timecode.timecode.identifiers.uid == *timecode_uid && !timecode.state.is_active
        }) {
            return true;
        }
        apply_rate_master_value(
            *uid,
            1.0,
            &clip_snapshot,
            &materialized_clips,
            &mut clip_actions,
            &mut origins,
        );
        false
    });
    // Create a map of timecode UIDs to their current times for quick lookup
    let mut timecode_times = std::collections::HashMap::new();

    for (_, timecode) in timecode_query.iter() {
        if timecode.state.is_active {
            timecode_times.insert(
                timecode.timecode.identifiers.uid,
                timecode.state.current_time,
            );
        }
    }

    // Process each timeline
    for (_, mut timeline) in timeline_query.iter_mut() {
        // Skip inactive timelines
        if !timeline.is_active {
            continue;
        }

        // Get the current timecode time for this timeline
        let timecode_time = match timecode_times.get(&timeline.timeline.timecode_uid) {
            Some(time) => *time,
            None => continue, // Skip if no timecode found
        };

        // Calculate the timeline position
        let timeline_position = timeline.get_playback_position(timecode_time);

        // Process parameters to find changed values
        let changed_parameters = timeline.process_parameters(timeline_position);

        // Apply parameter changes to the appropriate target
        for track in &timeline.timeline.tracks {
            for param in &track.automation_lanes {
                let param_key = (track.id.clone(), param.id.clone());
                if let Some(value) = changed_parameters.get(&param_key) {
                    match &param.parameter_type {
                        ParameterType::GlobalVariable(var_id) => {
                            // Update global variable value
                            tracing::trace!("Setting global variable {} to {}", var_id, value);
                            global_vars.set(var_id, VariableValue::Float(*value));
                        }
                        ParameterType::RateMaster(clip_uid) => {
                            applied_rate_targets.insert(*clip_uid, timeline.timeline.timecode_uid);
                            apply_rate_master_value(
                                *clip_uid,
                                *value,
                                &clip_snapshot,
                                &materialized_clips,
                                &mut clip_actions,
                                &mut origins,
                            );
                        }
                    }
                }
            }
        }
    }
}

/// Uses the same SetRate action as authored timeline actions and manual clip controls.
fn apply_rate_master_value(
    clip_uid: Uuid,
    value: f32,
    clip_lookup: &ClipLookupSnapshot,
    materialized_clips: &Query<&MaterializedClip>,
    clip_actions: &mut MessageWriter<EngineActionEnvelope<ClipAction>>,
    origins: &mut TimelineCommandOrigins,
) {
    let Ok((_, clip)) = clip_lookup.by_uid(clip_uid) else {
        tracing::warn!(
            clip_uid = %clip_uid,
            "Timeline rate master target clip not found"
        );
        return;
    };
    if materialized_clips
        .iter()
        .any(|playback| playback.clip_id == clip.identifiers.id)
    {
        write_timeline_clip_action(
            clip_actions,
            origins,
            ClipAction::SetRate {
                clip_id: IdExpr::Single(clip.identifiers.id),
                rate: value,
            },
        );
    }
}
