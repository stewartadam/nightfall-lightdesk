// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

pub fn process_parameters_system(
    mut timeline_query: Query<(Entity, &mut MaterializedTimeline)>,
    timecode_query: Query<(Entity, &TimecodeGenerator)>,
    global_vars: ResMut<GlobalVariables>,
    clip_lookup: ClipLookup,
    materialized_clips: Query<&MaterializedClip>,
    mut instance_controls: Query<(&InstanceId, &mut InstanceControls)>,
) {
    let clip_snapshot = clip_lookup.snapshot();
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
                        ParameterType::RateMaster(_clip_uid) => {
                            apply_rate_master_value(
                                *_clip_uid,
                                *value,
                                &clip_snapshot,
                                &materialized_clips,
                                &mut instance_controls,
                            );
                        }
                    }
                }
            }
        }
    }
}

/// Applies a normalized timeline rate-master value to the clip's attached playback.
fn apply_rate_master_value(
    clip_uid: Uuid,
    value: f32,
    clip_lookup: &ClipLookupSnapshot,
    materialized_clips: &Query<&MaterializedClip>,
    instance_controls: &mut Query<(&InstanceId, &mut InstanceControls)>,
) {
    let Ok((_, clip)) = clip_lookup.by_uid(clip_uid) else {
        tracing::warn!(
            clip_uid = %clip_uid,
            "Timeline rate master target clip not found"
        );
        return;
    };
    let rate = value.max(0.0);
    let mut applied = false;
    for materialized_clip in materialized_clips.iter() {
        if materialized_clip.clip_id != clip.identifiers.id {
            continue;
        }
        for (instance_id, mut controls) in instance_controls.iter_mut() {
            if *instance_id == materialized_clip.attached_instance {
                controls.rate = rate;
                applied = true;
            }
        }
    }

    if !applied {
        tracing::trace!(
            clip_uid = %clip_uid,
            clip_id = clip.identifiers.id,
            "Timeline rate master target has no attached playback"
        );
    }
}
