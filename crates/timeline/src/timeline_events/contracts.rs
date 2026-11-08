// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Notification that an active timeline's playhead jumped without a seek command: a loop
/// wrapped, or an external source relocated the timecode. Timeline playback is rebuilt at the
/// new position as for a seek, without the activation an explicit seek brings.
#[derive(Clone, Copy, Debug, Message)]
pub(crate) struct TimelinePlayheadJumped {
    /// Timeline whose playhead jumped.
    pub timeline: Entity,
    /// Timecode position the playhead jumped to.
    pub timecode_position: Duration,
}

/// Notification emitted after a timeline action mutation is accepted.
#[allow(dead_code)]
#[derive(Clone, Debug, Message)]
pub(crate) struct TimelineActionsChanged {
    /// Timeline ID whose live action set changed.
    pub timeline_id: u32,
}
