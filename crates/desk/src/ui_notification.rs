// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::{Message, Resource};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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
    CurrentShowfileChanged {
        name: Option<String>,
        change_id: Uuid,
    },
}

impl UiNotification {
    /// Identifies a confirmed showfile change so clients can deduplicate resync replays.
    pub fn current_showfile_changed(name: Option<String>) -> Self {
        Self::CurrentShowfileChanged {
            name,
            change_id: Uuid::new_v4(),
        }
    }
}

/// One-shot UI notifications and confirmed showfile identity replayed during resync.
#[derive(Debug, Default, Resource)]
pub struct UiNotificationState {
    pending: Vec<UiNotification>,
    current_showfile: Option<UiNotification>,
}

impl UiNotificationState {
    /// Queues transient notifications and retains confirmed identity for every resync.
    pub fn push(&mut self, notification: UiNotification) {
        if matches!(notification, UiNotification::CurrentShowfileChanged { .. }) {
            self.current_showfile = Some(notification);
        } else {
            self.pending.push(notification);
        }
    }

    /// Records live identity changes without queuing transient notifications again.
    pub fn observe(&mut self, notification: &UiNotification) {
        if matches!(notification, UiNotification::CurrentShowfileChanged { .. }) {
            self.current_showfile = Some(notification.clone());
        }
    }

    /// Drains transient notifications and replays the latest confirmed identity.
    pub fn take_for_resync(&mut self) -> impl Iterator<Item = UiNotification> + '_ {
        self.pending.drain(..).chain(self.current_showfile.clone())
    }
}
