// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_app::{App, Update};
use nightfall::prelude::*;
use nightfall_desk::prelude::{FixtureMasterTarget, GroupCommand, Master, MasterTarget};
use nightfall_fixtures::prelude::{Fixture, FixtureDataProviderExt};
use nightfall_selection::{ReferenceIssueReason, ReferenceTarget};
use uuid::Uuid;

use super::*;

/// Builds an app running the report systems in their plugin order, capturing every published
/// frame.
fn report_app() -> (App, async_channel::Receiver<OutboundFrame>) {
    let mut app = App::new();
    let (tx, rx) = async_channel::unbounded();
    app.insert_resource(ClientEventSink::new(tx));
    sources::init_source_resources(&mut app);
    app.init_resource::<ReferenceReportState>();
    app.init_resource::<BlueprintReferenceIndex>();
    app.init_resource::<GroupReferenceIndex>();
    app.add_message::<ResyncRequested>();
    app.add_message::<ClientDisconnected>();
    app.add_systems(
        Update,
        (
            forget_disconnected_watchers,
            rebuild_reference_report,
            queue_health_on_resync,
            send_reference_report,
        )
            .chain(),
    );
    (app, rx)
}

/// Stores fixture 1 with two elements.
fn add_fixture(app: &mut App) {
    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::from_u128(1),
                label: "Spot".to_owned(),
            },
            elements: vec![Default::default(), Default::default()],
            ..Default::default()
        })
        .expect("fixture should store");
}

/// Stores a group with `selection`.
fn add_group(app: &mut App, id: u32, selection: SelectionExpr) {
    let mut group = Group::default();
    group.identifiers.id = id;
    group.identifiers.uid = Uuid::from_u128(u128::from(id) + 100);
    group.identifiers.label = format!("Group {id}");
    group.selection = SpatialSelection::identity(selection);
    app.world_mut()
        .resource_mut::<DataProvider<Group>>()
        .add(group)
        .expect("group should store");
}

/// Returns a resolved selection naming element 1 of fixture 1 and the missing fixture 99.
fn resolved_with_missing_fixture() -> SelectionExpr {
    SelectionExpr::Resolved(vec![
        FixtureRef {
            fixture_uid: Uuid::from_u128(1),
            index: Some(1),
        },
        FixtureRef {
            fixture_uid: Uuid::from_u128(99),
            index: None,
        },
    ])
}

/// A published report message as a client decodes it.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", content = "data")]
enum Decoded {
    ReferenceHealth {
        summary: ReferenceSummary,
        issues: Vec<ReferenceIssue>,
    },
    ReferenceList(Vec<ReferenceEntry>),
}

/// Decodes every published frame with the audience it was addressed to.
fn drain(rx: &async_channel::Receiver<OutboundFrame>) -> Vec<(Audience, Decoded)> {
    std::iter::from_fn(|| rx.try_recv().ok())
        .map(|frame| {
            assert_eq!(frame.bytes[0], DISCRIMINATOR_NON_DROPPABLE);
            let decoded = minicbor_serde::from_slice(&frame.bytes[1..]).expect("frame decodes");
            (frame.audience, decoded)
        })
        .collect()
}

/// Starts or stops the full list for `client` the way a client update does.
fn watch(app: &mut App, client: u64, references: bool) {
    deserialize_reference_watch(
        app.world_mut(),
        serde_json::json!({ "references": references }),
        Audience::Client(ClientId(client)),
    )
    .expect("watch should parse");
}

/// A store change broadcasts the health message once with the missing references, and an
/// unchanged show publishes nothing more.
#[test]
fn store_change_broadcasts_health_once() {
    let (mut app, rx) = report_app();
    add_fixture(&mut app);
    add_group(&mut app, 1, resolved_with_missing_fixture());

    app.update();

    let published = drain(&rx);
    let [(Audience::All, Decoded::ReferenceHealth { summary, issues })] = published.as_slice()
    else {
        panic!("expected one broadcast health message, got {published:?}");
    };
    assert_eq!(summary.reference_count, 2);
    assert_eq!(summary.issue_count, 1);
    assert_eq!(summary.prunable_issue_count, 1);
    assert_eq!(issues[0].reason, ReferenceIssueReason::MissingFixtureUid);
    assert_eq!(issues[0].source.description(), "group 1 (Group 1)");

    app.update();
    assert!(drain(&rx).is_empty(), "unchanged report was resent");
}

/// Only watching clients receive the full list, a watcher gets it again after every change, and
/// unwatching or disconnecting stops it.
#[test]
fn list_reaches_only_watchers() {
    let (mut app, rx) = report_app();
    add_fixture(&mut app);
    add_group(&mut app, 1, resolved_with_missing_fixture());
    app.update();
    drain(&rx);

    watch(&mut app, 7, true);
    app.update();
    let published = drain(&rx);
    let [(Audience::Client(ClientId(7)), Decoded::ReferenceList(list))] = published.as_slice()
    else {
        panic!("expected the list for client 7 only, got {published:?}");
    };
    assert_eq!(list.len(), 2);

    add_group(&mut app, 2, SelectionExpr::Group(GroupRefExpr::ById(1)));
    app.update();
    let audiences: Vec<_> = drain(&rx)
        .into_iter()
        .map(|(audience, decoded)| (audience, matches!(decoded, Decoded::ReferenceList(_))))
        .collect();
    assert_eq!(
        audiences,
        vec![
            (Audience::All, false),
            (Audience::Client(ClientId(7)), true)
        ]
    );

    app.world_mut().write_message(ClientDisconnected {
        client: ClientId(7),
    });
    add_group(&mut app, 3, SelectionExpr::Group(GroupRefExpr::ById(1)));
    app.update();
    let published = drain(&rx);
    assert!(
        matches!(
            published.as_slice(),
            [(Audience::All, Decoded::ReferenceHealth { .. })]
        ),
        "disconnected watcher still received the list: {published:?}"
    );
}

/// Moving a master's level, as a fader does every frame, does not re-audit the show, while
/// changing what the master is scoped to does.
#[test]
fn master_level_changes_do_not_rebuild() {
    let (mut app, rx) = report_app();
    let mut master = Master::default();
    master.identifiers.id = 1;
    master.identifiers.uid = Uuid::from_u128(500);
    master.target = MasterTarget::Fixtures(FixtureMasterTarget::Group(Uuid::from_u128(9)));
    app.world_mut()
        .resource_mut::<DataProvider<Master>>()
        .add(master.clone())
        .expect("master should store");
    app.update();
    drain(&rx);

    master.level_percent = 40.0;
    app.world_mut()
        .resource_mut::<DataProvider<Master>>()
        .add(master.clone())
        .expect("master should store");
    app.update();
    assert!(drain(&rx).is_empty(), "a level change re-audited the show");

    master.target = MasterTarget::Fixtures(FixtureMasterTarget::All);
    app.world_mut()
        .resource_mut::<DataProvider<Master>>()
        .add(master)
        .expect("master should store");
    app.update();
    let published = drain(&rx);
    assert!(
        matches!(
            published.as_slice(),
            [(Audience::All, Decoded::ReferenceHealth { summary, .. })] if summary.issue_count == 0
        ),
        "expected a fresh report without the missing group, got {published:?}"
    );
}

/// A resync republishes the unchanged health message.
#[test]
fn resync_republishes_health() {
    let (mut app, rx) = report_app();
    add_group(&mut app, 1, resolved_with_missing_fixture());
    app.update();
    drain(&rx);

    app.world_mut()
        .write_message(ResyncRequested { command_id: None });
    app.update();

    let published = drain(&rx);
    assert!(
        matches!(
            published.as_slice(),
            [(Audience::All, Decoded::ReferenceHealth { summary, .. })] if summary.issue_count == 2
        ),
        "expected the health message again, got {published:?}"
    );
}

/// The group reverse index lists the objects that reference each live group, which the group
/// delete guard reads.
#[test]
fn report_feeds_group_index() {
    let (mut app, _rx) = report_app();
    add_group(&mut app, 1, SelectionExpr::Resolved(Vec::new()));
    add_group(&mut app, 2, SelectionExpr::Group(GroupRefExpr::ById(1)));

    app.update();

    let index = app.world().resource::<GroupReferenceIndex>();
    assert_eq!(
        index.dependents(Uuid::from_u128(101)),
        vec!["objects:group 2 (Group 2)".to_owned()]
    );
    assert!(index.dependents(Uuid::from_u128(102)).is_empty());
    let report = app.world().resource::<ReferenceReportState>().report();
    assert!(
        report
            .references
            .iter()
            .any(|entry| entry.target == ReferenceTarget::Group { group_id: 1 })
    );
}

/// Builds an app that runs the prune handler against the command lifecycle resources.
fn prune_app() -> App {
    let mut app = App::new();
    sources::init_source_resources(&mut app);
    app.init_resource::<CommandTracker>();
    app.init_resource::<PendingCommandBuffer>();
    app.add_message::<CommandEnvelope<ReferenceCommand>>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNoticeReply>();
    app.add_systems(Update, prune::handle_reference_commands);
    app
}

/// Registers and submits one prune command, returning its envelope.
fn submit_prune(app: &mut App) -> CommandEnvelope<ReferenceCommand> {
    let envelope = CommandEnvelope::new(
        ReferenceCommand::PruneMissingFixtureRefs,
        CommandOrigin::WebUi,
        ReplyTarget::Detached,
    );
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("prune command should register");
    app.world_mut().write_message(envelope.clone());
    envelope
}

/// Pruning queues one store per affected object, without the missing fixture, under the prune
/// command's id and undo group so a single undo restores everything.
#[test]
fn prune_stores_affected_objects_in_one_undo_group() {
    let mut app = prune_app();
    add_fixture(&mut app);
    add_group(&mut app, 1, resolved_with_missing_fixture());
    add_group(&mut app, 2, SelectionExpr::Group(GroupRefExpr::ById(1)));
    let envelope = submit_prune(&mut app);

    app.update();

    let queued = app
        .world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .drain();
    let [store] = queued.as_slice() else {
        panic!("expected one store, got {} commands", queued.len());
    };
    assert_eq!(store.command_id, envelope.command_id);
    assert_eq!(store.undo_id, envelope.undo_id);
    let Some(GroupCommand::StoreGroup(group)) = store.payload.as_any().downcast_ref() else {
        panic!("expected a group store");
    };
    assert_eq!(group.identifiers.id, 1);
    assert_eq!(
        group.selection.source,
        SelectionExpr::Resolved(vec![FixtureRef {
            fixture_uid: Uuid::from_u128(1),
            index: Some(1),
        }])
    );
    assert!(
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .is_none(),
        "prune finished before its stores completed"
    );
}

/// Pruning a show with nothing to prune succeeds at once.
#[test]
fn prune_without_missing_refs_succeeds() {
    let mut app = prune_app();
    add_fixture(&mut app);
    let envelope = submit_prune(&mut app);

    app.update();

    assert!(
        app.world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .is_empty()
    );
    let result = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .next()
        .expect("prune should finish");
    assert_eq!(result.command_id, envelope.command_id);
    assert!(matches!(result.outcome, CommandOutcome::Succeeded { .. }));
}
