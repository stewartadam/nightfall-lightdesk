// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use gdt_cpus::{CoreKind, CpuInfo, Lp, ThreadPriority, pin_thread_to_core, set_thread_priority};

pub(super) const BACKEND_THREAD_PRIORITY: ThreadPriority = ThreadPriority::Highest;

/// Apply the backend scheduling priority policy to the current thread.
pub(super) fn apply_backend_thread_priority(thread_role: &str) {
    match set_thread_priority(BACKEND_THREAD_PRIORITY) {
        Ok(applied) => tracing::info!(
            thread_role,
            priority = %applied,
            "Applied backend thread priority"
        ),
        Err(error) => tracing::warn!(
            thread_role,
            priority = %BACKEND_THREAD_PRIORITY,
            error = %error,
            "Failed to apply backend thread priority"
        ),
    }
}

/// Pin the current thread to the selected backend performance core when supported.
pub(super) fn pin_backend_thread_to_performance_core(thread_role: &str) {
    let cpu_info = match CpuInfo::detect() {
        Ok(cpu_info) => cpu_info,
        Err(error) => {
            tracing::warn!(
                thread_role,
                error = %error,
                "Failed to detect CPU topology for backend thread affinity"
            );
            return;
        }
    };

    let Some(core_id) = best_backend_core(&cpu_info.lps) else {
        tracing::warn!(
            thread_role,
            "No performance core found for backend thread affinity"
        );
        return;
    };

    match pin_thread_to_core(core_id) {
        Ok(()) => tracing::info!(
            thread_role,
            core_id,
            model = %cpu_info.model_name,
            "Pinned backend thread to performance core"
        ),
        Err(error) => tracing::info!(
            thread_role,
            core_id,
            model = %cpu_info.model_name,
            error = %error,
            "Backend thread affinity unavailable; using priority policy only"
        ),
    }
}

/// Select the strongest primary performance-core logical processor.
pub(super) fn best_backend_core(lps: &[Lp]) -> Option<usize> {
    lps.iter()
        .filter(|lp| lp.kind == CoreKind::Performance && lp.smt_index == 0)
        .max_by_key(|lp| (lp.perf_hint, std::cmp::Reverse(lp.os_id)))
        .map(|lp| lp.os_id as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a logical processor record for backend CPU policy tests.
    fn test_lp(os_id: u16, kind: CoreKind, smt_index: u8, perf_hint: u16) -> Lp {
        Lp {
            os_id,
            core: os_id,
            socket: 0,
            l3_domain: Lp::NO_L3,
            l2_domain: Lp::NO_L2,
            numa_node: 0,
            kind,
            smt_index,
            perf_hint,
            cpu_part: 0,
        }
    }

    /// Prefer the fastest primary performance core over SMT siblings and efficiency cores.
    #[test]
    fn best_backend_core_prefers_fastest_primary_performance_core() {
        let lps = [
            test_lp(1, CoreKind::Performance, 1, 100),
            test_lp(2, CoreKind::Efficiency, 0, 300),
            test_lp(3, CoreKind::Performance, 0, 100),
            test_lp(4, CoreKind::Performance, 0, 200),
        ];

        assert_eq!(best_backend_core(&lps), Some(4));
    }
}
