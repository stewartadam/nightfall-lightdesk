// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! What happened in this session, for debugging: every command the engine accepted, where it
//! came from and how it ended, alongside events domains record, such as a backup copying its
//! primary's show.
//!
//! The history lives for the whole process, so it survives the world swaps a show load causes,
//! and keeps only the newest [`HISTORY_CAPACITY`] entries. Clients read it with
//! [`SessionHistoryCommand::Read`] while they show it, so nothing is sent otherwise.

use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};

use crate::{
    command_lifecycle::{CommandResponder, FinishedCommand},
    prelude::*,
};

/// Entries the history keeps before dropping the oldest.
pub const HISTORY_CAPACITY: usize = 2_000;

/// Longest command description kept, in characters.
const MAX_SUMMARY_CHARS: usize = 400;

/// What kind of thing an entry records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum SessionHistoryKind {
    /// A command the engine accepted.
    Command,
    /// Something a domain recorded, such as a backup copying its primary's show.
    Event,
}

/// How a command ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct SessionHistoryOutcome {
    /// Whether the command did what it asked.
    pub succeeded: bool,
    /// Why it failed, when it did.
    pub message: Option<String>,
}

/// One thing that happened in this session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct SessionHistoryEntry {
    /// Increases with every entry.
    #[typeshare(serialized_as = "number")]
    pub id: u64,
    /// Increases whenever the entry is added or changes, as when its command finishes.
    #[typeshare(serialized_as = "number")]
    pub revision: u64,
    /// Unix time in milliseconds the entry was recorded.
    #[typeshare(serialized_as = "number")]
    pub at_ms: u64,
    /// Whether it is a command or an event.
    pub kind: SessionHistoryKind,
    /// Who submitted the command, such as `Web UI`, `MIDI` or `Primary`, or the domain that
    /// recorded the event, such as `Backup`.
    pub source: String,
    /// Command module, such as `ClipCommand`, or the event's subject.
    pub module: String,
    /// The command with its arguments, or the event's description.
    pub summary: String,
    /// How the command ended, or `None` while it runs and for events.
    pub outcome: Option<SessionHistoryOutcome>,
    /// The command's number in its primary's forwarded command sequence, on the primary that
    /// forwarded it and on the backup that replayed it, so the two histories line up.
    #[typeshare(serialized_as = "Option<number>")]
    pub forwarded_sequence: Option<u64>,
}

/// Entries changed since a client's last read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct SessionHistoryPage {
    /// Entries added or changed after the requested revision, oldest first.
    pub entries: Vec<SessionHistoryEntry>,
    /// Newest revision, to pass as `after` next time.
    #[typeshare(serialized_as = "number")]
    pub revision: u64,
    /// Identifies this engine process, whose history a restarted engine does not keep, so a
    /// client starts over when it changes.
    #[typeshare(serialized_as = "number")]
    pub session: u64,
    /// Id of the oldest entry still kept, so a client can drop the ones the history dropped.
    #[typeshare(serialized_as = "Option<number>")]
    pub oldest_id: Option<u64>,
}

/// Reads the session history.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum SessionHistoryCommand {
    /// Answers with the entries added or changed after revision `after`, or all of them.
    Read {
        /// Revision of the client's last read.
        #[typeshare(serialized_as = "Option<number>")]
        after: Option<u64>,
    },
}

impl IngressCommand for SessionHistoryCommand {}

/// The history's entries and the bookkeeping that attaches outcomes and forwarded numbers.
#[derive(Default)]
struct History {
    session: u64,
    entries: VecDeque<SessionHistoryEntry>,
    next_id: u64,
    revision: u64,
    /// Entry ids of commands that have not finished yet.
    running: HashMap<CommandId, u64>,
    /// Forwarded numbers of commands a backup is about to replay.
    forwarded: HashMap<CommandId, u64>,
}

impl History {
    /// Adds an entry, dropping the oldest when full, and returns its id.
    fn push(&mut self, mut entry: SessionHistoryEntry) -> u64 {
        self.next_id += 1;
        self.revision += 1;
        entry.id = self.next_id;
        entry.revision = self.revision;
        self.entries.push_back(entry);
        while self.entries.len() > HISTORY_CAPACITY {
            self.entries.pop_front();
        }
        // Commands that never finish leave their bookkeeping behind; trim it once it outgrows the
        // history, rather than on every push.
        if self.running.len() > HISTORY_CAPACITY {
            let oldest = self.entries.front().map_or(0, |entry| entry.id);
            self.running.retain(|_, id| *id >= oldest);
        }
        if self.forwarded.len() > HISTORY_CAPACITY {
            self.forwarded.clear();
        }
        self.next_id
    }

    /// Changes the entry with `id`, if it is still kept, and marks it changed.
    fn update(&mut self, id: u64, change: impl FnOnce(&mut SessionHistoryEntry)) {
        let Some(first) = self.entries.front().map(|entry| entry.id) else {
            return;
        };
        let Some(entry) = id
            .checked_sub(first)
            .and_then(|offset| self.entries.get_mut(offset as usize))
        else {
            return;
        };
        change(entry);
        self.revision += 1;
        entry.revision = self.revision;
    }

    /// Returns the entries changed after revision `after`.
    fn page(&self, after: Option<u64>) -> SessionHistoryPage {
        let after = after.unwrap_or(0);
        let mut entries: Vec<_> = self
            .entries
            .iter()
            .filter(|entry| entry.revision > after)
            .cloned()
            .collect();
        entries.sort_by_key(|entry| entry.id);
        SessionHistoryPage {
            entries,
            revision: self.revision,
            session: self.session,
            oldest_id: self.entries.front().map(|entry| entry.id),
        }
    }
}

/// The process-wide history.
static HISTORY: Mutex<Option<History>> = Mutex::new(None);

/// Runs `f` on the process-wide history.
fn with_history<R>(f: impl FnOnce(&mut History) -> R) -> R {
    let mut history = HISTORY
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(history.get_or_insert_with(|| History {
        session: now_ms(),
        ..History::default()
    }))
}

/// Returns the current Unix time in milliseconds.
fn now_ms() -> u64 {
    web_time::SystemTime::now()
        .duration_since(web_time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// Names who submitted a command, in a few words.
pub fn origin_label(origin: &CommandOrigin) -> String {
    match origin {
        CommandOrigin::WebUi => "Web UI".to_string(),
        CommandOrigin::Cli => "Command line".to_string(),
        CommandOrigin::Remote(source) => source.clone(),
        CommandOrigin::Automation { surface, source } => match source {
            Some(source) => format!("{surface}: {source}"),
            None => surface.clone(),
        },
    }
}

/// Collects formatted text up to [`MAX_SUMMARY_CHARS`] and refuses the rest, so a large command
/// is never formatted in full.
#[derive(Default)]
struct SummaryWriter {
    text: String,
    chars: usize,
    cut: bool,
}

impl std::fmt::Write for SummaryWriter {
    /// Appends `part` until the summary is full, then stops formatting with an error.
    fn write_str(&mut self, part: &str) -> std::fmt::Result {
        for character in part.chars() {
            if self.chars == MAX_SUMMARY_CHARS {
                self.cut = true;
                return Err(std::fmt::Error);
            }
            self.text.push(character);
            self.chars += 1;
        }
        Ok(())
    }
}

/// Formats a command's debug form, cut to [`MAX_SUMMARY_CHARS`] and marked when cut.
fn summarize(command: &impl std::fmt::Debug) -> String {
    let mut writer = SummaryWriter::default();
    let _ = std::fmt::Write::write_fmt(&mut writer, format_args!("{command:?}"));
    if writer.cut {
        writer.text.push('…');
    }
    writer.text
}

/// Cuts `text` to [`MAX_SUMMARY_CHARS`], marking the cut.
fn truncate(mut text: String) -> String {
    if let Some((cut, _)) = text.char_indices().nth(MAX_SUMMARY_CHARS) {
        text.truncate(cut);
        text.push('…');
    }
    text
}

/// Returns the last path segment of a type name, such as `ClipCommand`.
fn short_type_name<T>() -> &'static str {
    let name = std::any::type_name::<T>();
    let name = name.split('<').next().unwrap_or(name);
    name.rsplit("::").next().unwrap_or(name)
}

/// Records a command the engine accepted, with the forwarded number the primary gave it, if any.
///
/// Dispatch records every command; a system that handles commands before dispatch, such as fader
/// flash buttons, records them itself.
pub fn record_session_command<C: std::fmt::Debug + 'static>(
    command_id: CommandId,
    command: &C,
    origin: &CommandOrigin,
    forwarded_sequence: Option<u64>,
) {
    if std::any::TypeId::of::<C>() == std::any::TypeId::of::<SessionHistoryCommand>() {
        return;
    }
    let summary = summarize(command);
    with_history(|history| {
        let forwarded_sequence =
            forwarded_sequence.or_else(|| history.forwarded.remove(&command_id));
        let id = history.push(SessionHistoryEntry {
            id: 0,
            revision: 0,
            at_ms: now_ms(),
            kind: SessionHistoryKind::Command,
            source: origin_label(origin),
            module: short_type_name::<C>().to_string(),
            summary,
            outcome: None,
            forwarded_sequence,
        });
        history.running.insert(command_id, id);
    });
}

/// Notes the forwarded number of a command a backup is about to replay under `command_id`, so its
/// entry carries the primary's number.
pub(crate) fn note_forwarded_replay(command_id: CommandId, sequence: u64) {
    with_history(|history| {
        history.forwarded.insert(command_id, sequence);
    });
}

/// Records an event, such as a backup copying its primary's show. `source` names the domain and
/// `subject` what the event is about.
pub fn record_session_event(source: &str, subject: &str, description: impl Into<String>) {
    with_history(|history| {
        history.push(SessionHistoryEntry {
            id: 0,
            revision: 0,
            at_ms: now_ms(),
            kind: SessionHistoryKind::Event,
            source: source.to_string(),
            module: subject.to_string(),
            summary: truncate(description.into()),
            outcome: None,
            forwarded_sequence: None,
        });
    });
}

/// Returns the entries changed after revision `after`.
pub fn session_history_page(after: Option<u64>) -> SessionHistoryPage {
    with_history(|history| history.page(after))
}

/// Attaches each finished command's outcome to its entry.
fn record_outcomes(mut finished: MessageReader<FinishedCommand>) {
    let finished: Vec<_> = finished
        .read()
        .map(|finished| (finished.command_id, finished.outcome.clone()))
        .collect();
    if finished.is_empty() {
        return;
    }
    with_history(|history| {
        for (command_id, outcome) in finished {
            history.forwarded.remove(&command_id);
            let Some(id) = history.running.remove(&command_id) else {
                continue;
            };
            let outcome = match outcome {
                CommandOutcome::Succeeded { .. } => SessionHistoryOutcome {
                    succeeded: true,
                    message: None,
                },
                CommandOutcome::Failed(error) => SessionHistoryOutcome {
                    succeeded: false,
                    message: Some(error.message),
                },
            };
            history.update(id, |entry| entry.outcome = Some(outcome));
        }
    });
}

/// Answers history reads with the entries changed since the client's last read.
fn handle_session_history_commands(
    mut commands: MessageReader<CommandEnvelope<SessionHistoryCommand>>,
    mut responder: CommandResponder,
) {
    for envelope in commands.read() {
        let SessionHistoryCommand::Read { after } = envelope.command;
        let page = session_history_page(after);
        if let Err(error) = responder.succeed_with_output(envelope.command_id, &page) {
            tracing::error!(command_id = %envelope.command_id, %error, "session_history_read_failed");
        }
    }
}

/// Registers the history read command, allowed on a read-only backup, and the systems that answer
/// it and attach command outcomes.
pub(crate) fn register(app: &mut App) {
    crate::client::register_client_command::<SessionHistoryCommand>(app, Undo::Skipped);
    allow_command_while_read_only(app, SessionHistoryCommand::COMMAND_MODULE, "Read");
    app.add_systems(
        Update,
        handle_session_history_commands.in_set(EventHandling),
    );
    app.add_systems(Last, record_outcomes);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An entry built for a test, with the given summary.
    fn entry(summary: &str) -> SessionHistoryEntry {
        SessionHistoryEntry {
            id: 0,
            revision: 0,
            at_ms: 0,
            kind: SessionHistoryKind::Event,
            source: "Test".into(),
            module: "Test".into(),
            summary: summary.into(),
            outcome: None,
            forwarded_sequence: None,
        }
    }

    /// A read returns entries added or changed after the given revision, oldest first, and the
    /// history keeps only the newest entries.
    #[test]
    fn pages_return_changed_entries_and_drop_the_oldest() {
        let mut history = History::default();
        let first = history.push(entry("first"));
        history.push(entry("second"));
        let page = history.page(None);
        assert_eq!(page.entries.len(), 2);

        history.update(first, |entry| entry.summary = "changed".into());
        let changed = history.page(Some(page.revision));
        assert_eq!(changed.entries.len(), 1);
        assert_eq!(changed.entries[0].summary, "changed");
        assert_eq!(changed.entries[0].id, first);

        for index in 0..HISTORY_CAPACITY {
            history.push(entry(&index.to_string()));
        }
        assert_eq!(history.entries.len(), HISTORY_CAPACITY);
        assert!(history.page(None).oldest_id.unwrap() > first);
        history.update(first, |entry| entry.summary = "gone".into());
        assert!(history.entries.iter().all(|entry| entry.summary != "gone"));
    }

    /// Long descriptions are cut and marked, and type names lose their paths.
    #[test]
    fn shortens_descriptions_and_type_names() {
        let long = "x".repeat(MAX_SUMMARY_CHARS + 10);
        let cut = truncate(long.clone());
        assert_eq!(cut.chars().count(), MAX_SUMMARY_CHARS + 1);
        assert!(cut.ends_with('…'));
        assert_eq!(summarize(&long).chars().count(), MAX_SUMMARY_CHARS + 1);
        assert_eq!(summarize(&"short"), "\"short\"");
        assert_eq!(
            short_type_name::<SessionHistoryCommand>(),
            "SessionHistoryCommand"
        );
    }
}
