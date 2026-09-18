// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::LexerToken;
use crate::parser::analysis::ParseBranchState;

/// Borrowed command text, tokens, and parse branch used by strict parser checks.
#[derive(Clone, Copy)]
pub(super) struct StrictBranchContext<'i, 'b> {
    pub(super) command_str: &'i str,
    pub(super) tokens: &'b [LexerToken],
    pub(super) branch: &'b ParseBranchState<'i>,
}

impl<'i, 'b> StrictBranchContext<'i, 'b> {
    pub(super) fn new(
        command_str: &'i str,
        tokens: &'b [LexerToken],
        branch: &'b ParseBranchState<'i>,
    ) -> Self {
        Self {
            command_str,
            tokens,
            branch,
        }
    }
}
