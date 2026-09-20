// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/// Validate bundled media before compiling it into the app, then prepare desktop resources.
fn main() {
    let manifest_dir = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"),
    );
    for name in ["lofi.mp3", "rap.mp3"] {
        let path = manifest_dir.join("assets/sample-audio").join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        let bytes = std::fs::read(&path).unwrap_or_else(|error| {
            panic!(
                "Cannot read sample audio {}: {error}. Install Git LFS and run `git lfs pull`.",
                path.display()
            )
        });
        assert!(
            !bytes.is_empty() && !bytes.starts_with(b"version https://git-lfs.github.com/spec/v1"),
            "Sample audio {} is empty or an unresolved Git LFS pointer. Run `git lfs pull` before building.",
            path.display()
        );
    }

    #[cfg(feature = "tauri")]
    tauri_build::build()
}
