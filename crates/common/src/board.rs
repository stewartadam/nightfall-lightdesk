// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Persisted board definitions: a numbered grid of buttons, collections, frames and labels.

use serde::{Deserialize, Serialize};
use smart_default::SmartDefault;
use uuid::Uuid;

use crate::{
    command_types::{ObjectIdentity, ObjectType},
    data::{HasIdentifiers, Identifiers},
    object_query::ObjectQuery,
};

/// Furthest grid line, in cells, that an element may reach in either direction.
///
/// Boards are an open canvas of small square cells, so this only bounds runaway coordinates.
pub const MAX_BOARD_DIMENSION: u32 = 512;

/// Object types a board button can target in this version.
pub const BOARD_TARGET_TYPES: &[ObjectType] = &[
    ObjectType::Clip,
    ObjectType::Group,
    ObjectType::Blueprint,
    ObjectType::Master,
];

/// Shared showfile object holding operator-arranged controls on an open grid of small cells.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, SmartDefault)]
#[typeshare::typeshare]
pub struct Board {
    /// Stable showfile identifiers ("Board 3").
    pub identifiers: Identifiers,
    /// Elements in paint order; frames are listed before the elements they contain.
    #[serde(default)]
    pub elements: Vec<BoardElement>,
    /// Whether the board is listed in the layout switcher, where picking it fills the workspace.
    #[serde(default = "shown_in_switcher_default")]
    #[default(true)]
    pub shown_in_switcher: bool,
}

/// Returns the switcher visibility of boards stored without one: listed.
fn shown_in_switcher_default() -> bool {
    true
}

impl HasIdentifiers for Board {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

impl Board {
    /// Returns the element with `uid`, if the board contains it.
    pub fn element(&self, uid: Uuid) -> Option<&BoardElement> {
        self.elements.iter().find(|element| element.uid == uid)
    }

    /// Returns the exclusive frames whose area fully contains `cell`.
    pub fn exclusive_frames_containing(
        &self,
        cell: &BoardCell,
    ) -> impl Iterator<Item = &BoardElement> {
        self.elements.iter().filter(move |element| {
            matches!(element.kind, BoardElementKind::Frame { exclusive: true })
                && element.cell.contains(cell)
        })
    }

    /// Returns the pinned target elements sharing an exclusive frame with `element`.
    ///
    /// Siblings must target the same object type, because exclusivity only applies within
    /// one type of on/off state.
    pub fn exclusive_target_siblings(&self, element: &BoardElement) -> Vec<ObjectIdentity> {
        let BoardElementKind::Target { target } = &element.kind else {
            return Vec::new();
        };
        let frames: Vec<&BoardCell> = self
            .exclusive_frames_containing(&element.cell)
            .map(|frame| &frame.cell)
            .collect();
        if frames.is_empty() {
            return Vec::new();
        }
        self.elements
            .iter()
            .filter(|candidate| candidate.uid != element.uid)
            .filter(|candidate| frames.iter().any(|frame| frame.contains(&candidate.cell)))
            .filter_map(|candidate| match &candidate.kind {
                BoardElementKind::Target { target: sibling }
                    if sibling.object_type == target.object_type && sibling.uid != target.uid =>
                {
                    Some(*sibling)
                }
                _ => None,
            })
            .collect()
    }

    /// Checks whether an element fits at `cell`: it must span at least one cell, stay inside
    /// the grid's bounds and, unless it is a frame, share no cells with another non-frame
    /// element. Frames may overlap anything. `ignore` skips one element, so an element being
    /// moved or resized is not checked against itself.
    pub fn check_placement(
        &self,
        cell: &BoardCell,
        is_frame: bool,
        ignore: Option<Uuid>,
    ) -> Result<(), BoardPlacementError> {
        if cell.width == 0 || cell.height == 0 {
            return Err(BoardPlacementError::Empty);
        }
        if cell.right() > MAX_BOARD_DIMENSION || cell.bottom() > MAX_BOARD_DIMENSION {
            return Err(BoardPlacementError::OutOfBounds);
        }
        if !is_frame && self.blocking_cell(cell, ignore).is_some() {
            return Err(BoardPlacementError::Occupied);
        }
        Ok(())
    }

    /// Returns the area of a button, collection or label sharing cells with `cell`, skipping
    /// the element `ignore`.
    fn blocking_cell(&self, cell: &BoardCell, ignore: Option<Uuid>) -> Option<&BoardCell> {
        self.elements
            .iter()
            .filter(|other| Some(other.uid) != ignore && !other.kind.is_frame())
            .map(|other| &other.cell)
            .find(|other| other.overlaps(cell))
    }

    /// Finds the first cell of the given size where an element fits, scanning rows top to
    /// bottom within the first `columns` columns (the visible width) and continuing downwards
    /// when they are full. A size wider than `columns` is searched at the left edge. Returns
    /// `None` when nothing fits on the grid.
    pub fn find_free_cell(
        &self,
        width: u32,
        height: u32,
        is_frame: bool,
        columns: u32,
    ) -> Option<BoardCell> {
        if width == 0 || height == 0 || width > MAX_BOARD_DIMENSION {
            return None;
        }
        let search_columns = columns.max(width).min(MAX_BOARD_DIMENSION);
        for y in 0..=MAX_BOARD_DIMENSION.checked_sub(height)? {
            let mut x = 0;
            while x + width <= search_columns {
                let cell = BoardCell {
                    x,
                    y,
                    width,
                    height,
                };
                if is_frame {
                    return Some(cell);
                }
                match self.blocking_cell(&cell, None) {
                    // Every column up to the blocker's right edge would hit it again.
                    Some(blocker) => x = blocker.right(),
                    None => return Some(cell),
                }
            }
        }
        None
    }
}

/// Why an element cannot be placed where it was asked to go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoardPlacementError {
    /// The area spans no cells.
    Empty,
    /// The area reaches past the grid's bounds.
    OutOfBounds,
    /// The area shares cells with another button, collection or label.
    Occupied,
}

/// Rectangular placement of an element on the board grid, in cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, SmartDefault)]
#[typeshare::typeshare]
pub struct BoardCell {
    /// Zero-based column of the left edge.
    pub x: u32,
    /// Zero-based row of the top edge.
    pub y: u32,
    /// Width in cells (at least one).
    #[default(1)]
    pub width: u32,
    /// Height in cells (at least one).
    #[default(1)]
    pub height: u32,
}

impl BoardCell {
    /// Exclusive right edge column.
    pub fn right(&self) -> u32 {
        self.x.saturating_add(self.width)
    }

    /// Exclusive bottom edge row.
    pub fn bottom(&self) -> u32 {
        self.y.saturating_add(self.height)
    }

    /// Returns whether `other` lies entirely inside this area.
    pub fn contains(&self, other: &BoardCell) -> bool {
        other.x >= self.x
            && other.y >= self.y
            && other.right() <= self.right()
            && other.bottom() <= self.bottom()
    }

    /// Returns whether the two areas share at least one cell.
    pub fn overlaps(&self, other: &BoardCell) -> bool {
        self.x < other.right()
            && other.x < self.right()
            && self.y < other.bottom()
            && other.y < self.bottom()
    }
}

/// One placed item on a board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, SmartDefault)]
#[typeshare::typeshare]
pub struct BoardElement {
    /// Stable identity within the board.
    #[serde(with = "crate::serde_uuid_simple")]
    #[default(_code = "Uuid::new_v4()")]
    #[typeshare(serialized_as = "String")]
    pub uid: Uuid,
    /// Grid position and span.
    pub cell: BoardCell,
    /// Text override; targets fall back to the object's label, frames and labels show it as is.
    #[serde(default)]
    pub label: Option<String>,
    /// Optional `#rrggbb` color override.
    #[serde(default)]
    pub color: Option<String>,
    /// Whether a frame or collection draws its title above its area.
    #[serde(default = "show_title_default")]
    #[default(true)]
    pub show_title: bool,
    /// What the element shows and does.
    pub kind: BoardElementKind,
}

/// Returns the title visibility of elements stored without one: shown.
fn show_title_default() -> bool {
    true
}

/// The behavior of a board element.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, SmartDefault)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum BoardElementKind {
    /// One button pinned to one object, using that object type's default press action.
    Target {
        /// Object the button presses.
        target: ObjectIdentity,
    },
    /// A region filled live with one button per object matching the query, in ID order.
    Collection {
        /// Stored filter; the backend resolves it on every change.
        query: ObjectQuery,
        /// Whether only one button in the region may be on at a time.
        #[serde(default)]
        exclusive: bool,
    },
    /// A titled rectangle grouping the pinned buttons inside it.
    Frame {
        /// Whether only one same-typed pinned button inside the frame may be on at a time.
        #[serde(default)]
        exclusive: bool,
    },
    /// Static heading text.
    #[default]
    Label,
    /// The show tempo: a beat indicator and BPM readout that work as a tap tempo pad.
    Tempo,
}

impl BoardElementKind {
    /// Returns whether the element is a frame, which may overlap the elements it groups.
    pub fn is_frame(&self) -> bool {
        matches!(self, Self::Frame { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a pinned target element at a cell for exclusivity tests.
    fn target(object_type: ObjectType, x: u32, y: u32) -> BoardElement {
        BoardElement {
            cell: BoardCell {
                x,
                y,
                ..Default::default()
            },
            kind: BoardElementKind::Target {
                target: ObjectIdentity {
                    object_type,
                    uid: Uuid::new_v4(),
                },
            },
            ..Default::default()
        }
    }

    /// Builds a frame element covering the given area.
    fn frame(exclusive: bool, cell: BoardCell) -> BoardElement {
        BoardElement {
            cell,
            kind: BoardElementKind::Frame { exclusive },
            ..Default::default()
        }
    }

    /// Cells contain areas inside them and detect shared cells.
    #[test]
    fn cell_containment_and_overlap() {
        let outer = BoardCell {
            x: 0,
            y: 0,
            width: 4,
            height: 2,
        };
        let inner = BoardCell {
            x: 3,
            y: 1,
            ..Default::default()
        };
        let outside = BoardCell {
            x: 4,
            y: 0,
            ..Default::default()
        };
        assert!(outer.contains(&inner));
        assert!(!outer.contains(&outside));
        assert!(outer.overlaps(&inner));
        assert!(!outer.overlaps(&outside));
    }

    /// Exclusive siblings are the same-typed pinned targets inside a shared exclusive frame.
    #[test]
    fn exclusive_siblings_share_frame_and_type() {
        let area = BoardCell {
            x: 0,
            y: 0,
            width: 3,
            height: 1,
        };
        let red = target(ObjectType::Blueprint, 0, 0);
        let blue = target(ObjectType::Blueprint, 1, 0);
        let clip = target(ObjectType::Clip, 2, 0);
        let outside = target(ObjectType::Blueprint, 0, 1);
        let board = Board {
            elements: vec![frame(true, area), red.clone(), blue.clone(), clip, outside],
            ..Default::default()
        };

        let BoardElementKind::Target {
            target: blue_target,
        } = blue.kind
        else {
            unreachable!()
        };
        assert_eq!(board.exclusive_target_siblings(&red), vec![blue_target]);
    }

    /// Buttons may not share cells with each other, but frames overlap freely and a moved
    /// element is not checked against itself.
    #[test]
    fn placement_rejects_overlapping_buttons_only() {
        let button = target(ObjectType::Clip, 1, 0);
        let board = Board {
            elements: vec![
                frame(
                    false,
                    BoardCell {
                        x: 0,
                        y: 0,
                        width: 4,
                        height: 4,
                    },
                ),
                button.clone(),
            ],
            ..Default::default()
        };
        let occupied = button.cell;
        assert_eq!(
            board.check_placement(&occupied, false, None),
            Err(BoardPlacementError::Occupied)
        );
        assert_eq!(board.check_placement(&occupied, true, None), Ok(()));
        assert_eq!(
            board.check_placement(&occupied, false, Some(button.uid)),
            Ok(())
        );
        assert_eq!(
            board.check_placement(
                &BoardCell {
                    x: 0,
                    y: 0,
                    ..Default::default()
                },
                false,
                None
            ),
            Ok(())
        );
    }

    /// Areas must span a cell and stay inside the grid, frames included.
    #[test]
    fn placement_rejects_empty_and_out_of_bounds_areas() {
        let board = Board::default();
        let empty = BoardCell {
            width: 0,
            ..Default::default()
        };
        let past_edge = BoardCell {
            x: MAX_BOARD_DIMENSION - 1,
            width: 2,
            ..Default::default()
        };
        assert_eq!(
            board.check_placement(&empty, true, None),
            Err(BoardPlacementError::Empty)
        );
        assert_eq!(
            board.check_placement(&past_edge, true, None),
            Err(BoardPlacementError::OutOfBounds)
        );
    }

    /// The free-cell search fills the visible columns row by row, then continues below, and
    /// gives up on sizes larger than the grid.
    #[test]
    fn free_cell_search_scans_visible_columns_first() {
        let board = Board {
            elements: vec![
                target(ObjectType::Clip, 0, 0),
                target(ObjectType::Clip, 1, 0),
            ],
            ..Default::default()
        };
        assert_eq!(
            board.find_free_cell(1, 1, false, 8),
            Some(BoardCell {
                x: 2,
                y: 0,
                ..Default::default()
            })
        );
        assert_eq!(
            board.find_free_cell(2, 1, false, 1),
            Some(BoardCell {
                x: 0,
                y: 1,
                width: 2,
                height: 1,
            })
        );
        assert_eq!(
            board.find_free_cell(1, 1, true, 8),
            Some(BoardCell {
                x: 0,
                y: 0,
                ..Default::default()
            })
        );
        assert_eq!(
            board.find_free_cell(MAX_BOARD_DIMENSION + 1, 1, false, 8),
            None
        );
    }

    /// Non-exclusive frames do not make their contents exclusive.
    #[test]
    fn plain_frames_have_no_siblings() {
        let area = BoardCell {
            x: 0,
            y: 0,
            width: 2,
            height: 1,
        };
        let red = target(ObjectType::Blueprint, 0, 0);
        let board = Board {
            elements: vec![
                frame(false, area),
                red.clone(),
                target(ObjectType::Blueprint, 1, 0),
            ],
            ..Default::default()
        };
        assert!(board.exclusive_target_siblings(&red).is_empty());
    }
}
