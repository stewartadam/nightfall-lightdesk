// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::ast;
use nightfall_cmd_parse::conv;
use nightfall_engine::prelude::*;
use nightfall_timecode::prelude::Timecode;

use crate::prelude::TimelineCommand;

/// Converts timeline-related AST commands to engine commands
pub struct TimelineAstConverter;

impl AstConvert for TimelineAstConverter {
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        match ast {
            ast::CommandAst::Timeline(tl_ast) => {
                let id = conv::simple_identifier_ast_to_single_id(&tl_ast.timeline_id).ok_or_else(
                    || DispatchError::ConversionFailed("invalid timeline ID".to_string()),
                )?;
                match &tl_ast.action {
                    ast::StartStopAst::Start => {
                        Ok(vec![Box::new(TimelineCommand::StartTimeline(id))])
                    }
                    ast::StartStopAst::Stop => {
                        Ok(vec![Box::new(TimelineCommand::StopTimeline(id))])
                    }
                }
            }
            ast::CommandAst::General(gen_ast) => match gen_ast {
                ast::GeneralCommandAst::StoreTimeline(store_ast) => {
                    let ids = conv::simple_identifier_ast_to_ids(&store_ast.id).map_err(|_| {
                        DispatchError::ConversionFailed("invalid timeline ID".to_string())
                    })?;
                    let mut commands = Vec::with_capacity(ids.len());
                    for id in ids {
                        let mut timecode = Timecode::default();
                        timecode.identifiers.id = id;
                        timecode.identifiers.label = format!("Timeline {id}");

                        let mut timeline = crate::prelude::Timeline::default();
                        timeline.identifiers.id = id;
                        timeline.identifiers.label = format!("Timeline {id}");
                        timeline.timecode_uid = timecode.identifiers.uid;

                        commands.push(Box::new(TimelineCommand::CreateTimeline {
                            timeline,
                            timecode,
                        }) as DynEnginePayload);
                    }

                    Ok(commands)
                }
                ast::GeneralCommandAst::Delete(delete_ast) => {
                    if matches!(delete_ast.object_type, ast::ObjectTypeAst::Timeline) {
                        let id = conv::simple_identifier_ast_to_single_id(&delete_ast.id)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid timeline ID".to_string())
                            })?;
                        return Ok(vec![Box::new(TimelineCommand::DeleteTimeline(id))]);
                    }
                    Err(DispatchError::NotApplicable)
                }
                ast::GeneralCommandAst::Rename(rename_ast) => {
                    if matches!(rename_ast.object_type, ast::ObjectTypeAst::Timeline) {
                        let id = conv::simple_identifier_ast_to_single_id(&rename_ast.from)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid timeline ID".to_string())
                            })?;
                        let new_id = conv::simple_identifier_ast_to_single_id(&rename_ast.to)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid timeline ID".to_string())
                            })?;
                        return Ok(vec![Box::new(TimelineCommand::RenameTimeline {
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
