// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Show-wide reference report for the References panel, delete guards and dependency lists.
//!
//! The engine keeps the audit of every reference-bearing object in a
//! [`nightfall_selection::ReferenceBook`]. When stores change, it re-audits only the objects that
//! changed and the objects whose references read a fixture, group, Blueprint or output target
//! that changed. Opening the References panel audits the whole show once, so the panel starts
//! from a fresh result. Clients get these messages:
//!
//! - `ReferenceHealth`, broadcast to every client when the counts or missing references change,
//!   carries the summary counts and the missing references. It stays small however large the
//!   show is.
//! - `ReferenceList` carries every reference, and only reaches clients that ask for it through
//!   [`REFERENCE_WATCH_MODULE`], such as an open References panel. A large show holds tens of
//!   thousands of fixture references, so it is sent once when the client starts watching.
//! - `ReferenceListUpdate` then carries the references of the objects whose references changed,
//!   so an edit costs watchers only the objects it touched.
//!
//! The book also feeds [`BlueprintReferenceIndex`] and [`GroupReferenceIndex`], which the
//! Blueprint and group delete guards read, and `ReferenceCommand::PruneMissingFixtureRefs`
//! removes missing resolved fixture references from every object under one undo step.

mod prune;
mod sources;
#[cfg(test)]
mod tests;

use std::collections::{BTreeSet, HashSet};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_selection::{
    OwnerKey, OwnerReferences, ReferenceBook, ReferenceDomain, ReferenceEntry, ReferenceIssue,
    ReferenceOwner, ReferenceStatus, ReferenceSummary, ReferenceTarget,
};
pub use prune::ReferenceCommand;
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub use sources::ReferenceSources;
use sources::{AuditCursor, AuditUpdate};
use uuid::Uuid;

/// Update module a client sends to choose whether it receives the full reference list.
pub const REFERENCE_WATCH_MODULE: &str = "ReferenceWatch";

/// Source name under which showfile objects report their dependents to the reverse indexes.
const INDEX_SOURCE: &str = "objects";

/// Payload of a [`REFERENCE_WATCH_MODULE`] update.
#[typeshare::typeshare]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReferenceWatch {
    /// Whether the sender receives `ReferenceList` and `ReferenceListUpdate` messages.
    pub references: bool,
}

/// Summary counts and missing references, broadcast to every client.
#[typeshare::typeshare]
#[derive(Debug, Serialize)]
pub struct ReferenceHealth<'a> {
    /// Counts across the audit.
    pub summary: &'a ReferenceSummary,
    /// Every missing reference.
    pub issues: &'a [ReferenceIssue],
}

/// Every reference one object holds, with the owner described once for all of them.
#[typeshare::typeshare]
#[derive(Debug, Serialize)]
pub struct OwnerReferenceList<'a> {
    /// Object family of the owner.
    pub domain: ReferenceDomain,
    /// Stable identity of the owner.
    pub uid: &'a str,
    /// User-facing numeric ID of the owner; 0 when it no longer exists.
    pub id: u32,
    /// User-facing label of the owner; empty when it no longer exists.
    pub label: &'a str,
    /// Every reference the owner holds; empty when it holds none or no longer exists.
    pub references: Vec<ListedReference<'a>>,
}

/// One reference in a list message. Its owner is the enclosing [`OwnerReferenceList`], so a large
/// list does not repeat the owner's identity for every reference.
#[typeshare::typeshare]
#[derive(Debug, Serialize)]
pub struct ListedReference<'a> {
    /// Location of the reference inside the owner, such as `selection.source.Resolved[0]`.
    pub path: &'a str,
    /// Target the reference names.
    pub target: &'a ReferenceTarget,
    /// Whether the target exists.
    pub status: ReferenceStatus,
}

impl<'a> From<&'a ReferenceEntry> for ListedReference<'a> {
    /// Borrows an audited reference without its owner.
    fn from(entry: &'a ReferenceEntry) -> Self {
        Self {
            path: &entry.path,
            target: &entry.target,
            status: entry.status,
        }
    }
}

/// Reference report messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum ReferenceWsMessage<'a> {
    /// Summary counts and missing references.
    ReferenceHealth(ReferenceHealth<'a>),
    /// Every object that holds references, for a client that starts watching.
    ReferenceList(Vec<OwnerReferenceList<'a>>),
    /// Objects whose references changed since the last list or update, for watching clients.
    ReferenceListUpdate(Vec<OwnerReferenceList<'a>>),
}

/// Engine-side state of the reference report.
#[derive(Resource, Default)]
pub struct ReferenceReportState {
    /// Latest audit of every object.
    book: ReferenceBook,
    /// How far the book has followed the stores.
    cursor: AuditCursor,
    /// Every missing reference in report order, as last broadcast.
    issues: Vec<ReferenceIssue>,
    /// Whether the next update audits every object.
    full_audit_requested: bool,
    /// Clients that must be sent the health message at the next client output: every client
    /// after a change, or the clients that resynced.
    health_pending: PendingReplies,
    /// Clients that receive the full reference list.
    watchers: HashSet<Audience>,
    /// Watchers that must be sent the full list at the next client output.
    list_pending: HashSet<Audience>,
    /// Objects whose references changed since watchers were last sent the list or an update.
    list_updates: BTreeSet<OwnerKey>,
}

/// What storing a batch of audits changed.
#[derive(Default)]
struct AppliedAudits {
    /// Whether any object's missing references changed.
    issues: bool,
    /// Whether any object's group or Blueprint dependencies, or how it is described, changed.
    dependents: bool,
}

impl ReferenceReportState {
    /// Returns the latest audit of every object.
    pub fn book(&self) -> &ReferenceBook {
        &self.book
    }

    /// Stores a batch of audits, queueing the messages they change.
    fn apply(&mut self, update: AuditUpdate) -> AppliedAudits {
        let summary_before = self.book.summary().clone();
        let mut applied = AppliedAudits::default();
        let mut seen = update.full.then(HashSet::new);
        for (key, audit) in update.audits {
            if let Some(seen) = &mut seen {
                seen.insert(key.clone());
            }
            let previous = match audit {
                Some(audit) => self.book.insert(audit),
                None => self.book.remove(&key),
            };
            self.record_change(key, previous.as_ref(), &mut applied);
        }
        if let Some(seen) = seen {
            for removed in self.book.retain(|key| seen.contains(key)) {
                self.record_change(OwnerKey::of(&removed.owner), Some(&removed), &mut applied);
            }
        }
        if applied.issues {
            self.issues = self.book.issues();
        }
        if applied.issues || *self.book.summary() != summary_before {
            self.health_pending.request(Audience::All);
        }
        applied
    }

    /// Compares an object's stored audit with `previous`, queueing a list update for watchers and
    /// noting in `applied` what else changed.
    fn record_change(
        &mut self,
        key: OwnerKey,
        previous: Option<&OwnerReferences>,
        applied: &mut AppliedAudits,
    ) {
        /// Returns the references of an audit, or none for a missing one.
        fn references(audit: Option<&OwnerReferences>) -> &[ReferenceEntry] {
            audit.map_or(&[], |audit| &audit.references)
        }
        /// Returns the missing references of an audit, or none for a missing one.
        fn issues(audit: Option<&OwnerReferences>) -> &[ReferenceIssue] {
            audit.map_or(&[], |audit| &audit.issues)
        }
        /// Returns what the reverse indexes store for an audit.
        fn dependents(
            audit: Option<&OwnerReferences>,
        ) -> Option<(&ReferenceOwner, &BTreeSet<Uuid>, &BTreeSet<Uuid>)> {
            audit.map(|audit| {
                (
                    &audit.owner,
                    &audit.group_dependencies,
                    &audit.blueprint_dependencies,
                )
            })
        }
        let current = self.book.get(&key);
        applied.issues |= issues(previous) != issues(current);
        applied.dependents |= dependents(previous) != dependents(current);
        if !self.watchers.is_empty() && references(previous) != references(current) {
            self.list_updates.insert(key);
        }
    }

    /// Starts or stops sending the full reference list to `audience`. Starting audits the whole
    /// show before the list is sent.
    fn watch(&mut self, audience: Audience, references: bool) {
        if references {
            self.watchers.insert(audience);
            self.list_pending.insert(audience);
            self.full_audit_requested = true;
        } else {
            self.watchers.remove(&audience);
            self.list_pending.remove(&audience);
            if self.watchers.is_empty() {
                self.list_updates.clear();
            }
        }
    }

    /// Returns the references of the objects `keys` name, for a list or update message.
    fn owner_lists<'a>(
        &'a self,
        keys: impl IntoIterator<Item = &'a OwnerKey>,
    ) -> Vec<OwnerReferenceList<'a>> {
        keys.into_iter()
            .map(|key| {
                let audit = self.book.get(key);
                OwnerReferenceList {
                    domain: key.domain,
                    uid: &key.uid,
                    id: audit.map_or(0, |audit| audit.owner.id),
                    label: audit.map_or("", |audit| &audit.owner.label),
                    references: audit
                        .map(|audit| audit.references.iter().map(ListedReference::from).collect())
                        .unwrap_or_default(),
                }
            })
            .collect()
    }
}

/// Registers the reference report, its client messages and the prune command.
pub struct ReferencesPlugin;

impl Plugin for ReferencesPlugin {
    fn build(&self, app: &mut App) {
        sources::init_source_resources(app);
        app.init_resource::<ReferenceReportState>();
        app.init_resource::<BlueprintReferenceIndex>();
        app.init_resource::<GroupReferenceIndex>();
        prune::register(app);
        register_client_update_deserializer(
            app,
            REFERENCE_WATCH_MODULE,
            deserialize_reference_watch,
        );
        app.add_systems(
            Update,
            (
                forget_disconnected_watchers.in_set(EventHandling),
                update_reference_report
                    .after(EventHandling)
                    .before(ResyncHandling),
                queue_health_on_resync.in_set(ResyncHandling),
            ),
        );
        app.add_systems(Render, send_reference_report.in_set(ClientOutput));
    }
}

/// Re-audits the objects that store changes affect, or the whole show when a client starts
/// watching or a store was replaced, and refreshes the reverse indexes the delete guards read.
pub fn update_reference_report(
    mut sources: ReferenceSources,
    mut state: ResMut<ReferenceReportState>,
    mut blueprint_index: ResMut<BlueprintReferenceIndex>,
    mut group_index: ResMut<GroupReferenceIndex>,
) {
    let full = state.full_audit_requested;
    let state = &mut *state;
    let Some(update) = sources.audit_changes(&mut state.cursor, &state.book, full) else {
        return;
    };
    state.full_audit_requested = false;
    let full = update.full;
    let audited = update.audits.len();
    let applied = state.apply(update);
    tracing::debug!(
        full,
        audited,
        references = state.book.summary().reference_count,
        issues = state.book.summary().issue_count,
        "reference_report_updated"
    );
    if applied.dependents {
        blueprint_index.replace_source(INDEX_SOURCE, state.book.blueprint_dependents());
        group_index.replace_source(INDEX_SOURCE, state.book.group_dependents());
    }
}

/// Queues the health message for the clients that resync.
fn queue_health_on_resync(
    mut events: MessageReader<ResyncRequested>,
    mut state: ResMut<ReferenceReportState>,
) {
    state
        .health_pending
        .request_each(events.read().map(|request| request.audience));
}

/// Publishes queued health, list and list update messages.
fn send_reference_report(mut state: ResMut<ReferenceReportState>, sink: Res<ClientEventSink>) {
    if state.health_pending.is_empty()
        && state.list_pending.is_empty()
        && state.list_updates.is_empty()
    {
        return;
    }
    let state = &mut *state;
    if let Some(audience) = state.health_pending.take() {
        sink.narrowed_to(audience.into_audiences()).publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &ReferenceWsMessage::ReferenceHealth(ReferenceHealth {
                summary: state.book.summary(),
                issues: &state.issues,
            }),
        );
    }
    let list_updates = std::mem::take(&mut state.list_updates);
    if !list_updates.is_empty() {
        let message = ReferenceWsMessage::ReferenceListUpdate(state.owner_lists(&list_updates));
        for audience in state.watchers.difference(&state.list_pending) {
            sink.publish_to(*audience, DISCRIMINATOR_NON_DROPPABLE, &message);
        }
    }
    if !state.list_pending.is_empty() {
        let owners = state
            .book
            .owners()
            .filter(|audit| !audit.references.is_empty())
            .map(|audit| OwnerKey::of(&audit.owner))
            .collect::<Vec<_>>();
        let message = ReferenceWsMessage::ReferenceList(state.owner_lists(&owners));
        for audience in &state.list_pending {
            sink.publish_to(*audience, DISCRIMINATOR_NON_DROPPABLE, &message);
        }
    }
    state.list_pending.clear();
}

/// Applies a client's [`REFERENCE_WATCH_MODULE`] update.
fn deserialize_reference_watch(
    world: &mut World,
    json: Value,
    sender: Audience,
) -> Result<(), String> {
    let watch: ReferenceWatch = serde_json::from_value(json)
        .map_err(|error| format!("Failed to parse ReferenceWatch: {error}"))?;
    world
        .resource_mut::<ReferenceReportState>()
        .watch(sender, watch.references);
    Ok(())
}

/// Drops the watches of clients that disconnected.
fn forget_disconnected_watchers(
    mut disconnected: MessageReader<ClientDisconnected>,
    mut state: ResMut<ReferenceReportState>,
) {
    for message in disconnected.read() {
        state.watch(Audience::Client(message.client), false);
    }
}
