// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Converts `park` and `unpark` command-line input into park commands.

use nightfall::prelude::SpatialSelection;
use nightfall_cmd_parse::{ast, conv};
use nightfall_dmx::prelude::Attribute;
use nightfall_engine::prelude::*;

use crate::command::ParkCommand;

/// Converts park AST commands to engine commands.
pub struct ParkAstConverter;

impl AstConvert for ParkAstConverter {
    /// Converts a `park` or `unpark` command to its park command, with no selection when the
    /// command names no fixtures and no attributes when it names none. `@ value` is read as a
    /// percentage like a programmer value, and parks intensity when no attribute is named.
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
        let attributes: Vec<Attribute> = park_ast
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
        let value = park_ast
            .value
            .as_ref()
            .map(|value| {
                conv::parameter_value_from_ast(value).map_err(|error| {
                    DispatchError::ConversionFailed(format!("value conversion: {error}"))
                })
            })
            .transpose()?;
        let command = match park_ast.action {
            ast::ParkActionAst::Park => ParkCommand::Park {
                selection,
                // A bare `@ value` sets intensity, as it does in the programmer.
                attributes: if value.is_some() && attributes.is_empty() {
                    vec![Attribute::Intensity]
                } else {
                    attributes
                },
                value,
            },
            ast::ParkActionAst::Unpark if value.is_some() => {
                return Err(DispatchError::ConversionFailed(
                    "unpark doesn't take a value".to_string(),
                ));
            }
            ast::ParkActionAst::Unpark => ParkCommand::Unpark {
                selection,
                attributes,
            },
        };
        Ok(vec![Box::new(command)])
    }
}
