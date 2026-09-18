// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! AST converter for programmer commands
use std::collections::HashMap;
use std::str::FromStr;

use nightfall::prelude::*;
use nightfall_cmd_parse::{ast, conv, parse_spatial_selection_text};
use nightfall_cues::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::undo::{ClearDmxChannels, DmxChannelSnapshot};

use crate::action_model::{ClearCommand, ClearTarget, ReleaseCommand, ReleaseTarget, UserCommand};
use crate::events::{StoreCueId, StoreCuePartId, StoreMode};

/// Converts parser store mode AST into programmer command mode.
fn store_mode_from_ast(mode: ast::StoreCueModeAst) -> StoreMode {
    match mode {
        ast::StoreCueModeAst::Replace => StoreMode::Replace,
        ast::StoreCueModeAst::Merge => StoreMode::Merge,
        ast::StoreCueModeAst::Update => StoreMode::Update,
        ast::StoreCueModeAst::Remove => StoreMode::Remove,
    }
}

/// Converts programmer-related AST commands to engine commands
pub struct ProgrammerAstConverter;

impl AstConvert for ProgrammerAstConverter {
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        match ast {
            ast::CommandAst::General(gen_ast) => match gen_ast {
                ast::GeneralCommandAst::StoreCue(store_cue_ast) => {
                    use crate::prelude::ProgrammerCommand;
                    let mode = store_mode_from_ast(store_cue_ast.mode);
                    match &store_cue_ast.target {
                        ast::StoreCueTargetAst::Cue(cue_ref) => {
                            Ok(vec![Box::new(ProgrammerCommand::StoreCue {
                                sequence_id: cue_ref.sequence_id,
                                cue_id: StoreCueId::Exact(cue_ref.cue_id),
                                part_id: StoreCuePartId::Exact(0),
                                mode,
                                label: None,
                            })])
                        }
                        ast::StoreCueTargetAst::Cues {
                            sequence_id,
                            cue_ids,
                        } => {
                            let cue_ids =
                                conv::simple_identifier_ast_to_ids(cue_ids).map_err(|_| {
                                    DispatchError::ConversionFailed(
                                        "invalid cue ID expression".to_string(),
                                    )
                                })?;
                            Ok(cue_ids
                                .into_iter()
                                .map(|cue_id| {
                                    Box::new(ProgrammerCommand::StoreCue {
                                        sequence_id: *sequence_id,
                                        cue_id: StoreCueId::Exact(cue_id),
                                        part_id: StoreCuePartId::Exact(0),
                                        mode,
                                        label: None,
                                    }) as DynEnginePayload
                                })
                                .collect())
                        }
                        ast::StoreCueTargetAst::NextCue { sequence_id } => {
                            Ok(vec![Box::new(ProgrammerCommand::StoreCue {
                                sequence_id: *sequence_id,
                                cue_id: StoreCueId::Next,
                                part_id: StoreCuePartId::Exact(0),
                                mode,
                                label: None,
                            })])
                        }
                        ast::StoreCueTargetAst::CuePart { cue_ref, part_id } => {
                            Ok(vec![Box::new(ProgrammerCommand::StoreCue {
                                sequence_id: cue_ref.sequence_id,
                                cue_id: StoreCueId::Exact(cue_ref.cue_id),
                                part_id: StoreCuePartId::Exact(*part_id),
                                mode,
                                label: None,
                            })])
                        }
                        ast::StoreCueTargetAst::NextPart { cue_ref } => {
                            Ok(vec![Box::new(ProgrammerCommand::StoreCue {
                                sequence_id: cue_ref.sequence_id,
                                cue_id: StoreCueId::Exact(cue_ref.cue_id),
                                part_id: StoreCuePartId::Next,
                                mode,
                                label: None,
                            })])
                        }
                    }
                }
                ast::GeneralCommandAst::StoreGroup(store_group_ast) => {
                    let ids =
                        conv::simple_identifier_ast_to_ids(&store_group_ast.id).map_err(|_| {
                            DispatchError::ConversionFailed("invalid group ID".to_string())
                        })?;
                    use crate::prelude::ProgrammerCommand;
                    Ok(ids
                        .into_iter()
                        .map(|group_id| {
                            Box::new(ProgrammerCommand::StoreGroup {
                                group_id,
                                label: None,
                            }) as DynEnginePayload
                        })
                        .collect())
                }
                ast::GeneralCommandAst::StoreFixture(_) => {
                    // Fixture store commands are handled by FixtureAstConverter
                    Err(DispatchError::NotApplicable)
                }
                ast::GeneralCommandAst::StoreBlueprint(store_bp_ast) => {
                    let ids =
                        conv::simple_identifier_ast_to_ids(&store_bp_ast.id).map_err(|_| {
                            DispatchError::ConversionFailed("invalid blueprint ID".to_string())
                        })?;
                    use crate::prelude::ProgrammerCommand;
                    Ok(ids
                        .into_iter()
                        .map(|blueprint_id| {
                            Box::new(ProgrammerCommand::StoreBlueprint {
                                blueprint_id,
                                filter: store_bp_ast
                                    .filter
                                    .iter()
                                    .map(store_blueprint_filter_from_ast)
                                    .collect(),
                            }) as DynEnginePayload
                        })
                        .collect())
                }
                ast::GeneralCommandAst::RecallCue(recall_cue_ast) => {
                    use crate::prelude::ProgrammerCommand;
                    Ok(vec![Box::new(ProgrammerCommand::RecallCue {
                        sequence_id: recall_cue_ast.cue_ref.sequence_id,
                        cue_id: recall_cue_ast.cue_ref.cue_id,
                        part_id: recall_cue_ast.part_id.unwrap_or(0),
                        select: recall_cue_ast.select,
                    })])
                }
                ast::GeneralCommandAst::RecallBlueprint(recall_bp_ast) => {
                    use crate::prelude::ProgrammerCommand;
                    Ok(vec![Box::new(
                        ProgrammerCommand::ApplyAttributeOperations {
                            selection: None,
                            operations: vec![crate::events::ProgrammerAttributeOperation {
                                target: BlueprintSelector::All,
                                source: programmer_blueprint_source(&recall_bp_ast.source),
                            }],
                            transitions: Default::default(),
                            transitions_by_attribute: Default::default(),
                        },
                    )])
                }
                ast::GeneralCommandAst::Release(release_ast) => {
                    let release_target = match &release_ast.target {
                        None => None,
                        Some(ast::ReleaseTargetAst::Selection(selection_ast)) => {
                            let selection =
                                conv::selection_from_ast(selection_ast).map_err(|error| {
                                    DispatchError::ConversionFailed(format!(
                                        "selection conversion: {error}"
                                    ))
                                })?;
                            Some(ReleaseTarget::Selection(selection))
                        }
                        Some(ast::ReleaseTargetAst::Fixture(fixture_target)) => {
                            let selection = conv::identifier_expression_to_selection(
                                &fixture_target.selection.ids,
                            );
                            let attributes = fixture_target
                                .attributes
                                .as_ref()
                                .map(|attributes| {
                                    attributes
                                        .attributes
                                        .iter()
                                        .map(conv::attribute_type_from_ast)
                                        .collect::<Vec<_>>()
                                })
                                .unwrap_or_default();
                            Some(ReleaseTarget::Fixture {
                                selection,
                                attributes,
                            })
                        }
                        Some(ast::ReleaseTargetAst::Attribute(attribute_target)) => {
                            let attributes = attribute_target
                                .attributes
                                .attributes
                                .iter()
                                .map(conv::attribute_type_from_ast)
                                .collect::<Vec<_>>();
                            Some(ReleaseTarget::Attribute { attributes })
                        }
                        Some(ast::ReleaseTargetAst::Dmx(dmx_target)) => {
                            let channels =
                                conv::release_dmx_channel_expression_from_ast(&dmx_target.channels)
                                    .map_err(|error| {
                                        DispatchError::ConversionFailed(format!(
                                            "dmx channel conversion: {error}"
                                        ))
                                    })?;
                            Some(ReleaseTarget::Channels { channels })
                        }
                        Some(ast::ReleaseTargetAst::StaleInputs) => {
                            return Ok(vec![Box::new(
                                nightfall_desk::prelude::DeskCommand::ReleaseStaleInputs,
                            )]);
                        }
                    };

                    match release_target {
                        Some(ReleaseTarget::Channels { channels }) => {
                            Ok(vec![Box::new(ClearDmxChannels(DmxChannelSnapshot {
                                channels,
                                value: 0,
                            }))])
                        }
                        target => Ok(vec![Box::new(UserCommand::Release(ReleaseCommand {
                            target,
                            allow_selection_flatten: false,
                            selection_flatten_approval: None,
                        }))]),
                    }
                }
                ast::GeneralCommandAst::Clear(clear_ast) => {
                    if clear_ast.targets.is_empty() {
                        return Ok(vec![Box::new(UserCommand::Clear(ClearCommand::default()))]);
                    }

                    let mut targets: Vec<ClearTarget> = Vec::new();
                    let mut cleared_selection = false;
                    let mut cleared_values = false;

                    for target in &clear_ast.targets {
                        match target {
                            ast::ClearTargetAst::Selection(_) if !cleared_selection => {
                                targets.push(ClearTarget::Selection);
                                cleared_selection = true;
                            }
                            ast::ClearTargetAst::Values(_) if !cleared_values => {
                                targets.push(ClearTarget::Values);
                                cleared_values = true;
                            }
                            ast::ClearTargetAst::Fixture(fixture_target) => {
                                let selection = conv::identifier_expression_to_selection(
                                    &fixture_target.selection.ids,
                                );
                                let attributes = fixture_target
                                    .attributes
                                    .as_ref()
                                    .map(|attrs| {
                                        attrs
                                            .attributes
                                            .iter()
                                            .map(conv::attribute_type_from_ast)
                                            .collect::<Vec<_>>()
                                    })
                                    .unwrap_or_default();
                                targets.push(ClearTarget::Fixture {
                                    selection,
                                    attributes,
                                });
                            }
                            ast::ClearTargetAst::Attribute(attribute_target) => {
                                let attributes = attribute_target
                                    .attributes
                                    .attributes
                                    .iter()
                                    .map(conv::attribute_type_from_ast)
                                    .collect::<Vec<_>>();
                                targets.push(ClearTarget::Attribute { attributes });
                            }
                            _ => {}
                        }
                    }

                    Ok(vec![Box::new(UserCommand::Clear(ClearCommand {
                        targets,
                        allow_selection_flatten: false,
                        selection_flatten_approval: None,
                    }))])
                }
                _ => Err(DispatchError::NotApplicable),
            },
            ast::CommandAst::Selection(sel_ast) => {
                let selection = parse_spatial_selection_text(sel_ast.source).map_err(|e| {
                    DispatchError::ConversionFailed(format!("selection conversion: {e}"))
                })?;
                use crate::prelude::ProgrammerCommand;
                Ok(vec![Box::new(
                    ProgrammerCommand::SetProgrammerSpatialSelection(selection),
                )])
            }
            ast::CommandAst::Attribute(attr_ast) => {
                let selection =
                    parse_spatial_selection_text(attr_ast.selection.source).map_err(|e| {
                        DispatchError::ConversionFailed(format!("selection conversion: {e}"))
                    })?;
                use crate::prelude::ProgrammerCommand;
                if attribute_actions_use_blueprints(&attr_ast.actions) {
                    let (operations, transitions, transitions_by_attribute) =
                        attribute_actions_to_programmer_operations(
                            &attr_ast.actions,
                            &attr_ast.timings,
                        )
                        .map_err(|error| {
                            DispatchError::ConversionFailed(format!("attribute parsing: {error}"))
                        })?;
                    return Ok(vec![Box::new(
                        ProgrammerCommand::ApplyAttributeOperations {
                            selection: Some(selection),
                            operations,
                            transitions,
                            transitions_by_attribute,
                        },
                    )]);
                }
                let instruction =
                    attribute_actions_to_cue_instruction(&attr_ast.actions, &attr_ast.timings)
                        .map_err(|e| {
                            DispatchError::ConversionFailed(format!("attribute parsing: {}", e))
                        })?;
                Ok(vec![Box::new(
                    ProgrammerCommand::AddProgrammerInstruction {
                        selection,
                        instruction,
                    },
                )])
            }
            ast::CommandAst::ActiveSelectionAttribute(active_attr_ast) => {
                use crate::prelude::ProgrammerCommand;
                if attribute_actions_use_blueprints(&active_attr_ast.actions) {
                    let (operations, transitions, transitions_by_attribute) =
                        attribute_actions_to_programmer_operations(
                            &active_attr_ast.actions,
                            &active_attr_ast.timings,
                        )
                        .map_err(|error| {
                            DispatchError::ConversionFailed(format!("attribute parsing: {error}"))
                        })?;
                    return Ok(vec![Box::new(
                        ProgrammerCommand::ApplyAttributeOperations {
                            selection: None,
                            operations,
                            transitions,
                            transitions_by_attribute,
                        },
                    )]);
                }
                let instruction = attribute_actions_to_cue_instruction(
                    &active_attr_ast.actions,
                    &active_attr_ast.timings,
                )
                .map_err(|e| {
                    DispatchError::ConversionFailed(format!("attribute parsing: {}", e))
                })?;
                Ok(vec![Box::new(
                    ProgrammerCommand::AddProgrammerInstructionWithActiveSelection(instruction),
                )])
            }
            _ => Err(DispatchError::NotApplicable),
        }
    }
}

/// Convert an AttributeTypeAst to an Attribute
fn attribute_type_ast_to_attribute(attr_ast: &ast::AttributeTypeAst) -> Attribute {
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

/// Converts an unquoted category name or ordinary attribute into a Blueprint store filter.
fn store_blueprint_filter_from_ast(attr_ast: &ast::AttributeTypeAst) -> BlueprintSelector {
    let ast::AttributeTypeAst::Other(name) = attr_ast else {
        return BlueprintSelector::Attribute(attribute_type_ast_to_attribute(attr_ast));
    };
    let category = match name.to_ascii_lowercase().as_str() {
        "dimmer" => Some(AttributeCategory::Dimmer),
        "position" => Some(AttributeCategory::Position),
        "gobo" => Some(AttributeCategory::Gobo),
        "color" | "colour" => Some(AttributeCategory::Color),
        "beam" => Some(AttributeCategory::Beam),
        "focus" => Some(AttributeCategory::Focus),
        "control" => Some(AttributeCategory::Control),
        "other" => Some(AttributeCategory::Other),
        _ => None,
    };
    category.map_or_else(
        || BlueprintSelector::Attribute(attribute_type_ast_to_attribute(attr_ast)),
        BlueprintSelector::Category,
    )
}

/// Convert a DurationRangeAst to a TransitionMode
/// - 1 value -> Fixed
/// - 2 values -> Interpolated
/// - 3+ values -> Manual (envelope with interpolated waypoints)
fn duration_range_to_transition_mode(
    range: &ast::DurationRangeAst,
    context: &str,
) -> Result<TransitionMode, String> {
    use std::time::Duration;

    let durations: Vec<Duration> = range
        .values
        .iter()
        .map(|v| {
            let secs: f32 = conv::duration_from_ast(v)
                .map_err(|_| format!("invalid {} value: {:?}", context, v))?;
            Ok(Duration::from_secs_f32(secs))
        })
        .collect::<Result<Vec<_>, String>>()?;

    match durations.len() {
        0 => Err(format!("empty {} value range", context)),
        1 => Ok(TransitionMode::Fixed(durations[0])),
        2 => Ok(TransitionMode::Interpolated {
            start: durations[0],
            end: durations[1],
        }),
        _ => Ok(TransitionMode::Manual(durations)),
    }
}

/// Applies a fade transition mode to the directed fields requested by the timing AST.
fn apply_fade_timing(
    transition: &mut PartialTransition,
    direction: Option<ast::TimingDirectionAst>,
    transition_mode: TransitionMode,
) {
    match direction {
        Some(ast::TimingDirectionAst::In) => {
            transition.fade_in = Some(transition_mode);
        }
        Some(ast::TimingDirectionAst::Out) => {
            transition.fade_out = Some(transition_mode);
        }
        None => {
            transition.fade_in = Some(transition_mode.clone());
            transition.fade_out = Some(transition_mode);
        }
    }
}

/// Applies a delay transition mode to the directed fields requested by the timing AST.
fn apply_delay_timing(
    transition: &mut PartialTransition,
    direction: Option<ast::TimingDirectionAst>,
    transition_mode: TransitionMode,
) {
    match direction {
        Some(ast::TimingDirectionAst::In) => {
            transition.delay_in = Some(transition_mode);
        }
        Some(ast::TimingDirectionAst::Out) => {
            transition.delay_out = Some(transition_mode);
        }
        None => {
            transition.delay_in = Some(transition_mode.clone());
            transition.delay_out = Some(transition_mode);
        }
    }
}

/// Applies one parsed fade clause to global and per-attribute transition fields.
fn apply_fade_clause(
    transition: &mut PartialTransition,
    attribute_transitions: &mut AttributeTransitions,
    direction: Option<ast::TimingDirectionAst>,
    value: &Option<ast::DurationRangeAst>,
    overrides: &[ast::AttributeOverrideAst],
) -> Result<(), String> {
    if let Some(fade_range) = value {
        let transition_mode = duration_range_to_transition_mode(fade_range, "fade")?;
        apply_fade_timing(transition, direction, transition_mode);
    }

    for attr_override in overrides {
        let attribute = attribute_type_ast_to_attribute(&attr_override.attribute);
        let transition_mode = duration_range_to_transition_mode(&attr_override.value, "fade")?;

        let attr_transition = attribute_transitions.entry(attribute).or_default();
        apply_fade_timing(attr_transition, direction, transition_mode);
    }

    Ok(())
}

/// Applies one parsed delay clause to global and per-attribute transition fields.
fn apply_delay_clause(
    transition: &mut PartialTransition,
    attribute_transitions: &mut AttributeTransitions,
    direction: Option<ast::TimingDirectionAst>,
    value: &Option<ast::DurationRangeAst>,
    overrides: &[ast::AttributeOverrideAst],
) -> Result<(), String> {
    if let Some(delay_range) = value {
        let transition_mode = duration_range_to_transition_mode(delay_range, "delay")?;
        apply_delay_timing(transition, direction, transition_mode);
    }

    for attr_override in overrides {
        let attribute = attribute_type_ast_to_attribute(&attr_override.attribute);
        let transition_mode = duration_range_to_transition_mode(&attr_override.value, "delay")?;

        let attr_transition = attribute_transitions.entry(attribute).or_default();
        apply_delay_timing(attr_transition, direction, transition_mode);
    }

    Ok(())
}

/// Convert timing AST to a PartialTransition and per-attribute transitions
fn timings_to_transitions(
    timings: &Option<ast::TimingsAst>,
) -> Result<(PartialTransition, AttributeTransitions), String> {
    let mut transition = PartialTransition::default();
    let mut attribute_transitions: AttributeTransitions = HashMap::new();

    if let Some(timings) = timings {
        // Process fades. Bare fade timing applies to both assertion directions.
        if let Some(fades) = &timings.fades {
            apply_fade_clause(
                &mut transition,
                &mut attribute_transitions,
                fades.direction,
                &fades.value,
                &fades.overrides,
            )?;
            for clause in &fades.additional {
                apply_fade_clause(
                    &mut transition,
                    &mut attribute_transitions,
                    clause.direction,
                    &clause.value,
                    &clause.overrides,
                )?;
            }
        }

        // Process delays. Bare delay timing applies to both assertion directions.
        if let Some(delays) = &timings.delays {
            apply_delay_clause(
                &mut transition,
                &mut attribute_transitions,
                delays.direction,
                &delays.value,
                &delays.overrides,
            )?;
            for clause in &delays.additional {
                apply_delay_clause(
                    &mut transition,
                    &mut attribute_transitions,
                    clause.direction,
                    &clause.value,
                    &clause.overrides,
                )?;
            }
        }
    }

    Ok((transition, attribute_transitions))
}

/// Convert attribute actions to a CueInstruction
fn attribute_actions_to_cue_instruction(
    actions: &ast::AttributeActionsAst,
    timings: &Option<ast::TimingsAst>,
) -> Result<CueInstruction, String> {
    let mut values = HashMap::new();

    // Convert the first attribute action
    attributes_from_action(&actions.first, &mut values)?;

    // Convert remaining attribute actions
    for set_attr in &actions.rest {
        attributes_from_set_attribute(set_attr, &mut values)?;
    }

    // Convert timing information (both global and per-attribute)
    let (transitions, transitions_by_attribute) = timings_to_transitions(timings)?;

    Ok(CueInstruction {
        blueprint_application: None,
        values,
        transitions_by_attribute,
        transitions_by_fixture_attribute: Default::default(),
        color_path_id: None,
        transitions,
    })
}

/// Convert an attribute action to attribute assignments
fn attributes_from_action(
    action: &ast::AttributeActionAst,
    values: &mut HashMap<Attribute, ValueSource>,
) -> Result<(), String> {
    match action {
        ast::AttributeActionAst::SetFullIntensity => {
            values.insert(
                Attribute::Intensity,
                ValueSource::Inline(
                    conv::parameter_value_from_ast(&ast::ValueAst("100"))
                        .map_err(|e| format!("value conversion: {}", e))?,
                ),
            );
        }
        ast::AttributeActionAst::SetIntensity(value_range_ast) => {
            let value_source = conv::value_source_from_range_ast_for_attribute(
                value_range_ast,
                &Attribute::Intensity,
            )
            .map_err(|e| format!("value conversion: {}", e))?;
            values.insert(Attribute::Intensity, value_source);
        }
        ast::AttributeActionAst::SetAttribute(set_attr_ast) => {
            attributes_from_set_attribute(set_attr_ast, values)?;
        }
        ast::AttributeActionAst::ApplyBlueprint(_) => {
            return Err("Blueprint source requires stateful execution".to_string());
        }
    }
    Ok(())
}

/// Convert a SetAttribute AST to attribute assignments
fn attributes_from_set_attribute(
    set_attr: &ast::SetAttributeAst,
    values: &mut HashMap<Attribute, ValueSource>,
) -> Result<(), String> {
    let ast::AttributeTargetAst::Attribute(attribute_ast) = &set_attr.target else {
        return Err("attribute category requires a Blueprint source".to_string());
    };
    let ast::AttributeValueSourceAst::Direct(value_ast) = &set_attr.source else {
        return Err("Blueprint source requires stateful execution".to_string());
    };
    let attribute = attribute_type_ast_to_attribute(attribute_ast);
    let value_source = conv::value_source_from_range_ast_for_attribute(value_ast, &attribute)
        .map_err(|e| format!("value conversion: {}", e))?;

    values.insert(attribute, value_source);
    Ok(())
}

/// Returns whether any action requires the stateful Blueprint execution path.
fn attribute_actions_use_blueprints(actions: &ast::AttributeActionsAst) -> bool {
    matches!(actions.first, ast::AttributeActionAst::ApplyBlueprint(_))
        || matches!(
            actions.first,
            ast::AttributeActionAst::SetAttribute(ast::SetAttributeAst {
                source: ast::AttributeValueSourceAst::Blueprint(_),
                ..
            })
        )
        || actions
            .rest
            .iter()
            .any(|action| matches!(action.source, ast::AttributeValueSourceAst::Blueprint(_)))
}

/// Converts shared attribute actions into ordered operations for the stateful handler.
fn attribute_actions_to_programmer_operations(
    actions: &ast::AttributeActionsAst,
    timings: &Option<ast::TimingsAst>,
) -> Result<
    (
        Vec<crate::events::ProgrammerAttributeOperation>,
        PartialTransition,
        AttributeTransitions,
    ),
    String,
> {
    let mut operations = Vec::with_capacity(actions.rest.len() + 1);
    operations.push(programmer_operation_from_action(&actions.first)?);
    for action in &actions.rest {
        operations.push(programmer_operation_from_set_attribute(action)?);
    }
    let (transitions, transitions_by_attribute) = timings_to_transitions(timings)?;
    Ok((operations, transitions, transitions_by_attribute))
}

/// Converts the first action, including intensity shorthand or complete Blueprint recall.
fn programmer_operation_from_action(
    action: &ast::AttributeActionAst,
) -> Result<crate::events::ProgrammerAttributeOperation, String> {
    match action {
        ast::AttributeActionAst::SetFullIntensity => {
            Ok(crate::events::ProgrammerAttributeOperation {
                target: BlueprintSelector::Attribute(Attribute::Intensity),
                source: crate::events::ProgrammerAttributeSource::Direct(ValueSource::Inline(
                    conv::parameter_value_from_ast(&ast::ValueAst("100"))
                        .map_err(|error| format!("value conversion: {error}"))?,
                )),
            })
        }
        ast::AttributeActionAst::SetIntensity(value) => {
            Ok(crate::events::ProgrammerAttributeOperation {
                target: BlueprintSelector::Attribute(Attribute::Intensity),
                source: crate::events::ProgrammerAttributeSource::Direct(
                    conv::value_source_from_range_ast_for_attribute(value, &Attribute::Intensity)
                        .map_err(|error| format!("value conversion: {error}"))?,
                ),
            })
        }
        ast::AttributeActionAst::SetAttribute(action) => {
            programmer_operation_from_set_attribute(action)
        }
        ast::AttributeActionAst::ApplyBlueprint(source) => {
            Ok(crate::events::ProgrammerAttributeOperation {
                target: BlueprintSelector::All,
                source: programmer_blueprint_source(source),
            })
        }
    }
}

/// Converts one explicit attribute-or-category action into a runtime operation.
fn programmer_operation_from_set_attribute(
    action: &ast::SetAttributeAst,
) -> Result<crate::events::ProgrammerAttributeOperation, String> {
    let target = match &action.target {
        ast::AttributeTargetAst::Attribute(attribute) => {
            BlueprintSelector::Attribute(attribute_type_ast_to_attribute(attribute))
        }
        ast::AttributeTargetAst::Category(category) => {
            BlueprintSelector::Category(attribute_category_from_ast(*category))
        }
    };
    let source = match &action.source {
        ast::AttributeValueSourceAst::Direct(value) => {
            let BlueprintSelector::Attribute(attribute) = &target else {
                return Err("direct values cannot target an attribute category".to_string());
            };
            crate::events::ProgrammerAttributeSource::Direct(
                conv::value_source_from_range_ast_for_attribute(value, attribute)
                    .map_err(|error| format!("value conversion: {error}"))?,
            )
        }
        ast::AttributeValueSourceAst::Blueprint(source) => programmer_blueprint_source(source),
    };
    Ok(crate::events::ProgrammerAttributeOperation { target, source })
}

/// Converts a parser Blueprint source while preserving address kind and resolution mode.
fn programmer_blueprint_source(
    source: &ast::BlueprintSourceAst,
) -> crate::events::ProgrammerAttributeSource {
    let address = match source.address {
        ast::BlueprintAddressAst::Id(id) => BlueprintAddress::Id(id),
        ast::BlueprintAddressAst::Label(label) => BlueprintAddress::Label(label.to_string()),
    };
    let resolution = match source.resolution {
        ast::BlueprintResolutionAst::Reference => BlueprintResolution::Reference,
        ast::BlueprintResolutionAst::Absolute => BlueprintResolution::Absolute,
    };
    crate::events::ProgrammerAttributeSource::Blueprint {
        address,
        resolution,
    }
}

/// Converts a parser category into the engine's canonical attribute category.
fn attribute_category_from_ast(category: ast::AttributeCategoryAst) -> AttributeCategory {
    match category {
        ast::AttributeCategoryAst::Dimmer => AttributeCategory::Dimmer,
        ast::AttributeCategoryAst::Position => AttributeCategory::Position,
        ast::AttributeCategoryAst::Gobo => AttributeCategory::Gobo,
        ast::AttributeCategoryAst::Color => AttributeCategory::Color,
        ast::AttributeCategoryAst::Beam => AttributeCategory::Beam,
        ast::AttributeCategoryAst::Focus => AttributeCategory::Focus,
        ast::AttributeCategoryAst::Control => AttributeCategory::Control,
        ast::AttributeCategoryAst::Other => AttributeCategory::Other,
    }
}
