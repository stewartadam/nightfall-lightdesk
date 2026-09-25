// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Adapts raw control-surface signals to the input kind each bound action consumes.

use std::collections::HashMap;

use bevy_ecs::prelude::Resource;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::descriptor::ActionInputKind;
use crate::invocation::ActionInput;

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

/// Edge of a button-like control that fires a binding's trigger action.
///
/// A control holds either one binding whose action consumes both edges (a momentary or
/// absolute action), or up to one trigger binding per edge, so a pad can start one action
/// on press and another on release.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum SourceEdge {
    /// Fire when the control is pressed. Actions consuming both edges bind here.
    #[default]
    Press,
    /// Fire a trigger action when the control is released.
    Release,
}

impl SourceEdge {
    /// Returns whether a binding on this edge can drive an action input kind.
    ///
    /// Release bindings only fire triggers; momentary and absolute actions already receive
    /// the release through their press binding.
    pub fn accepts(self, kind: ActionInputKind) -> bool {
        self == Self::Press || kind == ActionInputKind::Trigger
    }

    /// Returns whether two bindings on the same control would fire from the same edge.
    ///
    /// `None` input kinds are client-hosted or unknown actions, which fire as triggers.
    pub fn overlaps(
        self,
        kind: Option<ActionInputKind>,
        other: Self,
        other_kind: Option<ActionInputKind>,
    ) -> bool {
        let uses_both_edges = |kind: Option<ActionInputKind>| {
            kind.is_some_and(|kind| kind != ActionInputKind::Trigger)
        };
        self == other || uses_both_edges(kind) || uses_both_edges(other_kind)
    }

    /// Returns whether serialization can omit this edge because it is the default.
    pub fn is_press(&self) -> bool {
        *self == Self::Press
    }
}

/// Per-binding press state used to turn continuous levels into button edges.
///
/// Button-style hardware often reports levels (a MIDI controller sending 127 then 0, or an
/// OSC toggle sending 1.0 then 0.0). Driving a trigger or momentary action from such a
/// control fires only when the level crosses the press threshold, so repeated values or
/// fader movement within one half of the range do not retrigger the action.
#[derive(Debug, Default, Resource)]
pub struct SourceEdgeStates {
    pressed: HashMap<Uuid, bool>,
}

impl SourceEdgeStates {
    /// Converts one signal from the binding identified by `binding` to action input.
    ///
    /// Returns `None` when the signal has no effect for the binding, such as a level that
    /// stays on the same side of the press threshold, or a press reaching a release binding.
    /// A release binding fires its trigger action when the control is let go.
    pub fn adapt(
        &mut self,
        binding: Uuid,
        kind: ActionInputKind,
        edge: SourceEdge,
        signal: SourceSignal,
    ) -> Option<ActionInput> {
        let input = self.adapt_signal(binding, kind, signal)?;
        match edge {
            SourceEdge::Press => Some(input),
            SourceEdge::Release => (input == ActionInput::Release).then_some(ActionInput::Trigger),
        }
    }

    /// Converts one signal to the input an action consuming `kind` expects on a press binding.
    fn adapt_signal(
        &mut self,
        binding: Uuid,
        kind: ActionInputKind,
        signal: SourceSignal,
    ) -> Option<ActionInput> {
        match (kind, signal) {
            (ActionInputKind::Absolute, SourceSignal::Level(value)) => {
                Some(ActionInput::Scalar(value))
            }
            (ActionInputKind::Absolute, SourceSignal::Button(pressed)) => {
                Some(ActionInput::Scalar(if pressed { 1.0 } else { 0.0 }))
            }
            (ActionInputKind::Trigger, SourceSignal::Pulse) => Some(ActionInput::Trigger),
            (_, SourceSignal::Pulse) => None,
            (_, SourceSignal::Button(pressed)) => {
                self.pressed.insert(binding, pressed);
                Some(button_input(pressed))
            }
            (_, SourceSignal::Level(value)) => {
                let pressed = value >= PRESS_THRESHOLD;
                let previous = self.pressed.insert(binding, pressed).unwrap_or(false);
                (pressed != previous).then(|| button_input(pressed))
            }
        }
    }

    /// Forgets press state for a binding that was removed or replaced.
    pub fn forget(&mut self, binding: Uuid) {
        self.pressed.remove(&binding);
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

    /// Verifies faders feed absolute actions directly.
    #[test]
    fn levels_drive_absolute_actions_directly() {
        let mut states = SourceEdgeStates::default();
        let binding = Uuid::from_u128(1);

        assert_eq!(
            states.adapt(
                binding,
                ActionInputKind::Absolute,
                SourceEdge::Press,
                SourceSignal::Level(0.3)
            ),
            Some(ActionInput::Scalar(0.3))
        );
    }

    /// Verifies level-reporting buttons fire once per crossing of the press threshold.
    #[test]
    fn levels_drive_triggers_on_threshold_edges() {
        let mut states = SourceEdgeStates::default();
        let binding = Uuid::from_u128(2);
        let adapt = |states: &mut SourceEdgeStates, value| {
            states.adapt(
                binding,
                ActionInputKind::Trigger,
                SourceEdge::Press,
                SourceSignal::Level(value),
            )
        };

        assert_eq!(adapt(&mut states, 1.0), Some(ActionInput::Press));
        assert_eq!(adapt(&mut states, 0.9), None);
        assert_eq!(adapt(&mut states, 0.0), Some(ActionInput::Release));
        assert_eq!(adapt(&mut states, 0.1), None);
        assert_eq!(adapt(&mut states, 0.6), Some(ActionInput::Press));
    }

    /// Verifies stateless pulses only drive trigger actions.
    #[test]
    fn pulses_only_drive_triggers() {
        let mut states = SourceEdgeStates::default();
        let binding = Uuid::from_u128(3);

        assert_eq!(
            states.adapt(
                binding,
                ActionInputKind::Trigger,
                SourceEdge::Press,
                SourceSignal::Pulse
            ),
            Some(ActionInput::Trigger)
        );
        assert_eq!(
            states.adapt(
                binding,
                ActionInputKind::Absolute,
                SourceEdge::Press,
                SourceSignal::Pulse
            ),
            None
        );
        assert!(!SourceSignal::Pulse.can_drive(ActionInputKind::Momentary));
    }

    /// Verifies buttons pass edges to momentary actions and on/off levels to absolute ones.
    #[test]
    fn buttons_drive_momentary_and_absolute_actions() {
        let mut states = SourceEdgeStates::default();
        let binding = Uuid::from_u128(4);

        assert_eq!(
            states.adapt(
                binding,
                ActionInputKind::Momentary,
                SourceEdge::Press,
                SourceSignal::Button(false)
            ),
            Some(ActionInput::Release)
        );
        assert_eq!(
            states.adapt(
                binding,
                ActionInputKind::Absolute,
                SourceEdge::Press,
                SourceSignal::Button(true)
            ),
            Some(ActionInput::Scalar(1.0))
        );
    }

    /// Verifies release bindings fire their trigger when a button or level is let go.
    #[test]
    fn release_bindings_fire_triggers_on_release() {
        let mut states = SourceEdgeStates::default();
        let button = Uuid::from_u128(5);
        let level = Uuid::from_u128(6);
        let release = |states: &mut SourceEdgeStates, binding, signal| {
            states.adapt(
                binding,
                ActionInputKind::Trigger,
                SourceEdge::Release,
                signal,
            )
        };

        assert_eq!(
            release(&mut states, button, SourceSignal::Button(true)),
            None
        );
        assert_eq!(
            release(&mut states, button, SourceSignal::Button(false)),
            Some(ActionInput::Trigger)
        );
        assert_eq!(release(&mut states, level, SourceSignal::Level(1.0)), None);
        assert_eq!(
            release(&mut states, level, SourceSignal::Level(0.0)),
            Some(ActionInput::Trigger)
        );
        assert_eq!(release(&mut states, button, SourceSignal::Pulse), None);
    }

    /// Verifies a control holds one binding per edge unless an action consumes both edges.
    #[test]
    fn bindings_overlap_on_the_same_edge_or_when_consuming_both() {
        let trigger = Some(ActionInputKind::Trigger);
        let momentary = Some(ActionInputKind::Momentary);

        assert!(!SourceEdge::Press.overlaps(trigger, SourceEdge::Release, trigger));
        assert!(!SourceEdge::Press.overlaps(None, SourceEdge::Release, trigger));
        assert!(SourceEdge::Press.overlaps(trigger, SourceEdge::Press, None));
        assert!(SourceEdge::Press.overlaps(momentary, SourceEdge::Release, trigger));
        assert!(SourceEdge::Release.accepts(ActionInputKind::Trigger));
        assert!(!SourceEdge::Release.accepts(ActionInputKind::Momentary));
    }
}
