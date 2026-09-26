// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_app::prelude::*;
use bevy_ecs::{prelude::Messages, schedule::IntoScheduleConfigs};
use nightfall::prelude::*;
use nightfall_desk::prelude::GroupAction;
use nightfall_engine::prelude::{
    CommandEnvelope, CommandNotice, CommandOrigin, CommandReply, CommandResult, CommandTracker,
    DataProvider, EngineActionEnvelope, FinishedCommand, OperationResult, ReplyTarget,
};
use nightfall_fixtures::prelude::{Fixture, FixtureDataProviderExt, FixtureElement};
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_programmer::events::{ProgrammerCommand, StoreObjectWorkflows, handle_group_events};
use nightfall_programmer::prelude::Programmer;
use nightfall_undo::prelude::UndoManager;
use uuid::Uuid;

/// Builds an unresolved whole-fixture reference for selection commands.
fn unresolved_fixture_ref(fixture_id: u32) -> UnresolvedFixtureRef {
    UnresolvedFixtureRef {
        fixture_id,
        element_index: None,
    }
}

/// Builds the stable UID used for test groups.
fn group_uid(group_id: u32) -> Uuid {
    Uuid::from_u128(10_000 + group_id as u128)
}

/// Builds a fixture with a stable UID and caller-selected element count.
fn fixture_with_elements(fixture_id: u32, element_count: usize) -> Fixture {
    Fixture {
        identifiers: Identifiers {
            id: fixture_id,
            uid: Uuid::from_u128(fixture_id as u128),
            label: format!("Fixture {fixture_id}"),
        },
        make: "Test".to_string(),
        model: "Multi Element".to_string(),
        mode: "Mode".to_string(),
        elements: (0..element_count)
            .map(|_| FixtureElement::default())
            .collect(),
        ..Default::default()
    }
}

/// Builds a group with a caller-provided stored selection.
fn group_with_selection(group_id: u32, selection: SpatialSelection) -> Group {
    Group {
        identifiers: Identifiers {
            id: group_id,
            uid: group_uid(group_id),
            label: format!("Group {group_id}"),
        },
        selection,
        description: String::new(),
    }
}

/// Builds a concrete element fixture reference from numeric fixture and element IDs.
fn element_fixture_ref(fixture_id: u32, element_index: u32) -> FixtureRef {
    FixtureRef {
        fixture_uid: Uuid::from_u128(fixture_id as u128),
        index: Some(element_index),
    }
}

/// Creates an app with resources needed by group store handling.
fn setup_app() -> App {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<ProgrammerCommand>>();
    app.add_message::<EngineActionEnvelope<GroupAction>>();
    app.insert_resource(Programmer::default());
    app.insert_resource(StoreObjectWorkflows::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.add_systems(Update, handle_group_events);
    app
}

/// Inserts test fixtures into the fixture provider used by selection resolution.
fn insert_fixtures(
    app: &mut App,
    fixture_ids: impl IntoIterator<Item = u32>,
    element_count: usize,
) {
    let mut fixture_provider = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    for fixture_id in fixture_ids {
        fixture_provider
            .inner
            .add(fixture_with_elements(fixture_id, element_count))
            .expect("fixture should insert");
    }
}

/// Inserts one test group into the group provider.
fn insert_group(app: &mut App, group: Group) {
    app.world_mut()
        .resource_mut::<DataProvider<Group>>()
        .add(group)
        .expect("group should insert");
}

/// Resolves a selection against the app's fixture and group providers.
fn resolve_selection(app: &mut App, selection: &SpatialSelection) -> ResolvedSelection {
    let mut system_state =
        bevy_ecs::system::SystemState::<SpatialSelectionResolver>::new(app.world_mut());
    let resolver = system_state
        .get(app.world())
        .expect("resolver should build");
    resolver.resolve(selection).into_value()
}

/// Runs one store-group command and returns the queued group action.
fn run_store_group_command(app: &mut App, group_id: u32) -> GroupAction {
    app.world_mut().write_message(CommandEnvelope::new(
        ProgrammerCommand::StoreGroup {
            group_id,
            label: None,
        },
        CommandOrigin::Cli,
        ReplyTarget::Detached,
    ));
    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<GroupAction>>>()
        .drain()
        .map(|envelope| envelope.action)
        .next()
        .expect("store group action should be queued")
}

/// Verifies the programmer workflow finishes only after the desk action stores the group.
#[test]
fn tracked_store_group_finishes_after_action_result() {
    let mut app = setup_app();
    app.init_resource::<CommandTracker>();
    app.init_resource::<UndoManager>();
    app.add_message::<OperationResult<(), nightfall_engine::prelude::CommandError>>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.add_systems(
        Update,
        (
            nightfall_desk::systems::event_handlers::group_events::action_events,
            nightfall_programmer::events::resume_store_object_workflows,
        )
            .chain()
            .after(handle_group_events),
    );
    insert_fixtures(&mut app, [1], 1);
    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_spatial_selection(SpatialSelection::identity(SelectionExpr::Fixture(
            unresolved_fixture_ref(1),
        )));
    let envelope = CommandEnvelope::new(
        ProgrammerCommand::StoreGroup {
            group_id: 9,
            label: None,
        },
        CommandOrigin::WebUi,
        ReplyTarget::Detached,
    );
    let command_id = envelope.command_id;
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("store group command should register");
    app.world_mut().write_message(envelope);

    app.update();

    assert!(
        app.world()
            .resource::<DataProvider<Group>>()
            .from_id(9)
            .is_ok()
    );
    let results = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].command_id, command_id);
}

/// Stores source-shaped active selections as resolved refs before remaining projection clauses.
#[test]
fn store_group_materializes_expanded_split_active_selection_source() {
    let mut app = setup_app();
    insert_fixtures(&mut app, 1..=4, 2);
    let active_selection = SpatialSelection::pipeline(
        SelectionExpr::Add {
            lhs: Box::new(SelectionExpr::FixtureRange {
                start: unresolved_fixture_ref(3),
                end: unresolved_fixture_ref(1),
            }),
            rhs: Box::new(SelectionExpr::Fixture(unresolved_fixture_ref(4))),
        },
        vec![
            SpatialClause::Expand { depth: None },
            SpatialClause::Split,
            SpatialClause::Grid(GridSize::Width(2)),
        ],
    );
    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_spatial_selection(active_selection);

    let GroupAction::StoreGroup(group) = run_store_group_command(&mut app, 9);

    assert_eq!(
        group.selection.clauses,
        vec![SpatialClause::Grid(GridSize::Width(2))]
    );
    assert!(group.selection.union.is_empty());
    assert_eq!(
        group.selection.source,
        SelectionExpr::Resolved(vec![
            element_fixture_ref(3, 1),
            element_fixture_ref(3, 2),
            element_fixture_ref(2, 1),
            element_fixture_ref(2, 2),
            element_fixture_ref(1, 1),
            element_fixture_ref(1, 2),
            element_fixture_ref(4, 1),
            element_fixture_ref(4, 2),
        ])
    );
}

/// Stores expanded source spans without flattening later projection behavior.
#[test]
fn store_group_preserves_materialized_source_spans_before_projection() {
    let mut app = setup_app();
    insert_fixtures(&mut app, 1..=2, 2);
    let active_selection = SpatialSelection::pipeline(
        SelectionExpr::FixtureRange {
            start: unresolved_fixture_ref(1),
            end: unresolved_fixture_ref(2),
        },
        vec![
            SpatialClause::Expand { depth: None },
            SpatialClause::Grid(GridSize::Width(2)),
        ],
    );
    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_spatial_selection(active_selection);

    let GroupAction::StoreGroup(group) = run_store_group_command(&mut app, 9);

    assert_eq!(
        group.selection.clauses,
        vec![SpatialClause::Grid(GridSize::Width(2))]
    );
    assert_eq!(
        group.selection.source,
        SelectionExpr::Add {
            lhs: Box::new(SelectionExpr::Span(Box::new(SelectionExpr::Resolved(
                vec![element_fixture_ref(1, 1), element_fixture_ref(1, 2),]
            )))),
            rhs: Box::new(SelectionExpr::Span(Box::new(SelectionExpr::Resolved(
                vec![element_fixture_ref(2, 1), element_fixture_ref(2, 2),]
            )))),
        }
    );
}

/// Stores unshaped active selections symbolically to preserve whole-fixture semantics.
#[test]
fn store_group_preserves_unshaped_active_selection() {
    let mut app = setup_app();
    insert_fixtures(&mut app, 1..=2, 2);
    let active_selection = SpatialSelection::identity(SelectionExpr::FixtureRange {
        start: unresolved_fixture_ref(1),
        end: unresolved_fixture_ref(2),
    });
    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_spatial_selection(active_selection.clone());

    let GroupAction::StoreGroup(group) = run_store_group_command(&mut app, 9);

    assert_eq!(group.selection, active_selection);
}

/// Stores projection-only active selections symbolically to preserve spatial layout metadata.
#[test]
fn store_group_preserves_projected_active_selection() {
    let mut app = setup_app();
    insert_fixtures(&mut app, 1..=4, 2);
    let active_selection = SpatialSelection::pipeline(
        SelectionExpr::FixtureRange {
            start: unresolved_fixture_ref(1),
            end: unresolved_fixture_ref(4),
        },
        vec![
            SpatialClause::Grid(GridSize::Width(2)),
            SpatialClause::Mirror(Axis::X),
        ],
    );
    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_spatial_selection(active_selection.clone());

    let GroupAction::StoreGroup(group) = run_store_group_command(&mut app, 9);

    assert_eq!(group.selection, active_selection);
}

/// Stores split-only active selections symbolically because no element expansion is frozen.
#[test]
fn store_group_preserves_split_only_active_selection() {
    let mut app = setup_app();
    insert_fixtures(&mut app, 1..=2, 2);
    let active_selection = SpatialSelection::pipeline(
        SelectionExpr::FixtureRange {
            start: unresolved_fixture_ref(1),
            end: unresolved_fixture_ref(2),
        },
        vec![SpatialClause::Split],
    );
    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_spatial_selection(active_selection.clone());

    let GroupAction::StoreGroup(group) = run_store_group_command(&mut app, 9);

    assert_eq!(group.selection, active_selection);
}

/// Stores shallow group expansion symbolically when it still resolves to whole fixtures.
#[test]
fn store_group_preserves_group_expansion_with_whole_fixtures() {
    let mut app = setup_app();
    insert_fixtures(&mut app, 1..=2, 2);
    insert_group(
        &mut app,
        group_with_selection(
            1,
            SpatialSelection::identity(SelectionExpr::FixtureRange {
                start: unresolved_fixture_ref(1),
                end: unresolved_fixture_ref(2),
            }),
        ),
    );
    let active_selection = SpatialSelection::pipeline(
        SelectionExpr::Group(GroupRefExpr::ById(1)),
        vec![SpatialClause::Expand { depth: Some(1) }],
    );
    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_spatial_selection(active_selection.clone());

    let GroupAction::StoreGroup(group) = run_store_group_command(&mut app, 9);

    assert_eq!(
        group.selection,
        SpatialSelection::pipeline(
            SelectionExpr::Group(GroupRefExpr::ByUid { uid: group_uid(1) }),
            vec![SpatialClause::Expand { depth: Some(1) }],
        )
    );
}

/// Stored group refs use stable UIDs so numeric group aliases can move later.
#[test]
fn store_group_stabilizes_group_refs_across_numeric_rename() {
    let mut app = setup_app();
    insert_fixtures(&mut app, [1], 1);
    let original_group = group_with_selection(
        1,
        SpatialSelection::identity(SelectionExpr::Fixture(unresolved_fixture_ref(1))),
    );
    let original_uid = original_group.identifiers.uid;
    insert_group(&mut app, original_group.clone());

    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_spatial_selection(SpatialSelection::identity(SelectionExpr::Group(
            GroupRefExpr::ById(1),
        )));

    let GroupAction::StoreGroup(stored_group) = run_store_group_command(&mut app, 9);

    assert_eq!(
        stored_group.selection.source,
        SelectionExpr::Group(GroupRefExpr::ByUid { uid: original_uid })
    );

    {
        let mut groups = app.world_mut().resource_mut::<DataProvider<Group>>();
        groups
            .remove(&original_uid)
            .expect("original group should remove before simulated rename");
        let mut renamed_group = original_group;
        renamed_group.identifiers.id = 2;
        groups
            .add(renamed_group)
            .expect("renamed group should insert with original UID");
    }

    let resolved = resolve_selection(&mut app, &stored_group.selection);

    assert_eq!(
        resolved.canonical_fixtures(),
        &[FixtureRef {
            fixture_uid: Uuid::from_u128(1),
            index: None,
        }]
    );
}
