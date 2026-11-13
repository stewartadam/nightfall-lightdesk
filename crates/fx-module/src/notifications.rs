// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Operator-facing toasts for FX module runtime failures.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::{NotificationEnvelope, ToastLevel, UiNotification};

use crate::FxModuleRuntimeNotification;

/// Converts FX module runtime observations into operator-visible UI notifications.
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
                ui_notifications.write(UiNotification::toast(
                    ToastLevel::Error,
                    format!(
                        "FX module {} ({}) failed to initialize: {}",
                        fx_module_id, module_name, error
                    ),
                ));
            }
            FxModuleRuntimeNotification::Stopped {
                fx_module_id,
                module_name,
                error,
            } => {
                ui_notifications.write(UiNotification::toast(
                    ToastLevel::Error,
                    format!(
                        "FX module {} ({}) stopped: {}",
                        fx_module_id, module_name, error
                    ),
                ));
            }
        }
    }
}

#[cfg(test)]
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
                        ..
                    } if message.contains("FX module 7 (missing-sparkle) failed to initialize")
                        && message.contains("missing module")
                )
            }),
            "expected fx module runtime failure notification to emit an error toast"
        );
    }
}
