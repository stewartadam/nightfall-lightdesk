// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;

use nightfall::prelude::{Identifiers, SpatialSelection};
use nightfall_cmd_parse::{ast, conv, parse_spatial_selection_text};
use nightfall_engine::prelude::*;
use uuid::Uuid;

use crate::{FxModuleCommand, FxModuleControlAction, StoredFxModuleRequest};

/// AST converter for fx module commands.
pub struct FxModuleAstConverter;

impl AstConvert for FxModuleAstConverter {
    /// Convert FX module storage and control AST nodes into engine payloads.
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        match ast {
            ast::CommandAst::General(ast::GeneralCommandAst::StoreFxModule(store_ast)) => {
                let ids = conv::simple_identifier_ast_to_ids(&store_ast.id)
                    .map_err(|_| DispatchError::ConversionFailed("invalid fx ID".to_string()))?;

                let mut selection: Option<SpatialSelection> = None;
                let mut config = HashMap::new();
                let mut merge = false;

                for part in &store_ast.parts {
                    match part {
                        ast::FxModuleStorePartAst::Selection(selection_ast) => {
                            selection = Some(
                                parse_spatial_selection_text(selection_ast.selection.source)
                                    .map_err(|error| {
                                        DispatchError::ConversionFailed(format!(
                                            "selection conversion failed: {}",
                                            error
                                        ))
                                    })?,
                            );
                        }
                        ast::FxModuleStorePartAst::ConfigClause(config_clause) => {
                            for entry in &config_clause.entries {
                                let (key, value) = split_config_entry(entry.0)?;
                                config.insert(key.to_string(), value.to_string());
                            }
                        }
                        ast::FxModuleStorePartAst::ConfigEntry(entry) => {
                            let (key, value) = split_config_entry(entry.0)?;
                            config.insert(key.to_string(), value.to_string());
                        }
                        ast::FxModuleStorePartAst::Merge(_) => {
                            merge = true;
                        }
                    }
                }

                Ok(ids
                    .into_iter()
                    .map(|id| {
                        Box::new(FxModuleCommand::StoreFxModule(StoredFxModuleRequest {
                            identifiers: Identifiers {
                                id,
                                uid: Uuid::new_v4(),
                                label: store_ast.module_name.0.to_string(),
                            },
                            module_name: store_ast.module_name.0.to_string(),
                            selection: selection.clone(),
                            config: config.clone(),
                            merge,
                        })) as DynEnginePayload
                    })
                    .collect())
            }
            ast::CommandAst::FxModule(fx_module_ast) => {
                let id = conv::simple_identifier_ast_to_single_id(&fx_module_ast.fx_id)
                    .ok_or_else(|| DispatchError::ConversionFailed("invalid fx ID".to_string()))?;

                let command = match &fx_module_ast.action {
                    ast::FxModuleActionAst::Start => {
                        FxModuleCommand::ControlFxModule(FxModuleControlAction::Start(id))
                    }
                    ast::FxModuleActionAst::Stop => {
                        FxModuleCommand::ControlFxModule(FxModuleControlAction::Stop(id))
                    }
                };

                Ok(vec![Box::new(command)])
            }
            _ => Err(DispatchError::NotApplicable),
        }
    }
}

fn split_config_entry(entry: &str) -> Result<(&str, &str), DispatchError> {
    entry.split_once('=').ok_or_else(|| {
        DispatchError::ConversionFailed(format!("invalid fx module config entry: {entry}"))
    })
}
