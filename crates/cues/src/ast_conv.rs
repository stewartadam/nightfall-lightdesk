// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! AST converter for cue commands
use nightfall::prelude::{ColorInterpolationSpace, ColorPath, ColorPathId, IdExpr};
use nightfall_cmd_parse::ast;
use nightfall_cmd_parse::conv;
use nightfall_desk::prelude::BlueprintCommand;
use nightfall_engine::prelude::*;

use crate::prelude::CueCommand;

/// Converts cue-related AST commands to engine commands
pub struct CueAstConverter;

/// Expands a parsed color path ID expression into concrete numeric IDs.
fn color_path_id_expression_to_ids(
    id_ast: &ast::SimpleIdentifierExpressionAst,
) -> Result<Vec<u32>, DispatchError> {
    let expr = conv::simple_identifier_ast_to_idexpr(id_ast)
        .map_err(|_| DispatchError::ConversionFailed("invalid color path ID".to_string()))?;
    let ids = expr.expand();
    if ids.is_empty() {
        return Err(DispatchError::ConversionFailed(
            "invalid color path ID".to_string(),
        ));
    }
    Ok(ids)
}

/// Extracts one color path ID from an expression that must resolve to exactly one ID.
fn color_path_id_expression_to_single_id(
    id_ast: &ast::SimpleIdentifierExpressionAst,
) -> Result<u32, DispatchError> {
    match conv::simple_identifier_ast_to_idexpr(id_ast)
        .map_err(|_| DispatchError::ConversionFailed("invalid color path ID".to_string()))?
    {
        IdExpr::Single(id) => Ok(id),
        _ => Err(DispatchError::ConversionFailed(
            "invalid color path ID".to_string(),
        )),
    }
}

impl AstConvert for CueAstConverter {
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        match ast {
            ast::CommandAst::General(gen_ast) => match gen_ast {
                // Cue-specific delete command using seq.cue format
                ast::GeneralCommandAst::DeleteCue(delete_cue_ast) => {
                    Ok(vec![Box::new(CueCommand::DeleteCue {
                        sequence_id: delete_cue_ast.cue_ref.sequence_id,
                        cue_id: delete_cue_ast.cue_ref.cue_id,
                    })])
                }
                // Cue-specific rename command using seq.cue format
                ast::GeneralCommandAst::RenameCue(rename_cue_ast) => {
                    Ok(vec![Box::new(CueCommand::RenameCue {
                        sequence_id: rename_cue_ast.from.sequence_id,
                        cue_id: rename_cue_ast.from.cue_id,
                        new_sequence_id: rename_cue_ast.to.sequence_id,
                        new_cue_id: rename_cue_ast.to.cue_id,
                    })])
                }
                ast::GeneralCommandAst::BlockCue(block_cue_ast) => {
                    let command = match block_cue_ast.operation {
                        ast::BlockCueOperationAst::Block => CueCommand::BlockCue {
                            sequence_id: block_cue_ast.cue_ref.sequence_id,
                            cue_id: block_cue_ast.cue_ref.cue_id,
                            part_id: block_cue_ast.part_id,
                            overwrite: block_cue_ast.overwrite,
                        },
                        ast::BlockCueOperationAst::Unblock => CueCommand::UnblockCue {
                            sequence_id: block_cue_ast.cue_ref.sequence_id,
                            cue_id: block_cue_ast.cue_ref.cue_id,
                            part_id: block_cue_ast.part_id,
                        },
                    };
                    Ok(vec![Box::new(command)])
                }
                ast::GeneralCommandAst::SetCueColorPath(color_path_ast) => {
                    Ok(vec![Box::new(CueCommand::SetCueColorPath {
                        sequence_id: color_path_ast.cue_ref.sequence_id,
                        cue_id: color_path_ast.cue_ref.cue_id,
                        color_path_id: color_path_ast.color_path_id.map(ColorPathId),
                    })])
                }
                ast::GeneralCommandAst::StoreColorPath(color_path_ast) => {
                    let ids = color_path_id_expression_to_ids(&color_path_ast.id)?;
                    Ok(ids
                        .into_iter()
                        .map(|id| {
                            let label = color_path_ast
                                .label
                                .as_ref()
                                .map(|label| label.0.trim_matches('"').to_string())
                                .unwrap_or_else(|| format!("Color Path {}", id));
                            let color_path =
                                ColorPath::new(id, label, ColorInterpolationSpace::Hsv);
                            Box::new(CueCommand::StoreColorPath(color_path)) as DynEnginePayload
                        })
                        .collect())
                }
                ast::GeneralCommandAst::LabelColorPath(color_path_ast) => {
                    let id = color_path_id_expression_to_single_id(&color_path_ast.id)?;
                    Ok(vec![Box::new(CueCommand::LabelColorPath {
                        id,
                        label: color_path_ast.label.0.trim_matches('"').to_string(),
                    })])
                }
                ast::GeneralCommandAst::DuplicateColorPath(color_path_ast) => {
                    let id = color_path_id_expression_to_single_id(&color_path_ast.id)?;
                    let new_id = color_path_id_expression_to_single_id(&color_path_ast.new_id)?;
                    Ok(vec![Box::new(CueCommand::DuplicateColorPath {
                        id,
                        new_id,
                    })])
                }
                ast::GeneralCommandAst::ListColorPaths(_) => {
                    Ok(vec![Box::new(CueCommand::ListColorPaths)])
                }
                // Generic delete command for sequences and blueprints
                ast::GeneralCommandAst::Delete(delete_ast) => match delete_ast.object_type {
                    ast::ObjectTypeAst::Sequence => {
                        let id = conv::simple_identifier_ast_to_single_id(&delete_ast.id)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid sequence ID".to_string())
                            })?;
                        Ok(vec![Box::new(CueCommand::DeleteSequence(id))])
                    }
                    ast::ObjectTypeAst::Blueprint => {
                        let id = conv::simple_identifier_ast_to_single_id(&delete_ast.id)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid blueprint ID".to_string())
                            })?;
                        Ok(vec![Box::new(BlueprintCommand::DeleteBlueprint(id))])
                    }
                    ast::ObjectTypeAst::ColorPath => {
                        Ok(color_path_id_expression_to_ids(&delete_ast.id)?
                            .into_iter()
                            .map(|id| Box::new(CueCommand::DeleteColorPath(id)) as DynEnginePayload)
                            .collect())
                    }
                    _ => Err(DispatchError::NotApplicable),
                },
                // Generic rename command for sequences and blueprints
                ast::GeneralCommandAst::Rename(rename_ast) => match rename_ast.object_type {
                    ast::ObjectTypeAst::Sequence => {
                        let id = conv::simple_identifier_ast_to_single_id(&rename_ast.from)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid sequence ID".to_string())
                            })?;
                        let new_id = conv::simple_identifier_ast_to_single_id(&rename_ast.to)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid sequence ID".to_string())
                            })?;
                        Ok(vec![Box::new(CueCommand::RenameSequence { id, new_id })])
                    }
                    ast::ObjectTypeAst::Blueprint => {
                        let id = conv::simple_identifier_ast_to_single_id(&rename_ast.from)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid blueprint ID".to_string())
                            })?;
                        let new_id = conv::simple_identifier_ast_to_single_id(&rename_ast.to)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid blueprint ID".to_string())
                            })?;
                        Ok(vec![Box::new(BlueprintCommand::RenameBlueprint {
                            id,
                            new_id,
                        })])
                    }
                    ast::ObjectTypeAst::ColorPath => {
                        let id = color_path_id_expression_to_single_id(&rename_ast.from)?;
                        let new_id = color_path_id_expression_to_single_id(&rename_ast.to)?;
                        Ok(vec![Box::new(CueCommand::RenameColorPath { id, new_id })])
                    }
                    _ => Err(DispatchError::NotApplicable),
                },
                _ => Err(DispatchError::NotApplicable),
            },
            _ => Err(DispatchError::NotApplicable),
        }
    }
}
