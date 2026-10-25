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

use std::io::{Cursor, Read, Write};
use std::path::Path;

use quick_xml::Reader;
use quick_xml::events::Event;
use serde::Serialize;

use crate::account::{AccountError, GdtfShareAccount};
use crate::catalog::GdtfShareFixture;

/// The library file an install wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct GdtfShareInstall {
    /// File name inside the fixture library folder.
    pub file_name: String,
    /// Lowercase `FixtureTypeID` the archive declares, which the library reports for it.
    pub fixture_type_id: Option<String>,
}

/// How much of an install's download has arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct GdtfShareDownloadProgress {
    /// Bytes received so far.
    pub received: u32,
    /// Expected size in bytes: what GDTF Share announced, or else the size its list gave.
    /// Unknown when neither is given or the download has outgrown the listed size.
    pub total: Option<u32>,
}

impl GdtfShareDownloadProgress {
    /// Coarse step this report falls in: its whole percent of a known size, or each
    /// 64 KiB received of an unknown one. Reports in the same step look alike to the UI.
    pub fn step(&self) -> u32 {
        match self.total {
            Some(total) if total > 0 => {
                u32::try_from(u64::from(self.received) * 100 / u64::from(total)).unwrap_or(100)
            }
            _ => self.received >> 16,
        }
    }
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
    // Turns the client's byte counts into a progress report, trusting the listed size only
    // until the download outgrows it.
    let report = |received: u64, length: Option<u64>| {
        let total = length
            .or((listed_size > 0).then_some(listed_size))
            .filter(|total| *total >= received);
        progress(GdtfShareDownloadProgress {
            received: bytes_u32(received),
            total: total.map(bytes_u32),
        });
    };
    let report = &report;
    let bytes = account
        .with_session(|client, session| async move { client.download(&session, rid, report).await })
        .await?;
    let file_name = fixture.file_name();
    let path = library_dir.join(&file_name);
    let fixture_type_id = tokio::task::spawn_blocking(move || {
        let fixture_type_id = check_archive(&bytes)?;
        save(&path, &bytes).map_err(|error| AccountError::Storage(error.to_string()))?;
        Ok::<_, AccountError>(fixture_type_id)
    })
    .await
    .map_err(|error| AccountError::Storage(error.to_string()))??;
    tracing::info!(rid, file_name, "Installed a GDTF Share fixture");
    Ok(GdtfShareInstall {
        file_name,
        fixture_type_id,
    })
}

/// Checks that `bytes` are a zip archive holding a GDTF `description.xml`, and returns
/// the lowercase `FixtureTypeID` it declares, if any.
fn check_archive(bytes: &[u8]) -> Result<Option<String>, AccountError> {
    /// A download that is not a usable GDTF archive.
    fn not_gdtf(reason: &str) -> AccountError {
        AccountError::Share(crate::client::ShareError::Protocol(reason.into()))
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| not_gdtf("the download is not a GDTF archive"))?;
    let mut description = String::new();
    archive
        .by_name("description.xml")
        .map_err(|_| not_gdtf("the download has no GDTF description"))?
        .read_to_string(&mut description)
        .map_err(|_| not_gdtf("the download's GDTF description is unreadable"))?;
    Ok(fixture_type_id(&description))
}

/// Reads the `FixtureTypeID` attribute of the first `FixtureType` element, lowercased,
/// leaving out the nil id some exporters write.
fn fixture_type_id(description: &str) -> Option<String> {
    let mut reader = Reader::from_str(description);
    let fixture_type = loop {
        match reader.read_event().ok()? {
            Event::Start(element) | Event::Empty(element)
                if element.name().as_ref() == "FixtureType" =>
            {
                break element;
            }
            Event::Eof => return None,
            _ => {}
        }
    };
    let value = fixture_type
        .try_get_attribute("FixtureTypeID")
        .ok()??
        .normalized_value(quick_xml::XmlVersion::Implicit1_0)
        .ok()?;
    let id = value.trim().to_ascii_lowercase();
    (!id.is_empty()
        && id
            .chars()
            .any(|character| character.is_ascii_hexdigit() && character != '0'))
    .then_some(id)
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
