// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Checks that rerunning `ApplyCommands` within an update changes nothing a client or a
//! fixture can observe.
//!
//! An undo or redo reruns `ApplyCommands` while it steps through a group, so every system in
//! that schedule must do nothing extra when it runs again with no new input. This test drives two
//! identical sample desks through the same commands, one of them with an extra rerun forced into
//! every update, and requires the same command results, DMX output and client messages from both.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use async_channel::Receiver;
use bevy::prelude::*;
use bevy::time::TimeUpdateStrategy;
use nightfall_dmx::ChannelDmxValue;
use nightfall_engine::prelude::{
    ApplyCommands, ClientEventSink, CommandApplication, CommandOutcome, CommandRerun,
    DISCRIMINATOR_NON_DROPPABLE, OutboundFrame,
};
use nightfall_fixtures::universe::ConsoleDmxUniverses;

use super::desk_harness::DeskHarness;

/// Simulated time per update, the same on both desks so time-driven output matches.
const FRAME_TIME: Duration = Duration::from_millis(25);

/// Updates each command gets to settle. Both desks run on the same simulated time, so a fade
/// still running when the comparison happens is at the same point on both.
const SETTLE_UPDATES: usize = 12;

/// Whether a desk forces an extra run of `ApplyCommands` into every update.
#[derive(Resource)]
struct ExtraRun {
    /// Whether this desk forces the extra run at all.
    enabled: bool,
    /// Whether the current update still owes its extra run.
    owed: bool,
    /// Extra runs requested so far.
    forced: usize,
}

/// Owes one extra run of `ApplyCommands` at the start of every update, on a desk that forces
/// them.
fn owe_extra_run(mut extra: ResMut<ExtraRun>) {
    extra.owed = extra.enabled;
}

/// Requests the owed extra run of `ApplyCommands`, once per update.
fn request_extra_run(mut extra: ResMut<ExtraRun>, mut rerun: ResMut<CommandRerun>) {
    if std::mem::take(&mut extra.owed) {
        extra.forced += 1;
        rerun.request();
    }
}

/// Returns the kind of a non-droppable client message, or `None` for any other message.
///
/// Droppable and delta messages are live streams sent at wall-clock rates, so their counts
/// differ between two runs anyway. Non-droppable messages report state changes and command
/// results, which a rerun must neither repeat nor lose. The kind is the chain of `type` tags
/// down the payload, such as `commandResult`; IDs and values are left out because each desk
/// generates its own.
fn state_message_kind(bytes: &[u8]) -> Option<String> {
    let (&discriminator, payload) = bytes.split_first()?;
    if discriminator != DISCRIMINATOR_NON_DROPPABLE {
        return None;
    }
    let value: serde_json::Value =
        minicbor_serde::from_slice(payload).unwrap_or(serde_json::Value::Null);
    let mut kind = Vec::new();
    let mut current = &value;
    while let Some(tag) = current.get("type").and_then(serde_json::Value::as_str) {
        kind.push(tag.to_owned());
        let Some(inner) = current
            .as_object()
            .and_then(|fields| fields.iter().find(|(key, _)| *key != "type"))
            .map(|(_, inner)| inner)
        else {
            break;
        };
        current = inner;
    }
    Some(kind.join("/"))
}

/// One sample desk, with the client messages it publishes captured.
struct ObservedDesk {
    /// The desk, driven through the full command path.
    harness: DeskHarness,
    /// Messages published to clients since the desk was built.
    published: Receiver<OutboundFrame>,
}

impl ObservedDesk {
    /// Builds a sample desk on simulated time, optionally forcing an extra run of
    /// `ApplyCommands` into every update.
    fn new(forced_rerun: bool) -> Self {
        let mut harness = DeskHarness::with_macros(&[(
            1,
            "fixture 601 @ 40\nrename clip 1 901\nrename clip 2 902",
            "",
        )]);
        let app = &mut harness.app;
        app.insert_resource(TimeUpdateStrategy::ManualDuration(FRAME_TIME));
        let (sender, published) = async_channel::unbounded();
        app.insert_resource(ClientEventSink::new(sender));
        // Both desks get the same systems, so Bevy picks the same order for systems that have
        // none between them, and only the extra run differs.
        app.insert_resource(ExtraRun {
            enabled: forced_rerun,
            owed: false,
            forced: 0,
        });
        app.add_systems(Update, owe_extra_run.before(CommandApplication));
        app.add_systems(ApplyCommands, request_extra_run);
        // A slow machine must not skip the forced run for lack of budget.
        app.world_mut()
            .resource_mut::<CommandRerun>()
            .set_budget(Duration::from_secs(5));
        Self { harness, published }
    }

    /// Submits command-line text, runs the settle updates, and returns what the desk showed.
    fn run(&mut self, text: &str) -> Observation {
        let command_id = self.harness.eval(text);
        for _ in 0..SETTLE_UPDATES {
            self.harness.step();
        }
        let mut published = BTreeMap::new();
        while let Ok(frame) = self.published.try_recv() {
            if let Some(kind) = state_message_kind(&frame.bytes) {
                *published.entry(kind).or_default() += 1;
            }
        }
        Observation {
            outcome: self.harness.result(command_id),
            published,
        }
    }

    /// Steps until the console DMX output holds still, and returns its non-zero channels keyed
    /// by universe and 1-based channel.
    ///
    /// Cue fades run on wall-clock time, so output is only comparable between two desks once
    /// every fade has finished.
    fn settled_output(&mut self) -> BTreeMap<(u16, usize), ChannelDmxValue> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut output = self.output();
        let mut unchanged = 0;
        while unchanged < 20 {
            assert!(Instant::now() < deadline, "DMX output never settled");
            self.harness.step();
            std::thread::sleep(Duration::from_millis(5));
            let next = self.output();
            unchanged = if next == output { unchanged + 1 } else { 0 };
            output = next;
        }
        output
    }

    /// Returns the console DMX channels that are not zero, keyed by universe and 1-based
    /// channel.
    fn output(&self) -> BTreeMap<(u16, usize), ChannelDmxValue> {
        self.harness
            .app
            .world()
            .resource::<ConsoleDmxUniverses>()
            .iter()
            .flat_map(|(universe, values)| {
                values
                    .iter()
                    .enumerate()
                    .filter(|(_, value)| **value != 0)
                    .map(move |(index, value)| ((universe, index + 1), *value))
            })
            .collect()
    }

    /// Returns how many extra runs of `ApplyCommands` this desk has forced so far.
    fn extra_runs(&self) -> usize {
        self.harness.app.world().resource::<ExtraRun>().forced
    }
}

/// What one command left behind once it settled.
#[derive(Debug, PartialEq)]
struct Observation {
    /// The command's result, if it finished.
    outcome: Option<CommandOutcome>,
    /// State messages published to clients while the command settled, counted by kind.
    published: BTreeMap<String, usize>,
}

/// Commands from many domains, including undo and redo of a multi-entry macro group, which
/// rerun the schedule for real on both desks.
const SCRIPT: &[&str] = &[
    "fixture 601 @ 100",
    "fix 601 white @ 100 int @ 100",
    "store cue 1.50",
    "clear",
    "clip 1 start",
    "clip 1 go",
    "clip 3 start",
    "park fixture 601 white @ 50",
    "tempo 128",
    "rename clip 3 903",
    "undo",
    "redo",
    "unpark fixture 601",
    "macro 1 start",
    "undo",
    "redo",
    "clip 901 stop",
    "clip 903 stop",
    "undo",
    "fixture 601 @ 70",
];

/// Verifies an extra run of `ApplyCommands` in every update leaves command results, client
/// state messages and the final DMX output unchanged, so no system in that schedule does extra
/// work on a rerun.
#[tokio::test]
async fn extra_command_runs_change_nothing_observable() {
    let mut normal = ObservedDesk::new(false);
    let mut forced = ObservedDesk::new(true);

    for text in SCRIPT {
        let expected = normal.run(text);
        let actual = forced.run(text);
        assert!(
            matches!(expected.outcome, Some(CommandOutcome::Succeeded { .. })),
            "`{text}` should succeed on the sample show, got {:?}",
            expected.outcome
        );
        assert_eq!(
            actual.outcome, expected.outcome,
            "`{text}` returned a different result with an extra run of ApplyCommands per update"
        );
        assert_eq!(
            actual.published, expected.published,
            "`{text}` published different state messages with an extra run of ApplyCommands \
             per update"
        );
    }

    let expected = normal.settled_output();
    assert!(!expected.is_empty(), "the script should leave some output");
    assert_eq!(
        forced.settled_output(),
        expected,
        "the script left different DMX output with an extra run of ApplyCommands per update"
    );
    assert!(
        forced.extra_runs() >= SCRIPT.len() * SETTLE_UPDATES,
        "the forced desk should have rerun ApplyCommands in every update"
    );
    assert_eq!(normal.extra_runs(), 0);
}
