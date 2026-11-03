// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Programmer ingress command and cue-store contracts.

use super::*;

/// Store behavior requested by a cue store command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "snake_case")]
pub enum StoreMode {
    /// Replace target contents with programmer values.
    Replace,
    /// Upsert programmer values into target contents.
    Merge,
    /// Update only existing fixture and attribute values in target contents.
    Update,
    /// Remove programmer attributes from target contents.
    Remove,
}

/// Cue ID target for a cue store command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum StoreCueId {
    /// Store into the exact cue ID.
    Exact(u32),
    /// Store into the next available cue ID in the sequence.
    Next,
}

/// Part ID target for a cue-part store command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum StoreCuePartId {
    /// Store into the exact part ID.
    Exact(u32),
    /// Store into the next available part ID in the cue.
    Next,
}

/// One ordered logical value operation produced by the shared attribute grammar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ProgrammerAttributeOperation {
    /// Attribute, category, or complete Blueprint target.
    pub target: BlueprintSelector,
    /// Direct value or unresolved Blueprint source.
    pub source: ProgrammerAttributeSource,
}

/// Runtime-independent source preserved until the programmer handler has showfile state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ProgrammerAttributeSource {
    /// Direct logical value entered by the operator.
    Direct(ValueSource),
    /// Blueprint address and source-local reference behavior.
    Blueprint {
        /// Mutable operator-facing address to resolve at execution.
        address: BlueprintAddress,
        /// Whether execution retains a UUID reference or direct values.
        resolution: BlueprintResolution,
    },
}

/// Events related to the programmer
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum ProgrammerCommand {
    /// Clear selection if present; otherwise clear active programmer values
    ClearProgrammer,
    /// Clear the active selection in the programmer
    ClearProgrammerSelection,
    /// Clear the active programmer values
    ClearProgrammerValues,
    /// Release programmer values for an optional selection and optional attributes.
    /// If selection is None, this applies globally across programmer instructions.
    ReleaseProgrammerValues {
        /// Optional selection scope. None applies globally.
        selection: Option<SelectionExpr>,
        /// Optional attribute filter. Empty means all attributes.
        attributes: Vec<Attribute>,
        /// Whether the caller explicitly approved flattening non-resolved selections.
        #[serde(default)]
        allow_selection_flatten: bool,
        /// Single-use backend approval proving that an operator confirmed flattening.
        #[serde(default)]
        selection_flatten_approval: Option<uuid::Uuid>,
    },

    /// Add an instruction to the active programmer.
    AddProgrammerInstruction {
        /// Spatial selection to apply instruction to.
        selection: SpatialSelection,
        /// Instruction to add.
        instruction: CueInstruction,
    },

    /// Add an instruction to the active programmer with the current selection
    AddProgrammerInstructionWithActiveSelection(CueInstruction),

    /// Resolve and apply ordered direct or Blueprint-backed attribute operations.
    ApplyAttributeOperations {
        /// Explicit selection, or `None` to bind the active selection at execution.
        selection: Option<SpatialSelection>,
        /// Ordered operations produced by the shared attribute-assignment parser.
        operations: Vec<ProgrammerAttributeOperation>,
        /// Instruction-wide timing applied to each generated ordered row.
        transitions: PartialTransition,
        /// Per-attribute timing retained on generated rows.
        transitions_by_attribute: AttributeTransitions,
    },

    /// Set the active selection in the programmer
    SetProgrammerSelection(SelectionExpr),

    /// Set the active spatial selection in the programmer
    SetProgrammerSpatialSelection(SpatialSelection),

    /// Add to the active selection in the programmer
    AddProgrammerSelection(SelectionExpr),

    /// Remove from the active selection in the programmer
    RemoveProgrammerSelection(SelectionExpr),

    /// Save programmer instructions as a cue
    StoreCue {
        /// Sequence ID to store the cue into
        sequence_id: u32,
        /// Cue ID target within the sequence
        cue_id: StoreCueId,
        /// Cue part target within the cue. Part 0 is the parent cue.
        part_id: StoreCuePartId,
        /// Store behavior for existing targets
        mode: StoreMode,
        /// Optional label for the cue or part
        label: Option<String>,
    },

    /// Recall a cue into the active programmer
    RecallCue {
        /// Sequence ID containing the cue
        sequence_id: u32,
        /// Cue ID to recall
        cue_id: u32,
        /// Cue part ID to recall. Part 0 is the parent cue.
        part_id: u32,
        /// Whether recall should select the recalled fixtures or elements.
        select: bool,
    },

    /// Store current programmer selection as a group
    StoreGroup {
        /// Group ID to store into
        group_id: u32,
        /// Optional label for the group
        label: Option<String>,
    },

    /// Store current programmer values as a blueprint
    StoreBlueprint {
        /// Blueprint ID to store into
        blueprint_id: u32,
        /// Optional attribute/category filter (empty = all attributes)
        filter: Vec<BlueprintSelector>,
    },
}

impl IngressCommand for ProgrammerCommand {}

impl ProgrammerCommand {
    /// Render this command into a parser-compatible CLI command string when possible.
    pub fn to_cli_command(&self) -> Option<String> {
        let format_attribute = |attribute: &Attribute| {
            let label = attribute.to_string();
            if label.chars().any(char::is_whitespace) {
                format!("\"{label}\"")
            } else {
                label.to_lowercase()
            }
        };
        let format_attributes = |attributes: &[Attribute]| {
            attributes
                .iter()
                .map(format_attribute)
                .collect::<Vec<_>>()
                .join(" ")
        };
        let format_store_mode = |mode: StoreMode| match mode {
            StoreMode::Replace => "",
            StoreMode::Merge => " /merge",
            StoreMode::Update => " /update",
            StoreMode::Remove => " /remove",
        };

        match self {
            ProgrammerCommand::ClearProgrammer => Some("clear".to_string()),
            ProgrammerCommand::ClearProgrammerSelection => Some("clear selection".to_string()),
            ProgrammerCommand::ClearProgrammerValues => Some("clear values".to_string()),
            ProgrammerCommand::ReleaseProgrammerValues {
                selection,
                attributes,
                allow_selection_flatten: _,
                selection_flatten_approval: _,
            } => match (selection, attributes.as_slice()) {
                (None, []) => Some("release".to_string()),
                (Some(selection), []) => Some(format!("release sel {selection}")),
                (None, attrs) => Some(format!("release attr {}", format_attributes(attrs))),
                (Some(selection), attrs) => Some(format!(
                    "release fix {selection} attr {}",
                    format_attributes(attrs)
                )),
            },
            ProgrammerCommand::StoreCue {
                sequence_id,
                cue_id,
                part_id,
                mode,
                label: _,
            } => match part_id {
                StoreCuePartId::Exact(0) => match cue_id {
                    StoreCueId::Exact(cue_id) => Some(format!(
                        "store cue {}.{}{}",
                        sequence_id,
                        cue_id,
                        format_store_mode(*mode)
                    )),
                    StoreCueId::Next => Some(format!(
                        "store cue {}.{}",
                        sequence_id,
                        format_store_mode(*mode)
                    )),
                },
                StoreCuePartId::Exact(part_id) => match cue_id {
                    StoreCueId::Exact(cue_id) => Some(format!(
                        "store cue {}.{}p{}{}",
                        sequence_id,
                        cue_id,
                        part_id,
                        format_store_mode(*mode)
                    )),
                    StoreCueId::Next => None,
                },
                StoreCuePartId::Next => match cue_id {
                    StoreCueId::Exact(cue_id) => Some(format!(
                        "store cue {}.{}p{}",
                        sequence_id,
                        cue_id,
                        format_store_mode(*mode)
                    )),
                    StoreCueId::Next => None,
                },
            },
            ProgrammerCommand::RecallCue {
                sequence_id,
                cue_id,
                part_id,
                select,
            } => {
                let select_flag = if *select { " /select" } else { "" };
                if *part_id == 0 {
                    Some(format!(
                        "recall cue {}.{}{}",
                        sequence_id, cue_id, select_flag
                    ))
                } else {
                    Some(format!(
                        "recall cue {}.{}p{}{}",
                        sequence_id, cue_id, part_id, select_flag
                    ))
                }
            }
            ProgrammerCommand::StoreGroup { group_id, label: _ } => {
                Some(format!("store group {group_id}"))
            }
            ProgrammerCommand::StoreBlueprint {
                blueprint_id,
                filter,
            } => {
                if !filter.is_empty() {
                    return None;
                }

                Some(format!("store blueprint {blueprint_id}"))
            }
            ProgrammerCommand::AddProgrammerInstruction { .. }
            | ProgrammerCommand::AddProgrammerInstructionWithActiveSelection(_)
            | ProgrammerCommand::ApplyAttributeOperations { .. }
            | ProgrammerCommand::SetProgrammerSelection(_)
            | ProgrammerCommand::SetProgrammerSpatialSelection(_)
            | ProgrammerCommand::AddProgrammerSelection(_)
            | ProgrammerCommand::RemoveProgrammerSelection(_) => None,
        }
    }
}
