// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! AST converter for clip words: storing, deleting, renaming and targeting clips, and running
//! them with `clip N go|on|off|back|speed|goto`.

use nightfall_cmd_parse::{ast, conv};
use nightfall_engine::prelude::*;

use crate::{Clip, ClipCommand, ClipSourceRef};

/// Marker type that registers clip command AST conversion.
pub struct ClipAstConverter;

impl AstConvert for ClipAstConverter {
    /// Converts clip statements to [`ClipCommand`]s; declines statements about other objects.
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        match ast {
            ast::CommandAst::General(general) => convert_general(general),
            ast::CommandAst::Clip(clip_ast) => convert_playback(clip_ast),
            _ => Err(DispatchError::NotApplicable),
        }
    }
}

/// Parses one clip ID, failing the conversion with `what` when it is not a single ID.
fn single_id(id: &ast::SimpleIdentifierExpressionAst, what: &str) -> Result<u32, DispatchError> {
    conv::simple_identifier_ast_to_single_id(id)
        .ok_or_else(|| DispatchError::ConversionFailed(format!("invalid {what} ID")))
}

/// Converts `store`, `delete`, `rename`, and `set ... target` statements about clips.
fn convert_general(
    general: &ast::GeneralCommandAst,
) -> Result<Vec<DynEnginePayload>, DispatchError> {
    match general {
        ast::GeneralCommandAst::StoreClip(store_ast) => {
            let ids = conv::simple_identifier_ast_to_ids(&store_ast.id)
                .map_err(|_| DispatchError::ConversionFailed("invalid clip ID".to_string()))?;
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
        ast::GeneralCommandAst::Delete(delete_ast)
            if matches!(delete_ast.object_type, ast::ObjectTypeAst::Clip) =>
        {
            let id = single_id(&delete_ast.id, "clip")?;
            Ok(vec![Box::new(ClipCommand::DeleteClip(id))])
        }
        ast::GeneralCommandAst::Rename(rename_ast)
            if matches!(rename_ast.object_type, ast::ObjectTypeAst::Clip) =>
        {
            let id = single_id(&rename_ast.from, "clip")?;
            let new_id = single_id(&rename_ast.to, "clip")?;
            Ok(vec![Box::new(ClipCommand::RenameClip { id, new_id })])
        }
        ast::GeneralCommandAst::SetObjectProperty(set_ast)
            if matches!(set_ast.object_type, ast::ObjectTypeAst::Clip)
                && matches!(set_ast.property, ast::SetObjectPropertyAst::Target) =>
        {
            let clip_id = single_id(&set_ast.id, "clip")?;
            let target_id = single_id(&set_ast.target.id, "target")?;
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
        _ => Err(DispatchError::NotApplicable),
    }
}

/// Converts a `clip N <action>` statement to the matching playback command.
fn convert_playback(
    clip_ast: &ast::ClipCommandAst,
) -> Result<Vec<DynEnginePayload>, DispatchError> {
    let id_expr = conv::simple_identifier_ast_to_idexpr(&clip_ast.clip_id)
        .map_err(|e| DispatchError::ConversionFailed(format!("invalid clip ID: {}", e)))?;
    let command = match &clip_ast.action {
        ast::PlaybackActionAst::On => ClipCommand::StartClip(id_expr),
        ast::PlaybackActionAst::Off => ClipCommand::StopClip(id_expr),
        ast::PlaybackActionAst::Go => ClipCommand::GoClip(id_expr),
        ast::PlaybackActionAst::Back => ClipCommand::BackClip(id_expr),
        ast::PlaybackActionAst::Speed(speed) => ClipCommand::SetSpeed {
            clip_id: id_expr,
            speed: *speed,
        },
        ast::PlaybackActionAst::Goto(position) => ClipCommand::GotoClip {
            clip_id: id_expr,
            position: *position,
            timing: None,
        },
    };
    Ok(vec![Box::new(command)])
}

#[cfg(test)]
mod tests;
