// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Converts `macro <id> start|stop` command-line input into macro commands.

use nightfall_cmd_parse::{ast, conv};
use nightfall_engine::prelude::*;

use crate::command::MacroCommand;

/// Converts macro AST commands to engine commands.
pub struct MacroAstConverter;

impl AstConvert for MacroAstConverter {
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        let ast::CommandAst::Macro(macro_ast) = ast else {
            return Err(DispatchError::NotApplicable);
        };
        let id = conv::simple_identifier_ast_to_single_id(&macro_ast.macro_id)
            .ok_or_else(|| DispatchError::ConversionFailed("invalid macro ID".to_string()))?;
        let command = match macro_ast.action {
            ast::StartStopAst::Start => MacroCommand::StartMacro(id),
            ast::StartStopAst::Stop => MacroCommand::StopMacro(id),
        };
        Ok(vec![Box::new(command)])
    }
}
