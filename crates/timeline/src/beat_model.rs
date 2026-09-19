// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Beat This model inference for beatgrid detection.

use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use sha2::{Digest, Sha256};

/// Immutable model identity shared by the downloader and inference path.
#[derive(Debug, serde::Deserialize)]
pub struct ModelManifest {
    /// Stable cache directory identifier for these weights.
    pub version: String,
    /// Immutable upstream source used only after consent.
    pub url: String,
    /// Expected SHA-256 digest of the downloaded bytes.
    pub sha256: String,
    /// Exact transfer size used to bound and validate downloads.
    pub size_bytes: u64,
}

/// Return the pinned model metadata compiled into this application version.
pub fn manifest() -> &'static ModelManifest {
    static MANIFEST: OnceLock<ModelManifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        serde_json::from_str(include_str!("../../../config/beat-this-model.json"))
            .expect("valid embedded model manifest")
    })
}

/// Locate this model version inside persistent application data, outside installed resources.
pub fn path_in(data_dir: &Path) -> PathBuf {
    data_dir
        .join("models/beat-this")
        .join(&manifest().version)
        .join("beat_this.onnx")
}

/// Resolve the configured application-data location for the optional model.
pub fn model_path() -> Result<PathBuf, String> {
    nightfall::nightfall_data_dir()
        .map(|dir| path_in(&dir))
        .ok_or_else(|| "Application data directory unavailable".into())
}

/// Reject truncated or substituted weights before installation or inference.
pub fn verify(path: &Path, size: u64, digest: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() != size {
        return Err("Beat detection model has an unexpected size".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != digest {
        return Err("Beat detection model checksum mismatch".into());
    }
    Ok(())
}
