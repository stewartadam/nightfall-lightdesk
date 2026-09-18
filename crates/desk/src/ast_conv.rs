// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! AST converter for desk commands
use std::str::FromStr;

use nightfall_cmd_parse::ast;
use nightfall_cmd_parse::conv;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;

use crate::clips::{Clip, ClipCommand, ClipSourceRef};
use crate::desk_command::{DeskCommand, ShowfileRevisionSelection};
use crate::group_command::GroupCommand;

/// Builds the desk command for a parsed load target, including explicit source prefixes.
fn load_command_for_target(target: &str) -> Result<DeskCommand, DispatchError> {
    if let Some(showfile_name) = target
        .strip_prefix("draft/")
        .or_else(|| target.strip_prefix("drafts/"))
    {
        return Ok(DeskCommand::LoadDraftShowfile(showfile_name.to_string()));
    }
    if let Some(revision_name) = target
        .strip_prefix("backup/")
        .or_else(|| target.strip_prefix("backups/"))
    {
        return ShowfileRevisionSelection::from_revision_name(revision_name)
            .map(DeskCommand::LoadShowfileRevision)
            .map_err(DispatchError::ConversionFailed);
    }
    Ok(DeskCommand::LoadNamedShowfile(target.to_string()))
}

/// Marker type that registers desk command AST conversion.
pub struct DeskAstConverter;

impl AstConvert for DeskAstConverter {
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        match ast {
            ast::CommandAst::General(gen_ast) => match gen_ast {
                ast::GeneralCommandAst::Save(save_ast) => match save_ast.name.as_ref() {
                    Some(name) => Ok(vec![Box::new(DeskCommand::SaveNamedShowfile {
                        name: name.0.to_string(),
                        options: Default::default(),
                    })]),
                    None => Ok(vec![Box::new(
                        DeskCommand::SaveShowfile(Default::default()),
                    )]),
                },
                ast::GeneralCommandAst::Load(load_ast) => match load_ast.name.as_ref() {
                    Some(name) => Ok(vec![Box::new(load_command_for_target(name.0)?)]),
                    None => Ok(vec![Box::new(DeskCommand::LoadShowfile)]),
                },
                ast::GeneralCommandAst::NewShowfile(_) => {
                    Ok(vec![Box::new(DeskCommand::NewShowfile)])
                }
                ast::GeneralCommandAst::Quit(_) => Ok(vec![Box::new(DeskCommand::Quit)]),
                ast::GeneralCommandAst::StoreClip(store_ast) => {
                    let ids = conv::simple_identifier_ast_to_ids(&store_ast.id).map_err(|_| {
                        DispatchError::ConversionFailed("invalid clip ID".to_string())
                    })?;
                    Ok(ids
                        .into_iter()
                        .map(|id| {
                            let mut clip = Clip::default();
                            clip.identifiers.id = id;
                            clip.identifiers.label = format!("Clip {id}");
                            Box::new(ClipCommand::StoreClip(clip)) as DynEnginePayload
                        })
                        .collect())
                }
                ast::GeneralCommandAst::Delete(delete_ast) => {
                    match delete_ast.object_type {
                        ast::ObjectTypeAst::Clip => {
                            let id = conv::simple_identifier_ast_to_single_id(&delete_ast.id)
                                .ok_or_else(|| {
                                    DispatchError::ConversionFailed("invalid clip ID".to_string())
                                })?;
                            return Ok(vec![Box::new(ClipCommand::DeleteClip(id))]);
                        }
                        ast::ObjectTypeAst::Group => {
                            let id = conv::simple_identifier_ast_to_single_id(&delete_ast.id)
                                .ok_or_else(|| {
                                    DispatchError::ConversionFailed("invalid group ID".to_string())
                                })?;
                            return Ok(vec![Box::new(GroupCommand::DeleteGroup(id))]);
                        }
                        _ => {}
                    }
                    Err(DispatchError::NotApplicable)
                }
                ast::GeneralCommandAst::Rename(rename_ast) => {
                    match rename_ast.object_type {
                        ast::ObjectTypeAst::Clip => {
                            let id = conv::simple_identifier_ast_to_single_id(&rename_ast.from)
                                .ok_or_else(|| {
                                    DispatchError::ConversionFailed("invalid clip ID".to_string())
                                })?;
                            let new_id = conv::simple_identifier_ast_to_single_id(&rename_ast.to)
                                .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid clip ID".to_string())
                            })?;
                            return Ok(vec![Box::new(ClipCommand::RenameClip { id, new_id })]);
                        }
                        ast::ObjectTypeAst::Group => {
                            let id = conv::simple_identifier_ast_to_single_id(&rename_ast.from)
                                .ok_or_else(|| {
                                    DispatchError::ConversionFailed("invalid group ID".to_string())
                                })?;
                            let new_id = conv::simple_identifier_ast_to_single_id(&rename_ast.to)
                                .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid group ID".to_string())
                            })?;
                            return Ok(vec![Box::new(GroupCommand::RenameGroup { id, new_id })]);
                        }
                        _ => {}
                    }
                    Err(DispatchError::NotApplicable)
                }
                ast::GeneralCommandAst::SetObjectProperty(set_ast) => {
                    if !matches!(set_ast.object_type, ast::ObjectTypeAst::Clip)
                        || !matches!(set_ast.property, ast::SetObjectPropertyAst::Target)
                    {
                        return Err(DispatchError::NotApplicable);
                    }
                    let clip_id = conv::simple_identifier_ast_to_single_id(&set_ast.id)
                        .ok_or_else(|| {
                            DispatchError::ConversionFailed("invalid clip ID".to_string())
                        })?;
                    let target_id = conv::simple_identifier_ast_to_single_id(&set_ast.target.id)
                        .ok_or_else(|| {
                            DispatchError::ConversionFailed("invalid target ID".to_string())
                        })?;
                    let source = match set_ast.target.object_type {
                        ast::SetObjectTargetTypeAst::Sequence => ClipSourceRef::Sequence(target_id),
                        ast::SetObjectTargetTypeAst::Fx => ClipSourceRef::Fx(target_id),
                        ast::SetObjectTargetTypeAst::StepFx => ClipSourceRef::StepFx(target_id),
                        ast::SetObjectTargetTypeAst::FxModule => ClipSourceRef::FxModule(target_id),
                        ast::SetObjectTargetTypeAst::Flow => ClipSourceRef::Flow(target_id),
                    };
                    Ok(vec![Box::new(ClipCommand::AssignSourceById {
                        clip_id,
                        source,
                    })])
                }
                ast::GeneralCommandAst::Sleep(sleep_ast) => {
                    let duration_secs =
                        conv::duration_from_ast(&sleep_ast.duration).map_err(|e| {
                            DispatchError::ConversionFailed(format!("duration conversion: {}", e))
                        })?;
                    let duration = std::time::Duration::from_secs_f32(duration_secs);
                    Ok(vec![Box::new(DeskCommand::Sleep(duration))])
                }
                ast::GeneralCommandAst::SetFps(setfps_ast) => {
                    let fps_str = setfps_ast.fps.0;
                    let fps = fps_str.parse::<u32>().map_err(|_| {
                        DispatchError::ConversionFailed("invalid fps value".to_string())
                    })?;
                    Ok(vec![Box::new(EngineCommand::SetFps(fps))])
                }
                ast::GeneralCommandAst::Log(log_ast) => match &log_ast.command {
                    ast::LogCommandAst::Level(level_ast) => Ok(vec![Box::new(
                        DeskCommand::SetLogLevel(level_ast.level.0.to_string()),
                    )]),
                    ast::LogCommandAst::Filter(filter_ast) => match &filter_ast.filter {
                        ast::LogFilterCommandAst::Set(set_filter_ast) => {
                            let field = set_filter_ast.field.name.0.to_string();
                            let value =
                                set_filter_ast.value.as_ref().map(|v| v.value.0.to_string());
                            Ok(vec![Box::new(DeskCommand::SetTracingFilter {
                                field,
                                value,
                            })])
                        }
                        ast::LogFilterCommandAst::Clear(_) => {
                            Ok(vec![Box::new(DeskCommand::ClearTracingFilter)])
                        }
                    },
                    ast::LogCommandAst::Fixture(fixture_ast) => {
                        let fixture_ref = conv::singleid_to_unresolved(&fixture_ast.id);
                        let attribute = match &fixture_ast.attribute {
                            ast::AttributeTypeAst::Aliased(a) => {
                                let name = format!("{:?}", a);
                                Attribute::from_str(&name)
                                    .unwrap_or(Attribute::Custom { label: name })
                            }
                            ast::AttributeTypeAst::Quoted(q) => Attribute::from_str(q)
                                .unwrap_or_else(|_| Attribute::Custom {
                                    label: q.to_string(),
                                }),
                            ast::AttributeTypeAst::Other(o) => Attribute::from_str(o)
                                .unwrap_or_else(|_| Attribute::Custom {
                                    label: o.to_string(),
                                }),
                        };
                        Ok(vec![Box::new(DeskCommand::TraceFixture {
                            fixture_ref,
                            attribute,
                        })])
                    }
                },
                ast::GeneralCommandAst::Undo(_) => Ok(vec![Box::new(UndoCommand::Undo {})]),
                ast::GeneralCommandAst::Redo(_) => Ok(vec![Box::new(UndoCommand::Redo {})]),
                _ => Err(DispatchError::NotApplicable),
            },
            ast::CommandAst::Clip(exec_ast) => {
                let id_expr =
                    conv::simple_identifier_ast_to_idexpr(&exec_ast.clip_id).map_err(|e| {
                        DispatchError::ConversionFailed(format!("invalid clip ID: {}", e))
                    })?;
                match &exec_ast.action {
                    ast::PlaybackActionAst::On => {
                        Ok(vec![Box::new(ClipCommand::StartClip(id_expr))])
                    }
                    ast::PlaybackActionAst::Off => {
                        Ok(vec![Box::new(ClipCommand::StopClip(id_expr))])
                    }
                    ast::PlaybackActionAst::Go => Ok(vec![Box::new(ClipCommand::GoClip(id_expr))]),
                    ast::PlaybackActionAst::Back => {
                        Ok(vec![Box::new(ClipCommand::BackClip(id_expr))])
                    }
                    ast::PlaybackActionAst::Rate(rate) => {
                        Ok(vec![Box::new(ClipCommand::SetRate {
                            clip_id: id_expr,
                            rate: *rate,
                        })])
                    }
                    ast::PlaybackActionAst::Goto(position) => {
                        Ok(vec![Box::new(ClipCommand::GotoClip {
                            clip_id: id_expr,
                            position: *position,
                            timing: None,
                        })])
                    }
                }
            }
            _ => Err(DispatchError::NotApplicable),
        }
    }
}
