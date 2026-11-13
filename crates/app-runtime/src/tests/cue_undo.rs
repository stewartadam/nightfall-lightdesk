// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! End-to-end undo and redo of cue edits and cue playback in a sample-data world.

use nightfall_cues::prelude::{Cue, MaterializedSequence, Sequence};
use nightfall_engine::prelude::{CommandOutcome, DataProvider};
use nightfall_undo::prelude::UndoCommand;
use uuid::Uuid;

use super::desk_harness::DeskHarness;

impl DeskHarness {
    /// Runs one command-line statement and asserts it succeeded.
    fn run(&mut self, text: &str) {
        let command = self.eval(text);
        assert_eq!(
            self.wait(command),
            CommandOutcome::succeeded(),
            "`{text}` should succeed"
        );
    }

    /// Lists the cue IDs of a sequence's steps in order, skipping steps without a definition.
    fn cue_ids(&self, sequence_id: u32) -> Vec<u32> {
        let world = self.app.world();
        let cues = world.resource::<DataProvider<Cue>>();
        world
            .resource::<DataProvider<Sequence>>()
            .from_id(sequence_id)
            .expect("sequence should exist")
            .steps
            .iter()
            .filter_map(|step| cues.get(Uuid::from(*step)).ok())
            .map(|cue| cue.identifiers.id)
            .collect()
    }
}

/// Undoing `delete cue` puts the cue back at its place in its sequence, and redoing it deletes
/// that same cue again, never a cue with the same number in another sequence.
#[tokio::test]
async fn delete_cue_undo_and_redo_touch_only_the_deleted_cue() {
    let mut harness = DeskHarness::new();
    let sequence_1 = harness.cue_ids(1);
    let sequence_2 = harness.cue_ids(2);
    assert!(sequence_1.contains(&2) && sequence_2.contains(&2));

    harness.run("delete cue 1.2");
    let without_cue_2 = sequence_1
        .iter()
        .copied()
        .filter(|id| *id != 2)
        .collect::<Vec<_>>();
    assert_eq!(harness.cue_ids(1), without_cue_2);

    assert_eq!(
        harness.history(UndoCommand::Undo {}),
        CommandOutcome::succeeded()
    );
    assert_eq!(harness.cue_ids(1), sequence_1, "undo restores the step");

    assert_eq!(
        harness.history(UndoCommand::Redo {}),
        CommandOutcome::succeeded()
    );
    assert_eq!(harness.cue_ids(1), without_cue_2);
    assert_eq!(harness.cue_ids(2), sequence_2, "sequence 2 is untouched");
}

/// Returns the 1-based cue position of the running playback of the sequence with this ID.
fn sequence_position(harness: &mut DeskHarness, sequence_id: u32) -> u32 {
    harness
        .app
        .world_mut()
        .query::<&MaterializedSequence>()
        .iter(harness.app.world())
        .find(|sequence| sequence.sequence.identifiers.id == sequence_id)
        .expect("the sequence should be playing")
        .position()
}

/// Undoing a goto after an edit to any sequence returns the playback to its earlier cue even
/// though the edit rebuilt the playback's cues only up to the current one.
#[tokio::test]
async fn goto_undo_after_a_sequence_edit_restores_the_earlier_cue() {
    let mut harness = DeskHarness::new();
    harness.run("clip 1 goto 4");
    harness.run("clip 1 goto 1");
    assert_eq!(sequence_position(&mut harness, 1), 1);

    harness.run("delete cue 2.2");
    assert_eq!(
        harness.history(UndoCommand::Undo {}),
        CommandOutcome::succeeded(),
        "undo the delete"
    );
    assert_eq!(
        harness.history(UndoCommand::Undo {}),
        CommandOutcome::succeeded(),
        "undo the goto"
    );

    assert_eq!(sequence_position(&mut harness, 1), 4);
}
