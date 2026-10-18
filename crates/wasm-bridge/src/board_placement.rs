// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Board placement rules for the web UI's board editor.
//!
//! The editor previews drags, resizes, drops and pastes with the same rules the engine
//! validates board commands with, so a placement the editor offers is never rejected.

use nightfall::prelude::{Board, BoardCell, MAX_BOARD_DIMENSION};
use uuid::Uuid;
use wasm_bindgen::prelude::*;

/// Returns the furthest grid line, in cells, that a board element may reach.
#[wasm_bindgen]
pub fn board_max_dimension() -> u32 {
    MAX_BOARD_DIMENSION
}

/// Converts a JavaScript grid coordinate or span to a cell count, or `None` when it is
/// negative, fractional or too large to name a cell.
fn grid_number(value: f64) -> Option<u32> {
    (value.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&value)).then_some(value as u32)
}

/// One board's placement rules, read from the board once so drags can ask about many cells
/// without passing the board across the bridge each time.
#[wasm_bindgen]
pub struct BoardPlacement {
    /// The board as it was when the placement was built.
    board: Board,
}

#[wasm_bindgen]
impl BoardPlacement {
    /// Reads a board (`Board` as a JavaScript object) for placement checks.
    #[wasm_bindgen(constructor)]
    pub fn new(board: JsValue) -> Result<BoardPlacement, JsValue> {
        let board = serde_wasm_bindgen::from_value(board)
            .map_err(|error| JsValue::from_str(&format!("Invalid board: {error}")))?;
        Ok(Self { board })
    }

    /// Returns whether an element fits at the given cell area: inside the grid, and not sharing
    /// cells with another button, collection or label unless it is a frame. `ignore_uid` skips
    /// the element being moved or resized. Areas that cannot name grid cells never fit.
    #[wasm_bindgen(js_name = canPlace)]
    pub fn can_place(
        &self,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        is_frame: bool,
        ignore_uid: Option<String>,
    ) -> bool {
        let (Some(x), Some(y), Some(width), Some(height)) = (
            grid_number(x),
            grid_number(y),
            grid_number(width),
            grid_number(height),
        ) else {
            return false;
        };
        let ignore = ignore_uid.and_then(|uid| Uuid::parse_str(&uid).ok());
        let cell = BoardCell {
            x,
            y,
            width,
            height,
        };
        self.board.check_placement(&cell, is_frame, ignore).is_ok()
    }

    /// Finds the first cell area of the given size where an element fits, scanning the first
    /// `columns` columns row by row before continuing below. Returns `undefined` when nothing
    /// fits.
    #[wasm_bindgen(js_name = findFreeCell)]
    pub fn find_free_cell(
        &self,
        width: u32,
        height: u32,
        is_frame: bool,
        columns: u32,
    ) -> Result<JsValue, JsValue> {
        match self.board.find_free_cell(width, height, is_frame, columns) {
            Some(cell) => serde_wasm_bindgen::to_value(&cell)
                .map_err(|error| JsValue::from_str(&format!("Failed to encode cell: {error}"))),
            None => Ok(JsValue::UNDEFINED),
        }
    }
}
