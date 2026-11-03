// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Resources for the programmer
use std::collections::HashMap;

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_cues::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A single instruction in the programmer
#[derive(Debug, Clone)]
pub struct ProgrammerInstruction {
    /// Identifier for the programmer instruction, and used for generating the ephemeral cue
    pub id: Uuid,
    /// The selection and fixture values
    pub instruction: BoundCueInstruction,
}

/// Maintains insertion order while allowing efficient lookups by UUID
#[derive(Debug, Default, Clone)]
pub struct ProgrammerInstructions {
    instructions: Vec<ProgrammerInstruction>,
    lookup: HashMap<Uuid, usize>, // Maps UUID to index in instructions
}

/// The mode of the programmer.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ProgrammerMode {
    #[default]
    /// Instructions are captured but not rendered to outputs
    Blind,
    /// Instructions are rendered to outputs on top of all other layers
    Live,
}

/// Cue-level timing defaults preserved when a cue or cue part is recalled.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct RecalledCueTimingDefaults {
    /// Default transition fields authored on the recalled cue or part.
    pub transitions: PartialTransition,
    /// Attribute-specific transition defaults authored on the recalled cue or part.
    pub transitions_by_attribute: AttributeTransitions,
}

impl ProgrammerInstructions {
    /// Create a new empty set of instructions
    pub fn new() -> Self {
        Self {
            instructions: Vec::new(),
            lookup: HashMap::new(),
        }
    }

    /// Insert a new instruction into the programmer
    pub fn insert(
        &mut self,
        id: Uuid,
        instruction: BoundCueInstruction,
    ) -> Option<BoundCueInstruction> {
        match self.lookup.entry(id) {
            std::collections::hash_map::Entry::Occupied(entry) => {
                let idx = *entry.get();
                let old_instruction =
                    std::mem::replace(&mut self.instructions[idx].instruction, instruction);
                Some(old_instruction)
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(self.instructions.len());
                self.instructions
                    .push(ProgrammerInstruction { id, instruction });
                None
            }
        }
    }

    /// Get an immutable reference to an instruction by ID
    pub fn get(&self, id: &Uuid) -> Option<&BoundCueInstruction> {
        self.lookup
            .get(id)
            .map(|&idx| &self.instructions[idx].instruction)
    }

    /// Get a mutable reference to an instruction by ID
    pub fn get_mut(&mut self, id: &Uuid) -> Option<&mut BoundCueInstruction> {
        if let Some(&idx) = self.lookup.get(id) {
            Some(&mut self.instructions[idx].instruction)
        } else {
            None
        }
    }

    /// Remove an instruction by ID
    pub fn remove(&mut self, id: &Uuid) -> Option<BoundCueInstruction> {
        if let Some(idx) = self.lookup.remove(id) {
            // Swap with last element for O(1) removal
            let instruction = self.instructions.swap_remove(idx).instruction;

            // Update the index of the swapped element if it's not the one we removed
            if idx < self.instructions.len() {
                let swapped_id = self.instructions[idx].id;
                *self.lookup.get_mut(&swapped_id).unwrap() = idx;
            }

            Some(instruction)
        } else {
            None
        }
    }

    /// Clear all instructions
    pub fn clear(&mut self) {
        self.instructions.clear();
        self.lookup.clear();
    }

    /// Iterate over all instructions
    pub fn iter(&self) -> impl Iterator<Item = (&Uuid, &BoundCueInstruction)> {
        self.instructions.iter().map(|i| (&i.id, &i.instruction))
    }

    /// Iterate over all instructions mutably
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&Uuid, &mut BoundCueInstruction)> {
        self.instructions.iter_mut().map(|i| {
            let id = &i.id;
            let instruction = &mut i.instruction;
            (id, instruction)
        })
    }

    /// Get the number of instructions
    pub fn len(&self) -> usize {
        self.instructions.len()
    }

    /// Check if the instruction buffer is empty
    pub fn is_empty(&self) -> bool {
        self.instructions.is_empty()
    }

    /// Move an instruction to the end of the vector (so it's applied last)
    pub fn reorder_to_end(&mut self, id: &Uuid) {
        if let Some(&idx) = self.lookup.get(id) {
            if idx < self.instructions.len() - 1 {
                // Only reorder if it's not already at the end
                let instruction = self.instructions.remove(idx);
                self.instructions.push(instruction);

                // Update lookup indices: all instructions between idx and end-1 shift down by 1
                for i in idx..self.instructions.len() - 1 {
                    let shifted_id = self.instructions[i].id;
                    *self.lookup.get_mut(&shifted_id).unwrap() = i;
                }
                // Update the moved instruction's index
                *self.lookup.get_mut(id).unwrap() = self.instructions.len() - 1;
            }
        }
    }
}

/// Programmer entity, to hold parameter values.
///
/// Looks very similar to a cue, but lacks identifiers and cue triggers.
/// Multiple programmers can be instantiated to facilitate functionality like 'in blind'.
#[derive(Default, Resource)]
pub struct Programmer {
    /// Identifiers for the programmer
    pub identifiers: Identifiers,
    /// References for the programmer
    pub references: References,
    /// Transitions for the programmer
    pub transitions: Transition,
    /// Attribute transitions for the programmer
    pub attribute_transitions: AttributeTransitions,
    /// Live instructions for the programmer
    pub live_instructions: ProgrammerInstructions,
    /// Blind instructions for the programmer
    pub blind_instructions: ProgrammerInstructions,
    /// New instruction IDs that should inherit timing anchors from an existing instruction.
    pub transition_anchor_aliases: HashMap<Uuid, Uuid>,
    /// The mode of the programmer
    pub mode: ProgrammerMode,
    /// The active spatial selection for the programmer
    pub active_selection: SpatialSelection,
    /// Cue-level timing defaults from the last recalled cue or cue part.
    pub recalled_cue_timing_defaults: Option<RecalledCueTimingDefaults>,
}

impl HasIdentifiers for Programmer {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

impl Programmer {
    /// Get the mutable reference to the currently active buffer
    pub(crate) fn active_instructions_mut(&mut self) -> &mut ProgrammerInstructions {
        match self.mode {
            ProgrammerMode::Live => &mut self.live_instructions,
            ProgrammerMode::Blind => &mut self.blind_instructions,
        }
    }

    /// Get immutable reference to the active buffer
    pub fn active_instructions(&self) -> &ProgrammerInstructions {
        match self.mode {
            ProgrammerMode::Live => &self.live_instructions,
            ProgrammerMode::Blind => &self.blind_instructions,
        }
    }

    /// Add an instruction to the active programmer
    pub fn add_instruction(&mut self, bound_instruction: BoundCueInstruction) -> Uuid {
        tracing::trace!(
            instruction = ?bound_instruction,
            "Adding instruction to active programmer"
        );

        // Check if the instruction with this selection already exists
        let incoming_is_blueprint = bound_instruction
            .cue_instruction
            .blueprint_application
            .is_some();
        let maybe_existing = self
            .active_instructions_mut()
            .iter_mut()
            .find(|(_, instruction)| {
                !incoming_is_blueprint
                    && instruction.cue_instruction.blueprint_application.is_none()
                    && instruction.selection == bound_instruction.selection
            });

        match maybe_existing {
            Some((uid, existing_instruction)) => {
                let uid = *uid;
                existing_instruction
                    .cue_instruction
                    .merge(bound_instruction.cue_instruction);

                // Move the instruction to the end so it's applied last
                self.active_instructions_mut().reorder_to_end(&uid);
                uid
            }
            None => {
                let uid = Uuid::new_v4();
                self.active_instructions_mut()
                    .insert(uid, bound_instruction);
                uid
            }
        }
    }

    /// Clear the active programmer instructions
    pub fn clear(&mut self) {
        tracing::trace!("Clearing active programmer instructions");
        self.active_instructions_mut().clear();
        self.transition_anchor_aliases.clear();
        self.recalled_cue_timing_defaults = None;
    }

    /// Records that a split instruction should continue transition timing from a source row.
    pub(crate) fn set_transition_anchor_alias(&mut self, instruction_id: Uuid, source_id: Uuid) {
        self.transition_anchor_aliases
            .insert(instruction_id, source_id);
    }

    /// Returns the source row whose transition anchors should seed an instruction, if any.
    pub(crate) fn transition_anchor_source(&self, instruction_id: &Uuid) -> Option<Uuid> {
        self.transition_anchor_aliases.get(instruction_id).copied()
    }

    /// Stores cue-level timing defaults from a recalled cue or cue part.
    pub fn set_recalled_cue_timing_defaults(
        &mut self,
        transitions: PartialTransition,
        transitions_by_attribute: AttributeTransitions,
    ) {
        self.recalled_cue_timing_defaults = Some(RecalledCueTimingDefaults {
            transitions,
            transitions_by_attribute,
        });
    }

    /// Clears cue-level timing defaults retained from the last recalled cue or cue part.
    pub fn clear_recalled_cue_timing_defaults(&mut self) {
        self.recalled_cue_timing_defaults = None;
    }

    /// Commit blind instructions to live
    pub fn commit_blind(&mut self) {
        tracing::trace!("Committing blind instructions to live");
        // Clone all instructions from blind to live, maintaining order
        for instruction in self.blind_instructions.instructions.drain(..) {
            self.live_instructions
                .insert(instruction.id, instruction.instruction);
        }
        self.blind_instructions.clear();
    }

    /// Set the mode of the programmer
    pub fn set_mode(&mut self, mode: ProgrammerMode) {
        tracing::trace!(?mode, "Setting programmer mode");
        self.mode = mode;
    }

    /// Get the active selection
    pub fn active_selection(&self) -> SelectionExpr {
        self.active_selection.source.clone()
    }

    /// Get the active spatial selection
    pub fn active_spatial_selection(&self) -> SpatialSelection {
        self.active_selection.clone()
    }

    /// Set the active selection
    pub fn set_active_selection(&mut self, new_selection: SelectionExpr) {
        tracing::debug!(selection = ?new_selection, "Setting active selection");
        self.active_selection = SpatialSelection::identity(new_selection);
    }

    /// Set the active spatial selection
    pub fn set_active_spatial_selection(&mut self, new_selection: SpatialSelection) {
        tracing::debug!(
            selection = ?new_selection,
            "Setting active spatial selection"
        );
        self.active_selection = new_selection;
    }
}

#[cfg(test)]
mod tests {
    use nightfall_cues::cue::CueInstruction;

    use super::*;

    #[test]
    fn test_merged_instruction_moves_to_end() {
        use nightfall::prelude::UnresolvedFixtureRef;

        let mut programmer = Programmer::default();

        // Create two different selection expressions
        let selection1 = SelectionExpr::Fixture(UnresolvedFixtureRef {
            fixture_id: 1,
            element_index: None,
        });
        let selection2 = SelectionExpr::Fixture(UnresolvedFixtureRef {
            fixture_id: 2,
            element_index: None,
        });

        // Add first instruction with selection1
        let instr1 = BoundCueInstruction {
            selection: selection1.clone().into(),
            cue_instruction: CueInstruction::default(),
        };
        let uid1 = programmer.add_instruction(instr1);

        // Add second instruction with selection2 (different)
        let instr2 = BoundCueInstruction {
            selection: selection2.clone().into(),
            cue_instruction: CueInstruction::default(),
        };
        let uid2 = programmer.add_instruction(instr2);

        // Add third instruction with same selection as first (should merge and move to end)
        let instr3 = BoundCueInstruction {
            selection: selection1.clone().into(),
            cue_instruction: CueInstruction::default(),
        };
        programmer.add_instruction(instr3);

        // Collect the order of instructions
        let mut order = Vec::new();
        for (uid, _) in programmer.active_instructions().iter() {
            order.push(*uid);
        }

        // The merged instruction (uid1) should be at the end
        assert_eq!(order.len(), 2, "Should have 2 instructions after merge");
        assert_eq!(
            order[1], uid1,
            "Merged instruction should be moved to the end"
        );
        assert_eq!(order[0], uid2, "Second instruction should now be first");
    }

    #[test]
    fn test_programmer_instructions_reorder_to_end() {
        let mut instructions = ProgrammerInstructions::new();

        let uuid1 = Uuid::new_v4();
        let uuid2 = Uuid::new_v4();
        let uuid3 = Uuid::new_v4();

        let instr = BoundCueInstruction {
            selection: SelectionExpr::default().into(),
            cue_instruction: CueInstruction::default(),
        };

        // Insert three instructions
        instructions.insert(uuid1, instr.clone());
        instructions.insert(uuid2, instr.clone());
        instructions.insert(uuid3, instr.clone());

        // Verify initial order
        let order: Vec<_> = instructions.iter().map(|(uid, _)| *uid).collect();
        assert_eq!(order, vec![uuid1, uuid2, uuid3]);

        // Move uuid1 to end
        instructions.reorder_to_end(&uuid1);

        // Verify new order
        let order: Vec<_> = instructions.iter().map(|(uid, _)| *uid).collect();
        assert_eq!(order, vec![uuid2, uuid3, uuid1]);

        // Move uuid2 to end
        instructions.reorder_to_end(&uuid2);

        // Verify final order
        let order: Vec<_> = instructions.iter().map(|(uid, _)| *uid).collect();
        assert_eq!(order, vec![uuid3, uuid1, uuid2]);
    }
}
