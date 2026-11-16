// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! AST converter for the `undo` and `redo` words.

use nightfall_cmd_parse::ast;
use nightfall_engine::prelude::*;

use crate::commands::UndoCommand;

/// Marker type that registers undo command AST conversion.
pub struct UndoAstConverter;

impl AstConvert for UndoAstConverter {
    /// Converts `undo` and `redo` statements; declines everything else.
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        match ast {
            ast::CommandAst::General(ast::GeneralCommandAst::Undo(_)) => {
                Ok(vec![Box::new(UndoCommand::Undo {})])
            }
            ast::CommandAst::General(ast::GeneralCommandAst::Redo(_)) => {
                Ok(vec![Box::new(UndoCommand::Redo {})])
            }
            _ => Err(DispatchError::NotApplicable),
        }
    }
}

#[cfg(test)]
mod tests;
