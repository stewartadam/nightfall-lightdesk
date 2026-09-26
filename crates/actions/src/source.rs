// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Adapts raw control-surface signals to the input each bound action consumes.

use std::collections::{HashMap, HashSet};

use bevy_ecs::prelude::Resource;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::descriptor::ActionInputKind;
use crate::invocation::{ActionInput, ActionReference};
use crate::registry::ActionRegistry;

/// Level at or above which a continuous control counts as pressed.
const PRESS_THRESHOLD: f32 = 0.5;

/// Raw signal produced by one physical or network control before action adaptation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SourceSignal {
    /// A stateless event such as an OSC message without arguments.
    Pulse,
    /// A button edge such as a MIDI note on (`true`) or note off (`false`).
    Button(bool),
    /// A continuous normalized level such as a MIDI controller or OSC fader.
    Level(f32),
}

impl SourceSignal {
    /// Returns the action input kinds this signal can drive.
    pub fn can_drive(self, kind: ActionInputKind) -> bool {
        !matches!(
            (self, kind),
            (
                Self::Pulse,
                ActionInputKind::Momentary | ActionInputKind::Absolute
            )
        )
    }
}

/// How a controller binding turns a control's presses and releases into action input.
///
/// Behaviors only shape when and how the bound action is invoked. Whether the resulting work
/// is tracked or undoable is decided by the command the action lowers to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum ControlBehavior {
    /// Fire a trigger action on press; faders and knobs drive absolute actions directly.
    #[default]
    Press,
    /// Fire a trigger action when the control is released.
    Release,
    /// Invoke the action on press and its declared release counterpart on release.
    Hold,
    /// Push an absolute action to full while pressed and restore its level on release.
    Flash,
}

impl ControlBehavior {
    /// Returns which control edges (press, release) a binding reacts to for an action kind.
    ///
    /// `None` input kinds are client-hosted or unknown actions, which fire as triggers.
    fn edges(self, kind: Option<ActionInputKind>) -> (bool, bool) {
        match (self, kind) {
            (Self::Press, Some(ActionInputKind::Trigger) | None) => (true, false),
            (Self::Release, _) => (false, true),
            _ => (true, true),
        }
    }

    /// Returns whether two bindings on the same control would react to the same edge.
    ///
    /// A control holds one binding reacting to both edges, or one press and one release
    /// trigger binding.
    pub fn overlaps(
        self,
        kind: Option<ActionInputKind>,
        other: Self,
        other_kind: Option<ActionInputKind>,
    ) -> bool {
        let (press, release) = self.edges(kind);
        let (other_press, other_release) = other.edges(other_kind);
        (press && other_press) || (release && other_release)
    }

    /// Returns whether the behavior needs a control that reports being released.
    pub fn needs_release(self) -> bool {
        self != Self::Press
    }
}

/// Action a binding invokes for one control edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingTarget {
    /// The bound action itself.
    Action,
    /// The release counterpart the bound action declares for Hold bindings.
    HoldRelease,
}

/// Identifies one stream of press state: a binding, split per sender when several senders
/// can drive the same binding.
///
/// An OSC mapping without a source filter matches every sender on its address, so tracking
/// press state per binding alone would let one sender's release complete another's press.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EdgeKey {
    /// Binding the signal matched.
    binding: Uuid,
    /// Sender the signal came from, when a binding can be driven by several senders.
    sender: Option<String>,
}

impl EdgeKey {
    /// Tracks press state for a binding across all senders.
    pub fn new(binding: Uuid) -> Self {
        Self {
            binding,
            sender: None,
        }
    }

    /// Tracks press state for a binding separately for each sender.
    pub fn with_sender(mut self, sender: impl Into<String>) -> Self {
        self.sender = Some(sender.into());
        self
    }
}

impl From<Uuid> for EdgeKey {
    fn from(binding: Uuid) -> Self {
        Self::new(binding)
    }
}

/// Per-binding press state used to turn continuous levels into button edges.
///
/// Button-style hardware often reports levels (a MIDI controller sending 127 then 0, or an
/// OSC toggle sending 1.0 then 0.0). Driving a button behavior from such a control reacts
/// only when the level crosses the press threshold, so repeated values or fader movement
/// within one half of the range do not retrigger the action.
///
/// Input can be suppressed, as it is while controller mapping mode is active. Suppression
/// starts nothing new but finishes what already started live:
/// - Presses, levels, pulses, and Release-behavior triggers are swallowed.
/// - A release completing a press that was dispatched live still dispatches, so a Hold
///   binding's release counterpart runs and a Flash restores its level instead of latching.
/// - A press swallowed while suppressed also swallows its release, even when the release
///   arrives after suppression ended, so leaving mapping mode never fires a stray release.
///
/// State is kept per [`EdgeKey`], so senders sharing a binding each keep their own edges.
#[derive(Debug, Default, Resource)]
pub struct SourceEdgeStates {
    /// Last known button state per binding and sender.
    pressed: HashMap<EdgeKey, bool>,
    /// Bindings and senders whose current press was swallowed, so their release is too.
    swallowed: HashSet<EdgeKey>,
}

impl SourceEdgeStates {
    /// Converts one signal from the binding and sender identified by `key` to the input to
    /// invoke.
    ///
    /// Returns which action to invoke with which input, or `None` when the signal has no
    /// effect for the binding, such as a level that stays on the same side of the press
    /// threshold, a press reaching a release binding, or input swallowed while `suppressed`
    /// (see [`SourceEdgeStates`] for which edges suppression lets through).
    pub fn adapt(
        &mut self,
        key: impl Into<EdgeKey>,
        kind: ActionInputKind,
        behavior: ControlBehavior,
        signal: SourceSignal,
        suppressed: bool,
    ) -> Option<(BindingTarget, ActionInput)> {
        let binding = &key.into();
        let action = |input| Some((BindingTarget::Action, input));
        match behavior {
            ControlBehavior::Press => self
                .adapt_direct(binding, kind, signal, suppressed)
                .and_then(action),
            ControlBehavior::Release => (!self.edge(binding, signal, suppressed)? && !suppressed)
                .then_some((BindingTarget::Action, ActionInput::Trigger)),
            ControlBehavior::Hold if kind == ActionInputKind::Trigger => {
                let target = if self.edge(binding, signal, suppressed)? {
                    BindingTarget::Action
                } else {
                    BindingTarget::HoldRelease
                };
                Some((target, ActionInput::Trigger))
            }
            ControlBehavior::Hold | ControlBehavior::Flash => {
                action(button_input(self.edge(binding, signal, suppressed)?))
            }
        }
    }

    /// Converts one signal for a Press binding, which drives the action's own input kind.
    ///
    /// Levels and pulses carry no press to complete, so suppression swallows them outright.
    fn adapt_direct(
        &mut self,
        binding: &EdgeKey,
        kind: ActionInputKind,
        signal: SourceSignal,
        suppressed: bool,
    ) -> Option<ActionInput> {
        match (kind, signal) {
            (ActionInputKind::Absolute, SourceSignal::Level(value)) => {
                (!suppressed).then_some(ActionInput::Scalar(value))
            }
            (ActionInputKind::Absolute, SourceSignal::Button(pressed)) => {
                (!suppressed).then_some(ActionInput::Scalar(if pressed { 1.0 } else { 0.0 }))
            }
            (ActionInputKind::Trigger, SourceSignal::Pulse) => {
                (!suppressed).then_some(ActionInput::Trigger)
            }
            _ => self.edge(binding, signal, suppressed).map(button_input),
        }
    }

    /// Returns the button edge a signal dispatches: `true` for a press, `false` for a release.
    ///
    /// Pulses have no edges, and levels only report an edge when crossing the press threshold.
    /// Press state is tracked even while `suppressed`, but a suppressed press is swallowed along
    /// with its eventual release, and a suppressed release only passes when it completes a
    /// press that was dispatched live.
    fn edge(&mut self, binding: &EdgeKey, signal: SourceSignal, suppressed: bool) -> Option<bool> {
        let (pressed, was_pressed) = match signal {
            SourceSignal::Pulse => return None,
            SourceSignal::Button(pressed) => {
                let previous = self
                    .pressed
                    .insert(binding.clone(), pressed)
                    .unwrap_or(false);
                (pressed, previous)
            }
            SourceSignal::Level(value) => {
                let pressed = value >= PRESS_THRESHOLD;
                let previous = self
                    .pressed
                    .insert(binding.clone(), pressed)
                    .unwrap_or(false);
                if pressed == previous {
                    return None;
                }
                (pressed, previous)
            }
        };
        if pressed {
            if suppressed {
                self.swallowed.insert(binding.clone());
                return None;
            }
            self.swallowed.remove(binding);
            return Some(true);
        }
        if self.swallowed.remove(binding) || (suppressed && !was_pressed) {
            return None;
        }
        Some(false)
    }

    /// Resolves the action and input one signal invokes through a stored binding.
    ///
    /// Adapts the signal to the bound action's input kind and behavior, and swaps in the
    /// action's release counterpart for the release half of a Hold. Unknown actions still
    /// dispatch as triggers so the registry reports them as unregistered. While `suppressed`,
    /// only releases completing a live press resolve.
    pub fn resolve(
        &mut self,
        registry: &ActionRegistry,
        key: impl Into<EdgeKey>,
        action: &ActionReference,
        behavior: ControlBehavior,
        signal: SourceSignal,
        suppressed: bool,
    ) -> Option<(ActionReference, ActionInput)> {
        let kind = registry
            .input_kind(&action.id)
            .unwrap_or(ActionInputKind::Trigger);
        let (target, input) = self.adapt(key, kind, behavior, signal, suppressed)?;
        let action = match target {
            BindingTarget::Action => action.clone(),
            BindingTarget::HoldRelease => registry.hold_release_action(action)?,
        };
        Some((action, input))
    }

    /// Forgets press state from every sender for a binding that was removed or replaced.
    pub fn forget(&mut self, binding: Uuid) {
        self.pressed.retain(|key, _| key.binding != binding);
        self.swallowed.retain(|key| key.binding != binding);
    }
}

/// Maps a button state to its press or release input.
fn button_input(pressed: bool) -> ActionInput {
    if pressed {
        ActionInput::Press
    } else {
        ActionInput::Release
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Adapts one signal for a binding with the given kind and behavior.
    fn adapt(
        states: &mut SourceEdgeStates,
        binding: u128,
        kind: ActionInputKind,
        behavior: ControlBehavior,
        signal: SourceSignal,
    ) -> Option<(BindingTarget, ActionInput)> {
        states.adapt(Uuid::from_u128(binding), kind, behavior, signal, false)
    }

    /// Adapts one button edge while input is live or suppressed, returning the input fired.
    fn button(
        states: &mut SourceEdgeStates,
        behavior: ControlBehavior,
        kind: ActionInputKind,
        pressed: bool,
        suppressed: bool,
    ) -> Option<(BindingTarget, ActionInput)> {
        states.adapt(
            Uuid::from_u128(9),
            kind,
            behavior,
            SourceSignal::Button(pressed),
            suppressed,
        )
    }

    /// Verifies suppression swallows presses, levels, pulses, and Release-behavior triggers.
    #[test]
    fn suppression_swallows_new_input() {
        let mut states = SourceEdgeStates::default();
        let id = Uuid::from_u128(10);

        assert_eq!(
            button(
                &mut states,
                ControlBehavior::Press,
                ActionInputKind::Trigger,
                true,
                true
            ),
            None
        );
        assert_eq!(
            states.adapt(
                id,
                ActionInputKind::Absolute,
                ControlBehavior::Press,
                SourceSignal::Level(0.7),
                true
            ),
            None
        );
        assert_eq!(
            states.adapt(
                id,
                ActionInputKind::Trigger,
                ControlBehavior::Press,
                SourceSignal::Pulse,
                true
            ),
            None
        );
        let release_binding = Uuid::from_u128(11);
        for pressed in [true, false] {
            assert_eq!(
                states.adapt(
                    release_binding,
                    ActionInputKind::Trigger,
                    ControlBehavior::Release,
                    SourceSignal::Button(pressed),
                    true
                ),
                None
            );
        }
    }

    /// Verifies a Hold pressed live still runs its release counterpart while suppressed.
    #[test]
    fn suppression_completes_live_hold() {
        let mut states = SourceEdgeStates::default();
        let (hold, trigger) = (ControlBehavior::Hold, ActionInputKind::Trigger);

        assert_eq!(
            button(&mut states, hold, trigger, true, false),
            Some((BindingTarget::Action, ActionInput::Trigger))
        );
        assert_eq!(
            button(&mut states, hold, trigger, false, true),
            Some((BindingTarget::HoldRelease, ActionInput::Trigger))
        );
        assert_eq!(button(&mut states, hold, trigger, false, true), None);
    }

    /// Verifies a Flash pressed live still restores its level when released while suppressed.
    #[test]
    fn suppression_completes_live_flash() {
        let mut states = SourceEdgeStates::default();
        let (flash, absolute) = (ControlBehavior::Flash, ActionInputKind::Absolute);

        assert_eq!(
            button(&mut states, flash, absolute, true, false),
            Some((BindingTarget::Action, ActionInput::Press))
        );
        assert_eq!(
            button(&mut states, flash, absolute, false, true),
            Some((BindingTarget::Action, ActionInput::Release))
        );
    }

    /// Verifies a press swallowed while suppressed also swallows its release after suppression.
    #[test]
    fn suppressed_press_swallows_trailing_release() {
        let mut states = SourceEdgeStates::default();
        let (hold, trigger) = (ControlBehavior::Hold, ActionInputKind::Trigger);

        assert_eq!(button(&mut states, hold, trigger, true, true), None);
        assert_eq!(button(&mut states, hold, trigger, false, false), None);
        assert_eq!(
            button(&mut states, hold, trigger, true, false),
            Some((BindingTarget::Action, ActionInput::Trigger))
        );
        assert_eq!(
            button(&mut states, hold, trigger, false, false),
            Some((BindingTarget::HoldRelease, ActionInput::Trigger))
        );
    }

    /// Verifies faders feed absolute actions directly.
    #[test]
    fn levels_drive_absolute_actions_directly() {
        let mut states = SourceEdgeStates::default();

        assert_eq!(
            adapt(
                &mut states,
                1,
                ActionInputKind::Absolute,
                ControlBehavior::Press,
                SourceSignal::Level(0.3)
            ),
            Some((BindingTarget::Action, ActionInput::Scalar(0.3)))
        );
    }

    /// Verifies level-reporting buttons fire once per crossing of the press threshold.
    #[test]
    fn levels_drive_triggers_on_threshold_edges() {
        let mut states = SourceEdgeStates::default();
        let mut press = |value| {
            adapt(
                &mut states,
                2,
                ActionInputKind::Trigger,
                ControlBehavior::Press,
                SourceSignal::Level(value),
            )
            .map(|(_, input)| input)
        };

        assert_eq!(press(1.0), Some(ActionInput::Press));
        assert_eq!(press(0.9), None);
        assert_eq!(press(0.0), Some(ActionInput::Release));
        assert_eq!(press(0.1), None);
        assert_eq!(press(0.6), Some(ActionInput::Press));
    }

    /// Verifies stateless pulses only fire trigger actions on press bindings.
    #[test]
    fn pulses_only_drive_triggers() {
        let mut states = SourceEdgeStates::default();

        assert_eq!(
            adapt(
                &mut states,
                3,
                ActionInputKind::Trigger,
                ControlBehavior::Press,
                SourceSignal::Pulse
            ),
            Some((BindingTarget::Action, ActionInput::Trigger))
        );
        for behavior in [
            ControlBehavior::Release,
            ControlBehavior::Hold,
            ControlBehavior::Flash,
        ] {
            assert_eq!(
                adapt(
                    &mut states,
                    3,
                    ActionInputKind::Trigger,
                    behavior,
                    SourceSignal::Pulse
                ),
                None
            );
        }
        assert!(!SourceSignal::Pulse.can_drive(ActionInputKind::Absolute));
    }

    /// Verifies release bindings fire their trigger when a button or level is let go.
    #[test]
    fn release_bindings_fire_triggers_on_release() {
        let mut states = SourceEdgeStates::default();
        let mut release = |binding, signal| {
            adapt(
                &mut states,
                binding,
                ActionInputKind::Trigger,
                ControlBehavior::Release,
                signal,
            )
        };
        let fired = Some((BindingTarget::Action, ActionInput::Trigger));

        assert_eq!(release(4, SourceSignal::Button(true)), None);
        assert_eq!(release(4, SourceSignal::Button(false)), fired);
        assert_eq!(release(5, SourceSignal::Level(1.0)), None);
        assert_eq!(release(5, SourceSignal::Level(0.0)), fired);
    }

    /// Verifies Hold fires a trigger's action on press and its counterpart on release.
    #[test]
    fn hold_invokes_the_release_counterpart_on_release() {
        let mut states = SourceEdgeStates::default();
        let mut hold = |pressed| {
            adapt(
                &mut states,
                6,
                ActionInputKind::Trigger,
                ControlBehavior::Hold,
                SourceSignal::Button(pressed),
            )
        };

        assert_eq!(
            hold(true),
            Some((BindingTarget::Action, ActionInput::Trigger))
        );
        assert_eq!(
            hold(false),
            Some((BindingTarget::HoldRelease, ActionInput::Trigger))
        );
    }

    /// Verifies Flash passes press and release edges to the absolute action.
    #[test]
    fn flash_passes_edges_to_absolute_actions() {
        let mut states = SourceEdgeStates::default();
        let mut flash = |value| {
            adapt(
                &mut states,
                7,
                ActionInputKind::Absolute,
                ControlBehavior::Flash,
                SourceSignal::Level(value),
            )
        };

        assert_eq!(
            flash(1.0),
            Some((BindingTarget::Action, ActionInput::Press))
        );
        assert_eq!(
            flash(0.0),
            Some((BindingTarget::Action, ActionInput::Release))
        );
    }

    /// Verifies two senders driving one binding keep separate edges, so interleaved presses
    /// and releases each fire once instead of cancelling or duplicating each other.
    #[test]
    fn senders_sharing_a_binding_keep_separate_edges() {
        let mut states = SourceEdgeStates::default();
        let binding = Uuid::from_u128(12);
        let mut release = |sender: &str, pressed| {
            states.adapt(
                EdgeKey::new(binding).with_sender(sender),
                ActionInputKind::Trigger,
                ControlBehavior::Release,
                SourceSignal::Level(if pressed { 1.0 } else { 0.0 }),
                false,
            )
        };
        let fired = Some((BindingTarget::Action, ActionInput::Trigger));

        assert_eq!(release("10.0.0.1:9000", true), None);
        assert_eq!(release("10.0.0.2:9000", true), None);
        assert_eq!(release("10.0.0.1:9000", false), fired);
        assert_eq!(release("10.0.0.2:9000", false), fired);

        states.forget(binding);
        assert!(states.pressed.is_empty());
    }

    /// Verifies a control holds one press and one release trigger, or one two-edge binding.
    #[test]
    fn bindings_overlap_on_shared_edges() {
        let trigger = Some(ActionInputKind::Trigger);
        let absolute = Some(ActionInputKind::Absolute);
        let press = ControlBehavior::Press;
        let release = ControlBehavior::Release;

        assert!(!press.overlaps(trigger, release, trigger));
        assert!(!press.overlaps(None, release, trigger));
        assert!(press.overlaps(trigger, press, None));
        assert!(ControlBehavior::Hold.overlaps(trigger, release, trigger));
        assert!(press.overlaps(absolute, release, trigger));
        assert!(ControlBehavior::Flash.overlaps(absolute, press, trigger));
    }
}
