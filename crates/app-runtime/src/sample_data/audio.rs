// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! External tracks copied into each sample show's own media directory.

use std::{
    io::Read,
    path::{Path, PathBuf},
};

use crate::systems::showfile_events::InitialShowfileAsset;

/// Associates a packaged audio filename with its show-relative timeline path.
pub(crate) struct SampleAudio {
    /// Filename beneath the application's sample-audio resource directory.
    pub filename: &'static str,
    /// Destination within each newly created sample show.
    pub relative_path: &'static str,
}

/// Stable filenames allow replacing packaged tracks without rebuilding Rust.
pub(crate) const SAMPLE_AUDIO: &[SampleAudio] = &[
    SampleAudio {
        filename: "lofi.mp3",
        relative_path: "timeline-audio/098145c1934b4ed6b20078df6c6da180/lofi.mp3",
    },
    SampleAudio {
        filename: "rap.mp3",
        relative_path: "timeline-audio/87db6c536c244243894b725cef5e6301/rap.mp3",
    },
];

/// Resolve desktop resources, a standalone executable's sidecar, or development source assets.
pub(crate) fn sample_audio_directory(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(root) = resource_dir {
        return Ok(root.join("sample-audio"));
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let directory = executable
        .parent()
        .ok_or("Executable has no parent directory")?
        .join("sample-audio");
    if directory.is_dir() {
        return Ok(directory);
    }
    #[cfg(debug_assertions)]
    return Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample-audio"));
    #[cfg(not(debug_assertions))]
    Ok(directory)
}

/// Validate current resource files on each creation so missing LFS data cannot become show audio.
pub(crate) fn sample_audio_assets(directory: &Path) -> Result<Vec<InitialShowfileAsset>, String> {
    SAMPLE_AUDIO.iter().map(|asset| {
        let source_path = directory.join(asset.filename);
        let mut header = Vec::new();
        std::fs::File::open(&source_path)
            .and_then(|file| file.take(64).read_to_end(&mut header))
            .map_err(|error| format!("Cannot read sample audio {}: {error}. Install the sample-audio resources (development: git lfs pull).", source_path.display()))?;
        if header.is_empty() || header.starts_with(b"version https://git-lfs.github.com/spec/v1") {
            return Err(format!("Sample audio {} is empty or an unresolved Git LFS pointer. Install the sample-audio resources (development: git lfs pull).", source_path.display()));
        }
        Ok(InitialShowfileAsset { relative_path: asset.relative_path, source_path })
    }).collect()
}
