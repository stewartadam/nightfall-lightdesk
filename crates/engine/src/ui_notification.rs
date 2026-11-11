// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Toasts and other UI-only notifications that any plugin can raise.

use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::prelude::*;

/// Severity levels used when displaying UI toast messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum ToastLevel {
    Info,
    Success,
    Warning,
    Error,
}

/// Follow-up a toast offers as a button, resolved to a concrete UI destination by each client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ToastAction {
    /// Open Settings on the Network tab, where the DMX network interface is chosen.
    OpenNetworkSettings,
    /// Open the Transports panel, where External control and its interface are configured.
    OpenExternalControlSettings,
    /// Open the I/O Transports panel, where USB DMX outputs are assigned to adapters.
    OpenUsbDmxOutputs,
    /// Save the port an attached adapter is on now as its USB output's port.
    UpdateUsbDmxPort {
        /// USB output target identifier.
        target: String,
        /// Selector of the attached adapter.
        device: String,
    },
    /// Make an adapter that several USB outputs could claim drive the named output.
    ChooseUsbDmxOutput {
        /// USB output target identifier.
        target: String,
        /// Selector of the attached adapter.
        device: String,
    },
}

/// Outbound observations requesting UI-only presentation behavior.
#[derive(Debug, Clone, Serialize, Deserialize, Message)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum UiNotification {
    /// Show a toast/notification in the UI
    ShowToast {
        level: ToastLevel,
        message: String,
        /// Buttons offered alongside the message, in display order.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        actions: Vec<ToastAction>,
        /// Keeps the toast up until the operator dismisses it, for problems that must not be
        /// missed even when nobody is watching the screen.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        sticky: bool,
    },
    /// Update the frontend's remembered current showfile name.
    CurrentShowfileChanged {
        name: Option<String>,
        change_id: Uuid,
        /// The previous name when the open show was saved under a new name rather than replaced,
        /// so devices keep the arrangement they made for it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        renamed_from: Option<String>,
    },
}

impl UiNotification {
    /// Builds a plain toast with no action buttons.
    pub fn toast(level: ToastLevel, message: impl Into<String>) -> Self {
        Self::ShowToast {
            level,
            message: message.into(),
            actions: Vec::new(),
            sticky: false,
        }
    }

    /// Builds a toast that stays up until the operator dismisses it.
    pub fn sticky_toast(level: ToastLevel, message: impl Into<String>) -> Self {
        Self::ShowToast {
            level,
            message: message.into(),
            actions: Vec::new(),
            sticky: true,
        }
    }

    /// Builds a toast offering `actions` as buttons beside the message.
    pub fn toast_with_actions(
        level: ToastLevel,
        message: impl Into<String>,
        actions: Vec<ToastAction>,
    ) -> Self {
        Self::ShowToast {
            level,
            message: message.into(),
            actions,
            sticky: false,
        }
    }

    /// Identifies a confirmed showfile change so clients can deduplicate resync replays.
    pub fn current_showfile_changed(name: Option<String>) -> Self {
        Self::CurrentShowfileChanged {
            name,
            change_id: Uuid::new_v4(),
            renamed_from: None,
        }
    }

    /// Reports that the open show was saved under a new name without replacing its contents.
    ///
    /// `previous` is `None` for the default show.
    pub fn current_showfile_renamed(name: Option<String>, previous: Option<&str>) -> Self {
        Self::CurrentShowfileChanged {
            name,
            change_id: Uuid::new_v4(),
            renamed_from: Some(previous.unwrap_or("default").to_string()),
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

/// Forwards UI-only notifications to every connected client as they are raised.
///
/// Before a host attaches its client sink, notifications are queued instead so the first resync
/// replays them rather than dropping them.
pub fn forward_ui_notifications(
    mut events: MessageReader<UiNotification>,
    broadcaster: Option<Res<ClientEventSink>>,
    mut pending: ResMut<UiNotificationState>,
) {
    for event in events.read() {
        let Some(broadcaster) = broadcaster.as_deref() else {
            pending.push(event.clone());
            continue;
        };
        pending.observe(event);
        tracing::trace!(?event, "Forwarding UiNotification to UI");
        broadcaster.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &EngineClientMessage::UiNotification(event),
        );
    }
}

/// Replays queued notifications when clients resync.
///
/// Transient notifications go to every client, since they are drained once and no client has
/// seen them yet. The retained showfile identity goes only to the resyncing clients.
pub fn send_pending_ui_notifications_on_resync(
    mut resync: ResyncReplies,
    mut pending: ResMut<UiNotificationState>,
    every_client: Option<Res<ClientEventSink>>,
) {
    let (Some(resyncing), Some(every_client)) = (resync.sink(), every_client.as_deref()) else {
        return;
    };
    flush_pending_ui_notifications(&mut pending, every_client, &resyncing);
}

/// Sends queued transient notifications to `every_client` and the retained showfile identity to
/// `resyncing`, draining the transient queue.
fn flush_pending_ui_notifications(
    pending: &mut UiNotificationState,
    every_client: &ClientEventSink,
    resyncing: &ClientEventSink,
) {
    for notification in pending.take_for_resync() {
        tracing::trace!(
            ?notification,
            "Replaying pending UiNotification after resync"
        );
        let sink = if matches!(notification, UiNotification::CurrentShowfileChanged { .. }) {
            resyncing
        } else {
            every_client
        };
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &EngineClientMessage::UiNotification(&notification),
        );
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};

    use super::*;
    use crate::client_bridge::OutboundFrame;

    /// A Save As names the previous show, using "default" for the unnamed default show, while
    /// ordinary changes leave the field off the wire.
    #[test]
    fn renames_carry_the_previous_name() {
        let renamed = serde_json::to_value(UiNotification::current_showfile_renamed(
            Some("tour".into()),
            None,
        ))
        .unwrap();
        assert_eq!(renamed["data"]["renamed_from"], "default");

        let loaded = serde_json::to_value(UiNotification::current_showfile_changed(Some(
            "tour".into(),
        )))
        .unwrap();
        assert!(loaded["data"].get("renamed_from").is_none());
    }

    #[test]
    /// Verifies UI notifications are forwarded as non-droppable websocket messages.
    fn forward_ui_notifications_broadcasts_show_toast() {
        let (tx, rx) = async_channel::unbounded::<OutboundFrame>();
        let mut app = App::new();
        app.add_message::<UiNotification>();
        app.init_resource::<UiNotificationState>();
        app.insert_resource(ClientEventSink::new(tx));
        app.add_systems(Update, forward_ui_notifications);

        app.world_mut()
            .write_message(UiNotification::toast(ToastLevel::Success, "done"));

        app.update();

        let payload = rx
            .try_recv()
            .expect("expected websocket payload for UiNotification::ShowToast");
        assert_eq!(
            payload.bytes.first().copied(),
            Some(DISCRIMINATOR_NON_DROPPABLE)
        );

        let payload_text = String::from_utf8_lossy(&payload.bytes);
        assert!(
            payload_text.contains("UiNotification"),
            "payload did not include UiNotification tag: {payload_text:?}"
        );
        assert!(
            payload_text.contains("ShowToast"),
            "payload did not include ShowToast variant: {payload_text:?}"
        );
        assert!(
            payload_text.contains("done"),
            "payload did not include toast message: {payload_text:?}"
        );
    }

    #[test]
    /// Verifies queued startup notifications are replayed once and then drained.
    fn flush_pending_ui_notifications_broadcasts_and_drains_notifications() {
        let (tx, rx) = async_channel::unbounded::<OutboundFrame>();
        let broadcaster = ClientEventSink::new(tx);
        let mut pending = UiNotificationState::default();
        pending.push(UiNotification::toast(ToastLevel::Error, "startup failed"));

        flush_pending_ui_notifications(&mut pending, &broadcaster, &broadcaster);

        let payload = rx
            .try_recv()
            .expect("expected websocket payload for pending UiNotification::ShowToast");
        assert_eq!(
            payload.bytes.first().copied(),
            Some(DISCRIMINATOR_NON_DROPPABLE)
        );

        let payload_text = String::from_utf8_lossy(&payload.bytes);
        assert!(
            payload_text.contains("ShowToast"),
            "payload did not include ShowToast variant: {payload_text:?}"
        );
        assert!(
            payload_text.contains("startup failed"),
            "payload did not include toast message: {payload_text:?}"
        );

        flush_pending_ui_notifications(&mut pending, &broadcaster, &broadcaster);
        assert!(
            rx.try_recv().is_err(),
            "pending UI notifications should be drained after replay"
        );
    }

    #[test]
    /// Reconnects must receive confirmed identity even after an unobserved internal resync.
    fn resync_replays_showfile_identity_after_earlier_delivery() {
        let (tx, rx) = async_channel::unbounded::<OutboundFrame>();
        let broadcaster = ClientEventSink::new(tx);
        let mut state = UiNotificationState::default();
        flush_pending_ui_notifications(&mut state, &broadcaster, &broadcaster);
        assert!(
            rx.try_recv().is_err(),
            "initial worlds have no confirmed identity"
        );
        state.push(UiNotification::current_showfile_changed(Some(
            "Sample Tour".to_string(),
        )));
        for _ in 0..2 {
            flush_pending_ui_notifications(&mut state, &broadcaster, &broadcaster);
            let payload = rx.try_recv().expect("identity must survive every resync");
            assert!(String::from_utf8_lossy(&payload.bytes).contains("Sample Tour"));
        }
    }

    #[test]
    /// Queued toasts reach every client even when one client's resync drains them, while the
    /// showfile identity replay goes only to the resyncing client.
    fn resync_broadcasts_queued_toasts_and_replies_identity() {
        let (tx, rx) = async_channel::unbounded::<OutboundFrame>();
        let broadcaster = ClientEventSink::new(tx);
        let requester = Audience::Client(ClientId(6));
        let resyncing = broadcaster.narrowed_to(std::sync::Arc::from([requester]));
        let mut state = UiNotificationState::default();
        state.push(UiNotification::toast(ToastLevel::Error, "show load failed"));
        state.push(UiNotification::current_showfile_changed(Some(
            "Sample Tour".to_string(),
        )));

        flush_pending_ui_notifications(&mut state, &broadcaster, &resyncing);

        let audiences: Vec<Audience> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|frame| frame.audience)
            .collect();
        assert_eq!(audiences, vec![Audience::All, requester]);
    }

    #[test]
    /// Live rename notifications replace the identity retained for a later reconnect.
    fn forward_ui_notifications_updates_replayed_identity() {
        let (tx, rx) = async_channel::unbounded::<OutboundFrame>();
        let mut app = App::new();
        app.add_message::<UiNotification>();
        app.init_resource::<UiNotificationState>();
        app.insert_resource(ClientEventSink::new(tx));
        app.add_systems(Update, forward_ui_notifications);
        app.world_mut().resource_mut::<UiNotificationState>().push(
            UiNotification::current_showfile_changed(Some("Old".to_string())),
        );
        app.world_mut()
            .write_message(UiNotification::current_showfile_changed(Some(
                "Renamed".to_string(),
            )));
        app.update();
        rx.try_recv().expect("live notification");
        let replay: Vec<_> = app
            .world_mut()
            .resource_mut::<UiNotificationState>()
            .take_for_resync()
            .collect();
        assert!(
            matches!(replay.as_slice(), [UiNotification::CurrentShowfileChanged { name: Some(name), .. }] if name == "Renamed")
        );
    }
}
