// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! AST converter for timecode commands
use nightfall_cmd_parse::ast;
use nightfall_cmd_parse::conv;
use nightfall_engine::prelude::*;

use crate::TimecodeCommand;

/// Converts timecode-related AST commands to engine commands
pub struct TimecodeAstConverter;

impl AstConvert for TimecodeAstConverter {
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        match ast {
            ast::CommandAst::Timecode(tc_ast) => {
                let id = conv::simple_identifier_ast_to_single_id(&tc_ast.timecode_id).ok_or_else(
                    || DispatchError::ConversionFailed("invalid timecode ID".to_string()),
                )?;
                match &tc_ast.action {
                    ast::TimecodeActionAst::Start => {
                        Ok(vec![Box::new(TimecodeCommand::StartTimecode(id))])
                    }
                    ast::TimecodeActionAst::Pause => {
                        Ok(vec![Box::new(TimecodeCommand::PauseTimecode(id))])
                    }
                    ast::TimecodeActionAst::Stop => {
                        Ok(vec![Box::new(TimecodeCommand::StopTimecode(id))])
                    }
                }
            }
            ast::CommandAst::General(gen_ast) => match gen_ast {
                ast::GeneralCommandAst::StoreTimecode(store_ast) => {
                    let ids = conv::simple_identifier_ast_to_ids(&store_ast.id).map_err(|_| {
                        DispatchError::ConversionFailed("invalid timecode ID".to_string())
                    })?;
                    Ok(ids
                        .into_iter()
                        .map(|id| {
                            let mut timecode = crate::timecode::Timecode::default();
                            timecode.identifiers.id = id;
                            timecode.identifiers.label = format!("Timecode {id}");
                            Box::new(TimecodeCommand::StoreTimecode(timecode)) as DynEnginePayload
                        })
                        .collect())
                }
                ast::GeneralCommandAst::Delete(delete_ast) => {
                    if matches!(delete_ast.object_type, ast::ObjectTypeAst::Timecode) {
                        let id = conv::simple_identifier_ast_to_single_id(&delete_ast.id)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid timecode ID".to_string())
                            })?;
                        return Ok(vec![Box::new(TimecodeCommand::DeleteTimecode(id))]);
                    }
                    Err(DispatchError::NotApplicable)
                }
                ast::GeneralCommandAst::Rename(rename_ast) => {
                    if matches!(rename_ast.object_type, ast::ObjectTypeAst::Timecode) {
                        let id = conv::simple_identifier_ast_to_single_id(&rename_ast.from)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid timecode ID".to_string())
                            })?;
                        let new_id = conv::simple_identifier_ast_to_single_id(&rename_ast.to)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid timecode ID".to_string())
                            })?;
                        return Ok(vec![Box::new(TimecodeCommand::RenameTimecode {
                            id,
                            new_id,
                        })]);
                    }
                    Err(DispatchError::NotApplicable)
                }
                _ => Err(DispatchError::NotApplicable),
            },
            _ => Err(DispatchError::NotApplicable),
        }
    }
}
