// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Integration tests, linked into one binary to avoid per-file link overhead.

mod ast_conv_attributes;
mod ast_conv_clear;
mod ast_conv_selection;
mod ast_conv_store_recall;
mod ast_conv_timings;
mod blueprint_reference_events;
mod painter_tests;
mod pending_user_command_planning;
mod release_programmer_values_system;
mod store_cue_events;
mod store_group_events;
