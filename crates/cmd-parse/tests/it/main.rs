// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Integration tests, linked into one binary to avoid per-file link overhead.

mod attribute_command;
mod autocomplete;
mod autocomplete_edge_snapshots;
mod channel_command;
mod clear_release_command;
mod clip_command;
// Shared with the design_matrix_golden target, so it lives outside either binary.
#[path = "../support/common.rs"]
mod common;
mod cue_command;
mod fx_command;
mod fx_module_command;
mod intent_planner;
mod parser_ownership;
mod parser_prefix_analysis;
mod patch_bindings_command;
mod spatial_selection;
mod validation;
