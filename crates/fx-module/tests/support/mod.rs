// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

use wit_component::ComponentEncoder;

/// Builds and caches the guest component used by runtime and playback tests.
pub fn test_component_bytes() -> &'static [u8] {
    static COMPONENT: OnceLock<Vec<u8>> = OnceLock::new();
    COMPONENT
        .get_or_init(|| {
            let guest_wasm = build_test_guest_module_path();
            let module = std::fs::read(&guest_wasm)
                .unwrap_or_else(|error| panic!("failed to read {}: {error}", guest_wasm.display()));
            ComponentEncoder::default()
                .module(&module)
                .expect("failed to attach module to component encoder")
                .encode()
                .expect("failed to encode component")
        })
        .as_slice()
}

/// Uses Cargo's artifact output so configured target directories and cached builds are respected.
pub fn build_test_guest_module_path() -> PathBuf {
    let manifest =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../fx-module/tests/guest-module/Cargo.toml");
    let output = Command::new("cargo")
        .args(["build", "--manifest-path"])
        .arg(&manifest)
        .args([
            "--target",
            "wasm32-unknown-unknown",
            "--message-format=json-render-diagnostics",
        ])
        .current_dir(manifest.parent().unwrap())
        .output()
        .expect("failed to build test guest module");
    assert!(
        output.status.success(),
        "guest module build failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    guest_artifact_path(&output.stdout).unwrap_or_else(|| {
        panic!(
            "Cargo did not report the guest WASM artifact:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

/// Selects the guest library's WASM filename from Cargo's line-delimited JSON messages.
fn guest_artifact_path(output: &[u8]) -> Option<PathBuf> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|message| {
            message["reason"] == "compiler-artifact"
                && message["target"]["name"] == "fx_module_test_module"
        })
        .find_map(|message| {
            message["filenames"]
                .as_array()?
                .iter()
                .filter_map(|name| name.as_str())
                .map(PathBuf::from)
                .find(|path| {
                    path.extension()
                        .is_some_and(|extension| extension == "wasm")
                })
        })
}

/// Both freshly compiled and cached artifacts retain Cargo's configured output path.
#[test]
fn resolves_guest_artifacts_in_custom_target_directories() {
    for fresh in [false, true] {
        let output = format!(
            r#"{{"reason":"compiler-artifact","target":{{"name":"dependency"}},"filenames":["/wrong.wasm"]}}
{{"reason":"compiler-artifact","target":{{"name":"fx_module_test_module"}},"fresh":{fresh},"filenames":["/shared target/wasm32-unknown-unknown/debug/fx_module_test_module.wasm"]}}
{{"reason":"build-finished","success":true}}"#
        );
        assert_eq!(
            guest_artifact_path(output.as_bytes()),
            Some(PathBuf::from(
                "/shared target/wasm32-unknown-unknown/debug/fx_module_test_module.wasm"
            ))
        );
    }
}

/// Missing or unrelated artifacts cannot silently fall back to a stale fixture.
#[test]
fn rejects_output_without_a_guest_wasm_artifact() {
    assert_eq!(
        guest_artifact_path(
            b"cargo wrapper notice\n{\"reason\":\"build-finished\",\"success\":true}"
        ),
        None
    );
}
