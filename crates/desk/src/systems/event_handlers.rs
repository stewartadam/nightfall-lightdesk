// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::{NotificationEnvelope, ToastLevel, UiNotification};

pub mod debug_events;
pub mod desk_events;
pub mod settings_events;

/// Presents IO listener failures without coupling protocol adapters to UI contracts.
pub fn forward_io_runtime_notifications(
    mut notifications: MessageReader<NotificationEnvelope<nightfall_io::IoRuntimeNotification>>,
    mut ui_notifications: MessageWriter<UiNotification>,
) {
    use nightfall_io::{IoRuntimeNotification, RouteTransport};
    for event in notifications.read() {
        match event.notification {
            IoRuntimeNotification::InputBindFailed { transport, port } => {
                let protocol = match transport {
                    RouteTransport::ArtNet => "Art-Net",
                    RouteTransport::Sacn => "sACN",
                    RouteTransport::Udmx => "uDMX",
                };
                ui_notifications.write(UiNotification::toast(
                    ToastLevel::Warning,
                    format!("{protocol} input could not bind UDP {port}; network input has been disabled."),
                ));
            }
        }
    }
}

#[cfg(test)]
mod io_notification_tests {
    use bevy_app::prelude::*;
    use nightfall_io::{IoRuntimeNotification, RouteTransport};

    use super::*;

    /// Verifies IO failures are presented as warnings without adapter-owned UI contracts.
    #[test]
    fn io_bind_failures_forward_to_operator_warnings() {
        let mut app = App::new();
        app.add_message::<NotificationEnvelope<IoRuntimeNotification>>();
        app.add_message::<UiNotification>();
        app.add_systems(Update, forward_io_runtime_notifications);
        for (transport, port) in [(RouteTransport::ArtNet, 6454), (RouteTransport::Sacn, 5568)] {
            app.world_mut()
                .write_message(NotificationEnvelope::detached(
                    IoRuntimeNotification::InputBindFailed { transport, port },
                ));
        }
        app.update();
        let messages: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<UiNotification>>()
            .drain()
            .collect();
        assert_eq!(messages.len(), 2);
        for (notification, expected) in messages.iter().zip([
            "Art-Net input could not bind UDP 6454",
            "sACN input could not bind UDP 5568",
        ]) {
            let UiNotification::ShowToast { level, message, .. } = notification else {
                panic!("expected a toast")
            };
            assert_eq!(*level, ToastLevel::Warning);
            assert!(message.starts_with(expected));
            assert!(message.ends_with("network input has been disabled."));
        }
        app.update();
        assert!(
            app.world_mut()
                .resource_mut::<Messages<UiNotification>>()
                .drain()
                .next()
                .is_none()
        );
    }
}
