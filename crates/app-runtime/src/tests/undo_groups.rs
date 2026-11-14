// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! End-to-end undo and redo of one undo step that changes the same group several times.

use nightfall::prelude::Group;
use nightfall_engine::prelude::{CommandOutcome, DataProvider};
use nightfall_undo::prelude::{UndoCommand, UndoManager};

use super::desk_harness::DeskHarness;

impl DeskHarness {
    /// Returns the IDs of every stored group, sorted.
    fn group_ids(&self) -> Vec<u32> {
        let mut ids = self
            .app
            .world()
            .resource::<DataProvider<Group>>()
            .iter()
            .map(|entry| entry.value().identifiers.id)
            .collect::<Vec<_>>();
        ids.sort_unstable();
        ids
    }

    /// Submits an undo or redo, waits for it, and returns how it finished.
    fn step_history(&mut self, command: UndoCommand) -> CommandOutcome {
        let command_id = self.submit(command);
        self.wait(command_id)
    }

    /// Runs a macro to completion as one undo step and asserts it succeeded.
    fn run_macro(&mut self, id: u32) {
        let started = self.eval(&format!("macro {id} start"));
        assert_eq!(self.wait(started), CommandOutcome::succeeded());
        assert_eq!(
            self.app.world().resource::<UndoManager>().undo_depth(),
            1,
            "the macro run should be one undo step"
        );
    }
}

/// A macro that creates a group and deletes it again undoes and redoes, and leaves older
/// history reachable afterward.
#[tokio::test]
async fn create_then_delete_in_one_step_undoes_and_redoes() {
    let mut harness =
        DeskHarness::with_macros(&[(1, "fix 601\nstore group 905\nrm group 905", "")]);
    let before = harness.group_ids();
    assert!(!before.contains(&905));

    harness.run_macro(1);
    assert_eq!(harness.group_ids(), before);

    assert_eq!(
        harness.step_history(UndoCommand::Undo {}),
        CommandOutcome::succeeded()
    );
    assert_eq!(harness.group_ids(), before);
    assert_eq!(
        harness.step_history(UndoCommand::Redo {}),
        CommandOutcome::succeeded()
    );
    assert_eq!(harness.group_ids(), before);
    assert_eq!(
        harness.step_history(UndoCommand::Undo {}),
        CommandOutcome::succeeded()
    );
    let manager = harness.app.world().resource::<UndoManager>();
    assert_eq!((manager.undo_depth(), manager.redo_depth()), (0, 1));
}

/// A macro that creates a group and renames it twice undoes back to no group, and redo replays
/// the renames in the order they first ran.
#[tokio::test]
async fn create_then_renames_in_one_step_redo_in_order() {
    let mut harness = DeskHarness::with_macros(&[(
        1,
        "fix 601\nstore group 905\nmv group 905 906\nmv group 906 907",
        "",
    )]);
    let before = harness.group_ids();
    assert!(!before.iter().any(|id| (905..=907).contains(id)));

    harness.run_macro(1);
    assert!(harness.group_ids().contains(&907));

    assert_eq!(
        harness.step_history(UndoCommand::Undo {}),
        CommandOutcome::succeeded()
    );
    assert_eq!(harness.group_ids(), before);

    assert_eq!(
        harness.step_history(UndoCommand::Redo {}),
        CommandOutcome::succeeded()
    );
    let after_redo = harness.group_ids();
    assert!(after_redo.contains(&907));
    assert!(!after_redo.contains(&905) && !after_redo.contains(&906));
}
