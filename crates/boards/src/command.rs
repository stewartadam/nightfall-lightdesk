// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Board CRUD and per-element edit commands.

use std::collections::HashSet;

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_desk::object_crud::{ObjectCrud, apply_object_crud_command};
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// User commands that create boards and edit them one element at a time.
///
/// Clients never replace a whole board after creating it, so concurrent edits from several
/// devices touch only the elements each one changed.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum BoardCommand {
    /// Store or replace a board definition (used to create boards and by undo).
    StoreBoard(Board),
    /// Change a board's numeric ID.
    RenameBoard {
        /// Existing board ID.
        id: u32,
        /// New board ID.
        new_id: u32,
    },
    /// Delete a board by numeric ID.
    DeleteBoard(u32),
    /// Change a board's label.
    SetBoardLabel {
        /// Board numeric ID.
        board_id: u32,
        /// New label.
        label: String,
    },
    /// List a board in the layout switcher, or hide it from there.
    SetBoardShownInSwitcher {
        /// Board numeric ID.
        board_id: u32,
        /// Whether the switcher lists the board.
        shown: bool,
    },
    /// Add an element, or replace the element with the same UID.
    StoreBoardElement {
        /// Board numeric ID.
        board_id: u32,
        /// Element to store.
        element: BoardElement,
    },
    /// Remove one element from a board.
    DeleteBoardElement {
        /// Board numeric ID.
        board_id: u32,
        /// Element to remove.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        element_uid: Uuid,
    },
}

impl IngressCommand for BoardCommand {}

impl ObjectCrud<BoardCommand> for Board {
    fn type_name() -> &'static str {
        "board"
    }

    fn extract_store(command: &BoardCommand) -> Option<Self> {
        match command {
            BoardCommand::StoreBoard(board) => Some(board.clone()),
            _ => None,
        }
    }

    fn extract_rename(command: &BoardCommand) -> Option<(u32, u32)> {
        match command {
            BoardCommand::RenameBoard { id, new_id } => Some((*id, *new_id)),
            _ => None,
        }
    }

    fn extract_delete(command: &BoardCommand) -> Option<u32> {
        match command {
            BoardCommand::DeleteBoard(id) => Some(*id),
            _ => None,
        }
    }

    fn set_id(&mut self, new_id: u32) {
        self.identifiers.id = new_id;
    }
}

/// Applies board commands to the board store and reports one outcome per command.
pub fn handle_board_commands(
    mut events: MessageReader<CommandEnvelope<BoardCommand>>,
    mut boards: ResMut<DataProvider<Board>>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let result = apply_board_command(&event.command, &mut boards);
        let response = match result {
            Ok(()) => responder.succeed(event.command_id),
            Err(error) => responder.fail(event.command_id, error),
        };
        if let Err(error) = response {
            tracing::error!(command_id = %event.command_id, %error, "board_command_completion_failed");
        }
    }
}

/// Validates and applies one board command.
fn apply_board_command(
    command: &BoardCommand,
    boards: &mut DataProvider<Board>,
) -> Result<(), CommandError> {
    if let BoardCommand::StoreBoard(board) = command {
        validate_board(board)?;
    }
    if let Some(result) = apply_object_crud_command::<Board, _>(command, boards) {
        return result;
    }

    match command {
        BoardCommand::SetBoardLabel { board_id, label } => {
            update_board(*board_id, boards, |board| {
                board.identifiers.label = label.clone();
                Ok(())
            })
        }
        BoardCommand::SetBoardShownInSwitcher { board_id, shown } => {
            update_board(*board_id, boards, |board| {
                board.shown_in_switcher = *shown;
                Ok(())
            })
        }
        BoardCommand::StoreBoardElement { board_id, element } => {
            update_board(*board_id, boards, |board| {
                store_element(board, element.clone())
            })
        }
        BoardCommand::DeleteBoardElement {
            board_id,
            element_uid,
        } => update_board(*board_id, boards, |board| {
            let before = board.elements.len();
            board.elements.retain(|element| element.uid != *element_uid);
            if board.elements.len() == before {
                return Err(CommandError::new(
                    "board.element_not_found",
                    format!("Board {board_id} has no element {element_uid}"),
                ));
            }
            Ok(())
        }),
        BoardCommand::StoreBoard(_)
        | BoardCommand::RenameBoard { .. }
        | BoardCommand::DeleteBoard(_) => {
            unreachable!("CRUD commands returned above")
        }
    }
}

/// Inserts or replaces one element.
///
/// Frames are kept ahead of other elements so they paint underneath what they group.
fn store_element(board: &mut Board, element: BoardElement) -> Result<(), CommandError> {
    validate_element(&element)?;
    board
        .check_placement(&element.cell, element.kind.is_frame(), Some(element.uid))
        .map_err(placement_error)?;

    match board
        .elements
        .iter_mut()
        .find(|existing| existing.uid == element.uid)
    {
        Some(existing) => *existing = element,
        None => board.elements.push(element),
    }
    board
        .elements
        .sort_by_key(|element| !element.kind.is_frame());
    Ok(())
}

/// Checks a whole board: every element's contents, and its placement against the grid's
/// bounds and the other elements.
fn validate_board(board: &Board) -> Result<(), CommandError> {
    let mut uids = HashSet::with_capacity(board.elements.len());
    for element in &board.elements {
        if !uids.insert(element.uid) {
            return Err(CommandError::new(
                "board.duplicate_element",
                format!("Element {} appears more than once", element.uid),
            ));
        }
        validate_element(element)?;
        board
            .check_placement(&element.cell, element.kind.is_frame(), Some(element.uid))
            .map_err(placement_error)?;
    }
    Ok(())
}

/// Turns a placement rejection into the command error clients see.
fn placement_error(error: BoardPlacementError) -> CommandError {
    match error {
        BoardPlacementError::Empty => CommandError::new(
            "board.invalid_cell",
            "Board elements must span at least one cell",
        ),
        BoardPlacementError::OutOfBounds => CommandError::new(
            "board.element_out_of_bounds",
            "The element does not fit on the board grid",
        ),
        BoardPlacementError::Occupied => CommandError::new(
            "board.cells_occupied",
            "Those cells already hold another element",
        ),
    }
}

/// Checks one element's contents: its color override and the object type it targets.
fn validate_element(element: &BoardElement) -> Result<(), CommandError> {
    if let Some(color) = &element.color
        && !is_hex_color(color)
    {
        return Err(CommandError::new(
            "board.invalid_color",
            format!("'{color}' is not a #rrggbb color"),
        ));
    }
    let object_type = match &element.kind {
        BoardElementKind::Target { target } => Some(target.object_type),
        BoardElementKind::Collection { query, .. } => Some(query.object_type),
        BoardElementKind::Frame { .. } | BoardElementKind::Label => None,
    };
    if let Some(object_type) = object_type
        && !BOARD_TARGET_TYPES.contains(&object_type)
    {
        return Err(CommandError::new(
            "board.unsupported_target",
            format!("Boards cannot hold {object_type} buttons yet"),
        ));
    }
    Ok(())
}

/// Returns whether `value` is a `#rrggbb` color string.
fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

/// Mutates one board by numeric ID and stores it back, leaving it untouched on failure.
fn update_board(
    id: u32,
    boards: &mut DataProvider<Board>,
    update: impl FnOnce(&mut Board) -> Result<(), CommandError>,
) -> Result<(), CommandError> {
    let mut board = boards
        .from_id(id)
        .map(|board| board.clone())
        .map_err(|_| CommandError::new("board.not_found", format!("Board {id} does not exist")))?;
    update(&mut board)?;
    boards.add(board).map_err(|error| {
        CommandError::new(
            "board.update_failed",
            format!("Failed to update board {id}: {error}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};

    use super::*;

    /// Builds an app running only the board command handler.
    fn board_command_app() -> App {
        let mut app = App::new();
        app.init_resource::<DataProvider<Board>>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<BoardCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNoticeReply>();
        app.add_systems(Update, handle_board_commands);
        app
    }

    /// Registers, submits and runs one board command, returning whether it succeeded.
    fn run(app: &mut App, command: BoardCommand) -> bool {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("board command should register");
        app.world_mut().write_message(envelope);
        app.update();
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .last()
            .map(|result| matches!(result.outcome, CommandOutcome::Succeeded { .. }))
            .expect("board command should finish")
    }

    /// Builds a board with a numeric ID and an empty grid.
    fn board(id: u32) -> Board {
        Board {
            identifiers: Identifiers {
                id,
                label: format!("Board {id}"),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    /// Builds a pinned group button at a cell.
    fn group_button(x: u32, y: u32) -> BoardElement {
        BoardElement {
            cell: BoardCell {
                x,
                y,
                ..Default::default()
            },
            kind: BoardElementKind::Target {
                target: ObjectIdentity {
                    object_type: ObjectType::Group,
                    uid: Uuid::new_v4(),
                },
            },
            ..Default::default()
        }
    }

    /// Reads the stored board with `id`.
    fn stored(app: &App, id: u32) -> Board {
        app.world()
            .resource::<DataProvider<Board>>()
            .from_id(id)
            .expect("board should exist")
            .clone()
    }

    /// Elements are added, replaced by UID and removed without touching the rest of the board.
    #[test]
    fn element_commands_edit_one_element() {
        let mut app = board_command_app();
        assert!(run(&mut app, BoardCommand::StoreBoard(board(1))));

        let mut button = group_button(0, 0);
        let other = group_button(1, 0);
        for element in [button.clone(), other.clone()] {
            let result = run(
                &mut app,
                BoardCommand::StoreBoardElement {
                    board_id: 1,
                    element,
                },
            );
            assert!(result);
        }

        button.label = Some("Front".to_string());
        assert!(run(
            &mut app,
            BoardCommand::StoreBoardElement {
                board_id: 1,
                element: button.clone(),
            },
        ));
        let board = stored(&app, 1);
        assert_eq!(board.elements.len(), 2);
        assert_eq!(board.element(button.uid), Some(&button));

        assert!(run(
            &mut app,
            BoardCommand::DeleteBoardElement {
                board_id: 1,
                element_uid: button.uid,
            },
        ));
        assert_eq!(stored(&app, 1).elements, vec![other]);
    }

    /// Boards start listed in the layout switcher and can be hidden from it and shown again.
    #[test]
    fn switcher_visibility_toggles() {
        let mut app = board_command_app();
        run(&mut app, BoardCommand::StoreBoard(board(1)));
        assert!(stored(&app, 1).shown_in_switcher);
        for shown in [false, true] {
            assert!(run(
                &mut app,
                BoardCommand::SetBoardShownInSwitcher { board_id: 1, shown },
            ));
            assert_eq!(stored(&app, 1).shown_in_switcher, shown);
        }
        assert!(!run(
            &mut app,
            BoardCommand::SetBoardShownInSwitcher {
                board_id: 9,
                shown: false,
            },
        ));
    }

    /// Elements may sit anywhere on the open grid up to its far edge.
    #[test]
    fn elements_fit_anywhere_inside_the_grid_bounds() {
        let mut app = board_command_app();
        run(&mut app, BoardCommand::StoreBoard(board(1)));
        let edge = MAX_BOARD_DIMENSION - 1;
        let result = run(
            &mut app,
            BoardCommand::StoreBoardElement {
                board_id: 1,
                element: group_button(edge, edge),
            },
        );
        assert!(result);
    }

    /// Buttons may not share cells, while frames may cover buttons.
    #[test]
    fn overlapping_buttons_are_rejected_but_frames_overlap() {
        let mut app = board_command_app();
        run(&mut app, BoardCommand::StoreBoard(board(1)));
        run(
            &mut app,
            BoardCommand::StoreBoardElement {
                board_id: 1,
                element: group_button(0, 0),
            },
        );

        let clash = run(
            &mut app,
            BoardCommand::StoreBoardElement {
                board_id: 1,
                element: group_button(0, 0),
            },
        );
        assert!(!clash);

        let frame = BoardElement {
            cell: BoardCell {
                x: 0,
                y: 0,
                width: 2,
                height: 1,
            },
            kind: BoardElementKind::Frame { exclusive: true },
            ..Default::default()
        };
        let stored_frame = run(
            &mut app,
            BoardCommand::StoreBoardElement {
                board_id: 1,
                element: frame.clone(),
            },
        );
        assert!(stored_frame);
        assert_eq!(stored(&app, 1).elements[0], frame, "frames paint first");
    }

    /// Whole boards are rejected when two elements share a UID, since placement checks skip an
    /// element by its UID and would otherwise never compare the two.
    #[test]
    fn stored_boards_reject_duplicate_element_uids() {
        let mut app = board_command_app();
        let button = group_button(0, 0);
        let mut duplicate = group_button(5, 0);
        duplicate.uid = button.uid;
        let mut stored_board = board(1);
        stored_board.elements = vec![button, duplicate];
        assert!(!run(&mut app, BoardCommand::StoreBoard(stored_board)));
    }

    /// Elements past the grid's far edge and unsupported target types are rejected.
    #[test]
    fn invalid_elements_are_rejected() {
        let mut app = board_command_app();
        run(&mut app, BoardCommand::StoreBoard(board(1)));

        let mut too_wide = group_button(MAX_BOARD_DIMENSION - 1, 0);
        too_wide.cell.width = 2;
        let wide = run(
            &mut app,
            BoardCommand::StoreBoardElement {
                board_id: 1,
                element: too_wide,
            },
        );
        assert!(!wide);

        let cue = BoardElement {
            kind: BoardElementKind::Target {
                target: ObjectIdentity {
                    object_type: ObjectType::Cue,
                    uid: Uuid::new_v4(),
                },
            },
            ..Default::default()
        };
        let unsupported = run(
            &mut app,
            BoardCommand::StoreBoardElement {
                board_id: 1,
                element: cue,
            },
        );
        assert!(!unsupported);
        assert!(stored(&app, 1).elements.is_empty());
    }
}
