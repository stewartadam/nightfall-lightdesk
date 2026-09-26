// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::BTreeSet;

use nightfall_cmd_parse::autocomplete::{ParseStatus, complete_command};
use nightfall_cmd_parse::parser::analysis::GrammarRuleId;
use serde::Deserialize;

/// Autocomplete snapshot fixture with input and expected parser response.
#[derive(Debug, Deserialize)]
struct SnapshotCase {
    name: String,
    input: String,
    status: ParseStatus,
    furthest_pos: usize,
    expected_rules: Vec<GrammarRuleId>,
    expected_inserts: Vec<String>,
}

fn load_snapshot_cases() -> Vec<SnapshotCase> {
    serde_json::from_str(include_str!("../fixtures/autocomplete_edge_snapshots.json"))
        .expect("edge-case snapshot fixtures should deserialize")
}

#[test]
fn autocomplete_edge_case_snapshots_match_fixtures() {
    for case in load_snapshot_cases() {
        let response = complete_command(&case.input, case.input.len());
        assert_eq!(
            response.parse.status, case.status,
            "status mismatch for fixture case '{}'",
            case.name
        );
        assert_eq!(
            response.parse.furthest_pos, case.furthest_pos,
            "furthest_pos mismatch for fixture case '{}'",
            case.name
        );

        let expected_rules = case.expected_rules.into_iter().collect::<BTreeSet<_>>();
        let actual_rules = response
            .parse
            .frontier
            .expected_rules
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        assert_eq!(
            actual_rules, expected_rules,
            "expected_rules mismatch for fixture case '{}'",
            case.name
        );

        let actual_inserts = response
            .candidates
            .iter()
            .map(|candidate| candidate.insert_text.clone())
            .collect::<BTreeSet<_>>();
        let expected_inserts = case.expected_inserts.into_iter().collect::<BTreeSet<_>>();
        assert_eq!(
            actual_inserts, expected_inserts,
            "candidate inserts mismatch for fixture case '{}'",
            case.name
        );
    }
}
