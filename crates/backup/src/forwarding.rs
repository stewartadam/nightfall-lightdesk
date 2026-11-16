// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The primary's side of command forwarding: a bounded journal of the live commands it
//! accepted, which a following backup reads in order.
//!
//! Entries keep the engine's forwarding sequence numbers. A checkpoint records the newest
//! number it reflects, and every batch and checkpoint names the primary's session, so a backup
//! that follows a restarted primary starts counting again instead of waiting for numbers the
//! new process will take a long time to reach.

use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bevy_ecs::prelude::*;
use nightfall_actions::ActionSurface;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

/// Entries the journal keeps for a backup that falls behind.
const JOURNAL_CAPACITY: usize = 4096;

/// How long after a backup's last request the primary keeps recording commands for it.
const READER_TIMEOUT: Duration = Duration::from_secs(15);

/// Live state section key naming the commands a checkpoint reflects.
pub const COMMANDS_LIVE_STATE: &str = "commands";

/// Reads which forwarded commands a checkpoint reflects, if it says.
pub fn commands_through(snapshot: &LiveStateSnapshot) -> Option<CommandsThrough> {
    serde_json::from_value(snapshot.sections.get(COMMANDS_LIVE_STATE)?.clone()).ok()
}

/// Identifies this primary process, so a backup notices when the primary restarted.
pub fn primary_session() -> u64 {
    static SESSION: OnceLock<u64> = OnceLock::new();
    *SESSION.get_or_init(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos() as u64);
        nanos ^ (u64::from(std::process::id()) << 32)
    })
}

/// Which primary session and forwarded commands a checkpoint reflects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandsThrough {
    /// The primary's session.
    pub session: u64,
    /// The newest forwarded sequence number whose effect the checkpoint includes.
    pub sequence: u64,
}

/// Where a backup has read the journal up to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardCursor {
    /// The primary session the backup has been reading.
    pub session: u64,
    /// The newest sequence number the backup has received.
    pub after: u64,
}

/// Forwarded entries after a backup's cursor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedBatch {
    /// The primary's session.
    pub session: u64,
    /// Entries newer than the cursor, oldest first, with their sequence numbers.
    pub entries: Vec<(u64, ForwardedEntry)>,
    /// The cursor for the next request: the newest entry sent, or the position a fresh reader
    /// starts from.
    pub latest: u64,
    /// Whether entries the backup needed are gone, because they were dropped or the primary
    /// restarted, so it must wait for a checkpoint before replaying more.
    pub gap: bool,
}

/// Recorded entries in sequence order, bounded to [`JOURNAL_CAPACITY`].
#[derive(Debug, Default)]
struct Journal {
    entries: VecDeque<(u64, ForwardedEntry)>,
    /// Newest sequence number dropped to keep the journal bounded.
    dropped_through: u64,
}

/// The process-wide journal and a signal for waiting readers.
pub struct ForwardJournal {
    journal: Mutex<Journal>,
    appended: tokio::sync::Notify,
    /// When a backup last asked for commands or a checkpoint.
    last_reader: Mutex<Option<Instant>>,
}

impl ForwardJournal {
    /// Creates an empty journal with no reader.
    fn new() -> Self {
        Self {
            journal: Mutex::new(Journal::default()),
            appended: tokio::sync::Notify::new(),
            last_reader: Mutex::new(None),
        }
    }

    /// Records that a backup is reading, which keeps the primary recording commands for it.
    pub fn note_reader(&self) {
        if let Ok(mut last_reader) = self.last_reader.lock() {
            *last_reader = Some(Instant::now());
        }
    }

    /// Returns whether a backup has read recently.
    fn has_reader(&self) -> bool {
        self.last_reader
            .lock()
            .ok()
            .and_then(|last_reader| *last_reader)
            .is_some_and(|last| last.elapsed() < READER_TIMEOUT)
    }

    /// Appends entries in sequence order and wakes waiting readers.
    fn append(&self, entries: impl IntoIterator<Item = (u64, ForwardedEntry)>) {
        let Ok(mut journal) = self.journal.lock() else {
            return;
        };
        let before = journal.entries.len();
        journal.entries.extend(entries);
        while journal.entries.len() > JOURNAL_CAPACITY {
            if let Some((sequence, _)) = journal.entries.pop_front() {
                journal.dropped_through = sequence;
            }
        }
        let appended = journal.entries.len() != before;
        drop(journal);
        if appended {
            self.appended.notify_waiters();
        }
    }

    /// Returns entries after `cursor`, or `None` when there are none yet.
    ///
    /// A cursor from another session, or none at all, answers at once with the current
    /// position and no entries, so the backup starts from the commands that follow its next
    /// checkpoint.
    fn after(&self, cursor: Option<ForwardCursor>) -> Option<ForwardedBatch> {
        let journal = self.journal.lock().ok()?;
        let Some(ForwardCursor { after, .. }) =
            cursor.filter(|cursor| cursor.session == primary_session())
        else {
            return Some(self.batch(Vec::new(), latest_forwarded_sequence(), cursor.is_some()));
        };
        let entries: Vec<_> = journal
            .entries
            .iter()
            .filter(|(sequence, _)| *sequence > after)
            .cloned()
            .collect();
        let gap = journal.dropped_through > after;
        let latest = entries.last().map_or(after, |(sequence, _)| *sequence);
        (gap || !entries.is_empty()).then(|| self.batch(entries, latest, gap))
    }

    /// Builds a batch for this session.
    fn batch(&self, entries: Vec<(u64, ForwardedEntry)>, latest: u64, gap: bool) -> ForwardedBatch {
        ForwardedBatch {
            session: primary_session(),
            entries,
            latest,
            gap,
        }
    }

    /// Waits up to `wait` for entries after `cursor`, then answers with whatever is there.
    pub async fn wait_after(
        &self,
        cursor: Option<ForwardCursor>,
        wait: Duration,
    ) -> ForwardedBatch {
        self.note_reader();
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let appended = self.appended.notified();
            tokio::pin!(appended);
            appended.as_mut().enable();
            if let Some(batch) = self.after(cursor) {
                return batch;
            }
            if tokio::time::timeout_at(deadline, appended).await.is_err() {
                let after = cursor.map_or_else(latest_forwarded_sequence, |cursor| cursor.after);
                return self.batch(Vec::new(), after, false);
            }
        }
    }
}

/// Returns the process-wide journal.
pub fn forward_journal() -> &'static ForwardJournal {
    static JOURNAL: OnceLock<ForwardJournal> = OnceLock::new();
    JOURNAL.get_or_init(ForwardJournal::new)
}

/// Records commands while this host is a primary that a backup has read from recently, and
/// stops otherwise, so a desk without a backup does no forwarding work.
///
/// Runs first in every frame, so a world a show load swaps in records from its first frame.
pub(crate) fn update_forward_recording(
    state: Res<crate::BackupState>,
    mut forwarding: ResMut<CommandForwarding>,
) {
    let recording = !state.is_backup() && forward_journal().has_reader();
    if forwarding.is_recording() != recording {
        forwarding.set_recording(recording);
    }
}

/// Moves the commands the engine recorded this frame into the journal, leaving out those a
/// backup's own timelines reproduce.
pub(crate) fn publish_forwarded_commands(mut forwarding: ResMut<CommandForwarding>) {
    let recorded = forwarding.take_recorded();
    if recorded.is_empty() {
        return;
    }
    forward_journal().append(recorded.into_iter().filter_map(|recorded| {
        let from_timeline = matches!(
            &recorded.origin,
            Some(CommandOrigin::Automation { surface, .. })
                if surface == ActionSurface::Timeline.label()
        );
        (!from_timeline).then_some((recorded.sequence, recorded.entry))
    }));
}

/// Records which forwarded commands a checkpoint reflects: every one recorded before it.
pub(crate) fn capture_commands_through(_world: &mut World) -> CommandsThrough {
    CommandsThrough {
        session: primary_session(),
        sequence: latest_forwarded_sequence(),
    }
}

/// Leaves the commands section to the backup's tracking, which reads it before restoring.
pub(crate) fn restore_commands_through(
    _world: &mut World,
    _through: CommandsThrough,
    _context: LiveStateRestore,
) {
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a forwarded update with `value`.
    fn entry(value: u64) -> ForwardedEntry {
        ForwardedEntry::Update {
            module: "TestUpdate".to_string(),
            update: serde_json::json!(value),
        }
    }

    /// A reader gets entries after its cursor, and a gap once the entries it needs were dropped.
    #[test]
    fn journal_reads_after_a_cursor_and_reports_gaps() {
        let journal = ForwardJournal::new();
        let cursor = |after| {
            Some(ForwardCursor {
                session: primary_session(),
                after,
            })
        };
        journal.append([(1, entry(1)), (2, entry(2)), (3, entry(3))]);
        let batch = journal.after(cursor(1)).expect("entries after 1");
        assert_eq!(batch.entries, vec![(2, entry(2)), (3, entry(3))]);
        assert_eq!(batch.latest, 3);
        assert!(!batch.gap);
        assert!(journal.after(cursor(3)).is_none());

        journal.append(
            (4..=(JOURNAL_CAPACITY as u64 + 3)).map(|sequence| (sequence, entry(sequence))),
        );
        assert!(journal.after(cursor(1)).expect("gap after 1").gap);
    }

    /// A cursor from an earlier primary session gets no entries and a gap, so the backup waits
    /// for a checkpoint from the restarted primary.
    #[test]
    fn journal_refuses_a_cursor_from_another_session() {
        let journal = ForwardJournal::new();
        journal.append([(1, entry(1))]);
        let batch = journal
            .after(Some(ForwardCursor {
                session: primary_session().wrapping_add(1),
                after: 0,
            }))
            .expect("an answer");
        assert!(batch.entries.is_empty());
        assert!(batch.gap);
    }
}
