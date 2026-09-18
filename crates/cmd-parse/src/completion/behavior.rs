// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Command-family completion behavior.

use std::collections::BTreeSet;

use crate::command_family::{FamilyExpectedToken, SingleTokenHeadPolicy, command_family_for_head};
use crate::completion_groups::contracts::CompletionGroupId;
use crate::parser::analysis::{ExpectedToken, TokenId};

pub fn single_token_head_override(
    head: TokenId,
    has_trailing_whitespace: bool,
) -> Option<BTreeSet<ExpectedToken>> {
    match command_family_for_head(head)?.single_token_head_policy {
        SingleTokenHeadPolicy::None => None,
        SingleTokenHeadPolicy::Replace(_) if has_trailing_whitespace => None,
        SingleTokenHeadPolicy::Replace(expected_tokens) => Some(
            expected_tokens
                .iter()
                .map(family_expected_token)
                .collect::<BTreeSet<_>>(),
        ),
        SingleTokenHeadPolicy::Clear => Some(BTreeSet::new()),
    }
}

pub fn completion_group_matches_head(
    group_id: CompletionGroupId,
    command_head: Option<TokenId>,
) -> bool {
    let Some(head) = command_head else {
        return true;
    };
    if group_id == CompletionGroupId::Command {
        return true;
    }

    command_family_for_head(head).is_some_and(|family| family.completion_groups.contains(&group_id))
}

pub fn hide_group_for_exact_single_head(
    group_id: CompletionGroupId,
    command_head: Option<TokenId>,
    token_count: usize,
) -> bool {
    token_count == 1
        && command_head
            .and_then(command_family_for_head)
            .is_some_and(|family| family.hidden_exact_head_groups.contains(&group_id))
}

fn family_expected_token(token: &FamilyExpectedToken) -> ExpectedToken {
    match token {
        FamilyExpectedToken::Token(token) => ExpectedToken::Token(*token),
        FamilyExpectedToken::Placeholder(kind) => ExpectedToken::Placeholder(*kind),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        completion_group_matches_head, hide_group_for_exact_single_head, single_token_head_override,
    };
    use crate::completion_groups::contracts::CompletionGroupId;
    use crate::parser::analysis::{ExpectedToken, TokenId, ValueKind};

    #[test]
    fn release_policy_replaces_single_token_expected_tokens() {
        let expected_tokens =
            single_token_head_override(TokenId::Release, false).expect("release override");
        assert_eq!(
            expected_tokens,
            [
                ExpectedToken::Token(TokenId::Attribute),
                ExpectedToken::Token(TokenId::Channel),
            ]
            .into_iter()
            .collect()
        );
    }

    #[test]
    fn sleep_policy_exposes_duration_placeholder_only() {
        let expected_tokens =
            single_token_head_override(TokenId::Sleep, false).expect("sleep override");
        assert_eq!(
            expected_tokens,
            [ExpectedToken::Placeholder(ValueKind::DurationValue)]
                .into_iter()
                .collect()
        );
    }

    #[test]
    fn rename_policy_hides_exact_head_groups() {
        assert!(hide_group_for_exact_single_head(
            CompletionGroupId::Rename,
            Some(TokenId::Rename),
            1,
        ));
        assert!(!hide_group_for_exact_single_head(
            CompletionGroupId::Rename,
            Some(TokenId::Rename),
            2,
        ));
    }

    #[test]
    fn debug_policy_clears_candidates_after_committed_head() {
        let expected_tokens =
            single_token_head_override(TokenId::Debug, true).expect("debug clear policy");
        assert!(expected_tokens.is_empty());
    }

    #[test]
    fn programmer_groups_match_all_programmer_heads() {
        assert!(completion_group_matches_head(
            CompletionGroupId::ProgrammerSetAttribute,
            Some(TokenId::Fixture),
        ));
        assert!(completion_group_matches_head(
            CompletionGroupId::ProgrammerSetAttribute,
            Some(TokenId::Group),
        ));
        assert!(!completion_group_matches_head(
            CompletionGroupId::ProgrammerSetAttribute,
            Some(TokenId::Fx),
        ));
    }
}
