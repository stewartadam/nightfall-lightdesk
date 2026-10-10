// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Usage reports for builds without the `telemetry` feature: every entry point does nothing.

use bevy::prelude::App;
use nightfall_desk::prelude::TelemetryState;

use crate::HostShell;

/// Stands in for the usage report service; holds nothing.
pub struct UsageReportsGuard;

/// Usage reports are compiled out, so there is nothing to start.
pub(crate) fn init(_configured_url: Option<&str>, _shell: HostShell) -> UsageReportsGuard {
    UsageReportsGuard
}

/// There are no queued reports to write.
pub(crate) fn flush_usage_reports() {}

/// Consent has no effect without a usage report service.
pub(crate) fn apply_consent(_state: &TelemetryState) {}

/// There are no reports to schedule.
pub(crate) fn add_systems(_app: &mut App) {}
