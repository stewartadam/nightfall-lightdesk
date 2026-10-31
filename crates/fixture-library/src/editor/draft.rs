// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Open drafts and their edit history.

use std::collections::BTreeMap;
use std::path::PathBuf;

use bevy_ecs::prelude::*;
use gdtf::fixture_type::FixtureType;

use super::commands::{BodyShape, DraftId, DraftSource};
use super::problems::find_problems;
use super::view::DraftProblem;

/// Most edits a draft can undo; older edits are forgotten.
const HISTORY_LIMIT: usize = 100;

/// Editable state of a draft that undo and redo restore.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct DraftState {
    /// Description holding the draft's single fixture type.
    pub description: gdtf::Description,
    /// Body shape the geometry was built from.
    pub body: Option<BodyShape>,
}

/// One open draft.
#[derive(Debug)]
pub struct FixtureDraft {
    /// Draft identity.
    pub(super) id: DraftId,
    /// What the draft was opened from.
    pub(super) origin: DraftSource,
    /// Library file a save writes, once one is known.
    pub(super) file_name: Option<String>,
    /// Archive the draft was opened from, read once so later changes to the
    /// file cannot mix into a save.
    pub(super) source_archive: Option<Vec<u8>>,
    /// Path of the archive the draft was opened from; mesh previews load from it.
    pub(super) source_path: Option<PathBuf>,
    /// Parts of the source description a save drops.
    pub(super) lost_content: Vec<String>,
    /// Library file this draft last wrote, which it may overwrite without confirmation.
    pub(super) saved_file: Option<String>,
    /// Current editable state.
    state: DraftState,
    /// State as opened or last saved.
    saved: DraftState,
    /// States before each kept edit, oldest first.
    undo: Vec<DraftState>,
    /// States reverted by undo, most recent last.
    redo: Vec<DraftState>,
    /// Counts changes to the state, so clients can tell whether their view is current.
    version: u32,
    /// Problems of the current state, found once per change.
    problems: Vec<DraftProblem>,
}

impl FixtureDraft {
    /// Creates a draft whose opened state is `state`.
    pub(super) fn new(id: DraftId, origin: DraftSource, state: DraftState) -> Self {
        let mut draft = Self {
            id,
            origin,
            file_name: None,
            source_archive: None,
            source_path: None,
            lost_content: Vec::new(),
            saved_file: None,
            saved: state.clone(),
            state,
            undo: Vec::new(),
            redo: Vec::new(),
            version: 0,
            problems: Vec::new(),
        };
        draft.problems = find_problems(&draft);
        draft
    }

    /// Counts changes to the state since the draft opened.
    pub(super) fn version(&self) -> u32 {
        self.version
    }

    /// Problems of the current state.
    pub(super) fn problems(&self) -> &[DraftProblem] {
        &self.problems
    }

    /// Records that the state changed: bumps the version and finds its problems again.
    fn changed(&mut self) {
        self.version += 1;
        self.problems = find_problems(self);
    }

    /// Current description.
    pub(super) fn description(&self) -> &gdtf::Description {
        &self.state.description
    }

    /// The draft's fixture type.
    ///
    /// Drafts are only built from descriptions holding at least one fixture
    /// type, and edits never remove it.
    pub(super) fn fixture_type(&self) -> &FixtureType {
        &self.state.description.fixture_types[0]
    }

    /// Body shape the geometry was built from.
    pub(super) fn body(&self) -> Option<BodyShape> {
        self.state.body
    }

    /// Whether the draft differs from its opened or last saved state.
    pub(super) fn is_dirty(&self) -> bool {
        self.state != self.saved
    }

    /// Whether an edit can be reverted.
    pub(super) fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    /// Whether a reverted edit can be reapplied.
    pub(super) fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Applies `change` to a copy of the state and keeps the copy only when the change succeeds.
    ///
    /// A kept change that leaves the state as it was is not recorded in the
    /// history.
    pub(super) fn apply<E>(
        &mut self,
        change: impl FnOnce(&mut DraftState) -> Result<(), E>,
    ) -> Result<(), E> {
        let mut next = self.state.clone();
        change(&mut next)?;
        if next != self.state {
            let previous = std::mem::replace(&mut self.state, next);
            self.undo.push(previous);
            if self.undo.len() > HISTORY_LIMIT {
                self.undo.remove(0);
            }
            self.redo.clear();
            self.changed();
        }
        Ok(())
    }

    /// Reverts the most recent edit; returns whether there was one.
    pub(super) fn undo(&mut self) -> bool {
        let Some(previous) = self.undo.pop() else {
            return false;
        };
        self.redo.push(std::mem::replace(&mut self.state, previous));
        self.changed();
        true
    }

    /// Reapplies the most recently reverted edit; returns whether there was one.
    pub(super) fn redo(&mut self) -> bool {
        let Some(next) = self.redo.pop() else {
            return false;
        };
        self.undo.push(std::mem::replace(&mut self.state, next));
        self.changed();
        true
    }

    /// Records a save: the draft becomes clean and a save writes `file_name` from now on.
    ///
    /// The saved revision entry is added to every state in the history too,
    /// so undoing past a save never drops it from the next save.
    pub(super) fn mark_saved(&mut self, file_name: String, revision: gdtf::revision::Revision) {
        self.saved_file = Some(file_name.clone());
        self.file_name = Some(file_name);
        for state in std::iter::once(&mut self.state)
            .chain(&mut self.undo)
            .chain(&mut self.redo)
        {
            state.description.fixture_types[0]
                .revisions
                .push(revision.clone());
        }
        self.saved = self.state.clone();
        self.changed();
    }
}

/// Every open draft, keyed by identity.
#[derive(Resource, Debug, Default)]
pub struct FixtureDrafts {
    /// Identity the next opened draft receives.
    next_id: DraftId,
    /// Open drafts in opening order.
    drafts: BTreeMap<DraftId, FixtureDraft>,
}

impl FixtureDrafts {
    /// Stores a draft built by `build` under a fresh identity and returns it.
    pub(super) fn open(&mut self, build: impl FnOnce(DraftId) -> FixtureDraft) -> &FixtureDraft {
        self.next_id += 1;
        let id = self.next_id;
        self.drafts.entry(id).or_insert_with(|| build(id))
    }

    /// Looks up an open draft.
    pub(super) fn get(&self, id: DraftId) -> Option<&FixtureDraft> {
        self.drafts.get(&id)
    }

    /// Looks up an open draft for changing.
    pub(super) fn get_mut(&mut self, id: DraftId) -> Option<&mut FixtureDraft> {
        self.drafts.get_mut(&id)
    }

    /// Closes a draft; returns whether it was open.
    pub(super) fn close(&mut self, id: DraftId) -> bool {
        self.drafts.remove(&id).is_some()
    }

    /// Every open draft in opening order.
    pub(super) fn iter(&self) -> impl Iterator<Item = &FixtureDraft> {
        self.drafts.values()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a draft holding an empty description named `name`.
    fn draft(name: &str) -> FixtureDraft {
        let mut description = gdtf::Description::new();
        description
            .fixture_types
            .push(super::super::templates::blank_fixture_type(name, "Generic").unwrap());
        FixtureDraft::new(
            1,
            DraftSource::Blank,
            DraftState {
                description,
                body: None,
            },
        )
    }

    /// Renames the draft's fixture type.
    fn rename(state: &mut DraftState, name: &str) -> Result<(), String> {
        state.description.fixture_types[0].long_name = name.to_string();
        Ok(())
    }

    /// Undo and redo walk the history, and a new edit clears the redo stack.
    #[test]
    fn undo_and_redo_walk_history() {
        let mut draft = draft("Par");
        draft.apply(|state| rename(state, "One")).unwrap();
        draft.apply(|state| rename(state, "Two")).unwrap();
        assert!(draft.undo());
        assert_eq!(draft.fixture_type().long_name, "One");
        assert!(draft.redo());
        assert_eq!(draft.fixture_type().long_name, "Two");
        assert!(draft.undo());
        draft.apply(|state| rename(state, "Three")).unwrap();
        assert!(!draft.can_redo());
        assert!(draft.undo());
        assert!(draft.undo());
        assert!(!draft.undo());
        assert!(!draft.is_dirty());
    }

    /// A failed edit leaves the state and history untouched.
    #[test]
    fn failed_edit_changes_nothing() {
        let mut draft = draft("Par");
        let result = draft.apply(|state| {
            rename(state, "Changed")?;
            Err::<(), _>("rejected".to_string())
        });
        assert!(result.is_err());
        assert_eq!(draft.fixture_type().long_name, "Par");
        assert!(!draft.can_undo());
        assert!(!draft.is_dirty());
    }

    /// An edit that changes nothing is not recorded.
    #[test]
    fn unchanged_edit_is_not_recorded() {
        let mut draft = draft("Par");
        draft.apply(|state| rename(state, "Par")).unwrap();
        assert!(!draft.can_undo());
    }

    /// The history keeps only the most recent edits.
    #[test]
    fn history_is_capped() {
        let mut draft = draft("Par");
        for index in 0..HISTORY_LIMIT + 5 {
            draft
                .apply(|state| rename(state, &index.to_string()))
                .unwrap();
        }
        let mut undone = 0;
        while draft.undo() {
            undone += 1;
        }
        assert_eq!(undone, HISTORY_LIMIT);
    }
}
