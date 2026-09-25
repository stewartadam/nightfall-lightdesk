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
use nightfall_dmx::prelude::Attribute;
use nightfall_engine::prelude::CommandError;

use crate::prelude::{
    Fixture, FixtureDataProviderExt, Parameter, ParameterMetadata, ParameterValues,
};

/// Resolved fixture template and the library asset version it was built from.
pub struct LibraryFixtureTemplate {
    /// Fixture definition instantiated from the library profile.
    pub fixture: Fixture,
    /// Deterministic version of the library asset backing the template.
    pub asset_etag: String,
}

/// Placement of a library fixture into the show, independent of profile resolution.
#[derive(Debug, Clone, Copy)]
pub struct LibraryFixtureRequest<'a> {
    /// Fixture ID for the newly created fixture.
    pub id: u32,
    /// Optional user-facing label applied to the created fixture.
    pub label: Option<&'a str>,
    /// Existing fixture IDs to update to the resolved library asset version.
    pub update_existing_ids: &'a [u32],
    /// Update existing fixtures without creating a new fixture instance.
    pub update_existing_only: bool,
}

/// Validates, resolves, and atomically commits one library fixture creation.
///
/// Request-shape checks run before `resolve_template` so invalid requests never
/// touch the profile source. Every update target and the new fixture are validated
/// before any stored state changes; parameter entities are spawned through
/// `commands` and become visible once the command buffer applies.
pub fn create_library_fixture(
    commands: &mut Commands,
    fixtures: &mut FixtureDataProviderExt,
    request: LibraryFixtureRequest<'_>,
    resolve_template: impl FnOnce() -> Result<LibraryFixtureTemplate, CommandError>,
) -> Result<(), CommandError> {
    let LibraryFixtureRequest {
        id,
        label,
        update_existing_ids,
        update_existing_only,
    } = request;
    if update_existing_only && update_existing_ids.is_empty() {
        return Err(CommandError::new(
            "fixture_library.no_update_targets",
            "No existing fixture IDs were provided for fixture update",
        ));
    }
    if !update_existing_only && fixtures.inner.from_id(id).is_ok() {
        return Err(CommandError::new(
            "fixture_library.fixture_id_in_use",
            format!("Fixture ID {id} is already in use"),
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
    if let Some(label) = label {
        template.identifiers.label = label.to_string();
    }
    template.library_asset_etag = Some(asset_etag.clone());

    let updates = update_existing_ids
        .iter()
        .map(|update_id| updated_fixture(fixtures, *update_id, &template, &asset_etag))
        .collect::<Result<Vec<_>, _>>()?;
    for fixture in &updates {
        fixtures
            .inner
            .validate_add(fixture)
            .map_err(|error| fixture_store_error(fixture.identifiers.id, error.to_string()))?;
    }
    if !update_existing_only {
        fixtures
            .inner
            .validate_add(&template)
            .map_err(|error| fixture_store_error(id, error.to_string()))?;
    }

    for fixture in updates {
        replace_fixture(commands, fixtures, fixture)?;
    }
    if !update_existing_only {
        fixtures
            .inner
            .add(template.clone())
            .map_err(|error| fixture_store_error(id, error.to_string()))?;
        add_fixture_parameters(commands, fixtures, &template);
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

/// Derives initial runtime values for parameters spawned from fixture metadata.
///
/// Virtual intensity starts at full scale so colour-only fixtures emit light as soon
/// as a colour is applied; every other attribute keeps the standard defaults.
pub fn initial_parameter_values(parameter_metadata: &ParameterMetadata) -> ParameterValues {
    if parameter_metadata.attribute == Attribute::VirtualIntensity {
        ParameterValues {
            default_value: parameter_metadata.max,
            current_value: parameter_metadata.max,
            highlight_value: parameter_metadata.max,
        }
    } else {
        ParameterValues::default()
    }
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
                    values: initial_parameter_values(metadata),
                })
                .instance();
            fixtures.add_parameter(fixture_ref.clone(), metadata.attribute.clone(), parameter);
        }
    }
}
