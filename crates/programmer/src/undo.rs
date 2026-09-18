// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo/redo implementations for programmer commands.

use nightfall::prelude::*;
use nightfall_cues::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::prelude::ProgrammerCommand;
use crate::resources::{Programmer, ProgrammerMode, RecalledCueTimingDefaults};

/// Captures the complete state of a programmer for restoration.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
pub struct RestoreProgrammerState {
    /// Live mode instructions
    pub live_instructions: Vec<(Uuid, BoundCueInstruction)>,
    /// Blind mode instructions
    pub blind_instructions: Vec<(Uuid, BoundCueInstruction)>,
    /// Current programmer mode
    pub mode: ProgrammerMode,
    /// Active selection expression
    pub active_selection: SpatialSelection,
    /// Cue-level timing defaults retained from the last recalled cue or cue part.
    pub recalled_cue_timing_defaults: Option<RecalledCueTimingDefaults>,
    /// Split-row transition anchor aliases.
    pub transition_anchor_aliases: std::collections::HashMap<Uuid, Uuid>,
}

/// Command to remove a programmer instruction by UUID.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
pub struct RemoveProgrammerInstructionByUuid {
    /// UUID of the instruction to remove
    pub uuid: Uuid,
}

impl EngineAction for RestoreProgrammerState {}

impl EngineAction for RemoveProgrammerInstructionByUuid {}

/// Captures the complete programmer state that undo restoration needs.
fn capture_restore_programmer_state(programmer: &Programmer) -> RestoreProgrammerState {
    let live: Vec<_> = programmer
        .live_instructions
        .iter()
        .map(|(uuid, instr)| (*uuid, instr.clone()))
        .collect();
    let blind: Vec<_> = programmer
        .blind_instructions
        .iter()
        .map(|(uuid, instr)| (*uuid, instr.clone()))
        .collect();

    RestoreProgrammerState {
        live_instructions: live,
        blind_instructions: blind,
        mode: programmer.mode,
        active_selection: programmer.active_selection.clone(),
        recalled_cue_timing_defaults: programmer.recalled_cue_timing_defaults.clone(),
        transition_anchor_aliases: programmer.transition_anchor_aliases.clone(),
    }
}

impl UndoableOperation for RestoreProgrammerState {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        // Inverse of restore is to capture the current state before restoring
        let programmer = ctx.world.resource::<Programmer>();
        Some(Box::new(capture_restore_programmer_state(programmer)))
    }

    fn description(&self) -> String {
        "Restore Programmer".to_string()
    }
}

impl UndoableOperation for RemoveProgrammerInstructionByUuid {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let programmer = ctx.world.resource::<Programmer>();

        if programmer
            .live_instructions
            .iter()
            .any(|(uuid, _)| *uuid == self.uuid)
            || programmer
                .blind_instructions
                .iter()
                .any(|(uuid, _)| *uuid == self.uuid)
        {
            Some(Box::new(capture_restore_programmer_state(programmer)))
        } else {
            None
        }
    }

    fn description(&self) -> String {
        "Remove Instruction".to_string()
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::prelude::*;
    use bevy_ecs::prelude::Messages;
    use bevy_ecs::prelude::World;
    use nightfall::prelude::{
        Axis, PartialTransition, SelectionExpr, SpatialClause, SpatialSelection, TransitionMode,
    };
    use nightfall_cues::prelude::{BoundCueInstruction, CueInstruction};
    use nightfall_dmx::prelude::AttributeCategory;
    use uuid::Uuid;

    use super::*;
    use crate::events::{handle_remove_instruction_events, handle_undo_events};

    /// Installs the command lifecycle resources required by action handlers.
    fn init_command_lifecycle(app: &mut App) {
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.add_message::<OperationResult<(), CommandError>>();
    }

    fn spatial_selection_with_clause() -> SpatialSelection {
        SpatialSelection {
            source: SelectionExpr::default(),
            clauses: vec![SpatialClause::Mirror(Axis::Y)],
            union: Vec::new(),
        }
    }

    #[test]
    fn remove_instruction_inverse_restores_full_spatial_state() {
        let mut world = World::new();
        let mut programmer = Programmer::default();
        let instruction_id = Uuid::new_v4();
        let spatial_selection = spatial_selection_with_clause();

        programmer.live_instructions.insert(
            instruction_id,
            BoundCueInstruction {
                selection: spatial_selection.clone(),
                cue_instruction: CueInstruction::default(),
            },
        );
        programmer.active_selection = spatial_selection.clone();
        world.insert_resource(programmer);

        let inverse = RemoveProgrammerInstructionByUuid {
            uuid: instruction_id,
        }
        .inverse(&UndoContext { world: &world })
        .expect("existing instruction should produce an inverse");

        let restore = inverse
            .as_any()
            .downcast_ref::<RestoreProgrammerState>()
            .expect("remove inverse should restore full programmer state");

        assert_eq!(restore.live_instructions.len(), 1);
        assert_eq!(restore.live_instructions[0].0, instruction_id);
        assert_eq!(
            restore.live_instructions[0].1.selection, spatial_selection,
            "remove undo should preserve stored spatial clauses",
        );
        assert_eq!(
            restore.active_selection.clauses,
            vec![SpatialClause::Mirror(Axis::Y)],
            "remove undo should preserve active spatial selection clauses",
        );
    }

    #[test]
    fn remove_instruction_inverse_restores_recalled_cue_timing_defaults() {
        let mut world = World::new();
        let mut programmer = Programmer::default();
        let instruction_id = Uuid::new_v4();

        programmer.live_instructions.insert(
            instruction_id,
            BoundCueInstruction {
                selection: SpatialSelection::default(),
                cue_instruction: CueInstruction::default(),
            },
        );
        programmer.set_recalled_cue_timing_defaults(
            PartialTransition {
                fade_in: Some(TransitionMode::Fixed(std::time::Duration::from_secs(5))),
                ..Default::default()
            },
            Default::default(),
        );
        world.insert_resource(programmer);

        let inverse = RemoveProgrammerInstructionByUuid {
            uuid: instruction_id,
        }
        .inverse(&UndoContext { world: &world })
        .expect("existing instruction should produce an inverse");

        let restore = inverse
            .as_any()
            .downcast_ref::<RestoreProgrammerState>()
            .expect("remove inverse should restore full programmer state");

        assert!(
            restore.recalled_cue_timing_defaults.is_some(),
            "remove undo should preserve recalled cue timing defaults",
        );
    }

    #[test]
    fn restore_programmer_state_restores_active_spatial_selection_directly() {
        let mut app = App::new();
        init_command_lifecycle(&mut app);
        app.add_message::<EngineActionEnvelope<RestoreProgrammerState>>();
        app.add_message::<EngineActionEnvelope<CueLifecycleAction>>();
        app.insert_resource(Programmer::default());
        app.add_systems(Update, handle_undo_events);

        let restored_selection = spatial_selection_with_clause();
        app.world_mut()
            .resource_mut::<Messages<EngineActionEnvelope<RestoreProgrammerState>>>()
            .write(EngineActionEnvelope::detached(RestoreProgrammerState {
                live_instructions: Vec::new(),
                blind_instructions: Vec::new(),
                mode: ProgrammerMode::Blind,
                active_selection: restored_selection.clone(),
                recalled_cue_timing_defaults: None,
                transition_anchor_aliases: Default::default(),
            }));

        app.update();

        let programmer = app.world().resource::<Programmer>();
        assert_eq!(
            programmer.active_spatial_selection(),
            restored_selection,
            "restore should keep full spatial selection state instead of dropping clauses",
        );
    }

    #[test]
    fn restore_programmer_state_restores_recalled_cue_timing_defaults() {
        let mut app = App::new();
        init_command_lifecycle(&mut app);
        app.add_message::<EngineActionEnvelope<RestoreProgrammerState>>();
        app.add_message::<EngineActionEnvelope<CueLifecycleAction>>();
        app.insert_resource(Programmer::default());
        app.add_systems(Update, handle_undo_events);

        app.world_mut()
            .resource_mut::<Messages<EngineActionEnvelope<RestoreProgrammerState>>>()
            .write(EngineActionEnvelope::detached(RestoreProgrammerState {
                live_instructions: Vec::new(),
                blind_instructions: Vec::new(),
                mode: ProgrammerMode::Blind,
                active_selection: SpatialSelection::default(),
                recalled_cue_timing_defaults: Some(RecalledCueTimingDefaults {
                    transitions: PartialTransition {
                        fade_in: Some(TransitionMode::Fixed(std::time::Duration::from_secs(5))),
                        ..Default::default()
                    },
                    transitions_by_attribute: Default::default(),
                }),
                transition_anchor_aliases: Default::default(),
            }));

        app.update();

        let programmer = app.world().resource::<Programmer>();
        assert!(
            programmer.recalled_cue_timing_defaults.is_some(),
            "restore should reinstate recalled cue timing defaults",
        );
    }

    #[test]
    fn remove_instruction_event_clears_recalled_defaults_when_programmer_is_empty() {
        let mut app = App::new();
        init_command_lifecycle(&mut app);
        app.add_message::<EngineActionEnvelope<RemoveProgrammerInstructionByUuid>>();
        app.insert_resource(Programmer::default());
        app.add_systems(Update, handle_remove_instruction_events);

        let instruction_id = Uuid::new_v4();
        {
            let mut programmer = app.world_mut().resource_mut::<Programmer>();
            programmer.live_instructions.insert(
                instruction_id,
                BoundCueInstruction {
                    selection: SpatialSelection::default(),
                    cue_instruction: CueInstruction::default(),
                },
            );
            programmer.set_recalled_cue_timing_defaults(
                PartialTransition {
                    fade_in: Some(TransitionMode::Fixed(std::time::Duration::from_secs(5))),
                    ..Default::default()
                },
                Default::default(),
            );
        }

        app.world_mut()
            .resource_mut::<Messages<EngineActionEnvelope<RemoveProgrammerInstructionByUuid>>>()
            .write(EngineActionEnvelope::detached(
                RemoveProgrammerInstructionByUuid {
                    uuid: instruction_id,
                },
            ));
        app.update();

        let programmer = app.world().resource::<Programmer>();
        assert!(
            programmer.recalled_cue_timing_defaults.is_none(),
            "removing the final instruction should clear recalled cue timing defaults",
        );
    }

    /// Verifies multiple restore replays wait independently for nested cue cleanup.
    #[test]
    fn restore_replays_join_nested_cue_cleanup_without_late_count_expansion() {
        let mut app = App::new();
        init_command_lifecycle(&mut app);
        app.add_message::<EngineActionEnvelope<RestoreProgrammerState>>();
        app.add_message::<EngineActionEnvelope<CueLifecycleAction>>();
        app.insert_resource(Programmer::default());
        app.add_systems(Update, handle_undo_events);

        let command_id = CommandId::new();
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register_context(
                command_id,
                command_id.into(),
                CommandOrigin::WebUi,
                ReplyTarget::Detached,
            )
            .expect("undo command should register");
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .expect_completions(command_id, 2)
            .expect("undo should expect both restore replays");

        let first_uid = Uuid::new_v4();
        let second_uid = Uuid::new_v4();
        app.world_mut()
            .resource_mut::<Programmer>()
            .live_instructions
            .insert(first_uid, BoundCueInstruction::default());
        for restored_uid in [second_uid, Uuid::new_v4()] {
            app.world_mut()
                .write_message(EngineActionEnvelope::for_command_context(
                    command_id,
                    command_id.into(),
                    RestoreProgrammerState {
                        live_instructions: vec![(restored_uid, BoundCueInstruction::default())],
                        blind_instructions: Vec::new(),
                        mode: ProgrammerMode::Live,
                        active_selection: SpatialSelection::default(),
                        recalled_cue_timing_defaults: None,
                        transition_anchor_aliases: Default::default(),
                    },
                ));
        }

        app.update();

        let release_operations = app
            .world_mut()
            .resource_mut::<Messages<EngineActionEnvelope<CueLifecycleAction>>>()
            .drain()
            .map(|event| event.operation_id)
            .collect::<Vec<_>>();
        assert_eq!(release_operations.len(), 2);
        assert!(
            app.world_mut()
                .resource_mut::<Messages<CommandResult>>()
                .drain()
                .next()
                .is_none(),
            "restore replays must remain active until nested cleanup finishes",
        );

        app.world_mut()
            .write_message(OperationResult::<(), CommandError>::succeeded(
                release_operations[0],
                (),
            ));
        app.update();
        assert!(
            app.world_mut()
                .resource_mut::<Messages<CommandResult>>()
                .drain()
                .next()
                .is_none(),
            "one nested cleanup must not finish two restore replays",
        );

        app.world_mut()
            .write_message(OperationResult::<(), CommandError>::succeeded(
                release_operations[1],
                (),
            ));
        app.update();
        let results = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect::<Vec<_>>();
        assert!(matches!(
            results.as_slice(),
            [CommandResult {
                command_id: result_command_id,
                outcome: CommandOutcome::Succeeded { output: None },
            }] if *result_command_id == command_id
        ));
    }

    #[test]
    fn set_programmer_selection_inverse_restores_previous_spatial_selection() {
        let mut world = World::new();
        let mut programmer = Programmer::default();
        let previous_selection = spatial_selection_with_clause();
        programmer.active_selection = previous_selection.clone();
        world.insert_resource(programmer);

        let inverse = ProgrammerCommand::SetProgrammerSelection(SelectionExpr::default())
            .inverse(&UndoContext { world: &world })
            .expect("set selection should produce an inverse");

        let restore = inverse
            .as_any()
            .downcast_ref::<ProgrammerCommand>()
            .expect("inverse should be a programmer command");

        match restore {
            ProgrammerCommand::SetProgrammerSpatialSelection(selection) => {
                assert_eq!(
                    selection, &previous_selection,
                    "undo should restore the full previous spatial selection",
                );
            }
            other => panic!("expected SetProgrammerSpatialSelection inverse, got {other:?}"),
        }
    }

    /// Verifies attribute-operation undo snapshots retain live Blueprint identity and selector.
    #[test]
    fn apply_attribute_operations_inverse_preserves_blueprint_references() {
        let blueprint_uid = Uuid::from_u128(500);
        let instruction_uid = Uuid::from_u128(600);
        let application = BlueprintApplication {
            blueprint_uid,
            selector: BlueprintSelector::Category(AttributeCategory::Color),
        };
        let mut programmer = Programmer::default();
        programmer.live_instructions.insert(
            instruction_uid,
            BoundCueInstruction {
                selection: SpatialSelection::default(),
                cue_instruction: CueInstruction {
                    blueprint_application: Some(application.clone()),
                    ..Default::default()
                },
            },
        );
        let mut world = World::new();
        world.insert_resource(programmer);

        let inverse = ProgrammerCommand::ApplyAttributeOperations {
            selection: None,
            operations: Vec::new(),
            transitions: Default::default(),
            transitions_by_attribute: Default::default(),
        }
        .inverse(&UndoContext { world: &world })
        .expect("attribute application should capture an undo snapshot");
        let restore = inverse
            .as_any()
            .downcast_ref::<RestoreProgrammerState>()
            .expect("attribute application inverse should restore programmer state");

        assert_eq!(restore.live_instructions.len(), 1);
        assert_eq!(restore.live_instructions[0].0, instruction_uid);
        assert_eq!(
            restore.live_instructions[0]
                .1
                .cue_instruction
                .blueprint_application,
            Some(application),
        );
    }
}

impl UndoableOperation for ProgrammerCommand {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let programmer = ctx.world.resource::<Programmer>();

        match self {
            ProgrammerCommand::ClearProgrammer => {
                if programmer.active_selection.is_empty() {
                    // Snapshot current state for restoration (clear values)
                    Some(Box::new(capture_restore_programmer_state(programmer)))
                } else {
                    // Inverse is set to previous selection (clear selection)
                    Some(Box::new(ProgrammerCommand::SetProgrammerSpatialSelection(
                        programmer.active_selection.clone(),
                    )))
                }
            }
            ProgrammerCommand::ClearProgrammerSelection => {
                Some(Box::new(ProgrammerCommand::SetProgrammerSpatialSelection(
                    programmer.active_selection.clone(),
                )))
            }
            ProgrammerCommand::ClearProgrammerValues => {
                Some(Box::new(capture_restore_programmer_state(programmer)))
            }
            ProgrammerCommand::ReleaseProgrammerValues { .. } => {
                Some(Box::new(capture_restore_programmer_state(programmer)))
            }
            // AddProgrammerInstruction: capture full state to restore on undo.
            // The UUID is generated at handler time and instructions may merge,
            // so we restore the complete state rather than removing a specific instruction.
            ProgrammerCommand::AddProgrammerInstruction { .. }
            | ProgrammerCommand::AddProgrammerInstructionWithActiveSelection(_)
            | ProgrammerCommand::ApplyAttributeOperations { .. } => {
                Some(Box::new(capture_restore_programmer_state(programmer)))
            }
            ProgrammerCommand::SetProgrammerSelection(_new_selection) => {
                Some(Box::new(ProgrammerCommand::SetProgrammerSpatialSelection(
                    programmer.active_selection.clone(),
                )))
            }
            ProgrammerCommand::SetProgrammerSpatialSelection(_new_selection) => {
                Some(Box::new(ProgrammerCommand::SetProgrammerSpatialSelection(
                    programmer.active_selection.clone(),
                )))
            }
            ProgrammerCommand::AddProgrammerSelection(_selection) => {
                // Inverse is set to previous selection
                Some(Box::new(ProgrammerCommand::SetProgrammerSpatialSelection(
                    programmer.active_selection.clone(),
                )))
            }
            ProgrammerCommand::RemoveProgrammerSelection(_selection) => {
                // Inverse is set to previous selection
                Some(Box::new(ProgrammerCommand::SetProgrammerSpatialSelection(
                    programmer.active_selection.clone(),
                )))
            }
            // These commands delegate to their respective command types, not undoable here
            ProgrammerCommand::StoreCue { .. }
            | ProgrammerCommand::RecallCue { .. }
            | ProgrammerCommand::StoreGroup { .. }
            | ProgrammerCommand::StoreBlueprint { .. } => None,
        }
    }

    fn description(&self) -> String {
        match self {
            ProgrammerCommand::ClearProgrammer => "Clear Programmer".to_string(),
            ProgrammerCommand::ClearProgrammerSelection => "Clear Selection".to_string(),
            ProgrammerCommand::ClearProgrammerValues => "Clear Values".to_string(),
            ProgrammerCommand::ReleaseProgrammerValues { .. } => {
                "Release Programmer Values".to_string()
            }
            ProgrammerCommand::AddProgrammerInstruction { .. } => "Add Instruction".to_string(),
            ProgrammerCommand::AddProgrammerInstructionWithActiveSelection(_) => {
                "Add Instruction".to_string()
            }
            ProgrammerCommand::ApplyAttributeOperations { .. } => {
                "Apply Attribute Operations".to_string()
            }
            ProgrammerCommand::SetProgrammerSelection(_) => "Change Selection".to_string(),
            ProgrammerCommand::SetProgrammerSpatialSelection(_) => {
                "Change Spatial Selection".to_string()
            }
            ProgrammerCommand::AddProgrammerSelection(_) => "Add to Selection".to_string(),
            ProgrammerCommand::RemoveProgrammerSelection(_) => "Remove from Selection".to_string(),
            ProgrammerCommand::StoreCue {
                sequence_id,
                cue_id,
                part_id,
                ..
            } => match part_id {
                crate::events::StoreCuePartId::Exact(0) => match cue_id {
                    crate::events::StoreCueId::Exact(cue_id) => {
                        format!("Store Cue {}.{}", sequence_id, cue_id)
                    }
                    crate::events::StoreCueId::Next => format!("Store Cue {}.", sequence_id),
                },
                crate::events::StoreCuePartId::Exact(part_id) => match cue_id {
                    crate::events::StoreCueId::Exact(cue_id) => {
                        format!("Store Cue {}.{} Part {}", sequence_id, cue_id, part_id)
                    }
                    crate::events::StoreCueId::Next => {
                        format!("Store Cue {}. Next Part {}", sequence_id, part_id)
                    }
                },
                crate::events::StoreCuePartId::Next => match cue_id {
                    crate::events::StoreCueId::Exact(cue_id) => {
                        format!("Store Cue {}.{} Next Part", sequence_id, cue_id)
                    }
                    crate::events::StoreCueId::Next => {
                        format!("Store Cue {}. Next Part", sequence_id)
                    }
                },
            },
            ProgrammerCommand::RecallCue {
                sequence_id,
                cue_id,
                part_id,
                select: _,
            } => {
                if *part_id == 0 {
                    format!("Recall Cue {}.{}", sequence_id, cue_id)
                } else {
                    format!("Recall Cue {}.{} Part {}", sequence_id, cue_id, part_id)
                }
            }
            ProgrammerCommand::StoreGroup { group_id, .. } => format!("Store Group {}", group_id),
            ProgrammerCommand::StoreBlueprint { blueprint_id, .. } => {
                format!("Store Blueprint {}", blueprint_id)
            }
        }
    }
}
