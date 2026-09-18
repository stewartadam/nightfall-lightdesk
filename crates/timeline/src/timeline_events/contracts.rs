// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Notification emitted after a timeline action mutation is accepted.
#[allow(dead_code)]
#[derive(Clone, Debug, Message)]
pub(crate) struct TimelineActionsChanged {
    /// Timeline ID whose live action set changed.
    pub timeline_id: u32,
}
