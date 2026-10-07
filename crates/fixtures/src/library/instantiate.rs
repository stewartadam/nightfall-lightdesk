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
//! so every runtime produces fixtures that respond to the programmer identically.

use std::collections::HashSet;

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall::prelude::FixtureRef;
use nightfall_engine::prelude::CommandError;
use uuid::Uuid;

use super::commands::LibraryFixtureInstance;
use crate::prelude::{Fixture, FixtureDataProviderExt, Parameter, ParameterValues};

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

/// Validates, resolves, and atomically commits library fixture creations and updates.
///
/// Request-shape checks run before `resolve_template` so invalid requests never
/// touch the profile source. The template is resolved once and copied for every
/// instance, each with its own ID and UID. Every update target and new fixture is
/// validated before any stored state changes, so one rejected ID leaves the show
/// unchanged; parameter entities are spawned through `commands` and become visible
/// once the command buffer applies.
pub fn create_library_fixtures(
    commands: &mut Commands,
    fixtures: &mut FixtureDataProviderExt,
    request: &LibraryFixtureRequest<'_>,
    resolve_template: impl FnOnce() -> Result<LibraryFixtureTemplate, CommandError>,
) -> Result<(), CommandError> {
    let LibraryFixtureRequest {
        instances,
        update_existing_ids,
    } = request;
    if instances.is_empty() && update_existing_ids.is_empty() {
        return Err(CommandError::new(
            "fixture_library.no_fixtures",
            "No fixtures were provided to create or update",
        ));
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
    if instances
        .iter()
        .map(|instance| instance.id)
        .collect::<HashSet<_>>()
        .len()
        != instances.len()
    {
        return Err(CommandError::new(
            "fixture_library.duplicate_fixture_id",
            "A fixture ID was specified more than once",
        ));
    }
    if update_existing_ids.iter().collect::<HashSet<_>>().len() != update_existing_ids.len() {
        return Err(CommandError::new(
            "fixture_library.duplicate_update_target",
            "A fixture update target was specified more than once",
        ));
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
    for fixture in updates.iter().chain(&created) {
        fixtures
            .inner
            .validate_add(fixture)
            .map_err(|error| fixture_store_error(fixture.identifiers.id, error.to_string()))?;
    }

    for fixture in updates {
        replace_fixture(commands, fixtures, fixture)?;
    }
    for fixture in created {
        let id = fixture.identifiers.id;
        fixtures
            .inner
            .add(fixture.clone())
            .map_err(|error| fixture_store_error(id, error.to_string()))?;
        add_fixture_parameters(commands, fixtures, &fixture);
    }
    Ok(())
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
        .map_err(|_| {
            CommandError::new(
                "fixture_library.fixture_not_found",
                format!("Fixture {fixture_id} does not exist"),
            )
        })?;
    let mut updated = template.clone();
    updated.identifiers = existing.identifiers;
    updated.placement = existing.placement;
    updated.library_asset_etag = Some(asset_etag.to_string());
    Ok(updated)
}

/// Replaces one validated fixture and rebuilds its parameter entities.
fn replace_fixture(
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
