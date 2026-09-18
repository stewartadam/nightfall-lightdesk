// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Defines the cue and sequence data types.

use std::{collections::HashMap, time::Duration};

use nightfall::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_selection::{
    SelectionValidatedEntity, SpatialSelectionResolution, selection_validation_warnings,
};
use partially::Partial;
use serde::{Deserialize, Serialize};
use serde_with::DisplayFromStr;

pub mod cue_flags {
    //! proc macro from enum_flags generates structs that cannot be documented,
    //! causing warnings.
    //!
    //! To avoid warnings, any enum_flags-derived structs are moved here and we
    //! permit missing docs for the module.

    #![allow(missing_docs)]

    use enum_flags::enum_flags;
    use serde::{Deserialize, Serialize};
    /// Bit flags that determine which types attributes are tracked. Multiple values
    /// can be combined simultaneously.
    #[repr(u8)]
    #[enum_flags]
    #[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
    #[typeshare::typeshare]
    pub enum TrackingFlags {
        /// Enables tracking for HTP channels (generally, just dimmers)
        HTP = 1,
        /// Enables tracking for LTP channels
        LTP = 2,
        /// Enables tracking for FX
        // FIXME: does this make sense? FX are not attributes, if we wanted this
        // functionality there should probably be layer types here
        FX = 4,
        // These are not tracking flags
        //PixelMap = 8,
        //SOLO = 16,
        //BLOCK = 32,
    }

    impl Default for TrackingFlags {
        fn default() -> TrackingFlags {
            TrackingFlags::HTP | TrackingFlags::LTP | TrackingFlags::FX
        }
    }
}

/// Tracking behavior for cue values that can carry into later sequence cues.
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum TrackingMode {
    /// Uses the owning sequence's tracking mode.
    #[default]
    Inherit,
    /// Uses explicit tracking flags for this cue.
    Flags(cue_flags::TrackingFlags),
}

impl TrackingMode {
    /// Returns the default concrete tracking mode for top-level tracking owners.
    pub fn explicit_default() -> Self {
        Self::Flags(cue_flags::TrackingFlags::default())
    }

    /// Resolves this mode to concrete tracking flags.
    pub fn resolve(self, inherited: cue_flags::TrackingFlags) -> cue_flags::TrackingFlags {
        match self {
            Self::Inherit => inherited,
            Self::Flags(flags) => flags,
        }
    }

    /// Resolves this mode with the global tracking default as the inherited mode.
    pub fn resolve_default(self) -> cue_flags::TrackingFlags {
        self.resolve(cue_flags::TrackingFlags::default())
    }
}

/// Stores an instruction without a selection
///
/// Used by the programmer (active selection events) and palettes
#[serde_with::serde_as]
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct CueInstruction {
    /// The values for each attribute
    #[serde_as(as = "HashMap<DisplayFromStr, _>")]
    #[typeshare(serialized_as = "Record<String, ValueSource>")]
    pub values: HashMap<Attribute, ValueSource>,
    /// Optional live Blueprint operation occupying this instruction's authoring position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blueprint_application: Option<BlueprintApplication>,
    /// Per-transition attribute that override the instruction-wide transitions
    /// #[serde_as(as = "Vec<(_, _)>")]
    #[serde_as(as = "HashMap<DisplayFromStr, _>")]
    #[typeshare(serialized_as = "Record<String, PartialTransition>")]
    pub transitions_by_attribute: AttributeTransitions,
    /// Per-fixture, per-attribute transitions that override instruction-wide and
    /// attribute-wide transitions.
    #[serde(default)]
    pub transitions_by_fixture_attribute: Vec<FixtureAttributeTransition>,
    /// Optional color path applied to logical color transitions in this instruction.
    #[serde(default)]
    pub color_path_id: Option<ColorPathId>,
    /// Default transition that applies to all attributes
    pub transitions: PartialTransition,
}

/// Per-fixture transition overrides grouped by attribute.
#[serde_with::serde_as]
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FixtureAttributeTransition {
    /// Fixture or fixture element this override applies to.
    pub fixture: FixtureRef,
    /// Attribute-specific transition overrides for this fixture ref.
    #[serde_as(as = "HashMap<DisplayFromStr, _>")]
    #[typeshare(serialized_as = "Record<String, PartialTransition>")]
    pub transitions_by_attribute: AttributeTransitions,
}

impl CueInstruction {
    /// Reports whether this instruction dynamically references the Blueprint.
    pub fn references_blueprint(&self, uid: uuid::Uuid) -> bool {
        self.blueprint_application
            .as_ref()
            .is_some_and(|application| application.blueprint_uid == uid)
    }

    /// Merges another instruction into this one
    pub fn merge(&mut self, other: CueInstruction) {
        self.values.extend(other.values);
        if other.blueprint_application.is_some() {
            self.blueprint_application = other.blueprint_application;
        }
        self.transitions.apply_some(other.transitions);
        for (key, value) in other.transitions_by_attribute {
            self.transitions_by_attribute
                .entry(key)
                .and_modify(|e| {
                    e.apply_some(value.clone());
                })
                .or_insert(value);
        }
        for other_fixture_transition in other.transitions_by_fixture_attribute {
            if let Some(existing) = self
                .transitions_by_fixture_attribute
                .iter_mut()
                .find(|entry| entry.fixture == other_fixture_transition.fixture)
            {
                for (key, value) in other_fixture_transition.transitions_by_attribute {
                    existing
                        .transitions_by_attribute
                        .entry(key)
                        .and_modify(|entry| {
                            entry.apply_some(value.clone());
                        })
                        .or_insert(value);
                }
            } else {
                self.transitions_by_fixture_attribute
                    .push(other_fixture_transition);
            }
        }
        if other.color_path_id.is_some() {
            self.color_path_id = other.color_path_id;
        }
    }
}

fn flatten_bound_instructions(instructions: Vec<BoundCueInstruction>) -> Vec<BoundCueInstruction> {
    let mut flattened: Vec<BoundCueInstruction> = Vec::new();

    for instruction in instructions {
        match (
            &instruction.selection.source,
            instruction.selection.clauses.is_empty(),
        ) {
            (SelectionExpr::Resolved(fixtures), true) => {
                // Group FixtureRefs by fixture_uid, preserving order of first occurrence
                // and collecting all element indices for each fixture
                let mut fixture_order: Vec<uuid::Uuid> = Vec::new();
                let mut fixture_refs: HashMap<uuid::Uuid, Vec<FixtureRef>> = HashMap::new();

                for fixture_ref in fixtures {
                    if !fixture_refs.contains_key(&fixture_ref.fixture_uid) {
                        fixture_order.push(fixture_ref.fixture_uid);
                    }
                    fixture_refs
                        .entry(fixture_ref.fixture_uid)
                        .or_default()
                        .push(fixture_ref.clone());
                }

                if fixture_order.len() <= 1 && fixtures.len() <= 1 {
                    flattened.push(instruction);
                } else {
                    for uid in fixture_order {
                        let refs = fixture_refs.remove(&uid).unwrap();
                        flattened.push(BoundCueInstruction {
                            selection: SpatialSelection::identity(SelectionExpr::Resolved(refs)),
                            cue_instruction: instruction.cue_instruction.clone(),
                        });
                    }
                }
            }
            _ => {
                flattened.push(instruction);
            }
        }
    }

    flattened
}

/// Wrapper struct to bind a selection to the instructions
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BoundCueInstruction {
    /// The spatial selection for the instruction
    pub selection: SpatialSelection,
    /// The cue instruction to execute
    pub cue_instruction: CueInstruction,
}

impl SelectionValidatedEntity for BoundCueInstruction {
    /// Return validation warnings for this instruction selection.
    fn selection_validation_warnings(
        &self,
        resolver: &dyn SpatialSelectionResolution,
    ) -> Vec<String> {
        selection_validation_warnings(&self.selection, resolver)
    }
}

/// Nested cue-like component owned by a parent cue.
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct CuePart {
    /// Identifiers for the cue part. Part IDs are scoped to their parent cue.
    pub identifiers: Identifiers,
    /// Default transition that applies to all attributes in this part
    pub transitions: PartialTransition,
    /// Per-transition attribute that override the part default transitions
    pub transitions_by_attribute: AttributeTransitions,
    /// Instructions for the part. Transitions on an instruction override part-wide transitions.
    pub instructions: Vec<BoundCueInstruction>,
    /// Bit flags that determine which types attributes are tracked.
    pub tracking_flags: cue_flags::TrackingFlags,
    /// Whether this cue part may pre-position dark fixtures for its position assertions.
    #[serde(default)]
    pub lookahead: Option<bool>,
}

impl SelectionValidatedEntity for CuePart {
    /// Return validation warnings for selections stored in this cue part.
    fn selection_validation_warnings(
        &self,
        resolver: &dyn SpatialSelectionResolution,
    ) -> Vec<String> {
        self.instructions
            .iter()
            .enumerate()
            .flat_map(|(index, instruction)| {
                instruction
                    .selection_validation_warnings(resolver)
                    .into_iter()
                    .map(move |warning| {
                        format!(
                            "Cue part {} instruction {}: {}",
                            self.identifiers.id,
                            index + 1,
                            warning
                        )
                    })
            })
            .collect()
    }
}

impl CuePart {
    /// Resolves this part's transition with the parent cue timing underneath it.
    pub fn transition_inheriting(&self, cue: &Cue) -> PartialTransition {
        self.transitions.inheriting(&cue.transitions)
    }

    /// Returns the authored scheduling duration for this part under its parent cue.
    ///
    /// This duration comes from cue and part delay/fade timing, regardless of whether
    /// the part currently materializes output values.
    pub fn authored_duration_inheriting(&self, cue: &Cue) -> Duration {
        self.transition_inheriting(cue).authored_duration()
    }

    /// Flattens part instructions so each instruction contains only one fixture.
    pub fn flatten_instructions(mut self) -> Self {
        self.instructions = flatten_bound_instructions(self.instructions);
        self
    }
}

/// Definition of a cue
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Cue {
    /// Identifiers for the cue
    pub identifiers: Identifiers,
    /// Defines how *this* cue will be triggered
    pub trigger: CueTriggerType,
    /// Default transition that applies to all attributes
    pub transitions: PartialTransition,
    /// Per-transition attribute that override the default transitions
    pub transitions_by_attribute: AttributeTransitions,
    /// Instructions for the cue. Transitions on an instruction override the cue-wide transitions.
    pub instructions: Vec<BoundCueInstruction>,
    /// Whether the top-level cue part may pre-position dark fixtures for its position assertions.
    #[serde(default)]
    pub lookahead: Option<bool>,
    /// Nested cue parts that fire at the same activation time as this cue.
    #[serde(default)]
    pub parts: Vec<CuePart>,
    /// Bit flags that determine which types attributes are tracked. Multiple values
    pub tracking_flags: cue_flags::TrackingFlags,
    /// Tracking mode used when this cue contributes values to sequence tracking.
    #[serde(default)]
    pub tracking_mode: Option<TrackingMode>,
}

impl HasIdentifiers for Cue {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }

    /// Cue IDs are scoped to their parent sequence, so duplicates are allowed globally.
    fn requires_unique_id() -> bool {
        false
    }
}

impl SelectionValidatedEntity for Cue {
    /// Return validation warnings for selections stored in this cue and its parts.
    fn selection_validation_warnings(
        &self,
        resolver: &dyn SpatialSelectionResolution,
    ) -> Vec<String> {
        let instruction_warnings =
            self.instructions
                .iter()
                .enumerate()
                .flat_map(|(index, instruction)| {
                    instruction
                        .selection_validation_warnings(resolver)
                        .into_iter()
                        .map(move |warning| {
                            format!(
                                "Cue {} instruction {}: {}",
                                self.identifiers.id,
                                index + 1,
                                warning
                            )
                        })
                });

        let part_warnings = self
            .parts
            .iter()
            .flat_map(|part| part.selection_validation_warnings(resolver));

        instruction_warnings.chain(part_warnings).collect()
    }
}

impl Cue {
    /// Reports whether the cue body or any cue part references the Blueprint.
    pub fn references_blueprint(&self, uid: uuid::Uuid) -> bool {
        self.instructions
            .iter()
            .chain(self.parts.iter().flat_map(|part| part.instructions.iter()))
            .any(|instruction| instruction.cue_instruction.references_blueprint(uid))
    }

    /// Returns the distinct Blueprint identities referenced by this cue.
    pub fn referenced_blueprints(&self) -> std::collections::HashSet<uuid::Uuid> {
        self.instructions
            .iter()
            .chain(self.parts.iter().flat_map(|part| part.instructions.iter()))
            .filter_map(|instruction| {
                instruction
                    .cue_instruction
                    .blueprint_application
                    .as_ref()
                    .map(|application| application.blueprint_uid)
            })
            .collect()
    }

    /// Returns the authored scheduling duration for this cue and its parts.
    ///
    /// This is distinct from materialized assertion duration: it describes how much
    /// source-local time the cue definition occupies due to authored delay/fade
    /// timing, even when no fixture values materialize.
    pub fn authored_duration(&self) -> Duration {
        cue_authored_duration(
            &self.transitions,
            self.parts.iter().map(|part| &part.transitions),
        )
    }

    /// Resolves sequence-tracking flags, preserving legacy cue flags when no mode is stored.
    pub fn sequence_tracking_flags(
        &self,
        inherited: cue_flags::TrackingFlags,
    ) -> cue_flags::TrackingFlags {
        self.tracking_mode
            .map(|tracking_mode| tracking_mode.resolve(inherited))
            .unwrap_or(self.tracking_flags)
    }

    /// Flattens cue instructions so each instruction contains only one fixture.
    ///
    /// This simplifies editing by ensuring changes to one fixture's values
    /// don't affect other fixtures. Only `Resolved` selections with multiple
    /// fixtures are split; other selection types are left unchanged.
    ///
    /// FixtureRefs are grouped by fixture_uid, preserving the original index
    /// values (None for whole fixtures, Some(n) for specific elements).
    pub fn flatten_instructions(mut self) -> Self {
        self.instructions = flatten_bound_instructions(self.instructions);
        self.parts = self
            .parts
            .into_iter()
            .map(CuePart::flatten_instructions)
            .collect();
        self
    }

    /// Returns the cue part with the provided parent-scoped ID.
    pub fn part_by_id(&self, part_id: u32) -> Option<&CuePart> {
        self.parts
            .iter()
            .find(|part| part.identifiers.id == part_id)
    }

    /// Inserts or replaces a cue part by UID, falling back to parent-scoped part ID.
    pub fn upsert_part(&mut self, part: CuePart) {
        if let Some(existing) = self
            .parts
            .iter_mut()
            .find(|existing| existing.identifiers.uid == part.identifiers.uid)
        {
            *existing = part;
            return;
        }

        if let Some(existing) = self
            .parts
            .iter_mut()
            .find(|existing| existing.identifiers.id == part.identifiers.id)
        {
            *existing = part;
            return;
        }

        self.parts.push(part);
        self.parts
            .sort_by_key(|part| (part.identifiers.id, part.identifiers.uid));
    }
}

/// Definition of a sequence
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Sequence {
    /// Identifiers for the sequence
    pub identifiers: Identifiers,
    /// Steps in the sequence, where each item is a reference to a cue by unique ID.
    #[typeshare(serialized_as = "Array<String>")]
    pub steps: Vec<SimpleUuid>,
    /// Whether the sequence should transition to cue 1 when advancing on the last cue
    pub wrap: bool,
    /// Whether the sequence should release the selection on start
    pub release_on_start: bool,
    /// Built-in cue whose values are asserted when this sequence initializes.
    pub setup_cue: Cue,
    /// Built-in cue whose transition timing is used when this sequence releases.
    pub release_cue: Cue,
    /// Default transition that applies to all attributes
    pub default_timing: Transition,
    /// Tracking mode inherited by cues in this sequence.
    #[serde(default = "TrackingMode::explicit_default")]
    pub tracking_mode: TrackingMode,
}

impl Default for Sequence {
    /// Create an empty sequence with explicit tracking and initialized built-in cues.
    fn default() -> Self {
        let setup_cue = Cue {
            tracking_mode: Some(TrackingMode::explicit_default()),
            ..Default::default()
        };
        let release_cue = Cue {
            tracking_mode: Some(TrackingMode::Inherit),
            ..Default::default()
        };

        Self {
            identifiers: Identifiers::default(),
            steps: Vec::new(),
            wrap: false,
            release_on_start: false,
            setup_cue,
            release_cue,
            default_timing: Transition::default(),
            tracking_mode: TrackingMode::explicit_default(),
        }
    }
}

impl HasIdentifiers for Sequence {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies cue duration helpers read timing even when no values materialize.
    #[test]
    fn cue_authored_duration_reads_empty_cue_and_part_timing() {
        let cue = Cue {
            transitions: PartialTransition {
                fade_in: Some(TransitionMode::Interpolated {
                    start: Duration::ZERO,
                    end: Duration::from_millis(100),
                }),
                ..Default::default()
            },
            parts: vec![CuePart {
                identifiers: Identifiers {
                    id: 1,
                    label: "Empty timed part".to_owned(),
                    ..Default::default()
                },
                transitions: PartialTransition {
                    delay_in: Some(TransitionMode::Fixed(Duration::from_millis(250))),
                    fade_in: Some(TransitionMode::Manual(vec![
                        Duration::ZERO,
                        Duration::from_millis(500),
                        Duration::from_millis(100),
                    ])),
                    delay_out: Some(TransitionMode::Fixed(Duration::from_millis(100))),
                    fade_out: Some(TransitionMode::Fixed(Duration::from_millis(900))),
                    ..Default::default()
                },
                ..Default::default()
            }],
            ..Default::default()
        };

        assert_eq!(cue.authored_duration(), Duration::from_millis(1000));
    }

    /// Cue serialization preserves stable Blueprint identity and dynamic selector semantics.
    #[test]
    fn cue_blueprint_application_round_trips() {
        let blueprint_uid = uuid::Uuid::new_v4();
        let cue = Cue {
            instructions: vec![BoundCueInstruction {
                selection: SelectionExpr::Resolved(Vec::new()).into(),
                cue_instruction: CueInstruction {
                    blueprint_application: Some(BlueprintApplication {
                        blueprint_uid,
                        selector: BlueprintSelector::Category(AttributeCategory::Color),
                    }),
                    ..Default::default()
                },
            }],
            ..Default::default()
        };
        let serialized = serde_json::to_string(&cue).expect("cue should serialize");
        let restored: Cue = serde_json::from_str(&serialized).expect("cue should deserialize");
        assert_eq!(
            restored.instructions[0]
                .cue_instruction
                .blueprint_application,
            cue.instructions[0].cue_instruction.blueprint_application
        );
    }
}
