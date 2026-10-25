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

/// Downloads `fixture` and saves it in `library_dir` under GDTF Share's own file name.
///
/// A reply that is not a GDTF archive is refused before anything is written. The file is
/// written under a temporary name first, so the library never reads half an archive. An
/// earlier download of the same revision is replaced.
pub async fn install(
    account: &GdtfShareAccount,
    library_dir: &Path,
    fixture: &GdtfShareFixture,
) -> Result<GdtfShareInstall, AccountError> {
    let rid = fixture.rid;
    let bytes = account
        .with_session(|client, session| async move { client.download(&session, rid).await })
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
