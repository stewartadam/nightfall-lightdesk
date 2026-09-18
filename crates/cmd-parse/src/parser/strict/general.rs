// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::branch_view::{
    merged_slot_span, merged_slot_span_without_prefix_tokens, shifted_range, slot_spans,
    slot_tokens, tokens_for_spans, tokens_in_span,
};
use super::context::StrictBranchContext;
use super::*;

fn significant_tokens(tokens: &[LexerToken]) -> Vec<&LexerToken> {
    tokens
        .iter()
        .filter(|token| token.kind != LexerTokenKind::Whitespace)
        .collect()
}

fn selection_or_object_alias_context() -> AliasCanonicalizationContext {
    AliasCanonicalizationContext {
        selection_or_object_context: true,
        ..AliasCanonicalizationContext::default()
    }
}

fn attribute_alias_context() -> AliasCanonicalizationContext {
    AliasCanonicalizationContext {
        attribute_context: true,
        ..AliasCanonicalizationContext::default()
    }
}

/// Parses a compact color path reference such as `path101` into a simple ID expression.
fn parse_compact_color_path_reference(token: &LexerToken) -> Option<SimpleIdentifierExpressionAst> {
    if token.kind != LexerTokenKind::Word {
        return None;
    }
    let text = token.text.as_str().to_ascii_lowercase();
    let id_text = text.strip_prefix("path")?;
    if id_text.is_empty() {
        return None;
    }
    Some(SimpleIdentifierExpressionAst {
        head: SimpleTermAst::Single(SimpleIdAst {
            id: id_text.parse().ok()?,
        }),
        tail: Vec::new(),
    })
}

pub(super) fn parse_object_type_token(token: &LexerToken) -> Option<ObjectTypeAst> {
    match canonical_word(token, selection_or_object_alias_context())?.as_str() {
        "fx" => Some(ObjectTypeAst::Fx),
        "flow" => Some(ObjectTypeAst::Flow),
        "fixture" => Some(ObjectTypeAst::Fixture),
        "parameter" => Some(ObjectTypeAst::Parameter),
        "group" => Some(ObjectTypeAst::Group),
        "clip" => Some(ObjectTypeAst::Clip),
        "cue" => Some(ObjectTypeAst::Cue),
        "sequence" => Some(ObjectTypeAst::Sequence),
        "timecode" => Some(ObjectTypeAst::Timecode),
        "timeline" => Some(ObjectTypeAst::Timeline),
        "blueprint" => Some(ObjectTypeAst::Blueprint),
        "path" | "colorpath" | "colourpath" | "color_path" | "colour_path" | "color-path"
        | "colour-path" => Some(ObjectTypeAst::ColorPath),
        _ => None,
    }
}

/// Parses the assignable target object family in `set ... target=<kind> <id>` commands.
fn parse_set_target_type_text(text: &str) -> Option<SetObjectTargetTypeAst> {
    match text.to_ascii_lowercase().replace(['-', '_'], "").as_str() {
        "sequence" | "seq" => Some(SetObjectTargetTypeAst::Sequence),
        "fx" => Some(SetObjectTargetTypeAst::Fx),
        "stepfx" => Some(SetObjectTargetTypeAst::StepFx),
        "fxmodule" | "modulefx" => Some(SetObjectTargetTypeAst::FxModule),
        "flow" | "flowfx" | "graphfx" => Some(SetObjectTargetTypeAst::Flow),
        _ => None,
    }
}

/// Parses a color path ID token or a clear sentinel.
fn parse_color_path_assignment_token(token: &LexerToken) -> Option<Option<u32>> {
    if let Some(word) = canonical_word(token, AliasCanonicalizationContext::default()) {
        if matches!(word.as_str(), "clear" | "none" | "off") {
            return Some(None);
        }
    }
    token.text.parse::<u32>().ok().map(Some)
}

pub(super) fn parse_log_attribute<'i>(
    command_str: &'i str,
    token: &LexerToken,
) -> Option<AttributeTypeAst<'i>> {
    if token.kind == LexerTokenKind::QuotedString {
        return Some(AttributeTypeAst::Quoted(
            &command_str[token.span.start..token.span.end],
        ));
    }

    let canonical = canonical_word(token, attribute_alias_context())?;
    let alias = match canonical.as_str() {
        "int" => Some(AttributeAliasAst::Intensity),
        "red" => Some(AttributeAliasAst::Red),
        "green" => Some(AttributeAliasAst::Green),
        "blue" => Some(AttributeAliasAst::Blue),
        "white" => Some(AttributeAliasAst::White),
        _ => None,
    };
    if let Some(alias) = alias {
        return Some(AttributeTypeAst::Aliased(alias));
    }

    validate_attribute_surface(
        attribute_parse_spec(AttributeParseSpecId::Standard),
        token.text.as_str(),
    )
    .ok()?;
    Some(AttributeTypeAst::Other(
        &command_str[token.span.start..token.span.end],
    ))
}

/// Parses lightweight fixture, group, and parameter selection commands before strict fallback.
pub(super) fn parse_simple_selection_command<'i>(command_str: &'i str) -> Option<CommandAst<'i>> {
    let tokens = lex_command(command_str);
    parse_simple_selection_command_from_tokens(command_str, &tokens)
}

pub(super) fn parse_simple_selection_command_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[LexerToken],
) -> Option<CommandAst<'i>> {
    let significant = significant_tokens(tokens);
    let (head, ids) = significant.split_first()?;
    let selection_type = match canonical_word(head, selection_or_object_alias_context())?.as_str() {
        canonical if canonical == canonical_token_text(TokenId::Fixture) => {
            SelectionTypeAst::Fixture
        }
        canonical if canonical == canonical_token_text(TokenId::Parameter) => {
            SelectionTypeAst::Parameter
        }
        canonical if canonical == canonical_token_text(TokenId::Group) => SelectionTypeAst::Group,
        _ => return None,
    };

    let ids = match selection_type {
        SelectionTypeAst::Fixture => parse_identifier_expression_from_tokens(command_str, ids)?,
        SelectionTypeAst::Group | SelectionTypeAst::Parameter => identifier_expression_from_simple(
            parse_simple_identifier_expression_from_tokens(command_str, ids)?,
        ),
    };

    Some(CommandAst::Selection(SelectionCommandAst {
        source: command_str.trim(),
        selection: SelectionAst {
            selection_type,
            ids,
        },
    }))
}

pub(super) fn materialize_fps_ast<'i>(ctx: StrictBranchContext<'i, '_>) -> Option<CommandAst<'i>> {
    let span = merged_slot_span(ctx.branch, crate::slots::contracts::SlotId::FpsValue)?;
    Some(CommandAst::General(GeneralCommandAst::SetFps(
        SetFpsCommandAst {
            fps: IntegerAst(&ctx.command_str[span]),
        },
    )))
}

pub(super) fn materialize_sleep_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let span = merged_slot_span(ctx.branch, crate::slots::contracts::SlotId::SleepDuration)?;
    let surface = &ctx.command_str[span.clone()];
    let parsed = parse_duration_value_slice(surface)?;
    let value_span = shifted_range(&span, parsed.value);
    let unit = parsed
        .unit
        .map(|unit_span| DurationUnitAst(&ctx.command_str[shifted_range(&span, unit_span)]));

    Some(CommandAst::General(GeneralCommandAst::Sleep(
        SleepCommandAst {
            duration: DurationValueAst {
                value: ValueAst(&ctx.command_str[value_span]),
                unit,
            },
        },
    )))
}

pub(super) fn materialize_log_ast<'i>(ctx: StrictBranchContext<'i, '_>) -> Option<CommandAst<'i>> {
    let lowered = ctx.command_str.trim().to_ascii_lowercase();
    let committed = ctx.branch.committed_clause_path();
    if committed
        .iter()
        .any(|clause| clause.clause == ClauseId::LogLevel)
        && lowered.starts_with("log level ")
    {
        let level = merged_slot_span_without_prefix_tokens(
            ctx.command_str,
            ctx.branch,
            crate::slots::contracts::SlotId::LogLevel,
            &[crate::parser::analysis::TokenId::Level],
        )
        .or_else(|| merged_slot_span(ctx.branch, crate::slots::contracts::SlotId::LogLevel))?;
        return Some(CommandAst::General(GeneralCommandAst::Log(
            LogCommandsAst {
                command: LogCommandAst::Level(LogLevelCommandAst {
                    level: LogLevelAst(&ctx.command_str[level]),
                }),
            },
        )));
    }

    if committed
        .iter()
        .any(|clause| clause.clause == ClauseId::LogFilter)
        && lowered.starts_with("log filter ")
    {
        let field_span = merged_slot_span_without_prefix_tokens(
            ctx.command_str,
            ctx.branch,
            crate::slots::contracts::SlotId::LogFilterField,
            &[crate::parser::analysis::TokenId::Filter],
        );
        let value_tokens = slot_tokens(
            ctx.tokens,
            ctx.branch,
            crate::slots::contracts::SlotId::LogFilterValue,
        );
        let (field, value) = match field_span {
            Some(field) => {
                let value = value_tokens
                    .first()
                    .zip(value_tokens.last())
                    .map(|(first, last)| first.span.start..last.span.end);
                (field, value)
            }
            None => {
                let field = value_tokens.first()?.span.start..value_tokens.first()?.span.end;
                let value = value_tokens
                    .get(1)
                    .zip(value_tokens.last())
                    .map(|(first, last)| first.span.start..last.span.end);
                (field, value)
            }
        };
        let field_text = &ctx.command_str[field.clone()];
        let filter = if field_text.eq_ignore_ascii_case("clear") && value.is_none() {
            LogFilterCommandAst::Clear(ClearSpanFilterAst)
        } else {
            let value = value.map(|value| SpanFieldValueAst {
                value: WordAst(&ctx.command_str[value]),
            });
            LogFilterCommandAst::Set(SetSpanFilterAst {
                field: SpanFieldNameAst {
                    name: WordAst(field_text),
                },
                value,
            })
        };
        return Some(CommandAst::General(GeneralCommandAst::Log(
            LogCommandsAst {
                command: LogCommandAst::Filter(LogFilterCommandsAst { filter }),
            },
        )));
    }

    if committed
        .iter()
        .any(|clause| clause.clause == ClauseId::LogFixture)
        && lowered.starts_with("log ")
    {
        let id_tokens = match slot_tokens(
            ctx.tokens,
            ctx.branch,
            crate::slots::contracts::SlotId::LogFixtureIdentifier,
        )
        .as_slice()
        {
            [] => return None,
            [token] => vec![*token],
            [_, value_token, ..] => vec![*value_token],
        };
        let id = parse_single_id_from_tokens(ctx.command_str, &id_tokens)?;
        let attribute_token = slot_tokens(
            ctx.tokens,
            ctx.branch,
            crate::slots::contracts::SlotId::LogFixtureAttribute,
        )
        .into_iter()
        .last()?;
        let attribute = parse_log_attribute(ctx.command_str, attribute_token)?;
        return Some(CommandAst::General(GeneralCommandAst::Log(
            LogCommandsAst {
                command: LogCommandAst::Fixture(LogFixtureCommandAst { id, attribute }),
            },
        )));
    }

    None
}

/// Convert a completed store branch into the corresponding object store command.
pub(super) fn materialize_store_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let object_type = parse_object_type_from_tokens(&slot_tokens(
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::StoreObjectType,
    ))?;
    match object_type {
        ObjectTypeAst::Cue => {
            let mut store_target_tokens = slot_tokens(
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::StoreCueRef,
            );
            store_target_tokens.extend(slot_tokens(
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::StoreMode,
            ));
            let (target, mode) =
                parse_store_cue_target_and_mode_from_tokens(ctx.command_str, &store_target_tokens)?;
            Some(CommandAst::General(GeneralCommandAst::StoreCue(
                StoreCueCommandAst {
                    _cue: CueKeyword,
                    target,
                    mode,
                },
            )))
        }
        ObjectTypeAst::Clip => {
            let id = parse_slot_identifier_expression_from_tokens(
                ctx.command_str,
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::StoreObjectIdentifier,
            )?;
            Some(CommandAst::General(GeneralCommandAst::StoreClip(
                StoreClipCommandAst {
                    _clip: ClipKeyword,
                    id,
                },
            )))
        }
        ObjectTypeAst::Flow => {
            let id = parse_slot_identifier_expression_from_tokens(
                ctx.command_str,
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::StoreObjectIdentifier,
            )?;
            Some(CommandAst::General(GeneralCommandAst::StoreFlow(
                StoreFlowCommandAst {
                    _flow: FlowKeyword,
                    id,
                    payload: merged_slot_span(
                        ctx.branch,
                        crate::slots::contracts::SlotId::StoreObjectPayload,
                    )
                    .map(|span| QuotedStringAst(&ctx.command_str[span])),
                },
            )))
        }
        ObjectTypeAst::Timecode => {
            let id = parse_slot_identifier_expression_from_tokens(
                ctx.command_str,
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::StoreObjectIdentifier,
            )?;
            Some(CommandAst::General(GeneralCommandAst::StoreTimecode(
                StoreTimecodeCommandAst {
                    _timecode: TimecodeKeyword,
                    id,
                },
            )))
        }
        ObjectTypeAst::Timeline => {
            let id = parse_slot_identifier_expression_from_tokens(
                ctx.command_str,
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::StoreObjectIdentifier,
            )?;
            Some(CommandAst::General(GeneralCommandAst::StoreTimeline(
                StoreTimelineCommandAst {
                    _timeline: TimelineKeyword,
                    id,
                },
            )))
        }
        ObjectTypeAst::Fx => super::fx::materialize_store_step_fx_ast(ctx)
            .or_else(|| super::fx::materialize_store_fx_module_ast(ctx)),
        ObjectTypeAst::Group => {
            let id = parse_slot_identifier_expression_from_tokens(
                ctx.command_str,
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::StoreGroupIdentifier,
            )?;
            Some(CommandAst::General(GeneralCommandAst::StoreGroup(
                StoreGroupCommandAst {
                    _group: GroupKeyword,
                    id,
                },
            )))
        }
        ObjectTypeAst::Fixture => {
            let id = parse_identifier_expression_from_tokens(
                ctx.command_str,
                &slot_tokens(
                    ctx.tokens,
                    ctx.branch,
                    crate::slots::contracts::SlotId::StoreFixtureIdentifier,
                ),
            )?;

            if let (Some(attribute_span), Some(value_span)) = (
                merged_slot_span(
                    ctx.branch,
                    crate::slots::contracts::SlotId::StoreFixtureOffsetAttribute,
                ),
                merged_slot_span(
                    ctx.branch,
                    crate::slots::contracts::SlotId::StoreFixtureOffsetValue,
                ),
            ) {
                let attribute = parse_attribute_type_from_tokens(
                    ctx.command_str,
                    &tokens_in_span(ctx.tokens, attribute_span.clone()),
                    AttributeParseSpecId::Standard,
                )?;
                return Some(CommandAst::General(GeneralCommandAst::StoreFixtureOffset(
                    StoreFixtureOffsetCommandAst {
                        _fixture: FixtureKeyword,
                        id,
                        attribute,
                        value: parse_offset_value_from_tokens(
                            ctx.command_str,
                            &tokens_in_span(ctx.tokens, value_span),
                        )?,
                    },
                )));
            }

            let make_span = merged_slot_span(
                ctx.branch,
                crate::slots::contracts::SlotId::StoreFixtureMake,
            )?;
            let model_span = merged_slot_span(
                ctx.branch,
                crate::slots::contracts::SlotId::StoreFixtureModel,
            )?;
            let mode_span = merged_slot_span(
                ctx.branch,
                crate::slots::contracts::SlotId::StoreFixtureMode,
            )?;
            Some(CommandAst::General(GeneralCommandAst::StoreFixture(
                StoreFixtureCommandAst {
                    _fixture: FixtureKeyword,
                    id,
                    make: QuotedStringAst(&ctx.command_str[make_span]),
                    model: QuotedStringAst(&ctx.command_str[model_span]),
                    mode: WordAst(&ctx.command_str[mode_span]),
                },
            )))
        }
        ObjectTypeAst::Blueprint => {
            let id = parse_slot_identifier_expression_from_tokens(
                ctx.command_str,
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::StoreBlueprintIdentifier,
            )?;
            let filter_spans = slot_spans(
                ctx.branch,
                crate::slots::contracts::SlotId::QualifierAttributeList,
            );
            let filter = parse_attribute_types_from_tokens(
                ctx.command_str,
                &tokens_for_spans(ctx.tokens, &filter_spans),
                AttributeParseSpecId::Standard,
            )
            .unwrap_or_default();

            Some(CommandAst::General(GeneralCommandAst::StoreBlueprint(
                StoreBlueprintCommandAst {
                    _blueprint: BlueprintKeyword,
                    id,
                    filter,
                },
            )))
        }
        _ => None,
    }
}

pub(super) fn materialize_release_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    if ctx
        .branch
        .consumed_items
        .iter()
        .any(|item| item.slot.slot == crate::slots::contracts::SlotId::ReleaseStaleKeyword)
    {
        ctx.branch
            .consumed_items
            .iter()
            .find(|item| item.slot.slot == crate::slots::contracts::SlotId::ReleaseInputsKeyword)?;
        return Some(CommandAst::General(GeneralCommandAst::Release(
            ReleaseCommandAst {
                target: Some(ReleaseTargetAst::StaleInputs),
            },
        )));
    }
    let committed = ctx.branch.committed_clause_path();
    let attributes = if committed
        .iter()
        .any(|clause| clause.clause == ClauseId::ReleaseAttributes)
    {
        let attribute_spans = slot_spans(
            ctx.branch,
            crate::slots::contracts::SlotId::QualifierAttributeList,
        );
        let attributes = parse_attribute_types_from_tokens(
            ctx.command_str,
            &tokens_for_spans(ctx.tokens, &attribute_spans),
            AttributeParseSpecId::Standard,
        )?;
        if attributes.is_empty() {
            return None;
        }
        Some(AttributeQualifierAst {
            _attr: AttributeKeyword,
            attributes,
        })
    } else {
        None
    };

    if let Some(channel_span) = merged_slot_span(
        ctx.branch,
        crate::slots::contracts::SlotId::ReleaseChannelExpr,
    ) {
        let channel_tokens = tokens_in_span(ctx.tokens, channel_span.clone());
        let target = if matches!(
            channel_tokens
                .first()
                .and_then(|token| canonical_word(token, selection_or_object_alias_context()))
                .as_deref(),
            Some("channel")
        ) {
            if attributes.is_some() {
                return None;
            }
            let channels = parse_release_dmx_channel_expression_from_tokens(&channel_tokens[1..])?;
            ReleaseTargetAst::Dmx(ReleaseDmxTargetAst {
                _channel: ReleaseChannelKeyword,
                channels,
            })
        } else {
            let selection = parse_selection_from_tokens(ctx.command_str, &channel_tokens)?;
            match selection.selection_type {
                SelectionTypeAst::Fixture => ReleaseTargetAst::Fixture(ReleaseFixtureTargetAst {
                    selection: parse_fixture_selection_from_tokens(
                        ctx.command_str,
                        &channel_tokens,
                    )?,
                    attributes,
                }),
                _ => {
                    if attributes.is_some() {
                        return None;
                    }
                    ReleaseTargetAst::Selection(selection)
                }
            }
        };

        return Some(CommandAst::General(GeneralCommandAst::Release(
            ReleaseCommandAst {
                target: Some(target),
            },
        )));
    }

    let target = attributes
        .map(|attributes| ReleaseTargetAst::Attribute(ReleaseAttributeTargetAst { attributes }));
    Some(CommandAst::General(GeneralCommandAst::Release(
        ReleaseCommandAst { target },
    )))
}

pub(super) fn materialize_clear_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let committed = ctx.branch.committed_clause_path();
    let target_spans = slot_spans(ctx.branch, crate::slots::contracts::SlotId::ClearTarget);
    let attribute_spans = slot_spans(
        ctx.branch,
        crate::slots::contracts::SlotId::QualifierAttributeList,
    );
    if target_spans.is_empty() && attribute_spans.is_empty() {
        return Some(CommandAst::General(GeneralCommandAst::Clear(
            ClearCommandAst {
                targets: Vec::new(),
            },
        )));
    }
    let target_tokens = tokens_for_spans(ctx.tokens, &target_spans);

    let targets = if committed
        .iter()
        .any(|clause| clause.clause == ClauseId::ClearAttributes)
        || !attribute_spans.is_empty()
    {
        let attributes = parse_attribute_types_from_tokens(
            ctx.command_str,
            &tokens_for_spans(ctx.tokens, &attribute_spans),
            AttributeParseSpecId::Standard,
        )?;
        if attributes.is_empty() {
            return None;
        }
        let qualifier = AttributeQualifierAst {
            _attr: AttributeKeyword,
            attributes,
        };
        if target_tokens.is_empty() {
            return Some(CommandAst::General(GeneralCommandAst::Clear(
                ClearCommandAst {
                    targets: vec![ClearTargetAst::Attribute(ClearAttributeTargetAst {
                        attributes: qualifier,
                    })],
                },
            )));
        }
        let first_target_surface = target_tokens.first().map(|token| token.text.as_str())?;
        if matches!(
            first_target_surface.to_ascii_lowercase().as_str(),
            "attr" | "attribute"
        ) {
            vec![ClearTargetAst::Attribute(ClearAttributeTargetAst {
                attributes: qualifier,
            })]
        } else {
            let selection = parse_fixture_selection_from_tokens(ctx.command_str, &target_tokens)?;
            vec![ClearTargetAst::Fixture(ClearFixtureTargetAst {
                selection,
                attributes: Some(qualifier),
            })]
        }
    } else if !target_tokens.is_empty() {
        let first_target_surface = target_tokens.first().map(|token| token.text.as_str())?;
        if matches!(
            first_target_surface.to_ascii_lowercase().as_str(),
            "attr" | "attribute"
        ) {
            let attributes = parse_attribute_types_from_tokens(
                ctx.command_str,
                &target_tokens[1..],
                AttributeParseSpecId::Standard,
            )?;
            vec![ClearTargetAst::Attribute(ClearAttributeTargetAst {
                attributes: AttributeQualifierAst {
                    _attr: AttributeKeyword,
                    attributes,
                },
            })]
        } else if let Some(selection) =
            parse_fixture_selection_from_tokens(ctx.command_str, &target_tokens)
        {
            vec![ClearTargetAst::Fixture(ClearFixtureTargetAst {
                selection,
                attributes: None,
            })]
        } else {
            target_tokens
                .into_iter()
                .map(|token| {
                    if matches!(
                        token.text.to_ascii_lowercase().as_str(),
                        "selection" | "sel"
                    ) {
                        Some(ClearTargetAst::Selection(ClearSelectionAst))
                    } else if crate::lexicon::tokens::token_id_for_text(token.text.as_str())
                        == Some(TokenId::Values)
                    {
                        Some(ClearTargetAst::Values(ClearValuesAst))
                    } else {
                        None
                    }
                })
                .collect::<Option<Vec<_>>>()?
        }
    } else {
        return None;
    };

    Some(CommandAst::General(GeneralCommandAst::Clear(
        ClearCommandAst { targets },
    )))
}

pub(super) fn materialize_recall_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let blueprint_address_tokens = slot_tokens(
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::RecallBlueprintIdentifier,
    );
    if !blueprint_address_tokens.is_empty() {
        let mut source_tokens = blueprint_address_tokens;
        source_tokens.extend(slot_tokens(
            ctx.tokens,
            ctx.branch,
            crate::slots::contracts::SlotId::RecallBlueprintResolution,
        ));
        let source = parse_recall_blueprint_source_from_tokens(ctx.command_str, &source_tokens)?;
        return Some(CommandAst::General(GeneralCommandAst::RecallBlueprint(
            RecallBlueprintCommandAst {
                _blueprint: BlueprintKeyword,
                source,
            },
        )));
    }

    let mut recall_tokens = slot_tokens(
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::RecallCueRef,
    );
    if recall_tokens.first().is_some_and(|token| {
        canonical_word(token, selection_or_object_alias_context()).as_deref()
            == Some(canonical_token_text(TokenId::Cue))
    }) {
        recall_tokens.remove(0);
    }
    recall_tokens.extend(slot_tokens(
        ctx.tokens,
        ctx.branch,
        crate::slots::contracts::SlotId::RecallSelectFlag,
    ));
    let (cue_ref, part_id, select) =
        parse_recall_cue_target_from_tokens(ctx.command_str, &recall_tokens)?;
    Some(CommandAst::General(GeneralCommandAst::RecallCue(
        RecallCueCommandAst {
            _cue: CueKeyword,
            cue_ref,
            part_id,
            select,
        },
    )))
}

/// Parses one Blueprint recall address followed by an optional `/absolute` modifier.
fn parse_recall_blueprint_source_from_tokens<'i>(
    command_str: &'i str,
    tokens: &[&LexerToken],
) -> Option<BlueprintSourceAst<'i>> {
    let [address, tail @ ..] = tokens else {
        return None;
    };
    let address = parse_blueprint_address_from_token(command_str, address)?;
    let resolution = match tail {
        [] => BlueprintResolutionAst::Reference,
        [modifier] if modifier.text.eq_ignore_ascii_case("/absolute") => {
            BlueprintResolutionAst::Absolute
        }
        _ => return None,
    };
    Some(BlueprintSourceAst {
        address,
        resolution,
    })
}

pub(super) fn materialize_general_object_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    let committed = ctx.branch.committed_clause_path();
    let root = committed.first()?.clause;
    match root {
        ClauseId::Rm => {
            let object_type = parse_object_type_from_tokens(&slot_tokens(
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::RmObjectType,
            ))?;
            match object_type {
                ObjectTypeAst::Cue => {
                    let cue_ref = parse_cue_ref_from_tokens(
                        ctx.command_str,
                        &slot_tokens(
                            ctx.tokens,
                            ctx.branch,
                            crate::slots::contracts::SlotId::RmObjectIdentifier,
                        ),
                    )?;
                    Some(CommandAst::General(GeneralCommandAst::DeleteCue(
                        DeleteCueCommandAst {
                            _cue: CueKeyword,
                            cue_ref,
                        },
                    )))
                }
                _ => {
                    let id = parse_slot_identifier_expression_from_tokens(
                        ctx.command_str,
                        ctx.tokens,
                        ctx.branch,
                        crate::slots::contracts::SlotId::RmObjectIdentifier,
                    )?;
                    Some(CommandAst::General(GeneralCommandAst::Delete(
                        DeleteCommandAst { object_type, id },
                    )))
                }
            }
        }
        ClauseId::Rename => {
            let compact = slot_tokens(
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::CompactPathSource,
            );
            if let Some(source) = compact.first() {
                let targets = slot_tokens(
                    ctx.tokens,
                    ctx.branch,
                    crate::slots::contracts::SlotId::CompactPathTarget,
                );
                let from = parse_compact_color_path_reference(source)?;
                let to = parse_compact_color_path_reference(targets.first()?)?;
                return Some(CommandAst::General(GeneralCommandAst::Rename(
                    RenameCommandAst {
                        object_type: ObjectTypeAst::ColorPath,
                        from,
                        to,
                    },
                )));
            }
            let object_type = parse_object_type_from_tokens(&slot_tokens(
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::RenameObjectType,
            ))?;
            if object_type == ObjectTypeAst::Cue {
                let from = parse_cue_ref_from_tokens(
                    ctx.command_str,
                    &slot_tokens(
                        ctx.tokens,
                        ctx.branch,
                        crate::slots::contracts::SlotId::RenameSource,
                    ),
                )?;
                let to = parse_cue_ref_from_tokens(
                    ctx.command_str,
                    &slot_tokens(
                        ctx.tokens,
                        ctx.branch,
                        crate::slots::contracts::SlotId::RenameTarget,
                    ),
                )?;
                return Some(CommandAst::General(GeneralCommandAst::RenameCue(
                    RenameCueCommandAst {
                        _cue: CueKeyword,
                        from,
                        to,
                    },
                )));
            }
            let from = parse_slot_identifier_expression_from_tokens(
                ctx.command_str,
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::RenameSource,
            )?;
            let to = parse_slot_identifier_expression_from_tokens(
                ctx.command_str,
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::RenameTarget,
            )?;
            Some(CommandAst::General(GeneralCommandAst::Rename(
                RenameCommandAst {
                    object_type,
                    from,
                    to,
                },
            )))
        }
        ClauseId::Debug => {
            let object_type = parse_object_type_from_tokens(&slot_tokens(
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::DebugObjectType,
            ))?;
            let id = parse_slot_identifier_expression_from_tokens(
                ctx.command_str,
                ctx.tokens,
                ctx.branch,
                crate::slots::contracts::SlotId::DebugObjectIdentifier,
            )?;
            Some(CommandAst::General(GeneralCommandAst::Debug(
                DebugCommandAst { object_type, id },
            )))
        }
        _ => None,
    }
}

/// Builds general command ASTs from their grammar-selected command head and argument slot.
pub(super) fn materialize_utility_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    use crate::slots::contracts::SlotId;
    let head = ctx
        .branch
        .consumed_items
        .iter()
        .find(|item| item.slot.slot == SlotId::CommandHead)?;
    let name = merged_slot_span(ctx.branch, SlotId::ShowfileName)
        .map(|span| WordAst(&ctx.command_str[span]));
    let command = match crate::lexicon::tokens::token_id_for_text(head.surface.as_str())? {
        TokenId::Save => GeneralCommandAst::Save(SaveCommandAst { name }),
        TokenId::Load => GeneralCommandAst::Load(LoadCommandAst { name }),
        TokenId::New
            if ctx
                .branch
                .consumed_items
                .iter()
                .any(|item| item.slot.slot == SlotId::NewShowfileType) =>
        {
            GeneralCommandAst::NewShowfile(NewShowfileCommandAst)
        }
        TokenId::Help => GeneralCommandAst::Help(HelpCommandAst),
        TokenId::Quit => GeneralCommandAst::Quit(QuitCommandAst),
        TokenId::Undo => GeneralCommandAst::Undo(UndoCommandAst),
        TokenId::Redo => GeneralCommandAst::Redo(RedoCommandAst),
        _ => return None,
    };
    Some(CommandAst::General(command))
}

/// Builds cue tracking commands from the same cue-reference clause used during authoring.
pub(super) fn materialize_cue_block_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    use crate::slots::contracts::SlotId;
    let target = slot_tokens(ctx.tokens, ctx.branch, SlotId::RecallCueRef);
    let (_, target) = target.split_first()?;
    let (cue_ref, part_id) = parse_cue_part_ref_from_tokens(ctx.command_str, target)?;
    let operation = if ctx.branch.consumed_items.iter().any(|item| {
        item.slot.slot == SlotId::CommandHead && item.surface.eq_ignore_ascii_case("unblock")
    }) {
        BlockCueOperationAst::Unblock
    } else {
        BlockCueOperationAst::Block
    };
    let overwrite = ctx
        .branch
        .consumed_items
        .iter()
        .any(|item| item.slot.slot == SlotId::CueOverwrite);
    Some(CommandAst::General(GeneralCommandAst::BlockCue(
        BlockCueCommandAst {
            _cue: CueKeyword,
            cue_ref,
            part_id,
            operation,
            overwrite,
        },
    )))
}

/// Constructs color-path commands from their parser-owned identifier, value, and label slots.
pub(super) fn materialize_color_path_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    use crate::slots::contracts::SlotId;
    let root = ctx.branch.committed_clause_path().first()?.clause;
    let command = match root {
        ClauseId::Store => {
            let id = parse_slot_identifier_expression_from_tokens(
                ctx.command_str,
                ctx.tokens,
                ctx.branch,
                SlotId::PathIdentifier,
            )?;
            let label = merged_slot_span(ctx.branch, SlotId::LabelText)
                .map(|span| WordAst(&ctx.command_str[span]));
            if !slot_tokens(ctx.tokens, ctx.branch, SlotId::LabelKeyword).is_empty()
                && label.is_none()
            {
                return None;
            }
            GeneralCommandAst::StoreColorPath(StoreColorPathCommandAst { id, label })
        }
        ClauseId::CopyColorPath => {
            let id = parse_slot_identifier_expression_from_tokens(
                ctx.command_str,
                ctx.tokens,
                ctx.branch,
                SlotId::RenameSource,
            )?;
            let new_id = parse_slot_identifier_expression_from_tokens(
                ctx.command_str,
                ctx.tokens,
                ctx.branch,
                SlotId::RenameTarget,
            )?;
            GeneralCommandAst::DuplicateColorPath(DuplicateColorPathCommandAst { id, new_id })
        }
        ClauseId::CueColorPath | ClauseId::Programmer => {
            let values = slot_tokens(ctx.tokens, ctx.branch, SlotId::PathValue);
            let [value] = values.as_slice() else {
                return None;
            };
            let color_path_id = parse_color_path_assignment_token(value)?;
            if root == ClauseId::CueColorPath {
                let cue_ref = parse_cue_ref_from_tokens(
                    ctx.command_str,
                    &slot_tokens(ctx.tokens, ctx.branch, SlotId::StoreCueRef),
                )?;
                GeneralCommandAst::SetCueColorPath(SetCueColorPathCommandAst {
                    _cue: CueKeyword,
                    cue_ref,
                    color_path_id,
                })
            } else {
                let id = parse_identifier_expression_from_tokens(
                    ctx.command_str,
                    &slot_tokens(ctx.tokens, ctx.branch, SlotId::SelectionIdentifier),
                )?;
                GeneralCommandAst::SetFixtureColorPath(SetFixtureColorPathCommandAst {
                    _fixture: FixtureKeyword,
                    id,
                    color_path_id,
                })
            }
        }
        _ => return None,
    };
    Some(CommandAst::General(command))
}

/// Builds a target assignment exclusively from slots consumed by its grammar branch.
pub(super) fn materialize_object_property_ast<'i>(
    ctx: StrictBranchContext<'i, '_>,
) -> Option<CommandAst<'i>> {
    use crate::slots::contracts::SlotId;
    let object_tokens = slot_tokens(ctx.tokens, ctx.branch, SlotId::PropertyObjectType);
    let object_type = parse_object_type_token(object_tokens.first()?)?;
    let id = parse_simple_identifier_expression_from_tokens(
        ctx.command_str,
        &slot_tokens(ctx.tokens, ctx.branch, SlotId::PropertyObjectIdentifier),
    )?;
    let property = slot_tokens(ctx.tokens, ctx.branch, SlotId::PropertyKeyword);
    if property.len() != 1 {
        return None;
    }
    let target_tokens = slot_tokens(ctx.tokens, ctx.branch, SlotId::PropertyTargetType);
    let target_type = parse_set_target_type_text(target_tokens.first()?.text.as_str())?;
    let target_id = parse_simple_identifier_expression_from_tokens(
        ctx.command_str,
        &slot_tokens(ctx.tokens, ctx.branch, SlotId::PropertyTargetIdentifier),
    )?;
    Some(CommandAst::General(GeneralCommandAst::SetObjectProperty(
        SetObjectPropertyCommandAst {
            object_type,
            id,
            property: SetObjectPropertyAst::Target,
            target: SetObjectPropertyTargetAst {
                object_type: target_type,
                id: target_id,
            },
        },
    )))
}
