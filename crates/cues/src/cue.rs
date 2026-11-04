// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Defines the cue and sequence data types.

use std::{collections::HashMap, time::Duration};

use nightfall::prelude::*;
use nightfall_engine::prelude::BoundAssertionSet;
use nightfall_instances::Timebase;
use nightfall_selection::{
    HeldReference, ReferenceSource, SelectionValidatedEntity, SpatialSelectionResolution,
};
use serde::{Deserialize, Serialize};

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

fn flatten_bound_instructions(instructions: Vec<BoundAssertionSet>) -> Vec<BoundAssertionSet> {
    let mut flattened: Vec<BoundAssertionSet> = Vec::new();

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
                        flattened.push(BoundAssertionSet {
                            selection: SpatialSelection::identity(SelectionExpr::Resolved(refs)),
                            assertions: instruction.assertions.clone(),
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

/// Nested cue-like component owned by a parent cue.
#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct CuePart {
    /// Identifiers for the cue part. Part IDs are scoped to their parent cue.
    pub identifiers: Identifiers,
    /// Default transition that applies to all attributes in this part
    pub transitions: PartialTransition,
    /// Per-transition attribute that override the part default transitions
    pub transitions_by_attribute: AttributeTransitions,
    /// Instructions for the part. Transitions on an instruction override part-wide transitions.
    pub instructions: Vec<BoundAssertionSet>,
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
#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    pub instructions: Vec<BoundAssertionSet>,
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
            .any(|instruction| instruction.assertions.references_blueprint(uid))
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

/// Reports one instruction's selection and live Blueprint application under `prefix`.
fn visit_instruction_references(
    prefix: &str,
    instruction: &BoundAssertionSet,
    visit: &mut dyn FnMut(&str, HeldReference<'_>),
) {
    visit(
        &format!("{prefix}.selection"),
        HeldReference::Selection(&instruction.selection),
    );
    if let Some(application) = &instruction.assertions.blueprint_application {
        visit(
            &format!("{prefix}.assertions.blueprint_application.blueprint_uid"),
            HeldReference::Blueprint(application.blueprint_uid),
        );
    }
}

impl Cue {
    /// Reports this cue's references with every path prefixed by `prefix`, so sequences can
    /// report their built-in cues as `setup_cue.` and `release_cue.`.
    fn visit_references_with_prefix(
        &self,
        prefix: &str,
        visit: &mut dyn FnMut(&str, HeldReference<'_>),
    ) {
        for (index, instruction) in self.instructions.iter().enumerate() {
            visit_instruction_references(
                &format!("{prefix}instructions[{index}]"),
                instruction,
                visit,
            );
        }
        for (part_index, part) in self.parts.iter().enumerate() {
            for (index, instruction) in part.instructions.iter().enumerate() {
                visit_instruction_references(
                    &format!("{prefix}parts[{part_index}].instructions[{index}]"),
                    instruction,
                    visit,
                );
            }
        }
    }
}

/// Reports instruction selections and Blueprint applications in the cue body and its parts.
impl ReferenceSource for Cue {
    fn visit_references(&self, visit: &mut dyn FnMut(&str, HeldReference<'_>)) {
        self.visit_references_with_prefix("", visit);
    }

    fn visit_selections_mut(&mut self, visit: &mut dyn FnMut(&mut SpatialSelection)) {
        for instruction in self.instructions.iter_mut().chain(
            self.parts
                .iter_mut()
                .flat_map(|part| part.instructions.iter_mut()),
        ) {
            visit(&mut instruction.selection);
        }
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
    /// Whether cue triggers, delays and fades count seconds or show-tempo beats.
    #[serde(default)]
    pub timebase: Timebase,
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
            timebase: Timebase::default(),
        }
    }
}

impl HasIdentifiers for Sequence {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

/// Reports the references of the sequence's built-in setup and release cues.
impl ReferenceSource for Sequence {
    fn visit_references(&self, visit: &mut dyn FnMut(&str, HeldReference<'_>)) {
        self.setup_cue
            .visit_references_with_prefix("setup_cue.", visit);
        self.release_cue
            .visit_references_with_prefix("release_cue.", visit);
    }

    fn visit_selections_mut(&mut self, visit: &mut dyn FnMut(&mut SpatialSelection)) {
        self.setup_cue.visit_selections_mut(visit);
        self.release_cue.visit_selections_mut(visit);
    }
}

#[cfg(test)]
mod tests {
    use nightfall_dmx::prelude::AttributeCategory;
    use nightfall_engine::prelude::AssertionSet;

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
            instructions: vec![BoundAssertionSet {
                selection: SelectionExpr::Resolved(Vec::new()).into(),
                assertions: AssertionSet {
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
            restored.instructions[0].assertions.blueprint_application,
            cue.instructions[0].assertions.blueprint_application
        );
    }
}
