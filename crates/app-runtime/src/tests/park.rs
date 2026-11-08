// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! End-to-end park and unpark through the command line, undo and showfiles in a sample world.

use std::time::{Duration, Instant};

use bevy::prelude::{App, Messages};
use moonshine_kind::Instance;
use nightfall::prelude::FixtureRef;
use nightfall_dmx::prelude::Attribute;
use nightfall_engine::prelude::{
    CommandId, CommandOrigin, CommandOutcome, CommandResult, CommandTracker, EngineCommand,
    IngressCommand, PayloadEnvelope, PendingCommandBuffer, ReplyTarget, UndoId,
};
use nightfall_fixtures::prelude::{FixtureDataProviderExt, Parameter};
use nightfall_park::prelude::{ParkCommand, ParkedParameters};
use nightfall_undo::prelude::UndoCommand;

use super::{WorldBootstrap, WorldFactory, sample_app, test_log_config};

/// Sample world plus every command result seen so far, watching fixture 601's first white
/// channel, which the sample show patches with a virtual dimmer.
struct ParkHarness {
    app: App,
    results: Vec<CommandResult>,
    white: Instance<Parameter>,
}

impl ParkHarness {
    /// Builds a sample world and finds fixture 601's first white parameter.
    fn new() -> Self {
        Self::with_app(sample_app())
    }

    /// Wraps an existing world and finds fixture 601's first white parameter in it.
    fn with_app(app: App) -> Self {
        let white = {
            let fixtures = app.world().resource::<FixtureDataProviderExt>();
            let fixture_uid = fixtures
                .inner
                .iter()
                .find(|fixture| fixture.identifiers.id == 601)
                .expect("sample data should include fixture 601")
                .identifiers
                .uid;
            fixtures
                .parameter_index()
                .parameter(
                    &FixtureRef {
                        fixture_uid,
                        index: Some(4),
                    },
                    &Attribute::White,
                )
                .expect("fixture 601 element 4 should expose white")
        };
        Self {
            app,
            results: Vec::new(),
            white,
        }
    }

    /// Submits a command the way a client does, with undo capture and a broadcast result.
    fn submit<C: IngressCommand + Clone + 'static>(&mut self, command: C) -> CommandId {
        let command_id = CommandId::new();
        let undo_id = UndoId::from(command_id);
        self.app
            .world_mut()
            .resource_mut::<CommandTracker>()
            .register_context(
                command_id,
                undo_id,
                CommandOrigin::Cli,
                ReplyTarget::ClientBroadcast,
            )
            .expect("test command should register");
        self.app
            .world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .push(PayloadEnvelope::with_context(
                command_id,
                undo_id,
                Box::new(command),
            ));
        command_id
    }

    /// Runs command-line text, waits for it to finish and renders a few frames of output.
    fn eval(&mut self, text: &str) -> CommandOutcome {
        let command_id = self.submit(EngineCommand::Eval(text.to_string()));
        self.finish(command_id)
    }

    /// Waits for a command to finish, then renders a few frames so its output settles.
    fn finish(&mut self, command_id: CommandId) -> CommandOutcome {
        let outcome = self.wait(command_id);
        for _ in 0..5 {
            self.step();
        }
        outcome
    }

    /// Runs one frame and records the command results it produced.
    fn step(&mut self) {
        self.app.update();
        self.results.extend(
            self.app
                .world_mut()
                .resource_mut::<Messages<CommandResult>>()
                .drain(),
        );
    }

    /// Steps frames until a command finishes, giving up after two seconds.
    fn wait(&mut self, command_id: CommandId) -> CommandOutcome {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            self.step();
            if let Some(result) = self
                .results
                .iter()
                .find(|result| result.command_id == command_id)
            {
                return result.outcome.clone();
            }
            assert!(
                Instant::now() < deadline,
                "command {command_id} did not finish"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Returns the value fixture 601's first white channel outputs now.
    fn white(&self) -> f32 {
        self.app
            .world()
            .get::<Parameter>(self.white.entity())
            .expect("white parameter entity should exist")
            .values
            .current_value
    }

    /// Returns how many parameters are parked.
    fn parked_count(&self) -> usize {
        self.app.world().resource::<ParkedParameters>().len()
    }
}

/// A parked channel holds its output through programmer changes, virtual dimmer changes and
/// `clear`, and follows playback again once unparked; undo reverses both steps.
#[tokio::test]
async fn parked_parameters_hold_output_until_unparked_and_undo() {
    let mut harness = ParkHarness::new();
    assert_eq!(
        harness.eval("fix 601 white @ 100 int @ 100"),
        CommandOutcome::succeeded()
    );
    assert_eq!(harness.white(), 255.0);

    let park = harness.submit(EngineCommand::Eval("park fixture 601".to_string()));
    assert_eq!(harness.finish(park), CommandOutcome::succeeded());
    assert!(
        harness.parked_count() > 0,
        "every parameter of 601 should park"
    );

    assert_eq!(
        harness.eval("fix 601 white @ 0 int @ 0"),
        CommandOutcome::succeeded()
    );
    assert_eq!(
        harness.white(),
        255.0,
        "a parked channel ignores both its own value and the virtual dimmer"
    );

    assert_eq!(harness.eval("clear"), CommandOutcome::succeeded());
    assert_eq!(harness.white(), 255.0, "clear does not unpark");

    assert_eq!(
        harness.eval("unpark fixture 601 white"),
        CommandOutcome::succeeded()
    );
    assert_eq!(
        harness.white(),
        0.0,
        "an unparked channel follows playback, which no longer drives it"
    );
    assert!(harness.parked_count() > 0, "only white should unpark");

    let undo = harness.submit(UndoCommand::Undo {});
    assert_eq!(harness.finish(undo), CommandOutcome::succeeded());
    assert_eq!(
        harness.white(),
        255.0,
        "undoing the unpark parks white again"
    );

    let unpark_all = harness.submit(ParkCommand::UnparkAll);
    assert_eq!(harness.finish(unpark_all), CommandOutcome::succeeded());
    assert_eq!(harness.parked_count(), 0);
    assert_eq!(harness.white(), 0.0);
}

/// `park … @ value` holds parameters at that value, read as a percentage like a programmer
/// value, rather than at their current output.
#[tokio::test]
async fn park_at_a_value_holds_that_value() {
    let mut harness = ParkHarness::new();
    assert_eq!(
        harness.eval("fix 601 white @ 100 int @ 100"),
        CommandOutcome::succeeded()
    );
    assert_eq!(
        harness.eval("park fixture 601.4 white @ 50"),
        CommandOutcome::succeeded()
    );
    assert_eq!(harness.parked_count(), 1);
    assert_eq!(
        harness.white(),
        127.5,
        "white holds at 50%, not its 100% output"
    );

    assert_eq!(
        harness.eval("fix 601 white @ 0"),
        CommandOutcome::succeeded()
    );
    assert_eq!(harness.white(), 127.5);

    let outcome = harness.eval("unpark fixture 601 @ 50");
    assert!(
        matches!(outcome, CommandOutcome::Failed(_)),
        "unpark rejects a value, got {outcome:?}"
    );
}

/// Parking with an empty selection fails with a clear message instead of silently doing nothing.
#[tokio::test]
async fn park_without_a_selection_fails() {
    let mut harness = ParkHarness::new();
    assert_eq!(harness.eval("clear"), CommandOutcome::succeeded());
    let outcome = harness.eval("park");
    assert!(
        matches!(outcome, CommandOutcome::Failed(_)),
        "park with nothing selected should fail, got {outcome:?}"
    );
    assert_eq!(harness.parked_count(), 0);
}

/// Parked parameters are saved with the show and hold their values again once it loads.
#[tokio::test]
async fn parked_parameters_round_trip_through_showfiles() {
    let mut harness = ParkHarness::new();
    assert_eq!(
        harness.eval("fix 601 white @ 100 int @ 100"),
        CommandOutcome::succeeded()
    );
    assert_eq!(
        harness.eval("park fixture 601 white"),
        CommandOutcome::succeeded()
    );
    let parked = harness.parked_count();
    assert!(parked > 0, "every white element of 601 should park");

    let snapshot = nightfall_showfile::snapshot_from_world(harness.app.world_mut())
        .expect("snapshot should save");
    assert_eq!(snapshot.parked.len(), parked);
    let encoded = serde_json::to_string(&snapshot).expect("snapshot should serialize");
    let decoded: nightfall_showfile::ShowfileSnapshot =
        serde_json::from_str(&encoded).expect("snapshot should deserialize");

    let mut app = WorldFactory::new(test_log_config(), false, false, false)
        .build(WorldBootstrap::Empty {
            showfile_name: None,
        })
        .expect("empty world");
    nightfall_showfile::apply_showfile_snapshot_to_world(app.world_mut(), decoded)
        .expect("snapshot should load");
    for _ in 0..5 {
        app.update();
    }
    let loaded = ParkHarness::with_app(app);
    assert_eq!(
        loaded.app.world().resource::<ParkedParameters>(),
        harness.app.world().resource::<ParkedParameters>(),
    );
    assert_eq!(
        loaded.white(),
        255.0,
        "the loaded show holds the parked value"
    );
}
