// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Mappable MIDI and OSC actions for the show tempo.
//!
//! Each action applies on a press only: a MIDI note-off or a zero OSC value is ignored, so a
//! pad mapped to tap tempo registers one tap per hit.

use bevy_app::App;
use bevy_ecs::prelude::World;
use nightfall_actions::{
    ActionDescriptor, ActionId, ActionInput, ActionInvocation, ActionReference, ActionRegistry,
    ActionSurface, InvocationDispatch, InvocationError,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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

/// Registers every tempo action with the shared action registry.
pub fn register_tempo_actions(app: &mut App) {
    let Some(mut registry) = app.world_mut().get_resource_mut::<ActionRegistry>() else {
        tracing::warn!("ActionRegistry unavailable; tempo actions are not mappable");
        return;
    };
    registry.register::<NoArguments, _>(
        descriptor(
            TEMPO_TAP_ACTION_ID,
            "Tap tempo",
            json!({ "type": "object" }),
        ),
        |world, _: NoArguments, invocation| tap_on_press(world, invocation),
    );
    registry.register::<NoArguments, _>(
        descriptor(
            TEMPO_RESYNC_ACTION_ID,
            "Resync tempo to downbeat",
            json!({ "type": "object" }),
        ),
        |world, _: NoArguments, invocation| apply_on_press(world, invocation, TempoCommand::Resync),
    );
    registry.register::<TempoSetActionArguments, _>(
        descriptor(TEMPO_SET_ACTION_ID, "Set tempo", number_schema("bpm")),
        |world, arguments, invocation| {
            apply_on_press(world, invocation, TempoCommand::SetBpm(arguments.bpm))
        },
    );
    registry.register::<TempoMultiplyActionArguments, _>(
        descriptor(
            TEMPO_MULTIPLY_ACTION_ID,
            "Multiply tempo",
            number_schema("factor"),
        ),
        |world, arguments, invocation| {
            apply_on_press(world, invocation, TempoCommand::Multiply(arguments.factor))
        },
    );
    registry.register::<TempoNudgeActionArguments, _>(
        descriptor(
            TEMPO_NUDGE_ACTION_ID,
            "Nudge tempo phase",
            number_schema("beats"),
        ),
        |world, arguments, invocation| {
            apply_on_press(world, invocation, TempoCommand::Nudge(arguments.beats))
        },
    );
}

/// Applies a tempo command when the invocation is a press, ignoring releases.
fn apply_on_press(
    world: &mut World,
    invocation: &ActionInvocation,
    command: TempoCommand,
) -> Result<InvocationDispatch, InvocationError> {
    if !is_press(&invocation.input) {
        return Ok(InvocationDispatch::Succeeded { output: None });
    }
    command
        .validate()
        .map_err(|message| InvocationError::new("tempo.invalid_argument", message))?;
    world
        .get_resource_mut::<ShowTempo>()
        .ok_or_else(|| InvocationError::new("tempo.unavailable", "Show tempo is unavailable"))?
        .apply(&command, None);
    Ok(InvocationDispatch::Succeeded { output: None })
}

/// Registers a tap when the invocation is a press, timed from when the surface received
/// the input so the wait for the next frame does not skew the tempo.
fn tap_on_press(
    world: &mut World,
    invocation: &ActionInvocation,
) -> Result<InvocationDispatch, InvocationError> {
    let Some(received_at) = invocation.received_at else {
        return apply_on_press(world, invocation, TempoCommand::Tap(None));
    };
    if is_press(&invocation.input) {
        world
            .get_resource_mut::<ShowTempo>()
            .ok_or_else(|| InvocationError::new("tempo.unavailable", "Show tempo is unavailable"))?
            .tap_at(received_at);
    }
    Ok(InvocationDispatch::Succeeded { output: None })
}

/// Returns whether an input represents a press rather than a release.
fn is_press(input: &ActionInput) -> bool {
    match input {
        ActionInput::Trigger => true,
        ActionInput::Scalar(value) => *value > 0.0,
    }
}

/// Builds a descriptor for a tempo action available from MIDI and OSC.
fn descriptor(id: &str, label: &str, argument_schema: Value) -> ActionDescriptor {
    ActionDescriptor {
        id: ActionId::new(id),
        label: label.to_string(),
        allowed_surfaces: vec![ActionSurface::Midi, ActionSurface::Osc],
        argument_schema,
    }
}

/// Builds a JSON Schema for an object with one required number property.
fn number_schema(property: &str) -> Value {
    json!({
        "type": "object",
        "required": [property],
        "properties": { property: { "type": "number" } }
    })
}

#[cfg(test)]
mod tests {
    use bevy_ecs::message::Messages;
    use nightfall_actions::{ActionsPlugin, InvocationOutcome, InvocationResult};

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

    /// Verifies a MIDI press applies the tempo action and a release does not.
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
            ActionInvocation::scalar(action.clone(), ActionSurface::Midi, 0.0),
        );
        assert_eq!(
            app.world().resource::<ShowTempo>().snapshot().target_bpm,
            120.0
        );

        invoke(
            &mut app,
            ActionInvocation::scalar(action, ActionSurface::Midi, 1.0),
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
