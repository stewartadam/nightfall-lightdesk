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
            update_reference_report,
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
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Deserialize)]
#[serde(tag = "type", content = "data")]
enum Decoded {
    ReferenceHealth {
        summary: ReferenceSummary,
        issues: Vec<ReferenceIssue>,
    },
    ReferenceList(Vec<DecodedOwner>),
    ReferenceListUpdate(Vec<DecodedOwner>),
}

/// The references of one object in a list or list update message.
#[derive(Debug, Deserialize)]
struct DecodedOwner {
    domain: ReferenceDomain,
    uid: String,
    references: Vec<ReferenceEntry>,
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

/// Only watching clients receive the full list, a watcher then gets only the objects each change
/// touched, and unwatching or disconnecting stops it.
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
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].domain, ReferenceDomain::Group);
    assert_eq!(list[0].references.len(), 2);

    add_group(&mut app, 2, SelectionExpr::Group(GroupRefExpr::ById(1)));
    app.update();
    let published = drain(&rx);
    let [
        (Audience::All, Decoded::ReferenceHealth { .. }),
        (Audience::Client(ClientId(7)), Decoded::ReferenceListUpdate(owners)),
    ] = published.as_slice()
    else {
        panic!("expected health and an update for client 7, got {published:?}");
    };
    assert_eq!(owners.len(), 1);
    assert_eq!(owners[0].uid, Uuid::from_u128(102).simple().to_string());
    assert_eq!(
        owners[0].references[0].target,
        ReferenceTarget::Group { group_id: 1 }
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

/// Moving a master's level, as a fader does every frame, publishes nothing because the master's
/// references are unchanged, while changing what the master is scoped to does.
#[test]
fn master_level_changes_publish_nothing() {
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
    let book = app.world().resource::<ReferenceReportState>().book();
    assert!(
        book.owners()
            .flat_map(|owner| &owner.references)
            .any(|entry| entry.target == ReferenceTarget::Group { group_id: 1 })
    );

    app.world_mut()
        .resource_mut::<DataProvider<Group>>()
        .remove(&Uuid::from_u128(102))
        .expect("group should remove");
    app.update();
    let index = app.world().resource::<GroupReferenceIndex>();
    assert!(index.dependents(Uuid::from_u128(101)).is_empty());
}

/// Renumbering a fixture re-audits only the objects that reference it, and a watcher receives
/// just those objects.
#[test]
fn fixture_change_reaudits_only_its_readers() {
    let (mut app, rx) = report_app();
    add_fixture(&mut app);
    add_group(&mut app, 1, resolved_with_missing_fixture());
    add_group(&mut app, 2, SelectionExpr::Resolved(Vec::new()));
    watch(&mut app, 7, true);
    app.update();
    drain(&rx);

    let mut fixture = app
        .world()
        .resource::<FixtureDataProviderExt>()
        .inner
        .get(Uuid::from_u128(1))
        .expect("fixture should exist")
        .clone();
    fixture.identifiers.id = 5;
    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture)
        .expect("fixture should store");
    app.update();

    let published = drain(&rx);
    let [(Audience::Client(ClientId(7)), Decoded::ReferenceListUpdate(owners))] =
        published.as_slice()
    else {
        panic!("expected only an update for client 7, got {published:?}");
    };
    assert_eq!(owners.len(), 1);
    assert_eq!(owners[0].uid, Uuid::from_u128(101).simple().to_string());
    assert_eq!(
        owners[0].references[0].target,
        ReferenceTarget::Fixture {
            fixture_id: 5,
            element_index: Some(1)
        }
    );
}

/// A client that starts watching gets the full list from a whole-show audit, while a client
/// already watching an unchanged show is sent nothing.
#[test]
fn starting_a_watch_sends_only_that_client_the_list() {
    let (mut app, rx) = report_app();
    add_fixture(&mut app);
    add_group(&mut app, 1, resolved_with_missing_fixture());
    watch(&mut app, 7, true);
    app.update();
    drain(&rx);

    watch(&mut app, 8, true);
    app.update();

    let published = drain(&rx);
    assert!(
        matches!(
            published.as_slice(),
            [(Audience::Client(ClientId(8)), Decoded::ReferenceList(owners))] if owners.len() == 1
        ),
        "expected the list for client 8 only, got {published:?}"
    );
}

/// Deleting an object sends watchers an empty reference list for it, and clearing a store, as a
/// showfile load does, re-audits the whole show.
#[test]
fn removed_objects_and_cleared_stores_update_the_report() {
    let (mut app, rx) = report_app();
    add_fixture(&mut app);
    add_group(&mut app, 1, resolved_with_missing_fixture());
    add_group(&mut app, 2, resolved_with_missing_fixture());
    watch(&mut app, 7, true);
    app.update();
    drain(&rx);

    app.world_mut()
        .resource_mut::<DataProvider<Group>>()
        .remove(&Uuid::from_u128(102))
        .expect("group should remove");
    app.update();
    let published = drain(&rx);
    let [
        (Audience::All, Decoded::ReferenceHealth { summary, .. }),
        (Audience::Client(ClientId(7)), Decoded::ReferenceListUpdate(owners)),
    ] = published.as_slice()
    else {
        panic!("expected health and an update for client 7, got {published:?}");
    };
    assert_eq!(summary.issue_count, 1);
    assert_eq!(owners.len(), 1);
    assert!(owners[0].references.is_empty());

    app.world_mut()
        .resource_mut::<DataProvider<Group>>()
        .clear();
    app.update();
    let published = drain(&rx);
    assert!(
        matches!(
            published.as_slice(),
            [
                (Audience::All, Decoded::ReferenceHealth { summary, .. }),
                (Audience::Client(ClientId(7)), Decoded::ReferenceListUpdate(_)),
            ] if summary.object_count == 0 && summary.issue_count == 0
        ),
        "expected an empty report after the clear, got {published:?}"
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

/// Measures report updates and their messages on a show with 2,000 four-element fixtures and
/// 2,000 groups of 50 resolved fixture references each (100,000 references): opening the panel
/// (a whole-show audit), editing one group, and renumbering one fixture. Prints the timings. Run
/// with `cargo test -p nightfall-references -- --ignored --nocapture`.
#[test]
#[ignore = "benchmark"]
fn benchmark_report_updates() {
    let (mut app, rx) = report_app();
    {
        let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        for id in 1..=2_000u32 {
            fixtures
                .inner
                .add(Fixture {
                    identifiers: Identifiers {
                        id,
                        uid: Uuid::from_u128(u128::from(id)),
                        label: format!("Fixture {id}"),
                    },
                    elements: vec![Default::default(); 4],
                    ..Default::default()
                })
                .expect("fixture should store");
        }
    }
    for id in 1..=2_000u32 {
        let refs = (0..50u32)
            .map(|offset| FixtureRef {
                fixture_uid: Uuid::from_u128(u128::from((id + offset) % 2_000 + 1)),
                index: Some(offset % 4 + 1),
            })
            .collect();
        add_group(&mut app, id, SelectionExpr::Resolved(refs));
    }
    let timed = |app: &mut App, label: &str| {
        let started = std::time::Instant::now();
        app.update();
        let elapsed = started.elapsed();
        let sizes: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|frame| frame.bytes.len())
            .collect();
        println!("{label}: {elapsed:?}, message bytes {sizes:?}");
    };
    timed(&mut app, "first audit");
    timed(&mut app, "idle frame");
    watch(&mut app, 7, true);
    timed(&mut app, "panel open");

    for round in 0..3u32 {
        add_group(
            &mut app,
            1,
            SelectionExpr::Resolved(vec![FixtureRef {
                fixture_uid: Uuid::from_u128(u128::from(round + 1)),
                index: None,
            }]),
        );
        timed(&mut app, &format!("group edit {round}"));
    }
    for round in 0..3u32 {
        let mut fixture = app
            .world()
            .resource::<FixtureDataProviderExt>()
            .inner
            .get(Uuid::from_u128(1_000))
            .expect("fixture should exist")
            .clone();
        fixture.identifiers.id = 3_000 + round;
        app.world_mut()
            .resource_mut::<FixtureDataProviderExt>()
            .inner
            .add(fixture)
            .expect("fixture should store");
        timed(&mut app, &format!("fixture renumber {round}"));
    }
    watch(&mut app, 7, false);
    add_group(&mut app, 2, SelectionExpr::Resolved(Vec::new()));
    timed(&mut app, "group edit, panel closed");
}
