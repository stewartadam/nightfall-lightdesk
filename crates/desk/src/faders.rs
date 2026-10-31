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

const FADER_EPSILON: f32 = 0.0001;
pub const DEFAULT_FADER_COUNT: usize = 10;

/// Fallible user commands that mutate fader assignments.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum FaderCommand {
    AssignClip {
        fader_index: u32,
        clip_id: u32,
    },
    AssignMaster {
        fader_index: u32,
        master_id: u32,
    },
    ClearClip {
        fader_index: u32,
    },
    /// Runs the fader's Go behavior for its current assignment.
    ///
    /// Sequence clips start or advance, other clips start when inactive, and toggle-mode
    /// masters toggle. Expanded into the concrete clip or master command before dispatch.
    Go {
        fader_index: u32,
    },
    /// Sets what pressing the fader's button does.
    ///
    /// Fails when the mode does not apply to the fader's current assignment.
    SetButtonMode {
        fader_index: u32,
        mode: FaderButtonMode,
    },
    /// Presses the fader's button, running its button mode for the current assignment.
    ///
    /// Expanded into the concrete clip or master command before dispatch, like `Go`.
    PressButton {
        fader_index: u32,
    },
    /// Releases the fader's button.
    ///
    /// Ends a Flash or Swop once every surface holding it has let go; other modes act on
    /// the press only, so their releases complete without effect.
    ReleaseButton {
        fader_index: u32,
    },
    /// Lets go of every held Flash and Swop, whoever holds it, such as a press left on by a
    /// faderler that never sent its release.
    ReleaseHeldButtons,
}

impl IngressCommand for FaderCommand {}

/// What pressing a fader's button does, saved with the fader.
///
/// The mode belongs to the fader rather than to each faderler binding, so the on-screen
/// button, a bound MIDI pad and a board showing the fader always behave the same.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum FaderButtonMode {
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

impl FaderButtonMode {
    /// Every mode, in the order the mode picker lists them.
    pub const ALL: [Self; 6] = [
        Self::Go,
        Self::GoBack,
        Self::Flash,
        Self::Swop,
        Self::Toggle,
        Self::Release,
    ];

    /// Returns whether this mode does something for a fader holding `assignment`.
    ///
    /// Clips support every mode. Masters have no cues to step back through, no playback to
    /// release and no playback to solo, so they offer Go, Flash and Toggle. An empty fader
    /// accepts any mode, which is kept until something is assigned.
    pub fn supports(self, assignment: Option<&FaderAssignment>) -> bool {
        match assignment {
            None | Some(FaderAssignment::Clip(_)) => true,
            Some(FaderAssignment::Master(_)) => {
                matches!(self, Self::Go | Self::Flash | Self::Toggle)
            }
        }
    }

    /// Returns whether the mode acts while the button is held and ends on release.
    pub fn is_held(self) -> bool {
        matches!(self, Self::Flash | Self::Swop)
    }

    /// Lists the modes a fader holding `assignment` can use, in picker order.
    pub fn available_for(assignment: Option<&FaderAssignment>) -> Vec<Self> {
        Self::ALL
            .into_iter()
            .filter(|mode| mode.supports(assignment))
            .collect()
    }
}

/// High-frequency fader changes that intentionally have no command lifecycle.
#[derive(Debug, Clone, Serialize, Deserialize, Message)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum FaderUpdate {
    SetConsoleValue { fader_index: u32, value: f32 },
    SetHardwareValue { fader_index: u32, value: f32 },
    SetExternalHardwareValue { fader_index: u32, value: f32 },
}

/// Serializable snapshot of current fader bank state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FaderSnapshot {
    pub index: u32,
    pub assigned_clip_id: Option<u32>,
    pub assigned_master_id: Option<u32>,
    /// Position last reported by a mapped controller fader, or `None` when no controller
    /// has driven this fader.
    pub hardware_value: Option<f32>,
    pub console_value: f32,
    pub display_value: f32,
    pub is_grabbed: bool,
    pub is_clip_active: bool,
    pub attached_instance_id: Option<InstanceId>,
    /// What pressing the fader's button does.
    pub button_mode: FaderButtonMode,
    /// Modes the fader's current assignment supports, in picker order.
    pub available_button_modes: Vec<FaderButtonMode>,
    /// Whether the fader's Flash or Swop button is held down.
    pub is_flashing: bool,
    /// How a held Flash or Swop, on this fader or another, changes the fader's playback.
    pub held_button: Option<HeldButtonEffect>,
}

/// Resource that stores fader bank assignments and current levels.
#[derive(Clone, Copy, Debug, Default)]
struct FaderRuntimeState {
    console_value: f32,
    is_clip_active: bool,
    attached_instance_id: Option<InstanceId>,
}

/// One fader's assignment and current level in a fader bank.
#[derive(Clone, Debug, PartialEq)]
struct Fader {
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
    button_mode: FaderButtonMode,
    /// Whether a physical fader has reported a position for this fader since startup.
    has_hardware: bool,
    /// Flash or Swop currently held on the fader's button.
    flash: Option<FaderFlash>,
}

/// Who holds a fader's button down, so each release ends only its own press and a client
/// that disconnects lets go of everything it held.
#[derive(Clone, Debug, PartialEq, Eq)]
enum ButtonHolder {
    /// A connected client session, such as a web UI tab.
    Client(ClientId),
    /// Any other surface, such as a MIDI pad, identified by its command origin.
    Surface(CommandOrigin),
}

/// A Flash or Swop held on a fader's button, and what letting go must undo.
#[derive(Clone, Debug, PartialEq)]
struct FaderFlash {
    /// The assignment the flash acts on; reassigning the fader ends the flash.
    target: FaderAssignment,
    /// Whether the press was a Swop, which also mutes every other playback.
    swop: bool,
    /// Every press still held, one entry per press.
    holders: Vec<ButtonHolder>,
    /// Whether the flash started an idle clip, which letting go stops again.
    started_clip: bool,
    /// Master fader position captured at the press, restored when letting go.
    restore_master_position: Option<f32>,
}

impl FaderFlash {
    /// Builds a flash of `target` pressed by `holder` in `mode` that has not changed any
    /// output yet.
    fn new(target: FaderAssignment, mode: FaderButtonMode, holder: ButtonHolder) -> Self {
        Self {
            target,
            swop: mode == FaderButtonMode::Swop,
            holders: vec![holder],
            started_clip: false,
            restore_master_position: None,
        }
    }

    /// Returns whether the fader still holds the flashed target in the pressed mode.
    fn fits(&self, fader: &Fader) -> bool {
        let pressed_mode = if self.swop {
            FaderButtonMode::Swop
        } else {
            FaderButtonMode::Flash
        };
        fader.button_mode == pressed_mode && fader.assignment().as_ref() == Some(&self.target)
    }

    /// Returns whether the flash should keep going: someone still holds a press and the fader
    /// still [fits](Self::fits) it.
    fn still_held_on(&self, fader: &Fader) -> bool {
        !self.holders.is_empty() && self.fits(fader)
    }
}

impl Default for Fader {
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
            button_mode: FaderButtonMode::default(),
            has_hardware: false,
            flash: None,
        }
    }
}

impl Fader {
    /// Returns the fader's persisted target, or `None` for an empty fader.
    fn assignment(&self) -> Option<FaderAssignment> {
        self.assigned_clip_id
            .map(FaderAssignment::Clip)
            .or_else(|| self.assigned_master_id.map(FaderAssignment::Master))
    }

    /// Falls back to Go when the button mode does not apply to the fader's new assignment.
    fn fit_button_mode_to_assignment(&mut self) {
        if !self.button_mode.supports(self.assignment().as_ref()) {
            self.button_mode = FaderButtonMode::Go;
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

    /// Empties the fader and resets its levels, keeping the button mode and whether a physical
    /// fader drives it, since both belong to the fader rather than to its assignment. A held
    /// flash is kept too, so [`end_released_flashes`] can still undo what it did.
    fn clear(&mut self) {
        *self = Self {
            button_mode: self.button_mode,
            has_hardware: self.has_hardware,
            flash: self.flash.take(),
            ..Self::default()
        };
    }

    /// Returns the level (percent) the fader is still driving its clip's playback toward, or
    /// `None` once the playback has taken it.
    ///
    /// A clip started from a fader binds playback at full intensity before the fader's level
    /// is applied, so the console briefly reads 100%; feedback shows this level instead.
    fn settling_level(&self) -> Option<f32> {
        self.pending_console_value
            .or(self.pending_console_sync.then_some(self.hardware_value))
    }

    /// Returns the level the on-screen fader shows: the console level, unless a controller
    /// holds the fader, in which case the controller position until it is picked up.
    fn display_value(&self, runtime: FaderRuntimeState) -> f32 {
        if self.has_hardware && self.is_grabbed {
            self.hardware_value
        } else {
            // A level queued for an instance that is still starting is what the fader will
            // settle on, so show it rather than the new instance's default full level.
            self.pending_console_value.unwrap_or(runtime.console_value)
        }
    }

    /// Reconciles the fader with the target's live level each frame. Returns a level to push to
    /// a newly attached instance when one is queued, and lets go of the physical fader when the
    /// level moves away from it from elsewhere, so the fader must be picked up again.
    fn sync_from_runtime(&mut self, runtime: FaderRuntimeState) -> Option<f32> {
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
            && !is_same_value(runtime.console_value, self.hardware_value)
            && ((self.external_grab_armed && !self.hardware_drove_console && console_changed)
                // A clip started from elsewhere attaches a new instance at its own level, so a
                // physical fader that drove the previous instance must be picked up again.
                || (runtime.attached_instance_id.is_some()
                    && runtime.attached_instance_id != self.attached_instance_id))
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
        runtime: FaderRuntimeState,
    ) -> FaderActions {
        let clamped_console_value = clamp_percent(next_console_value);

        if runtime.is_clip_active && is_same_value(clamped_console_value, runtime.console_value) {
            tracing::debug!(
                runtime_console_value = runtime.console_value,
                incoming_console_value = clamped_console_value,
                "Ignoring no-op fader value"
            );
            return FaderActions::default();
        }

        self.pending_console_sync = false;
        self.hardware_drove_console = false;
        self.pending_console_value = None;
        self.is_grabbed = is_same_value(clamped_console_value, self.hardware_value);
        // An on-screen move never claims the console for this fader's hardware, so another
        // fader or source moving the same target must still release it to follow the console.
        self.external_grab_armed = true;
        self.attached_instance_id = runtime.attached_instance_id;

        if !runtime.is_clip_active {
            if clamped_console_value > FADER_EPSILON {
                self.pending_console_value = Some(clamped_console_value);
                return FaderActions {
                    should_start_clip: true,
                    ..Default::default()
                };
            }

            return FaderActions::default();
        }

        if clamped_console_value <= FADER_EPSILON && runtime.console_value > FADER_EPSILON {
            return FaderActions {
                should_stop_clip: true,
                ..Default::default()
            };
        }

        if runtime.attached_instance_id.is_none() {
            self.pending_console_value = Some(clamped_console_value);
            return FaderActions::default();
        }

        if is_same_value(clamped_console_value, runtime.console_value) {
            return FaderActions::default();
        }

        FaderActions {
            intensity_value: Some(clamped_console_value / 100.0),
            ..Default::default()
        }
    }

    fn handle_hardware_value(
        &mut self,
        next_hardware_value: f32,
        runtime: FaderRuntimeState,
    ) -> FaderActions {
        let clamped_hardware_value = clamp_percent(next_hardware_value);
        let previous_hardware_value = self.hardware_value;
        self.hardware_value = clamped_hardware_value;

        if !runtime.is_clip_active {
            if clamped_hardware_value > FADER_EPSILON
                && !self.pending_console_sync
                && (previous_hardware_value <= FADER_EPSILON
                    || runtime.console_value <= FADER_EPSILON)
            {
                self.is_grabbed = true;
                self.pending_console_sync = runtime.attached_instance_id.is_none();
                self.attached_instance_id = runtime.attached_instance_id;
                return FaderActions {
                    should_start_clip: true,
                    ..Default::default()
                };
            }

            self.attached_instance_id = runtime.attached_instance_id;
            return FaderActions::default();
        }

        if !self.is_grabbed {
            if !crossed_console_value(
                previous_hardware_value,
                clamped_hardware_value,
                runtime.console_value,
            ) {
                self.attached_instance_id = runtime.attached_instance_id;
                return FaderActions::default();
            }

            self.is_grabbed = true;
        }

        if clamped_hardware_value <= FADER_EPSILON && previous_hardware_value > FADER_EPSILON {
            self.attached_instance_id = runtime.attached_instance_id;
            return FaderActions {
                should_stop_clip: true,
                ..Default::default()
            };
        }

        if runtime.attached_instance_id.is_none() {
            self.pending_console_sync = true;
            self.attached_instance_id = runtime.attached_instance_id;
            return FaderActions::default();
        }

        self.attached_instance_id = runtime.attached_instance_id;

        if self.pending_console_sync
            || !is_same_value(clamped_hardware_value, runtime.console_value)
        {
            self.hardware_drove_console = true;
            return FaderActions {
                intensity_value: Some(clamped_hardware_value / 100.0),
                ..Default::default()
            };
        }

        FaderActions::default()
    }

    fn handle_external_hardware_value(
        &mut self,
        next_hardware_value: f32,
        runtime: FaderRuntimeState,
    ) -> FaderActions {
        let clamped_hardware_value = clamp_percent(next_hardware_value);
        let was_grabbed = self.is_grabbed;

        if runtime.is_clip_active
            && self.is_grabbed
            && self.external_grab_armed
            && !self.pending_console_sync
            && runtime.console_value > FADER_EPSILON
            && is_same_value(self.hardware_value, runtime.console_value)
            && !is_same_value(clamped_hardware_value, runtime.console_value)
        {
            tracing::debug!(
                runtime_console_value = runtime.console_value,
                previous_hardware_value = self.hardware_value,
                next_hardware_value = clamped_hardware_value,
                "Fader external hardware detached awaiting pickup"
            );
            self.hardware_value = clamped_hardware_value;
            self.is_grabbed = false;
            self.attached_instance_id = runtime.attached_instance_id;
            return FaderActions::default();
        }

        let actions = self.handle_hardware_value(clamped_hardware_value, runtime);
        if (!was_grabbed && self.is_grabbed)
            || (self.is_grabbed && !is_same_value(clamped_hardware_value, runtime.console_value))
        {
            self.external_grab_armed = false;
            tracing::debug!(
                runtime_console_value = runtime.console_value,
                hardware_value = clamped_hardware_value,
                "Fader external grab disarmed after hardware took control"
            );
        }
        actions
    }
}

/// Action bindings emitted when a fader is moved or pressed.
#[derive(Clone, Copy, Debug, Default)]
struct FaderActions {
    should_start_clip: bool,
    should_stop_clip: bool,
    intensity_value: Option<f32>,
}

/// Persisted target assigned to a desk fader, independent of playback state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FaderAssignment {
    /// Playable clip identifier.
    Clip(u32),
    /// Master identifier.
    Master(u32),
}

/// Persisted configuration of one fader, independent of playback and hardware state.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaderConfig {
    /// Target assigned to the fader and its button, if any.
    pub assignment: Option<FaderAssignment>,
    /// What pressing the fader's button does.
    #[serde(default)]
    pub button_mode: FaderButtonMode,
}

impl FaderConfig {
    /// Builds a fader configuration with the default Go button.
    pub fn assigned(assignment: FaderAssignment) -> Self {
        Self {
            assignment: Some(assignment),
            button_mode: FaderButtonMode::default(),
        }
    }
}

/// Resource storing faders and action assignments.
#[derive(Resource, Clone, Debug)]
pub struct Faders {
    faders: Vec<Fader>,
}

impl Default for Faders {
    fn default() -> Self {
        Self {
            faders: vec![Fader::default(); DEFAULT_FADER_COUNT],
        }
    }
}

impl Faders {
    /// Copy each fader's configuration in fader order without transient playback or hardware state.
    pub fn fader_configs(&self) -> Vec<FaderConfig> {
        self.faders
            .iter()
            .map(|fader| FaderConfig {
                assignment: fader.assignment(),
                button_mode: fader.button_mode,
            })
            .collect()
    }

    /// Restore ordered fader configurations into a fresh bank, leaving unused faders unassigned.
    ///
    /// A button mode that does not fit its fader's assignment falls back to Go.
    pub fn from_configs(configs: &[FaderConfig]) -> Self {
        let mut faders = Self::default();
        faders
            .faders
            .resize(configs.len().max(DEFAULT_FADER_COUNT), Fader::default());
        for (fader, config) in faders.faders.iter_mut().zip(configs) {
            match config.assignment {
                Some(FaderAssignment::Clip(id)) => fader.assigned_clip_id = Some(id),
                Some(FaderAssignment::Master(id)) => fader.assigned_master_id = Some(id),
                None => {}
            }
            fader.button_mode = config.button_mode;
            fader.fit_button_mode_to_assignment();
        }
        faders
    }

    /// Returns how many faders the bank has; valid fader indices are `1..=count`.
    pub fn fader_count(&self) -> usize {
        self.faders.len()
    }

    /// Returns whether a 1-based fader index addresses a fader, whether or not it is assigned.
    pub fn contains(&self, fader_index: u32) -> bool {
        self.fader(fader_index).is_some()
    }

    /// Lists the clips a held Flash or Swop plays at full as `(fader index, clip id, swop)`,
    /// where a Swop also takes every other playback out.
    ///
    /// A flash nobody holds any more, or whose fader was reassigned or switched to another
    /// mode, is left out at once, before [`end_released_flashes`] undoes it on the next frame.
    pub(crate) fn flashed_clips(&self) -> impl Iterator<Item = (u32, u32, bool)> + '_ {
        self.faders
            .iter()
            .zip(1..)
            .filter_map(|(fader, fader_index)| {
                let flash = fader
                    .flash
                    .as_ref()
                    .filter(|flash| flash.still_held_on(fader))?;
                match flash.target {
                    FaderAssignment::Clip(clip_id) => Some((fader_index, clip_id, flash.swop)),
                    FaderAssignment::Master(_) => None,
                }
            })
    }

    /// Holds fader `fader_index`'s assignment as if a web client pressed its Flash or Swop
    /// button, without starting or pushing anything.
    #[cfg(test)]
    pub(crate) fn hold_for_test(&mut self, fader_index: u32) {
        let fader = self.fader_mut(fader_index).expect("fader exists");
        let target = fader.assignment().expect("fader is assigned");
        fader.flash = Some(FaderFlash::new(
            target,
            fader.button_mode,
            ButtonHolder::Client(ClientId(1)),
        ));
    }

    /// Returns a held flash of `target` on any fader other than `fader_index`, which a new
    /// flash of the same target joins instead of changing outputs again.
    fn flash_on(&self, target: &FaderAssignment, fader_index: u32) -> Option<&FaderFlash> {
        let index = self.flash_index_on(target, fader_index)?;
        self.faders[index].flash.as_ref()
    }

    /// Returns the zero-based position of the fader other than `fader_index` that holds a
    /// flash of `target`.
    fn flash_index_on(&self, target: &FaderAssignment, fader_index: u32) -> Option<usize> {
        self.faders.iter().enumerate().position(|(index, fader)| {
            u32::try_from(index + 1).ok() != Some(fader_index)
                && fader
                    .flash
                    .as_ref()
                    .is_some_and(|flash| &flash.target == target && flash.still_held_on(fader))
        })
    }

    /// Reads a fader's live console level (percent) and whether its assignment is running, for
    /// faderler feedback.
    ///
    /// The level matches the console value fader snapshots publish, except while a fader
    /// is still settling a clip it just started, when the fader's own level is reported. A
    /// fader is active while its clip runs or its master contributes (toggle masters only
    /// while on). Unassigned faders read as idle at zero. Returns `None` for an index outside
    /// the bank.
    pub(crate) fn live_state(&self, world: &World, fader_index: u32) -> Option<(f32, bool)> {
        let fader = self.fader(fader_index)?;
        if let Some(clip_id) = fader.assigned_clip_id {
            let (level, active) = clip_live_state(world, clip_id);
            return Some((fader.settling_level().unwrap_or(level), active));
        }
        let master = fader.assigned_master_id.and_then(|master_id| {
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

    fn fader(&self, fader_index: u32) -> Option<&Fader> {
        let zero_based = usize::try_from(fader_index.checked_sub(1)?).ok()?;
        self.faders.get(zero_based)
    }

    fn fader_mut(&mut self, fader_index: u32) -> Option<&mut Fader> {
        let zero_based = usize::try_from(fader_index.checked_sub(1)?).ok()?;
        self.faders.get_mut(zero_based)
    }

    /// Project fader assignments and current playback state into ordered fader snapshots.
    pub(crate) fn snapshots(
        &self,
        clips: &Query<&Clip>,
        masters: &DataProvider<Master>,
        materialized_clips: &Query<&MaterializedClip>,
        instance_index: &InstanceIndex,
        controls_query: &Query<&InstanceControls>,
        held_buttons: &HeldButtonEffects,
    ) -> Vec<FaderSnapshot> {
        self.faders
            .iter()
            .enumerate()
            .map(|(idx, fader)| {
                let runtime = fader
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
                        fader
                            .assigned_master_id
                            .and_then(|master_id| runtime_state_for_master(master_id, masters))
                    })
                    .unwrap_or_default();

                FaderSnapshot {
                    index: (idx + 1) as u32,
                    assigned_clip_id: fader.assigned_clip_id,
                    assigned_master_id: fader.assigned_master_id,
                    hardware_value: fader.has_hardware.then_some(fader.hardware_value),
                    console_value: runtime.console_value,
                    display_value: fader.display_value(runtime),
                    is_grabbed: fader.is_grabbed,
                    is_clip_active: runtime.is_clip_active,
                    attached_instance_id: runtime.attached_instance_id,
                    button_mode: fader.button_mode,
                    available_button_modes: FaderButtonMode::available_for(
                        fader.assignment().as_ref(),
                    ),
                    is_flashing: fader.flash.is_some(),
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
    (left - right).abs() <= FADER_EPSILON
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
) -> Option<FaderRuntimeState> {
    let clip_exists = clips.iter().any(|clip| clip.identifiers.id == clip_id);
    if !clip_exists {
        return None;
    }

    let Some(materialized_clip) = materialized_clips
        .iter()
        .find(|materialized| materialized.clip_id == clip_id)
    else {
        return Some(FaderRuntimeState::default());
    };

    let Some(playback_entity) = instance_index.get(&materialized_clip.attached_instance) else {
        return Some(FaderRuntimeState::default());
    };

    let Ok(controls) = controls_query.get(playback_entity) else {
        return Some(FaderRuntimeState::default());
    };

    Some(FaderRuntimeState {
        console_value: clamp_percent(controls.intensity_scale * 100.0),
        is_clip_active: true,
        attached_instance_id: Some(materialized_clip.attached_instance),
    })
}

/// Reads a clip's console level (percent) and whether it is running, from the live world.
///
/// A clip that is not running, or whose playback has no instance controls yet, reads as
/// level zero, matching the runtime state fader snapshots use.
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
) -> Option<FaderRuntimeState> {
    let master = masters.from_id(master_id).ok()?;
    Some(FaderRuntimeState {
        console_value: master.control_position_percent(),
        is_clip_active: true,
        attached_instance_id: None,
    })
}

fn set_fader_level(fader: &mut Fader, value: f32) -> f32 {
    let value = clamp_percent(value);
    fader.hardware_value = value;
    fader.last_console_value = value;
    fader.pending_console_value = None;
    fader.is_grabbed = true;
    fader.external_grab_armed = true;
    fader.hardware_drove_console = false;
    fader.pending_console_sync = false;
    value
}

fn set_master_fader_level(
    fader: &mut Fader,
    master_id: u32,
    masters: &DataProvider<Master>,
    value: f32,
) -> Option<f32> {
    let kind = masters.from_id(master_id).ok()?.kind;
    let fader_percent = set_fader_level(fader, value);
    Some(Master::level_percent_from_control(kind, fader_percent))
}

/// Applies fallible fader assignment commands and returns one terminal result per command.
pub fn handle_fader_commands(
    mut events: MessageReader<CommandEnvelope<FaderCommand>>,
    mut faders: ResMut<Faders>,
    clips: Query<&Clip>,
    masters: Res<DataProvider<Master>>,
    materialized_clips: Query<&MaterializedClip>,
    instance_index: Res<InstanceIndex>,
    controls_query: Query<&InstanceControls>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let result = match &event.command {
            FaderCommand::AssignClip {
                fader_index,
                clip_id,
            } => assign_clip_to_fader(
                &mut faders,
                *fader_index,
                *clip_id,
                &clips,
                &materialized_clips,
                &instance_index,
                &controls_query,
            ),
            FaderCommand::AssignMaster {
                fader_index,
                master_id,
            } => assign_master_to_fader(&mut faders, *fader_index, *master_id, &masters),
            FaderCommand::ClearClip { fader_index } => clear_fader(&mut faders, *fader_index),
            FaderCommand::SetButtonMode { fader_index, mode } => {
                set_fader_button_mode(&mut faders, *fader_index, *mode)
            }
            FaderCommand::ReleaseHeldButtons => {
                release_held_buttons(&mut faders);
                Ok(())
            }
            FaderCommand::Go { fader_index }
            | FaderCommand::PressButton { fader_index }
            | FaderCommand::ReleaseButton { fader_index } => Err(CommandError::new(
                "fader.button_not_expanded",
                format!(
                    "Button input for fader {fader_index} must be queued through command expansion"
                ),
            )),
        };
        finish_fader_command(&mut responder, event.command_id, result);
    }
}

/// Assigns one clip to a fader after validating both domain references.
fn assign_clip_to_fader(
    faders: &mut Faders,
    fader_index: u32,
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
    let fader = faders.fader_mut(fader_index).ok_or_else(|| {
        CommandError::new(
            "fader.not_found",
            format!("Fader {fader_index} does not exist"),
        )
    })?;

    fader.assigned_clip_id = Some(clip_id);
    fader.assigned_master_id = None;
    fader.reset_to(runtime.console_value);
    fader.attached_instance_id = runtime.attached_instance_id;
    fader.fit_button_mode_to_assignment();
    Ok(())
}

/// Assigns one master to a fader after validating both domain references.
fn assign_master_to_fader(
    faders: &mut Faders,
    fader_index: u32,
    master_id: u32,
    masters: &DataProvider<Master>,
) -> Result<(), CommandError> {
    let runtime = runtime_state_for_master(master_id, masters).ok_or_else(|| {
        CommandError::new(
            "master.not_found",
            format!("Cannot assign missing master {master_id}"),
        )
    })?;
    let fader = faders.fader_mut(fader_index).ok_or_else(|| {
        CommandError::new(
            "fader.not_found",
            format!("Fader {fader_index} does not exist"),
        )
    })?;

    fader.assigned_clip_id = None;
    fader.assigned_master_id = Some(master_id);
    fader.reset_to(runtime.console_value);
    fader.attached_instance_id = None;
    fader.fit_button_mode_to_assignment();
    Ok(())
}

/// Sets a fader's button mode, rejecting modes its current assignment cannot use.
fn set_fader_button_mode(
    faders: &mut Faders,
    fader_index: u32,
    mode: FaderButtonMode,
) -> Result<(), CommandError> {
    let fader = faders.fader_mut(fader_index).ok_or_else(|| {
        CommandError::new(
            "fader.not_found",
            format!("Fader {fader_index} does not exist"),
        )
    })?;
    if !mode.supports(fader.assignment().as_ref()) {
        return Err(CommandError::new(
            "fader.button_mode_unsupported",
            format!("Fader {fader_index} cannot use the {mode:?} button mode"),
        ));
    }
    fader.button_mode = mode;
    Ok(())
}

/// Clears one fader assignment or reports an invalid fader reference.
fn clear_fader(faders: &mut Faders, fader_index: u32) -> Result<(), CommandError> {
    let fader = faders.fader_mut(fader_index).ok_or_else(|| {
        CommandError::new(
            "fader.not_found",
            format!("Fader {fader_index} does not exist"),
        )
    })?;
    fader.clear();
    Ok(())
}

/// One edge of button input addressed to a fader.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FaderButtonInput {
    /// An explicit Go, regardless of the fader's button mode.
    Go(u32),
    /// A press, running the fader's button mode.
    Press(u32),
    /// A release of a previous press.
    Release(u32),
}

impl FaderButtonInput {
    /// Extracts button input from a fader command, or `None` for other fader commands.
    fn from_command(command: &FaderCommand) -> Option<Self> {
        match *command {
            FaderCommand::Go { fader_index } => Some(Self::Go(fader_index)),
            FaderCommand::PressButton { fader_index } => Some(Self::Press(fader_index)),
            FaderCommand::ReleaseButton { fader_index } => Some(Self::Release(fader_index)),
            _ => None,
        }
    }
}

/// Replaces queued fader button commands with the clip or master command they resolve to.
///
/// Handles explicit Go and the press and release of the fader's button. Runs in the pending
/// command expansion stage so the concrete command inherits the button command's identity and
/// undo group and dispatches in the same frame. Input that has nothing to do for the fader's
/// assignment and playback state, such as Go on an empty fader or any release, completes
/// without effect.
pub fn expand_fader_button_commands(
    mut pending: ResMut<PendingCommandBuffer>,
    mut faders: ResMut<Faders>,
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
            .downcast_ref::<FaderCommand>()
            .and_then(FaderButtonInput::from_command)
        else {
            pending.push(envelope);
            continue;
        };
        let holder = button_holder(&responder, envelope.command_id);
        let held_input = match input {
            FaderButtonInput::Press(fader_index) => faders
                .fader(fader_index)
                .is_some_and(|fader| fader.button_mode.is_held())
                .then(|| {
                    press_flash(
                        &mut faders,
                        fader_index,
                        holder,
                        &clips,
                        &materialized_clips,
                        &mut flash_outputs,
                    )
                }),
            FaderButtonInput::Release(fader_index) => {
                Some(release_flash(&mut faders, fader_index, &holder))
            }
            FaderButtonInput::Go(_) => None,
        };
        if let Some(result) = held_input {
            finish_fader_command(&mut responder, envelope.command_id, result);
            continue;
        }
        match resolve_fader_button(&faders, input, &clips, &materialized_clips, &masters) {
            Ok(Some(command)) => pending.push(PayloadEnvelope::with_context(
                envelope.command_id,
                envelope.undo_id,
                command,
            )),
            Ok(None) => finish_fader_command(&mut responder, envelope.command_id, Ok(())),
            Err(error) => {
                finish_fader_command(&mut responder, envelope.command_id, Err(error));
            }
        }
    }
}

/// Decides which command a fader's button input runs for its assignment and playback state.
///
/// Go and presses in Go mode start or advance the clip; Go back steps a running sequence
/// back; Toggle starts an idle clip or stops a running one; Release stops a running clip.
/// Toggle-mode masters toggle in Go and Toggle modes. Releases do nothing yet.
fn resolve_fader_button(
    faders: &Faders,
    input: FaderButtonInput,
    clips: &Query<&Clip>,
    materialized_clips: &Query<&MaterializedClip>,
    masters: &DataProvider<Master>,
) -> Result<Option<DynEnginePayload>, CommandError> {
    let fader_index = match input {
        FaderButtonInput::Go(index)
        | FaderButtonInput::Press(index)
        | FaderButtonInput::Release(index) => index,
    };
    let fader = faders.fader(fader_index).ok_or_else(|| {
        CommandError::new(
            "fader.not_found",
            format!("Fader {fader_index} does not exist"),
        )
    })?;
    let mode = match input {
        FaderButtonInput::Go(_) => FaderButtonMode::Go,
        FaderButtonInput::Press(_) => fader.button_mode,
        FaderButtonInput::Release(_) => return Ok(None),
    };
    if let Some(master_id) = fader.assigned_master_id {
        let master = masters.from_id(master_id).map_err(|_| {
            CommandError::new(
                "master.not_found",
                format!("Assigned master {master_id} does not exist"),
            )
        })?;
        let toggles = matches!(mode, FaderButtonMode::Go | FaderButtonMode::Toggle)
            && matches!(master.mode, MasterMode::Toggle { .. });
        return Ok(toggles
            .then(|| Box::new(MasterCommand::ToggleMaster { id: master_id }) as DynEnginePayload));
    }
    let Some(clip_id) = fader.assigned_clip_id else {
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
        (FaderButtonMode::Go, true) => is_sequence.then_some(ClipCommand::GoClip(target)),
        (FaderButtonMode::Go | FaderButtonMode::Toggle, false) => {
            Some(ClipCommand::StartClip(target))
        }
        (FaderButtonMode::GoBack, true) => is_sequence.then_some(ClipCommand::BackClip(target)),
        (FaderButtonMode::Toggle | FaderButtonMode::Release, true) => {
            Some(ClipCommand::StopClip(target))
        }
        (FaderButtonMode::GoBack | FaderButtonMode::Release, false) => None,
        // Held modes are handled by `press_flash` before resolving.
        (FaderButtonMode::Flash | FaderButtonMode::Swop, _) => None,
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

/// Holds a Flash or Swop on a fader: the first press starts it, and later presses from other
/// surfaces only add holders so the flash lasts until the last one lets go.
///
/// Pressing an empty fader does nothing. A clip that is not running is started with its
/// fader level at zero, so it shows only while the button is held.
fn press_flash(
    faders: &mut Faders,
    fader_index: u32,
    holder: ButtonHolder,
    clips: &Query<&Clip>,
    materialized_clips: &Query<&MaterializedClip>,
    flash_outputs: &mut FlashOutputs,
) -> Result<(), CommandError> {
    let shared = {
        let fader = faders
            .fader(fader_index)
            .ok_or_else(|| fader_not_found(fader_index))?;
        fader
            .assignment()
            .and_then(|target| faders.flash_on(&target, fader_index))
            .map(|flash| flash.restore_master_position)
    };
    let fader = faders
        .fader_mut(fader_index)
        .ok_or_else(|| fader_not_found(fader_index))?;
    if fader.flash.as_ref().is_some_and(|flash| flash.fits(fader))
        && let Some(flash) = fader.flash.as_mut()
    {
        if !flash.holders.contains(&holder) {
            flash.holders.push(holder);
        }
        return Ok(());
    }
    let Some(target) = fader.assignment() else {
        return Ok(());
    };
    if let FaderAssignment::Clip(clip_id) = target
        && !clips.iter().any(|clip| clip.identifiers.id == clip_id)
    {
        return Err(CommandError::new(
            "clip.not_found",
            format!("Assigned clip {clip_id} does not exist"),
        ));
    }
    let stale = fader.flash.take();
    let result = match shared {
        Some(restore_master_position) => {
            fader.flash = Some(FaderFlash {
                restore_master_position,
                ..FaderFlash::new(target, fader.button_mode, holder)
            });
            Ok(())
        }
        None => flash_outputs.start(fader, target, holder, materialized_clips),
    };
    if let Some(stale) = stale {
        end_flash(faders, fader_index, stale, flash_outputs);
    }
    result
}

/// Lets go of one holder's press of a fader's button. The flash itself ends in
/// [`end_released_flashes`] once nobody holds it.
///
/// Releases that let go of nothing, such as every release of a Go button, leave the bank
/// untouched so they do not re-broadcast fader snapshots.
fn release_flash(
    faders: &mut ResMut<Faders>,
    fader_index: u32,
    holder: &ButtonHolder,
) -> Result<(), CommandError> {
    let fader = faders
        .fader(fader_index)
        .ok_or_else(|| fader_not_found(fader_index))?;
    let is_holding = fader
        .flash
        .as_ref()
        .is_some_and(|flash| flash.holders.contains(holder));
    if is_holding
        && let Some(flash) = faders
            .fader_mut(fader_index)
            .and_then(|fader| fader.flash.as_mut())
    {
        flash.holders.retain(|held| held != holder);
    }
    Ok(())
}

/// Drops every holder of every held flash, so [`end_released_flashes`] ends them all and
/// undoes what they did. Leaves the bank untouched when nothing is held.
fn release_held_buttons(faders: &mut ResMut<Faders>) {
    if faders.faders.iter().all(|fader| fader.flash.is_none()) {
        return;
    }
    for flash in faders
        .faders
        .iter_mut()
        .filter_map(|fader| fader.flash.as_mut())
    {
        flash.holders.clear();
    }
}

/// Builds the error for button input addressed to a fader the bank does not have.
fn fader_not_found(fader_index: u32) -> CommandError {
    CommandError::new(
        "fader.not_found",
        format!("Fader {fader_index} does not exist"),
    )
}

/// Playback and master changes a fader Flash or Swop makes when it starts and ends.
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
    /// Starts a flash of `target` held by `holder` on `fader`.
    ///
    /// An idle clip starts with its fader level queued at zero, so the instance shows only
    /// through the flash. A master records its position and goes to full.
    fn start(
        &mut self,
        fader: &mut Fader,
        target: FaderAssignment,
        holder: ButtonHolder,
        materialized_clips: &Query<&MaterializedClip>,
    ) -> Result<(), CommandError> {
        let mut flash = FaderFlash::new(target.clone(), fader.button_mode, holder);
        match target {
            FaderAssignment::Clip(clip_id) => {
                let running = materialized_clips
                    .iter()
                    .any(|materialized| materialized.clip_id == clip_id);
                if !running {
                    flash.started_clip = true;
                    fader.pending_console_value = Some(0.0);
                    self.clip_writer.write(EngineOperationEnvelope::detached(
                        ClipOperation::Start(IdExpr::Single(clip_id)),
                    ));
                }
            }
            FaderAssignment::Master(master_id) => {
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
        fader.flash = Some(flash);
        Ok(())
    }

    /// Undoes what a flash did: stops a clip it started unless its fader was raised while
    /// held, and returns a master to its position from before the press unless something
    /// else moved it meanwhile.
    ///
    /// The master still reads its pre-press position when press and release land in the
    /// same frame, before the push to full applies, so that position is restored too.
    fn end(&mut self, flash: FaderFlash, fader_raised: bool) {
        match flash.target {
            FaderAssignment::Clip(clip_id) if flash.started_clip && !fader_raised => {
                self.clip_writer
                    .write(EngineOperationEnvelope::detached(ClipOperation::Stop(
                        IdExpr::Single(clip_id),
                    )));
            }
            FaderAssignment::Clip(_) => {}
            FaderAssignment::Master(master_id) => {
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

/// Ends fader flashes nobody holds any more: after the last release, when the client holding
/// them disconnects, or when the fader is reassigned or switched to another mode.
///
/// A dropped phone or closed tab therefore never leaves a flash latched.
pub fn end_released_flashes(
    mut faders: ResMut<Faders>,
    mut disconnects: MessageReader<ClientDisconnected>,
    mut flash_outputs: FlashOutputs,
) {
    let disconnected: Vec<ClientId> = disconnects.read().map(|event| event.client).collect();
    let disconnected_holder = |holder: &ButtonHolder| matches!(holder, ButtonHolder::Client(client) if disconnected.contains(client));
    let needs_update = faders.faders.iter().any(|fader| {
        fader.flash.as_ref().is_some_and(|flash| {
            !flash.still_held_on(fader) || flash.holders.iter().any(disconnected_holder)
        })
    });
    if !needs_update {
        return;
    }
    let mut ended = Vec::new();
    for (index, fader) in faders.faders.iter_mut().enumerate() {
        let Some(mut flash) = fader.flash.take() else {
            continue;
        };
        flash.holders.retain(|holder| !disconnected_holder(holder));
        if flash.still_held_on(fader) {
            fader.flash = Some(flash);
        } else if let Ok(fader_index) = u32::try_from(index + 1) {
            ended.push((fader_index, flash));
        }
    }
    for (fader_index, flash) in ended {
        end_flash(&mut faders, fader_index, flash, &mut flash_outputs);
    }
}

/// Ends a flash taken off fader `fader_index`.
///
/// When another fader still flashes the same target, that flash takes over stopping a clip
/// this one started, so the target stays flashed until the last fader lets go. Otherwise the
/// outputs are undone, keeping a started clip running if this fader was raised while
/// the button was held.
fn end_flash(
    faders: &mut Faders,
    fader_index: u32,
    flash: FaderFlash,
    flash_outputs: &mut FlashOutputs,
) {
    if let Some(index) = faders.flash_index_on(&flash.target, fader_index) {
        if let Some(other) = faders.faders[index].flash.as_mut() {
            other.started_clip |= flash.started_clip;
        }
        return;
    }
    let fader_raised = faders.fader(fader_index).is_some_and(|fader| {
        fader.assignment().as_ref() == Some(&flash.target)
            && !is_same_value(
                fader
                    .pending_console_value
                    .unwrap_or(fader.last_console_value),
                0.0,
            )
    });
    flash_outputs.end(flash, fader_raised);
}

/// Publishes the terminal outcome for one fader assignment command.
fn finish_fader_command(
    responder: &mut CommandResponder,
    command_id: CommandId,
    result: Result<(), CommandError>,
) {
    let response = match result {
        Ok(()) => responder.succeed(command_id),
        Err(error) => responder.fail(command_id, error),
    };
    if let Err(error) = response {
        tracing::error!(%command_id, %error, "fader_command_completion_failed");
    }
}

/// Applies continuous fader changes without creating command or undo state.
pub fn handle_fader_updates(
    mut events: MessageReader<FaderUpdate>,
    mut faders: ResMut<Faders>,
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
            FaderUpdate::SetConsoleValue { fader_index, value } => {
                let Some(fader) = faders.fader_mut(*fader_index) else {
                    tracing::warn!(
                        fader_index = *fader_index,
                        "Ignoring out-of-range fader value"
                    );
                    continue;
                };

                if let Some(master_id) = fader.assigned_master_id {
                    let Some(level_percent) =
                        set_master_fader_level(fader, master_id, &masters, *value)
                    else {
                        fader.clear();
                        continue;
                    };
                    master_writer.write(MasterUpdate::SetLevel {
                        id: master_id,
                        level_percent,
                    });
                    continue;
                }

                let Some(clip_id) = fader.assigned_clip_id else {
                    continue;
                };

                let Some(runtime) = runtime_state_for_clip(
                    clip_id,
                    &clips,
                    &materialized_clips,
                    &instance_index,
                    &controls_query,
                ) else {
                    fader.clear();
                    continue;
                };

                let actions = fader.handle_console_value(*value, runtime);

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
            FaderUpdate::SetHardwareValue { fader_index, value } => {
                let Some(fader) = faders.fader_mut(*fader_index) else {
                    tracing::warn!(
                        fader_index = *fader_index,
                        "Ignoring out-of-range fader value"
                    );
                    continue;
                };
                fader.has_hardware = true;

                if let Some(master_id) = fader.assigned_master_id {
                    let Some(level_percent) =
                        set_master_fader_level(fader, master_id, &masters, *value)
                    else {
                        fader.clear();
                        continue;
                    };
                    master_writer.write(MasterUpdate::SetLevel {
                        id: master_id,
                        level_percent,
                    });
                    continue;
                }

                let Some(clip_id) = fader.assigned_clip_id else {
                    fader.hardware_value = clamp_percent(*value);
                    continue;
                };

                let Some(runtime) = runtime_state_for_clip(
                    clip_id,
                    &clips,
                    &materialized_clips,
                    &instance_index,
                    &controls_query,
                ) else {
                    fader.clear();
                    continue;
                };

                let actions = fader.handle_hardware_value(*value, runtime);

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
            FaderUpdate::SetExternalHardwareValue { fader_index, value } => {
                let Some(fader) = faders.fader_mut(*fader_index) else {
                    tracing::warn!(
                        fader_index = *fader_index,
                        "Ignoring out-of-range external fader value"
                    );
                    continue;
                };
                fader.has_hardware = true;

                if let Some(master_id) = fader.assigned_master_id {
                    let Some(level_percent) =
                        set_master_fader_level(fader, master_id, &masters, *value)
                    else {
                        fader.clear();
                        continue;
                    };
                    master_writer.write(MasterUpdate::SetLevel {
                        id: master_id,
                        level_percent,
                    });
                    continue;
                }

                let Some(clip_id) = fader.assigned_clip_id else {
                    fader.hardware_value = clamp_percent(*value);
                    fader.is_grabbed = false;
                    continue;
                };

                let Some(runtime) = runtime_state_for_clip(
                    clip_id,
                    &clips,
                    &materialized_clips,
                    &instance_index,
                    &controls_query,
                ) else {
                    fader.clear();
                    continue;
                };

                let was_grabbed = fader.is_grabbed;
                let was_external_grab_armed = fader.external_grab_armed;
                let actions = fader.handle_external_hardware_value(*value, runtime);
                tracing::debug!(
                    fader_index = *fader_index,
                    clip_id,
                    incoming_value = *value,
                    runtime_console_value = runtime.console_value,
                    runtime_clip_active = runtime.is_clip_active,
                    runtime_attached_instance_id = ?runtime.attached_instance_id,
                    is_grabbed_before = was_grabbed,
                    is_grabbed_after = fader.is_grabbed,
                    external_grab_armed_before = was_external_grab_armed,
                    external_grab_armed_after = fader.external_grab_armed,
                    pending_console_sync = fader.pending_console_sync,
                    hardware_drove_console = fader.hardware_drove_console,
                    action_start_clip = actions.should_start_clip,
                    action_stop_clip = actions.should_stop_clip,
                    action_intensity_value = ?actions.intensity_value,
                    "Handled external fader hardware value"
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

pub fn sync_fader_state(
    mut faders: ResMut<Faders>,
    clips: Query<&Clip>,
    masters: Res<DataProvider<Master>>,
    materialized_clips: Query<&MaterializedClip>,
    instance_index: Res<InstanceIndex>,
    controls_query: Query<&InstanceControls>,
    mut playback_control_writer: MessageWriter<InstanceControlUpdate>,
) {
    let mut next_faders = faders.faders.clone();

    for fader in &mut next_faders {
        let runtime = if let Some(clip_id) = fader.assigned_clip_id {
            let Some(runtime) = runtime_state_for_clip(
                clip_id,
                &clips,
                &materialized_clips,
                &instance_index,
                &controls_query,
            ) else {
                fader.clear();
                continue;
            };
            runtime
        } else if let Some(master_id) = fader.assigned_master_id {
            let Some(runtime) = runtime_state_for_master(master_id, &masters) else {
                fader.clear();
                continue;
            };
            runtime
        } else {
            fader.attached_instance_id = None;
            continue;
        };

        let pending_intensity = fader.sync_from_runtime(runtime);
        if let (Some(intensity_value), Some(instance_id)) =
            (pending_intensity, runtime.attached_instance_id)
        {
            let target_id = fader.assigned_clip_id.or(fader.assigned_master_id);
            tracing::debug!(
                ?target_id,
                instance_id = ?instance_id,
                runtime_console_value = runtime.console_value,
                fader_hardware_value = fader.hardware_value,
                fader_is_grabbed = fader.is_grabbed,
                fader_external_grab_armed = fader.external_grab_armed,
                fader_pending_console_sync = fader.pending_console_sync,
                fader_hardware_drove_console = fader.hardware_drove_console,
                intensity_value,
                "Syncing fader runtime intensity"
            );
            playback_control_writer.write(InstanceControlUpdate::SetIntensityScale {
                instance_id,
                value: intensity_value,
            });
        }
    }

    if next_faders != faders.faders {
        faders.faders = next_faders;
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};

    use super::*;

    /// Builds the focused resources needed by fader command lifecycle tests.
    fn fader_command_app() -> App {
        let mut app = App::new();
        app.init_resource::<Faders>();
        app.init_resource::<DataProvider<Master>>();
        app.init_resource::<InstanceIndex>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<FaderCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNoticeReply>();
        app.add_systems(Update, handle_fader_commands);
        app
    }

    /// Builds an app running only button expansion over a faderled pending buffer.
    fn fader_go_app() -> App {
        let mut app = fader_command_app();
        app.init_resource::<PendingCommandBuffer>();
        app.add_message::<EngineOperationEnvelope<ClipOperation>>();
        app.add_message::<MasterUpdate>();
        app.add_message::<ClientDisconnected>();
        app.add_systems(
            Update,
            (expand_fader_button_commands, end_released_flashes).chain(),
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

    /// Queues Go for fader 1 after assigning it, and returns what expansion produced.
    fn expand_go(app: &mut App, assignment: FaderAssignment) -> Vec<PayloadEnvelope> {
        expand_button(
            app,
            FaderConfig::assigned(assignment),
            FaderCommand::Go { fader_index: 1 },
        )
    }

    /// Configures fader 1, queues one button command for it, and returns what expansion
    /// produced.
    fn expand_button(
        app: &mut App,
        config: FaderConfig,
        command: FaderCommand,
    ) -> Vec<PayloadEnvelope> {
        let mut faders = Faders::from_configs(&[config]);
        std::mem::swap(&mut *app.world_mut().resource_mut::<Faders>(), &mut faders);
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
        let mut app = fader_go_app();
        spawn_clip(&mut app, 7, Some(Source::Sequence(uuid::Uuid::nil())), true);
        spawn_clip(
            &mut app,
            8,
            Some(Source::Sequence(uuid::Uuid::nil())),
            false,
        );

        let running = expand_go(&mut app, FaderAssignment::Clip(7));
        let idle = expand_go(&mut app, FaderAssignment::Clip(8));

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
        let mut app = fader_go_app();
        spawn_clip(&mut app, 9, Some(Source::Fx(uuid::Uuid::nil())), true);

        let expanded = expand_go(&mut app, FaderAssignment::Clip(9));

        assert!(expanded.is_empty());
        assert_eq!(
            take_fader_result(&mut app).outcome,
            CommandOutcome::succeeded()
        );
    }

    /// Verifies Go toggles toggle-mode masters and ignores always-on masters.
    #[test]
    fn go_toggles_only_toggle_mode_masters() {
        let mut app = fader_go_app();
        add_master(&mut app, 1, MasterMode::Toggle { active: false });
        add_master(&mut app, 2, MasterMode::AlwaysOn);

        let toggle = expand_go(&mut app, FaderAssignment::Master(1));
        let always_on = expand_go(&mut app, FaderAssignment::Master(2));

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

    /// Presses the button of fader 1 holding `clip_id` in `mode` and returns the clip
    /// command expansion produced, if any.
    fn press_clip_button(
        app: &mut App,
        clip_id: u32,
        mode: FaderButtonMode,
    ) -> Option<ClipCommand> {
        let expanded = expand_button(
            app,
            FaderConfig {
                assignment: Some(FaderAssignment::Clip(clip_id)),
                button_mode: mode,
            },
            FaderCommand::PressButton { fader_index: 1 },
        );
        match expanded.as_slice() {
            [] => None,
            [envelope] => clip_command(envelope).cloned(),
            _ => panic!("one press should expand to at most one command"),
        }
    }

    /// Verifies each button mode's press on running and idle sequence and effect clips.
    #[test]
    fn button_press_runs_the_fader_mode_for_clips() {
        let mut app = fader_go_app();
        let sequence = || Some(Source::Sequence(uuid::Uuid::nil()));
        spawn_clip(&mut app, 1, sequence(), true);
        spawn_clip(&mut app, 2, sequence(), false);
        spawn_clip(&mut app, 3, Some(Source::Fx(uuid::Uuid::nil())), true);
        let single = IdExpr::Single;

        use FaderButtonMode::{Go, GoBack, Release, Toggle};
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
        let mut app = fader_go_app();
        spawn_clip(&mut app, 1, Some(Source::Fx(uuid::Uuid::nil())), true);

        let expanded = expand_button(
            &mut app,
            FaderConfig {
                assignment: Some(FaderAssignment::Clip(1)),
                button_mode: FaderButtonMode::Toggle,
            },
            FaderCommand::ReleaseButton { fader_index: 1 },
        );

        assert!(expanded.is_empty());
        assert_eq!(
            take_fader_result(&mut app).outcome,
            CommandOutcome::succeeded()
        );
    }

    /// Verifies a Toggle-mode press toggles a toggle-mode master.
    #[test]
    fn toggle_button_press_toggles_master() {
        let mut app = fader_go_app();
        add_master(&mut app, 4, MasterMode::Toggle { active: true });

        let expanded = expand_button(
            &mut app,
            FaderConfig {
                assignment: Some(FaderAssignment::Master(4)),
                button_mode: FaderButtonMode::Toggle,
            },
            FaderCommand::PressButton { fader_index: 1 },
        );

        assert!(matches!(
            expanded.as_slice(),
            [envelope] if matches!(
                envelope.payload.as_any().downcast_ref::<MasterCommand>(),
                Some(MasterCommand::ToggleMaster { id: 4 })
            )
        ));
    }

    /// Verifies setting a clip-only mode on a master fader fails and keeps the previous mode.
    #[test]
    fn set_button_mode_rejects_modes_the_assignment_cannot_use() {
        let mut app = fader_command_app();
        *app.world_mut().resource_mut::<Faders>() =
            Faders::from_configs(&[FaderConfig::assigned(FaderAssignment::Master(1))]);

        submit_fader_command(
            &mut app,
            FaderCommand::SetButtonMode {
                fader_index: 1,
                mode: FaderButtonMode::Release,
            },
        );
        app.update();

        assert!(matches!(
            take_fader_result(&mut app).outcome,
            CommandOutcome::Failed(error) if error.code == "fader.button_mode_unsupported"
        ));
        assert_eq!(
            app.world().resource::<Faders>().faders[0].button_mode,
            FaderButtonMode::Go
        );
    }

    /// Verifies a fader keeps its mode when cleared and drops a clip-only mode when a master
    /// is assigned.
    #[test]
    fn button_mode_survives_clear_and_fits_new_master_assignment() {
        let mut fader = Fader {
            assigned_clip_id: Some(1),
            button_mode: FaderButtonMode::Release,
            ..Fader::default()
        };

        fader.clear();
        assert_eq!(fader.button_mode, FaderButtonMode::Release);

        fader.assigned_master_id = Some(2);
        fader.fit_button_mode_to_assignment();
        assert_eq!(fader.button_mode, FaderButtonMode::Go);
    }

    /// Registers and submits one fader command to the focused app.
    fn submit_fader_command(app: &mut App, command: FaderCommand) -> CommandId {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let command_id = envelope.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("fader command should register");
        app.world_mut().write_message(envelope);
        command_id
    }

    /// Drains the terminal result emitted for one fader command.
    fn take_fader_result(app: &mut App) -> CommandResult {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("fader command should return a terminal result")
    }

    /// Verifies a valid assignment clear returns terminal success.
    #[test]
    fn clear_fader_returns_success() {
        let mut app = fader_command_app();
        let command_id = submit_fader_command(&mut app, FaderCommand::ClearClip { fader_index: 1 });

        app.update();

        let result = take_fader_result(&mut app);
        assert_eq!(result.command_id, command_id);
        assert!(matches!(result.outcome, CommandOutcome::Succeeded { .. }));
    }

    /// Verifies an invalid fader reference returns a stable structured failure.
    #[test]
    fn missing_fader_returns_failure() {
        let mut app = fader_command_app();
        submit_fader_command(&mut app, FaderCommand::ClearClip { fader_index: 99 });

        app.update();

        assert!(matches!(
            take_fader_result(&mut app).outcome,
            CommandOutcome::Failed(error) if error.code == "fader.not_found"
        ));
    }

    /// Restoring assignments resets hardware pickup and pending playback changes without losing targets.
    #[test]
    fn persisted_assignments_exclude_runtime_state() {
        let mut faders = Faders::from_configs(&[
            FaderConfig {
                assignment: Some(FaderAssignment::Clip(1)),
                button_mode: FaderButtonMode::Toggle,
            },
            FaderConfig::default(),
            FaderConfig::assigned(FaderAssignment::Master(2)),
        ]);
        let fader = faders.fader_mut(1).unwrap();
        fader.reset_to(80.0);
        fader.pending_console_sync = true;
        let restored = Faders::from_configs(&faders.fader_configs());
        assert_eq!(restored.fader_configs(), faders.fader_configs());
        assert_eq!(
            restored.faders[0],
            Fader {
                assigned_clip_id: Some(1),
                button_mode: FaderButtonMode::Toggle,
                ..Fader::default()
            }
        );
        assert_eq!(restored.faders[1], Fader::default());
    }

    /// Verifies a restored button mode that does not fit its master assignment falls back to Go.
    #[test]
    fn restored_master_fader_drops_clip_only_button_mode() {
        let faders = Faders::from_configs(&[FaderConfig {
            assignment: Some(FaderAssignment::Master(2)),
            button_mode: FaderButtonMode::GoBack,
        }]);

        assert_eq!(faders.faders[0].button_mode, FaderButtonMode::Go);
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

    /// Builds a button app whose fader 1 holds `assignment` in `mode`.
    fn flash_app(assignment: FaderAssignment, mode: FaderButtonMode) -> App {
        let mut app = fader_go_app();
        app.insert_resource(Faders::from_configs(&[FaderConfig {
            assignment: Some(assignment),
            button_mode: mode,
        }]));
        app
    }

    /// Sends one press or release of fader 1 from `origin`, replying to `client` when set,
    /// and runs a frame.
    fn send_button(
        app: &mut App,
        command: FaderCommand,
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
        command: FaderCommand,
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

    /// Presses fader 1 from the web client.
    fn press_web(app: &mut App) {
        send_button(
            app,
            FaderCommand::PressButton { fader_index: 1 },
            CommandOrigin::WebUi,
            Some(WEB_CLIENT),
        );
    }

    /// Releases fader 1 from the web client.
    fn release_web(app: &mut App) {
        send_button(
            app,
            FaderCommand::ReleaseButton { fader_index: 1 },
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

    /// Returns whether fader 1 has a flash held.
    fn is_flashing(app: &App) -> bool {
        app.world().resource::<Faders>().faders[0].flash.is_some()
    }

    /// Verifies a Flash on an idle clip starts it with its fader queued at zero, plays it at
    /// full only while held, and stops it again on release.
    #[test]
    fn flash_on_idle_clip_starts_it_until_release() {
        let mut app = flash_app(FaderAssignment::Clip(5), FaderButtonMode::Flash);
        spawn_clip(&mut app, 5, Some(Source::Fx(uuid::Uuid::nil())), false);

        press_web(&mut app);
        assert_eq!(take_clip_operations(&mut app), [(true, 5)]);
        let faders = app.world().resource::<Faders>();
        assert_eq!(faders.flashed_clips().collect::<Vec<_>>(), [(1, 5, false)]);
        assert_eq!(faders.faders[0].pending_console_value, Some(0.0));

        release_web(&mut app);
        assert_eq!(take_clip_operations(&mut app), [(false, 5)]);
        assert!(!is_flashing(&app));
    }

    /// Verifies a Flash on a running clip leaves it running when let go, and that a Swop
    /// reports its clip as soloed.
    #[test]
    fn swop_on_running_clip_leaves_it_running() {
        let mut app = flash_app(FaderAssignment::Clip(5), FaderButtonMode::Swop);
        spawn_clip(&mut app, 5, Some(Source::Fx(uuid::Uuid::nil())), true);

        press_web(&mut app);
        assert!(take_clip_operations(&mut app).is_empty());
        assert_eq!(
            app.world()
                .resource::<Faders>()
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
        let mut app = flash_app(FaderAssignment::Clip(5), FaderButtonMode::Flash);
        spawn_clip(&mut app, 5, Some(Source::Fx(uuid::Uuid::nil())), false);

        press_web(&mut app);
        send_button(
            &mut app,
            FaderCommand::PressButton { fader_index: 1 },
            midi_origin(),
            None,
        );
        assert_eq!(take_clip_operations(&mut app), [(true, 5)]);

        send_button(
            &mut app,
            FaderCommand::ReleaseButton { fader_index: 1 },
            CommandOrigin::Cli,
            None,
        );
        release_web(&mut app);
        assert!(is_flashing(&app));
        assert!(take_clip_operations(&mut app).is_empty());

        send_button(
            &mut app,
            FaderCommand::ReleaseButton { fader_index: 1 },
            midi_origin(),
            None,
        );
        assert!(!is_flashing(&app));
        assert_eq!(take_clip_operations(&mut app), [(false, 5)]);
    }

    /// Verifies a client that disconnects while holding a flash lets go of it.
    #[test]
    fn disconnect_releases_a_held_flash() {
        let mut app = flash_app(FaderAssignment::Clip(5), FaderButtonMode::Flash);
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

    /// Verifies switching a held fader to another mode ends the flash at once.
    #[test]
    fn changing_mode_ends_a_held_flash() {
        let mut app = flash_app(FaderAssignment::Clip(5), FaderButtonMode::Flash);
        spawn_clip(&mut app, 5, Some(Source::Fx(uuid::Uuid::nil())), false);
        press_web(&mut app);
        take_clip_operations(&mut app);

        app.world_mut().resource_mut::<Faders>().faders[0].button_mode = FaderButtonMode::Toggle;
        app.update();
        assert!(!is_flashing(&app));
        assert_eq!(take_clip_operations(&mut app), [(false, 5)]);
    }

    /// Verifies a master Flash pushes the master to full and restores its earlier level on
    /// release, unless the level was moved off full while held.
    #[test]
    fn master_flash_restores_the_level_it_found() {
        let mut app = flash_app(FaderAssignment::Master(3), FaderButtonMode::Flash);
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
        let mut fader = Fader {
            pending_console_value: Some(0.0),
            ..Default::default()
        };
        assert_eq!(fader.sync_from_runtime(FaderRuntimeState::default()), None);
        assert_eq!(fader.pending_console_value, Some(0.0));

        let attached = FaderRuntimeState {
            console_value: 100.0,
            is_clip_active: true,
            attached_instance_id: Some(InstanceId::new()),
        };
        assert_eq!(fader.sync_from_runtime(attached), Some(0.0));
    }

    /// Verifies a master Flash tapped within one frame still restores the earlier level,
    /// although the push to full has not applied when the release is handled.
    #[test]
    fn master_flash_tapped_in_one_frame_restores_its_level() {
        let mut app = flash_app(FaderAssignment::Master(3), FaderButtonMode::Flash);
        add_master(&mut app, 3, MasterMode::AlwaysOn);

        for command in [
            FaderCommand::PressButton { fader_index: 1 },
            FaderCommand::ReleaseButton { fader_index: 1 },
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
        let mut app = flash_app(FaderAssignment::Clip(5), FaderButtonMode::Flash);
        spawn_clip(&mut app, 5, Some(Source::Fx(uuid::Uuid::nil())), false);
        let press = FaderCommand::PressButton { fader_index: 1 };

        send_button(&mut app, press.clone(), midi_origin(), None);
        send_button(&mut app, press, midi_origin(), None);
        send_button(
            &mut app,
            FaderCommand::ReleaseButton { fader_index: 1 },
            midi_origin(),
            None,
        );
        assert!(!is_flashing(&app));
    }

    /// Verifies two faders flashing one idle clip keep it running until both let go, whichever
    /// started it, and that a clip whose fader was raised while held keeps running.
    #[test]
    fn shared_and_raised_flashes_keep_their_clip_running() {
        let mut app = fader_go_app();
        let config = FaderConfig {
            assignment: Some(FaderAssignment::Clip(5)),
            button_mode: FaderButtonMode::Flash,
        };
        app.insert_resource(Faders::from_configs(&[config.clone(), config]));
        spawn_clip(&mut app, 5, Some(Source::Fx(uuid::Uuid::nil())), false);
        let button = |press: bool, fader_index: u32| {
            if press {
                FaderCommand::PressButton { fader_index }
            } else {
                FaderCommand::ReleaseButton { fader_index }
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
        app.world_mut().resource_mut::<Faders>().faders[0].pending_console_value = Some(60.0);
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

        let mut app = flash_app(FaderAssignment::Clip(5), FaderButtonMode::Swop);
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
        let mut fader = Fader::default();
        fader.reset_to(50.0);

        fader.sync_from_runtime(FaderRuntimeState {
            console_value: 70.0,
            is_clip_active: true,
            attached_instance_id: Some(InstanceId::new()),
        });
        assert!(!fader.is_grabbed);
        assert_eq!(
            fader.display_value(FaderRuntimeState {
                console_value: 70.0,
                is_clip_active: true,
                attached_instance_id: Some(InstanceId::new()),
            }),
            70.0
        );

        let before_cross = fader.handle_hardware_value(
            60.0,
            FaderRuntimeState {
                console_value: 70.0,
                is_clip_active: true,
                attached_instance_id: Some(InstanceId::new()),
            },
        );
        assert_eq!(before_cross.intensity_value, None);
        assert!(!before_cross.should_start_clip);
        assert!(!before_cross.should_stop_clip);
        assert!(!fader.is_grabbed);

        let cross_through = fader.handle_hardware_value(
            72.0,
            FaderRuntimeState {
                console_value: 70.0,
                is_clip_active: true,
                attached_instance_id: Some(InstanceId::new()),
            },
        );
        assert_eq!(cross_through.intensity_value, Some(0.72));
        assert!(fader.is_grabbed);
    }

    #[test]
    fn grabbed_hardware_releases_when_console_moves_elsewhere() {
        let instance_id = InstanceId::new();
        let mut fader = Fader::default();
        fader.reset_to(70.0);

        let grabbed_move = fader.handle_hardware_value(
            80.0,
            FaderRuntimeState {
                console_value: 70.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(grabbed_move.intensity_value, Some(0.8));
        assert!(fader.is_grabbed);

        fader.sync_from_runtime(FaderRuntimeState {
            console_value: 80.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(fader.is_grabbed);

        fader.sync_from_runtime(FaderRuntimeState {
            console_value: 60.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(!fader.is_grabbed);
        assert_eq!(
            fader.display_value(FaderRuntimeState {
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
        let mut fader = Fader::default();
        fader.reset_to(0.0);

        let start = fader.handle_hardware_value(
            20.0,
            FaderRuntimeState {
                console_value: 0.0,
                is_clip_active: false,
                attached_instance_id: None,
            },
        );
        assert!(start.should_start_clip);
        assert_eq!(start.intensity_value, None);
        assert!(fader.is_grabbed);

        let duplicate_start = fader.handle_hardware_value(
            30.0,
            FaderRuntimeState {
                console_value: 0.0,
                is_clip_active: false,
                attached_instance_id: None,
            },
        );
        assert!(!duplicate_start.should_start_clip);
        assert_eq!(duplicate_start.intensity_value, None);

        let pending = fader.sync_from_runtime(FaderRuntimeState {
            console_value: 100.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert_eq!(pending, Some(0.3));
        assert_eq!(fader.settling_level(), Some(30.0));

        fader.sync_from_runtime(FaderRuntimeState {
            console_value: 30.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(fader.is_grabbed);
        assert!(!fader.pending_console_sync);
        assert_eq!(fader.settling_level(), None);
    }

    #[test]
    fn moving_to_zero_only_stops_clip_when_hardware_has_grabbed_fader() {
        let instance_id = InstanceId::new();
        let mut fader = Fader::default();
        fader.reset_to(20.0);

        let stop = fader.handle_hardware_value(
            0.0,
            FaderRuntimeState {
                console_value: 20.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert!(stop.should_stop_clip);
        assert_eq!(stop.intensity_value, None);

        fader.reset_to(20.0);
        fader.sync_from_runtime(FaderRuntimeState {
            console_value: 50.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(!fader.is_grabbed);

        let detached_zero = fader.handle_hardware_value(
            0.0,
            FaderRuntimeState {
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
        let mut fader = Fader::default();
        fader.reset_to(80.0);

        let first_external_move = fader.handle_external_hardware_value(
            10.0,
            FaderRuntimeState {
                console_value: 80.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(first_external_move.intensity_value, None);
        assert!(!fader.is_grabbed);

        let before_pickup = fader.handle_external_hardware_value(
            60.0,
            FaderRuntimeState {
                console_value: 80.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(before_pickup.intensity_value, None);
        assert!(!fader.is_grabbed);

        let after_pickup = fader.handle_external_hardware_value(
            90.0,
            FaderRuntimeState {
                console_value: 80.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(after_pickup.intensity_value, Some(0.9));
        assert!(fader.is_grabbed);
    }

    #[test]
    fn external_hardware_from_zero_stays_grabbed_while_raising() {
        let instance_id = InstanceId::new();
        let mut fader = Fader::default();
        fader.reset_to(0.0);

        let first_raise = fader.handle_external_hardware_value(
            3.0,
            FaderRuntimeState {
                console_value: 0.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(first_raise.intensity_value, Some(0.03));
        assert!(fader.is_grabbed);

        let continue_raise = fader.handle_external_hardware_value(
            25.0,
            FaderRuntimeState {
                console_value: 2.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(continue_raise.intensity_value, Some(0.25));
        assert!(fader.is_grabbed);
    }

    #[test]
    fn external_hardware_from_zero_stays_grabbed_across_runtime_bounce() {
        let instance_id = InstanceId::new();
        let mut fader = Fader::default();
        fader.reset_to(0.0);

        let first_raise = fader.handle_external_hardware_value(
            1.0,
            FaderRuntimeState {
                console_value: 0.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(first_raise.intensity_value, Some(0.01));
        assert!(fader.is_grabbed);
        assert!(!fader.external_grab_armed);

        fader.sync_from_runtime(FaderRuntimeState {
            console_value: 100.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(fader.is_grabbed);
        assert!(!fader.external_grab_armed);

        fader.sync_from_runtime(FaderRuntimeState {
            console_value: 1.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(fader.is_grabbed);
        assert!(!fader.external_grab_armed);

        let continue_raise = fader.handle_external_hardware_value(
            25.0,
            FaderRuntimeState {
                console_value: 1.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(continue_raise.intensity_value, Some(0.25));
        assert!(fader.is_grabbed);
    }

    #[test]
    fn noop_console_value_does_not_release_external_grab() {
        let instance_id = InstanceId::new();
        let mut fader = Fader::default();
        fader.reset_to(0.0);

        let start = fader.handle_external_hardware_value(
            1.0,
            FaderRuntimeState {
                console_value: 0.0,
                is_clip_active: false,
                attached_instance_id: None,
            },
        );
        assert!(start.should_start_clip);
        assert!(fader.is_grabbed);
        assert!(!fader.external_grab_armed);

        fader.sync_from_runtime(FaderRuntimeState {
            console_value: 1.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(fader.is_grabbed);
        assert!(!fader.external_grab_armed);

        let noop_console = fader.handle_console_value(
            1.0,
            FaderRuntimeState {
                console_value: 1.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(noop_console.intensity_value, None);
        assert!(fader.is_grabbed);
        assert!(!fader.external_grab_armed);

        let continue_raise = fader.handle_external_hardware_value(
            5.0,
            FaderRuntimeState {
                console_value: 1.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(continue_raise.intensity_value, Some(0.05));
        assert!(fader.is_grabbed);
    }

    #[test]
    fn external_hardware_grab_at_max_stays_grabbed_when_moving_back_down() {
        let instance_id = InstanceId::new();
        let mut fader = Fader::default();
        fader.reset_to(100.0);

        let first_external_move = fader.handle_external_hardware_value(
            80.0,
            FaderRuntimeState {
                console_value: 100.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(first_external_move.intensity_value, None);
        assert!(!fader.is_grabbed);

        let pickup_at_max = fader.handle_external_hardware_value(
            100.0,
            FaderRuntimeState {
                console_value: 100.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(pickup_at_max.intensity_value, None);
        assert!(fader.is_grabbed);
        assert!(!fader.external_grab_armed);

        let move_down_after_pickup = fader.handle_external_hardware_value(
            95.0,
            FaderRuntimeState {
                console_value: 100.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(move_down_after_pickup.intensity_value, Some(0.95));
        assert!(fader.is_grabbed);
    }

    #[test]
    fn grabbed_hardware_stays_grabbed_while_console_catches_up() {
        let instance_id = InstanceId::new();
        let mut fader = Fader::default();
        fader.reset_to(100.0);

        let first_external_move = fader.handle_external_hardware_value(
            80.0,
            FaderRuntimeState {
                console_value: 100.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(first_external_move.intensity_value, None);
        assert!(!fader.is_grabbed);

        let pickup_at_max = fader.handle_external_hardware_value(
            100.0,
            FaderRuntimeState {
                console_value: 100.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(pickup_at_max.intensity_value, None);
        assert!(fader.is_grabbed);

        let drive_down = fader.handle_external_hardware_value(
            96.0,
            FaderRuntimeState {
                console_value: 100.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(drive_down.intensity_value, Some(0.96));
        assert!(fader.is_grabbed);

        fader.sync_from_runtime(FaderRuntimeState {
            console_value: 99.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(fader.is_grabbed);

        fader.sync_from_runtime(FaderRuntimeState {
            console_value: 98.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(fader.is_grabbed);

        fader.sync_from_runtime(FaderRuntimeState {
            console_value: 96.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(fader.is_grabbed);
        assert!(!fader.hardware_drove_console);
    }

    #[test]
    fn external_hardware_grab_ignores_runtime_drift_until_console_input_releases_it() {
        let instance_id = InstanceId::new();
        let mut fader = Fader::default();
        fader.reset_to(80.0);

        let detach = fader.handle_external_hardware_value(
            10.0,
            FaderRuntimeState {
                console_value: 80.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(detach.intensity_value, None);
        assert!(!fader.is_grabbed);

        let grab = fader.handle_external_hardware_value(
            90.0,
            FaderRuntimeState {
                console_value: 80.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(grab.intensity_value, Some(0.9));
        assert!(fader.is_grabbed);
        assert!(!fader.external_grab_armed);

        fader.sync_from_runtime(FaderRuntimeState {
            console_value: 90.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(fader.is_grabbed);
        assert!(!fader.hardware_drove_console);

        fader.sync_from_runtime(FaderRuntimeState {
            console_value: 25.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        });
        assert!(fader.is_grabbed);
        assert!(!fader.external_grab_armed);
    }

    #[test]
    fn console_value_change_releases_grab_and_requires_external_pickup_again() {
        let instance_id = InstanceId::new();
        let mut fader = Fader::default();
        fader.reset_to(80.0);

        let console_move = fader.handle_console_value(
            40.0,
            FaderRuntimeState {
                console_value: 80.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(console_move.intensity_value, Some(0.4));
        assert!(!fader.is_grabbed);
        assert!(fader.external_grab_armed);

        let hardware_move_without_pickup = fader.handle_external_hardware_value(
            75.0,
            FaderRuntimeState {
                console_value: 40.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(hardware_move_without_pickup.intensity_value, None);
        assert!(!fader.is_grabbed);

        let hardware_pickup = fader.handle_external_hardware_value(
            39.0,
            FaderRuntimeState {
                console_value: 40.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert_eq!(hardware_pickup.intensity_value, Some(0.39));
        assert!(fader.is_grabbed);
    }

    /// Verifies that after a physical fader starts and stops a clip, starting the clip again
    /// from elsewhere shows the new instance's full level and makes the physical fader pick it
    /// up, instead of showing the parked fader while the clip plays at full.
    #[test]
    fn restarted_clip_releases_physical_fader_that_stopped_it() {
        let active = |console_value: f32, instance_id: InstanceId| FaderRuntimeState {
            console_value,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        };
        let first_instance = InstanceId::new();
        let mut fader = Fader {
            has_hardware: true,
            ..Fader::default()
        };

        let raise = fader.handle_external_hardware_value(20.0, FaderRuntimeState::default());
        assert!(raise.should_start_clip);
        assert_eq!(
            fader.sync_from_runtime(active(100.0, first_instance)),
            Some(0.2)
        );
        fader.sync_from_runtime(active(20.0, first_instance));
        let lower = fader.handle_external_hardware_value(0.0, active(20.0, first_instance));
        assert!(lower.should_stop_clip);
        fader.sync_from_runtime(FaderRuntimeState::default());

        let second_instance = InstanceId::new();
        let restarted = active(100.0, second_instance);
        assert_eq!(fader.sync_from_runtime(restarted), None);
        assert!(!fader.is_grabbed);
        assert_eq!(fader.display_value(restarted), 100.0);

        let nudge = fader.handle_external_hardware_value(10.0, restarted);
        assert_eq!(nudge.intensity_value, None);
        assert!(!fader.is_grabbed);
    }

    /// Verifies a fader no physical fader has driven shows the console level, even while its
    /// stored position from assignment still counts as held, and that a physical fader's
    /// position is shown once one has reported.
    #[test]
    fn display_ignores_stored_position_until_a_physical_fader_reports() {
        let mut fader = Fader::default();
        fader.reset_to(100.0);
        let runtime = FaderRuntimeState {
            console_value: 31.0,
            is_clip_active: true,
            attached_instance_id: Some(InstanceId::new()),
        };
        assert!(fader.is_grabbed);
        assert_eq!(fader.display_value(runtime), 31.0);

        fader.has_hardware = true;
        assert_eq!(fader.display_value(runtime), 100.0);

        fader.clear();
        assert!(fader.has_hardware);
    }

    /// Verifies only faders a physical fader has driven report a hardware position, and that an
    /// on-screen move does not count as one.
    #[test]
    fn only_physical_fader_input_reports_a_hardware_position() {
        let mut app = fader_command_app();
        app.add_message::<FaderUpdate>();
        app.add_message::<EngineOperationEnvelope<ClipOperation>>();
        app.add_message::<MasterUpdate>();
        app.add_message::<InstanceControlUpdate>();
        app.add_systems(Update, handle_fader_updates);
        let update = |app: &mut App, update: FaderUpdate| {
            app.world_mut().write_message(update);
            app.update();
        };

        update(
            &mut app,
            FaderUpdate::SetConsoleValue {
                fader_index: 1,
                value: 40.0,
            },
        );
        update(
            &mut app,
            FaderUpdate::SetExternalHardwareValue {
                fader_index: 2,
                value: 60.0,
            },
        );

        let faders = app.world().resource::<Faders>();
        assert!(!faders.faders[0].has_hardware);
        assert!(faders.faders[1].has_hardware);
        assert_eq!(faders.faders[1].hardware_value, 60.0);
    }

    /// Verifies a fader pulled to zero on screen keeps following the clip when another fader
    /// assigned to the same clip raises it again, instead of sticking at zero.
    #[test]
    fn on_screen_fader_at_zero_follows_another_fader_on_the_same_clip() {
        let instance_id = InstanceId::new();
        let mut follower = Fader::default();
        let stopped = FaderRuntimeState::default();

        let stop = follower.handle_console_value(
            0.0,
            FaderRuntimeState {
                console_value: 80.0,
                is_clip_active: true,
                attached_instance_id: Some(instance_id),
            },
        );
        assert!(stop.should_stop_clip);
        follower.sync_from_runtime(stopped);
        assert_eq!(follower.display_value(stopped), 0.0);

        let raised = FaderRuntimeState {
            console_value: 60.0,
            is_clip_active: true,
            attached_instance_id: Some(instance_id),
        };
        assert_eq!(follower.sync_from_runtime(raised), None);
        assert!(!follower.is_grabbed);
        assert_eq!(follower.display_value(raised), 60.0);
    }
}
