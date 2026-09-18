// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::NotificationEnvelope;
#[cfg(feature = "fx-module-host")]
use nightfall_fx_module::prelude::FxModuleRuntimeNotification;

use crate::prelude::{ToastLevel, UiNotification};

pub mod blueprint_events;
pub mod clip_events;
pub mod debug_events;
pub mod desk_events;
pub mod fixture_events;
pub mod group_events;
pub mod instance_events;
pub mod master_events;
pub mod settings_events;

/// Converts FX module runtime observations into operator-visible UI notifications.
#[cfg(feature = "fx-module-host")]
pub fn forward_fx_module_runtime_notifications(
    mut notifications: MessageReader<NotificationEnvelope<FxModuleRuntimeNotification>>,
    mut ui_notifications: MessageWriter<UiNotification>,
) {
    for event in notifications.read() {
        match &event.notification {
            FxModuleRuntimeNotification::InstantiationFailed {
                fx_module_id,
                module_name,
                error,
            } => {
                ui_notifications.write(UiNotification::ShowToast {
                    level: ToastLevel::Error,
                    message: format!(
                        "FX module {} ({}) failed to initialize: {}",
                        fx_module_id, module_name, error
                    ),
                });
            }
        }
    }
}

#[cfg(all(test, feature = "fx-module-host"))]
mod tests {
    use bevy_app::{App, Update};

    use super::*;

    /// Verifies fx module runtime failures are surfaced as UI error toasts.
    #[test]
    fn fx_module_runtime_notification_forwards_error_toast() {
        let mut app = App::new();
        app.add_message::<NotificationEnvelope<FxModuleRuntimeNotification>>();
        app.add_message::<UiNotification>();
        app.add_systems(Update, forward_fx_module_runtime_notifications);

        app.world_mut()
            .write_message(NotificationEnvelope::detached(
                FxModuleRuntimeNotification::InstantiationFailed {
                    fx_module_id: 7,
                    module_name: "missing-sparkle".to_string(),
                    error: "missing module".to_string(),
                },
            ));
        app.update();

        let ui_notifications: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<UiNotification>>()
            .drain()
            .collect();
        assert!(
            ui_notifications.iter().any(|notification| {
                matches!(
                    notification,
                    UiNotification::ShowToast {
                        level: ToastLevel::Error,
                        message,
                    } if message.contains("FX module 7 (missing-sparkle) failed to initialize")
                        && message.contains("missing module")
                )
            }),
            "expected fx module runtime failure notification to emit an error toast"
        );
    }
}

/// Presents IO listener failures without coupling protocol adapters to UI contracts.
pub fn forward_io_runtime_notifications(
    mut notifications: MessageReader<NotificationEnvelope<nightfall_io::IoRuntimeNotification>>,
    mut ui_notifications: MessageWriter<UiNotification>,
) {
    use nightfall_io::{BindingTransport, IoRuntimeNotification};
    for event in notifications.read() {
        match event.notification {
            IoRuntimeNotification::InputBindFailed { transport, port } => {
                let protocol = match transport {
                    BindingTransport::ArtNet => "Art-Net",
                    BindingTransport::Sacn => "sACN",
                    BindingTransport::Udmx => "uDMX",
                };
                ui_notifications.write(UiNotification::ShowToast {
                    level: ToastLevel::Warning,
                    message: format!("{protocol} input could not bind UDP {port}; network input has been disabled."),
                });
            }
        }
    }
}

#[cfg(test)]
mod io_notification_tests {
    use bevy_app::prelude::*;
    use nightfall_io::{BindingTransport, IoRuntimeNotification};

    use super::*;

    /// Verifies IO failures are presented as warnings without adapter-owned UI contracts.
    #[test]
    fn io_bind_failures_forward_to_operator_warnings() {
        let mut app = App::new();
        app.add_message::<NotificationEnvelope<IoRuntimeNotification>>();
        app.add_message::<UiNotification>();
        app.add_systems(Update, forward_io_runtime_notifications);
        for (transport, port) in [
            (BindingTransport::ArtNet, 6454),
            (BindingTransport::Sacn, 5568),
        ] {
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
            let UiNotification::ShowToast { level, message } = notification else {
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
