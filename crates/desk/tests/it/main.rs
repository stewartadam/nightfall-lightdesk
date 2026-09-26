// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Integration tests, linked into one binary to avoid per-file link overhead.

mod ast_conv_clip;
mod ast_conv_logging;
mod ast_conv_management;
mod ast_conv_system;
mod release_system_tests;
mod settings_sync;
mod undo_ast_conv;
mod vdim_output_tests;
