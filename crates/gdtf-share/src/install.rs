// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Downloads GDTF Share revisions into the fixture library folder.
//!
//! The fixture library watches its folder, so a saved archive appears in the library
//! without any further step.

use std::io::{Cursor, Write};
use std::path::Path;

use serde::Serialize;

use crate::account::{AccountError, GdtfShareAccount};
use crate::catalog::GdtfShareFixture;

/// The library file an install wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct GdtfShareInstall {
    /// File name inside the fixture library folder.
    pub file_name: String,
}

/// How much of an install's download has arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct GdtfShareDownloadProgress {
    /// Bytes received so far.
    pub received: u32,
    /// Expected size in bytes: what GDTF Share announced, or else the size its list gave.
    pub total: u32,
}

/// Why an install failed, worded for the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct GdtfShareInstallFailure {
    /// What went wrong, shown to the user as is.
    pub message: String,
    /// Whether it failed only because no account is signed in.
    pub signed_out: bool,
}

/// One line of an install's reply, which streams the download's progress and ends with
/// the outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum GdtfShareInstallEvent {
    /// More of the download arrived.
    Progress(GdtfShareDownloadProgress),
    /// The archive is saved in the library folder.
    Installed(GdtfShareInstall),
    /// The install stopped; nothing was saved.
    Failed(GdtfShareInstallFailure),
}

/// Downloads `fixture` and saves it in `library_dir` under GDTF Share's own file name.
///
/// A reply that is not a GDTF archive is refused before anything is written. The file is
/// written under a temporary name first, so the library never reads half an archive. An
/// earlier download of the same revision is replaced. `progress` hears how much of the
/// download has arrived after each chunk.
pub async fn install(
    account: &GdtfShareAccount,
    library_dir: &Path,
    fixture: &GdtfShareFixture,
    progress: &(dyn Fn(GdtfShareDownloadProgress) + Sync),
) -> Result<GdtfShareInstall, AccountError> {
    let rid = fixture.rid;
    let listed_size = u64::from(fixture.file_size);
    /// Clamps a byte count into the `u32` the UI receives.
    fn bytes_u32(bytes: u64) -> u32 {
        u32::try_from(bytes).unwrap_or(u32::MAX)
    }
    let report = |received: u64, length: Option<u64>| {
        let total = length.unwrap_or(listed_size).max(received);
        progress(GdtfShareDownloadProgress {
            received: bytes_u32(received),
            total: bytes_u32(total),
        });
    };
    let report = &report;
    let bytes = account
        .with_session(|client, session| async move { client.download(&session, rid, report).await })
        .await?;
    let file_name = fixture.file_name();
    let path = library_dir.join(&file_name);
    tokio::task::spawn_blocking(move || {
        check_archive(&bytes)?;
        save(&path, &bytes).map_err(|error| AccountError::Storage(error.to_string()))
    })
    .await
    .map_err(|error| AccountError::Storage(error.to_string()))??;
    tracing::info!(rid, file_name, "Installed a GDTF Share fixture");
    Ok(GdtfShareInstall { file_name })
}

/// Checks that `bytes` are a zip archive holding a GDTF `description.xml`.
fn check_archive(bytes: &[u8]) -> Result<(), AccountError> {
    let archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| {
        AccountError::Share(crate::client::ShareError::Protocol(
            "the download is not a GDTF archive".into(),
        ))
    })?;
    if archive.index_for_name("description.xml").is_none() {
        return Err(AccountError::Share(crate::client::ShareError::Protocol(
            "the download has no GDTF description".into(),
        )));
    }
    Ok(())
}

/// Writes `bytes` to `path` through a uniquely named temporary file in the same folder.
///
/// The temporary file is hidden and lacks the `.gdtf` extension the library scans for, and
/// each install gets its own, so overlapping installs of one revision never interleave.
fn save(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let folder = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(folder)?;
    let mut partial = tempfile::Builder::new()
        .prefix(".gdtf-share-")
        .suffix(".part")
        .tempfile_in(folder)?;
    partial.write_all(bytes)?;
    partial.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests;
