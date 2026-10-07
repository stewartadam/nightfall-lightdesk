// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Integration tests, linked into one binary to avoid per-file link overhead.

mod ast_conv;
mod ast_conv_control;
mod ast_conv_create;
mod ast_conv_create_basic;
mod ast_conv_create_curves;
mod ast_conv_create_multi_attr;
mod ast_conv_management;
mod runtime_dedup;
