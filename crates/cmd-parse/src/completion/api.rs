// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Public completion API contracts.

use serde::{Deserialize, Serialize};

use crate::autocomplete::{CompletionCandidate, ParseSnapshot, TextRange};
use crate::slots::planner::SlotPlan;

/// Autocomplete response for one command segment, returned to UI and bridge callers.
///
/// This is the outward response shape from [`crate::autocomplete::complete_command`].
/// It contains the replacement span, parse snapshot, slot-plan metadata, and
/// completion candidates needed to render CLI autocomplete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandCompletionResponse {
    pub object_reference_requests: Vec<crate::autocomplete::ObjectReferenceCompletionRequest>,
    pub input_len: usize,
    pub cursor: usize,
    pub segment_start: usize,
    pub segment_end: usize,
    pub replace: TextRange,
    pub parse: ParseSnapshot,
    pub slot_plan: SlotPlan,
    pub candidates: Vec<CompletionCandidate>,
}
