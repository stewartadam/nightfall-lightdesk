// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Cross-layer contracts that keep completion a projection of parser-owned state.

use nightfall_cmd_parse::autocomplete::complete_command;
use nightfall_cmd_parse::parser::analysis::{ExpectedToken, TokenId};
use serde_json::Value;

/// Baseline value prefixes stay open through signs and expose source-local Blueprint resolution.
#[test]
fn step_fx_baseline_frontiers_match_completed_sources() {
    for attribute in ["int", "pan"] {
        let prefix = format!("store fx 1 step fix 1 5s {attribute} @ -");
        let response = complete_command(&prefix, prefix.len());
        assert!(
            response
                .candidates
                .iter()
                .any(|candidate| matches!(candidate.expected, ExpectedToken::Placeholder(_)))
        );
        assert!(nightfall_cmd_parse::generate_ast(&format!("{prefix}50 steps ~25")).is_ok());
    }
    let prefix = "store fx 8 step fix 1 5s pan @ bp 10";
    let response = complete_command(prefix, prefix.len());
    let absolute = response
        .candidates
        .iter()
        .find(|candidate| candidate.insert_text == "/absolute")
        .expect("Blueprint baseline permits source-local resolution");
    assert_eq!(absolute.replace.start, prefix.len());
    let command = format!("{prefix}{}steps ~25", absolute.apply_text);
    assert!(
        nightfall_cmd_parse::generate_ast(&command).is_ok(),
        "{command}"
    );
}

/// FPS accepts one signed integer and never advertises a fractional or second numeric operand.
#[test]
fn fps_integer_frontier_matches_strict_consumption() {
    for input in ["fps 120", "fps +120", "fps -120"] {
        assert!(nightfall_cmd_parse::generate_ast(input).is_ok(), "{input}");
        let committed = format!("{input} ");
        assert!(
            complete_command(&committed, committed.len())
                .candidates
                .is_empty(),
            "{input}"
        );
    }
    for input in ["fps .5", "fps 1.5", "fps 1 2", "fps + 120"] {
        assert!(nightfall_cmd_parse::generate_ast(input).is_err(), "{input}");
    }
}

/// Replacing a custom attribute with a target keyword retains the pre-token branch's own facts.
#[test]
fn replacement_alternatives_do_not_borrow_committed_branch_fills() {
    use nightfall_cmd_parse::parser::analysis::ContinuationTarget;
    use nightfall_cmd_parse::parser::prefix::parse_prefix;
    use nightfall_cmd_parse::slots::contracts::{ClauseId, SlotId};
    let input = "release cha";
    let snapshot = parse_prefix(input, input.len());
    assert!(snapshot.completed_ast().is_some());
    assert!(
        snapshot
            .committed_clause_path()
            .iter()
            .any(|item| item.clause == ClauseId::ReleaseAttributes)
    );
    let sources = snapshot.projected_expectations();
    let source = sources
        .iter()
        .find(|source| {
            source
                .expectation
                .expected_tokens
                .contains(&ExpectedToken::Token(TokenId::Channel))
        })
        .expect("channel remains a replacement alternative");
    assert!(source.branch_index >= snapshot.branches.len());
    assert!(
        matches!(&source.expectation.target, ContinuationTarget::Slot(slot) if slot.slot == SlotId::ReleaseChannelExpr)
    );
    let owner = snapshot
        .completion_branches()
        .nth(source.branch_index)
        .unwrap();
    assert!(
        owner
            .consumed_items
            .iter()
            .all(|item| item.source_span.end <= 8)
    );
    assert_eq!((source.replace.start, source.replace.end), (8, 11));
    assert!(owner.ast.is_none());
}

/// Object-reference edits replace a complete quoted lexeme even when the cursor precedes Unicode or escaped quotes.
#[test]
fn blueprint_replacement_uses_full_quoted_lexeme_bounds() {
    let input = "sleep 1; recall blueprint \"Warm \\\"Amber\\\" 😀\" /absolute";
    let start = input.find('"').unwrap();
    let cursor = start + "\"Wa".len();
    let end = input.rfind('"').unwrap() + 1;
    let response = complete_command(input, cursor);
    let request = response
        .object_reference_requests
        .first()
        .expect("active Blueprint address request");
    assert_eq!((request.replace.start, request.replace.end), (start, end));
    assert_eq!(request.query, "Wa");
    let edited = format!(
        "{}{}17{}{}",
        &input[..start],
        request.before_value,
        request.after_value,
        &input[end..]
    );
    assert!(
        nightfall_cmd_parse::autocomplete::validate_command(&edited).status
            == nightfall_cmd_parse::autocomplete::ParseStatus::Ok,
        "{edited:?}"
    );
}

/// Duration suffix edits are grammar-owned and produce commands accepted by the same parser.
#[test]
fn duration_suffix_edits_preserve_strict_acceptance() {
    for (input, tail) in [
        ("sleep 5", ""),
        ("fix 1 red @ 100 fade 5", ""),
        ("store fx 1 step fix 1 5", " red steps 100"),
    ] {
        let response = complete_command(input, input.len());
        for unit in nightfall_cmd_parse::parser::parse_specs::duration_unit_texts() {
            let candidate = response
                .candidates
                .iter()
                .find(|candidate| candidate.insert_text == *unit)
                .unwrap_or_else(|| panic!("{input:?}: missing duration suffix {unit:?}"));
            assert_eq!(candidate.replace.start, input.len());
            assert_eq!(candidate.replace.end, input.len());
            let edited = format!("{input}{}{tail}", candidate.apply_text);
            assert!(
                nightfall_cmd_parse::generate_ast(&edited).is_ok(),
                "{edited:?}: suffix edit is not accepted"
            );
        }
    }
}

/// Returns the authoring examples shared with the design-matrix regression suite.
fn matrix_inputs() -> Vec<String> {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/design_matrix_cases.json"))
        .expect("valid design matrix");
    fixture["cases"]
        .as_array()
        .expect("matrix cases")
        .iter()
        .map(|case| case["input"].as_str().expect("command input").to_owned())
        .collect()
}

/// Every active slot retains the exact parser-owned clause instance that introduced it.
#[test]
fn active_slots_belong_to_parser_frontier() {
    for input in matrix_inputs() {
        let response = complete_command(&input, input.len());
        let alternatives = &response.parse.frontier.alternatives;
        for slot in response.slot_plan.active_slots.iter().chain(
            response
                .slot_plan
                .completion_groups
                .iter()
                .flat_map(|group| &group.active_slots),
        ) {
            assert!(
                alternatives
                    .iter()
                    .any(|alternative| alternative.slot.as_ref() == Some(slot)),
                "{input:?}: manufactured slot {slot:?}"
            );
        }
    }
}

/// A group may expose only tokens emitted by its declared parser alternatives.
#[test]
fn grouped_candidates_retain_exact_frontier_provenance() {
    for input in matrix_inputs() {
        let response = complete_command(&input, input.len());
        for group in &response.slot_plan.completion_groups {
            assert!(
                !group.frontier_sources.is_empty(),
                "{input:?}: source-less group {}",
                group.group_id.as_str()
            );
            for candidate in &group.candidates {
                assert!(
                    group.frontier_sources.iter().any(|index| {
                        response
                            .parse
                            .frontier
                            .alternatives
                            .get(*index)
                            .is_some_and(|alternative| {
                                alternative.expected_tokens.contains(candidate)
                            })
                    }),
                    "{input:?}: {} borrows {candidate:?} from another frontier",
                    group.group_id.as_str()
                );
            }
        }
    }
}

/// Display planning must preserve the parser's shared committed structure exactly.
#[test]
fn planner_preserves_committed_structure() {
    for input in matrix_inputs() {
        let response = complete_command(&input, input.len());
        assert_eq!(
            response.slot_plan.committed_path, response.parse.committed_clause_path,
            "{input:?}"
        );
    }
}

/// FX Module continuations must use the module action grammar rather than regular FX actions.
#[test]
fn fx_module_frontier_excludes_regular_fx_rate_action() {
    let input = "fx module 1 ";
    let response = complete_command(input, input.len());
    assert!(
        !response
            .parse
            .frontier
            .expected_tokens
            .contains(&ExpectedToken::Token(TokenId::Rate))
    );
    assert!(
        response
            .candidates
            .iter()
            .any(|candidate| candidate.insert_text == "start")
    );
    assert!(
        !response
            .candidates
            .iter()
            .any(|candidate| candidate.insert_text == "rate")
    );
}

/// Incomplete placement diagnostics point after the consumed placement keyword.
#[test]
fn incomplete_placement_reports_consumed_keyword_end() {
    let input = "fix 311 3d";
    assert_eq!(
        complete_command(input, input.len()).parse.furthest_pos,
        input.len()
    );
}

/// Every formatted edit can be traced to the parser alternative that owns its syntax and range.
#[test]
fn formatted_edits_retain_parser_provenance() {
    for input in matrix_inputs() {
        let response = complete_command(&input, input.len());
        for candidate in &response.candidates {
            assert!(
                !candidate.frontier_sources.is_empty(),
                "{input:?}: source-less edit"
            );
            for source in &candidate.frontier_sources {
                let alternative = &response.parse.frontier.alternatives[*source];
                assert!(
                    alternative.expected_tokens.contains(&candidate.expected),
                    "{input:?}: invented syntax"
                );
                assert_eq!(
                    candidate.replace.start,
                    response.segment_start + alternative.replace.start,
                    "{input:?}: rewritten edit"
                );
            }
        }
        for id in response.slot_plan.loose_candidate_ids.iter().chain(
            response
                .slot_plan
                .completion_groups
                .iter()
                .flat_map(|group| &group.candidate_ids),
        ) {
            assert!(
                response
                    .candidates
                    .iter()
                    .any(|candidate| &candidate.id == id),
                "{input:?}: unresolved candidate {id}"
            );
        }
    }
}

/// Applying an offered token must leave an input prefix that the same parser can consume.
#[test]
fn offered_edits_remain_viable_parser_prefixes() {
    let mut failures = Vec::new();
    for input in matrix_inputs() {
        let response = complete_command(&input, input.len());
        for candidate in response
            .candidates
            .iter()
            .filter(|candidate| candidate.completable)
        {
            let edited = format!(
                "{}{}{}",
                &input[..candidate.replace.start],
                candidate.apply_text,
                &input[candidate.replace.end..]
            );
            let next = complete_command(&edited, edited.len());
            if next.parse.furthest_pos != edited.len() {
                failures.push(format!(
                    "{input:?}: {:?} produces invalid prefix {edited:?} (stopped at {})",
                    candidate.insert_text, next.parse.furthest_pos
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Object-reference requests are emitted only where an executable branch expects an object ID or label.
#[test]
fn blueprint_requests_require_active_address_slots() {
    for input in [
        "bogus @ blueprint ",
        "@ blueprint ",
        "fix 1 @ bp ",
        "recall bp ",
        "recall blueprint \"Wa",
        "store fx 1 step fix 1 1s red @ blueprint ",
        "store fx 1 step fix 1 1s red steps @ blueprint ",
    ] {
        let response = complete_command(input, input.len());
        assert!(
            !response.object_reference_requests.is_empty(),
            "missing address request at {input:?}"
        );
        for request in &response.object_reference_requests {
            for source in &request.frontier_sources {
                assert!(
                    response.parse.frontier.alternatives[*source]
                        .expected_tokens
                        .contains(&ExpectedToken::Placeholder(
                            nightfall_cmd_parse::parser::analysis::ValueKind::BlueprintAddress
                        ))
                );
            }
        }
    }
    for input in [
        "fx banana @ blueprint ",
        "fix garbage @ blueprint ",
        "sleep @ blueprint ",
        "store group 1 @ blueprint ",
    ] {
        assert!(
            complete_command(input, input.len())
                .object_reference_requests
                .is_empty(),
            "object-reference request escaped its grammar at {input:?}"
        );
    }
}
