// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Converts `park` and `unpark` command-line input into park commands.

use nightfall::prelude::SpatialSelection;
use nightfall_cmd_parse::{ast, conv};
use nightfall_engine::prelude::*;

use crate::command::ParkCommand;

/// Converts park AST commands to engine commands.
pub struct ParkAstConverter;

impl AstConvert for ParkAstConverter {
    /// Converts a `park` or `unpark` command to its park command, with no selection when the
    /// command names no fixtures and no attributes when it names none.
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        let ast::CommandAst::Park(park_ast) = ast else {
            return Err(DispatchError::NotApplicable);
        };
        let selection = park_ast
            .selection
            .as_ref()
            .map(|selection| {
                conv::selection_from_ast(selection)
                    .map(SpatialSelection::identity)
                    .map_err(|error| {
                        DispatchError::ConversionFailed(format!("selection conversion: {error}"))
                    })
            })
            .transpose()?;
        let attributes = park_ast
            .attributes
            .as_ref()
            .map(|qualifier| {
                qualifier
                    .attributes
                    .iter()
                    .map(conv::attribute_type_from_ast)
                    .collect()
            })
            .unwrap_or_default();
        let command = match park_ast.action {
            ast::ParkActionAst::Park => ParkCommand::Park {
                selection,
                attributes,
            },
            ast::ParkActionAst::Unpark => ParkCommand::Unpark {
                selection,
                attributes,
            },
        };
        Ok(vec![Box::new(command)])
    }
}
