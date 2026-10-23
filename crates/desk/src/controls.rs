// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::{prelude::*, system::SystemParam};
use nightfall::prelude::*;
use nightfall_clips::{InstanceIndex, Source};
use nightfall_engine::prelude::*;
use nightfall_instances::{InstanceControlUpdate, InstanceControls, InstanceId};
use serde::{Deserialize, Serialize};

use crate::{
    clips::{Clip, ClipCommand, ClipOperation, MaterializedClip},
    masters::{Master, MasterCommand, MasterMode, MasterUpdate},
};

mod held_buttons;

pub use held_buttons::{HeldButtonEffect, HeldButtonEffects, resolve_held_button_effects};

const CONTROL_EPSILON: f32 = 0.0001;
pub const DEFAULT_CONTROL_COUNT: usize = 10;

/// Fallible user commands that mutate control assignments.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum ControlCommand {
    AssignClip {
        control_index: u32,
        clip_id: u32,
    },
    AssignMaster {
        control_index: u32,
        master_id: u32,
    },
    ClearClip {
        control_index: u32,
    },
    /// Runs the control's Go behavior for its current assignment.
    ///
    /// Sequence clips start or advance, other clips start when inactive, and toggle-mode
    /// masters toggle. Expanded into the concrete clip or master command before dispatch.
    Go {
        control_index: u32,
    },
    /// Sets what pressing the control's button does.
    ///
    /// Fails when the mode does not apply to the control's current assignment.
    SetButtonMode {
        control_index: u32,
        mode: ControlButtonMode,
    },
    /// Presses the control's button, running its button mode for the current assignment.
    ///
    /// Expanded into the concrete clip or master command before dispatch, like `Go`.
    PressButton {
        control_index: u32,
    },
    /// Releases the control's button.
    ///
    /// Ends a Flash or Swop once every surface holding it has let go; other modes act on
    /// the press only, so their releases complete without effect.
    ReleaseButton {
        control_index: u32,
    },
    /// Lets go of every held Flash and Swop, whoever holds it, such as a press left on by a
    /// controller that never sent its release.
    ReleaseHeldButtons,
}

impl IngressCommand for ControlCommand {}

/// What pressing a control slot's button does, saved with the slot.
///
/// The mode belongs to the slot rather than to each controller binding, so the on-screen
/// button, a bound MIDI pad and a board showing the slot always behave the same.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum ControlButtonMode {
    /// Starts or advances the clip, or toggles a toggle-mode master.
    #[default]
    Go,
    /// Steps a running sequence clip back one cue.
    GoBack,
    /// While held, plays the clip at full intensity whatever its fader says, starting it if
    /// idle, or pushes a master to full. Letting go restores the fader level and stops a clip
    /// the flash started.
    Flash,
    /// Flash that also takes the intensity of every other playback to zero while held.
    Swop,
    /// Starts an idle clip and stops a running one, or toggles a toggle-mode master.
    Toggle,
    /// Stops a running clip.
    Release,
}

impl ControlButtonMode {
    /// Every mode, in the order the mode picker lists them.
    pub const ALL: [Self; 6] = [
        Self::Go,
        Self::GoBack,
        Self::Flash,
        Self::Swop,
        Self::Toggle,
        Self::Release,
    ];

    /// Returns whether this mode does something for a slot holding `assignment`.
    ///
    /// Clips support every mode. Masters have no cues to step back through, no playback to
    /// release and no playback to solo, so they offer Go, Flash and Toggle. An empty slot
    /// accepts any mode, which is kept until something is assigned.
    pub fn supports(self, assignment: Option<&ControlAssignment>) -> bool {
        match assignment {
            None | Some(ControlAssignment::Clip(_)) => true,
            Some(ControlAssignment::Master(_)) => {
                matches!(self, Self::Go | Self::Flash | Self::Toggle)
            }
        }
    }

    /// Returns whether the mode acts while the button is held and ends on release.
    pub fn is_held(self) -> bool {
        matches!(self, Self::Flash | Self::Swop)
    }

    /// Lists the modes a slot holding `assignment` can use, in picker order.
    pub fn available_for(assignment: Option<&ControlAssignment>) -> Vec<Self> {
        Self::ALL
            .into_iter()
            .filter(|mode| mode.supports(assignment))
            .collect()
    }
}

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
    /// Position last reported by the slot's physical fader, or `None` when no physical fader
    /// has driven the slot.
    pub hardware_value: Option<f32>,
    pub console_value: f32,
    pub display_value: f32,
    pub is_grabbed: bool,
    pub is_clip_active: bool,
    pub attached_instance_id: Option<InstanceId>,
    /// What pressing the slot's button does.
    pub button_mode: ControlButtonMode,
    /// Modes the slot's current assignment supports, in picker order.
    pub available_button_modes: Vec<ControlButtonMode>,
    /// Whether the slot's Flash or Swop button is held down.
    pub is_flashing: bool,
    /// How a held Flash or Swop, on this slot or another, changes the slot's playback.
    pub held_button: Option<HeldButtonEffect>,
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
    button_mode: ControlButtonMode,
    /// Whether a physical fader has reported a position for this slot since startup.
    has_hardware: bool,
    /// Flash or Swop currently held on the slot's button.
    flash: Option<SlotFlash>,
}

/// Who holds a slot's button down, so each release ends only its own press and a client
/// that disconnects lets go of everything it held.
#[derive(Clone, Debug, PartialEq, Eq)]
enum ButtonHolder {
    /// A connected client session, such as a web UI tab.
    Client(ClientId),
    /// Any other surface, such as a MIDI pad, identified by its command origin.
    Surface(CommandOrigin),
}

/// A Flash or Swop held on a slot's button, and what letting go must undo.
#[derive(Clone, Debug, PartialEq)]
struct SlotFlash {
    /// The assignment the flash acts on; reassigning the slot ends the flash.
    target: ControlAssignment,
    /// Whether the press was a Swop, which also mutes every other playback.
    swop: bool,
    /// Every press still held, one entry per press.
    holders: Vec<ButtonHolder>,
    /// Whether the flash started an idle clip, which letting go stops again.
    started_clip: bool,
    /// Master control position captured at the press, restored when letting go.
    restore_master_position: Option<f32>,
}

impl SlotFlash {
    /// Builds a flash of `target` pressed by `holder` in `mode` that has not changed any
    /// output yet.
    fn new(target: ControlAssignment, mode: ControlButtonMode, holder: ButtonHolder) -> Self {
        Self {
            target,
            swop: mode == ControlButtonMode::Swop,
            holders: vec![holder],
            started_clip: false,
            restore_master_position: None,
        }
    }

    /// Returns whether the slot still holds the flashed target in the pressed mode.
    fn fits(&self, slot: &Control) -> bool {
        let pressed_mode = if self.swop {
            ControlButtonMode::Swop
        } else {
            ControlButtonMode::Flash
        };
        slot.button_mode == pressed_mode && slot.assignment().as_ref() == Some(&self.target)
    }

    /// Returns whether the flash should keep going: someone still holds a press and the slot
    /// still [fits](Self::fits) it.
    fn still_held_on(&self, slot: &Control) -> bool {
        !self.holders.is_empty() && self.fits(slot)
    }
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
            button_mode: ControlButtonMode::default(),
            has_hardware: false,
            flash: None,
        }
    }
}

impl Control {
    /// Returns the slot's persisted target, or `None` for an empty slot.
    fn assignment(&self) -> Option<ControlAssignment> {
        self.assigned_clip_id
            .map(ControlAssignment::Clip)
            .or_else(|| self.assigned_master_id.map(ControlAssignment::Master))
    }

    /// Falls back to Go when the button mode does not apply to the slot's new assignment.
    fn fit_button_mode_to_assignment(&mut self) {
        if !self.button_mode.supports(self.assignment().as_ref()) {
            self.button_mode = ControlButtonMode::Go;
        }
    }

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

    /// Empties the slot and resets its levels, keeping the button mode and whether a physical
    /// fader drives it, since both belong to the slot rather than to its assignment. A held
    /// flash is kept too, so [`end_released_flashes`] can still undo what it did.
    fn clear(&mut self) {
        *self = Self {
            button_mode: self.button_mode,
            has_hardware: self.has_hardware,
            flash: self.flash.take(),
            ..Self::default()
        };
    }

    /// Returns the level (percent) the slot is still driving its clip's playback toward, or
    /// `None` once the playback has taken it.
    ///
    /// A clip started from a fader binds playback at full intensity before the fader's level
    /// is applied, so the console briefly reads 100%; feedback shows this level instead.
    fn settling_level(&self) -> Option<f32> {
        self.pending_console_value
            .or(self.pending_console_sync.then_some(self.hardware_value))
    }

    /// Returns the level the slot's on-screen fader shows: the console level, unless a physical
    /// fader holds the slot, in which case the physical position until it is picked up.
    fn display_value(&self, runtime: ControlRuntimeState) -> f32 {
        if self.has_hardware && self.is_grabbed {
            self.hardware_value
        } else {
            // A level queued for an instance that is still starting is what the fader will
            // settle on, so show it rather than the new instance's default full level.
            self.pending_console_value.unwrap_or(runtime.console_value)
        }
    }

    fn sync_from_runtime(&mut self, runtime: ControlRuntimeState) -> Option<f32> {
        let console_changed = !is_same_value(runtime.console_value, self.last_console_value);
        let pending_intensity = if let Some(pending_console_value) = self.pending_console_value {
            // An idle clip reads zero, which must not settle a zero level queued for the
            // instance a Flash is about to start.
            if runtime.is_clip_active && is_same_value(runtime.console_value, pending_console_value)
            {
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
        // An on-screen move never claims the console for this slot's hardware, so another
        // slot or source moving the same target must still release it to follow the console.
        self.external_grab_armed = true;
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

/// Persisted target assigned to a desk fader, independent of playback state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ControlAssignment {
    /// Playable clip identifier.
    Clip(u32),
    /// Master identifier.
    Master(u32),
}

/// Persisted configuration of one control slot, independent of playback and hardware state.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlSlotConfig {
    /// Target assigned to the slot's fader and button, if any.
    pub assignment: Option<ControlAssignment>,
    /// What pressing the slot's button does.
    #[serde(default)]
    pub button_mode: ControlButtonMode,
}

impl ControlSlotConfig {
    /// Builds a slot configuration with the default Go button.
    pub fn assigned(assignment: ControlAssignment) -> Self {
        Self {
            assignment: Some(assignment),
            button_mode: ControlButtonMode::default(),
        }
    }
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
    /// Copy each slot's configuration in fader order without transient playback or hardware state.
    pub fn slot_configs(&self) -> Vec<ControlSlotConfig> {
        self.slots
            .iter()
            .map(|slot| ControlSlotConfig {
                assignment: slot.assignment(),
                button_mode: slot.button_mode,
            })
            .collect()
    }

    /// Restore ordered slot configurations into a fresh bank, leaving unused faders unassigned.
    ///
    /// A button mode that does not fit its slot's assignment falls back to Go.
    pub fn from_slot_configs(configs: &[ControlSlotConfig]) -> Self {
        let mut controls = Self::default();
        controls
            .slots
            .resize(configs.len().max(DEFAULT_CONTROL_COUNT), Control::default());
        for (slot, config) in controls.slots.iter_mut().zip(configs) {
            match config.assignment {
                Some(ControlAssignment::Clip(id)) => slot.assigned_clip_id = Some(id),
                Some(ControlAssignment::Master(id)) => slot.assigned_master_id = Some(id),
                None => {}
            }
            slot.button_mode = config.button_mode;
            slot.fit_button_mode_to_assignment();
        }
        controls
    }

    /// Returns how many control slots the bank has; valid control indices are `1..=count`.
    pub fn slot_count(&self) -> usize {
        self.slots.len()
    }

    /// Returns whether a 1-based control index addresses a slot, whether or not it is assigned.
    pub fn contains(&self, control_index: u32) -> bool {
        self.slot(control_index).is_some()
    }

    /// Lists the clips a held Flash or Swop plays at full as `(control index, clip id, swop)`,
    /// where a Swop also takes every other playback out.
    ///
    /// A flash nobody holds any more, or whose slot was reassigned or switched to another
    /// mode, is left out at once, before [`end_released_flashes`] undoes it on the next frame.
    pub(crate) fn flashed_clips(&self) -> impl Iterator<Item = (u32, u32, bool)> + '_ {
        self.slots
            .iter()
            .zip(1..)
            .filter_map(|(slot, control_index)| {
                let flash = slot
                    .flash
                    .as_ref()
                    .filter(|flash| flash.still_held_on(slot))?;
                match flash.target {
                    ControlAssignment::Clip(clip_id) => Some((control_index, clip_id, flash.swop)),
                    ControlAssignment::Master(_) => None,
                }
            })
    }

    /// Holds slot `control_index`'s assignment as if a web client pressed its Flash or Swop
    /// button, without starting or pushing anything.
    #[cfg(test)]
    pub(crate) fn hold_for_test(&mut self, control_index: u32) {
        let slot = self.slot_mut(control_index).expect("control slot exists");
        let target = slot.assignment().expect("control slot is assigned");
        slot.flash = Some(SlotFlash::new(
            target,
            slot.button_mode,
            ButtonHolder::Client(ClientId(1)),
        ));
    }

    /// Returns a held flash of `target` on any slot other than `control_index`, which a new
    /// flash of the same target joins instead of changing outputs again.
    fn flash_on(&self, target: &ControlAssignment, control_index: u32) -> Option<&SlotFlash> {
        let index = self.flash_index_on(target, control_index)?;
        self.slots[index].flash.as_ref()
    }

    /// Returns the zero-based position of the slot other than `control_index` that holds a
    /// flash of `target`.
    fn flash_index_on(&self, target: &ControlAssignment, control_index: u32) -> Option<usize> {
        self.slots.iter().enumerate().position(|(index, slot)| {
            u32::try_from(index + 1).ok() != Some(control_index)
                && slot
                    .flash
                    .as_ref()
                    .is_some_and(|flash| &flash.target == target && flash.still_held_on(slot))
        })
    }

    /// Reads a slot's live console level (percent) and whether its assignment is running, for
    /// controller feedback.
    ///
    /// The level matches the console value control snapshots publish, except while a fader
    /// is still settling a clip it just started, when the fader's own level is reported. A
    /// slot is active while its clip runs or its master contributes (toggle masters only
    /// while on). Unassigned slots read as idle at zero. Returns `None` for an index outside
    /// the bank.
    pub(crate) fn live_state(&self, world: &World, control_index: u32) -> Option<(f32, bool)> {
        let slot = self.slot(control_index)?;
        if let Some(clip_id) = slot.assigned_clip_id {
            let (level, active) = clip_live_state(world, clip_id);
            return Some((slot.settling_level().unwrap_or(level), active));
        }
        let master = slot.assigned_master_id.and_then(|master_id| {
            world
                .get_resource::<DataProvider<Master>>()?
                .from_id(master_id)
                .ok()
                .map(|master| master.clone())
        });
        Some(master.map_or((0.0, false), |master| {
            (
                master.control_position_percent(),
                master_contributes(&master),
            )
        }))
    }

    fn slot(&self, control_index: u32) -> Option<&Control> {
        let zero_based = usize::try_from(control_index.checked_sub(1)?).ok()?;
        self.slots.get(zero_based)
    }

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
        held_buttons: &HeldButtonEffects,
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
                    hardware_value: slot.has_hardware.then_some(slot.hardware_value),
                    console_value: runtime.console_value,
                    display_value: slot.display_value(runtime),
                    is_grabbed: slot.is_grabbed,
                    is_clip_active: runtime.is_clip_active,
                    attached_instance_id: runtime.attached_instance_id,
                    button_mode: slot.button_mode,
                    available_button_modes: ControlButtonMode::available_for(
                        slot.assignment().as_ref(),
                    ),
                    is_flashing: slot.flash.is_some(),
                    held_button: runtime
                        .attached_instance_id
                        .and_then(|instance_id| held_buttons.get(&instance_id)),
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

/// Reads a clip's console level (percent) and whether it is running, from the live world.
///
/// A clip that is not running, or whose playback has no instance controls yet, reads as
/// level zero, matching the runtime state control snapshots use.
pub(crate) fn clip_live_state(world: &World, clip_id: u32) -> (f32, bool) {
    let attached = world
        .try_query::<&MaterializedClip>()
        .and_then(|mut materialized| {
            materialized
                .iter(world)
                .find(|materialized| materialized.clip_id == clip_id)
                .map(|materialized| materialized.attached_instance)
        });
    let Some(attached) = attached else {
        return (0.0, false);
    };
    let level = world
        .get_resource::<InstanceIndex>()
        .and_then(|index| index.get(&attached))
        .and_then(|entity| world.get::<InstanceControls>(entity))
        .map_or(0.0, |controls| {
            clamp_percent(controls.intensity_scale * 100.0)
        });
    (level, true)
}

/// Returns whether a master currently contributes: always-on masters always do, toggle
/// masters only while on, and disabled masters never.
pub(crate) fn master_contributes(master: &Master) -> bool {
    match master.mode {
        MasterMode::AlwaysOn => true,
        MasterMode::Toggle { active } => active,
        MasterMode::Disabled => false,
    }
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
            ControlCommand::SetButtonMode {
                control_index,
                mode,
            } => set_control_button_mode(&mut controls, *control_index, *mode),
            ControlCommand::ReleaseHeldButtons => {
                release_held_buttons(&mut controls);
                Ok(())
            }
            ControlCommand::Go { control_index }
            | ControlCommand::PressButton { control_index }
            | ControlCommand::ReleaseButton { control_index } => Err(CommandError::new(
                "control.button_not_expanded",
                format!(
                    "Button input for control {control_index} must be queued through command expansion"
                ),
            )),
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
    slot.fit_button_mode_to_assignment();
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
    slot.fit_button_mode_to_assignment();
    Ok(())
}

/// Sets a control's button mode, rejecting modes its current assignment cannot use.
fn set_control_button_mode(
    controls: &mut Controls,
    control_index: u32,
    mode: ControlButtonMode,
) -> Result<(), CommandError> {
    let slot = controls.slot_mut(control_index).ok_or_else(|| {
        CommandError::new(
            "control.not_found",
            format!("Control {control_index} does not exist"),
        )
    })?;
    if !mode.supports(slot.assignment().as_ref()) {
        return Err(CommandError::new(
            "control.button_mode_unsupported",
            format!("Control {control_index} cannot use the {mode:?} button mode"),
        ));
    }
    slot.button_mode = mode;
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

/// One edge of button input addressed to a control slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ControlButtonInput {
    /// An explicit Go, regardless of the slot's button mode.
    Go(u32),
    /// A press, running the slot's button mode.
    Press(u32),
    /// A release of a previous press.
    Release(u32),
}

impl ControlButtonInput {
    /// Extracts button input from a control command, or `None` for other control commands.
    fn from_command(command: &ControlCommand) -> Option<Self> {
        match *command {
            ControlCommand::Go { control_index } => Some(Self::Go(control_index)),
            ControlCommand::PressButton { control_index } => Some(Self::Press(control_index)),
            ControlCommand::ReleaseButton { control_index } => Some(Self::Release(control_index)),
            _ => None,
        }
    }
}

/// Replaces queued control button commands with the clip or master command they resolve to.
///
/// Handles explicit Go and the press and release of the slot's button. Runs in the pending
/// command expansion stage so the concrete command inherits the button command's identity and
/// undo group and dispatches in the same frame. Input that has nothing to do for the slot's
/// assignment and playback state, such as Go on an empty control or any release, completes
/// without effect.
pub fn expand_control_button_commands(
    mut pending: ResMut<PendingCommandBuffer>,
    mut controls: ResMut<Controls>,
    clips: Query<&Clip>,
    materialized_clips: Query<&MaterializedClip>,
    masters: Res<DataProvider<Master>>,
    mut flash_outputs: FlashOutputs,
    mut responder: CommandResponder,
) {
    for envelope in pending.drain() {
        let Some(input) = envelope
            .payload
            .as_any()
            .downcast_ref::<ControlCommand>()
            .and_then(ControlButtonInput::from_command)
        else {
            pending.push(envelope);
            continue;
        };
        let holder = button_holder(&responder, envelope.command_id);
        let held_input = match input {
            ControlButtonInput::Press(control_index) => controls
                .slot(control_index)
                .is_some_and(|slot| slot.button_mode.is_held())
                .then(|| {
                    press_flash(
                        &mut controls,
                        control_index,
                        holder,
                        &clips,
                        &materialized_clips,
                        &mut flash_outputs,
                    )
                }),
            ControlButtonInput::Release(control_index) => {
                Some(release_flash(&mut controls, control_index, &holder))
            }
            ControlButtonInput::Go(_) => None,
        };
        if let Some(result) = held_input {
            finish_control_command(&mut responder, envelope.command_id, result);
            continue;
        }
        match resolve_control_button(&controls, input, &clips, &materialized_clips, &masters) {
            Ok(Some(command)) => pending.push(PayloadEnvelope::with_context(
                envelope.command_id,
                envelope.undo_id,
                command,
            )),
            Ok(None) => finish_control_command(&mut responder, envelope.command_id, Ok(())),
            Err(error) => {
                finish_control_command(&mut responder, envelope.command_id, Err(error));
            }
        }
    }
}

/// Decides which command a control's button input runs for its assignment and playback state.
///
/// Go and presses in Go mode start or advance the clip; Go back steps a running sequence
/// back; Toggle starts an idle clip or stops a running one; Release stops a running clip.
/// Toggle-mode masters toggle in Go and Toggle modes. Releases do nothing yet.
fn resolve_control_button(
    controls: &Controls,
    input: ControlButtonInput,
    clips: &Query<&Clip>,
    materialized_clips: &Query<&MaterializedClip>,
    masters: &DataProvider<Master>,
) -> Result<Option<DynEnginePayload>, CommandError> {
    let control_index = match input {
        ControlButtonInput::Go(index)
        | ControlButtonInput::Press(index)
        | ControlButtonInput::Release(index) => index,
    };
    let slot = controls.slot(control_index).ok_or_else(|| {
        CommandError::new(
            "control.not_found",
            format!("Control {control_index} does not exist"),
        )
    })?;
    let mode = match input {
        ControlButtonInput::Go(_) => ControlButtonMode::Go,
        ControlButtonInput::Press(_) => slot.button_mode,
        ControlButtonInput::Release(_) => return Ok(None),
    };
    if let Some(master_id) = slot.assigned_master_id {
        let master = masters.from_id(master_id).map_err(|_| {
            CommandError::new(
                "master.not_found",
                format!("Assigned master {master_id} does not exist"),
            )
        })?;
        let toggles = matches!(mode, ControlButtonMode::Go | ControlButtonMode::Toggle)
            && matches!(master.mode, MasterMode::Toggle { .. });
        return Ok(toggles
            .then(|| Box::new(MasterCommand::ToggleMaster { id: master_id }) as DynEnginePayload));
    }
    let Some(clip_id) = slot.assigned_clip_id else {
        return Ok(None);
    };
    let clip = clips
        .iter()
        .find(|clip| clip.identifiers.id == clip_id)
        .ok_or_else(|| {
            CommandError::new(
                "clip.not_found",
                format!("Assigned clip {clip_id} does not exist"),
            )
        })?;
    let Some(source) = &clip.source else {
        return Ok(None);
    };
    let is_active = materialized_clips
        .iter()
        .any(|materialized| materialized.clip_id == clip_id);
    let target = IdExpr::Single(clip_id);
    let is_sequence = matches!(source, Source::Sequence(_));
    let command = match (mode, is_active) {
        (ControlButtonMode::Go, true) => is_sequence.then_some(ClipCommand::GoClip(target)),
        (ControlButtonMode::Go | ControlButtonMode::Toggle, false) => {
            Some(ClipCommand::StartClip(target))
        }
        (ControlButtonMode::GoBack, true) => is_sequence.then_some(ClipCommand::BackClip(target)),
        (ControlButtonMode::Toggle | ControlButtonMode::Release, true) => {
            Some(ClipCommand::StopClip(target))
        }
        (ControlButtonMode::GoBack | ControlButtonMode::Release, false) => None,
        // Held modes are handled by `press_flash` before resolving.
        (ControlButtonMode::Flash | ControlButtonMode::Swop, _) => None,
    };
    Ok(command.map(|command| Box::new(command) as DynEnginePayload))
}

/// Identifies who pressed or released a button: the client session that sent the command,
/// or else the surface that accepted it.
fn button_holder(responder: &CommandResponder, command_id: CommandId) -> ButtonHolder {
    match responder.connection(command_id) {
        Some(client) => ButtonHolder::Client(client),
        None => ButtonHolder::Surface(
            responder
                .origin(command_id)
                .cloned()
                .unwrap_or(CommandOrigin::WebUi),
        ),
    }
}

/// Holds a Flash or Swop on a slot: the first press starts it, and later presses from other
/// surfaces only add holders so the flash lasts until the last one lets go.
///
/// Pressing an empty slot does nothing. A clip that is not running is started with its
/// fader level at zero, so it shows only while the button is held.
fn press_flash(
    controls: &mut Controls,
    control_index: u32,
    holder: ButtonHolder,
    clips: &Query<&Clip>,
    materialized_clips: &Query<&MaterializedClip>,
    flash_outputs: &mut FlashOutputs,
) -> Result<(), CommandError> {
    let shared = {
        let slot = controls
            .slot(control_index)
            .ok_or_else(|| control_not_found(control_index))?;
        slot.assignment()
            .and_then(|target| controls.flash_on(&target, control_index))
            .map(|flash| flash.restore_master_position)
    };
    let slot = controls
        .slot_mut(control_index)
        .ok_or_else(|| control_not_found(control_index))?;
    if slot.flash.as_ref().is_some_and(|flash| flash.fits(slot))
        && let Some(flash) = slot.flash.as_mut()
    {
        if !flash.holders.contains(&holder) {
            flash.holders.push(holder);
        }
        return Ok(());
    }
    let Some(target) = slot.assignment() else {
        return Ok(());
    };
    if let ControlAssignment::Clip(clip_id) = target
        && !clips.iter().any(|clip| clip.identifiers.id == clip_id)
    {
        return Err(CommandError::new(
            "clip.not_found",
            format!("Assigned clip {clip_id} does not exist"),
        ));
    }
    let stale = slot.flash.take();
    let result = match shared {
        Some(restore_master_position) => {
            slot.flash = Some(SlotFlash {
                restore_master_position,
                ..SlotFlash::new(target, slot.button_mode, holder)
            });
            Ok(())
        }
        None => flash_outputs.start(slot, target, holder, materialized_clips),
    };
    if let Some(stale) = stale {
        end_flash(controls, control_index, stale, flash_outputs);
    }
    result
}

/// Lets go of one holder's press of a slot's button. The flash itself ends in
/// [`end_released_flashes`] once nobody holds it.
///
/// Releases that let go of nothing, such as every release of a Go button, leave the bank
/// untouched so they do not re-broadcast control snapshots.
fn release_flash(
    controls: &mut ResMut<Controls>,
    control_index: u32,
    holder: &ButtonHolder,
) -> Result<(), CommandError> {
    let slot = controls
        .slot(control_index)
        .ok_or_else(|| control_not_found(control_index))?;
    let is_holding = slot
        .flash
        .as_ref()
        .is_some_and(|flash| flash.holders.contains(holder));
    if is_holding
        && let Some(flash) = controls
            .slot_mut(control_index)
            .and_then(|slot| slot.flash.as_mut())
    {
        flash.holders.retain(|held| held != holder);
    }
    Ok(())
}

/// Drops every holder of every held flash, so [`end_released_flashes`] ends them all and
/// undoes what they did. Leaves the bank untouched when nothing is held.
fn release_held_buttons(controls: &mut ResMut<Controls>) {
    if controls.slots.iter().all(|slot| slot.flash.is_none()) {
        return;
    }
    for flash in controls
        .slots
        .iter_mut()
        .filter_map(|slot| slot.flash.as_mut())
    {
        flash.holders.clear();
    }
}

/// Builds the error for button input addressed to a slot the bank does not have.
fn control_not_found(control_index: u32) -> CommandError {
    CommandError::new(
        "control.not_found",
        format!("Control {control_index} does not exist"),
    )
}

/// Playback and master changes a slot Flash or Swop makes when it starts and ends.
///
/// They are runtime effects rather than show edits, so they bypass the command and undo
/// lifecycle like fader moves do.
#[derive(SystemParam)]
pub struct FlashOutputs<'w> {
    clip_writer: MessageWriter<'w, EngineOperationEnvelope<ClipOperation>>,
    master_writer: MessageWriter<'w, MasterUpdate>,
    masters: Res<'w, DataProvider<Master>>,
}

impl FlashOutputs<'_> {
    /// Starts a flash of `target` held by `holder` on `slot`.
    ///
    /// An idle clip starts with its fader level queued at zero, so the instance shows only
    /// through the flash. A master records its position and goes to full.
    fn start(
        &mut self,
        slot: &mut Control,
        target: ControlAssignment,
        holder: ButtonHolder,
        materialized_clips: &Query<&MaterializedClip>,
    ) -> Result<(), CommandError> {
        let mut flash = SlotFlash::new(target.clone(), slot.button_mode, holder);
        match target {
            ControlAssignment::Clip(clip_id) => {
                let running = materialized_clips
                    .iter()
                    .any(|materialized| materialized.clip_id == clip_id);
                if !running {
                    flash.started_clip = true;
                    slot.pending_console_value = Some(0.0);
                    self.clip_writer.write(EngineOperationEnvelope::detached(
                        ClipOperation::Start(IdExpr::Single(clip_id)),
                    ));
                }
            }
            ControlAssignment::Master(master_id) => {
                let master = self.masters.from_id(master_id).map_err(|_| {
                    CommandError::new(
                        "master.not_found",
                        format!("Assigned master {master_id} does not exist"),
                    )
                })?;
                flash.restore_master_position = Some(master.control_position_percent());
                self.master_writer.write(MasterUpdate::SetLevel {
                    id: master_id,
                    level_percent: Master::level_percent_from_control(master.kind, 100.0),
                });
            }
        }
        slot.flash = Some(flash);
        Ok(())
    }

    /// Undoes what a flash did: stops a clip it started unless its fader was raised while
    /// held, and returns a master to its position from before the press unless something
    /// else moved it meanwhile.
    ///
    /// The master still reads its pre-press position when press and release land in the
    /// same frame, before the push to full applies, so that position is restored too.
    fn end(&mut self, flash: SlotFlash, fader_raised: bool) {
        match flash.target {
            ControlAssignment::Clip(clip_id) if flash.started_clip && !fader_raised => {
                self.clip_writer
                    .write(EngineOperationEnvelope::detached(ClipOperation::Stop(
                        IdExpr::Single(clip_id),
                    )));
            }
            ControlAssignment::Clip(_) => {}
            ControlAssignment::Master(master_id) => {
                let (Some(restore), Ok(master)) = (
                    flash.restore_master_position,
                    self.masters.from_id(master_id),
                ) else {
                    return;
                };
                let position = master.control_position_percent();
                if is_same_value(position, 100.0) || is_same_value(position, restore) {
                    self.master_writer.write(MasterUpdate::SetLevel {
                        id: master_id,
                        level_percent: Master::level_percent_from_control(master.kind, restore),
                    });
                }
            }
        }
    }
}

/// Ends slot flashes nobody holds any more: after the last release, when the client holding
/// them disconnects, or when the slot is reassigned or switched to another mode.
///
/// A dropped phone or closed tab therefore never leaves a flash latched.
pub fn end_released_flashes(
    mut controls: ResMut<Controls>,
    mut disconnects: MessageReader<ClientDisconnected>,
    mut flash_outputs: FlashOutputs,
) {
    let disconnected: Vec<ClientId> = disconnects.read().map(|event| event.client).collect();
    let disconnected_holder = |holder: &ButtonHolder| matches!(holder, ButtonHolder::Client(client) if disconnected.contains(client));
    let needs_update = controls.slots.iter().any(|slot| {
        slot.flash.as_ref().is_some_and(|flash| {
            !flash.still_held_on(slot) || flash.holders.iter().any(disconnected_holder)
        })
    });
    if !needs_update {
        return;
    }
    let mut ended = Vec::new();
    for (index, slot) in controls.slots.iter_mut().enumerate() {
        let Some(mut flash) = slot.flash.take() else {
            continue;
        };
        flash.holders.retain(|holder| !disconnected_holder(holder));
        if flash.still_held_on(slot) {
            slot.flash = Some(flash);
        } else if let Ok(control_index) = u32::try_from(index + 1) {
            ended.push((control_index, flash));
        }
    }
    for (control_index, flash) in ended {
        end_flash(&mut controls, control_index, flash, &mut flash_outputs);
    }
}

/// Ends a flash taken off slot `control_index`.
///
/// When another slot still flashes the same target, that flash takes over stopping a clip
/// this one started, so the target stays flashed until the last slot lets go. Otherwise the
/// outputs are undone, keeping a started clip running if this slot's fader was raised while
/// the button was held.
fn end_flash(
    controls: &mut Controls,
    control_index: u32,
    flash: SlotFlash,
    flash_outputs: &mut FlashOutputs,
) {
    if let Some(index) = controls.flash_index_on(&flash.target, control_index) {
        if let Some(other) = controls.slots[index].flash.as_mut() {
            other.started_clip |= flash.started_clip;
        }
        return;
    }
    let fader_raised = controls.slot(control_index).is_some_and(|slot| {
        slot.assignment().as_ref() == Some(&flash.target)
            && !is_same_value(
                slot.pending_console_value
                    .unwrap_or(slot.last_console_value),
                0.0,
            )
    });
    flash_outputs.end(flash, fader_raised);
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
    mut clip_writer: MessageWriter<EngineOperationEnvelope<ClipOperation>>,
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
                    clip_writer.write(EngineOperationEnvelope::detached(ClipOperation::Start(
                        IdExpr::Single(clip_id),
                    )));
                }

                if actions.should_stop_clip {
                    clip_writer.write(EngineOperationEnvelope::detached(ClipOperation::Stop(
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
                slot.has_hardware = true;

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
                    clip_writer.write(EngineOperationEnvelope::detached(ClipOperation::Start(
                        IdExpr::Single(clip_id),
                    )));
                }

                if actions.should_stop_clip {
                    clip_writer.write(EngineOperationEnvelope::detached(ClipOperation::Stop(
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
                slot.has_hardware = true;

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
                    clip_writer.write(EngineOperationEnvelope::detached(ClipOperation::Start(
                        IdExpr::Single(clip_id),
                    )));
                }

                if actions.should_stop_clip {
                    clip_writer.write(EngineOperationEnvelope::detached(ClipOperation::Stop(
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
        app.add_message::<CommandNoticeReply>();
        app.add_systems(Update, handle_control_commands);
        app
    }

    /// Builds an app running only button expansion over a controlled pending buffer.
    fn control_go_app() -> App {
        let mut app = control_command_app();
        app.init_resource::<PendingCommandBuffer>();
        app.add_message::<EngineOperationEnvelope<ClipOperation>>();
        app.add_message::<MasterUpdate>();
        app.add_message::<ClientDisconnected>();
        app.add_systems(
            Update,
            (expand_control_button_commands, end_released_flashes).chain(),
        );
        app
    }

    /// Spawns a clip with the given source, optionally as a running playback.
    fn spawn_clip(app: &mut App, id: u32, source: Option<Source>, running: bool) {
        app.world_mut().spawn(Clip {
            identifiers: Identifiers {
                id,
                uid: uuid::Uuid::from_u128(u128::from(id)),
                label: format!("Clip {id}"),
            },
            source,
            ..Default::default()
        });
        if running {
            app.world_mut().spawn(MaterializedClip {
                clip_id: id,
                attached_instance: InstanceId::new(),
                auto_release_on_stop: false,
            });
        }
    }

    /// Queues Go for control 1 after assigning it, and returns what expansion produced.
    fn expand_go(app: &mut App, assignment: ControlAssignment) -> Vec<PayloadEnvelope> {
        expand_button(
            app,
            ControlSlotConfig::assigned(assignment),
            ControlCommand::Go { control_index: 1 },
        )
    }

    /// Configures control 1, queues one button command for it, and returns what expansion
    /// produced.
    fn expand_button(
        app: &mut App,
        config: ControlSlotConfig,
        command: ControlCommand,
    ) -> Vec<PayloadEnvelope> {
        let mut controls = Controls::from_slot_configs(&[config]);
        std::mem::swap(
            &mut *app.world_mut().resource_mut::<Controls>(),
            &mut controls,
        );
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("button command should register");
        app.world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .push(PayloadEnvelope::with_context(
                envelope.command_id,
                envelope.undo_id,
                Box::new(envelope.command),
            ));
        app.update();
        app.world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .drain()
    }

    /// Extracts a clip command from an expanded pending envelope.
    fn clip_command(envelope: &PayloadEnvelope) -> Option<&ClipCommand> {
        envelope.payload.as_any().downcast_ref::<ClipCommand>()
    }

    /// Verifies Go advances a running sequence and starts an idle one.
    #[test]
    fn go_advances_running_sequence_and_starts_idle_sequence() {
        let mut app = control_go_app();
        spawn_clip(&mut app, 7, Some(Source::Sequence(uuid::Uuid::nil())), true);
        spawn_clip(
            &mut app,
            8,
            Some(Source::Sequence(uuid::Uuid::nil())),
            false,
        );

        let running = expand_go(&mut app, ControlAssignment::Clip(7));
        let idle = expand_go(&mut app, ControlAssignment::Clip(8));

        assert!(matches!(
            running.as_slice(),
            [envelope] if matches!(clip_command(envelope), Some(ClipCommand::GoClip(IdExpr::Single(7))))
        ));
        assert!(matches!(
            idle.as_slice(),
            [envelope] if matches!(clip_command(envelope), Some(ClipCommand::StartClip(IdExpr::Single(8))))
        ));
    }

    /// Verifies Go leaves a running non-sequence clip alone and completes the command.
    #[test]
    fn go_on_running_effect_clip_completes_without_command() {
        let mut app = control_go_app();
        spawn_clip(&mut app, 9, Some(Source::Fx(uuid::Uuid::nil())), true);

        let expanded = expand_go(&mut app, ControlAssignment::Clip(9));

        assert!(expanded.is_empty());
        assert_eq!(
            take_control_result(&mut app).outcome,
            CommandOutcome::succeeded()
        );
    }

    /// Verifies Go toggles toggle-mode masters and ignores always-on masters.
    #[test]
    fn go_toggles_only_toggle_mode_masters() {
        let mut app = control_go_app();
        add_master(&mut app, 1, MasterMode::Toggle { active: false });
        add_master(&mut app, 2, MasterMode::AlwaysOn);

        let toggle = expand_go(&mut app, ControlAssignment::Master(1));
        let always_on = expand_go(&mut app, ControlAssignment::Master(2));

        assert!(matches!(
            toggle.as_slice(),
            [envelope] if matches!(
                envelope.payload.as_any().downcast_ref::<MasterCommand>(),
                Some(MasterCommand::ToggleMaster { id: 1 })
            )
        ));
        assert!(always_on.is_empty());
    }

    /// Stores an intensity master with the given ID and activation mode.
    fn add_master(app: &mut App, id: u32, mode: MasterMode) {
        app.world_mut()
            .resource_mut::<DataProvider<Master>>()
            .add(Master {
                identifiers: Identifiers {
                    id,
                    uid: uuid::Uuid::from_u128(u128::from(id)),
                    label: format!("Master {id}"),
                },
                kind: crate::masters::MasterKind::InhibitiveIntensity,
                target: crate::masters::MasterTarget::Instances(
                    crate::masters::InstanceMasterTarget::All,
                ),
                mode,
                level_percent: 100.0,
            })
            .expect("master should store");
    }

    /// Presses the button of control 1 holding `clip_id` in `mode` and returns the clip
    /// command expansion produced, if any.
    fn press_clip_button(
        app: &mut App,
        clip_id: u32,
        mode: ControlButtonMode,
    ) -> Option<ClipCommand> {
        let expanded = expand_button(
            app,
            ControlSlotConfig {
                assignment: Some(ControlAssignment::Clip(clip_id)),
                button_mode: mode,
            },
            ControlCommand::PressButton { control_index: 1 },
        );
        match expanded.as_slice() {
            [] => None,
            [envelope] => clip_command(envelope).cloned(),
            _ => panic!("one press should expand to at most one command"),
        }
    }

    /// Verifies each button mode's press on running and idle sequence and effect clips.
    #[test]
    fn button_press_runs_the_slot_mode_for_clips() {
        let mut app = control_go_app();
        let sequence = || Some(Source::Sequence(uuid::Uuid::nil()));
        spawn_clip(&mut app, 1, sequence(), true);
        spawn_clip(&mut app, 2, sequence(), false);
        spawn_clip(&mut app, 3, Some(Source::Fx(uuid::Uuid::nil())), true);
        let single = IdExpr::Single;

        use ControlButtonMode::{Go, GoBack, Release, Toggle};
        let cases = [
            (Go, 1, Some(ClipCommand::GoClip(single(1)))),
            (Go, 2, Some(ClipCommand::StartClip(single(2)))),
            (GoBack, 1, Some(ClipCommand::BackClip(single(1)))),
            (GoBack, 2, None),
            (GoBack, 3, None),
            (Toggle, 1, Some(ClipCommand::StopClip(single(1)))),
            (Toggle, 2, Some(ClipCommand::StartClip(single(2)))),
            (Release, 3, Some(ClipCommand::StopClip(single(3)))),
            (Release, 2, None),
        ];
        for (mode, clip_id, expected) in cases {
            let produced = press_clip_button(&mut app, clip_id, mode);
            assert_eq!(
                format!("{produced:?}"),
                format!("{expected:?}"),
                "{mode:?} press on clip {clip_id}"
            );
        }
    }

    /// Verifies a button release completes without queuing any playback command.
    #[test]
    fn button_release_completes_without_effect() {
        let mut app = control_go_app();
        spawn_clip(&mut app, 1, Some(Source::Fx(uuid::Uuid::nil())), true);

        let expanded = expand_button(
            &mut app,
            ControlSlotConfig {
                assignment: Some(ControlAssignment::Clip(1)),
                button_mode: ControlButtonMode::Toggle,
            },
            ControlCommand::ReleaseButton { control_index: 1 },
        );

        assert!(expanded.is_empty());
        assert_eq!(
            take_control_result(&mut app).outcome,
            CommandOutcome::succeeded()
        );
    }

    /// Verifies a Toggle-mode press toggles a toggle-mode master.
    #[test]
    fn toggle_button_press_toggles_master() {
        let mut app = control_go_app();
        add_master(&mut app, 4, MasterMode::Toggle { active: true });

        let expanded = expand_button(
            &mut app,
            ControlSlotConfig {
                assignment: Some(ControlAssignment::Master(4)),
                button_mode: ControlButtonMode::Toggle,
            },
            ControlCommand::PressButton { control_index: 1 },
        );

        assert!(matches!(
            expanded.as_slice(),
            [envelope] if matches!(
                envelope.payload.as_any().downcast_ref::<MasterCommand>(),
                Some(MasterCommand::ToggleMaster { id: 4 })
            )
        ));
    }

    /// Verifies setting a clip-only mode on a master slot fails and keeps the previous mode.
    #[test]
    fn set_button_mode_rejects_modes_the_assignment_cannot_use() {
        let mut app = control_command_app();
        *app.world_mut().resource_mut::<Controls>() =
            Controls::from_slot_configs(&[ControlSlotConfig::assigned(ControlAssignment::Master(
                1,
            ))]);

        submit_control_command(
            &mut app,
            ControlCommand::SetButtonMode {
                control_index: 1,
                mode: ControlButtonMode::Release,
            },
        );
        app.update();

        assert!(matches!(
            take_control_result(&mut app).outcome,
            CommandOutcome::Failed(error) if error.code == "control.button_mode_unsupported"
        ));
        assert_eq!(
            app.world().resource::<Controls>().slots[0].button_mode,
            ControlButtonMode::Go
        );
    }

    /// Verifies a slot keeps its mode when cleared and drops a clip-only mode when a master
    /// is assigned.
    #[test]
    fn button_mode_survives_clear_and_fits_new_master_assignment() {
        let mut slot = Control {
            assigned_clip_id: Some(1),
            button_mode: ControlButtonMode::Release,
            ..Control::default()
        };

        slot.clear();
        assert_eq!(slot.button_mode, ControlButtonMode::Release);

        slot.assigned_master_id = Some(2);
        slot.fit_button_mode_to_assignment();
        assert_eq!(slot.button_mode, ControlButtonMode::Go);
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

    /// Restoring assignments resets hardware pickup and pending playback changes without losing targets.
    #[test]
    fn persisted_assignments_exclude_runtime_state() {
        let mut controls = Controls::from_slot_configs(&[
            ControlSlotConfig {
                assignment: Some(ControlAssignment::Clip(1)),
                button_mode: ControlButtonMode::Toggle,
            },
            ControlSlotConfig::default(),
            ControlSlotConfig::assigned(ControlAssignment::Master(2)),
        ]);
        let slot = controls.slot_mut(1).unwrap();
        slot.reset_to(80.0);
        slot.pending_console_sync = true;
        let restored = Controls::from_slot_configs(&controls.slot_configs());
        assert_eq!(restored.slot_configs(), controls.slot_configs());
        assert_eq!(
            restored.slots[0],
            Control {
                assigned_clip_id: Some(1),
                button_mode: ControlButtonMode::Toggle,
                ..Control::default()
            }
        );
        assert_eq!(restored.slots[1], Control::default());
    }

    /// Verifies a restored button mode that does not fit its master assignment falls back to Go.
    #[test]
    fn restored_master_slot_drops_clip_only_button_mode() {
        let controls = Controls::from_slot_configs(&[ControlSlotConfig {
            assignment: Some(ControlAssignment::Master(2)),
            button_mode: ControlButtonMode::GoBack,
        }]);

        assert_eq!(controls.slots[0].button_mode, ControlButtonMode::Go);
    }

    /// Web UI session used as the holder of flash presses in tests.
    const WEB_CLIENT: ClientId = ClientId(7);

    /// Origin of a press arriving from a MIDI pad rather than a client session.
    fn midi_origin() -> CommandOrigin {
        CommandOrigin::Automation {
            surface: "MIDI".to_string(),
            source: Some("pad".to_string()),
        }
    }

    /// Builds a button app whose control 1 holds `assignment` in `mode`.
    fn flash_app(assignment: ControlAssignment, mode: ControlButtonMode) -> App {
        let mut app = control_go_app();
        app.insert_resource(Controls::from_slot_configs(&[ControlSlotConfig {
            assignment: Some(assignment),
            button_mode: mode,
        }]));
        app
    }

    /// Sends one press or release of control 1 from `origin`, replying to `client` when set,
    /// and runs a frame.
    fn send_button(
        app: &mut App,
        command: ControlCommand,
        origin: CommandOrigin,
        client: Option<ClientId>,
    ) {
        queue_button(app, command, origin, client);
        app.update();
    }

    /// Queues one button command like [`send_button`] without running a frame, so several
    /// commands can land in the same frame.
    fn queue_button(
        app: &mut App,
        command: ControlCommand,
        origin: CommandOrigin,
        client: Option<ClientId>,
    ) {
        let reply_target = client.map_or(ReplyTarget::Detached, ReplyTarget::Client);
        let envelope = CommandEnvelope::new(command, origin, reply_target);
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("button command should register");
        app.world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .push(PayloadEnvelope::with_context(
                envelope.command_id,
                envelope.undo_id,
                Box::new(envelope.command),
            ));
    }

    /// Presses control 1 from the web client.
    fn press_web(app: &mut App) {
        send_button(
            app,
            ControlCommand::PressButton { control_index: 1 },
            CommandOrigin::WebUi,
            Some(WEB_CLIENT),
        );
    }

    /// Releases control 1 from the web client.
    fn release_web(app: &mut App) {
        send_button(
            app,
            ControlCommand::ReleaseButton { control_index: 1 },
            CommandOrigin::WebUi,
            Some(WEB_CLIENT),
        );
    }

    /// Drains the clip operations flashes wrote, as `(start, clip id)` pairs.
    fn take_clip_operations(app: &mut App) -> Vec<(bool, u32)> {
        app.world_mut()
            .resource_mut::<Messages<EngineOperationEnvelope<ClipOperation>>>()
            .drain()
            .map(|envelope| match envelope.operation {
                ClipOperation::Start(IdExpr::Single(id)) => (true, id),
                ClipOperation::Stop(IdExpr::Single(id)) => (false, id),
                other => panic!("unexpected clip operation {other:?}"),
            })
            .collect()
    }

    /// Drains the master levels flashes wrote, as `(master id, level)` pairs.
    fn take_master_levels(app: &mut App) -> Vec<(u32, f32)> {
        app.world_mut()
            .resource_mut::<Messages<MasterUpdate>>()
            .drain()
            .map(|MasterUpdate::SetLevel { id, level_percent }| (id, level_percent))
            .collect()
    }

    /// Returns whether control 1 has a flash held.
    fn is_flashing(app: &App) -> bool {
        app.world().resource::<Controls>().slots[0].flash.is_some()
    }

    /// Verifies a Flash on an idle clip starts it with its fader queued at zero, plays it at
    /// full only while held, and stops it again on release.
    #[test]
    fn flash_on_idle_clip_starts_it_until_release() {
        let mut app = flash_app(ControlAssignment::Clip(5), ControlButtonMode::Flash);
        spawn_clip(&mut app, 5, Some(Source::Fx(uuid::Uuid::nil())), false);

        press_web(&mut app);
        assert_eq!(take_clip_operations(&mut app), [(true, 5)]);
        let controls = app.world().resource::<Controls>();
        assert_eq!(
            controls.flashed_clips().collect::<Vec<_>>(),
            [(1, 5, false)]
        );
        assert_eq!(controls.slots[0].pending_console_value, Some(0.0));

        release_web(&mut app);
        assert_eq!(take_clip_operations(&mut app), [(false, 5)]);
        assert!(!is_flashing(&app));
    }

    /// Verifies a Flash on a running clip leaves it running when let go, and that a Swop
    /// reports its clip as soloed.
    #[test]
    fn swop_on_running_clip_leaves_it_running() {
        let mut app = flash_app(ControlAssignment::Clip(5), ControlButtonMode::Swop);
        spawn_clip(&mut app, 5, Some(Source::Fx(uuid::Uuid::nil())), true);

        press_web(&mut app);
        assert!(take_clip_operations(&mut app).is_empty());
        assert_eq!(
            app.world()
                .resource::<Controls>()
                .flashed_clips()
                .collect::<Vec<_>>(),
            [(1, 5, true)]
        );

        release_web(&mut app);
        assert!(take_clip_operations(&mut app).is_empty());
        assert!(!is_flashing(&app));
    }

    /// Verifies a flash held from the screen and a MIDI pad lasts until both let go, and that
    /// a release from a surface that never pressed changes nothing.
    #[test]
    fn flash_lasts_until_every_holder_lets_go() {
        let mut app = flash_app(ControlAssignment::Clip(5), ControlButtonMode::Flash);
        spawn_clip(&mut app, 5, Some(Source::Fx(uuid::Uuid::nil())), false);

        press_web(&mut app);
        send_button(
            &mut app,
            ControlCommand::PressButton { control_index: 1 },
            midi_origin(),
            None,
        );
        assert_eq!(take_clip_operations(&mut app), [(true, 5)]);

        send_button(
            &mut app,
            ControlCommand::ReleaseButton { control_index: 1 },
            CommandOrigin::Cli,
            None,
        );
        release_web(&mut app);
        assert!(is_flashing(&app));
        assert!(take_clip_operations(&mut app).is_empty());

        send_button(
            &mut app,
            ControlCommand::ReleaseButton { control_index: 1 },
            midi_origin(),
            None,
        );
        assert!(!is_flashing(&app));
        assert_eq!(take_clip_operations(&mut app), [(false, 5)]);
    }

    /// Verifies a client that disconnects while holding a flash lets go of it.
    #[test]
    fn disconnect_releases_a_held_flash() {
        let mut app = flash_app(ControlAssignment::Clip(5), ControlButtonMode::Flash);
        spawn_clip(&mut app, 5, Some(Source::Fx(uuid::Uuid::nil())), false);
        press_web(&mut app);
        take_clip_operations(&mut app);

        app.world_mut().write_message(ClientDisconnected {
            client: ClientId(99),
        });
        app.update();
        assert!(is_flashing(&app));

        app.world_mut()
            .write_message(ClientDisconnected { client: WEB_CLIENT });
        app.update();
        assert!(!is_flashing(&app));
        assert_eq!(take_clip_operations(&mut app), [(false, 5)]);
    }

    /// Verifies switching a held slot to another mode ends the flash at once.
    #[test]
    fn changing_mode_ends_a_held_flash() {
        let mut app = flash_app(ControlAssignment::Clip(5), ControlButtonMode::Flash);
        spawn_clip(&mut app, 5, Some(Source::Fx(uuid::Uuid::nil())), false);
        press_web(&mut app);
        take_clip_operations(&mut app);

        app.world_mut().resource_mut::<Controls>().slots[0].button_mode = ControlButtonMode::Toggle;
        app.update();
        assert!(!is_flashing(&app));
        assert_eq!(take_clip_operations(&mut app), [(false, 5)]);
    }

    /// Verifies a master Flash pushes the master to full and restores its earlier level on
    /// release, unless the level was moved off full while held.
    #[test]
    fn master_flash_restores_the_level_it_found() {
        let mut app = flash_app(ControlAssignment::Master(3), ControlButtonMode::Flash);
        add_master(&mut app, 3, MasterMode::AlwaysOn);
        let set_level = |app: &mut App, level: f32| {
            let mut masters = app.world_mut().resource_mut::<DataProvider<Master>>();
            let mut master = masters
                .remove(&uuid::Uuid::from_u128(3))
                .expect("master exists");
            master.level_percent = level;
            masters.add(master).expect("master should store");
        };
        set_level(&mut app, 40.0);

        press_web(&mut app);
        assert_eq!(take_master_levels(&mut app), [(3, 100.0)]);
        set_level(&mut app, 100.0);
        release_web(&mut app);
        assert_eq!(take_master_levels(&mut app), [(3, 40.0)]);

        press_web(&mut app);
        take_master_levels(&mut app);
        set_level(&mut app, 60.0);
        release_web(&mut app);
        assert!(take_master_levels(&mut app).is_empty());
    }

    /// Verifies a zero level queued for an idle clip survives until its instance attaches,
    /// so a flashed clip starts with its fader at zero rather than at the default full level.
    #[test]
    fn queued_zero_level_waits_for_the_instance() {
        let mut slot = Control {
            pending_console_value: Some(0.0),
            ..Default::default()
        };
        assert_eq!(slot.sync_from_runtime(ControlRuntimeState::default()), None);
        assert_eq!(slot.pending_console_value, Some(0.0));

        let attached = ControlRuntimeState {
            console_value: 100.0,
            is_clip_active: true,
            attached_instance_id: Some(InstanceId::new()),
        };
        assert_eq!(slot.sync_from_runtime(attached), Some(0.0));
    }

    /// Verifies a master Flash tapped within one frame still restores the earlier level,
    /// although the push to full has not applied when the release is handled.
    #[test]
    fn master_flash_tapped_in_one_frame_restores_its_level() {
        let mut app = flash_app(ControlAssignment::Master(3), ControlButtonMode::Flash);
        add_master(&mut app, 3, MasterMode::AlwaysOn);

        for command in [
            ControlCommand::PressButton { control_index: 1 },
            ControlCommand::ReleaseButton { control_index: 1 },
        ] {
            queue_button(&mut app, command, CommandOrigin::WebUi, Some(WEB_CLIENT));
        }
        app.update();
        let levels = take_master_levels(&mut app);
        assert_eq!(levels.first(), Some(&(3, 100.0)));
        assert_eq!(levels.len(), 2);
        assert!(!is_flashing(&app));
    }

    /// Verifies repeated presses from one surface count as one holder, so a single release
    /// ends the flash rather than leaving it latched by a press that was never let go.
    #[test]
    fn repeated_presses_from_one_surface_need_one_release() {
        let mut app = flash_app(ControlAssignment::Clip(5), ControlButtonMode::Flash);
        spawn_clip(&mut app, 5, Some(Source::Fx(uuid::Uuid::nil())), false);
        let press = ControlCommand::PressButton { control_index: 1 };

        send_button(&mut app, press.clone(), midi_origin(), None);
        send_button(&mut app, press, midi_origin(), None);
        send_button(
            &mut app,
            ControlCommand::ReleaseButton { control_index: 1 },
            midi_origin(),
            None,
        );
        assert!(!is_flashing(&app));
    }

    /// Verifies two slots flashing one idle clip keep it running until both let go, whichever
    /// started it, and that a clip whose fader was raised while held keeps running.
    #[test]
    fn shared_and_raised_flashes_keep_their_clip_running() {
        let mut app = control_go_app();
        let config = ControlSlotConfig {
            assignment: Some(ControlAssignment::Clip(5)),
            button_mode: ControlButtonMode::Flash,
        };
        app.insert_resource(Controls::from_slot_configs(&[config.clone(), config]));
        spawn_clip(&mut app, 5, Some(Source::Fx(uuid::Uuid::nil())), false);
        let button = |press: bool, control_index: u32| {
            if press {
                ControlCommand::PressButton { control_index }
            } else {
                ControlCommand::ReleaseButton { control_index }
            }
        };

        send_button(
            &mut app,
            button(true, 1),
            CommandOrigin::WebUi,
            Some(WEB_CLIENT),
        );
        send_button(
            &mut app,
            button(true, 2),
            CommandOrigin::WebUi,
            Some(WEB_CLIENT),
        );
        assert_eq!(take_clip_operations(&mut app), [(true, 5)]);
        send_button(
            &mut app,
            button(false, 1),
            CommandOrigin::WebUi,
            Some(WEB_CLIENT),
        );
        assert!(take_clip_operations(&mut app).is_empty());
        send_button(
            &mut app,
            button(false, 2),
            CommandOrigin::WebUi,
            Some(WEB_CLIENT),
        );
        assert_eq!(take_clip_operations(&mut app), [(false, 5)]);

        send_button(
            &mut app,
            button(true, 1),
            CommandOrigin::WebUi,
            Some(WEB_CLIENT),
        );
        take_clip_operations(&mut app);
        app.world_mut().resource_mut::<Controls>().slots[0].pending_console_value = Some(60.0);
        send_button(
            &mut app,
            button(false, 1),
            CommandOrigin::WebUi,
            Some(WEB_CLIENT),
        );
        assert!(take_clip_operations(&mut app).is_empty());
    }

    /// Verifies a held Swop reaches the rendered layers: the swopped clip plays at full
    /// although its fader sits at half, another clip's layer drops out entirely, and the
    /// Programmer keeps its level; releasing restores the swopped clip's fader scaling.
    #[test]
    fn held_swop_scales_rendered_layers() {
        use moonshine_kind::prelude::*;
        use nightfall_compositor::prelude::*;
        use nightfall_dmx::prelude::*;
        use nightfall_fixture_model::prelude::*;
        use nightfall_fixtures::prelude::*;
        use nightfall_instances::{InstanceKind, InstanceMetadata};

        let mut app = flash_app(ControlAssignment::Clip(5), ControlButtonMode::Swop);
        spawn_clip(&mut app, 5, Some(Source::Fx(uuid::Uuid::nil())), false);
        app.init_resource::<HeldButtonEffects>();
        app.add_systems(
            Update,
            (
                resolve_held_button_effects,
                crate::systems::instance_controls::apply_playback_intensity,
            )
                .chain()
                .after(end_released_flashes),
        );
        let parameter = app
            .world_mut()
            .spawn(Parameter {
                metadata: ParameterMetadata::default(),
                values: Default::default(),
            })
            .id();
        // SAFETY: the entity was just spawned with a Parameter component.
        let parameter = unsafe { Instance::<Parameter>::from_entity_unchecked(parameter) };
        let mut spawn_playback = |kind: InstanceKind, scale: f32, clip_id: Option<u32>| {
            let instance_id = InstanceId::new();
            let mut layer = Layer::new(format!("{kind:?}"), Priority(0));
            layer
                .absolute
                .insert(parameter, (ParameterValue::Absolute { value: 200.0 }, None));
            let world = app.world_mut();
            let layer = world
                .spawn((
                    layer,
                    InstanceControls {
                        intensity_scale: scale,
                        ..Default::default()
                    },
                    instance_id,
                    InstanceMetadata::new(kind),
                ))
                .id();
            if let Some(clip_id) = clip_id {
                world.spawn(MaterializedClip {
                    clip_id,
                    attached_instance: instance_id,
                    auto_release_on_stop: false,
                });
            }
            layer
        };
        let swopped = spawn_playback(InstanceKind::Sequence, 0.5, Some(5));
        let other = spawn_playback(InstanceKind::Sequence, 1.0, Some(6));
        let programmer = spawn_playback(InstanceKind::Programmer, 1.0, None);
        let intensity = |app: &App, layer| match app.world().get::<Layer>(layer) {
            Some(layer) => layer.absolute.get(parameter).map(|(value, _)| *value),
            None => None,
        };

        press_web(&mut app);
        let full = Some(ParameterValue::Absolute { value: 200.0 });
        assert_eq!(intensity(&app, swopped), full);
        assert_eq!(intensity(&app, other), None);
        assert_eq!(intensity(&app, programmer), full);

        release_web(&mut app);
        assert_eq!(
            intensity(&app, swopped),
            Some(ParameterValue::Absolute { value: 100.0 })
        );
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
        assert_eq!(slot.settling_level(), Some(30.0));

        slot.sync_from_runtime(ControlRuntimeState {
            console_value: 30.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(slot.is_grabbed);
        assert!(!slot.pending_console_sync);
        assert_eq!(slot.settling_level(), None);
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

    /// Verifies a slot no physical fader has driven shows the console level, even while its
    /// stored position from assignment still counts as held, and that a physical fader's
    /// position is shown once one has reported.
    #[test]
    fn display_ignores_stored_position_until_a_physical_fader_reports() {
        let mut slot = Control::default();
        slot.reset_to(100.0);
        let runtime = ControlRuntimeState {
            console_value: 31.0,
            is_clip_active: true,
            attached_instance_id: Some(InstanceId::new()),
        };
        assert!(slot.is_grabbed);
        assert_eq!(slot.display_value(runtime), 31.0);

        slot.has_hardware = true;
        assert_eq!(slot.display_value(runtime), 100.0);

        slot.clear();
        assert!(slot.has_hardware);
    }

    /// Verifies only slots a physical fader has driven report a hardware position, and that an
    /// on-screen move does not count as one.
    #[test]
    fn only_physical_fader_input_reports_a_hardware_position() {
        let mut app = control_command_app();
        app.add_message::<ControlUpdate>();
        app.add_message::<EngineOperationEnvelope<ClipOperation>>();
        app.add_message::<MasterUpdate>();
        app.add_message::<InstanceControlUpdate>();
        app.add_systems(Update, handle_control_updates);
        let update = |app: &mut App, update: ControlUpdate| {
            app.world_mut().write_message(update);
            app.update();
        };

        update(
            &mut app,
            ControlUpdate::SetConsoleValue {
                control_index: 1,
                value: 40.0,
            },
        );
        update(
            &mut app,
            ControlUpdate::SetExternalHardwareValue {
                control_index: 2,
                value: 60.0,
            },
        );

        let controls = app.world().resource::<Controls>();
        assert!(!controls.slots[0].has_hardware);
        assert!(controls.slots[1].has_hardware);
        assert_eq!(controls.slots[1].hardware_value, 60.0);
    }

    /// Verifies a slot pulled to zero on screen keeps following the clip when another slot
    /// assigned to the same clip raises it again, instead of sticking at zero.
    #[test]
    fn on_screen_slot_at_zero_follows_another_slot_on_the_same_clip() {
        let instance_id = InstanceId::new();
        let mut follower = Control::default();
        let stopped = ControlRuntimeState::default();

        let stop = follower.handle_console_value(
            0.0,
            ControlRuntimeState {
                console_value: 80.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert!(stop.should_stop_clip);
        follower.sync_from_runtime(stopped);
        assert_eq!(follower.display_value(stopped), 0.0);

        let raised = ControlRuntimeState {
            console_value: 60.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        };
        assert_eq!(follower.sync_from_runtime(raised), None);
        assert!(!follower.is_grabbed);
        assert_eq!(follower.display_value(raised), 60.0);
    }
}
