// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Use OS-default scheduling on macOS architectures unsupported by gdt-cpus.

/// Leave the current thread's priority unchanged when CPU policy is unsupported.
pub(super) fn apply_backend_thread_priority(thread_role: &str) {
    tracing::info!(
        thread_role,
        "Backend thread priority tuning unavailable; using OS-default scheduling"
    );
}

/// Leave core placement to the OS when CPU topology and affinity are unsupported.
pub(super) fn pin_backend_thread_to_performance_core(thread_role: &str) {
    tracing::info!(
        thread_role,
        "Backend thread affinity unavailable; using OS-default core placement"
    );
}
