// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Internal command-language evaluation requested by playback and automation.

use crate::prelude::*;

/// Parse and dispatch one command-language statement without a user reply lifecycle.
///
/// Timeline playback and automation emit this action; the desk registers and handles it.
#[derive(Debug, Clone, EnginePayload)]
pub struct EvalAction(pub String);

impl EngineAction for EvalAction {}
