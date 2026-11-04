// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bindable fader and master actions.

use std::collections::BTreeSet;

use bevy_app::App;
use bevy_ecs::prelude::{DetectChanges, Local, Res, World};
use nightfall_actions::{
    ActionAppExt, ActionDescriptor, ActionFeedback, ActionInputKind, ActionParameter,
    ActionParameterKind, ActionReference, ActionSurface, InvocationError,
};
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::faders::{FaderCommand, FaderUpdate, Faders, master_contributes};
use crate::masters::{
    Master, MasterCommand, MasterKind, MasterMode, MasterUpdate, clamp_master_level,
};

/// Stable action ID for driving a fader's level from external hardware input.
pub const FADER_LEVEL_ACTION_ID: &str = "fader.level";

/// Stable action ID for running a fader's Go behavior.
pub const FADER_GO_ACTION_ID: &str = "fader.go";

/// Stable action ID for pressing and releasing a fader's button in its button mode.
pub const FADER_BUTTON_ACTION_ID: &str = "fader.button";

/// Stable action ID for driving a master's level.
pub const MASTER_LEVEL_ACTION_ID: &str = "master.level";

/// Stable action ID for toggling a toggle-mode master.
pub const MASTER_TOGGLE_ACTION_ID: &str = "master.toggle";

/// Stable action ID for turning a toggle-mode master on.
pub const MASTER_ON_ACTION_ID: &str = "master.on";

/// Stable action ID for turning a toggle-mode master off.
pub const MASTER_OFF_ACTION_ID: &str = "master.off";

/// Stable action ID for halving a speed master.
pub const MASTER_SPEED_HALF_ACTION_ID: &str = "master.speed-half";

/// Stable action ID for doubling a speed master.
pub const MASTER_SPEED_DOUBLE_ACTION_ID: &str = "master.speed-double";

/// Stable action ID for returning a speed master to ×1.
pub const MASTER_SPEED_RESET_ACTION_ID: &str = "master.speed-reset";

/// Persisted arguments for externally-driven fader actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FaderActionArguments {
    /// One-based fader index in the backend-owned fader bank.
    pub fader_index: u32,
}

/// Persisted arguments for actions addressing one master.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct MasterActionArguments {
    /// Persistent UID of the addressed master.
    #[typeshare(serialized_as = "String")]
    pub master: Uuid,
}

/// Creates a persisted fader level action reference.
pub fn fader_level_action(fader_index: u32) -> ActionReference {
    fader_action_reference(FADER_LEVEL_ACTION_ID, fader_index)
}

/// Creates a persisted fader Go action reference.
pub fn fader_go_action(fader_index: u32) -> ActionReference {
    fader_action_reference(FADER_GO_ACTION_ID, fader_index)
}

/// Creates a persisted fader button action reference.
pub fn fader_button_action(fader_index: u32) -> ActionReference {
    fader_action_reference(FADER_BUTTON_ACTION_ID, fader_index)
}

/// Creates a persisted master level action reference.
pub fn master_level_action(master: Uuid) -> ActionReference {
    master_action_reference(MASTER_LEVEL_ACTION_ID, master)
}

/// Creates a persisted master toggle action reference.
pub fn master_toggle_action(master: Uuid) -> ActionReference {
    master_action_reference(MASTER_TOGGLE_ACTION_ID, master)
}

/// Registers every bindable fader and master action.
pub fn register_control_actions(app: &mut App) {
    register_control_target_validators(app);
    app.register_update_action::<FaderActionArguments, FaderUpdate, _>(
        ActionDescriptor::new(FADER_LEVEL_ACTION_ID, "Fader level", "Faders")
            .with_description("Drives a fader from hardware with soft pickup")
            .with_input(ActionInputKind::Absolute)
            .with_parameter(fader_parameter()),
        |_world, arguments, value| {
            Ok(FaderUpdate::SetExternalHardwareValue {
                fader_index: arguments.fader_index,
                value: value * 100.0,
            })
        },
    )
    .register_action_feedback::<FaderActionArguments, _>(
        FADER_LEVEL_ACTION_ID,
        |world, arguments| {
            let (level, active) = fader_live_state(world, arguments.fader_index)?;
            Ok(ActionFeedback {
                level: Some((level / 100.0).clamp(0.0, 1.0)),
                ..ActionFeedback::active_if(active)
            })
        },
    );
    app.register_command_action::<FaderActionArguments, FaderCommand, _>(
        ActionDescriptor::new(FADER_GO_ACTION_ID, "Fader Go", "Faders")
            .with_description("Starts or advances the fader's clip, or toggles its master")
            .with_parameter(fader_parameter()),
        |_world, arguments| {
            Ok(FaderCommand::Go {
                fader_index: arguments.fader_index,
            })
        },
    )
    .register_action_feedback::<FaderActionArguments, _>(
        FADER_GO_ACTION_ID,
        |world, arguments| {
            let (_, active) = fader_live_state(world, arguments.fader_index)?;
            Ok(ActionFeedback::active_if(active))
        },
    );
    app.register_momentary_command_action::<FaderActionArguments, FaderCommand, _>(
        ActionDescriptor::new(FADER_BUTTON_ACTION_ID, "Fader button", "Faders")
            .with_description("Presses and releases the fader's button in its button mode")
            .with_input(ActionInputKind::Momentary)
            .with_surfaces([
                ActionSurface::Midi,
                ActionSurface::Osc,
                ActionSurface::Websocket,
            ])
            .with_parameter(fader_parameter()),
        |_world, arguments, pressed| {
            let fader_index = arguments.fader_index;
            Ok(if pressed {
                FaderCommand::PressButton { fader_index }
            } else {
                FaderCommand::ReleaseButton { fader_index }
            })
        },
    );
    app.register_action_feedback::<FaderActionArguments, _>(
        FADER_BUTTON_ACTION_ID,
        |world, arguments| {
            let (_, active) = fader_live_state(world, arguments.fader_index)?;
            Ok(ActionFeedback::active_if(active))
        },
    );
    app.register_update_action::<MasterActionArguments, MasterUpdate, _>(
        ActionDescriptor::new(MASTER_LEVEL_ACTION_ID, "Master level", "Masters")
            .with_input(ActionInputKind::Absolute)
            .with_parameter(master_parameter()),
        |world, arguments, value| {
            let master = resolve_master(world, arguments.master)?;
            Ok(MasterUpdate::SetLevel {
                id: master.identifiers.id,
                level_percent: Master::level_percent_from_control(master.kind, value * 100.0),
            })
        },
    )
    .register_flash_level::<MasterActionArguments, _>(MASTER_LEVEL_ACTION_ID, |world, arguments| {
        let master = resolve_master(world, arguments.master)?;
        Ok(Some(
            Master::control_percent_from_level(master.kind, master.level_percent) / 100.0,
        ))
    })
    .register_action_feedback::<MasterActionArguments, _>(
        MASTER_LEVEL_ACTION_ID,
        |world, arguments| {
            let master = resolve_master(world, arguments.master)?;
            Ok(ActionFeedback::level(
                Master::control_percent_from_level(master.kind, master.level_percent) / 100.0,
            ))
        },
    );
    app.register_command_action::<MasterActionArguments, MasterCommand, _>(
        ActionDescriptor::new(MASTER_TOGGLE_ACTION_ID, "Toggle master", "Masters")
            .with_parameter(master_parameter()),
        |world, arguments| {
            let master = resolve_master(world, arguments.master)?;
            Ok(MasterCommand::ToggleMaster {
                id: master.identifiers.id,
            })
        },
    );
    for (action_id, label, active) in [
        (MASTER_ON_ACTION_ID, "Master on", true),
        (MASTER_OFF_ACTION_ID, "Master off", false),
    ] {
        let mut descriptor = ActionDescriptor::new(action_id, label, "Masters")
            .with_description("Turns a toggle-mode master on or off")
            .with_parameter(master_parameter());
        if active {
            descriptor = descriptor.with_hold_release(MASTER_OFF_ACTION_ID);
        }
        app.register_command_action::<MasterActionArguments, MasterCommand, _>(
            descriptor,
            move |world, arguments| set_master_active(world, arguments.master, active),
        );
    }
    for action_id in [
        MASTER_TOGGLE_ACTION_ID,
        MASTER_ON_ACTION_ID,
        MASTER_OFF_ACTION_ID,
    ] {
        app.register_action_feedback::<MasterActionArguments, _>(action_id, |world, arguments| {
            let master = resolve_master(world, arguments.master)?;
            Ok(ActionFeedback::active_if(master_contributes(&master)))
        });
    }
    for (action_id, label, description, step) in [
        (
            MASTER_SPEED_HALF_ACTION_ID,
            "Speed master ×½",
            "Halves a speed master, down to ×¼",
            SpeedMasterStep::Half,
        ),
        (
            MASTER_SPEED_DOUBLE_ACTION_ID,
            "Speed master ×2",
            "Doubles a running speed master, up to ×2",
            SpeedMasterStep::Double,
        ),
        (
            MASTER_SPEED_RESET_ACTION_ID,
            "Speed master ×1",
            "Returns a speed master to normal speed",
            SpeedMasterStep::Reset,
        ),
    ] {
        app.register_command_action::<MasterActionArguments, MasterCommand, _>(
            ActionDescriptor::new(action_id, label, "Masters")
                .with_description(description)
                .with_parameter(master_parameter()),
            move |world, arguments| step_speed_master(world, arguments.master, step),
        );
    }
}

/// Registers how stored bindings check that their master and fader targets exist.
///
/// Binding diagnostics are recomputed when the set of masters or the number of faders
/// changes.
fn register_control_target_validators(app: &mut App) {
    app.register_action_target_validator::<Uuid, _>(ActionParameterKind::Master, |world, uid| {
        resolve_master(world, uid).map(drop)
    })
    .register_action_target_validator::<u32, _>(ActionParameterKind::Fader, validate_fader)
    .invalidate_action_targets_when(master_set_changed)
    .invalidate_action_targets_when(fader_count_changed);
}

/// Run condition reporting whether masters were added or removed.
///
/// Master levels change on every fader move and master targets only need to exist, so this
/// compares the set of master UIDs, and only on frames where masters changed at all.
fn master_set_changed(
    masters: Option<Res<DataProvider<Master>>>,
    mut last_uids: Local<Option<BTreeSet<Uuid>>>,
) -> bool {
    let Some(masters) = masters else {
        return last_uids.take().is_some();
    };
    if !masters.is_changed() && last_uids.is_some() {
        return false;
    }
    let uids: BTreeSet<Uuid> = masters.iter().map(|entry| *entry.key()).collect();
    let changed = last_uids.as_ref() != Some(&uids);
    *last_uids = Some(uids);
    changed
}

/// Run condition reporting whether the fader bank gained or lost faders.
///
/// Faders change on every move, so this compares fader counts rather than change
/// ticks to avoid recomputing binding diagnostics while a fader is dragged.
fn fader_count_changed(faders: Option<Res<Faders>>, mut last_count: Local<Option<usize>>) -> bool {
    let count = faders.map(|faders| faders.fader_count());
    let changed = *last_count != count;
    *last_count = count;
    changed
}

/// Checks that a 1-based fader index addresses a fader in the bank.
///
/// Unassigned faders are valid targets, since a binding follows whatever is later assigned.
fn validate_fader(world: &World, fader_index: u32) -> Result<(), InvocationError> {
    let faders = world
        .get_resource::<Faders>()
        .ok_or_else(|| InvocationError::new("fader.bank_unavailable", "Faders are unavailable"))?;
    if faders.contains(fader_index) {
        return Ok(());
    }
    Err(InvocationError::new(
        "fader.not_found",
        format!(
            "Fader {fader_index} does not exist; faders are numbered 1 to {}",
            faders.fader_count()
        ),
    )
    .with_details(serde_json::json!({ "fader_index": fader_index })))
}

/// Creates a fader action reference for one stable action ID.
fn fader_action_reference(action_id: &str, fader_index: u32) -> ActionReference {
    ActionReference::with_arguments(action_id, &FaderActionArguments { fader_index })
        .expect("fader action arguments should serialize")
}

/// Creates a master action reference for one stable action ID.
fn master_action_reference(action_id: &str, master: Uuid) -> ActionReference {
    ActionReference::with_arguments(action_id, &MasterActionArguments { master })
        .expect("master action arguments should serialize")
}

/// Describes the fader argument shared by fader actions.
fn fader_parameter() -> ActionParameter {
    ActionParameter::required("fader_index", "Fader", ActionParameterKind::Fader)
}

/// Describes the master argument shared by master actions.
fn master_parameter() -> ActionParameter {
    ActionParameter::required("master", "Master", ActionParameterKind::Master)
}

/// Resolves a persisted master UID to a copy of its current definition.
fn resolve_master(world: &World, uid: Uuid) -> Result<Master, InvocationError> {
    world
        .get_resource::<DataProvider<Master>>()
        .ok_or_else(|| {
            InvocationError::new(
                "master.registry_unavailable",
                "Master storage is unavailable",
            )
        })?
        .get(uid)
        .map(|master| master.clone())
        .map_err(|_| {
            InvocationError::new(
                "master.not_found",
                format!("Master with UID {uid} does not exist"),
            )
            .with_details(serde_json::json!({ "master": uid }))
        })
}

/// One press of a speed master's ×½, ×2 or ×1 action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SpeedMasterStep {
    /// Halve the current speed.
    Half,
    /// Double the current speed.
    Double,
    /// Return to normal speed.
    Reset,
}

/// Lowest level the ×½ action steps down to, so repeated presses never stop playback.
const SPEED_MASTER_MIN_STEP_PERCENT: f32 = 25.0;

/// Lowers a speed master's ×½, ×2 or ×1 action to an undoable level change.
///
/// Halving stops at ×¼ and doubling at the master's ×2 maximum. Masters of any other kind
/// reject the action, since halving an intensity master is not a speed change.
fn step_speed_master(
    world: &World,
    uid: Uuid,
    step: SpeedMasterStep,
) -> Result<MasterCommand, InvocationError> {
    let master = resolve_master(world, uid)?;
    if master.kind != MasterKind::PlaybackSpeed {
        return Err(InvocationError::new(
            "master.not_speed",
            format!(
                "Master '{}' is not a speed master",
                master.identifiers.label
            ),
        )
        .with_details(serde_json::json!({ "master": uid })));
    }
    let level_percent = match step {
        SpeedMasterStep::Half => (master.level_percent / 2.0)
            .max(SPEED_MASTER_MIN_STEP_PERCENT)
            .min(master.level_percent),
        SpeedMasterStep::Double => master.level_percent * 2.0,
        SpeedMasterStep::Reset => 100.0,
    };
    Ok(MasterCommand::SetMasterLevel {
        id: master.identifiers.id,
        level_percent: clamp_master_level(MasterKind::PlaybackSpeed, level_percent),
    })
}

/// Lowers turning a toggle-mode master on or off to a mode change.
///
/// Masters in other modes are rejected so a held button never changes how a master works.
fn set_master_active(
    world: &World,
    uid: Uuid,
    active: bool,
) -> Result<MasterCommand, InvocationError> {
    let master = resolve_master(world, uid)?;
    if !matches!(master.mode, MasterMode::Toggle { .. }) {
        return Err(InvocationError::new(
            "master.not_toggle",
            format!(
                "Master '{}' is not a toggle master",
                master.identifiers.label
            ),
        )
        .with_details(serde_json::json!({ "master": uid })));
    }
    Ok(MasterCommand::SetMasterMode {
        id: master.identifiers.id,
        mode: MasterMode::Toggle { active },
    })
}

/// Reads a fader's console level and whether its assignment is running.
fn fader_live_state(world: &World, fader_index: u32) -> Result<(f32, bool), InvocationError> {
    validate_fader(world, fader_index)?;
    world
        .resource::<Faders>()
        .live_state(world, fader_index)
        .ok_or_else(|| InvocationError::new("fader.not_found", "Fader does not exist"))
}

#[cfg(test)]
mod tests {
    use bevy_ecs::change_detection::DetectChanges;
    use bevy_ecs::message::Messages;
    use nightfall_actions::{ActionInput, ActionInvocation, ActionsPlugin};

    use super::*;

    /// Creates a focused app containing registry dispatch and the control action registrations.
    fn control_action_app() -> App {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        app.add_message::<FaderUpdate>();
        app.add_message::<MasterUpdate>();
        app.init_resource::<DataProvider<Master>>();
        app.init_resource::<Faders>();
        app.init_resource::<CommandTracker>();
        app.init_resource::<PendingCommandBuffer>();
        register_control_actions(&mut app);
        app
    }

    /// Drains the commands queued for undo capture and ingress dispatch.
    fn take_pending_commands(app: &mut App) -> Vec<PayloadEnvelope> {
        app.world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .drain()
    }

    /// Verifies normalized action input is converted to the desk fader percentage scale.
    #[test]
    fn fader_action_writes_normalized_update() {
        let mut app = control_action_app();
        app.world_mut().write_message(ActionInvocation::scalar(
            fader_level_action(3),
            ActionSurface::Osc,
            0.25,
        ));

        app.update();

        let updates = app
            .world_mut()
            .resource_mut::<Messages<FaderUpdate>>()
            .drain()
            .collect::<Vec<_>>();
        assert!(matches!(
            updates.as_slice(),
            [FaderUpdate::SetExternalHardwareValue {
                fader_index: 3,
                value,
            }] if (*value - 25.0).abs() < f32::EPSILON
        ));
        assert!(take_pending_commands(&mut app).is_empty());
    }

    /// Verifies the master target validator reports a missing master and accepts a present one.
    #[test]
    fn target_validation_resolves_masters() {
        let mut app = control_action_app();
        let master_uid = Uuid::from_u128(41);
        /// Validates one reference's targets against the app's current world.
        fn validate(app: &App, action: &ActionReference) -> Result<(), InvocationError> {
            app.world()
                .resource::<nightfall_actions::ActionRegistry>()
                .validate_target(app.world(), action)
        }

        assert_eq!(
            validate(&app, &master_level_action(master_uid)).map_err(|error| error.code),
            Err("master.not_found".to_string())
        );

        add_speed_master(&mut app);

        assert!(validate(&app, &master_level_action(master_uid)).is_ok());
        assert!(validate(&app, &fader_go_action(2)).is_ok());
    }

    /// Verifies fader targets accept every fader in the bank, assigned or not, and reject
    /// indices outside `1..=fader_count`.
    #[test]
    fn target_validation_bounds_faders() {
        let app = control_action_app();
        let registry = app.world().resource::<nightfall_actions::ActionRegistry>();
        let last = u32::try_from(app.world().resource::<Faders>().fader_count())
            .expect("fader count fits in u32");
        let code = |index| {
            registry
                .validate_target(app.world(), &fader_go_action(index))
                .map_err(|error| error.code)
        };

        assert_eq!(code(1), Ok(()));
        assert_eq!(code(last), Ok(()));
        assert_eq!(code(0), Err("fader.not_found".to_string()));
        assert_eq!(code(last + 1), Err("fader.not_found".to_string()));
        assert_eq!(
            registry
                .validate_target(app.world(), &fader_level_action(last + 1))
                .map_err(|error| error.code),
            Err("fader.not_found".to_string())
        );
    }

    /// Verifies changing a master's level leaves action targets untouched, so dragging a
    /// master fader does not recompute binding diagnostics, while adding a master marks them.
    #[test]
    fn only_master_set_changes_mark_action_targets_changed() {
        let mut app = control_action_app();
        let uid = add_speed_master(&mut app);
        app.update();
        app.update();
        /// Returns when action targets were last marked changed.
        fn targets_changed(app: &App) -> bevy_ecs::change_detection::Tick {
            app.world()
                .resource_ref::<nightfall_actions::ActionTargets>()
                .last_changed()
        }
        let settled = targets_changed(&app);

        let mut masters = app.world_mut().resource_mut::<DataProvider<Master>>();
        let mut master = masters.remove(&uid).expect("master should exist");
        master.level_percent = 40.0;
        masters.add(master).expect("master should store");
        app.update();
        assert_eq!(
            targets_changed(&app),
            settled,
            "a level change is not a target change"
        );

        let second = Master {
            identifiers: nightfall::prelude::Identifiers {
                id: 5,
                uid: Uuid::from_u128(42),
                label: "Second".to_string(),
            },
            ..app
                .world()
                .resource::<DataProvider<Master>>()
                .get(uid)
                .expect("master should exist")
                .clone()
        };
        app.world_mut()
            .resource_mut::<DataProvider<Master>>()
            .add(second)
            .expect("master should store");
        app.update();
        assert!(
            targets_changed(&app).is_newer_than(settled, app.world().read_change_tick()),
            "adding a master should mark action targets changed"
        );
    }

    /// Stores a toggle-mode playback speed master and returns its persistent UID.
    fn add_speed_master(app: &mut App) -> Uuid {
        let uid = Uuid::from_u128(41);
        app.world_mut()
            .resource_mut::<DataProvider<Master>>()
            .add(Master {
                identifiers: nightfall::prelude::Identifiers {
                    id: 4,
                    uid,
                    label: "Speed".to_string(),
                },
                kind: crate::masters::MasterKind::PlaybackSpeed,
                target: crate::masters::MasterTarget::Instances(
                    crate::masters::InstanceMasterTarget::All,
                ),
                mode: crate::masters::MasterMode::Toggle { active: false },
                level_percent: 100.0,
            })
            .expect("master should store");
        uid
    }

    /// Verifies master level input is scaled to the master kind's range as an untracked update.
    #[test]
    fn master_level_action_scales_speed_masters() {
        let mut app = control_action_app();
        let uid = add_speed_master(&mut app);
        app.world_mut().write_message(ActionInvocation::scalar(
            master_level_action(uid),
            ActionSurface::Midi,
            0.75,
        ));

        app.update();

        let updates = app
            .world_mut()
            .resource_mut::<Messages<MasterUpdate>>()
            .drain()
            .collect::<Vec<_>>();
        assert!(matches!(
            updates.as_slice(),
            [MasterUpdate::SetLevel { id: 4, level_percent }]
                if (*level_percent - 150.0).abs() < f32::EPSILON
        ));
        assert!(take_pending_commands(&mut app).is_empty());
    }

    /// Verifies master toggle resolves the master UID to a tracked toggle command.
    #[test]
    fn master_toggle_action_submits_toggle_command() {
        let mut app = control_action_app();
        let uid = add_speed_master(&mut app);
        app.world_mut().write_message(ActionInvocation::trigger(
            master_toggle_action(uid),
            ActionSurface::Osc,
        ));

        app.update();

        let pending = take_pending_commands(&mut app);
        assert!(matches!(
            pending
                .as_slice()
                .first()
                .and_then(|envelope| envelope.payload.as_any().downcast_ref::<MasterCommand>()),
            Some(MasterCommand::ToggleMaster { id: 4 })
        ));
    }

    /// Invokes one speed-step action on a speed master at `level_percent` and returns the
    /// level it sets.
    fn speed_step_level(action_id: &str, level_percent: f32) -> f32 {
        let mut app = control_action_app();
        let uid = add_speed_master(&mut app);
        let mut masters = app.world_mut().resource_mut::<DataProvider<Master>>();
        let mut master = masters.remove(&uid).expect("speed master is stored");
        master.level_percent = level_percent;
        masters.add(master).expect("speed master re-stores");
        app.world_mut().write_message(ActionInvocation::trigger(
            master_action_reference(action_id, uid),
            ActionSurface::Midi,
        ));
        app.update();

        match take_pending_commands(&mut app)
            .first()
            .and_then(|envelope| envelope.payload.as_any().downcast_ref::<MasterCommand>())
        {
            Some(MasterCommand::SetMasterLevel {
                id: 4,
                level_percent,
            }) => *level_percent,
            other => panic!("expected a speed master level change, got {other:?}"),
        }
    }

    /// Verifies ×½ and ×2 step a speed master between ×¼ and ×2, and ×1 resets it.
    #[test]
    fn speed_master_steps_halve_double_and_reset() {
        assert_eq!(speed_step_level(MASTER_SPEED_HALF_ACTION_ID, 100.0), 50.0);
        assert_eq!(speed_step_level(MASTER_SPEED_HALF_ACTION_ID, 40.0), 25.0);
        assert_eq!(
            speed_step_level(MASTER_SPEED_HALF_ACTION_ID, 10.0),
            10.0,
            "halving below x1/4 never speeds a master up"
        );
        assert_eq!(speed_step_level(MASTER_SPEED_DOUBLE_ACTION_ID, 50.0), 100.0);
        assert_eq!(
            speed_step_level(MASTER_SPEED_DOUBLE_ACTION_ID, 150.0),
            200.0
        );
        assert_eq!(speed_step_level(MASTER_SPEED_RESET_ACTION_ID, 37.0), 100.0);
    }

    /// Verifies Master on and off set a toggle master's state and pair up for Hold.
    #[test]
    fn master_on_and_off_set_toggle_state() {
        let mut app = control_action_app();
        let uid = add_speed_master(&mut app);
        let on = master_action_reference(MASTER_ON_ACTION_ID, uid);
        assert_eq!(
            app.world()
                .resource::<nightfall_actions::ActionRegistry>()
                .hold_release_action(&on),
            Some(master_action_reference(MASTER_OFF_ACTION_ID, uid))
        );
        for action in [on, master_action_reference(MASTER_OFF_ACTION_ID, uid)] {
            app.world_mut()
                .write_message(ActionInvocation::trigger(action, ActionSurface::Midi));
            app.update();
        }

        let modes = take_pending_commands(&mut app)
            .iter()
            .filter_map(|envelope| match envelope.payload.as_any().downcast_ref() {
                Some(MasterCommand::SetMasterMode { id: 4, mode }) => Some(mode.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            modes,
            vec![
                MasterMode::Toggle { active: true },
                MasterMode::Toggle { active: false }
            ]
        );
    }

    /// Verifies flashing a master pushes it to full and restores its level on release.
    #[test]
    fn master_level_flash_restores_the_previous_level() {
        let mut app = control_action_app();
        let uid = add_speed_master(&mut app);
        for input in [ActionInput::Press, ActionInput::Release] {
            app.world_mut().write_message(ActionInvocation::new(
                master_level_action(uid),
                ActionSurface::Midi,
                input,
            ));
            app.update();
        }

        let levels = app
            .world_mut()
            .resource_mut::<Messages<MasterUpdate>>()
            .drain()
            .filter_map(|update| match update {
                MasterUpdate::SetLevel {
                    id: 4,
                    level_percent,
                } => Some(level_percent),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(levels, vec![200.0, 100.0]);
    }

    /// Verifies fader Go lowers to the fader Go command expanded later in the frame.
    #[test]
    fn fader_go_action_submits_fader_go_command() {
        let mut app = control_action_app();
        app.world_mut().write_message(ActionInvocation::new(
            fader_go_action(2),
            ActionSurface::Midi,
            nightfall_actions::ActionInput::Press,
        ));

        app.update();

        let pending = take_pending_commands(&mut app);
        assert!(matches!(
            pending
                .as_slice()
                .first()
                .and_then(|envelope| envelope.payload.as_any().downcast_ref::<FaderCommand>()),
            Some(FaderCommand::Go { fader_index: 2 })
        ));
    }

    /// Verifies the fader button action lowers each press and release edge to its own
    /// fader command, so held MIDI pads reach the fader's button mode on both edges.
    #[test]
    fn fader_button_action_submits_press_and_release_commands() {
        let mut app = control_action_app();
        for input in [ActionInput::Press, ActionInput::Release] {
            app.world_mut().write_message(ActionInvocation::new(
                fader_button_action(3),
                ActionSurface::Midi,
                input,
            ));
            app.update();
        }

        let commands = take_pending_commands(&mut app)
            .iter()
            .filter_map(|envelope| {
                envelope
                    .payload
                    .as_any()
                    .downcast_ref::<FaderCommand>()
                    .cloned()
            })
            .collect::<Vec<_>>();
        assert!(matches!(
            commands.as_slice(),
            [
                FaderCommand::PressButton { fader_index: 3 },
                FaderCommand::ReleaseButton { fader_index: 3 }
            ]
        ));
    }
}
