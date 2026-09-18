// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::{HashMap, VecDeque};

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::{CommandId, UndoId};
use web_time::Instant;

use crate::traits::UndoableOperation;

/// Configuration for undo manager behavior.
#[derive(Clone, Debug)]
pub struct UndoConfig {
    /// Maximum number of undo groups to retain. Default: 100.
    pub max_history: usize,
}

impl Default for UndoConfig {
    fn default() -> Self {
        Self { max_history: 100 }
    }
}

/// A single entry in an undo group, representing one command.
#[derive(Clone)]
pub struct UndoEntry {
    /// The inverse command that undoes the original operation.
    pub command: Box<dyn UndoableOperation>,
    /// Human-readable description for UI display.
    pub description: String,
    /// User command that caused the operation, when one exists.
    pub command_id: Option<CommandId>,
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
    redo_stack: Vec<UndoGroup>,
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
        if !self.redo_stack.is_empty() {
            self.collapse_redo_stack_for_gurq();
        }

        if let Some(last_group) = self.undo_stack.back_mut() {
            if last_group.undo_id == undo_id {
                last_group.entries.extend(group.entries);
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
    /// This makes all previous states reachable via undo, implementing
    /// the linear-time history model where no states are ever lost.
    fn collapse_redo_stack_for_gurq(&mut self) {
        for redo_group in self.redo_stack.drain(..).rev() {
            let mut instant_group = redo_group;
            instant_group.is_gurq_preserved = true;
            self.undo_stack.push_back(instant_group);
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
        self.redo_stack.last()
    }

    /// Iterate over undo groups from oldest to newest.
    pub fn undo_stack(&self) -> impl DoubleEndedIterator<Item = &UndoGroup> {
        self.undo_stack.iter()
    }

    /// Iterate over redo groups from oldest to newest.
    pub fn redo_stack(&self) -> impl DoubleEndedIterator<Item = &UndoGroup> {
        self.redo_stack.iter()
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
    pub fn push_redo(&mut self, group: UndoGroup) {
        self.redo_stack.push(group);
    }

    /// Pop and return the next group to redo.
    pub fn pop_redo(&mut self) -> Option<UndoGroup> {
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

#[cfg(test)]
mod tests {
    use nightfall_engine::prelude::EnginePayload;

    use super::*;
    use crate::context::UndoContext;
    use crate::traits::UndoableOperation;

    /// Test command used to verify undo-manager behavior without app dependencies.
    #[derive(Debug, Clone, EnginePayload)]
    struct TestUndoCommand;

    impl UndoableOperation for TestUndoCommand {
        fn inverse(&self, _ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
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
        }
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
}
