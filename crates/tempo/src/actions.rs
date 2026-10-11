// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bindable actions for the show tempo.
//!
//! Every tempo action is a trigger, so a pad mapped to tap tempo registers one tap per hit and
//! its release is ignored before it reaches the tempo.

use bevy_app::App;
use bevy_ecs::prelude::World;
use nightfall_actions::{
    ActionAppExt, ActionDescriptor, ActionInvocation, ActionParameter, ActionParameterKind,
    ActionReference, InvocationDispatch, InvocationError,
};
use serde::{Deserialize, Serialize};

use crate::engine::{MAX_BPM, MIN_BPM};
use crate::{ShowTempo, TempoCommand};

/// Stable action ID for one tap of tap tempo.
pub const TEMPO_TAP_ACTION_ID: &str = "tempo.tap";
/// Stable action ID for easing the downbeat onto the press.
pub const TEMPO_RESYNC_ACTION_ID: &str = "tempo.resync";
/// Stable action ID for setting an exact tempo.
pub const TEMPO_SET_ACTION_ID: &str = "tempo.set";
/// Stable action ID for multiplying the tempo (half or double time).
pub const TEMPO_MULTIPLY_ACTION_ID: &str = "tempo.multiply";
/// Stable action ID for nudging the phase by a number of beats.
pub const TEMPO_NUDGE_ACTION_ID: &str = "tempo.nudge";

/// Category grouping the tempo actions in pickers and the command palette.
const TEMPO_CATEGORY: &str = "Tempo";
/// Largest tempo multiplier offered by the action picker, and the inverse of the smallest.
const MAX_TEMPO_FACTOR: f64 = 16.0;
/// Largest phase nudge in beats offered by the action picker, in either direction.
const MAX_NUDGE_BEATS: f64 = 16.0;

/// Arguments for the set-tempo action.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TempoSetActionArguments {
    /// Tempo to ease to, in beats per minute.
    pub bpm: f64,
}

/// Arguments for the multiply-tempo action.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TempoMultiplyActionArguments {
    /// Factor applied to the tempo, e.g. `2.0` or `0.5`.
    pub factor: f64,
}

/// Arguments for the nudge-tempo action.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct TempoNudgeActionArguments {
    /// Signed phase shift in beats.
    pub beats: f64,
}

/// Arguments for tempo actions that take none.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
struct NoArguments {}

/// Creates a persisted tap-tempo action reference.
pub fn tap_tempo_action() -> ActionReference {
    ActionReference::with_arguments(TEMPO_TAP_ACTION_ID, &NoArguments {})
        .expect("empty arguments should serialize")
}

/// Registers every tempo action in the shared action catalog.
pub fn register_tempo_actions(app: &mut App) {
    app.register_action::<NoArguments, _>(
        ActionDescriptor::new(TEMPO_TAP_ACTION_ID, "Tap tempo", TEMPO_CATEGORY)
            .with_description("Registers one beat; repeated taps set the tempo"),
        |world, _, invocation| tap(world, invocation),
    )
    .register_action::<NoArguments, _>(
        ActionDescriptor::new(
            TEMPO_RESYNC_ACTION_ID,
            "Resync tempo to downbeat",
            TEMPO_CATEGORY,
        )
        .with_description("Eases the bar so its downbeat lands on the press"),
        |world, _, _| apply(world, TempoCommand::Resync),
    )
    .register_action::<TempoSetActionArguments, _>(
        ActionDescriptor::new(TEMPO_SET_ACTION_ID, "Set tempo", TEMPO_CATEGORY).with_parameter(
            ActionParameter::required(
                "bpm",
                "BPM",
                ActionParameterKind::Number {
                    min: MIN_BPM,
                    max: MAX_BPM,
                },
            ),
        ),
        |world, arguments, _| apply(world, TempoCommand::SetBpm(arguments.bpm)),
    )
    .register_action::<TempoMultiplyActionArguments, _>(
        ActionDescriptor::new(TEMPO_MULTIPLY_ACTION_ID, "Multiply tempo", TEMPO_CATEGORY)
            .with_description("Scales the tempo, e.g. 2 for double time or 0.5 for half time")
            .with_parameter(ActionParameter::required(
                "factor",
                "Factor",
                ActionParameterKind::Number {
                    min: 1.0 / MAX_TEMPO_FACTOR,
                    max: MAX_TEMPO_FACTOR,
                },
            )),
        |world, arguments, _| apply(world, TempoCommand::Multiply(arguments.factor)),
    )
    .register_action::<TempoNudgeActionArguments, _>(
        ActionDescriptor::new(TEMPO_NUDGE_ACTION_ID, "Nudge tempo phase", TEMPO_CATEGORY)
            .with_description("Shifts the beat phase earlier or later without changing the tempo")
            .with_parameter(ActionParameter::required(
                "beats",
                "Beats",
                ActionParameterKind::Number {
                    min: -MAX_NUDGE_BEATS,
                    max: MAX_NUDGE_BEATS,
                },
            )),
        |world, arguments, _| apply(world, TempoCommand::Nudge(arguments.beats)),
    );
}

/// Validates a tempo command and applies it to the show tempo.
fn apply(world: &mut World, command: TempoCommand) -> Result<InvocationDispatch, InvocationError> {
    command
        .validate()
        .map_err(|message| InvocationError::new("tempo.invalid_argument", message))?;
    show_tempo(world)?.apply(&command, None);
    Ok(InvocationDispatch::succeeded())
}

/// Registers a tap, timed from when the surface received the input when it recorded that, so
/// the wait for the next frame does not skew the tempo.
fn tap(
    world: &mut World,
    invocation: &ActionInvocation,
) -> Result<InvocationDispatch, InvocationError> {
    let Some(received_at) = invocation.received_at else {
        return apply(world, TempoCommand::Tap(None));
    };
    show_tempo(world)?.tap_at(received_at);
    Ok(InvocationDispatch::succeeded())
}

/// Borrows the show tempo, failing the invocation when the tempo plugin is not installed.
fn show_tempo(world: &mut World) -> Result<bevy_ecs::world::Mut<'_, ShowTempo>, InvocationError> {
    world
        .get_resource_mut::<ShowTempo>()
        .ok_or_else(|| InvocationError::new("tempo.unavailable", "Show tempo is unavailable"))
}

#[cfg(test)]
mod tests {
    use bevy_ecs::message::Messages;
    use nightfall_actions::{
        ActionInput, ActionSurface, ActionsPlugin, InvocationOutcome, InvocationResult,
    };

    use super::*;

    /// Builds an app with action dispatch, the show tempo and the tempo actions.
    fn tempo_action_app() -> App {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        app.init_resource::<ShowTempo>();
        register_tempo_actions(&mut app);
        app
    }

    /// Invokes an action once and returns the dispatch outcome.
    fn invoke(app: &mut App, invocation: ActionInvocation) -> InvocationOutcome {
        app.world_mut().write_message(invocation);
        app.update();
        let mut results = app.world_mut().resource_mut::<Messages<InvocationResult>>();
        results
            .drain()
            .next()
            .expect("invocation should produce a result")
            .outcome
    }

    /// Verifies a MIDI release is ignored and the press applies the tempo action.
    #[test]
    fn set_tempo_applies_on_press_only() {
        let mut app = tempo_action_app();
        let action = ActionReference::with_arguments(
            TEMPO_SET_ACTION_ID,
            &TempoSetActionArguments { bpm: 90.0 },
        )
        .expect("arguments should serialize");

        invoke(
            &mut app,
            ActionInvocation::new(action.clone(), ActionSurface::Midi, ActionInput::Release),
        );
        assert_eq!(
            app.world().resource::<ShowTempo>().snapshot().target_bpm,
            120.0
        );

        invoke(
            &mut app,
            ActionInvocation::new(action, ActionSurface::Midi, ActionInput::Press),
        );
        assert_eq!(
            app.world().resource::<ShowTempo>().snapshot().target_bpm,
            90.0
        );
    }

    /// Verifies invalid persisted arguments fail instead of reaching the engine.
    #[test]
    fn invalid_multiplier_is_rejected() {
        let mut app = tempo_action_app();
        let action = ActionReference::with_arguments(
            TEMPO_MULTIPLY_ACTION_ID,
            &TempoMultiplyActionArguments { factor: 0.0 },
        )
        .expect("arguments should serialize");
        let outcome = invoke(
            &mut app,
            ActionInvocation::trigger(action, ActionSurface::Osc),
        );
        assert!(
            matches!(outcome, InvocationOutcome::Failed(_)),
            "{outcome:?}"
        );
    }

    /// Verifies the tap action reference round-trips through the registry.
    #[test]
    fn tap_action_is_accepted() {
        let mut app = tempo_action_app();
        let outcome = invoke(
            &mut app,
            ActionInvocation::trigger(tap_tempo_action(), ActionSurface::Osc),
        );
        assert!(
            matches!(outcome, InvocationOutcome::Succeeded { .. }),
            "{outcome:?}"
        );
    }
}
