// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The GDTF Share fixture list, saved on disk so it can be searched offline.
//!
//! The full list is a few megabytes, so it is fetched once and saved next to the
//! fixture library rather than fetched per search. A saved list older than a day is
//! still searched while a newer one is fetched in the background.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};

use crate::account::{AccountError, GdtfShareAccount};
use crate::client::ShareEntry;

mod search;

pub use search::GdtfShareSearchResults;

/// How long a fetched list is used before a newer one is fetched.
const REFRESH_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

/// How long searches wait after a failed background fetch before trying again, so a
/// changed password or an outage does not send GDTF Share a login per keystroke.
const RETRY_AFTER: Duration = Duration::from_secs(15 * 60);

/// Name of the saved list, in the Nightfall data folder next to `fixtures/`.
pub const CATALOG_FILE_NAME: &str = "gdtf-share-catalog.json";

/// One fixture revision on GDTF Share, as clients show it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct GdtfShareFixture {
    /// Revision id, which installs name.
    pub rid: u32,
    /// GDTF fixture type id, shared by every revision of a fixture type.
    pub fixture_type_id: Option<String>,
    /// Manufacturer name.
    pub manufacturer: String,
    /// Fixture name.
    pub fixture: String,
    /// Revision text the uploader gave.
    pub revision: String,
    /// DMX modes, in the order GDTF Share lists them.
    pub modes: Vec<GdtfShareMode>,
    /// Average user rating out of 5, when anyone has rated it.
    pub rating: Option<f32>,
    /// Whether the manufacturer uploaded this revision.
    pub manufacturer_upload: bool,
    /// When the revision was last changed, in Unix seconds.
    pub last_modified: u32,
    /// Archive size in bytes.
    pub file_size: u32,
}

/// One DMX mode of a GDTF Share fixture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct GdtfShareMode {
    /// Mode name.
    pub name: String,
    /// DMX channels the mode uses.
    pub footprint: u32,
}

impl GdtfShareFixture {
    /// Converts a list entry, dropping a blank fixture type id and an unrated `N/A`.
    fn from_entry(entry: ShareEntry) -> Self {
        let rating = match &entry.rating {
            serde_json::Value::String(text) => text.trim().parse::<f32>().ok(),
            serde_json::Value::Number(number) => number.as_f64().map(|value| value as f32),
            _ => None,
        };
        Self {
            rid: entry.rid,
            fixture_type_id: entry
                .uuid
                .map(|uuid| uuid.trim().to_ascii_lowercase())
                .filter(|uuid| !uuid.is_empty()),
            manufacturer: entry.manufacturer.trim().to_string(),
            fixture: entry.fixture.trim().to_string(),
            revision: entry.revision.trim().to_string(),
            modes: entry
                .modes
                .into_iter()
                .map(|mode| GdtfShareMode {
                    name: mode.name,
                    footprint: mode.dmxfootprint,
                })
                .collect(),
            rating,
            manufacturer_upload: entry
                .uploader
                .trim_end_matches('.')
                .eq_ignore_ascii_case("manuf"),
            last_modified: u32::try_from(entry.last_modified).unwrap_or(u32::MAX),
            file_size: u32::try_from(entry.filesize).unwrap_or(u32::MAX),
        }
    }

    /// Returns the library file name for this revision: GDTF Share's own
    /// `Manufacturer@Fixture@Revision` naming plus the revision id, which keeps two
    /// revisions with the same names from replacing each other. Characters no file system
    /// allows are replaced by underscores.
    pub fn file_name(&self) -> String {
        /// Replaces path separators, reserved and control characters, and trims
        /// trailing dots and underscores, which Windows drops.
        fn part(text: &str) -> String {
            let cleaned: String = text
                .chars()
                .map(|character| match character {
                    ' ' | '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '@' => '_',
                    character if character.is_control() => '_',
                    character => character,
                })
                .collect();
            let trimmed = cleaned.trim_end_matches(['.', '_']).trim_start_matches('.');
            if trimmed.is_empty() {
                "unnamed".to_string()
            } else {
                trimmed.to_string()
            }
        }
        format!(
            "{}@{}@{}@{}.gdtf",
            part(&self.manufacturer),
            part(&self.fixture),
            part(&self.revision),
            self.rid
        )
    }
}

/// The list as saved on disk.
#[derive(Serialize, Deserialize)]
struct SavedCatalog {
    /// When the list was fetched, in Unix seconds.
    fetched_at: u64,
    /// Every listed revision.
    fixtures: Vec<GdtfShareFixture>,
}

/// A loaded list, with each fixture type's newest revision picked out for search.
pub struct Catalog {
    fetched_at: u64,
    revisions: HashMap<u32, GdtfShareFixture>,
    latest: Vec<search::Indexed>,
}

impl Catalog {
    /// Indexes `fixtures` fetched at `fetched_at`.
    ///
    /// Revisions of one fixture type share its id; those without one are grouped by
    /// manufacturer and fixture name. The most recently changed revision of each group
    /// is the one searched.
    fn new(fetched_at: u64, fixtures: Vec<GdtfShareFixture>) -> Self {
        let mut newest: HashMap<String, &GdtfShareFixture> = HashMap::new();
        for fixture in &fixtures {
            let key = fixture.fixture_type_id.clone().unwrap_or_else(|| {
                format!(
                    "{}\u{0}{}",
                    fixture.manufacturer.to_lowercase(),
                    fixture.fixture.to_lowercase()
                )
            });
            newest
                .entry(key)
                .and_modify(|current| {
                    if (fixture.last_modified, fixture.rid) > (current.last_modified, current.rid) {
                        *current = fixture;
                    }
                })
                .or_insert(fixture);
        }
        let latest = newest
            .into_values()
            .map(|fixture| search::Indexed::new(fixture.clone()))
            .collect();
        Self {
            fetched_at,
            revisions: fixtures
                .into_iter()
                .map(|fixture| (fixture.rid, fixture))
                .collect(),
            latest,
        }
    }

    /// Looks up any listed revision, including ones a newer revision hides from search.
    pub fn revision(&self, rid: u32) -> Option<&GdtfShareFixture> {
        self.revisions.get(&rid)
    }

    /// When the list was fetched, in Unix seconds.
    pub fn fetched_at(&self) -> u64 {
        self.fetched_at
    }

    /// Whether the list is old enough to fetch again.
    fn is_stale(&self, now: u64) -> bool {
        now.saturating_sub(self.fetched_at) >= REFRESH_AFTER.as_secs()
    }
}

/// Returns the current time in Unix seconds.
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// The saved list, loaded from disk on first use and fetched again when stale.
pub struct GdtfShareCatalog {
    path: PathBuf,
    /// `None` until the saved file has been read; then the list, if there is one.
    current: RwLock<Option<Option<Arc<Catalog>>>>,
    /// Held while fetching, so overlapping searches fetch the list once.
    fetching: Mutex<()>,
    /// Set while a background fetch runs, so searches start at most one.
    refreshing: AtomicBool,
    /// When the last background fetch failed, in Unix seconds, or 0.
    refresh_failed_at: AtomicU64,
}

impl GdtfShareCatalog {
    /// A catalog saved at `path`.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            current: RwLock::new(None),
            fetching: Mutex::new(()),
            refreshing: AtomicBool::new(false),
            refresh_failed_at: AtomicU64::new(0),
        }
    }

    /// Fetches a newer list than the one fetched at `older_than` without waiting for it.
    ///
    /// Searches keep using the older list until the fetch finishes. A failed fetch is
    /// logged, and stale searches try again once [`RETRY_AFTER`] has passed.
    pub fn refresh_in_background(
        self: &Arc<Self>,
        account: Arc<GdtfShareAccount>,
        older_than: u64,
    ) {
        let failed_at = self.refresh_failed_at.load(Ordering::Acquire);
        if now().saturating_sub(failed_at) < RETRY_AFTER.as_secs()
            || self.refreshing.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let catalog = self.clone();
        tokio::spawn(async move {
            let failed_at = match catalog.fetch(&account, Some(older_than)).await {
                Ok(_) => 0,
                Err(error) => {
                    tracing::warn!(%error, "Could not refresh the GDTF Share fixture list");
                    now()
                }
            };
            catalog
                .refresh_failed_at
                .store(failed_at, Ordering::Release);
            catalog.refreshing.store(false, Ordering::Release);
        });
    }

    /// Returns the list in memory, reading the saved file the first time.
    ///
    /// An unreadable saved file counts as no list, so the next search fetches a new one.
    pub async fn current(&self) -> Option<Arc<Catalog>> {
        if let Some(current) = self.current.read().await.as_ref() {
            return current.clone();
        }
        let mut current = self.current.write().await;
        if let Some(loaded) = current.as_ref() {
            return loaded.clone();
        }
        let path = self.path.clone();
        let loaded = tokio::task::spawn_blocking(move || read_saved(&path))
            .await
            .ok()
            .flatten()
            .map(Arc::new);
        *current = Some(loaded.clone());
        loaded
    }

    /// Returns the list to search, fetching it when there is none yet.
    ///
    /// A stale list is returned as is, and `refresh_stale` is told to fetch a newer one.
    pub async fn for_search(
        &self,
        account: &GdtfShareAccount,
    ) -> Result<(Arc<Catalog>, bool), AccountError> {
        match self.current().await {
            Some(catalog) => {
                let stale = catalog.is_stale(now());
                Ok((catalog, stale))
            }
            None => Ok((self.fetch(account, None).await?, false)),
        }
    }

    /// Fetches the list from GDTF Share, saves it and makes it current.
    ///
    /// When another fetch finished while this one waited its turn, its list is used
    /// instead of fetching again; `older_than` is the fetch time a caller wants replaced.
    pub async fn fetch(
        &self,
        account: &GdtfShareAccount,
        older_than: Option<u64>,
    ) -> Result<Arc<Catalog>, AccountError> {
        let _fetching = self.fetching.lock().await;
        if let Some(current) = self.current().await
            && older_than.is_none_or(|older_than| current.fetched_at > older_than)
            && !current.is_stale(now())
        {
            return Ok(current);
        }
        let entries = account
            .with_session(|client, session| async move { client.list(&session).await })
            .await?;
        let path = self.path.clone();
        let catalog = tokio::task::spawn_blocking(move || {
            let saved = SavedCatalog {
                fetched_at: now(),
                fixtures: entries
                    .into_iter()
                    .map(GdtfShareFixture::from_entry)
                    .collect(),
            };
            if let Err(error) = write_saved(&path, &saved) {
                tracing::warn!(%error, "Could not save the GDTF Share fixture list");
            }
            Catalog::new(saved.fetched_at, saved.fixtures)
        })
        .await
        .map_err(|error| AccountError::Storage(error.to_string()))?;
        let catalog = Arc::new(catalog);
        tracing::info!(
            revisions = catalog.revisions.len(),
            fixtures = catalog.latest.len(),
            "Fetched the GDTF Share fixture list"
        );
        *self.current.write().await = Some(Some(catalog.clone()));
        Ok(catalog)
    }
}

/// Reads the saved list at `path`, or `None` when it is missing or unreadable.
fn read_saved(path: &std::path::Path) -> Option<Catalog> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "Could not read the saved GDTF Share list");
            return None;
        }
    };
    match serde_json::from_slice::<SavedCatalog>(&bytes) {
        Ok(saved) => Some(Catalog::new(saved.fetched_at, saved.fixtures)),
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "Ignoring an unreadable saved GDTF Share list");
            None
        }
    }
}

/// Saves `catalog` to `path` through a temporary file, so a crash never leaves half a list.
fn write_saved(path: &std::path::Path, catalog: &SavedCatalog) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension("json.part");
    std::fs::write(&partial, serde_json::to_vec(catalog)?)?;
    std::fs::rename(&partial, path)
}

#[cfg(test)]
mod tests;
