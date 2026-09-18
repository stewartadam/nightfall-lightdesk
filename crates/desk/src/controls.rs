// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_instances::{InstanceControlUpdate, InstanceControls, InstanceId};
use serde::{Deserialize, Serialize};

use crate::{
    clips::{Clip, ClipAction, MaterializedClip},
    instances::InstanceIndex,
    masters::{Master, MasterUpdate},
};

const CONTROL_EPSILON: f32 = 0.0001;
pub const DEFAULT_CONTROL_COUNT: usize = 10;

/// Fallible user commands that mutate control assignments.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum ControlCommand {
    AssignClip { control_index: u32, clip_id: u32 },
    AssignMaster { control_index: u32, master_id: u32 },
    ClearClip { control_index: u32 },
}

impl IngressCommand for ControlCommand {}

/// High-frequency control changes that intentionally have no command lifecycle.
#[derive(Debug, Clone, Serialize, Deserialize, Message)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum ControlUpdate {
    SetConsoleValue { control_index: u32, value: f32 },
    SetHardwareValue { control_index: u32, value: f32 },
    SetExternalHardwareValue { control_index: u32, value: f32 },
}

/// Serializable snapshot of current control bank state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ControlSnapshot {
    pub index: u32,
    pub assigned_clip_id: Option<u32>,
    pub assigned_master_id: Option<u32>,
    pub hardware_value: f32,
    pub console_value: f32,
    pub display_value: f32,
    pub is_grabbed: bool,
    pub is_clip_active: bool,
    pub attached_instance_id: Option<InstanceId>,
}

/// Resource that stores control bank assignments and current levels.
#[derive(Clone, Copy, Debug, Default)]
struct ControlRuntimeState {
    console_value: f32,
    is_clip_active: bool,
    attached_instance_id: Option<InstanceId>,
}

/// One control's assignment and current level in a control bank.
#[derive(Clone, Debug, PartialEq)]
struct Control {
    assigned_clip_id: Option<u32>,
    assigned_master_id: Option<u32>,
    hardware_value: f32,
    last_console_value: f32,
    pending_console_value: Option<f32>,
    is_grabbed: bool,
    external_grab_armed: bool,
    hardware_drove_console: bool,
    pending_console_sync: bool,
    attached_instance_id: Option<InstanceId>,
}

impl Default for Control {
    fn default() -> Self {
        Self {
            assigned_clip_id: None,
            assigned_master_id: None,
            hardware_value: 0.0,
            last_console_value: 0.0,
            pending_console_value: None,
            is_grabbed: true,
            external_grab_armed: true,
            hardware_drove_console: false,
            pending_console_sync: false,
            attached_instance_id: None,
        }
    }
}

impl Control {
    fn reset_to(&mut self, console_value: f32) {
        let clamped_console_value = clamp_percent(console_value);
        self.hardware_value = clamped_console_value;
        self.last_console_value = clamped_console_value;
        self.pending_console_value = None;
        self.is_grabbed = true;
        self.external_grab_armed = true;
        self.hardware_drove_console = false;
        self.pending_console_sync = false;
    }

    fn clear(&mut self) {
        *self = Self::default();
    }

    fn display_value(&self, runtime: ControlRuntimeState) -> f32 {
        if self.is_grabbed {
            self.hardware_value
        } else {
            runtime.console_value
        }
    }

    fn sync_from_runtime(&mut self, runtime: ControlRuntimeState) -> Option<f32> {
        let console_changed = !is_same_value(runtime.console_value, self.last_console_value);
        let pending_intensity = if let Some(pending_console_value) = self.pending_console_value {
            if is_same_value(runtime.console_value, pending_console_value) {
                self.pending_console_value = None;
                None
            } else if runtime.attached_instance_id.is_some()
                && runtime.attached_instance_id != self.attached_instance_id
            {
                Some(pending_console_value / 100.0)
            } else {
                None
            }
        } else if self.pending_console_sync {
            if is_same_value(runtime.console_value, self.hardware_value) {
                self.pending_console_sync = false;
                self.hardware_drove_console = false;
                None
            } else if runtime.attached_instance_id.is_some()
                && runtime.attached_instance_id != self.attached_instance_id
            {
                self.hardware_drove_console = true;
                Some(self.hardware_value / 100.0)
            } else {
                None
            }
        } else if self.is_grabbed
            && self.hardware_drove_console
            && is_same_value(runtime.console_value, self.hardware_value)
        {
            self.hardware_drove_console = false;
            None
        } else if self.is_grabbed
            && self.external_grab_armed
            && !self.hardware_drove_console
            && console_changed
            && !is_same_value(runtime.console_value, self.hardware_value)
        {
            self.is_grabbed = false;
            self.external_grab_armed = true;
            None
        } else {
            None
        };

        self.attached_instance_id = runtime.attached_instance_id;
        self.last_console_value = runtime.console_value;
        pending_intensity
    }

    fn handle_console_value(
        &mut self,
        next_console_value: f32,
        runtime: ControlRuntimeState,
    ) -> ControlActions {
        let clamped_console_value = clamp_percent(next_console_value);

        if runtime.is_clip_active && is_same_value(clamped_console_value, runtime.console_value) {
            tracing::debug!(
                runtime_console_value = runtime.console_value,
                incoming_console_value = clamped_console_value,
                "Ignoring no-op control value"
            );
            return ControlActions::default();
        }

        self.pending_console_sync = false;
        self.hardware_drove_console = false;
        self.pending_console_value = None;
        self.is_grabbed = is_same_value(clamped_console_value, self.hardware_value);
        self.external_grab_armed = !self.is_grabbed;
        self.attached_instance_id = runtime.attached_instance_id;

        if !runtime.is_clip_active {
            if clamped_console_value > CONTROL_EPSILON {
                self.pending_console_value = Some(clamped_console_value);
                return ControlActions {
                    should_start_clip: true,
                    ..Default::default()
                };
            }

            return ControlActions::default();
        }

        if clamped_console_value <= CONTROL_EPSILON && runtime.console_value > CONTROL_EPSILON {
            return ControlActions {
                should_stop_clip: true,
                ..Default::default()
            };
        }

        if runtime.attached_instance_id.is_none() {
            self.pending_console_value = Some(clamped_console_value);
            return ControlActions::default();
        }

        if is_same_value(clamped_console_value, runtime.console_value) {
            return ControlActions::default();
        }

        ControlActions {
            intensity_value: Some(clamped_console_value / 100.0),
            ..Default::default()
        }
    }

    fn handle_hardware_value(
        &mut self,
        next_hardware_value: f32,
        runtime: ControlRuntimeState,
    ) -> ControlActions {
        let clamped_hardware_value = clamp_percent(next_hardware_value);
        let previous_hardware_value = self.hardware_value;
        self.hardware_value = clamped_hardware_value;

        if !runtime.is_clip_active {
            if clamped_hardware_value > CONTROL_EPSILON
                && !self.pending_console_sync
                && (previous_hardware_value <= CONTROL_EPSILON
                    || runtime.console_value <= CONTROL_EPSILON)
            {
                self.is_grabbed = true;
                self.pending_console_sync = runtime.attached_instance_id.is_none();
                self.attached_instance_id = runtime.attached_instance_id;
                return ControlActions {
                    should_start_clip: true,
                    ..Default::default()
                };
            }

            self.attached_instance_id = runtime.attached_instance_id;
            return ControlActions::default();
        }

        if !self.is_grabbed {
            if !crossed_console_value(
                previous_hardware_value,
                clamped_hardware_value,
                runtime.console_value,
            ) {
                self.attached_instance_id = runtime.attached_instance_id;
                return ControlActions::default();
            }

            self.is_grabbed = true;
        }

        if clamped_hardware_value <= CONTROL_EPSILON && previous_hardware_value > CONTROL_EPSILON {
            self.attached_instance_id = runtime.attached_instance_id;
            return ControlActions {
                should_stop_clip: true,
                ..Default::default()
            };
        }

        if runtime.attached_instance_id.is_none() {
            self.pending_console_sync = true;
            self.attached_instance_id = runtime.attached_instance_id;
            return ControlActions::default();
        }

        self.attached_instance_id = runtime.attached_instance_id;

        if self.pending_console_sync
            || !is_same_value(clamped_hardware_value, runtime.console_value)
        {
            self.hardware_drove_console = true;
            return ControlActions {
                intensity_value: Some(clamped_hardware_value / 100.0),
                ..Default::default()
            };
        }

        ControlActions::default()
    }

    fn handle_external_hardware_value(
        &mut self,
        next_hardware_value: f32,
        runtime: ControlRuntimeState,
    ) -> ControlActions {
        let clamped_hardware_value = clamp_percent(next_hardware_value);
        let was_grabbed = self.is_grabbed;

        if runtime.is_clip_active
            && self.is_grabbed
            && self.external_grab_armed
            && !self.pending_console_sync
            && runtime.console_value > CONTROL_EPSILON
            && is_same_value(self.hardware_value, runtime.console_value)
            && !is_same_value(clamped_hardware_value, runtime.console_value)
        {
            tracing::debug!(
                runtime_console_value = runtime.console_value,
                previous_hardware_value = self.hardware_value,
                next_hardware_value = clamped_hardware_value,
                "Control external hardware detached awaiting pickup"
            );
            self.hardware_value = clamped_hardware_value;
            self.is_grabbed = false;
            self.attached_instance_id = runtime.attached_instance_id;
            return ControlActions::default();
        }

        let actions = self.handle_hardware_value(clamped_hardware_value, runtime);
        if (!was_grabbed && self.is_grabbed)
            || (self.is_grabbed && !is_same_value(clamped_hardware_value, runtime.console_value))
        {
            self.external_grab_armed = false;
            tracing::debug!(
                runtime_console_value = runtime.console_value,
                hardware_value = clamped_hardware_value,
                "Control external grab disarmed after hardware took control"
            );
        }
        actions
    }
}

/// Action bindings emitted when a control is moved or pressed.
#[derive(Clone, Copy, Debug, Default)]
struct ControlActions {
    should_start_clip: bool,
    should_stop_clip: bool,
    intensity_value: Option<f32>,
}

/// Resource storing control slots and action assignments.
#[derive(Resource, Clone, Debug)]
pub struct Controls {
    slots: Vec<Control>,
}

impl Default for Controls {
    fn default() -> Self {
        Self {
            slots: vec![Control::default(); DEFAULT_CONTROL_COUNT],
        }
    }
}

impl Controls {
    fn slot_mut(&mut self, control_index: u32) -> Option<&mut Control> {
        let zero_based = usize::try_from(control_index.checked_sub(1)?).ok()?;
        self.slots.get_mut(zero_based)
    }

    /// Project control assignments and current playback state into ordered control snapshots.
    pub(crate) fn snapshots(
        &self,
        clips: &Query<&Clip>,
        masters: &DataProvider<Master>,
        materialized_clips: &Query<&MaterializedClip>,
        instance_index: &InstanceIndex,
        controls_query: &Query<&InstanceControls>,
    ) -> Vec<ControlSnapshot> {
        self.slots
            .iter()
            .enumerate()
            .map(|(idx, slot)| {
                let runtime = slot
                    .assigned_clip_id
                    .and_then(|clip_id| {
                        runtime_state_for_clip(
                            clip_id,
                            clips,
                            materialized_clips,
                            instance_index,
                            controls_query,
                        )
                    })
                    .or_else(|| {
                        slot.assigned_master_id
                            .and_then(|master_id| runtime_state_for_master(master_id, masters))
                    })
                    .unwrap_or_default();

                ControlSnapshot {
                    index: (idx + 1) as u32,
                    assigned_clip_id: slot.assigned_clip_id,
                    assigned_master_id: slot.assigned_master_id,
                    hardware_value: slot.hardware_value,
                    console_value: runtime.console_value,
                    display_value: slot.display_value(runtime),
                    is_grabbed: slot.is_grabbed,
                    is_clip_active: runtime.is_clip_active,
                    attached_instance_id: runtime.attached_instance_id,
                }
            })
            .collect()
    }
}

fn clamp_percent(value: f32) -> f32 {
    value.clamp(0.0, 100.0)
}

fn is_same_value(left: f32, right: f32) -> bool {
    (left - right).abs() <= CONTROL_EPSILON
}

fn crossed_console_value(
    previous_hardware_value: f32,
    hardware_value: f32,
    console_value: f32,
) -> bool {
    if is_same_value(hardware_value, console_value) {
        return true;
    }

    (previous_hardware_value < console_value && hardware_value > console_value)
        || (previous_hardware_value > console_value && hardware_value < console_value)
}

fn runtime_state_for_clip(
    clip_id: u32,
    clips: &Query<&Clip>,
    materialized_clips: &Query<&MaterializedClip>,
    instance_index: &InstanceIndex,
    controls_query: &Query<&InstanceControls>,
) -> Option<ControlRuntimeState> {
    let clip_exists = clips.iter().any(|clip| clip.identifiers.id == clip_id);
    if !clip_exists {
        return None;
    }

    let Some(materialized_clip) = materialized_clips
        .iter()
        .find(|materialized| materialized.clip_id == clip_id)
    else {
        return Some(ControlRuntimeState::default());
    };

    let Some(playback_entity) = instance_index.get(&materialized_clip.attached_instance) else {
        return Some(ControlRuntimeState::default());
    };

    let Ok(controls) = controls_query.get(playback_entity) else {
        return Some(ControlRuntimeState::default());
    };

    Some(ControlRuntimeState {
        console_value: clamp_percent(controls.intensity_scale * 100.0),
        is_clip_active: true,
        attached_instance_id: Some(materialized_clip.attached_instance),
    })
}

fn runtime_state_for_master(
    master_id: u32,
    masters: &DataProvider<Master>,
) -> Option<ControlRuntimeState> {
    let master = masters.from_id(master_id).ok()?;
    Some(ControlRuntimeState {
        console_value: master.control_position_percent(),
        is_clip_active: true,
        attached_instance_id: None,
    })
}

fn set_slot_level(slot: &mut Control, value: f32) -> f32 {
    let value = clamp_percent(value);
    slot.hardware_value = value;
    slot.last_console_value = value;
    slot.pending_console_value = None;
    slot.is_grabbed = true;
    slot.external_grab_armed = true;
    slot.hardware_drove_console = false;
    slot.pending_console_sync = false;
    value
}

fn set_master_slot_level(
    slot: &mut Control,
    master_id: u32,
    masters: &DataProvider<Master>,
    value: f32,
) -> Option<f32> {
    let kind = masters.from_id(master_id).ok()?.kind;
    let control_percent = set_slot_level(slot, value);
    Some(Master::level_percent_from_control(kind, control_percent))
}

/// Applies fallible control assignment commands and returns one terminal result per command.
pub fn handle_control_commands(
    mut events: MessageReader<CommandEnvelope<ControlCommand>>,
    mut controls: ResMut<Controls>,
    clips: Query<&Clip>,
    masters: Res<DataProvider<Master>>,
    materialized_clips: Query<&MaterializedClip>,
    instance_index: Res<InstanceIndex>,
    controls_query: Query<&InstanceControls>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let result = match &event.command {
            ControlCommand::AssignClip {
                control_index,
                clip_id,
            } => assign_clip_to_control(
                &mut controls,
                *control_index,
                *clip_id,
                &clips,
                &materialized_clips,
                &instance_index,
                &controls_query,
            ),
            ControlCommand::AssignMaster {
                control_index,
                master_id,
            } => assign_master_to_control(&mut controls, *control_index, *master_id, &masters),
            ControlCommand::ClearClip { control_index } => {
                clear_control(&mut controls, *control_index)
            }
        };
        finish_control_command(&mut responder, event.command_id, result);
    }
}

/// Assigns one clip to a control after validating both domain references.
fn assign_clip_to_control(
    controls: &mut Controls,
    control_index: u32,
    clip_id: u32,
    clips: &Query<&Clip>,
    materialized_clips: &Query<&MaterializedClip>,
    instance_index: &InstanceIndex,
    controls_query: &Query<&InstanceControls>,
) -> Result<(), CommandError> {
    let runtime = runtime_state_for_clip(
        clip_id,
        clips,
        materialized_clips,
        instance_index,
        controls_query,
    )
    .ok_or_else(|| {
        CommandError::new(
            "clip.not_found",
            format!("Cannot assign missing clip {clip_id}"),
        )
    })?;
    let slot = controls.slot_mut(control_index).ok_or_else(|| {
        CommandError::new(
            "control.not_found",
            format!("Control {control_index} does not exist"),
        )
    })?;

    slot.assigned_clip_id = Some(clip_id);
    slot.assigned_master_id = None;
    slot.reset_to(runtime.console_value);
    slot.attached_instance_id = runtime.attached_instance_id;
    Ok(())
}

/// Assigns one master to a control after validating both domain references.
fn assign_master_to_control(
    controls: &mut Controls,
    control_index: u32,
    master_id: u32,
    masters: &DataProvider<Master>,
) -> Result<(), CommandError> {
    let runtime = runtime_state_for_master(master_id, masters).ok_or_else(|| {
        CommandError::new(
            "master.not_found",
            format!("Cannot assign missing master {master_id}"),
        )
    })?;
    let slot = controls.slot_mut(control_index).ok_or_else(|| {
        CommandError::new(
            "control.not_found",
            format!("Control {control_index} does not exist"),
        )
    })?;

    slot.assigned_clip_id = None;
    slot.assigned_master_id = Some(master_id);
    slot.reset_to(runtime.console_value);
    slot.attached_instance_id = None;
    Ok(())
}

/// Clears one control assignment or reports an invalid control reference.
fn clear_control(controls: &mut Controls, control_index: u32) -> Result<(), CommandError> {
    let slot = controls.slot_mut(control_index).ok_or_else(|| {
        CommandError::new(
            "control.not_found",
            format!("Control {control_index} does not exist"),
        )
    })?;
    slot.clear();
    Ok(())
}

/// Publishes the terminal outcome for one control assignment command.
fn finish_control_command(
    responder: &mut CommandResponder,
    command_id: CommandId,
    result: Result<(), CommandError>,
) {
    let response = match result {
        Ok(()) => responder.succeed(command_id),
        Err(error) => responder.fail(command_id, error),
    };
    if let Err(error) = response {
        tracing::error!(%command_id, %error, "control_command_completion_failed");
    }
}

/// Applies continuous control changes without creating command or undo state.
pub fn handle_control_updates(
    mut events: MessageReader<ControlUpdate>,
    mut controls: ResMut<Controls>,
    clips: Query<&Clip>,
    masters: Res<DataProvider<Master>>,
    materialized_clips: Query<&MaterializedClip>,
    instance_index: Res<InstanceIndex>,
    controls_query: Query<&InstanceControls>,
    mut clip_writer: MessageWriter<EngineActionEnvelope<ClipAction>>,
    mut master_writer: MessageWriter<MasterUpdate>,
    mut playback_control_writer: MessageWriter<InstanceControlUpdate>,
) {
    for event in events.read() {
        match event {
            ControlUpdate::SetConsoleValue {
                control_index,
                value,
            } => {
                let Some(slot) = controls.slot_mut(*control_index) else {
                    tracing::warn!(
                        control_index = *control_index,
                        "Ignoring out-of-range control value"
                    );
                    continue;
                };

                if let Some(master_id) = slot.assigned_master_id {
                    let Some(level_percent) =
                        set_master_slot_level(slot, master_id, &masters, *value)
                    else {
                        slot.clear();
                        continue;
                    };
                    master_writer.write(MasterUpdate::SetLevel {
                        id: master_id,
                        level_percent,
                    });
                    continue;
                }

                let Some(clip_id) = slot.assigned_clip_id else {
                    continue;
                };

                let Some(runtime) = runtime_state_for_clip(
                    clip_id,
                    &clips,
                    &materialized_clips,
                    &instance_index,
                    &controls_query,
                ) else {
                    slot.clear();
                    continue;
                };

                let actions = slot.handle_console_value(*value, runtime);

                if actions.should_start_clip {
                    clip_writer.write(EngineActionEnvelope::detached(ClipAction::Start(
                        IdExpr::Single(clip_id),
                    )));
                }

                if actions.should_stop_clip {
                    clip_writer.write(EngineActionEnvelope::detached(ClipAction::Stop(
                        IdExpr::Single(clip_id),
                    )));
                }

                if let (Some(intensity_value), Some(instance_id)) =
                    (actions.intensity_value, runtime.attached_instance_id)
                {
                    playback_control_writer.write(InstanceControlUpdate::SetIntensityScale {
                        instance_id,
                        value: intensity_value,
                    });
                }
            }
            ControlUpdate::SetHardwareValue {
                control_index,
                value,
            } => {
                let Some(slot) = controls.slot_mut(*control_index) else {
                    tracing::warn!(
                        control_index = *control_index,
                        "Ignoring out-of-range control value"
                    );
                    continue;
                };

                if let Some(master_id) = slot.assigned_master_id {
                    let Some(level_percent) =
                        set_master_slot_level(slot, master_id, &masters, *value)
                    else {
                        slot.clear();
                        continue;
                    };
                    master_writer.write(MasterUpdate::SetLevel {
                        id: master_id,
                        level_percent,
                    });
                    continue;
                }

                let Some(clip_id) = slot.assigned_clip_id else {
                    slot.hardware_value = clamp_percent(*value);
                    continue;
                };

                let Some(runtime) = runtime_state_for_clip(
                    clip_id,
                    &clips,
                    &materialized_clips,
                    &instance_index,
                    &controls_query,
                ) else {
                    slot.clear();
                    continue;
                };

                let actions = slot.handle_hardware_value(*value, runtime);

                if actions.should_start_clip {
                    clip_writer.write(EngineActionEnvelope::detached(ClipAction::Start(
                        IdExpr::Single(clip_id),
                    )));
                }

                if actions.should_stop_clip {
                    clip_writer.write(EngineActionEnvelope::detached(ClipAction::Stop(
                        IdExpr::Single(clip_id),
                    )));
                }

                if let (Some(intensity_value), Some(instance_id)) =
                    (actions.intensity_value, runtime.attached_instance_id)
                {
                    playback_control_writer.write(InstanceControlUpdate::SetIntensityScale {
                        instance_id,
                        value: intensity_value,
                    });
                }
            }
            ControlUpdate::SetExternalHardwareValue {
                control_index,
                value,
            } => {
                let Some(slot) = controls.slot_mut(*control_index) else {
                    tracing::warn!(
                        control_index = *control_index,
                        "Ignoring out-of-range external control value"
                    );
                    continue;
                };

                if let Some(master_id) = slot.assigned_master_id {
                    let Some(level_percent) =
                        set_master_slot_level(slot, master_id, &masters, *value)
                    else {
                        slot.clear();
                        continue;
                    };
                    master_writer.write(MasterUpdate::SetLevel {
                        id: master_id,
                        level_percent,
                    });
                    continue;
                }

                let Some(clip_id) = slot.assigned_clip_id else {
                    slot.hardware_value = clamp_percent(*value);
                    slot.is_grabbed = false;
                    continue;
                };

                let Some(runtime) = runtime_state_for_clip(
                    clip_id,
                    &clips,
                    &materialized_clips,
                    &instance_index,
                    &controls_query,
                ) else {
                    slot.clear();
                    continue;
                };

                let was_grabbed = slot.is_grabbed;
                let was_external_grab_armed = slot.external_grab_armed;
                let actions = slot.handle_external_hardware_value(*value, runtime);
                tracing::debug!(
                    control_index = *control_index,
                    clip_id,
                    incoming_value = *value,
                    runtime_console_value = runtime.console_value,
                    runtime_clip_active = runtime.is_clip_active,
                    runtime_attached_instance_id = ?runtime.attached_instance_id,
                    is_grabbed_before = was_grabbed,
                    is_grabbed_after = slot.is_grabbed,
                    external_grab_armed_before = was_external_grab_armed,
                    external_grab_armed_after = slot.external_grab_armed,
                    pending_console_sync = slot.pending_console_sync,
                    hardware_drove_console = slot.hardware_drove_console,
                    action_start_clip = actions.should_start_clip,
                    action_stop_clip = actions.should_stop_clip,
                    action_intensity_value = ?actions.intensity_value,
                    "Handled external control hardware value"
                );

                if actions.should_start_clip {
                    clip_writer.write(EngineActionEnvelope::detached(ClipAction::Start(
                        IdExpr::Single(clip_id),
                    )));
                }

                if actions.should_stop_clip {
                    clip_writer.write(EngineActionEnvelope::detached(ClipAction::Stop(
                        IdExpr::Single(clip_id),
                    )));
                }

                if let (Some(intensity_value), Some(instance_id)) =
                    (actions.intensity_value, runtime.attached_instance_id)
                {
                    playback_control_writer.write(InstanceControlUpdate::SetIntensityScale {
                        instance_id,
                        value: intensity_value,
                    });
                }
            }
        }
    }
}

pub fn sync_control_state(
    mut controls: ResMut<Controls>,
    clips: Query<&Clip>,
    masters: Res<DataProvider<Master>>,
    materialized_clips: Query<&MaterializedClip>,
    instance_index: Res<InstanceIndex>,
    controls_query: Query<&InstanceControls>,
    mut playback_control_writer: MessageWriter<InstanceControlUpdate>,
) {
    let mut next_slots = controls.slots.clone();

    for slot in &mut next_slots {
        let runtime = if let Some(clip_id) = slot.assigned_clip_id {
            let Some(runtime) = runtime_state_for_clip(
                clip_id,
                &clips,
                &materialized_clips,
                &instance_index,
                &controls_query,
            ) else {
                slot.clear();
                continue;
            };
            runtime
        } else if let Some(master_id) = slot.assigned_master_id {
            let Some(runtime) = runtime_state_for_master(master_id, &masters) else {
                slot.clear();
                continue;
            };
            runtime
        } else {
            slot.attached_instance_id = None;
            continue;
        };

        let pending_intensity = slot.sync_from_runtime(runtime);
        if let (Some(intensity_value), Some(instance_id)) =
            (pending_intensity, runtime.attached_instance_id)
        {
            let target_id = slot.assigned_clip_id.or(slot.assigned_master_id);
            tracing::debug!(
                ?target_id,
                instance_id = ?instance_id,
                runtime_console_value = runtime.console_value,
                slot_hardware_value = slot.hardware_value,
                slot_is_grabbed = slot.is_grabbed,
                slot_external_grab_armed = slot.external_grab_armed,
                slot_pending_console_sync = slot.pending_console_sync,
                slot_hardware_drove_console = slot.hardware_drove_console,
                intensity_value,
                "Syncing control runtime intensity"
            );
            playback_control_writer.write(InstanceControlUpdate::SetIntensityScale {
                instance_id,
                value: intensity_value,
            });
        }
    }

    if next_slots != controls.slots {
        controls.slots = next_slots;
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};

    use super::*;

    /// Builds the focused resources needed by control command lifecycle tests.
    fn control_command_app() -> App {
        let mut app = App::new();
        app.init_resource::<Controls>();
        app.init_resource::<DataProvider<Master>>();
        app.init_resource::<InstanceIndex>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<ControlCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.add_systems(Update, handle_control_commands);
        app
    }

    /// Registers and submits one control command to the focused app.
    fn submit_control_command(app: &mut App, command: ControlCommand) -> CommandId {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let command_id = envelope.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("control command should register");
        app.world_mut().write_message(envelope);
        command_id
    }

    /// Drains the terminal result emitted for one control command.
    fn take_control_result(app: &mut App) -> CommandResult {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("control command should return a terminal result")
    }

    /// Verifies a valid assignment clear returns terminal success.
    #[test]
    fn clear_control_returns_success() {
        let mut app = control_command_app();
        let command_id =
            submit_control_command(&mut app, ControlCommand::ClearClip { control_index: 1 });

        app.update();

        let result = take_control_result(&mut app);
        assert_eq!(result.command_id, command_id);
        assert!(matches!(result.outcome, CommandOutcome::Succeeded { .. }));
    }

    /// Verifies an invalid control reference returns a stable structured failure.
    #[test]
    fn missing_control_returns_failure() {
        let mut app = control_command_app();
        submit_control_command(&mut app, ControlCommand::ClearClip { control_index: 99 });

        app.update();

        assert!(matches!(
            take_control_result(&mut app).outcome,
            CommandOutcome::Failed(error) if error.code == "control.not_found"
        ));
    }

    #[test]
    fn detached_hardware_does_not_send_intensity_until_it_crosses_console_value() {
        let mut slot = Control::default();
        slot.reset_to(50.0);

        slot.sync_from_runtime(ControlRuntimeState {
            console_value: 70.0,
            is_clip_active: true,
            attached_instance_id: Some(InstanceId::new()),
        });
        assert!(!slot.is_grabbed);
        assert_eq!(
            slot.display_value(ControlRuntimeState {
                console_value: 70.0,
                is_clip_active: true,
                attached_instance_id: Some(InstanceId::new()),
            }),
            70.0
        );

        let before_cross = slot.handle_hardware_value(
            60.0,
            ControlRuntimeState {
                console_value: 70.0,
                is_clip_active: true,
                attached_instance_id: Some(InstanceId::new()),
            },
        );
        assert_eq!(before_cross.intensity_value, None);
        assert!(!before_cross.should_start_clip);
        assert!(!before_cross.should_stop_clip);
        assert!(!slot.is_grabbed);

        let cross_through = slot.handle_hardware_value(
            72.0,
            ControlRuntimeState {
                console_value: 70.0,
                is_clip_active: true,
                attached_instance_id: Some(InstanceId::new()),
            },
        );
        assert_eq!(cross_through.intensity_value, Some(0.72));
        assert!(slot.is_grabbed);
    }

    #[test]
    fn grabbed_hardware_releases_when_console_moves_elsewhere() {
        let instance_id = InstanceId::new();
        let mut slot = Control::default();
        slot.reset_to(70.0);

        let grabbed_move = slot.handle_hardware_value(
            80.0,
            ControlRuntimeState {
                console_value: 70.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(grabbed_move.intensity_value, Some(0.8));
        assert!(slot.is_grabbed);

        slot.sync_from_runtime(ControlRuntimeState {
            console_value: 80.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(slot.is_grabbed);

        slot.sync_from_runtime(ControlRuntimeState {
            console_value: 60.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(!slot.is_grabbed);
        assert_eq!(
            slot.display_value(ControlRuntimeState {
                console_value: 60.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            }),
            60.0
        );
    }

    #[test]
    fn starting_inactive_clip_queues_console_sync_until_playback_binds() {
        let instance_id = InstanceId::new();
        let mut slot = Control::default();
        slot.reset_to(0.0);

        let start = slot.handle_hardware_value(
            20.0,
            ControlRuntimeState {
                console_value: 0.0,
                is_clip_active: false,
                attached_instance_id: None,
            },
        );
        assert!(start.should_start_clip);
        assert_eq!(start.intensity_value, None);
        assert!(slot.is_grabbed);

        let duplicate_start = slot.handle_hardware_value(
            30.0,
            ControlRuntimeState {
                console_value: 0.0,
                is_clip_active: false,
                attached_instance_id: None,
            },
        );
        assert!(!duplicate_start.should_start_clip);
        assert_eq!(duplicate_start.intensity_value, None);

        let pending = slot.sync_from_runtime(ControlRuntimeState {
            console_value: 100.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert_eq!(pending, Some(0.3));

        slot.sync_from_runtime(ControlRuntimeState {
            console_value: 30.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(slot.is_grabbed);
        assert!(!slot.pending_console_sync);
    }

    #[test]
    fn moving_to_zero_only_stops_clip_when_hardware_has_grabbed_control() {
        let instance_id = InstanceId::new();
        let mut slot = Control::default();
        slot.reset_to(20.0);

        let stop = slot.handle_hardware_value(
            0.0,
            ControlRuntimeState {
                console_value: 20.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert!(stop.should_stop_clip);
        assert_eq!(stop.intensity_value, None);

        slot.reset_to(20.0);
        slot.sync_from_runtime(ControlRuntimeState {
            console_value: 50.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(!slot.is_grabbed);

        let detached_zero = slot.handle_hardware_value(
            0.0,
            ControlRuntimeState {
                console_value: 50.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert!(!detached_zero.should_stop_clip);
        assert_eq!(detached_zero.intensity_value, None);
    }

    #[test]
    fn external_hardware_starts_detached_until_it_picks_up_console_value() {
        let instance_id = InstanceId::new();
        let mut slot = Control::default();
        slot.reset_to(80.0);

        let first_external_move = slot.handle_external_hardware_value(
            10.0,
            ControlRuntimeState {
                console_value: 80.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(first_external_move.intensity_value, None);
        assert!(!slot.is_grabbed);

        let before_pickup = slot.handle_external_hardware_value(
            60.0,
            ControlRuntimeState {
                console_value: 80.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(before_pickup.intensity_value, None);
        assert!(!slot.is_grabbed);

        let after_pickup = slot.handle_external_hardware_value(
            90.0,
            ControlRuntimeState {
                console_value: 80.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(after_pickup.intensity_value, Some(0.9));
        assert!(slot.is_grabbed);
    }

    #[test]
    fn external_hardware_from_zero_stays_grabbed_while_raising() {
        let instance_id = InstanceId::new();
        let mut slot = Control::default();
        slot.reset_to(0.0);

        let first_raise = slot.handle_external_hardware_value(
            3.0,
            ControlRuntimeState {
                console_value: 0.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(first_raise.intensity_value, Some(0.03));
        assert!(slot.is_grabbed);

        let continue_raise = slot.handle_external_hardware_value(
            25.0,
            ControlRuntimeState {
                console_value: 2.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(continue_raise.intensity_value, Some(0.25));
        assert!(slot.is_grabbed);
    }

    #[test]
    fn external_hardware_from_zero_stays_grabbed_across_runtime_bounce() {
        let instance_id = InstanceId::new();
        let mut slot = Control::default();
        slot.reset_to(0.0);

        let first_raise = slot.handle_external_hardware_value(
            1.0,
            ControlRuntimeState {
                console_value: 0.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(first_raise.intensity_value, Some(0.01));
        assert!(slot.is_grabbed);
        assert!(!slot.external_grab_armed);

        slot.sync_from_runtime(ControlRuntimeState {
            console_value: 100.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(slot.is_grabbed);
        assert!(!slot.external_grab_armed);

        slot.sync_from_runtime(ControlRuntimeState {
            console_value: 1.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(slot.is_grabbed);
        assert!(!slot.external_grab_armed);

        let continue_raise = slot.handle_external_hardware_value(
            25.0,
            ControlRuntimeState {
                console_value: 1.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(continue_raise.intensity_value, Some(0.25));
        assert!(slot.is_grabbed);
    }

    #[test]
    fn noop_console_value_does_not_release_external_grab() {
        let instance_id = InstanceId::new();
        let mut slot = Control::default();
        slot.reset_to(0.0);

        let start = slot.handle_external_hardware_value(
            1.0,
            ControlRuntimeState {
                console_value: 0.0,
                is_clip_active: false,
                attached_instance_id: None,
            },
        );
        assert!(start.should_start_clip);
        assert!(slot.is_grabbed);
        assert!(!slot.external_grab_armed);

        slot.sync_from_runtime(ControlRuntimeState {
            console_value: 1.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(slot.is_grabbed);
        assert!(!slot.external_grab_armed);

        let noop_console = slot.handle_console_value(
            1.0,
            ControlRuntimeState {
                console_value: 1.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(noop_console.intensity_value, None);
        assert!(slot.is_grabbed);
        assert!(!slot.external_grab_armed);

        let continue_raise = slot.handle_external_hardware_value(
            5.0,
            ControlRuntimeState {
                console_value: 1.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(continue_raise.intensity_value, Some(0.05));
        assert!(slot.is_grabbed);
    }

    #[test]
    fn external_hardware_grab_at_max_stays_grabbed_when_moving_back_down() {
        let instance_id = InstanceId::new();
        let mut slot = Control::default();
        slot.reset_to(100.0);

        let first_external_move = slot.handle_external_hardware_value(
            80.0,
            ControlRuntimeState {
                console_value: 100.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(first_external_move.intensity_value, None);
        assert!(!slot.is_grabbed);

        let pickup_at_max = slot.handle_external_hardware_value(
            100.0,
            ControlRuntimeState {
                console_value: 100.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(pickup_at_max.intensity_value, None);
        assert!(slot.is_grabbed);
        assert!(!slot.external_grab_armed);

        let move_down_after_pickup = slot.handle_external_hardware_value(
            95.0,
            ControlRuntimeState {
                console_value: 100.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(move_down_after_pickup.intensity_value, Some(0.95));
        assert!(slot.is_grabbed);
    }

    #[test]
    fn grabbed_hardware_stays_grabbed_while_console_catches_up() {
        let instance_id = InstanceId::new();
        let mut slot = Control::default();
        slot.reset_to(100.0);

        let first_external_move = slot.handle_external_hardware_value(
            80.0,
            ControlRuntimeState {
                console_value: 100.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(first_external_move.intensity_value, None);
        assert!(!slot.is_grabbed);

        let pickup_at_max = slot.handle_external_hardware_value(
            100.0,
            ControlRuntimeState {
                console_value: 100.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(pickup_at_max.intensity_value, None);
        assert!(slot.is_grabbed);

        let drive_down = slot.handle_external_hardware_value(
            96.0,
            ControlRuntimeState {
                console_value: 100.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(drive_down.intensity_value, Some(0.96));
        assert!(slot.is_grabbed);

        slot.sync_from_runtime(ControlRuntimeState {
            console_value: 99.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(slot.is_grabbed);

        slot.sync_from_runtime(ControlRuntimeState {
            console_value: 98.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(slot.is_grabbed);

        slot.sync_from_runtime(ControlRuntimeState {
            console_value: 96.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(slot.is_grabbed);
        assert!(!slot.hardware_drove_console);
    }

    #[test]
    fn external_hardware_grab_ignores_runtime_drift_until_console_input_releases_it() {
        let instance_id = InstanceId::new();
        let mut slot = Control::default();
        slot.reset_to(80.0);

        let detach = slot.handle_external_hardware_value(
            10.0,
            ControlRuntimeState {
                console_value: 80.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(detach.intensity_value, None);
        assert!(!slot.is_grabbed);

        let grab = slot.handle_external_hardware_value(
            90.0,
            ControlRuntimeState {
                console_value: 80.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(grab.intensity_value, Some(0.9));
        assert!(slot.is_grabbed);
        assert!(!slot.external_grab_armed);

        slot.sync_from_runtime(ControlRuntimeState {
            console_value: 90.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(slot.is_grabbed);
        assert!(!slot.hardware_drove_console);

        slot.sync_from_runtime(ControlRuntimeState {
            console_value: 25.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(slot.is_grabbed);
        assert!(!slot.external_grab_armed);
    }

    #[test]
    fn console_value_change_releases_grab_and_requires_external_pickup_again() {
        let instance_id = InstanceId::new();
        let mut slot = Control::default();
        slot.reset_to(80.0);

        let console_move = slot.handle_console_value(
            40.0,
            ControlRuntimeState {
                console_value: 80.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(console_move.intensity_value, Some(0.4));
        assert!(!slot.is_grabbed);
        assert!(slot.external_grab_armed);

        let hardware_move_without_pickup = slot.handle_external_hardware_value(
            75.0,
            ControlRuntimeState {
                console_value: 40.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(hardware_move_without_pickup.intensity_value, None);
        assert!(!slot.is_grabbed);

        let hardware_pickup = slot.handle_external_hardware_value(
            39.0,
            ControlRuntimeState {
                console_value: 40.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(hardware_pickup.intensity_value, Some(0.39));
        assert!(slot.is_grabbed);
    }
}
