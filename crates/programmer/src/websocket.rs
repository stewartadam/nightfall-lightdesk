// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for programmer commands.
//!
//! This module handles self-registration with the websocket infrastructure and
//! owns all programmer-related websocket forwarding logic.

use std::collections::HashMap;

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_cues::prelude::CueInstruction;
use nightfall_desk::prelude::BlueprintDefinitionChange;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_selection::filter_existing_selection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_with::DisplayFromStr;
use uuid::Uuid;

use crate::action_model::{ProgrammerAction, UserCommand};
use crate::events::ProgrammerCommand;
use crate::prelude::Programmer;
use crate::undo::RestoreProgrammerState;

/// Resolved values and Blueprint provenance collected for one fixture element.
type ElementAssertionMaps = (
    HashMap<Attribute, ValueSource>,
    HashMap<Attribute, OutboundBlueprintValueSource>,
);

/// Per-element parameter values for a single fixture element in the programmer
#[serde_with::serde_as]
#[typeshare::typeshare]
#[derive(Clone, Debug, Serialize, Deserialize)]
struct ElementParameterValues {
    /// Contains the attributes for this fixture element
    #[typeshare(serialized_as = "Record<String, ValueSource>")]
    #[serde_as(as = "HashMap<DisplayFromStr, _>")]
    parameters: HashMap<Attribute, ValueSource>,
    /// Live Blueprint provenance for attributes currently won by a referenced row.
    #[typeshare(serialized_as = "Record<String, OutboundBlueprintValueSource>")]
    #[serde_as(as = "HashMap<DisplayFromStr, _>")]
    blueprint_sources: HashMap<Attribute, OutboundBlueprintValueSource>,
}

/// Operator-facing identity retained alongside a materialized Blueprint value.
#[typeshare::typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct OutboundBlueprintValueSource {
    /// Stable identity used by the authored programmer instruction.
    #[serde(with = "nightfall::serde_uuid_simple")]
    blueprint_uid: Uuid,
    /// Current mutable numeric address shown to the operator.
    blueprint_id: u32,
    /// Current mutable label shown to the operator.
    blueprint_label: String,
    /// Future-looking selector retained by the live application.
    selector: BlueprintSelector,
}

/// Outbound programmer state for a fixture (contains per-element parameter values)
#[typeshare::typeshare]
#[derive(Clone, Debug, Serialize, Deserialize)]
struct OutboundProgrammerElementState {
    /// Unique ID of the fixture this state applies to
    #[serde(with = "nightfall::serde_uuid_simple")]
    fixture_uid: Uuid,
    /// Contains the parameter values for each fixture element (indexed by element number, 0-based)
    parameters: Vec<ElementParameterValues>,
}

/// Websocket payload that publishes the programmer's resolved spatial selection.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
struct OutboundProgrammerSpatialSelection {
    selection: SpatialSelection,
    resolved: ResolvedSelection,
}

/// Wrapper for serializing programmer messages with WsOutbound-compatible format
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
#[allow(clippy::enum_variant_names)]
enum ProgrammerWsMessage {
    /// Adapts the internal state to a fixture UID-keyed map of parameter values
    ProgrammerState(Vec<OutboundProgrammerElementState>),
    /// Current programmer selection (fixture UIDs). Has a dedicated
    /// command instead of forwarding ProgrammerCommand::SetProgrammerSelection
    /// because the UI cannot resolve a SelectionExpr for now.
    ProgrammerSelection(Vec<String>),
    /// Current programmer spatial selection and its resolved index view.
    ProgrammerSpatialSelection(OutboundProgrammerSpatialSelection),
    /// Programmer commands for reactive UI handling.
    #[allow(dead_code)]
    ProgrammerCommand,
}

/// Deserialize and dispatch ProgrammerCommand from JSON.
///
/// This function is registered with the `CommandDeserializerRegistry` to handle
/// incoming programmer commands from the UI. It deserializes the JSON payload into a
/// `ProgrammerCommand` and sends it as a typed event for domain handlers.
pub fn deserialize_programmer_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: ProgrammerCommand = serde_json::from_value(json)
        .map_err(|e| format!("Failed to parse ProgrammerCommand: {}", e))?;

    // Route through PendingCommandBuffer so planning + undo capture are applied
    // consistently for websocket and CLI command ingress paths.
    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));

    Ok(())
}

/// Deserializes a high-level user command resubmitted after operator approval.
pub fn deserialize_user_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: UserCommand = serde_json::from_value(json)
        .map_err(|error| format!("Failed to parse UserCommand: {error}"))?;
    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));
    Ok(())
}

fn should_broadcast_programmer_update(command: &ProgrammerCommand) -> bool {
    matches!(
        command,
        ProgrammerCommand::ClearProgrammer
            | ProgrammerCommand::ClearProgrammerSelection
            | ProgrammerCommand::ClearProgrammerValues
            | ProgrammerCommand::ReleaseProgrammerValues { .. }
            | ProgrammerCommand::AddProgrammerInstruction { .. }
            | ProgrammerCommand::AddProgrammerInstructionWithActiveSelection(..)
            | ProgrammerCommand::ApplyAttributeOperations { .. }
            | ProgrammerCommand::SetProgrammerSelection(..)
            | ProgrammerCommand::SetProgrammerSpatialSelection(..)
            | ProgrammerCommand::AddProgrammerSelection(..)
            | ProgrammerCommand::RemoveProgrammerSelection(..)
            | ProgrammerCommand::RecallCue { .. }
    )
}

/// Returns whether the active programmer depends on a changed Blueprint definition.
fn programmer_references_blueprint(programmer: &Programmer, blueprint_uid: Uuid) -> bool {
    programmer
        .active_instructions()
        .iter()
        .any(|(_, instruction)| {
            instruction
                .cue_instruction
                .blueprint_application
                .as_ref()
                .is_some_and(|application| application.blueprint_uid == blueprint_uid)
        })
}

/// Resolves direct values or the current values behind one live Blueprint application.
fn resolved_programmer_instruction_values(
    instruction: &CueInstruction,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
) -> (
    HashMap<Attribute, ValueSource>,
    Option<OutboundBlueprintValueSource>,
) {
    let Some(application) = &instruction.blueprint_application else {
        return (instruction.values.clone(), None);
    };
    let Some(provider) = blueprint_data_provider else {
        tracing::warn!(
            blueprint_uid = %application.blueprint_uid,
            "Programmer state could not resolve a Blueprint without its provider"
        );
        return (HashMap::new(), None);
    };
    provider
        .get(application.blueprint_uid)
        .map(|blueprint| {
            (
                blueprint.selected_values(&application.selector),
                Some(OutboundBlueprintValueSource {
                    blueprint_uid: blueprint.identifiers.uid,
                    blueprint_id: blueprint.identifiers.id,
                    blueprint_label: blueprint.identifiers.label.clone(),
                    selector: application.selector.clone(),
                }),
            )
        })
        .unwrap_or_else(|_| {
            tracing::warn!(
                blueprint_uid = %application.blueprint_uid,
                "Programmer state references a missing Blueprint"
            );
            (HashMap::new(), None)
        })
}

/// Forward programmer commands to the UI for reactive handling.
///
/// This system reads programmer command events and broadcasts relevant ones
/// to connected clients for immediate UI updates.
pub fn forward_programmer_commands(
    mut events: MessageReader<CommandEnvelope<ProgrammerCommand>>,
    mut restore_events: MessageReader<EngineActionEnvelope<RestoreProgrammerState>>,
    mut action_events: MessageReader<EngineActionEnvelope<ProgrammerAction>>,
    mut blueprint_changes: MessageReader<BlueprintDefinitionChange>,
    programmer: Res<Programmer>,
    blueprint_data_provider: Option<Res<DataProvider<Blueprint>>>,
    spatial_selection_resolver: SpatialSelectionResolver,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    broadcaster: Res<ClientEventSink>,
) {
    let mut should_update = programmer.is_changed();

    for event in events.read() {
        // Any programmer command that modifies state should trigger an update
        if should_broadcast_programmer_update(&event.command) {
            tracing::debug!("forward_programmer_commands: observed ProgrammerCommand");
            should_update = true;
        }
    }

    for event in action_events.read() {
        if matches!(
            event.action,
            ProgrammerAction::ClearSelection
                | ProgrammerAction::ClearValues { .. }
                | ProgrammerAction::ReleaseValues { .. }
        ) {
            tracing::debug!("forward_programmer_commands: observed ProgrammerAction");
            should_update = true;
        }
    }

    // RestoreProgrammerState (from undo) also triggers update
    for _event in restore_events.read() {
        tracing::debug!("forward_programmer_commands: observed RestoreProgrammerState");
        should_update = true;
    }

    for change in blueprint_changes.read() {
        if programmer_references_blueprint(&programmer, change.uid) {
            tracing::debug!(blueprint_uid=%change.uid, "forward_programmer_commands: observed dependent Blueprint change");
            should_update = true;
        }
    }

    // Send update notification once after processing all events
    if should_update {
        // FIXME: This is what we should be doing:

        // tracing::trace!("Forwarding programmer state change to UI");
        // broadcaster.publish(
        //     DISCRIMINATOR_NON_DROPPABLE,
        //     &ProgrammerWsMessage::ProgrammerCommand,
        // );

        tracing::debug!("Sending programmer state due to programmer command");
        send_programmer(
            &programmer,
            &spatial_selection_resolver,
            &fixture_data_provider,
            blueprint_data_provider.as_deref(),
            &broadcaster,
        );
        send_programmer_selection(&programmer, &spatial_selection_resolver, &broadcaster);
    }
}

/// Send the current programmer state to websocket clients
pub fn send_programmer(
    programmer: &Res<Programmer>,
    selection_resolver: &SpatialSelectionResolver,
    fixture_data_provider: &Res<FixtureDataProviderExt>,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
    broadcaster: &Res<ClientEventSink>,
) {
    // Map of fixture_uid -> element_index (0-based) -> attributes
    let mut programmer_state: HashMap<Uuid, HashMap<usize, ElementAssertionMaps>> = HashMap::new();

    // Get instructions from the active programmer buffer
    let instructions = programmer.active_instructions();

    for (_instruction_id, instruction) in instructions.iter() {
        let (attribute_map, blueprint_source) = resolved_programmer_instruction_values(
            &instruction.cue_instruction,
            blueprint_data_provider,
        );
        if attribute_map.is_empty() {
            continue;
        }
        let resolved_selection = filter_existing_selection(
            &selection_resolver
                .resolve(&instruction.selection)
                .into_value(),
            fixture_data_provider.as_ref(),
        );
        for fixture_ref in resolved_selection.canonical_fixtures() {
            // Determine which element this instruction targets
            let element_index = fixture_ref.index.map(|i| (i - 1) as usize).unwrap_or(0);

            // Store per-element attributes
            let (parameters, blueprint_sources) = programmer_state
                .entry(fixture_ref.fixture_uid)
                .or_default()
                .entry(element_index)
                .or_default();
            for (attribute, value) in &attribute_map {
                parameters.insert(attribute.clone(), value.clone());
                if let Some(source) = &blueprint_source {
                    blueprint_sources.insert(attribute.clone(), source.clone());
                } else {
                    blueprint_sources.remove(attribute);
                }
            }
        }
    }

    // Build per-fixture outbound state with per-element arrays
    let programmer_state_vec: Vec<OutboundProgrammerElementState> = programmer_state
        .iter()
        .map(|(fixture_uid, element_map)| {
            // Get the fixture to know how many elements it has
            let fixture = fixture_data_provider.inner.get(*fixture_uid);
            let element_count = fixture.map(|f| f.elements.len()).unwrap_or(1);

            // Build per-element parameter arrays, filling gaps with empty maps
            let mut parameters: Vec<ElementParameterValues> = Vec::with_capacity(element_count);
            for element_index in 0..element_count {
                let (element_params, blueprint_sources) =
                    element_map.get(&element_index).cloned().unwrap_or_default();
                parameters.push(ElementParameterValues {
                    parameters: element_params,
                    blueprint_sources,
                });
            }

            OutboundProgrammerElementState {
                fixture_uid: *fixture_uid,
                parameters,
            }
        })
        .collect();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &ProgrammerWsMessage::ProgrammerState(programmer_state_vec),
    );
    tracing::trace!("Sending programmer state to websocket clients");
}

/// Send the current programmer selection (active fixture UIDs) to websocket clients
pub fn send_programmer_selection(
    programmer: &Res<Programmer>,
    spatial_selection_resolver: &SpatialSelectionResolver,
    broadcaster: &Res<ClientEventSink>,
) {
    let selection = programmer.active_spatial_selection();
    let resolved = spatial_selection_resolver.resolve(&selection).into_value();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &ProgrammerWsMessage::ProgrammerSelection(programmer_selection_uids(&resolved)),
    );

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &ProgrammerWsMessage::ProgrammerSpatialSelection(OutboundProgrammerSpatialSelection {
            selection: selection.clone(),
            resolved,
        }),
    );
}

/// Builds the legacy fixture UID selection list from the fully resolved spatial selection.
fn programmer_selection_uids(resolved: &ResolvedSelection) -> Vec<String> {
    let resolved_uids = resolved
        .canonical_fixtures()
        .iter()
        .map(|fixture_ref| fixture_ref.fixture_uid.simple().to_string());

    let mut seen = std::collections::HashSet::new();
    resolved_uids
        .filter(|uid| seen.insert(uid.clone()))
        .collect()
}

/// Handle ResyncState by sending full programmer state and selection
pub fn handle_resync_state(
    mut events: MessageReader<ResyncRequested>,
    programmer: Res<crate::resources::Programmer>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    blueprint_data_provider: Option<Res<DataProvider<Blueprint>>>,
    spatial_selection_resolver: SpatialSelectionResolver,
    broadcaster: Res<ClientEventSink>,
) {
    let should_resync = events.read().next().is_some();

    if !should_resync {
        return;
    }

    send_programmer(
        &programmer,
        &spatial_selection_resolver,
        &fixture_data_provider,
        blueprint_data_provider.as_deref(),
        &broadcaster,
    );
    send_programmer_selection(&programmer, &spatial_selection_resolver, &broadcaster);
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use nightfall::prelude::*;
    use nightfall_cues::prelude::{BoundCueInstruction, CueInstruction};
    use nightfall_dmx::prelude::{Attribute, ParameterValue};
    use nightfall_engine::prelude::DataProvider;
    use uuid::Uuid;

    use super::OutboundBlueprintValueSource;
    use super::programmer_references_blueprint;
    use super::programmer_selection_uids;
    use super::resolved_programmer_instruction_values;
    use super::should_broadcast_programmer_update;
    use crate::events::ProgrammerCommand;
    use crate::prelude::Programmer;

    #[test]
    fn recall_cue_triggers_programmer_broadcast() {
        assert!(should_broadcast_programmer_update(
            &ProgrammerCommand::RecallCue {
                sequence_id: 1,
                cue_id: 1,
                part_id: 0,
                select: false,
            }
        ));
    }

    #[test]
    fn blueprint_application_triggers_programmer_broadcast() {
        assert!(should_broadcast_programmer_update(
            &ProgrammerCommand::ApplyAttributeOperations {
                selection: None,
                operations: vec![],
                transitions: Default::default(),
                transitions_by_attribute: Default::default(),
            }
        ));
    }

    /// Verifies programmer snapshots publish the current values behind a live Blueprint row.
    #[test]
    fn referenced_programmer_values_are_resolved_for_websocket_state() {
        let blueprint_uid = Uuid::new_v4();
        let mut blueprints = DataProvider::<Blueprint>::default();
        blueprints
            .add(Blueprint {
                identifiers: Identifiers {
                    id: 5,
                    uid: blueprint_uid,
                    label: "Blue".to_owned(),
                },
                values: HashMap::from([(
                    Attribute::Blue,
                    ValueSource::Inline(ParameterValue::Absolute { value: 128.0 }),
                )]),
                ..Default::default()
            })
            .expect("Blueprint should be insertable");
        let instruction = CueInstruction {
            blueprint_application: Some(BlueprintApplication {
                blueprint_uid,
                selector: BlueprintSelector::Category(Attribute::Blue.category()),
            }),
            ..Default::default()
        };

        let (values, source) =
            resolved_programmer_instruction_values(&instruction, Some(&blueprints));

        assert_eq!(values.len(), 1);
        assert!(values.contains_key(&Attribute::Blue));
        assert_eq!(
            source,
            Some(OutboundBlueprintValueSource {
                blueprint_uid,
                blueprint_id: 5,
                blueprint_label: "Blue".to_owned(),
                selector: BlueprintSelector::Category(Attribute::Blue.category()),
            })
        );
    }

    /// Verifies Blueprint definition changes rebroadcast only dependent programmer state.
    #[test]
    fn blueprint_change_matches_dependent_programmer_reference() {
        let blueprint_uid = Uuid::new_v4();
        let mut programmer = Programmer::default();
        programmer.add_instruction(BoundCueInstruction {
            selection: SpatialSelection::default(),
            cue_instruction: CueInstruction {
                blueprint_application: Some(BlueprintApplication {
                    blueprint_uid,
                    selector: BlueprintSelector::All,
                }),
                ..Default::default()
            },
        });

        assert!(programmer_references_blueprint(&programmer, blueprint_uid));
        assert!(!programmer_references_blueprint(
            &programmer,
            Uuid::new_v4()
        ));
    }

    #[test]
    fn store_cue_does_not_trigger_programmer_broadcast() {
        assert!(!should_broadcast_programmer_update(
            &ProgrammerCommand::StoreCue {
                sequence_id: 1,
                cue_id: crate::events::StoreCueId::Exact(1),
                part_id: crate::events::StoreCuePartId::Exact(0),
                mode: crate::events::StoreMode::Replace,
                label: None,
            }
        ));
    }

    /// Verifies the legacy UID list is derived from the spatially filtered canonical selection.
    #[test]
    fn programmer_selection_uids_uses_resolved_canonical_subset() {
        let first = FixtureRef {
            fixture_uid: Uuid::from_u128(1),
            index: None,
        };
        let second = FixtureRef {
            fixture_uid: Uuid::from_u128(2),
            index: None,
        };
        let resolved =
            ResolvedSelection::new(vec![first.clone(), second.clone(), first], Vec::new(), None);

        assert_eq!(
            programmer_selection_uids(&resolved),
            vec![
                Uuid::from_u128(1).simple().to_string(),
                Uuid::from_u128(2).simple().to_string()
            ],
        );
    }
}
