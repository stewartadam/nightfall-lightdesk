// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Builds the `hw_profile` event and the request bodies OpenPanel's track API accepts.

use nightfall_desk::prelude::GraphicsReport;
use serde_json::{Map, Value, json};
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

use crate::HostShell;

/// Hardware and operating system details that do not change while the app runs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Hardware {
    /// Operating system family as OpenPanel names it: `macOS`, `Windows`, or `Linux`.
    pub(crate) os: String,
    /// Operating system version, such as `15.1` or `24.04`.
    pub(crate) os_version: Option<String>,
    /// Linux distribution identifier, such as `ubuntu`.
    pub(crate) os_distribution: Option<String>,
    /// Processor architecture, such as `aarch64`.
    pub(crate) arch: String,
    /// Processor model as the operating system names it.
    pub(crate) cpu_model: Option<String>,
    /// Hardware threads.
    pub(crate) cpu_threads: usize,
    /// Physical cores.
    pub(crate) cpu_cores: Option<usize>,
    /// Installed memory rounded to a power of two gigabytes.
    pub(crate) ram_gb: Option<u64>,
}

impl Hardware {
    /// Reads the details from the operating system. Takes a few milliseconds, so callers run it
    /// away from the frame loop.
    pub(crate) fn detect() -> Self {
        let system = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::nothing())
                .with_memory(MemoryRefreshKind::nothing().with_ram()),
        )
        .ok();
        let os = match std::env::consts::OS {
            "macos" => "macOS",
            "windows" => "Windows",
            "linux" => "Linux",
            other => other,
        };
        Self {
            os: os.to_string(),
            os_version: System::os_version()
                .ok()
                .filter(|version| !version.is_empty()),
            os_distribution: (std::env::consts::OS == "linux")
                .then(System::distribution_id)
                .filter(|id| !id.is_empty()),
            arch: std::env::consts::ARCH.to_string(),
            cpu_model: system
                .as_ref()
                .and_then(|system| system.cpus().first())
                .map(|cpu| cpu.brand().trim().to_string())
                .filter(|brand| !brand.is_empty()),
            cpu_threads: std::thread::available_parallelism().map_or(0, usize::from),
            cpu_cores: System::physical_core_count().ok(),
            ram_gb: system
                .as_ref()
                .and_then(|system| ram_bucket_gb(system.total_memory())),
        }
    }
}

/// Rounds installed memory to the nearest power of two gigabytes, so the figure groups
/// machines without describing any one exactly. Systems report a little less than what is
/// installed, which rounding absorbs.
pub(crate) fn ram_bucket_gb(bytes: u64) -> Option<u64> {
    if bytes == 0 {
        return None;
    }
    let gigabytes = bytes as f64 / f64::from(1u32 << 30);
    let exponent = gigabytes.log2().round().clamp(0.0, 12.0);
    Some(1u64 << exponent as u32)
}

/// Builds the `hw_profile` properties. The `__os`, `__osVersion`, and `__device` keys fill
/// OpenPanel's built-in operating system and device fields.
pub(crate) fn hw_profile(
    shell: HostShell,
    hardware: &Hardware,
    graphics: Option<&GraphicsReport>,
) -> Map<String, Value> {
    let mut properties = Map::new();
    let mut set = |name: &str, value: Value| {
        if !value.is_null() {
            properties.insert(name.to_string(), value);
        }
    };
    set("app_version", json!(env!("CARGO_PKG_VERSION")));
    set(
        "runtime",
        json!(match shell {
            HostShell::Desktop => "desktop",
            HostShell::Headless => "headless",
        }),
    );
    set("__os", json!(hardware.os));
    set("__osVersion", json!(hardware.os_version));
    set("__device", json!("desktop"));
    set("os_distribution", json!(hardware.os_distribution));
    set("arch", json!(hardware.arch));
    set("cpu_model", json!(hardware.cpu_model));
    set("cpu_threads", json!(hardware.cpu_threads));
    set("cpu_cores", json!(hardware.cpu_cores));
    set("ram_gb", json!(hardware.ram_gb));
    if let Some(graphics) = graphics {
        set("gpu", json!(graphics.gpu));
        set("graphics_backend", json!(graphics.backend));
    }
    properties
}

/// Wraps one event in an OpenPanel track request. The install identifier is both the profile,
/// which is what monthly active installs count, and the device, so one install never appears
/// as several. `timestamp` records when the event happened, since a queued event may be sent
/// days later.
pub(crate) fn track_body(
    name: &str,
    mut properties: Map<String, Value>,
    install_id: &str,
    timestamp: &str,
) -> Vec<u8> {
    properties.insert("__timestamp".into(), json!(timestamp));
    properties.insert("__deviceId".into(), json!(install_id));
    let body = json!({
        "type": "track",
        "payload": {
            "name": name,
            "profileId": install_id,
            "properties": properties,
        },
    });
    serde_json::to_vec(&body).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Memory rounds to the nearest power of two gigabytes.
    #[test]
    fn buckets_memory_by_power_of_two() {
        const GIB: u64 = 1 << 30;
        assert_eq!(ram_bucket_gb(0), None);
        assert_eq!(ram_bucket_gb(GIB / 2), Some(1));
        assert_eq!(ram_bucket_gb(15 * GIB + GIB / 2), Some(16));
        assert_eq!(ram_bucket_gb(7 * GIB), Some(8));
        assert_eq!(ram_bucket_gb(24 * GIB), Some(32));
        assert_eq!(ram_bucket_gb(20 * GIB), Some(16));
    }

    /// `hw_profile` carries hardware, graphics, and OpenPanel's device fields, and omits what
    /// is unknown.
    #[test]
    fn hw_profile_lists_hardware_and_graphics() {
        let hardware = Hardware {
            os: "macOS".into(),
            os_version: Some("15.1".into()),
            arch: "aarch64".into(),
            cpu_model: Some("Apple M2".into()),
            cpu_threads: 8,
            cpu_cores: Some(8),
            ram_gb: Some(16),
            ..Default::default()
        };
        let graphics = GraphicsReport {
            gpu: Some("Apple M2".into()),
            backend: "WebGPU".into(),
        };
        let properties = hw_profile(HostShell::Desktop, &hardware, Some(&graphics));
        assert_eq!(properties["runtime"], "desktop");
        assert_eq!(properties["__os"], "macOS");
        assert_eq!(properties["__osVersion"], "15.1");
        assert_eq!(properties["ram_gb"], 16);
        assert_eq!(properties["gpu"], "Apple M2");
        assert_eq!(properties["graphics_backend"], "WebGPU");
        assert!(!properties.contains_key("os_distribution"));

        let headless = hw_profile(HostShell::Headless, &hardware, None);
        assert_eq!(headless["runtime"], "headless");
        assert!(!headless.contains_key("gpu"));
    }

    /// Track requests identify the install as both profile and device and keep the event time.
    #[test]
    fn track_body_matches_the_openpanel_api() {
        let body = track_body(
            "hw_profile",
            Map::new(),
            "install-1",
            "2026-10-10T20:00:00Z",
        );
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            body,
            json!({
                "type": "track",
                "payload": {
                    "name": "hw_profile",
                    "profileId": "install-1",
                    "properties": {
                        "__timestamp": "2026-10-10T20:00:00Z",
                        "__deviceId": "install-1",
                    },
                },
            })
        );
    }
}
