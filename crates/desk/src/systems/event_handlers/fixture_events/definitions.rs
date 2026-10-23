// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Fixture definition commands: store, rename, delete, placement, and parameter offsets.

use nightfall_dmx::prelude::{Attribute, ParameterValue};

use super::*;

/// Applies one fixture definition command and reports its outcome.
pub(super) fn handle_command(
    context: &mut FixtureCrudContext,
    event: &CommandEnvelope<FixtureCommand>,
) {
    let command_id = event.command_id;
    match &event.command {
        FixtureCommand::StoreFixture(fixture) => store_fixture(context, command_id, fixture),
        FixtureCommand::RenameFixture { id, new_id } => {
            rename_fixture(context, command_id, *id, *new_id);
        }
        FixtureCommand::DeleteFixture(fixture_id) => {
            delete_fixture(context, command_id, *fixture_id);
        }
        FixtureCommand::UpdateFixturePlacements { updates } => {
            update_fixture_placements(context, command_id, updates);
        }
        FixtureCommand::UpdateFixtureParameterOffset {
            id,
            attribute,
            offset,
        } => update_fixture_parameter_offset(context, command_id, *id, attribute, *offset),
        _ => {}
    }
}

/// Stores a fixture definition.
fn store_fixture(context: &mut FixtureCrudContext, command_id: CommandId, fixture: &Fixture) {
    tracing::debug!("Storing fixture with ID: {}", fixture.identifiers.id);
    if let Err(e) = context.fixture_data_provider.inner.add(fixture.clone()) {
        tracing::warn!("Failed to store fixture: {}", e);
        fail_fixture_command(
            &mut context.responder,
            command_id,
            "fixture.store_failed",
            format!("Failed to store fixture: {}", e),
        );
        return;
    }
    succeed_fixture_command(&mut context.responder, command_id);
}

/// Moves a fixture to a free fixture ID, keeping its UID.
fn rename_fixture(context: &mut FixtureCrudContext, command_id: CommandId, id: u32, new_id: u32) {
    tracing::debug!("Renaming fixture with ID: {} to {}", id, new_id);
    if context.fixture_data_provider.inner.from_id(new_id).is_ok() {
        tracing::warn!(
            "Failed to rename fixture {} -> {}: already exists",
            id,
            new_id
        );
        fail_fixture_command(
            &mut context.responder,
            command_id,
            "fixture.id_conflict",
            format!(
                "Failed to rename fixture {} to {}: already exists",
                id, new_id
            ),
        );
        return;
    }

    let maybe_fixture = context
        .fixture_data_provider
        .inner
        .from_id(id)
        .map(|fixture| fixture.clone());
    let Ok(mut fixture) = maybe_fixture else {
        tracing::warn!("Failed to rename fixture {} -> {}: not found", id, new_id);
        fail_fixture_command(
            &mut context.responder,
            command_id,
            "fixture.not_found",
            format!("Failed to rename fixture {} to {}: not found", id, new_id),
        );
        return;
    };
    fixture.identifiers.id = new_id;
    // This is an update (same UID, new ID) so it should always succeed
    let _ = context.fixture_data_provider.inner.add(fixture);
    succeed_fixture_command(&mut context.responder, command_id);
}

/// Deletes a fixture and despawns its parameter entities.
fn delete_fixture(context: &mut FixtureCrudContext, command_id: CommandId, fixture_id: u32) {
    tracing::debug!("Deleting fixture with ID: {}", fixture_id);
    let maybe_uid = context
        .fixture_data_provider
        .inner
        .from_id(fixture_id)
        .map(|fixture| fixture.identifiers.uid);
    let Ok(uid) = maybe_uid else {
        tracing::warn!("Failed to delete fixture {}: not found", fixture_id);
        fail_fixture_command(
            &mut context.responder,
            command_id,
            "fixture.not_found",
            format!("Failed to delete fixture {}: not found", fixture_id),
        );
        return;
    };
    match context.fixture_data_provider.remove_fixture(&uid) {
        Ok((_fixture, parameter_entities)) => {
            for param_entity in parameter_entities {
                context.commands.entity(param_entity.entity()).despawn();
            }
        }
        Err(err) => {
            tracing::warn!("Failed to delete fixture {}: {}", fixture_id, err);
            fail_fixture_command(
                &mut context.responder,
                command_id,
                "fixture.delete_failed",
                format!("Failed to delete fixture {}: {}", fixture_id, err),
            );
            return;
        }
    }
    succeed_fixture_command(&mut context.responder, command_id);
}

/// Applies a batch of fixture placement updates atomically.
///
/// Every fixture must exist or no placement changes. Only updates that actually move a fixture
/// are stored and broadcast, and broadcasting suppresses the redundant fixture snapshot.
fn update_fixture_placements(
    context: &mut FixtureCrudContext,
    command_id: CommandId,
    updates: &[FixturePlacementUpdateEntry],
) {
    if updates.is_empty() {
        succeed_fixture_command(&mut context.responder, command_id);
        return;
    }

    let (fixtures_to_store, changed_updates) =
        match collect_fixture_placement_batch_updates(&context.fixture_data_provider, updates) {
            Ok(result) => result,
            Err(message) => {
                tracing::warn!("{}", message);
                fail_fixture_command(
                    &mut context.responder,
                    command_id,
                    "fixture.placement_invalid",
                    message,
                );
                return;
            }
        };

    for fixture in fixtures_to_store {
        let _ = context.fixture_data_provider.inner.add(fixture);
    }

    if !changed_updates.is_empty() {
        broadcast_fixture_command(
            &context.broadcaster,
            &FixtureCommand::UpdateFixturePlacements {
                updates: changed_updates,
            },
        );
        context
            .suppress_fixture_changed_snapshot
            .write(SuppressFixtureChangedSnapshot);
    }
    succeed_fixture_command(&mut context.responder, command_id);
}

/// Sets the offset of every parameter with `attribute` on a fixture.
///
/// Both the stored fixture definition and its live parameter entities are updated. Fails when
/// the fixture is missing or has no parameter with the attribute.
fn update_fixture_parameter_offset(
    context: &mut FixtureCrudContext,
    command_id: CommandId,
    id: u32,
    attribute: &Attribute,
    offset: ParameterValue,
) {
    tracing::debug!(
        fixture_id = id,
        ?attribute,
        "Updating parameter offset for fixture"
    );

    let maybe_fixture = context
        .fixture_data_provider
        .inner
        .from_id(id)
        .map(|fixture| fixture.clone());
    let Ok(mut fixture) = maybe_fixture else {
        tracing::warn!(
            "Failed to update parameter offset for fixture {}: not found",
            id
        );
        fail_fixture_command(
            &mut context.responder,
            command_id,
            "fixture.not_found",
            format!(
                "Failed to update parameter offset for fixture {}: not found",
                id
            ),
        );
        return;
    };

    let mut updated_metadata = false;
    for element in &mut fixture.elements {
        for parameter in &mut element.parameters {
            if parameter.attribute == *attribute {
                parameter.offset = offset;
                updated_metadata = true;
            }
        }
    }

    if !updated_metadata {
        tracing::warn!(
            "Failed to update parameter offset for fixture {}: attribute not found",
            id
        );
        fail_fixture_command(
            &mut context.responder,
            command_id,
            "fixture.attribute_not_found",
            format!(
                "Failed to update parameter offset for fixture {}: attribute not found",
                id
            ),
        );
        return;
    }

    let uid = fixture.identifiers.uid;
    let _ = context.fixture_data_provider.inner.add(fixture);

    for param_instance in context
        .fixture_data_provider
        .parameter_entities_for_fixture(uid)
    {
        let param_entity = param_instance.entity();
        if let Ok(mut param) = context.param_query.get_mut(param_entity) {
            if param.metadata.attribute == *attribute {
                param.metadata.offset = offset;
            }
        }
    }
    succeed_fixture_command(&mut context.responder, command_id);
}

fn apply_fixture_placement_update(
    fixture: &mut Fixture,
    position: &Option<FixturePlacementPositionUpdate>,
    rotation: &Option<FixturePlacementRotationUpdate>,
) -> bool {
    let previous_placement = fixture.placement.clone();

    if let Some(pos_update) = position {
        match pos_update {
            FixturePlacementPositionUpdate::All(pos) => {
                fixture.placement.position = *pos;
            }
            FixturePlacementPositionUpdate::X(x) => {
                fixture.placement.position.x = *x;
            }
            FixturePlacementPositionUpdate::Y(y) => {
                fixture.placement.position.y = *y;
            }
            FixturePlacementPositionUpdate::Z(z) => {
                fixture.placement.position.z = *z;
            }
        }
    }

    if let Some(rot_update) = rotation {
        match rot_update {
            FixturePlacementRotationUpdate::All(rot) => {
                fixture.placement.rotation = *rot;
            }
            FixturePlacementRotationUpdate::X(x) => {
                fixture.placement.rotation.x = *x;
            }
            FixturePlacementRotationUpdate::Y(y) => {
                fixture.placement.rotation.y = *y;
            }
            FixturePlacementRotationUpdate::Z(z) => {
                fixture.placement.rotation.z = *z;
            }
        }
    }

    fixture.placement != previous_placement
}

pub(super) fn collect_fixture_placement_batch_updates(
    fixture_data_provider: &FixtureDataProviderExt,
    updates: &[FixturePlacementUpdateEntry],
) -> Result<(Vec<Fixture>, Vec<FixturePlacementUpdateEntry>), String> {
    let mut staged_fixtures: HashMap<u32, Fixture> = HashMap::new();
    let mut changed_fixture_ids: HashSet<u32> = HashSet::new();
    let mut changed_updates = Vec::new();

    for update in updates {
        let fixture = match staged_fixtures.entry(update.id) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                let base_fixture = fixture_data_provider
                    .inner
                    .from_id(update.id)
                    .map(|fixture| fixture.clone())
                    .map_err(|_| {
                        format!(
                            "Failed to update placement for fixture {}: not found",
                            update.id
                        )
                    })?;
                entry.insert(base_fixture)
            }
        };

        let changed = apply_fixture_placement_update(fixture, &update.position, &update.rotation);
        if changed {
            changed_fixture_ids.insert(update.id);
            changed_updates.push(update.clone());
        }
    }

    let fixtures_to_store = changed_fixture_ids
        .into_iter()
        .filter_map(|id| staged_fixtures.remove(&id))
        .collect();

    Ok((fixtures_to_store, changed_updates))
}
