// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Remembers which usage reports were already sent today, so each is sent at most once a day.

use std::{collections::BTreeMap, path::PathBuf};

use nightfall_websocket::host_preferences::{
    LoadedPreferences, load_preferences, save_preferences,
};
use serde::{Deserialize, Serialize};

/// Most shows remembered; the ones checked longest ago are forgotten first.
const MAX_REMEMBERED_SHOWS: usize = 100;

/// What was last sent for one show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ShowRecord {
    /// UTC day (`YYYY-MM-DD`) the show was last checked for changes.
    pub(super) checked_on: String,
    /// Fingerprint of the last snapshot sent for the show.
    pub(super) fingerprint: u64,
}

/// Days on which reports were sent, for one install identifier.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
struct StoredSchedule {
    install_id: String,
    app_started_on: Option<String>,
    shows: BTreeMap<String, ShowRecord>,
}

/// The persisted schedule. Sends are recorded even when saving fails, so a session never
/// repeats a report; only the next session might.
#[derive(Debug)]
pub(super) struct Schedule {
    path: PathBuf,
    stored: StoredSchedule,
}

impl Schedule {
    /// Reads the schedule from `path`; a missing or damaged file starts empty.
    pub(super) fn load(path: PathBuf) -> Self {
        let stored = match load_preferences::<StoredSchedule>(&path) {
            LoadedPreferences::Loaded(stored) => stored,
            LoadedPreferences::Missing => StoredSchedule::default(),
            LoadedPreferences::Unreadable(error) => {
                tracing::debug!(%error, "Usage report schedule is unreadable; starting afresh");
                StoredSchedule::default()
            }
        };
        Self { path, stored }
    }

    /// Forgets every send when the install identifier changed, since reports under a new
    /// identifier count as a new install.
    fn follow_install_id(&mut self, install_id: &str) {
        if self.stored.install_id != install_id {
            self.stored = StoredSchedule {
                install_id: install_id.to_string(),
                ..Default::default()
            };
        }
    }

    /// Returns whether `app_started` is still due on `today` for `install_id`.
    pub(super) fn app_started_due(&mut self, install_id: &str, today: &str) -> bool {
        self.follow_install_id(install_id);
        self.stored.app_started_on.as_deref() != Some(today)
    }

    /// Records that `app_started` was sent on `today`.
    pub(super) fn record_app_started(&mut self, today: &str) {
        self.stored.app_started_on = Some(today.to_string());
        self.save();
    }

    /// Returns whether the show under `show_key` has not been checked yet on `today`.
    pub(super) fn show_due(&mut self, install_id: &str, show_key: &str, today: &str) -> bool {
        self.follow_install_id(install_id);
        self.stored
            .shows
            .get(show_key)
            .is_none_or(|record| record.checked_on != today)
    }

    /// Returns whether a show's snapshot differs from the last one sent for it, which is when
    /// a new snapshot should go out.
    pub(super) fn show_changed(&self, show_key: &str, fingerprint: u64) -> bool {
        self.stored
            .shows
            .get(show_key)
            .is_none_or(|record| record.fingerprint != fingerprint)
    }

    /// Records today's check of a show along with the fingerprint of the snapshot now on
    /// record for it, forgetting the shows checked longest ago beyond the limit.
    pub(super) fn record_show_check(&mut self, show_key: &str, today: &str, fingerprint: u64) {
        self.stored.shows.insert(
            show_key.to_string(),
            ShowRecord {
                checked_on: today.to_string(),
                fingerprint,
            },
        );
        while self.stored.shows.len() > MAX_REMEMBERED_SHOWS {
            let oldest = self
                .stored
                .shows
                .iter()
                .min_by(|left, right| left.1.checked_on.cmp(&right.1.checked_on))
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                self.stored.shows.remove(&oldest);
            }
        }
        self.save();
    }

    /// Forgets every recorded send, so reports go out afresh once sharing is turned back on
    /// after reports still waiting in the queue were discarded.
    pub(super) fn forget(&mut self) {
        self.stored.app_started_on = None;
        self.stored.shows.clear();
        self.save();
    }

    /// Writes the schedule, logging rather than surfacing failures: at worst a later session
    /// sends one report again.
    fn save(&self) {
        if let Err(error) = save_preferences(&self.path, &self.stored) {
            tracing::debug!(%error, "Could not save the usage report schedule");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `app_started` is due once per day, survives a restart, and is due again for a new
    /// install identifier.
    #[test]
    fn app_started_is_due_once_per_day_and_install() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schedule.json");
        let mut schedule = Schedule::load(path.clone());
        assert!(schedule.app_started_due("a", "2026-10-10"));
        schedule.record_app_started("2026-10-10");

        let mut schedule = Schedule::load(path);
        assert!(!schedule.app_started_due("a", "2026-10-10"));
        assert!(schedule.app_started_due("a", "2026-10-11"));
        assert!(schedule.app_started_due("b", "2026-10-10"));
    }

    /// A show is checked once a day and its snapshot goes out only when it changed since the
    /// last one sent.
    #[test]
    fn show_snapshots_go_out_only_when_changed() {
        let directory = tempfile::tempdir().unwrap();
        let mut schedule = Schedule::load(directory.path().join("schedule.json"));
        assert!(schedule.show_due("a", "show", "2026-10-10"));
        assert!(schedule.show_changed("show", 1));
        schedule.record_show_check("show", "2026-10-10", 1);
        assert!(!schedule.show_due("a", "show", "2026-10-10"));

        assert!(schedule.show_due("a", "show", "2026-10-11"));
        assert!(!schedule.show_changed("show", 1));
        assert!(schedule.show_changed("show", 2));
        assert!(schedule.show_due("a", "other", "2026-10-12"));
    }

    /// Forgetting makes every report due again, including after a restart.
    #[test]
    fn forgetting_makes_reports_due_again() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schedule.json");
        let mut schedule = Schedule::load(path.clone());
        assert!(schedule.app_started_due("a", "2026-10-10"));
        schedule.record_app_started("2026-10-10");
        schedule.record_show_check("show", "2026-10-10", 1);
        schedule.forget();

        let mut schedule = Schedule::load(path);
        assert!(schedule.app_started_due("a", "2026-10-10"));
        assert!(schedule.show_due("a", "show", "2026-10-10"));
        assert!(schedule.show_changed("show", 1));
    }

    /// The oldest checked shows are forgotten beyond the limit.
    #[test]
    fn forgets_the_oldest_shows_beyond_the_limit() {
        let directory = tempfile::tempdir().unwrap();
        let mut schedule = Schedule::load(directory.path().join("schedule.json"));
        schedule.follow_install_id("a");
        schedule.record_show_check("oldest", "2026-10-01", 1);
        for index in 0..MAX_REMEMBERED_SHOWS {
            schedule.record_show_check(&format!("show-{index}"), "2026-10-02", 1);
        }
        assert_eq!(schedule.stored.shows.len(), MAX_REMEMBERED_SHOWS);
        assert!(!schedule.stored.shows.contains_key("oldest"));
    }
}
