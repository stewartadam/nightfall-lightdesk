// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! AST converter for fx commands
use std::str::FromStr;

use nightfall::prelude::*;
use nightfall_cmd_parse::ast;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use thiserror::Error;
use uuid::Uuid;

use crate::events::{
    FxStepDraft, FxStepSequenceDraft, StepFxCommand, StepFxCommandValueSource, StepFxDraft,
};
use crate::step_fx::{
    Bezier, CurveType, FxDirection, FxLane, FxStep, FxTrack, Linear, Point2D, Snap, StepFx,
    StepFxPhase, StepFxTiming, StepFxTransition,
};

/// Errors that can occur during AST conversion for FX commands
#[derive(Debug, Error)]
pub enum AstConvError {
    /// Missing required data in the AST
    #[error("missing data: {0}")]
    Missing(&'static str),
    /// Invalid value encountered in the AST
    #[error("invalid value: {0}")]
    Invalid(&'static str),
}

/// Convert FxActionAst -> StepFxCommand(s)
pub fn stepfx_commands_from_ast<'i>(
    fx_id: u32,
    action: &ast::FxActionAst<'i>,
) -> Result<Vec<StepFxCommand>, AstConvError> {
    match action {
        ast::FxActionAst::Start => Ok(vec![StepFxCommand::Start(fx_id)]),
        ast::FxActionAst::Stop => Ok(vec![StepFxCommand::Stop(fx_id)]),
        ast::FxActionAst::SetRate(set_rate_ast) => {
            // ValueAst is a newtype around &'i str
            let rate_text = (set_rate_ast.value).0;
            let rate = rate_text
                .parse::<f32>()
                .map_err(|_| AstConvError::Invalid("fx rate"))?;
            Ok(vec![StepFxCommand::SetRate { fx_id, rate }])
        }
        ast::FxActionAst::CreateStep(create_ast) => {
            let selection =
                nightfall_cmd_parse::parse_spatial_selection_text(create_ast.selection.source)
                    .map_err(|_| AstConvError::Invalid("selection"))?;

            // duration (seconds)
            let duration_secs = nightfall_cmd_parse::conv::duration_from_ast(&create_ast.duration)
                .map_err(|_| AstConvError::Invalid("duration"))?;
            let beat_duration = std::time::Duration::from_secs_f32(duration_secs);

            // Convert command attributes into canonical lanes and contribution tracks.
            let mut sequences = Vec::new();
            for attr in &create_ast.attributes {
                // attribute type conversion: try parse attribute name via existing Attribute::from_str
                let attribute = match &attr.attribute {
                    ast::AttributeTypeAst::Aliased(a) => {
                        let name = format!("{:?}", a);
                        Attribute::from_str(&name).unwrap_or(Attribute::Custom { label: name })
                    }
                    ast::AttributeTypeAst::Quoted(q) => {
                        let name = q.to_string();
                        Attribute::from_str(&name).unwrap_or(Attribute::Custom { label: name })
                    }
                    ast::AttributeTypeAst::Other(o) => {
                        let name = o.to_string();
                        Attribute::from_str(&name).unwrap_or(Attribute::Custom { label: name })
                    }
                };

                let mut steps = Vec::new();
                for step_ast in &attr.steps {
                    let target =
                        step_fx_command_value_from_ast(&step_ast.source, &attribute, "step value")?;
                    let width_beats = match &step_ast.width {
                        Some(v) => {
                            let w = nightfall_cmd_parse::conv::parameter_value_from_ast(v)
                                .map_err(|_| AstConvError::Invalid("width"))?;
                            f32_from_param(&w).unwrap_or(0.0)
                        }
                        None => 0.0,
                    };
                    let transition = match &step_ast.ramp {
                        Some(v) => {
                            let t = nightfall_cmd_parse::conv::parameter_value_from_ast(v)
                                .map_err(|_| AstConvError::Invalid("ramp"))?;
                            StepFxTransition::from(f32_from_param(&t).unwrap_or(1.0))
                        }
                        None => StepFxTransition::default(),
                    };
                    let curve = match &step_ast.curve {
                        Some(c) => match c {
                            ast::CurveNameAst::Linear => CurveType::Linear(Linear {}),
                            ast::CurveNameAst::Snap => CurveType::Snap(crate::step_fx::Snap {}),
                            ast::CurveNameAst::Ease => CurveType::Bezier(Bezier::EASE),
                            ast::CurveNameAst::Easein => CurveType::Bezier(Bezier::EASE_IN),
                            ast::CurveNameAst::Easeout => CurveType::Bezier(Bezier::EASE_OUT),
                            ast::CurveNameAst::Bezier(b) => {
                                // parse control points values
                                let x1p =
                                    nightfall_cmd_parse::conv::parameter_value_from_ast(&b.x1)
                                        .map_err(|_| AstConvError::Invalid("bezier x1"))?;
                                let y1p =
                                    nightfall_cmd_parse::conv::parameter_value_from_ast(&b.y1)
                                        .map_err(|_| AstConvError::Invalid("bezier y1"))?;
                                let x2p =
                                    nightfall_cmd_parse::conv::parameter_value_from_ast(&b.x2)
                                        .map_err(|_| AstConvError::Invalid("bezier x2"))?;
                                let y2p =
                                    nightfall_cmd_parse::conv::parameter_value_from_ast(&b.y2)
                                        .map_err(|_| AstConvError::Invalid("bezier y2"))?;
                                let x1 = f32_from_param(&x1p).unwrap_or(0.42);
                                let y1 = f32_from_param(&y1p).unwrap_or(0.0);
                                let x2 = f32_from_param(&x2p).unwrap_or(0.58);
                                let y2 = f32_from_param(&y2p).unwrap_or(1.0);
                                CurveType::Bezier(Bezier {
                                    cp1: Point2D { x: x1, y: y1 },
                                    cp2: Point2D { x: x2, y: y2 },
                                })
                            }
                        },
                        None => CurveType::Linear(Linear {}),
                    };

                    steps.push(FxStepDraft {
                        uid: Uuid::new_v4(),
                        target,
                        width_beats,
                        transition,
                        curve,
                    });
                }

                // Parse per-attribute base_value if present (e.g., int @ 50 steps ...)
                let base_value = match &attr.base_value {
                    Some(source) => Some(step_fx_command_value_from_ast(
                        source,
                        &attribute,
                        "base_value",
                    )?),
                    None => None,
                };

                normalize_step_widths(&mut steps);
                sequences.push(FxStepSequenceDraft {
                    attribute,
                    base_value,
                    steps,
                });
            }

            let step_fx = StepFxDraft {
                identifiers: Identifiers {
                    id: fx_id,
                    label: format!("FX {}", fx_id),
                    uid: Uuid::new_v4(),
                },
                selection,
                timing: StepFxTiming { beat_duration },
                phase: StepFxPhase {
                    waypoints: vec![0.0, 1.0],
                    ..Default::default()
                },
                direction: FxDirection::Forward,
                cycle_scale: Default::default(),
                sequences,
            };

            let command = if step_fx_draft_references_blueprints(&step_fx) {
                StepFxCommand::Create(step_fx)
            } else {
                StepFxCommand::Store(step_fx_from_direct_draft(step_fx))
            };
            Ok(vec![command])
        }
    }
}

/// Returns whether a command draft needs stateful Blueprint resolution.
fn step_fx_draft_references_blueprints(draft: &StepFxDraft) -> bool {
    draft.sequences.iter().any(|sequence| {
        sequence
            .base_value
            .iter()
            .chain(sequence.steps.iter().map(|step| &step.target))
            .any(|source| matches!(source, StepFxCommandValueSource::Blueprint { .. }))
    })
}

/// Converts a draft containing only direct values into the canonical lane model.
fn step_fx_from_direct_draft(draft: StepFxDraft) -> StepFx {
    let lanes = draft
        .sequences
        .into_iter()
        .map(|sequence| {
            let direct_value = |source: StepFxCommandValueSource| match source {
                StepFxCommandValueSource::Direct(value) => value,
                StepFxCommandValueSource::Blueprint { .. } => {
                    unreachable!("Blueprint drafts take the stateful command path")
                }
            };
            let base_value = sequence.base_value.map(direct_value);
            let steps = sequence
                .steps
                .into_iter()
                .map(|step| FxStep {
                    uid: step.uid,
                    target: direct_value(step.target),
                    blueprint_uid: None,
                    width_beats: step.width_beats,
                    transition: step.transition,
                    curve: step.curve,
                })
                .collect::<Vec<_>>();
            let relative = steps.first().is_some_and(|step| step.target.is_relative());
            let dynamic_track = FxTrack { steps };
            let base_track = relative
                .then_some(base_value)
                .flatten()
                .filter(|target| !target.is_relative())
                .map(|target| FxTrack {
                    steps: vec![FxStep {
                        uid: Uuid::new_v4(),
                        target,
                        blueprint_uid: None,
                        width_beats: 1.0,
                        transition: StepFxTransition::from(0.0),
                        curve: CurveType::Snap(Snap {}),
                    }],
                });
            FxLane {
                attribute: sequence.attribute,
                timing_override: None,
                phase_override: None,
                absolute: if relative {
                    base_track
                } else {
                    Some(dynamic_track.clone())
                },
                relative: relative.then_some(dynamic_track),
            }
        })
        .collect();
    StepFx {
        color_lane: None,
        identifiers: draft.identifiers,
        selection: draft.selection,
        timing: draft.timing,
        phase: draft.phase,
        direction: draft.direction,
        cycle_scale: draft.cycle_scale,
        lanes,
    }
}

/// Converts one parsed scalar source while retaining Blueprint addresses for execution.
fn step_fx_command_value_from_ast(
    source: &ast::FxValueSourceAst,
    attribute: &Attribute,
    error_name: &'static str,
) -> Result<StepFxCommandValueSource, AstConvError> {
    match source {
        ast::FxValueSourceAst::Direct { mode, value } => {
            let value = nightfall_cmd_parse::conv::parameter_value_from_ast_with_mode(value, *mode)
                .map_err(|_| AstConvError::Invalid(error_name))?;
            nightfall_cmd_parse::conv::validate_parameter_values_for_attribute(
                std::slice::from_ref(&value),
                attribute,
            )
            .map_err(|_| AstConvError::Invalid(error_name))?;
            Ok(StepFxCommandValueSource::Direct(value))
        }
        ast::FxValueSourceAst::Blueprint(source) => {
            let address = match source.address {
                ast::BlueprintAddressAst::Id(id) => BlueprintAddress::Id(id),
                ast::BlueprintAddressAst::Label(label) => BlueprintAddress::Label(label.to_owned()),
            };
            let resolution = match source.resolution {
                ast::BlueprintResolutionAst::Reference => BlueprintResolution::Reference,
                ast::BlueprintResolutionAst::Absolute => BlueprintResolution::Absolute,
            };
            Ok(StepFxCommandValueSource::Blueprint {
                address,
                resolution,
            })
        }
    }
}

/// Normalizes command width proportions to one authored beat.
fn normalize_step_widths(steps: &mut [FxStepDraft]) {
    let total_width: f32 = steps.iter().map(|step| step.width_beats).sum();
    if total_width == 0.0 && !steps.is_empty() {
        let equal_width = 1.0 / steps.len() as f32;
        for step in steps.iter_mut() {
            step.width_beats = equal_width;
        }
    } else if total_width > 0.0 && (total_width - 1.0).abs() > f32::EPSILON {
        let scale = 1.0 / total_width;
        for step in steps.iter_mut() {
            step.width_beats *= scale;
        }
    }
}

/// Extracts a scalar f32 from any parameter value variant.
fn f32_from_param(p: &ParameterValue) -> Option<f32> {
    match p {
        ParameterValue::AbsolutePercent { value } => Some(value.as_f32()),
        ParameterValue::RelativePercent { offset } => Some(offset.as_f32()),
        ParameterValue::Absolute { value } => Some(*value),
        ParameterValue::Relative { offset } => Some(*offset),
    }
}

/// AST converter for FX commands
pub struct FxAstConverter;

impl AstConvert for FxAstConverter {
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        match ast {
            ast::CommandAst::General(gen_ast) => match gen_ast {
                ast::GeneralCommandAst::StoreStepFx(store_ast) => {
                    let ids =
                        nightfall_cmd_parse::conv::simple_identifier_ast_to_ids(&store_ast.id)
                            .map_err(|_| {
                                DispatchError::ConversionFailed("invalid step FX ID".to_string())
                            })?;
                    let action = ast::FxActionAst::CreateStep(store_ast.definition.clone());
                    let mut payloads = Vec::new();
                    for id in ids {
                        let commands = stepfx_commands_from_ast(id, &action).map_err(|error| {
                            DispatchError::ConversionFailed(format!(
                                "fx conversion failed: {error}"
                            ))
                        })?;
                        payloads.extend(
                            commands
                                .into_iter()
                                .map(|command| Box::new(command) as DynEnginePayload),
                        );
                    }
                    Ok(payloads)
                }
                ast::GeneralCommandAst::Delete(delete_ast) => {
                    if matches!(delete_ast.object_type, ast::ObjectTypeAst::Fx) {
                        let id = nightfall_cmd_parse::conv::simple_identifier_ast_to_single_id(
                            &delete_ast.id,
                        )
                        .ok_or_else(|| {
                            DispatchError::ConversionFailed("invalid fx ID".to_string())
                        })?;
                        return Ok(vec![Box::new(crate::FxCommand::DeleteFx(id))]);
                    }
                    Err(DispatchError::NotApplicable)
                }
                ast::GeneralCommandAst::Rename(rename_ast) => {
                    if matches!(rename_ast.object_type, ast::ObjectTypeAst::Fx) {
                        let id = nightfall_cmd_parse::conv::simple_identifier_ast_to_single_id(
                            &rename_ast.from,
                        )
                        .ok_or_else(|| {
                            DispatchError::ConversionFailed("invalid fx ID".to_string())
                        })?;
                        let new_id = nightfall_cmd_parse::conv::simple_identifier_ast_to_single_id(
                            &rename_ast.to,
                        )
                        .ok_or_else(|| {
                            DispatchError::ConversionFailed("invalid fx ID".to_string())
                        })?;
                        return Ok(vec![Box::new(crate::FxCommand::RenameFx { id, new_id })]);
                    }
                    Err(DispatchError::NotApplicable)
                }
                _ => Err(DispatchError::NotApplicable),
            },
            ast::CommandAst::Fx(fx_ast) => {
                // fx_ast: FxCommandAst
                let id =
                    nightfall_cmd_parse::conv::simple_identifier_ast_to_single_id(&fx_ast.fx_id)
                        .ok_or_else(|| {
                            DispatchError::ConversionFailed("invalid fx ID".to_string())
                        })?;

                match &fx_ast.action {
                    ast::FxActionAst::Start => {
                        Ok(vec![Box::new(crate::events::StepFxCommand::Start(id))])
                    }
                    ast::FxActionAst::Stop => {
                        Ok(vec![Box::new(crate::events::StepFxCommand::Stop(id))])
                    }
                    ast::FxActionAst::SetRate(set_rate_ast) => {
                        // set_rate_ast.value is ValueAst(&str)
                        let rate = set_rate_ast.value.0.parse::<f32>().map_err(|_| {
                            DispatchError::ConversionFailed("invalid rate".to_string())
                        })?;
                        Ok(vec![Box::new(crate::events::StepFxCommand::SetRate {
                            fx_id: id,
                            rate,
                        })])
                    }
                    ast::FxActionAst::CreateStep(_create_ast) => {
                        match crate::stepfx_commands_from_ast(id, &fx_ast.action) {
                            Ok(cmds) => Ok(cmds
                                .into_iter()
                                .map(|c| Box::new(c) as DynEnginePayload)
                                .collect()),
                            Err(e) => Err(DispatchError::ConversionFailed(format!(
                                "fx conversion failed: {}",
                                e
                            ))),
                        }
                    }
                }
            }
            _ => Err(DispatchError::NotApplicable),
        }
    }
}
