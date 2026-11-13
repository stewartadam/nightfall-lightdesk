// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! End-to-end undo and redo of fixture edits and deletes in a sample-data world.

use nightfall_engine::prelude::CommandOutcome;
use nightfall_fixtures::prelude::{
    Fixture, FixtureCommand, FixtureDataProviderExt, OutputRoute, OutputRoutes,
};
use nightfall_undo::prelude::UndoCommand;

use super::desk_harness::DeskHarness;

/// A sample fixture with more than one element, so a mode change can drop one.
const FIXTURE_ID: u32 = 601;

impl DeskHarness {
    /// Returns the stored definition of a fixture, if it exists.
    fn fixture(&self, id: u32) -> Option<Fixture> {
        self.app
            .world()
            .resource::<FixtureDataProviderExt>()
            .inner
            .from_id(id)
            .ok()
            .map(|fixture| fixture.clone())
    }

    /// Counts the live parameter entities of a fixture.
    fn parameter_count(&self, fixture: &Fixture) -> usize {
        self.app
            .world()
            .resource::<FixtureDataProviderExt>()
            .parameter_entities_for_fixture(fixture.identifiers.uid)
            .len()
    }

    /// Returns every output route, to check edits and their undo leave patching alone.
    fn output_routes(&self) -> Vec<OutputRoute> {
        self.app.world().resource::<OutputRoutes>().routes.clone()
    }

    /// Stores a fixture definition through the client command path and asserts it succeeded.
    fn store_fixture(&mut self, fixture: Fixture) {
        let command = self.submit(FixtureCommand::StoreFixture(fixture));
        assert_eq!(self.wait(command), CommandOutcome::succeeded());
    }
}

/// Redoing an undone label change re-applies the label, keeping the fixture and its routes,
/// instead of deleting the fixture.
#[tokio::test]
async fn redo_of_fixture_label_change_reapplies_it() {
    let mut harness = DeskHarness::new();
    let original = harness.fixture(FIXTURE_ID).expect("sample fixture");
    let routes = harness.output_routes();
    let mut updated = original.clone();
    updated.identifiers.label = "Renamed by a client".to_string();

    harness.store_fixture(updated.clone());
    assert_eq!(
        harness.history(UndoCommand::Undo {}),
        CommandOutcome::succeeded()
    );
    assert_eq!(
        harness.fixture(FIXTURE_ID).map(|f| f.identifiers.label),
        Some(original.identifiers.label)
    );

    assert_eq!(
        harness.history(UndoCommand::Redo {}),
        CommandOutcome::succeeded()
    );
    assert_eq!(
        harness.fixture(FIXTURE_ID).map(|f| f.identifiers.label),
        Some(updated.identifiers.label),
        "redo should re-apply the update"
    );
    assert_eq!(harness.output_routes(), routes);
}

/// Undo and redo of a change that rebuilds a fixture's parameters swap between the two
/// element layouts, each time with live parameter entities for every parameter.
#[tokio::test]
async fn redo_of_fixture_mode_change_rebuilds_its_parameters() {
    let mut harness = DeskHarness::new();
    let original = harness.fixture(FIXTURE_ID).expect("sample fixture");
    let original_parameters = harness.parameter_count(&original);
    let mut updated = original.clone();
    updated
        .elements
        .pop()
        .expect("fixture should have elements");
    assert!(
        !updated.elements.is_empty(),
        "fixture should keep an element"
    );

    harness.store_fixture(updated.clone());
    let updated_parameters = harness.parameter_count(&updated);
    assert!(updated_parameters < original_parameters);

    assert_eq!(
        harness.history(UndoCommand::Undo {}),
        CommandOutcome::succeeded()
    );
    assert_eq!(
        harness.fixture(FIXTURE_ID).map(|f| f.elements.len()),
        Some(original.elements.len())
    );
    assert_eq!(harness.parameter_count(&original), original_parameters);

    assert_eq!(
        harness.history(UndoCommand::Redo {}),
        CommandOutcome::succeeded()
    );
    assert_eq!(
        harness.fixture(FIXTURE_ID).map(|f| f.elements.len()),
        Some(updated.elements.len())
    );
    assert_eq!(harness.parameter_count(&updated), updated_parameters);
}

/// Redoing an undone delete still deletes the fixture.
#[tokio::test]
async fn redo_of_fixture_delete_deletes_again() {
    let mut harness = DeskHarness::new();
    let command = harness.submit(FixtureCommand::DeleteFixture(FIXTURE_ID));
    assert_eq!(harness.wait(command), CommandOutcome::succeeded());

    assert_eq!(
        harness.history(UndoCommand::Undo {}),
        CommandOutcome::succeeded()
    );
    assert!(harness.fixture(FIXTURE_ID).is_some());

    assert_eq!(
        harness.history(UndoCommand::Redo {}),
        CommandOutcome::succeeded()
    );
    assert!(harness.fixture(FIXTURE_ID).is_none());
}
