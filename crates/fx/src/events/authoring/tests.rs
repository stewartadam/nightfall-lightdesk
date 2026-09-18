// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Persistence and command resolution regression tests.

use std::time::Duration;

use bevy_app::{App, Update};
use nightfall_fixtures::prelude::FixtureDataProviderExt;

use super::super::test_support::valid_step_fx;
use super::*;

/// Builds a focused app for step FX persistence tests.
fn step_fx_command_app() -> App {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<DataProvider<Blueprint>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.add_message::<CommandEnvelope<StepFxCommand>>();
    app.add_message::<EngineActionEnvelope<PlaybackReleaseAction>>();
    app.add_message::<StepFxCommandResult>();
    app.add_systems(Update, handle_step_fx_commands);
    app
}

/// Builds a one-value Blueprint for Step FX command resolution tests.
fn scalar_blueprint(
    id: u32,
    uid: Uuid,
    label: &str,
    attribute: Attribute,
    value: ParameterValue,
) -> Blueprint {
    Blueprint {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_owned(),
        },
        values: HashMap::from([(attribute, ValueSource::Inline(value))]),
        ..Blueprint::default()
    }
}

/// Builds a minimal draft whose sole red step uses the supplied command source.
fn blueprint_step_fx_draft(source: StepFxCommandValueSource) -> StepFxDraft {
    StepFxDraft {
        identifiers: Identifiers {
            id: 9,
            uid: Uuid::from_u128(0x903),
            label: "Blueprint Step FX".to_owned(),
        },
        selection: SpatialSelection::default(),
        timing: StepFxTiming::default(),
        phase: StepFxPhase::default(),
        direction: FxDirection::Forward,
        cycle_scale: StepFxCycleScale::Auto,
        sequences: vec![FxStepSequenceDraft {
            attribute: Attribute::Red,
            base_value: None,
            steps: vec![FxStepDraft {
                uid: Uuid::from_u128(0x905),
                target: source,
                width_beats: 1.0,
                transition: 0.0.into(),
                curve: CurveType::Linear(Linear {}),
            }],
        }],
    }
}

/// Verifies referenced sources remain live while absolute sources retain their copied value.
#[test]
fn create_step_fx_resolves_reference_and_absolute_sources() {
    let blueprint_uid = Uuid::from_u128(0x901);
    let mut provider = DataProvider::<Blueprint>::default();
    provider
        .add(scalar_blueprint(
            1,
            blueprint_uid,
            "FX Red",
            Attribute::Red,
            ParameterValue::AbsolutePercent { value: 0.25.into() },
        ))
        .expect("Blueprint should store");
    let referenced = resolve_step_fx_draft(
        blueprint_step_fx_draft(StepFxCommandValueSource::Blueprint {
            address: BlueprintAddress::Label("fx red".to_owned()),
            resolution: BlueprintResolution::Reference,
        }),
        &provider,
    )
    .expect("reference should resolve");
    let absolute = resolve_step_fx_draft(
        blueprint_step_fx_draft(StepFxCommandValueSource::Blueprint {
            address: BlueprintAddress::Id(1),
            resolution: BlueprintResolution::Absolute,
        }),
        &provider,
    )
    .expect("absolute source should resolve");

    provider
        .remove(&blueprint_uid)
        .expect("original Blueprint should remove");
    provider
        .add(scalar_blueprint(
            1,
            blueprint_uid,
            "FX Red",
            Attribute::Red,
            ParameterValue::AbsolutePercent { value: 0.75.into() },
        ))
        .expect("edited Blueprint should store");
    let offsets = StepFxLanePhaseOffsets::default();
    let referenced_sample = referenced.sample_for_selection_index_with_offsets_and_blueprints(
        Duration::ZERO,
        0,
        1,
        &offsets,
        Some(&provider),
    )[0]
    .absolute;
    let absolute_sample = absolute.sample_for_selection_index_with_offsets_and_blueprints(
        Duration::ZERO,
        0,
        1,
        &offsets,
        Some(&provider),
    )[0]
    .absolute;

    assert_eq!(
        referenced_sample,
        Some(ParameterValue::AbsolutePercent { value: 0.75.into() })
    );
    assert_eq!(
        absolute_sample,
        Some(ParameterValue::AbsolutePercent { value: 0.25.into() })
    );
}

/// Sends one detached Step FX command through the domain command system.
fn send_step_fx_command(app: &mut App, command: StepFxCommand) {
    app.world_mut().write_message(CommandEnvelope::new(
        command,
        CommandOrigin::Cli,
        ReplyTarget::Detached,
    ));
    app.update();
}

/// Verifies Step FX storage binds authored group aliases to stable group identities.
#[test]
fn store_step_fx_stabilizes_group_selection() {
    let mut app = step_fx_command_app();
    let group_uid = Uuid::from_u128(0x501);
    app.world_mut()
        .resource_mut::<DataProvider<Group>>()
        .add(Group {
            identifiers: Identifiers {
                id: 5,
                uid: group_uid,
                label: "Step FX target".to_owned(),
            },
            selection: SpatialSelection::default(),
            description: String::new(),
        })
        .expect("group should store");
    let step_fx = valid_step_fx(
        1,
        Uuid::from_u128(0x502),
        SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ById(5))),
    );
    app.world_mut().write_message(CommandEnvelope::new(
        StepFxCommand::Store(step_fx),
        CommandOrigin::Cli,
        ReplyTarget::Detached,
    ));

    app.update();

    let mut query = app.world_mut().query::<&StepFx>();
    let stored = query
        .single(app.world())
        .expect("step FX should be spawned");
    assert_eq!(
        stored.selection.source,
        SelectionExpr::Group(GroupRefExpr::ByUid { uid: group_uid })
    );
}

/// Verifies malformed drafts are rejected once and never become stored definitions.
#[test]
fn store_step_fx_rejects_invalid_draft_with_one_terminal_result() {
    let mut app = step_fx_command_app();
    let mut step_fx = valid_step_fx(1, Uuid::from_u128(0x601), SpatialSelection::default());
    step_fx.lanes[0].absolute.as_mut().unwrap().steps[0].width_beats = 0.0;

    send_step_fx_command(&mut app, StepFxCommand::Store(step_fx));

    assert_eq!(
        app.world()
            .resource::<Messages<StepFxCommandResult>>()
            .len(),
        1
    );
    assert_eq!(
        app.world_mut().query::<&StepFx>().iter(app.world()).count(),
        0
    );
}

/// Verifies user-facing IDs cannot silently replace a definition with another stable UID.
#[test]
fn store_step_fx_rejects_id_collision() {
    let mut app = step_fx_command_app();
    app.world_mut().spawn(valid_step_fx(
        7,
        Uuid::from_u128(0x610),
        SpatialSelection::default(),
    ));

    send_step_fx_command(
        &mut app,
        StepFxCommand::Store(valid_step_fx(
            7,
            Uuid::from_u128(0x611),
            SpatialSelection::default(),
        )),
    );

    assert_eq!(
        app.world()
            .resource::<Messages<StepFxCommandResult>>()
            .len(),
        1
    );
    assert_eq!(
        app.world_mut().query::<&StepFx>().iter(app.world()).count(),
        1
    );
}

/// Verifies same-frame stores observe earlier accepted definitions instead of duplicating them.
#[test]
fn same_frame_step_fx_stores_apply_in_message_order() {
    let mut app = step_fx_command_app();
    let uid = Uuid::from_u128(0x615);
    let first = valid_step_fx(7, uid, SpatialSelection::default());
    let mut second = first.clone();
    second.identifiers.label = "Latest definition".to_owned();
    for definition in [first, second] {
        app.world_mut().write_message(CommandEnvelope::new(
            StepFxCommand::Store(definition),
            CommandOrigin::Cli,
            ReplyTarget::Detached,
        ));
    }

    app.update();

    let stored = app
        .world_mut()
        .query::<&StepFx>()
        .single(app.world())
        .expect("same-frame replacement should leave one definition");
    assert_eq!(stored.identifiers.label, "Latest definition");
    assert_eq!(
        app.world()
            .resource::<Messages<StepFxCommandResult>>()
            .len(),
        2
    );
}

/// Verifies a newly stored definition can be deleted before deferred commands apply.
#[test]
fn same_frame_new_step_fx_store_then_delete_leaves_no_definition() {
    let mut app = step_fx_command_app();
    let definition = valid_step_fx(7, Uuid::from_u128(0x616), SpatialSelection::default());
    for command in [StepFxCommand::Store(definition), StepFxCommand::Delete(7)] {
        app.world_mut().write_message(CommandEnvelope::new(
            command,
            CommandOrigin::Cli,
            ReplyTarget::Detached,
        ));
    }

    app.update();

    assert_eq!(
        app.world_mut().query::<&StepFx>().iter(app.world()).count(),
        0
    );
    assert_eq!(
        app.world()
            .resource::<Messages<StepFxCommandResult>>()
            .len(),
        2
    );
}

/// Verifies a newly stored definition is visible to a later Start in the same update.
#[test]
fn same_frame_new_step_fx_store_then_start_spawns_playback() {
    let mut app = step_fx_command_app();
    let definition = valid_step_fx(7, Uuid::from_u128(0x618), SpatialSelection::default());
    for command in [StepFxCommand::Store(definition), StepFxCommand::Start(7)] {
        app.world_mut().write_message(CommandEnvelope::new(
            command,
            CommandOrigin::Cli,
            ReplyTarget::Detached,
        ));
    }

    app.update();

    let (active_fx_entity, metadata_name) = {
        let (active, metadata) = app
            .world_mut()
            .query::<(&ActiveStepFx, &InstanceMetadata)>()
            .single(app.world())
            .expect("same-frame Start should spawn one playback");
        (active.fx_entity, metadata.name.clone())
    };
    let stored_entity = app
        .world_mut()
        .query_filtered::<Entity, With<StepFx>>()
        .single(app.world())
        .expect("stored definition should exist");
    assert_eq!(active_fx_entity, stored_entity);
    assert_eq!(metadata_name.as_deref(), Some("Step FX 7"));
    assert_eq!(
        app.world()
            .resource::<Messages<StepFxCommandResult>>()
            .len(),
        2
    );
}

/// Verifies replacing and deleting a definition in one frame removes the replacement.
#[test]
fn same_frame_replacement_step_fx_store_then_delete_leaves_no_definition() {
    let mut app = step_fx_command_app();
    let uid = Uuid::from_u128(0x617);
    let original = valid_step_fx(7, uid, SpatialSelection::default());
    let original_entity = app.world_mut().spawn(original.clone()).id();
    let active_entity = app
        .world_mut()
        .spawn(ActiveStepFx {
            fx_entity: original_entity,
            priority: Priority(50),
            rate: 1.0,
            is_playing: true,
        })
        .id();
    let mut replacement = original;
    replacement.identifiers.label = "Replacement".to_owned();
    for command in [StepFxCommand::Store(replacement), StepFxCommand::Delete(7)] {
        app.world_mut().write_message(CommandEnvelope::new(
            command,
            CommandOrigin::Cli,
            ReplyTarget::Detached,
        ));
    }

    app.update();

    assert_eq!(
        app.world_mut().query::<&StepFx>().iter(app.world()).count(),
        0
    );
    assert_eq!(
        app.world()
            .resource::<Messages<StepFxCommandResult>>()
            .len(),
        2
    );
    assert!(app.world().get::<ReleaseMarker>(active_entity).is_some());
}

/// Verifies replacing a definition rebinds active runtimes and preserves normalized phase.
#[test]
fn store_step_fx_rebinds_active_playback_at_same_phase() {
    let mut app = step_fx_command_app();
    let uid = Uuid::from_u128(0x620);
    let old = valid_step_fx(8, uid, SpatialSelection::default());
    let old_entity = app.world_mut().spawn(old.clone()).id();
    let active_entity = app
        .world_mut()
        .spawn((
            ActiveStepFx {
                fx_entity: old_entity,
                priority: Priority(50),
                rate: 1.0,
                is_playing: true,
            },
            InstanceClock {
                position: Duration::from_millis(250),
                ..Default::default()
            },
            InstanceMetadata::new(InstanceKind::Fx)
                .with_display_kind(InstanceDisplayKind::StepFx)
                .with_name("Original")
                .with_tags(vec!["operator-tag".to_owned()]),
        ))
        .id();
    let mut replacement = old;
    replacement.identifiers.label = "Replacement".to_owned();
    for step in &mut replacement.lanes[0].absolute.as_mut().unwrap().steps {
        step.width_beats = 2.0;
    }

    send_step_fx_command(&mut app, StepFxCommand::Store(replacement));

    assert!(app.world().get_entity(old_entity).is_err());
    let active = app.world().get::<ActiveStepFx>(active_entity).unwrap();
    assert_ne!(active.fx_entity, old_entity);
    assert_eq!(
        app.world()
            .get::<InstanceClock>(active_entity)
            .unwrap()
            .position,
        Duration::from_millis(500)
    );
    let metadata = app.world().get::<InstanceMetadata>(active_entity).unwrap();
    assert_eq!(metadata.name.as_deref(), Some("Replacement"));
    assert_eq!(metadata.tags, vec!["operator-tag"]);
}

/// Verifies deletion removes the stored definition and emits one terminal outcome.
#[test]
fn delete_step_fx_removes_definition() {
    let mut app = step_fx_command_app();
    app.world_mut().spawn(valid_step_fx(
        9,
        Uuid::from_u128(0x630),
        SpatialSelection::default(),
    ));

    send_step_fx_command(&mut app, StepFxCommand::Delete(9));

    assert_eq!(
        app.world()
            .resource::<Messages<StepFxCommandResult>>()
            .len(),
        1
    );
    assert_eq!(
        app.world_mut().query::<&StepFx>().iter(app.world()).count(),
        0
    );
}
