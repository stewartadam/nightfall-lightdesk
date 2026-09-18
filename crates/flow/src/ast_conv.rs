// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! AST converter for flow commands.

use nightfall_cmd_parse::ast;
use nightfall_cmd_parse::conv;
use nightfall_engine::prelude::*;

use crate::FlowCommand;
use crate::definition::FlowDefinition;

/// Converts flow-related AST commands to engine commands.
pub struct FlowAstConverter;

fn decode_payload(payload: &str, context: &str) -> Result<String, DispatchError> {
    serde_json::from_str::<String>(payload)
        .map_err(|e| DispatchError::ConversionFailed(format!("invalid {} JSON: {}", context, e)))
}

impl AstConvert for FlowAstConverter {
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        match ast {
            ast::CommandAst::General(ast::GeneralCommandAst::StoreFlow(store_ast)) => {
                let ids = conv::simple_identifier_ast_to_ids(&store_ast.id)
                    .map_err(|_| DispatchError::ConversionFailed("invalid flow ID".to_string()))?;
                if let Some(payload) = &store_ast.payload {
                    let [id] = ids.as_slice() else {
                        return Err(DispatchError::ConversionFailed(
                            "serialized flow definitions require exactly one flow ID".to_string(),
                        ));
                    };
                    let json = decode_payload(payload.0, "flow definition")?;
                    let flow: FlowDefinition = serde_json::from_str(&json).map_err(|e| {
                        DispatchError::ConversionFailed(format!(
                            "invalid flow definition JSON: {}",
                            e
                        ))
                    })?;
                    if flow.identifiers.id != *id {
                        return Err(DispatchError::ConversionFailed(format!(
                            "flow id mismatch: command id {} != payload id {}",
                            id, flow.identifiers.id
                        )));
                    }
                    return Ok(vec![Box::new(FlowCommand::StoreFlow(flow))]);
                }

                Ok(ids
                    .into_iter()
                    .map(|id| {
                        let identifiers = nightfall::prelude::Identifiers {
                            id,
                            label: format!("Flow {id}"),
                            ..nightfall::prelude::Identifiers::default()
                        };
                        Box::new(FlowCommand::StoreFlow(FlowDefinition::new(identifiers)))
                            as DynEnginePayload
                    })
                    .collect())
            }
            ast::CommandAst::Flow(flow_ast) => {
                let id = conv::simple_identifier_ast_to_single_id(&flow_ast.flow_id).ok_or_else(
                    || DispatchError::ConversionFailed("invalid flow ID".to_string()),
                )?;

                match &flow_ast.action {
                    ast::FlowActionAst::Start => Ok(vec![Box::new(FlowCommand::StartFlow(id))]),
                    ast::FlowActionAst::Stop => Ok(vec![Box::new(FlowCommand::StopFlow(id))]),
                    ast::FlowActionAst::Go => Ok(vec![Box::new(FlowCommand::GoFlow(id))]),
                    ast::FlowActionAst::Delete => Ok(vec![Box::new(FlowCommand::DeleteFlow(id))]),
                    ast::FlowActionAst::Rename(rename_ast) => {
                        let new_id = conv::simple_identifier_ast_to_single_id(&rename_ast.to)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid flow ID".to_string())
                            })?;
                        Ok(vec![Box::new(FlowCommand::RenameFlow { id, new_id })])
                    }
                }
            }
            _ => Err(DispatchError::NotApplicable),
        }
    }
}
