// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::{CommandId, UndoId};
use web_time::Instant;

use crate::traits::{UndoCoalesceKey, Undoable};

/// Configuration for undo manager behavior.
#[derive(Clone, Debug)]
pub struct UndoConfig {
    /// Maximum number of undo groups to retain. Default: 100.
    pub max_history: usize,
    /// Longest pause between repeats of one edit that still joins them into one undo step,
    /// see [`Undoable::coalesce_key`]. Default: 30 seconds.
    pub coalesce_window: Duration,
}

impl Default for UndoConfig {
    fn default() -> Self {
        Self {
            max_history: 100,
            coalesce_window: Duration::from_secs(30),
        }
    }
}

/// A single entry in an undo group, representing one command.
#[derive(Clone)]
pub struct UndoEntry {
    /// The inverse command that undoes the original operation.
    pub command: Box<dyn Undoable>,
    /// Human-readable description for UI display.
    pub description: String,
    /// User command that caused the operation, when one exists.
    pub command_id: Option<CommandId>,
    /// Joins back-to-back repeats of the same edit into one undo step, see
    /// [`Undoable::coalesce_key`].
    pub coalesce_key: Option<UndoCoalesceKey>,
}

/// A group of commands that undo/redo together as a single unit.
#[derive(Clone)]
pub struct UndoGroup {
    /// Commands in this group, executed in order for undo.
    pub entries: Vec<UndoEntry>,
    /// Human-readable description for UI display.
    pub description: String,
    /// When the group was finalized.
    pub timestamp: Instant,
    /// Whether this group was preserved from the redo stack by GURQ branching.
    pub is_gurq_preserved: bool,
    /// Identity shared by operations that undo together.
    pub undo_id: UndoId,
}

/// A group waiting on the redo stack, kept with the undo group whose replay produced it.
pub struct RedoGroup {
    /// Commands that redo the undone work.
    pub group: UndoGroup,
    /// The undo group that was replayed, returned to history when GURQ collapses this redo.
    pub undone: UndoGroup,
}

/// Operations accumulated until their owning command reaches a terminal outcome.
struct PendingUndoGroup {
    entries: Vec<UndoEntry>,
    description: String,
    lifecycle_managed: bool,
    insertion_order: u64,
}

/// Resource managing undo/redo history using the GURQ algorithm.
///
/// GURQ (Global Undo Redo Queue) maintains a linear history where making
/// changes after an undo operation preserves all previous states by
/// collapsing the redo stack into the undo stack.
#[derive(Resource)]
pub struct UndoManager {
    undo_stack: VecDeque<UndoGroup>,
    redo_stack: Vec<RedoGroup>,
    pending_groups: HashMap<UndoId, PendingUndoGroup>,
    next_insertion_order: u64,
    config: UndoConfig,
}

impl Default for UndoManager {
    fn default() -> Self {
        Self::new()
    }
}

impl UndoManager {
    /// Create a new UndoManager with default configuration.
    pub fn new() -> Self {
        Self::with_config(UndoConfig::default())
    }

    /// Create a new UndoManager with custom configuration.
    pub fn with_config(config: UndoConfig) -> Self {
        Self {
            undo_stack: VecDeque::new(),
            redo_stack: Vec::new(),
            pending_groups: HashMap::new(),
            next_insertion_order: 0,
            config,
        }
    }

    /// Adds an inverse operation to an undo group that may span multiple frames.
    pub fn push(&mut self, entry: UndoEntry, undo_id: UndoId, lifecycle_managed: bool) {
        let insertion_order = self.next_insertion_order;
        let group = self
            .pending_groups
            .entry(undo_id)
            .or_insert_with(|| PendingUndoGroup {
                description: entry.description.clone(),
                entries: Vec::new(),
                lifecycle_managed,
                insertion_order,
            });
        group.lifecycle_managed |= lifecycle_managed;
        group.entries.push(entry);
        self.next_insertion_order = self.next_insertion_order.saturating_add(1);
    }

    /// Finishes one lifecycle-managed undo group, committing only successful work.
    pub fn finish_group(&mut self, undo_id: UndoId, commit: bool) {
        let Some(group) = self.pending_groups.remove(&undo_id) else {
            return;
        };
        if commit {
            self.commit_group(undo_id, group);
        }
    }

    /// Commits frame-scoped groups created by detached actions without a command lifecycle.
    pub fn finalize_detached_groups(&mut self) {
        let mut groups = self
            .pending_groups
            .iter()
            .filter_map(|(undo_id, group)| {
                (!group.lifecycle_managed).then_some((*undo_id, group.insertion_order))
            })
            .collect::<Vec<_>>();
        groups.sort_by_key(|(_, insertion_order)| *insertion_order);
        for (undo_id, _) in groups {
            if let Some(group) = self.pending_groups.remove(&undo_id) {
                self.commit_group(undo_id, group);
            }
        }
    }

    /// Commits a completed undo group to history using GURQ semantics.
    fn commit_group(&mut self, undo_id: UndoId, group: PendingUndoGroup) {
        if group.entries.is_empty() {
            return;
        }

        // GURQ: If redo stack is not empty, collapse it into undo stack.
        // This preserves all previous states as reachable history.
        let collapsed_redo = !self.redo_stack.is_empty();
        if collapsed_redo {
            self.collapse_redo_stack_for_gurq();
        }

        if let Some(last_group) = self.undo_stack.back_mut() {
            if last_group.undo_id == undo_id {
                last_group.entries.extend(group.entries);
                last_group.timestamp = Instant::now();
                return;
            }
            // A repeat of the newest edit keeps that step's earlier inverse, which already
            // restores the state from before the first repeat. An edit made after an undo never
            // joins, so the undone states stay reachable on their own.
            if !collapsed_redo
                && last_group.timestamp.elapsed() <= self.config.coalesce_window
                && standalone_coalesce_key(&group.entries, undo_id).is_some_and(|key| {
                    standalone_coalesce_key(&last_group.entries, last_group.undo_id) == Some(key)
                })
            {
                last_group.timestamp = Instant::now();
                return;
            }
        }

        // Enforce history limit
        while self.undo_stack.len() >= self.config.max_history {
            self.undo_stack.pop_front();
        }

        self.undo_stack.push_back(UndoGroup {
            entries: group.entries,
            description: group.description,
            timestamp: Instant::now(),
            is_gurq_preserved: false,
            undo_id,
        });
    }

    /// Returns true when at least one undo group is awaiting lifecycle completion.
    pub fn has_pending_groups(&self) -> bool {
        !self.pending_groups.is_empty()
    }

    /// Returns true when detached action groups are awaiting frame-end finalization.
    pub fn has_detached_groups(&self) -> bool {
        self.pending_groups
            .values()
            .any(|group| !group.lifecycle_managed)
    }

    /// GURQ: Collapse redo stack into undo history before new changes.
    ///
    /// Every state the desk passed through stays reachable by undo. The undone groups go back
    /// in the order they were first made, then the redo groups in the order they were undone,
    /// so the most recently undone work is redone first. After `G1 G2 G3`, two undos and a new
    /// edit `N`, the history reads `G1 G2 G3 R3 R2 N`: undo steps back through `N`, re-applies
    /// `G2` then `G3`, and continues back through `G3`, `G2` and `G1`.
    fn collapse_redo_stack_for_gurq(&mut self) {
        let (redo_groups, undone_groups): (Vec<_>, Vec<_>) = self
            .redo_stack
            .drain(..)
            .map(|redo| (redo.group, redo.undone))
            .unzip();
        self.undo_stack.extend(undone_groups.into_iter().rev());
        self.undo_stack
            .extend(redo_groups.into_iter().map(|mut group| {
                group.is_gurq_preserved = true;
                group
            }));
        while self.undo_stack.len() > self.config.max_history {
            self.undo_stack.pop_front();
        }
    }

    /// Returns true if there are operations available to undo.
    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    /// Returns true if there are operations available to redo.
    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    /// Peek at the next group to undo without removing it.
    pub fn peek_undo(&self) -> Option<&UndoGroup> {
        self.undo_stack.back()
    }

    /// Peek at the next group to redo without removing it.
    pub fn peek_redo(&self) -> Option<&UndoGroup> {
        self.redo_stack.last().map(|redo| &redo.group)
    }

    /// Iterate over undo groups from oldest to newest.
    pub fn undo_stack(&self) -> impl DoubleEndedIterator<Item = &UndoGroup> {
        self.undo_stack.iter()
    }

    /// Iterate over redo groups from oldest to newest.
    pub fn redo_stack(&self) -> impl DoubleEndedIterator<Item = &UndoGroup> {
        self.redo_stack.iter().map(|redo| &redo.group)
    }

    /// Pop and return the next group to undo.
    pub fn pop_undo(&mut self) -> Option<UndoGroup> {
        self.undo_stack.pop_back()
    }

    /// Pushes a group directly onto the undo stack, bypassing pending-group accumulation.
    ///
    /// Used internally by redo operations to restore undo state.
    pub fn push_undo_group_direct(&mut self, group: UndoGroup) {
        // Enforce history limit
        while self.undo_stack.len() >= self.config.max_history {
            self.undo_stack.pop_front();
        }
        self.undo_stack.push_back(group);
    }

    /// Push a group onto the redo stack.
    pub fn push_redo(&mut self, redo: RedoGroup) {
        self.redo_stack.push(redo);
    }

    /// Pop and return the next group to redo.
    pub fn pop_redo(&mut self) -> Option<RedoGroup> {
        self.redo_stack.pop()
    }

    /// Clear all history.
    pub fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.pending_groups.clear();
    }

    /// Get the current undo stack depth.
    pub fn undo_depth(&self) -> usize {
        self.undo_stack.len()
    }

    /// Get the current redo stack depth.
    pub fn redo_depth(&self) -> usize {
        self.redo_stack.len()
    }
}

/// Returns the coalesce key a step may join under: the key every entry carries, when every
/// entry also came from a standalone command whose undo ID is its own command ID.
///
/// Steps shared by several commands (a macro run, a client batch) never join, since later
/// commands of the same undo ID would extend whichever step absorbed the first one.
fn standalone_coalesce_key(entries: &[UndoEntry], undo_id: UndoId) -> Option<&UndoCoalesceKey> {
    let (first, _) = entries.split_first()?;
    let key = first.coalesce_key.as_ref()?;
    entries
        .iter()
        .all(|entry| {
            entry.coalesce_key.as_ref() == Some(key)
                && entry.command_id.map(UndoId::from) == Some(undo_id)
        })
        .then_some(key)
}

#[cfg(test)]
mod tests {
    use nightfall_engine::prelude::EnginePayload;

    use super::*;
    use crate::context::UndoContext;
    use crate::traits::Undoable;

    /// Test command used to verify undo-manager behavior without app dependencies.
    #[derive(Debug, Clone, EnginePayload)]
    struct TestUndoCommand;

    impl Undoable for TestUndoCommand {
        fn inverse(&self, _ctx: &UndoContext) -> Option<Box<dyn Undoable>> {
            None
        }

        fn description(&self) -> String {
            "Test Undo Command".to_string()
        }
    }

    fn test_entry(description: &str) -> UndoEntry {
        UndoEntry {
            command: Box::new(TestUndoCommand),
            description: description.to_string(),
            command_id: Some(CommandId::new()),
            coalesce_key: None,
        }
    }

    /// Builds an entry for a repeatable edit carrying `key`.
    fn coalescing_entry(description: &str, key: &UndoCoalesceKey) -> UndoEntry {
        UndoEntry {
            coalesce_key: Some(key.clone()),
            ..test_entry(description)
        }
    }

    /// Commits a repeatable edit as a standalone command, whose undo ID is its command ID.
    fn commit_coalescing_edit(manager: &mut UndoManager, description: &str, key: &UndoCoalesceKey) {
        let entry = coalescing_entry(description, key);
        let undo_id = UndoId::from(entry.command_id.expect("test entries carry a command ID"));
        manager.push(entry, undo_id, true);
        manager.finish_group(undo_id, true);
    }

    #[test]
    fn finishing_merges_consecutive_groups_with_same_undo_id() {
        let mut manager = UndoManager::new();
        let undo_id = UndoId::new();

        manager.push(test_entry("first"), undo_id, true);
        manager.finish_group(undo_id, true);
        manager.push(test_entry("second"), undo_id, true);
        manager.finish_group(undo_id, true);

        assert_eq!(manager.undo_depth(), 1);
        let group = manager.peek_undo().expect("expected one undo group");
        assert_eq!(group.entries.len(), 2);
        assert_eq!(group.entries[0].description, "first");
        assert_eq!(group.entries[1].description, "second");
    }

    #[test]
    fn finishing_keeps_different_undo_ids_as_separate_groups() {
        let mut manager = UndoManager::new();
        let first_undo_id = UndoId::new();
        let second_undo_id = UndoId::new();

        manager.push(test_entry("first"), first_undo_id, true);
        manager.finish_group(first_undo_id, true);
        manager.push(test_entry("second"), second_undo_id, true);
        manager.finish_group(second_undo_id, true);

        assert_eq!(manager.undo_depth(), 2);
        let latest = manager.peek_undo().expect("expected latest undo group");
        assert_eq!(latest.entries.len(), 1);
        assert_eq!(latest.entries[0].description, "second");
    }

    /// Verifies that interleaved operations remain grouped across frame-like push boundaries.
    #[test]
    fn interleaved_operations_remain_open_until_their_undo_group_finishes() {
        let mut manager = UndoManager::new();
        let workflow_undo_id = UndoId::new();
        let other_undo_id = UndoId::new();

        manager.push(test_entry("workflow first"), workflow_undo_id, true);
        manager.push(test_entry("other"), other_undo_id, true);
        manager.push(test_entry("workflow second"), workflow_undo_id, true);
        manager.finish_group(workflow_undo_id, true);

        assert_eq!(manager.undo_depth(), 1);
        let group = manager
            .peek_undo()
            .expect("expected completed workflow group");
        assert_eq!(group.undo_id, workflow_undo_id);
        assert_eq!(group.entries.len(), 2);
        assert!(manager.has_pending_groups());

        manager.finish_group(other_undo_id, true);
        assert_eq!(manager.undo_depth(), 2);
        assert!(!manager.has_pending_groups());
    }

    /// Commits a one-entry group under a fresh undo ID, standing in for a finished edit.
    fn commit_edit(manager: &mut UndoManager, description: &str) {
        let undo_id = UndoId::new();
        manager.push(test_entry(description), undo_id, true);
        manager.finish_group(undo_id, true);
    }

    /// Moves the newest undo group to the redo stack the way the undo command does, with a
    /// stand-in redo group described as `redo <description>`.
    fn undo_once(manager: &mut UndoManager) {
        let undone = manager.pop_undo().expect("expected a group to undo");
        manager.push_redo(RedoGroup {
            group: UndoGroup {
                entries: vec![test_entry(&format!("redo {}", undone.description))],
                description: format!("redo {}", undone.description),
                timestamp: Instant::now(),
                is_gurq_preserved: undone.is_gurq_preserved,
                undo_id: UndoId::new(),
            },
            undone,
        });
    }

    /// Lists the undo stack's descriptions from oldest to newest.
    fn undo_descriptions(manager: &UndoManager) -> Vec<String> {
        manager
            .undo_stack()
            .map(|group| group.description.clone())
            .collect()
    }

    /// Verifies an edit after two undos keeps every state reachable in the order the desk
    /// passed through them: back through the new edit, forward through the undone edits
    /// oldest first, then back through the original history.
    #[test]
    fn new_edit_after_undos_keeps_history_in_order() {
        let mut manager = UndoManager::new();
        for description in ["g1", "g2", "g3"] {
            commit_edit(&mut manager, description);
        }
        undo_once(&mut manager);
        undo_once(&mut manager);

        commit_edit(&mut manager, "n");

        assert_eq!(
            undo_descriptions(&manager),
            ["g1", "g2", "g3", "redo g3", "redo g2", "n"]
        );
        assert_eq!(manager.redo_depth(), 0);
        let preserved = manager
            .undo_stack()
            .map(|group| group.is_gurq_preserved)
            .collect::<Vec<_>>();
        assert_eq!(preserved, [false, false, false, true, true, false]);
    }

    /// Verifies the collapse that restores undone history still respects the history limit.
    #[test]
    fn collapse_keeps_history_within_its_limit() {
        let mut manager = UndoManager::with_config(UndoConfig {
            max_history: 4,
            ..UndoConfig::default()
        });
        for description in ["g1", "g2", "g3", "g4"] {
            commit_edit(&mut manager, description);
        }
        undo_once(&mut manager);
        undo_once(&mut manager);

        commit_edit(&mut manager, "n");

        assert_eq!(
            undo_descriptions(&manager),
            ["g4", "redo g4", "redo g3", "n"]
        );
    }

    /// Verifies that a failed command discards inverses captured before its mutation attempt.
    #[test]
    fn failed_command_discards_its_pending_undo_group() {
        let mut manager = UndoManager::new();
        let undo_id = UndoId::new();

        manager.push(test_entry("failed operation"), undo_id, true);
        manager.finish_group(undo_id, false);

        assert_eq!(manager.undo_depth(), 0);
        assert!(!manager.has_pending_groups());
    }

    /// Verifies back-to-back repeats of one edit share a single undo step that keeps the
    /// first repeat's inverse, so undo returns to the state before the whole run.
    #[test]
    fn repeats_of_one_edit_join_the_newest_step() {
        let mut manager = UndoManager::new();
        let key = UndoCoalesceKey::new("test.shift", 1);
        commit_edit(&mut manager, "earlier edit");

        for description in ["shift 1", "shift 2", "shift 3"] {
            commit_coalescing_edit(&mut manager, description, &key);
        }

        assert_eq!(manager.undo_depth(), 2);
        let group = manager.peek_undo().expect("expected the joined step");
        assert_eq!(group.entries.len(), 1);
        assert_eq!(group.entries[0].description, "shift 1");
    }

    /// Verifies repeats join only when nothing else came between them and they edit the same
    /// target.
    #[test]
    fn interrupted_or_different_edits_stay_separate() {
        let mut manager = UndoManager::new();
        let first = UndoCoalesceKey::new("test.shift", 1);
        let second = UndoCoalesceKey::new("test.shift", 2);

        commit_coalescing_edit(&mut manager, "shift 1", &first);
        commit_edit(&mut manager, "other edit");
        commit_coalescing_edit(&mut manager, "shift 1 again", &first);
        commit_coalescing_edit(&mut manager, "shift 2", &second);

        assert_eq!(
            undo_descriptions(&manager),
            ["shift 1", "other edit", "shift 1 again", "shift 2"]
        );
    }

    /// Verifies a repeat made after an undo starts its own step, so the undone states the GURQ
    /// collapse restores stay reachable.
    #[test]
    fn repeat_after_undo_does_not_join() {
        let mut manager = UndoManager::new();
        let key = UndoCoalesceKey::new("test.shift", 1);
        commit_coalescing_edit(&mut manager, "shift 1", &key);
        commit_coalescing_edit(&mut manager, "shift 2", &key);
        undo_once(&mut manager);

        commit_coalescing_edit(&mut manager, "shift 3", &key);

        assert_eq!(
            undo_descriptions(&manager),
            ["shift 1", "redo shift 1", "shift 3"]
        );
    }

    /// Verifies a step joins only when every entry carries the same key, so a multi-command
    /// step that merely contains a repeatable edit is never extended.
    #[test]
    fn mixed_step_does_not_join() {
        let mut manager = UndoManager::new();
        let key = UndoCoalesceKey::new("test.shift", 1);
        let mixed_undo_id = UndoId::new();
        manager.push(coalescing_entry("shift", &key), mixed_undo_id, true);
        manager.push(test_entry("other"), mixed_undo_id, true);
        manager.finish_group(mixed_undo_id, true);

        commit_coalescing_edit(&mut manager, "shift again", &key);

        assert_eq!(manager.undo_depth(), 2);
    }

    /// Verifies repeats inside a multi-command run (a macro or client batch sharing one undo
    /// ID) never join an earlier step, so the run still undoes as exactly its own commands.
    #[test]
    fn shared_undo_id_run_does_not_join() {
        let mut manager = UndoManager::new();
        let key = UndoCoalesceKey::new("test.shift", 1);
        commit_coalescing_edit(&mut manager, "operator shift", &key);
        let macro_undo_id = UndoId::new();

        manager.push(coalescing_entry("macro shift", &key), macro_undo_id, true);
        manager.finish_group(macro_undo_id, true);
        manager.push(test_entry("macro rename"), macro_undo_id, true);
        manager.finish_group(macro_undo_id, true);

        assert_eq!(
            undo_descriptions(&manager),
            ["operator shift", "macro shift"]
        );
        let macro_group = manager.peek_undo().expect("expected the macro step");
        assert_eq!(macro_group.entries.len(), 2);
    }

    /// Verifies a repeat after a pause longer than the coalesce window starts its own step.
    #[test]
    fn repeat_after_window_does_not_join() {
        let mut manager = UndoManager::with_config(UndoConfig {
            coalesce_window: Duration::ZERO,
            ..UndoConfig::default()
        });
        let key = UndoCoalesceKey::new("test.shift", 1);
        commit_coalescing_edit(&mut manager, "shift 1", &key);
        std::thread::sleep(Duration::from_millis(2));

        commit_coalescing_edit(&mut manager, "shift 2", &key);

        assert_eq!(manager.undo_depth(), 2);
    }
}
