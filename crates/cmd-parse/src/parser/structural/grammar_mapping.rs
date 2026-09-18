// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Structural expectation construction and grammar-rule mapping.

use super::*;

/// Returns the slot-offer candidates for one slot as parser expected tokens.
pub fn expected_tokens_for_slot(slot: SlotRef) -> Vec<ExpectedToken> {
    if slot.slot == SlotId::StoreFixtureOffsetKeyword {
        return vec![ExpectedToken::Literal("offset".into())];
    }
    let spec = slot_spec(slot.slot);
    let mut expected_tokens = spec
        .offers
        .tokens
        .iter()
        .copied()
        .map(ExpectedToken::Token)
        .collect::<Vec<_>>();

    if let Some(placeholder) = spec.offers.placeholder {
        push_expected_token(
            &mut expected_tokens,
            ExpectedToken::Placeholder(placeholder),
        );
        if placeholder == ValueKind::IdentifierExpression {
            push_expected_token(
                &mut expected_tokens,
                ExpectedToken::Placeholder(ValueKind::NumericDigit),
            );
        }
    }

    expected_tokens
}

/// Applies the slot's executable entry predicate to its advertised lexical alternatives.
pub(in crate::parser) fn initial_expected_tokens_for_slot(slot: SlotRef) -> Vec<ExpectedToken> {
    expected_tokens_for_slot(slot.clone())
        .into_iter()
        .filter(|expected| {
            let text = match expected {
                ExpectedToken::Token(token) => canonical_text(*token).unwrap_or_default(),
                ExpectedToken::Literal(text) => text.as_str(),
                ExpectedToken::Placeholder(ValueKind::Text) => "\"name\"",
                ExpectedToken::Placeholder(ValueKind::ColorPathReference) => "path0",
                ExpectedToken::Placeholder(_) => "0",
            };
            let tokens = crate::parser::lexer::lex_command(text);
            tokens
                .first()
                .is_some_and(|token| slot_accepts_initial_fill(slot.slot, token))
        })
        .collect()
}

/// Returns the shared frontier tokens that can begin a signed numeric value.
pub(in crate::parser) fn signed_numeric_expected_tokens() -> Vec<ExpectedToken> {
    vec![
        ExpectedToken::Placeholder(ValueKind::NumericDigit),
        ExpectedToken::Token(TokenId::Plus),
        ExpectedToken::Token(TokenId::Minus),
    ]
}

/// Returns the leading structural expectations for entering a clause.
pub fn expected_tokens_for_clause_entry(clause: ClauseId) -> Vec<ExpectedToken> {
    if clause == ClauseId::StepFxSelection {
        return vec![
            ExpectedToken::Token(TokenId::Fixture),
            ExpectedToken::Token(TokenId::Group),
        ];
    }
    leading_expected_tokens(&structural_clause_parser(clause))
}

/// Maps a root structural clause to the grammar rule used for diagnostics and completion.
pub(in crate::parser) fn root_rule_for_clause(clause: ClauseId) -> GrammarRuleId {
    match clause {
        ClauseId::Programmer => GrammarRuleId::SelectionCommand,
        ClauseId::Fx => GrammarRuleId::FxCommand,
        ClauseId::Patch => GrammarRuleId::PatchCommand,
        ClauseId::PatchSource | ClauseId::PatchTarget => GrammarRuleId::TransportName,
        ClauseId::Clip => GrammarRuleId::GeneralCommand,
        ClauseId::ChannelOverride => GrammarRuleId::DmxChannelExpression,
        ClauseId::Release => GrammarRuleId::ReleaseCommand,
        ClauseId::Clear => GrammarRuleId::ReleaseCommand,
        ClauseId::Flow => GrammarRuleId::FlowCommand,
        ClauseId::Timecode => GrammarRuleId::TimecodeCommand,
        ClauseId::Timeline => GrammarRuleId::TimelineCommand,
        ClauseId::Log => GrammarRuleId::LogCommands,
        ClauseId::Recall => GrammarRuleId::RecallCueCommand,
        ClauseId::Sleep => GrammarRuleId::SleepCommand,
        ClauseId::Fps => GrammarRuleId::SetFpsCommand,
        _ => GrammarRuleId::Command,
    }
}

/// Maps a structural slot and its active offers to the most specific grammar rule.
pub(in crate::parser) fn grammar_rule_for_slot(
    slot: SlotId,
    expected_tokens: &[ExpectedToken],
    fallback_clause: ClauseId,
) -> GrammarRuleId {
    match slot {
        SlotId::CommandHead => GrammarRuleId::Command,
        SlotId::SelectionType => GrammarRuleId::SelectionType,
        SlotId::SelectionIdentifier | SlotId::StepFxSelectionIdentifier => {
            GrammarRuleId::IdentifierExpression
        }
        SlotId::SetAttrAttribute
        | SlotId::TimingsOverrideAttribute
        | SlotId::StoreFixtureOffsetAttribute
        | SlotId::QualifierAttributeList => GrammarRuleId::AttributeType,
        SlotId::SetAttrValue => {
            if expected_tokens
                .iter()
                .any(|token| matches!(token, ExpectedToken::Placeholder(ValueKind::NumericDigit)))
            {
                GrammarRuleId::ValueRange
            } else {
                GrammarRuleId::SetAttribute
            }
        }
        SlotId::TimingsKeyword | SlotId::TimingsDirection => GrammarRuleId::TimingKeyword,
        SlotId::TimingsGlobalDuration
        | SlotId::TimingsOverrideDuration
        | SlotId::StepFxDuration => GrammarRuleId::DurationValue,
        SlotId::PlacementAction => GrammarRuleId::PlacementActions,
        SlotId::PlacementAxisValue => GrammarRuleId::FixturePlacementCommand,
        SlotId::FxIdentifier => GrammarRuleId::FxCommand,
        SlotId::FxAction | SlotId::StoreFxAction => GrammarRuleId::FxActions,
        SlotId::StepFxSelectionHead => GrammarRuleId::StepFxSelectionHead,
        SlotId::StepFxStepAttribute => GrammarRuleId::FxAttributeSteps,
        SlotId::StepFxAttributeBaseline | SlotId::StepFxStepValues => {
            if expected_tokens
                .iter()
                .any(|token| matches!(token, ExpectedToken::Placeholder(ValueKind::NumericDigit)))
            {
                GrammarRuleId::ValueRange
            } else {
                GrammarRuleId::FxStep
            }
        }
        SlotId::StepFxAttributeShaping => GrammarRuleId::CurveName,
        SlotId::RmObjectType
        | SlotId::RenameObjectType
        | SlotId::StoreObjectType
        | SlotId::DebugObjectType => GrammarRuleId::ObjectType,
        SlotId::ClipIdentifier
        | SlotId::FlowIdentifier
        | SlotId::TimecodeIdentifier
        | SlotId::TimelineIdentifier
        | SlotId::RenameSource
        | SlotId::RenameTarget
        | SlotId::StoreCueRef
        | SlotId::StoreObjectIdentifier
        | SlotId::StoreObjectPayload
        | SlotId::StoreGroupIdentifier
        | SlotId::StoreBlueprintIdentifier
        | SlotId::DebugObjectIdentifier
        | SlotId::RmObjectIdentifier
        | SlotId::RecallCueRef
        | SlotId::RecallBlueprintIdentifier => GrammarRuleId::SimpleIdentifierExpression,
        SlotId::StoreFixtureIdentifier => GrammarRuleId::IdentifierExpression,
        SlotId::ChannelOverrideValue | SlotId::StoreFixtureOffsetValue => GrammarRuleId::ValueRange,
        SlotId::PatchSourceEndpoint | SlotId::PatchTargetEndpoint => GrammarRuleId::TransportName,
        SlotId::ClipAction => GrammarRuleId::PlaybackActions,
        SlotId::FlowAction => GrammarRuleId::FlowActions,
        SlotId::TimecodeAction => GrammarRuleId::TimecodeActions,
        SlotId::TimelineAction => GrammarRuleId::TimelineActions,
        SlotId::LogLevel => GrammarRuleId::LogCommands,
        _ => root_rule_for_clause(fallback_clause),
    }
}

/// Collects the first reachable token offers from a parser and its required descendants.
pub(in crate::parser) fn leading_expected_tokens(
    parser: &StructuralClauseParser,
) -> Vec<ExpectedToken> {
    if let crate::slots::contracts::ClauseEntryKind::Keyword(tokens) =
        crate::slots::contracts::clause_schema(parser.clause).entry
    {
        return tokens.iter().copied().map(ExpectedToken::Token).collect();
    }
    let mut expected_tokens = Vec::new();

    for slot in parser.slots {
        for token in initial_expected_tokens_for_slot(SlotRef {
            slot: slot.slot,
            clause: Some(ClauseInstance {
                clause: parser.clause,
                instance: 0,
            }),
        }) {
            push_expected_token(&mut expected_tokens, token);
        }

        if matches!(
            slot.cardinality,
            crate::slots::contracts::SlotCardinality::Required
        ) {
            return expected_tokens;
        }
    }

    for child in &parser.children {
        for token in leading_expected_tokens(&child.parser) {
            push_expected_token(&mut expected_tokens, token);
        }

        if child.cardinality == ClauseCardinality::Required {
            return expected_tokens;
        }
    }

    expected_tokens
}

/// Returns the first required slot declared directly by a structural parser node.
pub(in crate::parser) fn first_required_slot(
    parser: &StructuralClauseParser,
) -> Option<ClauseSlotSpec> {
    parser.slots.iter().copied().find(|slot| {
        matches!(
            slot.cardinality,
            crate::slots::contracts::SlotCardinality::Required
        )
    })
}

/// Produces the canonical semantic surface for an inferred command head.
pub(in crate::parser) fn head_surface(context: &CommandPrefixContext, head: TokenId) -> SmolStr {
    let _ = context;
    canonical_text(head).unwrap_or_default().into()
}

/// Produces the source span occupied by an inferred canonical command head.
pub(in crate::parser) fn head_span(
    context: &CommandPrefixContext,
    head: TokenId,
) -> crate::parser::analysis::Span {
    let default_len = canonical_text(head).map_or(0, str::len);
    crate::parser::analysis::Span {
        start: context.segment_start,
        end: context.segment_start + default_len,
    }
}

/// Projects a clause entry to the concrete grammar slots that consume its initial token.
pub(in crate::parser) fn entry_slot_expectations(
    branch: &ParseBranchState<'_>,
    clause: ClauseId,
) -> Vec<ClauseExpectation> {
    let parser = structural_clause_parser(clause);
    if matches!(
        crate::slots::contracts::clause_schema(clause).entry,
        crate::slots::contracts::ClauseEntryKind::Keyword(_)
    ) {
        return vec![crate::parser::structural_expectation::clause_expectation(
            &parser, clause,
        )];
    }
    let instance = ClauseInstance {
        clause,
        instance: clause_parent(clause).map_or(0, |parent| {
            next_child_clause_instance(branch, parent, clause)
        }),
    };
    let mut expectations = Vec::new();
    for slot in parser.slots {
        let tokens = initial_expected_tokens_for_slot(SlotRef {
            slot: slot.slot,
            clause: Some(instance.clone()),
        });
        if !tokens.is_empty() {
            expectations.push(
                crate::parser::structural_expectation::filtered_slot_expectation(
                    &parser,
                    instance.clone(),
                    *slot,
                    tokens,
                ),
            );
        }
        if slot.cardinality == SlotCardinality::Required {
            return expectations;
        }
    }
    for child in &parser.children {
        expectations.extend(entry_slot_expectations(branch, child.parser.clause));
        if child.cardinality == ClauseCardinality::Required {
            break;
        }
    }
    expectations
}
