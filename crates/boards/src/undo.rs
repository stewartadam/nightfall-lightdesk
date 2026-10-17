// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo inverses for board commands.

use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;

use crate::{command::BoardCommand, model::Board};

impl Undoable for BoardCommand {
    /// Captures the command that restores the board state this command is about to change.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn Undoable>> {
        let boards = ctx.world.resource::<DataProvider<Board>>();
        let inverse = match self {
            BoardCommand::StoreBoard(board) => match boards.get(board.identifiers.uid) {
                Ok(existing) => BoardCommand::StoreBoard(existing.clone()),
                Err(_) => BoardCommand::DeleteBoard(board.identifiers.id),
            },
            BoardCommand::DeleteBoard(id) => {
                BoardCommand::StoreBoard(boards.from_id(*id).ok()?.clone())
            }
            BoardCommand::RenameBoard { id, new_id } => BoardCommand::RenameBoard {
                id: *new_id,
                new_id: *id,
            },
            BoardCommand::SetBoardLabel { board_id, .. } => BoardCommand::SetBoardLabel {
                board_id: *board_id,
                label: boards.from_id(*board_id).ok()?.identifiers.label.clone(),
            },
            BoardCommand::SetBoardShownInSwitcher { board_id, .. } => {
                BoardCommand::SetBoardShownInSwitcher {
                    board_id: *board_id,
                    shown: boards.from_id(*board_id).ok()?.shown_in_switcher,
                }
            }
            // Element edits restore the whole board, which keeps undo a single-board change.
            BoardCommand::StoreBoardElement { board_id, .. }
            | BoardCommand::DeleteBoardElement { board_id, .. } => {
                BoardCommand::StoreBoard(boards.from_id(*board_id).ok()?.clone())
            }
        };
        Some(Box::new(inverse))
    }

    /// Describes the edit for the undo history.
    fn description(&self) -> String {
        match self {
            BoardCommand::StoreBoard(board) => format!("Store Board {}", board.identifiers.id),
            BoardCommand::RenameBoard { id, new_id } => format!("Rename Board {id} to {new_id}"),
            BoardCommand::DeleteBoard(id) => format!("Delete Board {id}"),
            BoardCommand::SetBoardLabel { board_id, .. } => format!("Label Board {board_id}"),
            BoardCommand::SetBoardShownInSwitcher { board_id, shown } => {
                if *shown {
                    format!("Show Board {board_id} in switcher")
                } else {
                    format!("Hide Board {board_id} from switcher")
                }
            }
            BoardCommand::StoreBoardElement { board_id, .. } => {
                format!("Edit Board {board_id} element")
            }
            BoardCommand::DeleteBoardElement { board_id, .. } => {
                format!("Remove Board {board_id} element")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::prelude::*;
    use nightfall::prelude::*;
    use uuid::Uuid;

    use super::*;
    use crate::model::{BoardCell, BoardElement, BoardElementKind};

    /// Builds a world holding one board with one label element.
    fn world_with_board() -> (World, Board) {
        let board = Board {
            identifiers: Identifiers {
                id: 2,
                label: "Colors".to_string(),
                ..Default::default()
            },
            elements: vec![BoardElement {
                cell: BoardCell::default(),
                label: Some("Front".to_string()),
                kind: BoardElementKind::Label,
                ..Default::default()
            }],
            ..Default::default()
        };
        let mut world = World::new();
        let mut boards = DataProvider::<Board>::default();
        boards.add(board.clone()).expect("board should store");
        world.insert_resource(boards);
        (world, board)
    }

    /// Downcasts an inverse back to a board command for assertions.
    fn as_board_command(inverse: Box<dyn Undoable>) -> BoardCommand {
        *inverse
            .into_any()
            .downcast::<BoardCommand>()
            .expect("inverse should be a board command")
    }

    /// Element edits invert to restoring the board as it was before the edit.
    #[test]
    fn element_edits_restore_previous_board() {
        let (world, board) = world_with_board();
        let ctx = UndoContext { world: &world };
        let command = BoardCommand::DeleteBoardElement {
            board_id: 2,
            element_uid: board.elements[0].uid,
        };
        let inverse = as_board_command(command.inverse(&ctx).expect("inverse"));
        assert!(matches!(inverse, BoardCommand::StoreBoard(restored) if restored == board));
    }

    /// Storing a new board inverts to deleting it, and label edits restore the old label.
    #[test]
    fn creation_and_label_edits_invert() {
        let (world, _) = world_with_board();
        let ctx = UndoContext { world: &world };

        let created = Board {
            identifiers: Identifiers {
                id: 3,
                uid: Uuid::new_v4(),
                label: "New".to_string(),
            },
            ..Default::default()
        };
        let inverse = as_board_command(
            BoardCommand::StoreBoard(created)
                .inverse(&ctx)
                .expect("inverse"),
        );
        assert!(matches!(inverse, BoardCommand::DeleteBoard(3)));

        let inverse = as_board_command(
            BoardCommand::SetBoardLabel {
                board_id: 2,
                label: "Positions".to_string(),
            }
            .inverse(&ctx)
            .expect("inverse"),
        );
        assert!(matches!(
            inverse,
            BoardCommand::SetBoardLabel { board_id: 2, label } if label == "Colors"
        ));
    }

    /// Hiding a board from the switcher inverts to restoring its previous visibility.
    #[test]
    fn switcher_visibility_inverts() {
        let (world, _) = world_with_board();
        let ctx = UndoContext { world: &world };
        let inverse = as_board_command(
            BoardCommand::SetBoardShownInSwitcher {
                board_id: 2,
                shown: false,
            }
            .inverse(&ctx)
            .expect("inverse"),
        );
        assert!(matches!(
            inverse,
            BoardCommand::SetBoardShownInSwitcher {
                board_id: 2,
                shown: true
            }
        ));
    }
}
