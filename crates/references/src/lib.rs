// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Show-wide reference report for the References panel, delete guards and dependency lists.
//!
//! Whenever a reference-bearing store changes, the engine audits every object's references (see
//! [`nightfall_selection::ReferenceAuditor`]) and keeps the result. Clients get two messages:
//!
//! - `ReferenceHealth`, broadcast to every client, carries the summary counts and the missing
//!   references. It stays small however large the show is.
//! - `ReferenceList` carries every reference, and only reaches clients that ask for it through
//!   [`REFERENCE_WATCH_MODULE`], such as an open References panel. A large show holds tens of
//!   thousands of fixture references, so broadcasting the full list on every edit would cost
//!   every client far more than it needs.
//!
//! The report also feeds [`BlueprintReferenceIndex`] and [`GroupReferenceIndex`], which the
//! Blueprint and group delete guards read, and `ReferenceCommand::PruneMissingFixtureRefs`
//! removes missing resolved fixture references from every object under one undo step.

mod prune;
mod sources;
#[cfg(test)]
mod tests;

use std::collections::HashSet;

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_selection::{ReferenceEntry, ReferenceIssue, ReferenceReport, ReferenceSummary};
pub use prune::ReferenceCommand;
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub use sources::ReferenceSources;

/// Update module a client sends to choose whether it receives the full reference list.
pub const REFERENCE_WATCH_MODULE: &str = "ReferenceWatch";

/// Source name under which showfile objects report their dependents to the reverse indexes.
const INDEX_SOURCE: &str = "objects";

/// Payload of a [`REFERENCE_WATCH_MODULE`] update.
#[typeshare::typeshare]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReferenceWatch {
    /// Whether the sender receives `ReferenceList` messages.
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

/// Reference report messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum ReferenceWsMessage<'a> {
    /// Summary counts and missing references.
    ReferenceHealth(ReferenceHealth<'a>),
    /// Every reference in the show, for clients that watch it.
    ReferenceList(&'a [ReferenceEntry]),
}

/// Engine-side state of the reference report.
#[derive(Resource, Default)]
pub struct ReferenceReportState {
    /// Latest audit.
    report: ReferenceReport,
    /// Whether the health message must be broadcast at the next client output.
    health_pending: bool,
    /// Clients that receive the full reference list.
    watchers: HashSet<Audience>,
    /// Watchers that must be sent the list at the next client output.
    list_pending: HashSet<Audience>,
}

impl ReferenceReportState {
    /// Returns the latest audit.
    pub fn report(&self) -> &ReferenceReport {
        &self.report
    }

    /// Replaces the audit and queues it for every client.
    fn replace(&mut self, report: ReferenceReport) {
        self.report = report;
        self.health_pending = true;
        self.list_pending.extend(self.watchers.iter().copied());
    }

    /// Starts or stops sending the full reference list to `audience`.
    fn watch(&mut self, audience: Audience, references: bool) {
        if references {
            self.watchers.insert(audience);
            self.list_pending.insert(audience);
        } else {
            self.watchers.remove(&audience);
            self.list_pending.remove(&audience);
        }
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
                rebuild_reference_report
                    .after(EventHandling)
                    .before(ResyncHandling),
                queue_health_on_resync.in_set(ResyncHandling),
            ),
        );
        app.add_systems(Render, send_reference_report.in_set(ClientOutput));
    }
}

/// Re-audits every reference when a reference-bearing store changed, and refreshes the reverse
/// indexes the delete guards read.
pub fn rebuild_reference_report(
    mut sources: ReferenceSources,
    mut state: ResMut<ReferenceReportState>,
    mut blueprint_index: ResMut<BlueprintReferenceIndex>,
    mut group_index: ResMut<GroupReferenceIndex>,
) {
    if !sources.is_changed() {
        return;
    }
    let report = sources.audit();
    tracing::debug!(
        references = report.summary.reference_count,
        issues = report.summary.issue_count,
        "reference_report_rebuilt"
    );
    blueprint_index.replace_source(INDEX_SOURCE, dependents(&report.blueprint_dependents));
    group_index.replace_source(INDEX_SOURCE, dependents(&report.group_dependents));
    state.replace(report);
}

/// Flattens a dependents map into the `(target, description)` pairs a reverse index stores.
fn dependents(
    map: &std::collections::BTreeMap<uuid::Uuid, std::collections::BTreeSet<String>>,
) -> Vec<(uuid::Uuid, String)> {
    map.iter()
        .flat_map(|(uid, descriptions)| {
            descriptions
                .iter()
                .map(move |description| (*uid, description.clone()))
        })
        .collect()
}

/// Queues the health message for a client that resyncs.
fn queue_health_on_resync(
    mut events: MessageReader<ResyncRequested>,
    mut state: ResMut<ReferenceReportState>,
) {
    if events.read().next().is_some() {
        state.health_pending = true;
    }
}

/// Publishes queued health and list messages.
fn send_reference_report(mut state: ResMut<ReferenceReportState>, sink: Res<ClientEventSink>) {
    if !state.health_pending && state.list_pending.is_empty() {
        return;
    }
    let state = &mut *state;
    if std::mem::take(&mut state.health_pending) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &ReferenceWsMessage::ReferenceHealth(ReferenceHealth {
                summary: &state.report.summary,
                issues: &state.report.issues,
            }),
        );
    }
    for audience in state.list_pending.drain() {
        sink.publish_to(
            audience,
            DISCRIMINATOR_NON_DROPPABLE,
            &ReferenceWsMessage::ReferenceList(&state.report.references),
        );
    }
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
