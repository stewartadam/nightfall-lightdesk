// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Native adapter for authored sequence lookahead projection.

use std::collections::HashMap;

use nightfall::prelude::{FixtureRef, SpatialSelection, ValueSource};
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_lookahead_projection::{
    ProjectedLookaheadValue, ProjectionCue, ProjectionCuePart, ProjectionInstruction,
    SequenceLookaheadProjectionRequest, project_sequence_lookahead,
};
use uuid::Uuid;

use crate::cue::{BoundCueInstruction, Cue, Sequence};

/// Projects authored sequence lookahead values through the shared pure evaluator.
pub fn project_authored_sequence_lookahead(
    sequence: &Sequence,
    steps: &[Cue],
    target_cue_uid: Uuid,
    selection_resolver: &SpatialSelectionResolver,
) -> Vec<ProjectedLookaheadValue> {
    let request =
        sequence_lookahead_projection_request(sequence, steps, target_cue_uid, selection_resolver);
    project_sequence_lookahead(&request)
}

/// Builds a pure lookahead projection request from native cue definitions.
pub fn sequence_lookahead_projection_request(
    sequence: &Sequence,
    steps: &[Cue],
    target_cue_uid: Uuid,
    selection_resolver: &SpatialSelectionResolver,
) -> SequenceLookaheadProjectionRequest {
    SequenceLookaheadProjectionRequest {
        sequence_id: sequence.identifiers.id,
        wrap: sequence.wrap,
        target_cue_uid: target_cue_uid.to_string(),
        setup_instructions: projection_instructions(
            &sequence.setup_cue.instructions,
            selection_resolver,
        ),
        cues: steps
            .iter()
            .map(|cue| projection_cue(cue, selection_resolver))
            .collect(),
    }
}

/// Converts one cue into the pure projection DTO.
fn projection_cue(cue: &Cue, selection_resolver: &SpatialSelectionResolver) -> ProjectionCue {
    ProjectionCue {
        cue_uid: cue.identifiers.uid.to_string(),
        cue_id: cue.identifiers.id,
        lookahead: cue.lookahead.unwrap_or_default(),
        instructions: projection_instructions(&cue.instructions, selection_resolver),
        parts: cue
            .parts
            .iter()
            .map(|part| ProjectionCuePart {
                part_id: part.identifiers.id,
                lookahead: part.lookahead.unwrap_or_default(),
                instructions: projection_instructions(&part.instructions, selection_resolver),
            })
            .collect(),
    }
}

/// Converts an instruction list into pure projection DTOs.
fn projection_instructions(
    instructions: &[BoundCueInstruction],
    selection_resolver: &SpatialSelectionResolver,
) -> Vec<ProjectionInstruction> {
    instructions
        .iter()
        .map(|instruction| projection_instruction(instruction, selection_resolver))
        .collect()
}

/// Converts one cue instruction into a pure projection DTO.
fn projection_instruction(
    instruction: &BoundCueInstruction,
    selection_resolver: &SpatialSelectionResolver,
) -> ProjectionInstruction {
    ProjectionInstruction {
        fixtures: resolved_fixture_refs_for_selection(&instruction.selection, selection_resolver),
        values: instruction
            .cue_instruction
            .values
            .iter()
            .map(|(attribute, source)| (attribute.key(), source.clone()))
            .collect::<HashMap<String, ValueSource>>(),
    }
}

/// Resolves a spatial selection into fixture refs using runtime selection order.
fn resolved_fixture_refs_for_selection(
    selection: &SpatialSelection,
    selection_resolver: &SpatialSelectionResolver,
) -> Vec<FixtureRef> {
    selection_resolver
        .resolve(selection)
        .value
        .indexes()
        .iter()
        .flat_map(|index| index.members.iter().map(|member| member.fixture.clone()))
        .collect()
}
