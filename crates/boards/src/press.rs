// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The `board.press` action: what a press on a board button does for each target type.
//!
//! A press is planned against the live state in one step and lowered to the owning domains'
//! own tracked commands, which share one undo step. Exclusive frames and collections turn
//! their other engaged buttons off as part of the same press.

use std::collections::HashSet;

use bevy_app::App;
use bevy_ecs::{prelude::*, system::SystemState};
use nightfall::prelude::*;
use nightfall_actions::{
    ActionAppExt, ActionDescriptor, ActionInvocation, ActionSurface, InvocationDispatch,
    InvocationError,
};
use nightfall_clips::ClipCommand;
use nightfall_desk::prelude::{MasterCommand, MasterMode};
use nightfall_engine::prelude::*;
use nightfall_programmer::prelude::{
    ProgrammerAttributeOperation, ProgrammerAttributeSource, ProgrammerCommand,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    model::{Board, BoardElementKind},
    status::{BoardItemState, BoardObjects, BoardStateContext},
};

/// Stable action ID for pressing a board button.
pub const BOARD_PRESS_ACTION_ID: &str = "board.press";

/// Arguments identifying one pressed button on a board.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BoardPressArguments {
    /// Board holding the button.
    #[typeshare(serialized_as = "String")]
    pub board: Uuid,
    /// Element the button belongs to.
    #[typeshare(serialized_as = "String")]
    pub element: Uuid,
    /// Object the button presses; one of the element's current targets.
    pub target: ObjectIdentity,
}

/// One domain command produced by a press.
#[derive(Debug, Clone)]
#[expect(
    clippy::large_enum_variant,
    reason = "a press plans a handful of commands that are submitted immediately"
)]
pub(crate) enum PressCommand {
    /// Start or stop a clip.
    Clip(ClipCommand),
    /// Change the Programmer selection or values.
    Programmer(ProgrammerCommand),
    /// Toggle a master.
    Master(MasterCommand),
}

/// Registers the board press action, invokable only from boards.
pub(crate) fn register_board_press_action(app: &mut App) {
    app.register_action::<BoardPressArguments, _>(
        ActionDescriptor::new(BOARD_PRESS_ACTION_ID, "Press board button", "Board")
            .with_description("Runs the pressed board button's default action")
            .with_surfaces([ActionSurface::Board]),
        invoke_board_press,
    );
}

/// Plans a press against the live state and submits its commands as one undo step.
fn invoke_board_press(
    world: &mut World,
    arguments: BoardPressArguments,
    invocation: &ActionInvocation,
) -> Result<InvocationDispatch, InvocationError> {
    let commands = {
        let mut state: SystemState<(Res<DataProvider<Board>>, BoardObjects)> =
            SystemState::new(world);
        let (boards, objects) = state.get(world).map_err(|error| {
            InvocationError::new(
                "board.state_unavailable",
                format!("Board state is unavailable: {error}"),
            )
        })?;
        let board = boards.get(arguments.board).map_err(|_| {
            InvocationError::new("board.not_found", "The pressed board no longer exists")
        })?;
        plan_press(&board, &objects, &arguments)?
    };

    let undo_id = UndoId::new();
    for command in commands {
        match command {
            PressCommand::Clip(command) => {
                submit_in_undo_step(world, invocation, undo_id, command)?
            }
            PressCommand::Programmer(command) => {
                submit_in_undo_step(world, invocation, undo_id, command)?
            }
            PressCommand::Master(command) => {
                submit_in_undo_step(world, invocation, undo_id, command)?
            }
        }
    }
    Ok(InvocationDispatch::Accepted)
}

/// Decides which commands a press produces from the board, the button and the live state.
pub(crate) fn plan_press(
    board: &Board,
    objects: &BoardObjects,
    arguments: &BoardPressArguments,
) -> Result<Vec<PressCommand>, InvocationError> {
    let element = board.element(arguments.element).ok_or_else(|| {
        InvocationError::new(
            "board.element_not_found",
            "The pressed button no longer exists",
        )
    })?;
    let targets = objects.element_targets(element);
    if !targets.contains(&arguments.target) {
        return Err(InvocationError::new(
            "board.target_not_on_element",
            "The pressed object is no longer shown on that button",
        ));
    }
    let siblings: Vec<ObjectIdentity> = match &element.kind {
        BoardElementKind::Collection {
            exclusive: true, ..
        } => targets
            .into_iter()
            .filter(|target| *target != arguments.target)
            .collect(),
        BoardElementKind::Target { .. } => board.exclusive_target_siblings(element),
        _ => Vec::new(),
    };

    let context = objects.state_context();
    let target = arguments.target;
    let state = objects.item_state(&context, &target);
    if state == BoardItemState::Missing {
        return Err(InvocationError::new(
            "board.target_missing",
            "The object behind this button was deleted",
        ));
    }
    let identifiers = objects.identifiers(&target).ok_or_else(|| {
        InvocationError::new(
            "board.target_missing",
            "The object behind this button was deleted",
        )
    })?;
    let engaged_siblings = || {
        siblings
            .iter()
            .filter(|sibling| {
                matches!(
                    objects.item_state(&context, sibling),
                    BoardItemState::On | BoardItemState::Partial
                )
            })
            .copied()
            .collect::<Vec<_>>()
    };

    let commands = match target.object_type {
        ObjectType::Clip => {
            if state.is_on() {
                vec![PressCommand::Clip(ClipCommand::StopClip(IdExpr::Single(
                    identifiers.id,
                )))]
            } else {
                let mut commands: Vec<PressCommand> = engaged_siblings()
                    .iter()
                    .filter_map(|sibling| objects.identifiers(sibling))
                    .map(|sibling| {
                        PressCommand::Clip(ClipCommand::StopClip(IdExpr::Single(sibling.id)))
                    })
                    .collect();
                commands.push(PressCommand::Clip(ClipCommand::StartClip(IdExpr::Single(
                    identifiers.id,
                ))));
                commands
            }
        }
        ObjectType::Group => vec![PressCommand::Programmer(
            ProgrammerCommand::SetProgrammerSelection(SelectionExpr::Group(GroupRefExpr::ByUid {
                uid: target.uid,
            })),
        )],
        ObjectType::Blueprint => {
            if state.is_on() {
                release_blueprint(objects, &context, target.uid)
                    .into_iter()
                    .collect()
            } else {
                let mut commands: Vec<PressCommand> = engaged_siblings()
                    .iter()
                    .filter_map(|sibling| release_blueprint(objects, &context, sibling.uid))
                    .collect();
                commands.push(apply_blueprint(identifiers.id));
                commands
            }
        }
        ObjectType::Master => {
            let mut commands: Vec<PressCommand> = if state.is_on() {
                Vec::new()
            } else {
                engaged_siblings()
                    .iter()
                    .filter_map(|sibling| objects.master(sibling.uid))
                    .filter(|master| matches!(master.mode, MasterMode::Toggle { active: true }))
                    .map(|master| {
                        PressCommand::Master(MasterCommand::ToggleMaster {
                            id: master.identifiers.id,
                        })
                    })
                    .collect()
            };
            commands.push(PressCommand::Master(MasterCommand::ToggleMaster {
                id: identifiers.id,
            }));
            commands
        }
        other => {
            return Err(InvocationError::new(
                "board.unsupported_target",
                format!("Board buttons cannot press {other} objects yet"),
            ));
        }
    };
    Ok(commands)
}

/// Builds the command applying a blueprint by reference to the active selection.
fn apply_blueprint(blueprint_id: u32) -> PressCommand {
    PressCommand::Programmer(ProgrammerCommand::ApplyAttributeOperations {
        selection: None,
        operations: vec![ProgrammerAttributeOperation {
            target: BlueprintSelector::All,
            source: ProgrammerAttributeSource::Blueprint {
                address: BlueprintAddress::Id(blueprint_id),
                resolution: BlueprintResolution::Reference,
            },
        }],
        transitions: Default::default(),
        transitions_by_attribute: Default::default(),
    })
}

/// Builds the command releasing a blueprint's attributes from the fixtures that carry it.
///
/// Only fixtures in the current selection are released when there is one, so a color picked
/// for another group stays in place. Returns `None` when nothing would be released.
fn release_blueprint(
    objects: &BoardObjects,
    context: &BoardStateContext,
    blueprint_uid: Uuid,
) -> Option<PressCommand> {
    let blueprint = objects.blueprint(blueprint_uid)?;
    let carried = context.blueprint_fixtures(blueprint_uid)?;
    let selected = context.selected_fixtures();
    let fixtures: HashSet<&FixtureRef> = if selected.is_empty() {
        carried.iter().collect()
    } else {
        carried.intersection(selected).collect()
    };
    if fixtures.is_empty() || blueprint.values.is_empty() {
        return None;
    }
    let mut fixtures: Vec<FixtureRef> = fixtures.into_iter().cloned().collect();
    fixtures.sort();
    let mut attributes: Vec<_> = blueprint.values.keys().cloned().collect();
    attributes.sort_by_key(|attribute| attribute.to_string());
    Some(PressCommand::Programmer(
        ProgrammerCommand::ReleaseProgrammerValues {
            selection: Some(SelectionExpr::Resolved(fixtures)),
            attributes,
            allow_selection_flatten: false,
            selection_flatten_approval: None,
        },
    ))
}

/// Submits one command for an action invocation inside a shared undo step.
///
/// Mirrors [`nightfall_actions::submit_command`] but reuses `undo_id`, so every command a press produces undoes
/// together.
fn submit_in_undo_step<C>(
    world: &mut World,
    invocation: &ActionInvocation,
    undo_id: UndoId,
    command: C,
) -> Result<(), InvocationError>
where
    C: IngressCommand + Clone + 'static,
{
    let command_id = CommandId::new();
    world
        .resource_mut::<CommandTracker>()
        .register_context(
            command_id,
            undo_id,
            CommandOrigin::Automation {
                surface: invocation.surface.label().to_string(),
                source: invocation.source.clone(),
            },
            ReplyTarget::ClientBroadcast,
        )
        .map_err(|error| {
            InvocationError::new(
                "action.command_registration_failed",
                format!("Unable to register command: {error}"),
            )
        })?;
    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use nightfall_clips::{Clip, MaterializedClip};
    use nightfall_cues::prelude::{BoundCueInstruction, CueInstruction};
    use nightfall_desk::prelude::{Master, MasterMode};
    use nightfall_dmx::prelude::{Attribute, ParameterValue};
    use nightfall_fixture_model::prelude::*;
    use nightfall_fixtures::prelude::{Fixture, FixtureDataProviderExt, FixtureElement};
    use nightfall_instances::InstanceId;
    use nightfall_programmer::prelude::Programmer;

    use super::*;
    use crate::model::{BoardCell, BoardElement};

    const BOARD: Uuid = Uuid::from_u128(1000);
    const ELEMENT: Uuid = Uuid::from_u128(2000);
    const RED: Uuid = Uuid::from_u128(301);
    const BLUE: Uuid = Uuid::from_u128(302);
    const CLIP_A: Uuid = Uuid::from_u128(401);
    const CLIP_B: Uuid = Uuid::from_u128(402);
    const GROUP: Uuid = Uuid::from_u128(501);
    const MASTER: Uuid = Uuid::from_u128(601);

    /// Builds identifiers with a deterministic id, UID and label.
    fn identifiers(id: u32, uid: Uuid, label: &str) -> Identifiers {
        Identifiers {
            id,
            uid,
            label: label.to_owned(),
        }
    }

    /// Builds a color blueprint setting the red channel.
    fn blueprint(id: u32, uid: Uuid, label: &str) -> Blueprint {
        Blueprint {
            identifiers: identifiers(id, uid, label),
            values: HashMap::from([(
                Attribute::Red,
                ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
            )]),
            ..Default::default()
        }
    }

    /// Builds a world holding one fixture, two blueprints, two clips, a group and a master.
    fn world() -> World {
        let mut world = World::new();
        world.init_resource::<Programmer>();
        world.init_resource::<DataProvider<Group>>();
        world.init_resource::<DataProvider<Blueprint>>();
        world.init_resource::<DataProvider<Master>>();
        world.init_resource::<FixtureDataProviderExt>();
        world
            .resource_mut::<FixtureDataProviderExt>()
            .inner
            .add(Fixture {
                identifiers: identifiers(13, Uuid::from_u128(13), "Fixture 13"),
                elements: vec![FixtureElement {
                    parameters: vec![ParameterMetadata {
                        attribute: Attribute::Red,
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            })
            .expect("fixture should be insertable");
        let mut blueprints = world.resource_mut::<DataProvider<Blueprint>>();
        blueprints
            .add(blueprint(1, RED, "Red"))
            .expect("red should insert");
        blueprints
            .add(blueprint(2, BLUE, "Blue"))
            .expect("blue should insert");
        world
            .resource_mut::<DataProvider<Group>>()
            .add(Group {
                identifiers: identifiers(7, GROUP, "Front"),
                selection: SpatialSelection::identity(fixture_13()),
                description: String::new(),
            })
            .expect("group should insert");
        world
            .resource_mut::<DataProvider<Master>>()
            .add(Master {
                identifiers: identifiers(3, MASTER, "Blackout"),
                mode: MasterMode::Toggle { active: false },
                ..Default::default()
            })
            .expect("master should insert");
        for (id, uid, label) in [(11, CLIP_A, "Strobe"), (12, CLIP_B, "Chase")] {
            world.spawn(Clip {
                identifiers: identifiers(id, uid, label),
                ..Default::default()
            });
        }
        world
    }

    /// Selection expression for the only fixture in the test world.
    fn fixture_13() -> SelectionExpr {
        SelectionExpr::Fixture(UnresolvedFixtureRef {
            fixture_id: 13,
            element_index: None,
        })
    }

    /// Records Programmer values on fixture 13 that reference `blueprint_uid`.
    fn apply(world: &mut World, blueprint_uid: Uuid) {
        world
            .resource_mut::<Programmer>()
            .add_instruction(BoundCueInstruction {
                selection: SpatialSelection::identity(fixture_13()),
                cue_instruction: CueInstruction {
                    blueprint_application: Some(BlueprintApplication {
                        blueprint_uid,
                        selector: BlueprintSelector::All,
                    }),
                    ..Default::default()
                },
            });
    }

    /// Marks the clip with `clip_id` as running.
    fn run_clip(world: &mut World, clip_id: u32) {
        world.spawn(MaterializedClip {
            clip_id,
            attached_instance: InstanceId(Uuid::new_v4()),
            auto_release_on_stop: false,
        });
    }

    /// Builds a board holding one element of `kind`.
    fn board(kind: BoardElementKind) -> Board {
        Board {
            identifiers: identifiers(1, BOARD, "Busk"),
            elements: vec![BoardElement {
                uid: ELEMENT,
                cell: BoardCell {
                    x: 0,
                    y: 0,
                    width: 4,
                    height: 1,
                },
                label: None,
                color: None,
                show_title: true,
                kind,
            }],
            ..Default::default()
        }
    }

    /// Builds an exclusive collection of every object of `object_type`.
    fn exclusive_collection(object_type: ObjectType) -> BoardElementKind {
        BoardElementKind::Collection {
            query: ObjectQuery {
                object_type,
                id_range: None,
                label_contains: None,
            },
            exclusive: true,
        }
    }

    /// Plans a press of `target` on `board` against the world's live state.
    fn press(
        world: &mut World,
        board: &Board,
        object_type: ObjectType,
        uid: Uuid,
    ) -> Vec<PressCommand> {
        let mut state: SystemState<BoardObjects> = SystemState::new(world);
        let objects = state.get(world).expect("board objects should be available");
        plan_press(
            board,
            &objects,
            &BoardPressArguments {
                board: BOARD,
                element: ELEMENT,
                target: ObjectIdentity { object_type, uid },
            },
        )
        .expect("press should plan")
    }

    /// Returns the blueprint ID a planned command applies, if it is an apply.
    fn applied_blueprint(command: &PressCommand) -> Option<u32> {
        let PressCommand::Programmer(ProgrammerCommand::ApplyAttributeOperations {
            operations,
            ..
        }) = command
        else {
            return None;
        };
        match operations.first()?.source {
            ProgrammerAttributeSource::Blueprint {
                address: BlueprintAddress::Id(id),
                ..
            } => Some(id),
            _ => None,
        }
    }

    /// Pressing an unlit blueprint in an exclusive collection releases the lit one, then applies.
    #[test]
    fn exclusive_blueprint_press_releases_sibling_then_applies() {
        let mut world = world();
        apply(&mut world, RED);
        let commands = press(
            &mut world,
            &board(exclusive_collection(ObjectType::Blueprint)),
            ObjectType::Blueprint,
            BLUE,
        );
        assert_eq!(commands.len(), 2);
        assert!(matches!(
            &commands[0],
            PressCommand::Programmer(ProgrammerCommand::ReleaseProgrammerValues { attributes, .. })
                if attributes == &vec![Attribute::Red]
        ));
        assert_eq!(applied_blueprint(&commands[1]), Some(2));
    }

    /// Pressing the lit blueprint only releases it.
    #[test]
    fn lit_blueprint_press_releases_it() {
        let mut world = world();
        apply(&mut world, RED);
        let commands = press(
            &mut world,
            &board(exclusive_collection(ObjectType::Blueprint)),
            ObjectType::Blueprint,
            RED,
        );
        assert_eq!(commands.len(), 1);
        assert!(matches!(
            &commands[0],
            PressCommand::Programmer(ProgrammerCommand::ReleaseProgrammerValues { .. })
        ));
    }

    /// A non-exclusive blueprint press applies without touching other blueprints.
    #[test]
    fn plain_blueprint_press_only_applies() {
        let mut world = world();
        apply(&mut world, RED);
        let kind = BoardElementKind::Target {
            target: ObjectIdentity {
                object_type: ObjectType::Blueprint,
                uid: BLUE,
            },
        };
        let commands = press(&mut world, &board(kind), ObjectType::Blueprint, BLUE);
        assert_eq!(commands.len(), 1);
        assert_eq!(applied_blueprint(&commands[0]), Some(2));
    }

    /// Starting a clip in an exclusive collection stops the running sibling first.
    #[test]
    fn exclusive_clip_press_stops_sibling_then_starts() {
        let mut world = world();
        run_clip(&mut world, 11);
        let commands = press(
            &mut world,
            &board(exclusive_collection(ObjectType::Clip)),
            ObjectType::Clip,
            CLIP_B,
        );
        assert_eq!(commands.len(), 2);
        assert!(matches!(
            commands[0],
            PressCommand::Clip(ClipCommand::StopClip(IdExpr::Single(11)))
        ));
        assert!(matches!(
            commands[1],
            PressCommand::Clip(ClipCommand::StartClip(IdExpr::Single(12)))
        ));
    }

    /// Pressing a running clip stops it.
    #[test]
    fn running_clip_press_stops_it() {
        let mut world = world();
        run_clip(&mut world, 12);
        let commands = press(
            &mut world,
            &board(exclusive_collection(ObjectType::Clip)),
            ObjectType::Clip,
            CLIP_B,
        );
        assert_eq!(commands.len(), 1);
        assert!(matches!(
            commands[0],
            PressCommand::Clip(ClipCommand::StopClip(IdExpr::Single(12)))
        ));
    }

    /// Group presses select the group by UID and master presses toggle the master.
    #[test]
    fn group_selects_and_master_toggles() {
        let mut world = world();
        let group = press(
            &mut world,
            &board(exclusive_collection(ObjectType::Group)),
            ObjectType::Group,
            GROUP,
        );
        assert!(matches!(
            &group[..],
            [PressCommand::Programmer(ProgrammerCommand::SetProgrammerSelection(
                SelectionExpr::Group(GroupRefExpr::ByUid { uid })
            ))] if *uid == GROUP
        ));
        let master = press(
            &mut world,
            &board(exclusive_collection(ObjectType::Master)),
            ObjectType::Master,
            MASTER,
        );
        assert!(matches!(
            &master[..],
            [PressCommand::Master(MasterCommand::ToggleMaster { id: 3 })]
        ));
    }

    /// Turning on a master in a solo collection turns off the active toggle sibling first.
    #[test]
    fn exclusive_master_press_turns_off_sibling() {
        let mut world = world();
        world
            .resource_mut::<DataProvider<Master>>()
            .add(Master {
                identifiers: identifiers(4, Uuid::from_u128(602), "Haze"),
                mode: MasterMode::Toggle { active: true },
                ..Default::default()
            })
            .expect("master should insert");
        let commands = press(
            &mut world,
            &board(exclusive_collection(ObjectType::Master)),
            ObjectType::Master,
            MASTER,
        );
        assert!(matches!(
            &commands[..],
            [
                PressCommand::Master(MasterCommand::ToggleMaster { id: 4 }),
                PressCommand::Master(MasterCommand::ToggleMaster { id: 3 })
            ]
        ));
    }

    /// Pressing an object the element does not show is rejected.
    #[test]
    fn rejects_targets_not_on_the_element() {
        let mut world = world();
        let board = board(BoardElementKind::Target {
            target: ObjectIdentity {
                object_type: ObjectType::Blueprint,
                uid: RED,
            },
        });
        let mut state: SystemState<BoardObjects> = SystemState::new(&mut world);
        let objects = state
            .get(&world)
            .expect("board objects should be available");
        let error = plan_press(
            &board,
            &objects,
            &BoardPressArguments {
                board: BOARD,
                element: ELEMENT,
                target: ObjectIdentity {
                    object_type: ObjectType::Blueprint,
                    uid: BLUE,
                },
            },
        )
        .expect_err("press should be rejected");
        assert_eq!(error.code, "board.target_not_on_element");
    }
}
