// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Release cue rows derived from the values a sequence's cues assert.
//!
//! A sequence's release cue lists one row per value-bearing instruction in its steps, so the
//! operator can give each fixture attribute its own release timing. The rows copy the step
//! values (which identify the attributes) but none of their timing. The release cue's own shell,
//! with its cue-wide and part-wide timing, is kept, and per-fixture timing overrides the operator
//! stored on earlier rows are carried over to the rows that still match them.

use std::collections::{HashMap, VecDeque};
use std::ops::Deref;

use nightfall::prelude::*;
use nightfall_dmx::prelude::Attribute;
use uuid::Uuid;

use crate::cue::{
    BoundCueInstruction, Cue, CueInstruction, CuePart, FixtureAttributeTransition, Sequence,
};

/// Scope of a row: the release cue itself, or one of its parts by part ID.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum RowScope {
    /// A row on the release cue.
    Parent,
    /// A row on the release cue part with this ID.
    Part(u32),
}

/// Identifies a projected row across projections: its scope, selection and attributes.
type RowKey = (RowScope, String, Vec<Attribute>);

/// Identifies one fixture attribute's timing override across projections.
type FixtureAttributeKey = (Uuid, Option<u32>, Attribute);

/// Per-fixture timing overrides stored on the current release cue, consumed as rows claim them.
#[derive(Default)]
struct StoredTimings {
    /// Each stored row's per-fixture overrides, in row order, by row identity.
    by_row: HashMap<RowKey, VecDeque<Vec<FixtureAttributeTransition>>>,
    /// Each stored override by fixture and attribute, for rows whose identity changed.
    by_fixture_attribute: HashMap<FixtureAttributeKey, VecDeque<PartialTransition>>,
}

impl StoredTimings {
    /// Indexes the per-fixture timing overrides of every row on a stored release cue.
    fn from_release_cue(release_cue: &Cue) -> Self {
        let mut timings = Self::default();
        for instruction in &release_cue.instructions {
            timings.add(RowScope::Parent, instruction);
        }
        for part in &release_cue.parts {
            for instruction in &part.instructions {
                timings.add(RowScope::Part(part.identifiers.id), instruction);
            }
        }
        timings
    }

    /// Indexes one stored row's overrides by row identity and by fixture attribute.
    fn add(&mut self, scope: RowScope, instruction: &BoundCueInstruction) {
        let overrides = &instruction.cue_instruction.transitions_by_fixture_attribute;
        self.by_row
            .entry(row_key(scope, instruction))
            .or_default()
            .push_back(overrides.clone());
        for entry in overrides {
            for (attribute, transition) in &entry.transitions_by_attribute {
                self.by_fixture_attribute
                    .entry((
                        entry.fixture.fixture_uid,
                        entry.fixture.index,
                        attribute.clone(),
                    ))
                    .or_default()
                    .push_back(transition.clone());
            }
        }
    }

    /// Takes the overrides for a projected row: those of the next stored row with the same
    /// identity, or else the stored overrides for its resolved fixtures and attributes.
    fn take_for(
        &mut self,
        scope: RowScope,
        instruction: &BoundCueInstruction,
    ) -> Vec<FixtureAttributeTransition> {
        let by_row = self
            .by_row
            .get_mut(&row_key(scope, instruction))
            .and_then(VecDeque::pop_front)
            .filter(|overrides| !overrides.is_empty());
        if let Some(overrides) = by_row {
            return overrides;
        }

        let attributes = row_attributes(instruction);
        resolved_fixture_refs(instruction)
            .iter()
            .filter_map(|fixture| {
                let transitions_by_attribute: AttributeTransitions = attributes
                    .iter()
                    .filter_map(|attribute| {
                        let timing = self
                            .by_fixture_attribute
                            .get_mut(&(fixture.fixture_uid, fixture.index, attribute.clone()))?
                            .pop_front()?;
                        Some((attribute.clone(), timing))
                    })
                    .collect();
                (!transitions_by_attribute.is_empty()).then(|| FixtureAttributeTransition {
                    fixture: fixture.clone(),
                    transitions_by_attribute,
                })
            })
            .collect()
    }
}

/// Returns the release cue a sequence should store, with one row per value-bearing instruction of
/// its steps, or `None` when the stored release cue already matches it.
///
/// Sequences whose steps assert no values keep their stored release cue unchanged.
pub fn release_cue_rows_update<C: Deref<Target = Cue>>(
    sequence: &Sequence,
    cue_for_uid: impl Fn(Uuid) -> Option<C>,
) -> Option<Cue> {
    let projected = project_release_cue(sequence, cue_for_uid);
    if !has_instruction_rows(&projected) {
        return None;
    }
    (projected != sequence.release_cue).then_some(projected)
}

/// Builds a sequence's release cue rows from the value-bearing instructions of its steps, keeping
/// the stored release cue's shell and reapplying its per-fixture timing overrides.
fn project_release_cue<C: Deref<Target = Cue>>(
    sequence: &Sequence,
    cue_for_uid: impl Fn(Uuid) -> Option<C>,
) -> Cue {
    let stored = &sequence.release_cue;
    let mut release_cue = Cue {
        instructions: Vec::new(),
        parts: Vec::new(),
        ..stored.clone()
    };

    for step in &sequence.steps {
        let Some(cue) = cue_for_uid(step.0) else {
            continue;
        };
        release_cue
            .instructions
            .extend(release_rows(&cue.instructions));
        for part in &cue.parts {
            let stored_part = stored
                .parts
                .iter()
                .find(|candidate| candidate.identifiers.id == part.identifiers.id);
            let mut release_part = release_part(release_cue.identifiers.uid, stored_part, part);
            release_part.instructions = release_rows(&part.instructions);
            release_cue.parts.push(release_part);
        }
    }

    let mut timings = StoredTimings::from_release_cue(stored);
    for instruction in &mut release_cue.instructions {
        instruction.cue_instruction.transitions_by_fixture_attribute =
            timings.take_for(RowScope::Parent, instruction);
    }
    for part in &mut release_cue.parts {
        let scope = RowScope::Part(part.identifiers.id);
        for instruction in &mut part.instructions {
            instruction.cue_instruction.transitions_by_fixture_attribute =
                timings.take_for(scope, instruction);
        }
    }

    release_cue
}

/// Copies the selection and values of each value-bearing instruction, without its timing.
fn release_rows(instructions: &[BoundCueInstruction]) -> Vec<BoundCueInstruction> {
    instructions
        .iter()
        .filter(|instruction| !instruction.cue_instruction.values.is_empty())
        .map(|instruction| BoundCueInstruction {
            selection: instruction.selection.clone(),
            cue_instruction: CueInstruction {
                values: instruction.cue_instruction.values.clone(),
                ..Default::default()
            },
        })
        .collect()
}

/// Builds the release cue part matching a step's part, keeping the stored part's identity,
/// timing and tracking when one exists.
fn release_part(release_cue_uid: Uuid, stored: Option<&CuePart>, source: &CuePart) -> CuePart {
    match stored {
        Some(stored) => CuePart {
            instructions: Vec::new(),
            ..stored.clone()
        },
        None => CuePart {
            identifiers: Identifiers {
                id: source.identifiers.id,
                uid: Uuid::new_v5(
                    &release_cue_uid,
                    format!("part:{}", source.identifiers.id).as_bytes(),
                ),
                label: source.identifiers.label.clone(),
            },
            tracking_flags: source.tracking_flags.clone(),
            ..Default::default()
        },
    }
}

/// Returns whether a cue has any rows on itself or its parts.
fn has_instruction_rows(cue: &Cue) -> bool {
    !cue.instructions.is_empty() || cue.parts.iter().any(|part| !part.instructions.is_empty())
}

/// Returns a row's identity: its scope, selection and sorted attribute names.
fn row_key(scope: RowScope, instruction: &BoundCueInstruction) -> RowKey {
    (
        scope,
        serde_json::to_string(&instruction.selection).unwrap_or_default(),
        row_attributes(instruction),
    )
}

/// Returns the sorted names of the attributes a row writes.
fn row_attributes(instruction: &BoundCueInstruction) -> Vec<Attribute> {
    let mut attributes: Vec<_> = instruction.cue_instruction.values.keys().cloned().collect();
    attributes.sort();
    attributes
}

/// Returns the fixtures stored directly on a row's resolved selection, if it has one.
fn resolved_fixture_refs(instruction: &BoundCueInstruction) -> &[FixtureRef] {
    match &instruction.selection.source {
        SelectionExpr::Resolved(fixtures) => fixtures,
        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use nightfall_dmx::prelude::ParameterValue;

    use super::*;

    /// Builds a fixed fade-out override of `secs` seconds.
    fn fade_out(secs: u64) -> PartialTransition {
        PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(secs))),
            ..Default::default()
        }
    }

    /// Returns the fixed fade-out seconds of an optional override, if it has one.
    fn fade_out_secs(transition: Option<&PartialTransition>) -> Option<u64> {
        match transition?.fade_out.as_ref()? {
            TransitionMode::Fixed(duration) => Some(duration.as_secs()),
            _ => None,
        }
    }

    /// Builds a row writing full red to the given resolved fixtures.
    fn red_row(fixture_uids: &[Uuid]) -> BoundCueInstruction {
        BoundCueInstruction {
            selection: SpatialSelection::identity(SelectionExpr::Resolved(
                fixture_uids
                    .iter()
                    .map(|&fixture_uid| FixtureRef {
                        fixture_uid,
                        index: None,
                    })
                    .collect(),
            )),
            cue_instruction: CueInstruction {
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                )]),
                ..Default::default()
            },
        }
    }

    /// Builds a per-fixture red fade-out override.
    fn red_override(fixture_uid: Uuid, secs: u64) -> FixtureAttributeTransition {
        FixtureAttributeTransition {
            fixture: FixtureRef {
                fixture_uid,
                index: None,
            },
            transitions_by_attribute: HashMap::from([(Attribute::Red, fade_out(secs))]),
        }
    }

    /// Builds a sequence with one step cue and the given stored release cue.
    fn sequence_with(step: &Cue, release_cue: Cue) -> Sequence {
        Sequence {
            steps: vec![step.identifiers.uid.into()],
            release_cue,
            ..Default::default()
        }
    }

    /// Returns the red override stored for one fixture on a row.
    fn red_override_for(
        row: &BoundCueInstruction,
        fixture_uid: Uuid,
    ) -> Option<&PartialTransition> {
        row.cue_instruction
            .transitions_by_fixture_attribute
            .iter()
            .find(|entry| entry.fixture.fixture_uid == fixture_uid)?
            .transitions_by_attribute
            .get(&Attribute::Red)
    }

    /// Rows copy step values without their timing, and stored overrides follow a fixture when the
    /// row it was stored on no longer exists.
    #[test]
    fn overrides_follow_fixtures_when_row_identity_changes() {
        let stored_fixture = Uuid::from_u128(0x44);
        let projected_fixture = Uuid::from_u128(0x55);
        let mut step = Cue::default();
        let mut step_row = red_row(&[projected_fixture]);
        step_row.cue_instruction.transitions = fade_out(9);
        step.instructions = vec![step_row];

        let mut stored_row = red_row(&[stored_fixture]);
        stored_row.cue_instruction.transitions_by_fixture_attribute =
            vec![red_override(projected_fixture, 4)];
        let release_cue = Cue {
            instructions: vec![stored_row],
            ..Default::default()
        };
        let sequence = sequence_with(&step, release_cue);

        let updated =
            release_cue_rows_update(&sequence, |_| Some(&step)).expect("rows should change");
        let row = &updated.instructions[0];
        assert!(row.cue_instruction.transitions.fade_out.is_none());
        assert_eq!(
            fade_out_secs(red_override_for(row, projected_fixture)),
            Some(4)
        );
    }

    /// Fixtures added to a row keep the release cue's own timing, and the cue-wide timing and
    /// existing overrides are kept.
    #[test]
    fn added_fixtures_stay_on_cue_wide_timing() {
        let stored_fixture = Uuid::from_u128(0x44);
        let added_fixture = Uuid::from_u128(0x66);
        let mut step = Cue::default();
        step.instructions = vec![red_row(&[stored_fixture, added_fixture])];

        let mut stored_row = red_row(&[stored_fixture]);
        stored_row.cue_instruction.transitions_by_fixture_attribute =
            vec![red_override(stored_fixture, 6)];
        let release_cue = Cue {
            instructions: vec![stored_row],
            transitions_by_attribute: HashMap::from([(Attribute::Red, fade_out(4))]),
            ..Default::default()
        };
        let sequence = sequence_with(&step, release_cue);

        let updated =
            release_cue_rows_update(&sequence, |_| Some(&step)).expect("rows should change");
        let row = &updated.instructions[0];
        assert_eq!(
            fade_out_secs(updated.transitions_by_attribute.get(&Attribute::Red)),
            Some(4)
        );
        assert_eq!(
            fade_out_secs(red_override_for(row, stored_fixture)),
            Some(6)
        );
        assert!(red_override_for(row, added_fixture).is_none());
    }

    /// A release cue that already matches its steps is left alone, and steps without values never
    /// clear stored rows.
    #[test]
    fn unchanged_and_valueless_sequences_are_not_updated() {
        let mut step = Cue::default();
        step.instructions = vec![red_row(&[Uuid::from_u128(0x44)])];
        let mut sequence = sequence_with(&step, Cue::default());
        let updated =
            release_cue_rows_update(&sequence, |_| Some(&step)).expect("rows should change");
        sequence.release_cue = updated;
        assert!(release_cue_rows_update(&sequence, |_| Some(&step)).is_none());

        let empty = Cue::default();
        assert!(release_cue_rows_update(&sequence, |_| Some(&empty)).is_none());
    }

    /// Step parts get a release part with a stable identity, and a stored part keeps its timing.
    #[test]
    fn parts_map_to_release_parts() {
        let mut step = Cue::default();
        step.parts = vec![CuePart {
            identifiers: Identifiers {
                id: 2,
                uid: Uuid::from_u128(0x77),
                label: "Part 2".into(),
            },
            transitions: fade_out(8),
            instructions: vec![red_row(&[Uuid::from_u128(0x44)])],
            ..Default::default()
        }];
        let sequence = sequence_with(&step, Cue::default());

        let first =
            release_cue_rows_update(&sequence, |_| Some(&step)).expect("rows should change");
        let part = &first.parts[0];
        assert_eq!(part.identifiers.id, 2);
        assert_ne!(part.identifiers.uid, Uuid::from_u128(0x77));
        assert!(part.transitions.fade_out.is_none());
        assert_eq!(part.instructions.len(), 1);

        let mut stored = first.clone();
        stored.parts[0].transitions = fade_out(3);
        let sequence = sequence_with(&step, stored);
        let second = release_cue_rows_update(&sequence, |_| Some(&step));
        assert!(second.is_none(), "stored part timing should be kept as is");
        let again = project_release_cue(&sequence, |_| Some(&step));
        assert_eq!(again.parts[0].identifiers.uid, part.identifiers.uid);
        assert_eq!(fade_out_secs(Some(&again.parts[0].transitions)), Some(3));
    }
}
