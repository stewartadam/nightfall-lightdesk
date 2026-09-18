// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::{Message, Resource};
use serde::{Deserialize, Serialize};

/// Severity levels used when displaying UI toast messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum ToastLevel {
    Info,
    Success,
    Warning,
    Error,
}

/// Outbound observations requesting UI-only presentation behavior.
#[derive(Debug, Clone, Serialize, Deserialize, Message)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum UiNotification {
    /// Show a toast/notification in the UI
    ShowToast { level: ToastLevel, message: String },
    /// Update the frontend's remembered current showfile name.
    CurrentShowfileChanged { name: Option<String> },
}

/// UI notifications that should be replayed after the next websocket resync.
#[derive(Debug, Default, Resource)]
pub struct PendingUiNotifications(Vec<UiNotification>);

impl PendingUiNotifications {
    /// Queues one notification for delivery after the next state resync.
    pub fn push(&mut self, notification: UiNotification) {
        self.0.push(notification);
    }

    /// Drains queued notifications in insertion order.
    pub fn drain(&mut self) -> impl Iterator<Item = UiNotification> + '_ {
        self.0.drain(..)
    }
}
