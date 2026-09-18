// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! AST converter for fixture commands
use std::str::FromStr;

use nightfall::prelude::{ColorPathId, IdExpr, UnresolvedFixtureRef};
use nightfall_cmd_parse::ast;
use nightfall_cmd_parse::conv;
use nightfall_dmx::ParameterDmxValue;
use nightfall_dmx::prelude::{Attribute, ParameterValue, Percentage};
use nightfall_engine::prelude::*;
use nightfall_io::is_valid_network_dmx_target_id;

use crate::FixturePlacementUpdateEntry;
use crate::PlacementPosition;
use crate::PlacementRotation;
use crate::prelude::*;

/// Converts fixture-related AST commands to engine commands
pub struct FixtureAstConverter;

impl AstConvert for FixtureAstConverter {
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        match ast {
            ast::CommandAst::General(gen_ast) => match gen_ast {
                ast::GeneralCommandAst::Delete(delete_ast) => {
                    if matches!(delete_ast.object_type, ast::ObjectTypeAst::Fixture) {
                        let id_expr = conv::simple_identifier_ast_to_idexpr(&delete_ast.id)
                            .map_err(|e| DispatchError::ConversionFailed(e.to_string()))?;

                        let ids = id_expr.expand();
                        if ids.is_empty() {
                            return Err(DispatchError::ConversionFailed(
                                "empty fixture ID expression".to_string(),
                            ));
                        }

                        return Ok(ids
                            .into_iter()
                            .map(|id| {
                                Box::new(FixtureCommand::DeleteFixture(id)) as DynEnginePayload
                            })
                            .collect());
                    }
                    Err(DispatchError::NotApplicable)
                }
                ast::GeneralCommandAst::Rename(rename_ast) => {
                    if matches!(rename_ast.object_type, ast::ObjectTypeAst::Fixture) {
                        let id = conv::simple_identifier_ast_to_single_id(&rename_ast.from)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid fixture ID".to_string())
                            })?;
                        let new_id = conv::simple_identifier_ast_to_single_id(&rename_ast.to)
                            .ok_or_else(|| {
                                DispatchError::ConversionFailed("invalid fixture ID".to_string())
                            })?;
                        return Ok(vec![Box::new(FixtureCommand::RenameFixture { id, new_id })]);
                    }
                    Err(DispatchError::NotApplicable)
                }
                ast::GeneralCommandAst::StoreFixture(fixture_ast) => {
                    let ids = conv::identifier_expression_to_idexpr(&fixture_ast.id)
                        .map_err(|_| {
                            DispatchError::ConversionFailed("invalid fixture ID".to_string())
                        })?
                        .expand();
                    if ids.is_empty() {
                        return Err(DispatchError::ConversionFailed(
                            "invalid fixture ID".to_string(),
                        ));
                    }
                    let make = fixture_ast.make.0.trim_matches('"');
                    let model = fixture_ast.model.0.trim_matches('"');
                    let mode = fixture_ast.mode.0;

                    ids.into_iter()
                        .map(|id| {
                            crate::library::create_fixture_from_library(id, make, model, mode)
                                .map(|fixture| {
                                    Box::new(FixtureCommand::StoreFixture(fixture))
                                        as DynEnginePayload
                                })
                                .ok_or_else(|| {
                                    DispatchError::ConversionFailed(format!(
                                        "unknown fixture make/model: {} {}",
                                        make, model
                                    ))
                                })
                        })
                        .collect()
                }
                ast::GeneralCommandAst::StoreFixtureOffset(offset_ast) => {
                    if let Some(id) = conv::identifier_ast_to_single_id(&offset_ast.id) {
                        let attribute = attribute_from_ast(&offset_ast.attribute);
                        let value_str = offset_ast.value.0.trim();
                        let offset = if let Some(pct_str) = value_str.strip_suffix('%') {
                            let pct = pct_str.trim().parse::<f64>().map_err(|_| {
                                DispatchError::ConversionFailed(format!(
                                    "invalid offset percentage '{}'",
                                    offset_ast.value.0
                                ))
                            })?;
                            ParameterValue::AbsolutePercent {
                                value: Percentage::from(pct / 100.0),
                            }
                        } else {
                            let raw = value_str.parse::<ParameterDmxValue>().map_err(|_| {
                                DispatchError::ConversionFailed(format!(
                                    "invalid offset value '{}'",
                                    offset_ast.value.0
                                ))
                            })?;
                            ParameterValue::Absolute { value: raw }
                        };

                        return Ok(vec![Box::new(
                            FixtureCommand::UpdateFixtureParameterOffset {
                                id,
                                attribute,
                                offset,
                            },
                        )]);
                    }
                    Err(DispatchError::NotApplicable)
                }
                ast::GeneralCommandAst::SetFixtureColorPath(color_path_ast) => {
                    if let Some(target) = single_fixture_or_element_ref(&color_path_ast.id) {
                        return Ok(vec![Box::new(FixtureCommand::SetColorPathDefaultById {
                            id: target.fixture_id,
                            element_index: target.element_index,
                            color_path_id: color_path_ast.color_path_id.map(ColorPathId),
                        })]);
                    }
                    Err(DispatchError::ConversionFailed(
                        "invalid fixture or fixture element ID".to_string(),
                    ))
                }
                _ => Err(DispatchError::NotApplicable),
            },
            ast::CommandAst::PatchAdd(patch_ast) => {
                let source = binding_endpoint_from_ast(&patch_ast.source)?;
                let target = binding_endpoint_from_ast(&patch_ast.target)?;
                let priority = patch_ast
                    .priority
                    .as_ref()
                    .map(priority_from_ast)
                    .transpose()?
                    .unwrap_or(0);
                let clone = patch_ast.clone.is_some();

                Ok(vec![Box::new(FixtureCommand::PatchBinding {
                    source,
                    target,
                    priority,
                    clone,
                })])
            }
            ast::CommandAst::RmPatch(patch_ast) => {
                let source = patch_ast
                    .source
                    .as_ref()
                    .map(binding_endpoint_from_ast)
                    .transpose()?;
                let target = patch_ast
                    .target
                    .as_ref()
                    .map(binding_endpoint_from_ast)
                    .transpose()?;
                let priority = patch_ast
                    .priority
                    .as_ref()
                    .map(priority_from_ast)
                    .transpose()?;
                let clone = patch_ast.clone.as_ref().map(|_| true);

                Ok(vec![Box::new(FixtureCommand::RemovePatchBinding {
                    source,
                    target,
                    priority,
                    clone,
                })])
            }
            ast::CommandAst::Channel(channel_ast) => {
                let channels = conv::dmx_channel_expression_from_ast(&channel_ast.channels);
                let value_str = channel_ast.value.0;
                let value = value_str.parse::<u8>().map_err(|_| {
                    DispatchError::ConversionFailed(format!(
                        "invalid DMX value '{}', must be 0-255",
                        value_str
                    ))
                })?;
                Ok(vec![Box::new(FixtureCommand::SetDmxChannels {
                    channels,
                    value,
                })])
            }
            ast::CommandAst::FixturePlacement(placement_ast) => {
                if let Some(id) = conv::identifier_ast_to_single_id(&placement_ast.ids) {
                    let mut updates = Vec::new();

                    if let Some(position) = placement_ast.actions.position.as_ref() {
                        updates.extend(convert_position_action(id, position)?);
                    }

                    if let Some(rotation) = placement_ast.actions.rotation.as_ref() {
                        updates.extend(convert_rotation_action(id, rotation)?);
                    }

                    return Ok(vec![Box::new(FixtureCommand::UpdateFixturePlacements {
                        updates,
                    })]);
                }
                Err(DispatchError::NotApplicable)
            }
            _ => Err(DispatchError::NotApplicable),
        }
    }
}

fn binding_endpoint_from_ast(
    endpoint: &ast::PatchEndpointAst,
) -> Result<BindingEndpoint, DispatchError> {
    match endpoint {
        ast::PatchEndpointAst::Console(console) => Ok(BindingEndpoint::Console {
            universe: dmx_range_from_ast(console.range.as_ref())?,
            address: address_from_ast(console.address.as_ref())?,
        }),
        ast::PatchEndpointAst::Transport(transport) => Ok(BindingEndpoint::Transport {
            target: binding_target_from_ast(&transport.transport)?,
            universe: dmx_range_from_ast(transport.range.as_ref())?,
            address: address_from_ast(transport.address.as_ref())?,
        }),
        ast::PatchEndpointAst::Fixture(fixture) => {
            let element_from_target = fixture
                .target
                .as_ref()
                .and_then(|target| target.element.as_ref())
                .map(|element| parse_u16(&element.index))
                .transpose()?;
            let element_from_ids = fixture_element_from_ids(&fixture.ids)?;
            if let (Some(from_target), Some(from_ids)) = (element_from_target, element_from_ids) {
                if from_target != from_ids {
                    return Err(DispatchError::ConversionFailed(
                        "fixture element selector mismatch".to_string(),
                    ));
                }
            }

            Ok(BindingEndpoint::Fixture {
                ids: fixture_ids_from_ast(&fixture.ids)?,
                element: element_from_target.or(element_from_ids),
                param: fixture
                    .target
                    .as_ref()
                    .and_then(|target| target.param.as_ref())
                    .map(|param| param.name.0.to_string()),
            })
        }
        ast::PatchEndpointAst::Disabled(_) => Ok(BindingEndpoint::Disabled),
    }
}

fn binding_target_from_ast(transport: &ast::TransportNameAst) -> Result<String, DispatchError> {
    let target = transport.0.to_ascii_lowercase();
    if target == "udmx" || is_valid_network_dmx_target_id(&target) {
        return Ok(target);
    }
    Err(DispatchError::ConversionFailed(format!(
        "invalid transport target '{}'",
        transport.0
    )))
}

/// Extracts one fixture or fixture-element reference from a parsed identifier expression.
fn single_fixture_or_element_ref(
    id_ast: &ast::IdentifierExpressionAst,
) -> Option<UnresolvedFixtureRef> {
    if !id_ast.tail.is_empty() {
        return None;
    }

    match &id_ast.head {
        ast::TermAst::Single(single) => Some(conv::singleid_to_unresolved(single)),
        ast::TermAst::Grouped(grouped) => single_fixture_or_element_ref(&grouped.expr),
        _ => None,
    }
}

fn fixture_ids_from_ast(ids: &ast::IdentifierExpressionAst) -> Result<Vec<u32>, DispatchError> {
    let expr = fixture_identifier_expression_to_idexpr(ids)?;
    let expanded = expr.expand();
    if expanded.is_empty() {
        return Err(DispatchError::ConversionFailed(
            "fixture IDs resolve to empty set".to_string(),
        ));
    }
    Ok(expanded)
}

fn fixture_identifier_expression_to_idexpr(
    ids: &ast::IdentifierExpressionAst,
) -> Result<IdExpr, DispatchError> {
    let mut expr = fixture_term_to_idexpr(&ids.head)?;
    for op in &ids.tail {
        let rhs = fixture_term_to_idexpr(&op.term)?;
        expr = match op.op {
            ast::SetOperatorAst::Add => IdExpr::Add {
                lhs: Box::new(expr),
                rhs: Box::new(rhs),
            },
            ast::SetOperatorAst::Remove => IdExpr::Sub {
                lhs: Box::new(expr),
                rhs: Box::new(rhs),
            },
        };
    }
    Ok(expr)
}

fn fixture_term_to_idexpr(term: &ast::TermAst) -> Result<IdExpr, DispatchError> {
    match term {
        ast::TermAst::Grouped(grouped) => Ok(IdExpr::Span(Box::new(
            fixture_identifier_expression_to_idexpr(&grouped.expr)?,
        ))),
        ast::TermAst::Range(range) => {
            let start = fixture_singleid_to_u32(&range.start)?;
            let end = fixture_singleid_to_u32(&range.end)?;
            Ok(IdExpr::Range { start, end })
        }
        ast::TermAst::Single(single) => Ok(IdExpr::Single(fixture_singleid_to_u32(single)?)),
        ast::TermAst::FixtureMap(map) => Ok(IdExpr::Range {
            start: map.fixtures.start,
            end: map.fixtures.end,
        }),
    }
}

fn fixture_singleid_to_u32(single: &ast::SingleIdAst) -> Result<u32, DispatchError> {
    match &single.target {
        ast::TargetAst::FixtureRef { fixture_id } => Ok(*fixture_id),
        ast::TargetAst::ElementRef {
            fixture_id,
            element_index: _,
        } => Ok(*fixture_id),
    }
}

fn fixture_element_from_ids(
    ids: &ast::IdentifierExpressionAst,
) -> Result<Option<u16>, DispatchError> {
    if !ids.tail.is_empty() {
        return Ok(None);
    }

    match &ids.head {
        ast::TermAst::Single(single) => match &single.target {
            ast::TargetAst::ElementRef { element_index, .. } => {
                element_index.map(parse_element_index).transpose()
            }
            _ => Ok(None),
        },
        ast::TermAst::FixtureMap(map) => match &map.elements {
            ast::ElementSelectorAst::Single(index) => parse_element_u32(*index).map(Some),
            ast::ElementSelectorAst::Range { .. } => Err(DispatchError::ConversionFailed(
                "fixture element ranges are not supported in bindings".to_string(),
            )),
        },
        _ => Ok(None),
    }
}

fn parse_element_index(index: u32) -> Result<u16, DispatchError> {
    parse_element_u32(index)
}

fn parse_element_u32(index: u32) -> Result<u16, DispatchError> {
    u16::try_from(index)
        .map_err(|_| DispatchError::ConversionFailed(format!("invalid element index '{}'", index)))
}

fn dmx_range_from_ast(
    range: Option<&ast::UniverseRangeAst>,
) -> Result<Option<DmxRange>, DispatchError> {
    let Some(range) = range else {
        return Ok(None);
    };
    let start = parse_u16(&range.start)?;
    let end = range
        .end
        .as_ref()
        .map(parse_u16)
        .transpose()?
        .unwrap_or(start);
    let (start, end) = if start <= end {
        (start, end)
    } else {
        (end, start)
    };
    Ok(Some(DmxRange { start, end }))
}

fn address_from_ast(address: Option<&ast::AddressAst>) -> Result<Option<u16>, DispatchError> {
    address.map(|addr| parse_u16(&addr.value)).transpose()
}

fn priority_from_ast(priority: &ast::PatchPriorityAst) -> Result<i32, DispatchError> {
    priority
        .value
        .0
        .parse::<i32>()
        .map_err(|_| DispatchError::ConversionFailed("invalid patch priority".to_string()))
}

fn parse_u16(value: &ast::IntegerAst) -> Result<u16, DispatchError> {
    value
        .0
        .parse::<u16>()
        .map_err(|_| DispatchError::ConversionFailed(format!("invalid integer '{}'", value.0)))
}

fn convert_position_axis_value(
    axis_val: &ast::AxisValueAst,
) -> Result<FixturePlacementPositionUpdate, DispatchError> {
    let val = parse_value_f32(&axis_val.value)?;
    match axis_val.axis {
        ast::AxisAst::X => Ok(FixturePlacementPositionUpdate::X(val)),
        ast::AxisAst::Y => Ok(FixturePlacementPositionUpdate::Y(val)),
        ast::AxisAst::Z => Ok(FixturePlacementPositionUpdate::Z(val)),
    }
}

fn attribute_from_ast(attr_ast: &ast::AttributeTypeAst) -> Attribute {
    match attr_ast {
        ast::AttributeTypeAst::Aliased(a) => {
            let name = format!("{:?}", a);
            Attribute::from_str(&name).unwrap_or(Attribute::Custom { label: name })
        }
        ast::AttributeTypeAst::Quoted(q) => {
            Attribute::from_str(q).unwrap_or_else(|_| Attribute::Custom {
                label: q.to_string(),
            })
        }
        ast::AttributeTypeAst::Other(o) => {
            Attribute::from_str(o).unwrap_or_else(|_| Attribute::Custom {
                label: o.to_string(),
            })
        }
    }
}

fn convert_rotation_axis_value(
    axis_val: &ast::AxisValueAst,
) -> Result<FixturePlacementRotationUpdate, DispatchError> {
    let val = parse_value_f32(&axis_val.value)?;
    match axis_val.axis {
        ast::AxisAst::X => Ok(FixturePlacementRotationUpdate::X(val)),
        ast::AxisAst::Y => Ok(FixturePlacementRotationUpdate::Y(val)),
        ast::AxisAst::Z => Ok(FixturePlacementRotationUpdate::Z(val)),
    }
}

fn convert_position_action(
    id: u32,
    position: &ast::PositionActionAst,
) -> Result<Vec<FixturePlacementUpdateEntry>, DispatchError> {
    match &position.value {
        ast::PositionValueAst::Axis(axis_value) => Ok(vec![FixturePlacementUpdateEntry {
            id,
            position: Some(convert_position_axis_value(axis_value)?),
            rotation: None,
        }]),
        ast::PositionValueAst::Tuple(tuple) => Ok(vec![FixturePlacementUpdateEntry {
            id,
            position: Some(FixturePlacementPositionUpdate::All(PlacementPosition {
                x: parse_value_f32(&tuple.x)?,
                y: parse_value_f32(&tuple.y)?,
                z: parse_value_f32(&tuple.z)?,
            })),
            rotation: None,
        }]),
        ast::PositionValueAst::AxisChain(axis_values) => axis_values
            .iter()
            .map(|axis_value| {
                Ok(FixturePlacementUpdateEntry {
                    id,
                    position: Some(convert_position_axis_value(axis_value)?),
                    rotation: None,
                })
            })
            .collect(),
    }
}

fn convert_rotation_action(
    id: u32,
    rotation: &ast::RotationActionAst,
) -> Result<Vec<FixturePlacementUpdateEntry>, DispatchError> {
    match &rotation.value {
        ast::RotationValueAst::Axis(axis_value) => Ok(vec![FixturePlacementUpdateEntry {
            id,
            position: None,
            rotation: Some(convert_rotation_axis_value(axis_value)?),
        }]),
        ast::RotationValueAst::Tuple(tuple) => Ok(vec![FixturePlacementUpdateEntry {
            id,
            position: None,
            rotation: Some(FixturePlacementRotationUpdate::All(PlacementRotation {
                x: parse_value_f32(&tuple.x)?,
                y: parse_value_f32(&tuple.y)?,
                z: parse_value_f32(&tuple.z)?,
            })),
        }]),
        ast::RotationValueAst::AxisChain(axis_values) => axis_values
            .iter()
            .map(|axis_value| {
                Ok(FixturePlacementUpdateEntry {
                    id,
                    position: None,
                    rotation: Some(convert_rotation_axis_value(axis_value)?),
                })
            })
            .collect(),
    }
}

fn parse_value_f32(value: &ast::ValueAst) -> Result<f32, DispatchError> {
    value
        .0
        .parse::<f32>()
        .map_err(|_| DispatchError::ConversionFailed(format!("invalid axis value '{}'", value.0)))
}
