// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! AST converter for the `save`, `load`, and `new show` words.

use nightfall_cmd_parse::ast;
use nightfall_engine::prelude::*;

use crate::command::{ShowfileCommand, ShowfileRevisionSelection};

/// Marker type that registers showfile command AST conversion.
pub struct ShowfileAstConverter;

impl AstConvert for ShowfileAstConverter {
    /// Converts `save`, `load`, and `new show` statements; declines everything else.
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        let ast::CommandAst::General(general) = ast else {
            return Err(DispatchError::NotApplicable);
        };
        let command = match general {
            ast::GeneralCommandAst::Save(save_ast) => match save_ast.name.as_ref() {
                Some(name) => ShowfileCommand::SaveNamedShowfile(name.0.to_string()),
                None => ShowfileCommand::SaveShowfile,
            },
            ast::GeneralCommandAst::Load(load_ast) => match load_ast.name.as_ref() {
                Some(name) => load_command_for_target(name.0)?,
                None => ShowfileCommand::LoadShowfile,
            },
            ast::GeneralCommandAst::NewShowfile(_) => ShowfileCommand::NewShowfile,
            _ => return Err(DispatchError::NotApplicable),
        };
        Ok(vec![Box::new(command)])
    }
}

/// Builds the showfile command for a parsed load target, including explicit source prefixes.
fn load_command_for_target(target: &str) -> Result<ShowfileCommand, DispatchError> {
    if let Some(showfile_name) = target
        .strip_prefix("draft/")
        .or_else(|| target.strip_prefix("drafts/"))
    {
        return Ok(ShowfileCommand::LoadDraftShowfile(
            showfile_name.to_string(),
        ));
    }
    if let Some(revision_name) = target
        .strip_prefix("backup/")
        .or_else(|| target.strip_prefix("backups/"))
    {
        return ShowfileRevisionSelection::from_revision_name(revision_name)
            .map(ShowfileCommand::LoadShowfileRevision)
            .map_err(DispatchError::ConversionFailed);
    }
    Ok(ShowfileCommand::LoadNamedShowfile(target.to_string()))
}

#[cfg(test)]
mod tests;
