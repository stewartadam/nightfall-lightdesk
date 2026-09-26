// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Integration tests, linked into one binary to avoid per-file link overhead.

mod ast_conv;
mod binding_resolution;
mod clear_dmx_channels_system;
mod compositor_pipeline_tests;
mod compositor_system_tests;
mod restore_fixture_snapshot_system;
mod transport_input;
