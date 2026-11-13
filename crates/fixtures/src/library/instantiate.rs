// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Stores library-derived fixtures and spawns their runtime parameter entities.
//!
//! Profile resolution differs per runtime (file-backed library natively, compiled
//! built-ins in the browser), but committing the resulting fixture template is shared
//! so every runtime produces fixtures that respond to the programmer identically, and
//! records the same undo step.

use std::collections::{HashMap, HashSet};

use bevy_ecs::entity::Entity;
use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use moonshine_kind::prelude::*;
use nightfall::prelude::FixtureRef;
use nightfall_engine::prelude::{CommandError, CommandId, UndoId};
use nightfall_undo::prelude::{UndoEntry, UndoManager, Undoable};
use uuid::Uuid;

use super::commands::{LibraryFixtureInstance, LibraryFixtureModeUpdate};
use crate::prelude::{Fixture, FixtureCommand, FixtureDataProviderExt, Parameter, ParameterValues};
use crate::undo::{FixtureSnapshot, RestoreFixtureSnapshot, snapshot_fixture_state};

/// Resolved fixture template and the library asset version it was built from.
pub struct LibraryFixtureTemplate {
    /// Fixture definition instantiated from the library profile.
    pub fixture: Fixture,
    /// Deterministic version of the library asset backing the template.
    pub asset_etag: String,
}

/// Placement of library fixtures into the show, independent of profile resolution.
#[derive(Debug, Clone)]
pub struct LibraryFixtureRequest<'a> {
    /// Fixture instances to create, in patch order; empty to only update existing fixtures.
    pub instances: Vec<LibraryFixtureInstance>,
    /// Existing fixture IDs to update to the resolved library asset version.
    pub update_existing_ids: &'a [u32],
}

impl<'a> LibraryFixtureRequest<'a> {
    /// Builds the request for a `CreateFixtureFromLibrary` command, which creates at most
    /// one fixture and creates none when `update_existing_only` is set.
    pub fn single(
        id: u32,
        label: Option<&str>,
        update_existing_ids: &'a [u32],
        update_existing_only: bool,
    ) -> Self {
        let instances = if update_existing_only {
            Vec::new()
        } else {
            vec![LibraryFixtureInstance {
                id,
                label: label.map(str::to_string),
            }]
        };
        Self {
            instances,
            update_existing_ids,
        }
    }
}

/// What one library command changed, kept as the operations that put it back.
#[derive(Debug, Default)]
pub struct LibraryFixtureUndo {
    /// Fixtures as they were before the command replaced them.
    replaced: Vec<FixtureSnapshot>,
    /// IDs of the fixtures the command created.
    created: Vec<u32>,
}

impl LibraryFixtureUndo {
    /// Adds the inverse operations to the command's undo group, so undoing the command
    /// restores every replaced fixture and deletes every created one in one step.
    ///
    /// Runtimes without an undo history pass `None` and nothing is recorded.
    pub fn record(
        self,
        undo: Option<&mut UndoManager>,
        command_id: CommandId,
        undo_id: UndoId,
        description: &str,
    ) {
        let Some(undo) = undo else {
            return;
        };
        let restores = self
            .replaced
            .into_iter()
            .map(|snapshot| Box::new(RestoreFixtureSnapshot(snapshot)) as Box<dyn Undoable>);
        let deletes = self
            .created
            .into_iter()
            .map(|id| Box::new(FixtureCommand::DeleteFixture(id)) as Box<dyn Undoable>);
        for command in restores.chain(deletes) {
            undo.push(
                UndoEntry {
                    command,
                    description: description.to_string(),
                    command_id: Some(command_id),
                    coalesce_key: None,
                },
                undo_id,
                true,
            );
        }
    }
}

/// The show state a library command writes fixtures into, and the undo history it records
/// the change in.
///
/// Every runtime serving fixture-library commands goes through this, so creating and
/// updating library fixtures is undoable the same way everywhere.
#[derive(SystemParam)]
pub struct LibraryFixtureStore<'w, 's> {
    commands: Commands<'w, 's>,
    fixtures: ResMut<'w, FixtureDataProviderExt>,
    parameters: Query<'w, 's, &'static Parameter>,
    undo: Option<ResMut<'w, UndoManager>>,
}

impl LibraryFixtureStore<'_, '_> {
    /// Creates and updates library fixtures as [`create_library_fixtures`] does, recording
    /// one undo step for the command that deletes the created fixtures and restores the
    /// updated ones.
    pub fn create(
        &mut self,
        command_id: CommandId,
        undo_id: UndoId,
        request: &LibraryFixtureRequest<'_>,
        resolve_template: impl FnOnce() -> Result<LibraryFixtureTemplate, CommandError>,
    ) -> Result<(), CommandError> {
        let parameters = &self.parameters;
        let undo = create_library_fixtures(
            &mut self.commands,
            &mut self.fixtures,
            |entity| parameters.get(entity).ok().map(|p| p.values.clone()),
            request,
            resolve_template,
        )?;
        let description = if request.instances.is_empty() {
            "Change Fixture Type from Library"
        } else {
            "Patch Fixtures from Library"
        };
        undo.record(self.undo.as_deref_mut(), command_id, undo_id, description);
        Ok(())
    }

    /// Moves fixtures to another library revision as [`update_library_fixtures`] does,
    /// recording one undo step for the command that restores every fixture as it was.
    pub fn update_to_revision(
        &mut self,
        command_id: CommandId,
        undo_id: UndoId,
        updates: &[LibraryFixtureModeUpdate],
        resolve_mode: impl FnMut(&str) -> Result<LibraryFixtureTemplate, CommandError>,
    ) -> Result<(), CommandError> {
        let parameters = &self.parameters;
        let undo = update_library_fixtures(
            &mut self.commands,
            &mut self.fixtures,
            |entity| parameters.get(entity).ok().map(|p| p.values.clone()),
            updates,
            resolve_mode,
        )?;
        let description = match updates.len() {
            1 => "Update 1 Fixture to New Revision".to_string(),
            count => format!("Update {count} Fixtures to New Revision"),
        };
        undo.record(self.undo.as_deref_mut(), command_id, undo_id, &description);
        Ok(())
    }
}

/// Validates, resolves, and atomically commits library fixture creations and updates.
///
/// Request-shape checks run before `resolve_template` so invalid requests never
/// touch the profile source. The template is resolved once and copied for every
/// instance, each with its own ID and UID. Every update target and new fixture is
/// validated before any stored state changes, so one rejected ID leaves the show
/// unchanged; parameter entities are spawned through `commands` and become visible
/// once the command buffer applies. `parameter_values` reads the live values of the
/// fixtures being replaced, so the returned undo restores them.
pub fn create_library_fixtures(
    commands: &mut Commands,
    fixtures: &mut FixtureDataProviderExt,
    parameter_values: impl Fn(Entity) -> Option<ParameterValues>,
    request: &LibraryFixtureRequest<'_>,
    resolve_template: impl FnOnce() -> Result<LibraryFixtureTemplate, CommandError>,
) -> Result<LibraryFixtureUndo, CommandError> {
    let LibraryFixtureRequest {
        instances,
        update_existing_ids,
    } = request;
    if instances.is_empty() && update_existing_ids.is_empty() {
        return Err(no_fixtures_error());
    }
    if let Some(instance) = instances
        .iter()
        .find(|instance| fixtures.inner.from_id(instance.id).is_ok())
    {
        return Err(CommandError::new(
            "fixture_library.fixture_id_in_use",
            format!("Fixture ID {} is already in use", instance.id),
        ));
    }
    if has_repeats(instances.iter().map(|instance| instance.id)) {
        return Err(CommandError::new(
            "fixture_library.duplicate_fixture_id",
            "A fixture ID was specified more than once",
        ));
    }
    if has_repeats(update_existing_ids.iter().copied()) {
        return Err(duplicate_update_target_error());
    }

    let LibraryFixtureTemplate {
        fixture: mut template,
        asset_etag,
    } = resolve_template()?;
    template.library_asset_etag = Some(asset_etag.clone());

    let updates = update_existing_ids
        .iter()
        .map(|update_id| updated_fixture(fixtures, *update_id, &template, &asset_etag))
        .collect::<Result<Vec<_>, _>>()?;
    let created = instances
        .iter()
        .map(|instance| {
            let mut fixture = template.clone();
            fixture.identifiers.id = instance.id;
            fixture.identifiers.uid = Uuid::new_v4();
            if let Some(label) = &instance.label {
                fixture.identifiers.label = label.clone();
            }
            fixture
        })
        .collect::<Vec<_>>();
    commit_library_fixtures(commands, fixtures, parameter_values, updates, created)
}

/// Moves existing fixtures to another library revision, each rebuilt from the revision's
/// mode named for it, as one atomic change.
///
/// `resolve_mode` is called once per distinct mode. Every fixture keeps its ID, UID,
/// label and placement; DMX routes are left alone. The update is rejected before anything
/// changes when an ID is missing or repeated, a mode can't be resolved, or a fixture left
/// out of the update would keep another revision of the same make, model and mode as an
/// updated fixture, since a show holds one revision of each.
pub fn update_library_fixtures(
    commands: &mut Commands,
    fixtures: &mut FixtureDataProviderExt,
    parameter_values: impl Fn(Entity) -> Option<ParameterValues>,
    updates: &[LibraryFixtureModeUpdate],
    mut resolve_mode: impl FnMut(&str) -> Result<LibraryFixtureTemplate, CommandError>,
) -> Result<LibraryFixtureUndo, CommandError> {
    if updates.is_empty() {
        return Err(no_fixtures_error());
    }
    if has_repeats(updates.iter().map(|update| update.id)) {
        return Err(duplicate_update_target_error());
    }
    for update in updates {
        let Ok(existing) = fixtures.inner.from_id(update.id) else {
            return Err(fixture_not_found_error(update.id));
        };
        if existing.library_asset_etag.is_none() {
            return Err(CommandError::new(
                "fixture_library.not_a_library_fixture",
                format!(
                    "Fixture {} wasn't created from the fixture library, so it has no \
                     revision to update",
                    update.id
                ),
            ));
        }
    }

    let mut templates: HashMap<&str, LibraryFixtureTemplate> = HashMap::new();
    for update in updates {
        if !templates.contains_key(update.mode.as_str()) {
            templates.insert(update.mode.as_str(), resolve_mode(&update.mode)?);
        }
    }
    let replacements = updates
        .iter()
        .map(|update| {
            let template = &templates[update.mode.as_str()];
            updated_fixture(fixtures, update.id, &template.fixture, &template.asset_etag)
        })
        .collect::<Result<Vec<_>, _>>()?;

    let updated_ids = updates
        .iter()
        .map(|update| update.id)
        .collect::<HashSet<_>>();
    let revision_of_mode = replacements
        .iter()
        .map(|fixture| {
            (
                (&fixture.make, &fixture.model, &fixture.mode),
                &fixture.library_asset_etag,
            )
        })
        .collect::<HashMap<_, _>>();
    let left_behind = fixtures
        .inner
        .iter()
        .find(|other| {
            !updated_ids.contains(&other.identifiers.id)
                && other.library_asset_etag.is_some()
                && revision_of_mode
                    .get(&(&other.make, &other.model, &other.mode))
                    .is_some_and(|revision| **revision != other.library_asset_etag)
        })
        .map(|other| {
            CommandError::new(
                "fixture_library.mixed_revisions",
                format!(
                    "Fixture {} also uses {} {} ({}) from another revision; update it too, \
                     since a show holds one revision of each mode",
                    other.identifiers.id, other.make, other.model, other.mode
                ),
            )
        });
    drop(revision_of_mode);
    if let Some(error) = left_behind {
        return Err(error);
    }

    commit_library_fixtures(
        commands,
        fixtures,
        parameter_values,
        replacements,
        Vec::new(),
    )
}

/// Validates every replacement and creation, then stores them all and spawns their
/// parameters, snapshotting each replaced fixture first so the change can be undone.
fn commit_library_fixtures(
    commands: &mut Commands,
    fixtures: &mut FixtureDataProviderExt,
    parameter_values: impl Fn(Entity) -> Option<ParameterValues>,
    replacements: Vec<Fixture>,
    created: Vec<Fixture>,
) -> Result<LibraryFixtureUndo, CommandError> {
    for fixture in replacements.iter().chain(&created) {
        fixtures
            .inner
            .validate_add(fixture)
            .map_err(|error| fixture_store_error(fixture.identifiers.id, error.to_string()))?;
    }

    let mut undo = LibraryFixtureUndo::default();
    for fixture in replacements {
        if let Ok(existing) = fixtures.inner.get(fixture.identifiers.uid) {
            let snapshot = snapshot_fixture_state(fixtures, &existing, &parameter_values);
            undo.replaced.push(snapshot);
        }
        replace_fixture(commands, fixtures, fixture)?;
    }
    for fixture in created {
        let id = fixture.identifiers.id;
        fixtures
            .inner
            .add(fixture.clone())
            .map_err(|error| fixture_store_error(id, error.to_string()))?;
        add_fixture_parameters(commands, fixtures, &fixture);
        undo.created.push(id);
    }
    Ok(undo)
}

/// Reports whether any value occurs more than once.
fn has_repeats(values: impl ExactSizeIterator<Item = u32>) -> bool {
    let count = values.len();
    values.collect::<HashSet<_>>().len() != count
}

/// Builds an updated fixture definition without changing stored state.
fn updated_fixture(
    fixtures: &FixtureDataProviderExt,
    fixture_id: u32,
    template: &Fixture,
    asset_etag: &str,
) -> Result<Fixture, CommandError> {
    let existing = fixtures
        .inner
        .from_id(fixture_id)
        .map(|fixture| fixture.clone())
        .map_err(|_| fixture_not_found_error(fixture_id))?;
    let mut updated = template.clone();
    updated.identifiers = existing.identifiers;
    updated.placement = existing.placement;
    updated.library_asset_etag = Some(asset_etag.to_string());
    Ok(updated)
}

/// Replaces one validated fixture and rebuilds its parameter entities.
pub(crate) fn replace_fixture(
    commands: &mut Commands,
    fixtures: &mut FixtureDataProviderExt,
    fixture: Fixture,
) -> Result<(), CommandError> {
    let fixture_id = fixture.identifiers.id;
    let fixture_uid = fixture.identifiers.uid;
    let (_, removed_parameters) = fixtures
        .remove_fixture(&fixture_uid)
        .map_err(|error| fixture_store_error(fixture_id, error.to_string()))?;
    for parameter in removed_parameters {
        commands.entity(parameter.entity()).despawn();
    }
    fixtures
        .inner
        .add(fixture.clone())
        .map_err(|error| fixture_store_error(fixture_id, error.to_string()))?;
    add_fixture_parameters(commands, fixtures, &fixture);
    Ok(())
}

/// Builds the failure for a request that names no fixture to create or update.
fn no_fixtures_error() -> CommandError {
    CommandError::new(
        "fixture_library.no_fixtures",
        "No fixtures were provided to create or update",
    )
}

/// Builds the failure for a request that names one update target twice.
fn duplicate_update_target_error() -> CommandError {
    CommandError::new(
        "fixture_library.duplicate_update_target",
        "A fixture update target was specified more than once",
    )
}

/// Builds the failure for an update target that is not in the show.
fn fixture_not_found_error(fixture_id: u32) -> CommandError {
    CommandError::new(
        "fixture_library.fixture_not_found",
        format!("Fixture {fixture_id} does not exist"),
    )
}

/// Builds a stable failure for fixture storage and replacement errors.
fn fixture_store_error(id: u32, error: String) -> CommandError {
    CommandError::new(
        "fixture_library.fixture_store_failed",
        format!("Failed to store fixture {id}: {error}"),
    )
}

/// Spawns and indexes the runtime parameter entities for one stored fixture.
pub fn add_fixture_parameters(
    commands: &mut Commands,
    fixtures: &mut FixtureDataProviderExt,
    fixture: &Fixture,
) {
    let fixture_uid = fixture.identifiers.uid;
    for (element_index, element) in fixture.elements.iter().enumerate() {
        let fixture_ref = FixtureRef {
            fixture_uid,
            index: Some(element_index as u32 + 1),
        };
        for metadata in &element.parameters {
            let parameter = commands
                .spawn_instance(Parameter {
                    metadata: metadata.clone(),
                    values: ParameterValues::from_metadata(metadata),
                })
                .instance();
            fixtures.add_parameter(fixture_ref.clone(), metadata.attribute.clone(), parameter);
        }
    }
}
