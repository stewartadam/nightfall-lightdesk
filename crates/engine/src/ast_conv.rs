// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! AST converter for the engine's own words: sleep, fps, quit, and the log filter commands.

use nightfall_cmd_parse::{ast, conv};

use crate::EngineCommand;
use crate::logging::LogCommand;
use crate::prelude::*;

/// Marker type that registers engine command AST conversion.
pub struct EngineAstConverter;

impl AstConvert for EngineAstConverter {
    /// Converts `sleep`, `fps`, `quit`, and `log ...` statements; declines everything else.
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        let ast::CommandAst::General(general) = ast else {
            return Err(DispatchError::NotApplicable);
        };
        match general {
            ast::GeneralCommandAst::Quit(_) => Ok(vec![Box::new(EngineCommand::Quit)]),
            ast::GeneralCommandAst::Sleep(sleep_ast) => {
                let duration_secs = conv::duration_from_ast(&sleep_ast.duration).map_err(|e| {
                    DispatchError::ConversionFailed(format!("duration conversion: {}", e))
                })?;
                let duration = std::time::Duration::from_secs_f32(duration_secs);
                Ok(vec![Box::new(EngineCommand::Sleep(duration))])
            }
            ast::GeneralCommandAst::SetFps(setfps_ast) => {
                let fps = setfps_ast.fps.0.parse::<u32>().map_err(|_| {
                    DispatchError::ConversionFailed("invalid fps value".to_string())
                })?;
                Ok(vec![Box::new(EngineCommand::SetFps(fps))])
            }
            ast::GeneralCommandAst::Log(log_ast) => log_command(log_ast)
                .map(|command| vec![Box::new(command) as DynEnginePayload])
                .ok_or(DispatchError::NotApplicable),
            _ => Err(DispatchError::NotApplicable),
        }
    }
}

/// Builds the log command for a parsed `log ...` statement.
///
/// Returns `None` for `log fixture ...`, which the fixtures converter handles because it
/// traces a patched fixture.
fn log_command(log_ast: &ast::LogCommandsAst) -> Option<LogCommand> {
    match &log_ast.command {
        ast::LogCommandAst::Level(level_ast) => {
            Some(LogCommand::SetLogLevel(level_ast.level.0.to_string()))
        }
        ast::LogCommandAst::Filter(filter_ast) => Some(match &filter_ast.filter {
            ast::LogFilterCommandAst::Set(set_filter_ast) => LogCommand::SetTracingFilter {
                field: set_filter_ast.field.name.0.to_string(),
                value: set_filter_ast.value.as_ref().map(|v| v.value.0.to_string()),
            },
            ast::LogFilterCommandAst::Clear(_) => LogCommand::ClearTracingFilter,
        }),
        ast::LogCommandAst::Fixture(_) => None,
    }
}

#[cfg(test)]
mod tests;
