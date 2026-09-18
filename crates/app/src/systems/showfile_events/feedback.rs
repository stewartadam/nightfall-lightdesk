// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Command completion and operator feedback for showfile workflows.

use super::*;

/// Emits successful save completion and its operator-facing toast.
pub(super) fn write_showfile_saved_feedback(
    event: &CommandEnvelope<DeskCommand>,
    responder: &mut CommandResponder,
    ui_notifications: &mut MessageWriter<UiNotification>,
) {
    succeed_showfile_command(responder, event.command_id);
    ui_notifications.write(UiNotification::ShowToast {
        level: ToastLevel::Success,
        message: "Showfile saved".to_string(),
    });
}

/// Notifies the UI that the backend-confirmed current showfile changed.
pub(super) fn write_current_showfile_changed(
    name: Option<String>,
    ui_notifications: &mut MessageWriter<UiNotification>,
) {
    ui_notifications.write(UiNotification::CurrentShowfileChanged { name });
}

/// Emits successful import completion and its operator-facing toast.
pub(super) fn write_showfile_imported_feedback(
    event: &CommandEnvelope<DeskCommand>,
    responder: &mut CommandResponder,
    ui_notifications: &mut MessageWriter<UiNotification>,
) {
    succeed_showfile_command(responder, event.command_id);
    ui_notifications.write(UiNotification::ShowToast {
        level: ToastLevel::Success,
        message: "Showfile imported".to_string(),
    });
}

/// Reports successful completion for one directly handled showfile command.
pub(super) fn succeed_showfile_command(responder: &mut CommandResponder, command_id: CommandId) {
    if let Err(error) = responder.succeed(command_id) {
        tracing::error!(%error, "showfile_command_completion_failed");
    }
}

/// Reports a structured failure for one directly handled showfile command.
pub(super) fn fail_showfile_command(
    responder: &mut CommandResponder,
    command_id: CommandId,
    message: String,
) {
    if let Err(error) = responder.fail(
        command_id,
        CommandError::new("showfile.command_failed", message),
    ) {
        tracing::error!(%error, "showfile_command_failure_failed");
    }
}
