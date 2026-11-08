// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Finds newer GDTF Share revisions of the GDTF files in the fixture library.
//!
//! Every revision of a fixture type shares its `FixtureTypeID`, which GDTF Share lists too,
//! so a library file is matched to its fixture type's revisions by that id. Which of those
//! revisions the file is comes from the revision id saved when Nightfall installed it, or
//! else from its latest revision text, which GDTF Share lists as the revision's name.
//!
//! GDTF Share's change times are coarse (most revisions share one bulk import time), so a
//! revision only counts as newer when GDTF Share changed it strictly later. Updates come
//! from the same kind of uploader as the installed revision, so a manufacturer's file is
//! never "updated" to a user's edit of it, nor the other way round.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use nightfall_fixture_model::prelude::fixture_asset_etag;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::catalog::{Catalog, GdtfShareFixture};

/// Name of the saved install record, in the Nightfall data folder next to the list.
pub const INSTALLS_FILE_NAME: &str = "gdtf-share-installs.json";

/// A GDTF file in the fixture library, as a client describes it for an update check.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[typeshare::typeshare]
pub struct GdtfShareLibraryFixture {
    /// The library's fingerprint of the file.
    pub asset_etag: String,
    /// Lowercase `FixtureTypeID` the file declares.
    pub fixture_type_id: String,
    /// Text of the file's latest revision, if it has one.
    #[serde(default)]
    pub revision: Option<String>,
}

/// The library files a client asks about.
#[derive(Debug, Clone, Deserialize)]
#[typeshare::typeshare]
pub struct GdtfShareUpdateCheck {
    /// Library GDTF files that declare a fixture type id.
    pub fixtures: Vec<GdtfShareLibraryFixture>,
}

/// A newer GDTF Share revision of one library file.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[typeshare::typeshare]
pub struct GdtfShareUpdate {
    /// Fingerprint of the library file this update is for.
    pub asset_etag: String,
    /// The GDTF Share revision the library file is, or `None` when GDTF Share no longer
    /// lists it, which means it was replaced.
    pub installed: Option<GdtfShareFixture>,
    /// The newest revision to update to.
    pub latest: GdtfShareFixture,
    /// Fingerprint of another library file that already is the newest revision, if any.
    pub library_copy: Option<String>,
}

/// The outcome of an update check.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[typeshare::typeshare]
pub struct GdtfShareUpdates {
    /// One entry per library file with a newer revision on GDTF Share.
    pub updates: Vec<GdtfShareUpdate>,
}

/// Which GDTF Share revision a library file is.
enum Identified<'a> {
    /// A revision GDTF Share still lists.
    Listed(&'a GdtfShareFixture),
    /// A revision Nightfall installed that GDTF Share no longer lists.
    Removed,
}

/// Normalizes revision text for comparison, ignoring case and surrounding spaces.
fn revision_key(text: &str) -> String {
    text.trim().to_lowercase()
}

/// Whether `candidate` is newer than `current`: GDTF Share changed it strictly later.
fn is_newer(candidate: &GdtfShareFixture, current: &GdtfShareFixture) -> bool {
    candidate.last_modified > current.last_modified
}

/// Works out which listed revision `fixture` is: the one Nightfall recorded installing,
/// else the most recently changed revision of its type whose name matches the file's
/// latest revision text. A recorded revision GDTF Share dropped, with no listed revision
/// of the same name to fall back on, was replaced. `None` when nothing identifies it.
fn identify<'a>(
    catalog: &'a Catalog,
    installs: &HashMap<String, u32>,
    fixture: &GdtfShareLibraryFixture,
) -> Option<Identified<'a>> {
    let recorded = installs.get(&fixture.asset_etag).copied();
    if let Some(listed) = recorded
        .and_then(|rid| catalog.revision(rid))
        .filter(|listed| listed.fixture_type_id.as_deref() == Some(&fixture.fixture_type_id))
    {
        return Some(Identified::Listed(listed));
    }
    let by_name = fixture
        .revision
        .as_deref()
        .map(revision_key)
        .and_then(|key| {
            catalog
                .revisions_of_type(&fixture.fixture_type_id)
                .filter(|listed| revision_key(&listed.revision) == key)
                .max_by_key(|listed| (listed.last_modified, listed.rid))
        });
    match (by_name, recorded) {
        (Some(listed), _) => Some(Identified::Listed(listed)),
        (None, Some(rid)) if catalog.revision(rid).is_none() => Some(Identified::Removed),
        (None, _) => None,
    }
}

/// Finds the newest revision `fixture` should update to, if any.
///
/// A listed revision updates to its type's most recently changed revision from the same
/// kind of uploader, when that one changed strictly later. A replaced revision updates to
/// its type's most recently changed revision, preferring manufacturer uploads.
fn newest_for<'a>(
    catalog: &'a Catalog,
    fixture: &GdtfShareLibraryFixture,
    identified: &Identified<'a>,
) -> Option<&'a GdtfShareFixture> {
    let revisions = || catalog.revisions_of_type(&fixture.fixture_type_id);
    let newest = |manufacturer_upload: bool| {
        revisions()
            .filter(|listed| listed.manufacturer_upload == manufacturer_upload)
            .max_by_key(|listed| (listed.last_modified, listed.rid))
    };
    match identified {
        Identified::Listed(current) => {
            newest(current.manufacturer_upload).filter(|candidate| is_newer(candidate, current))
        }
        Identified::Removed => newest(true).or_else(|| newest(false)),
    }
}

/// Lists the newer GDTF Share revisions of `fixtures`, given the revision ids Nightfall
/// recorded installing by file fingerprint. Files nothing identifies are left out rather
/// than guessed at.
pub fn find_updates(
    catalog: &Catalog,
    installs: &HashMap<String, u32>,
    fixtures: &[GdtfShareLibraryFixture],
) -> GdtfShareUpdates {
    let identified: Vec<_> = fixtures
        .iter()
        .map(|fixture| identify(catalog, installs, fixture))
        .collect();
    let library_copies: HashMap<u32, &str> = fixtures
        .iter()
        .zip(&identified)
        .filter_map(|(fixture, identified)| match identified {
            Some(Identified::Listed(listed)) => Some((listed.rid, fixture.asset_etag.as_str())),
            _ => None,
        })
        .collect();
    let updates = fixtures
        .iter()
        .zip(&identified)
        .filter_map(|(fixture, identified)| {
            let identified = identified.as_ref()?;
            let latest = newest_for(catalog, fixture, identified)?;
            Some(GdtfShareUpdate {
                asset_etag: fixture.asset_etag.clone(),
                installed: match identified {
                    Identified::Listed(listed) => Some((*listed).clone()),
                    Identified::Removed => None,
                },
                latest: latest.clone(),
                library_copy: library_copies
                    .get(&latest.rid)
                    .map(|etag| (*etag).to_string()),
            })
        })
        .collect();
    GdtfShareUpdates { updates }
}

/// The GDTF Share revision id of every file Nightfall installed, by file fingerprint.
///
/// Keyed by fingerprint rather than file name, so renaming an installed file keeps its
/// record. Saved next to the fixture list. When no record is saved yet, it is rebuilt
/// from the library files whose names end in `@<rid>.gdtf`, as installs are named.
pub struct InstalledRevisions {
    path: PathBuf,
    library_dir: PathBuf,
    /// `None` until the saved record has been read.
    rids: Mutex<Option<HashMap<String, u32>>>,
}

impl InstalledRevisions {
    /// A record saved at `path` for installs into `library_dir`.
    pub fn new(path: PathBuf, library_dir: PathBuf) -> Self {
        Self {
            path,
            library_dir,
            rids: Mutex::new(None),
        }
    }

    /// Returns every recorded install, reading or rebuilding the record the first time.
    pub async fn rids(&self) -> HashMap<String, u32> {
        let mut rids = self.rids.lock().await;
        self.loaded(&mut rids).await.clone()
    }

    /// Records that the library file with fingerprint `asset_etag` is revision `rid`, and
    /// saves the record. A failed save is logged; the record stays in memory.
    pub async fn record(&self, asset_etag: String, rid: u32) {
        let mut rids = self.rids.lock().await;
        let loaded = self.loaded(&mut rids).await;
        if loaded.insert(asset_etag, rid) == Some(rid) {
            return;
        }
        let snapshot = loaded.clone();
        let path = self.path.clone();
        let saved = tokio::task::spawn_blocking(move || write_record(&path, &snapshot)).await;
        if let Ok(Err(error)) | Err(error) = saved.map_err(std::io::Error::other) {
            tracing::warn!(%error, "Could not save the GDTF Share install record");
        }
    }

    /// Fills `rids` from the saved record, or from the library's file names when none is
    /// saved, and returns it.
    async fn loaded<'a>(
        &self,
        rids: &'a mut Option<HashMap<String, u32>>,
    ) -> &'a mut HashMap<String, u32> {
        if rids.is_none() {
            let path = self.path.clone();
            let library_dir = self.library_dir.clone();
            let loaded = tokio::task::spawn_blocking(move || load_record(&path, &library_dir))
                .await
                .unwrap_or_default();
            *rids = Some(loaded);
        }
        rids.get_or_insert_with(HashMap::new)
    }
}

/// Reads the record at `path`. A missing record is rebuilt from `library_dir` and saved;
/// an unreadable one counts as empty.
fn load_record(path: &Path, library_dir: &Path) -> HashMap<String, u32> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            tracing::warn!(%error, path = %path.display(), "Ignoring an unreadable GDTF Share install record");
            HashMap::new()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let rebuilt = rebuild_record(library_dir);
            if let Err(error) = write_record(path, &rebuilt) {
                tracing::warn!(%error, "Could not save the GDTF Share install record");
            }
            rebuilt
        }
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "Could not read the GDTF Share install record");
            HashMap::new()
        }
    }
}

/// Fingerprints the library files named like installs, `…@<rid>.gdtf`, by revision id.
fn rebuild_record(library_dir: &Path) -> HashMap<String, u32> {
    let Ok(entries) = std::fs::read_dir(library_dir) else {
        return HashMap::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let rid = installed_rid(&entry.file_name().to_string_lossy())?;
            let bytes = std::fs::read(entry.path()).ok()?;
            Some((fixture_asset_etag(&bytes), rid))
        })
        .collect()
}

/// Reads the revision id from an install's file name, `Manufacturer@Fixture@Revision@rid.gdtf`.
fn installed_rid(file_name: &str) -> Option<u32> {
    let stem = file_name.strip_suffix(".gdtf")?;
    let (prefix, rid) = stem.rsplit_once('@')?;
    (prefix.matches('@').count() == 2)
        .then(|| rid.parse().ok())
        .flatten()
}

/// Saves `rids` to `path` through a temporary file, so a crash never leaves half a record.
fn write_record(path: &Path, rids: &HashMap<String, u32>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension("json.part");
    std::fs::write(&partial, serde_json::to_vec(rids)?)?;
    std::fs::rename(&partial, path)
}

#[cfg(test)]
mod tests;
