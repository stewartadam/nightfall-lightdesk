// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bindable macro actions, so MIDI, OSC, keyboard, timeline and board surfaces can run macros.

use bevy_app::App;
use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_actions::{
    ActionAppExt, ActionDescriptor, ActionFeedback, ActionParameter, ActionParameterKind,
    ActionReference, InvocationError,
};
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::command::MacroCommand;
use crate::runner::MacroRuns;

/// Stable action ID for running a macro's press body.
pub const MACRO_START_ACTION_ID: &str = "macro.start";

/// Stable action ID for letting go of a held macro button, which runs the release body.
pub const MACRO_RELEASE_ACTION_ID: &str = "macro.release";

/// Stable action ID for stopping a running macro.
pub const MACRO_STOP_ACTION_ID: &str = "macro.stop";

/// Persisted arguments shared by macro actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct MacroActionArguments {
    /// Persistent UID of the addressed macro.
    #[serde(rename = "macro")]
    #[typeshare(serialized_as = "String")]
    pub macro_uid: Uuid,
}

/// Creates a persisted start-macro action reference.
pub fn start_macro_action(macro_uid: Uuid) -> ActionReference {
    macro_action_reference(MACRO_START_ACTION_ID, macro_uid)
}

/// Creates a persisted release-macro action reference.
pub fn release_macro_action(macro_uid: Uuid) -> ActionReference {
    macro_action_reference(MACRO_RELEASE_ACTION_ID, macro_uid)
}

/// Creates a persisted stop-macro action reference.
pub fn stop_macro_action(macro_uid: Uuid) -> ActionReference {
    macro_action_reference(MACRO_STOP_ACTION_ID, macro_uid)
}

/// Creates a macro action reference with its typed macro argument.
fn macro_action_reference(action_id: &str, macro_uid: Uuid) -> ActionReference {
    ActionReference::with_arguments(action_id, &MacroActionArguments { macro_uid })
        .expect("macro action arguments should serialize")
}

/// Describes the macro argument every macro action takes.
fn macro_parameter() -> ActionParameter {
    ActionParameter::required("macro", "Macro", ActionParameterKind::Macro)
}

/// Resolves a macro UID to the numeric ID its commands address.
fn resolve_macro_id(world: &World, macro_uid: Uuid) -> Result<u32, InvocationError> {
    world
        .get_resource::<DataProvider<Macro>>()
        .ok_or_else(|| {
            InvocationError::new("macro.registry_unavailable", "Macro storage is unavailable")
        })?
        .get(macro_uid)
        .map(|definition| definition.identifiers.id)
        .map_err(|_| {
            InvocationError::new(
                "macro.not_found",
                format!("Macro with UID {macro_uid} does not exist"),
            )
            .with_details(serde_json::json!({ "macro": macro_uid }))
        })
}

/// Reports a macro as active while any of its bodies runs.
fn running_feedback(
    world: &World,
    arguments: MacroActionArguments,
) -> Result<ActionFeedback, InvocationError> {
    Ok(ActionFeedback::active_if(
        world
            .get_resource::<MacroRuns>()
            .is_some_and(|runs| runs.is_running(arguments.macro_uid)),
    ))
}

/// Registers the macro actions, their feedback and the macro target validator.
///
/// `macro.start` names `macro.release` as its hold release, so a held binding runs the press
/// body on press and the release body on release, while trigger surfaces such as the timeline
/// only run the press body.
pub fn register_macro_actions(app: &mut App) {
    app.register_action_target_validator::<Uuid, _>(ActionParameterKind::Macro, |world, uid| {
        resolve_macro_id(world, uid).map(drop)
    })
    .invalidate_action_targets_when(resource_exists_and_changed::<DataProvider<Macro>>);

    app.register_command_action::<MacroActionArguments, MacroCommand, _>(
        ActionDescriptor::new(MACRO_START_ACTION_ID, "Start macro", "Macros")
            .with_description("Runs a macro's commands in order")
            .with_parameter(macro_parameter())
            .with_hold_release(MACRO_RELEASE_ACTION_ID),
        |world, arguments| {
            resolve_macro_id(world, arguments.macro_uid).map(MacroCommand::StartMacro)
        },
    )
    .register_command_action::<MacroActionArguments, MacroCommand, _>(
        ActionDescriptor::new(MACRO_RELEASE_ACTION_ID, "Release macro", "Macros")
            .with_description(
                "Stops a macro's press commands and runs its release commands, if it has any",
            )
            .with_parameter(macro_parameter()),
        |world, arguments| {
            resolve_macro_id(world, arguments.macro_uid).map(MacroCommand::ReleaseMacro)
        },
    )
    .register_command_action::<MacroActionArguments, MacroCommand, _>(
        ActionDescriptor::new(MACRO_STOP_ACTION_ID, "Stop macro", "Macros")
            .with_description("Stops a running macro before its remaining commands run")
            .with_parameter(macro_parameter()),
        |world, arguments| {
            resolve_macro_id(world, arguments.macro_uid).map(MacroCommand::StopMacro)
        },
    );
    for action_id in [MACRO_START_ACTION_ID, MACRO_STOP_ACTION_ID] {
        app.register_action_feedback::<MacroActionArguments, _>(action_id, running_feedback);
    }
}
