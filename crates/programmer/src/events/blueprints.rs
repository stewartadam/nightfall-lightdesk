// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Blueprint storage, recall, and object-workflow completion.

use bevy_ecs::system::SystemParam;

use super::cues::{write_command_error, write_command_success, write_command_warning};
use super::*;

/// Rebuilds transient programmer dependencies used to protect live Blueprint references.
pub fn rebuild_programmer_blueprint_reference_index(
    programmer: Res<Programmer>,
    mut reference_index: ResMut<BlueprintReferenceIndex>,
) {
    if !programmer.is_changed() {
        return;
    }

    let references = [
        ("live programmer", &programmer.live_instructions),
        ("blind programmer", &programmer.blind_instructions),
    ]
    .into_iter()
    .flat_map(|(description, instructions)| {
        instructions.iter().filter_map(move |(_, instruction)| {
            instruction
                .cue_instruction
                .blueprint_application
                .as_ref()
                .map(|application| (application.blueprint_uid, description.to_owned()))
        })
    })
    .collect::<Vec<_>>();
    reference_index.replace_source("programmer", references);
}

/// Resolves an operator Blueprint address without retaining its mutable ID or label.
fn resolve_blueprint_address(
    provider: &DataProvider<Blueprint>,
    address: &BlueprintAddress,
) -> Result<Blueprint, CommandError> {
    match address {
        BlueprintAddress::Id(id) => provider
            .from_id(*id)
            .map(|blueprint| blueprint.clone())
            .map_err(|_| {
                CommandError::new(
                    "blueprint.not_found",
                    format!("Blueprint {id} was not found"),
                )
            }),
        BlueprintAddress::Label(label) => {
            let normalized = label.trim();
            let mut matches = provider
                .iter()
                .filter(|entry| {
                    entry
                        .identifiers
                        .label
                        .trim()
                        .eq_ignore_ascii_case(normalized)
                })
                .map(|entry| entry.clone())
                .collect::<Vec<_>>();
            matches.sort_by_key(|blueprint| blueprint.identifiers.id);
            match matches.as_slice() {
                [] => Err(CommandError::new(
                    "blueprint.not_found",
                    format!("Blueprint labeled \"{label}\" was not found"),
                )),
                [blueprint] => Ok(blueprint.clone()),
                blueprints => Err(CommandError::new(
                    "blueprint.label_ambiguous",
                    format!(
                        "Blueprint label \"{label}\" matches IDs {}; use a numeric ID",
                        blueprints
                            .iter()
                            .map(|blueprint| blueprint.identifiers.id.to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                )),
            }
        }
    }
}

/// Returns the selector-specific empty-result error required before programmer mutation.
fn empty_blueprint_selector_error(
    blueprint: &Blueprint,
    selector: &BlueprintSelector,
) -> CommandError {
    let (code, target) = match selector {
        BlueprintSelector::Attribute(attribute) => {
            ("blueprint.attribute_missing", attribute.to_string())
        }
        BlueprintSelector::Category(category) => {
            ("blueprint.category_empty", format!("{category:?}"))
        }
        BlueprintSelector::All => ("blueprint.capture_empty", "all attributes".to_string()),
    };
    CommandError::new(
        code,
        format!(
            "Blueprint {} contains no values for {target}",
            blueprint.identifiers.id
        ),
    )
}

/// Expands one selected fixture target to concrete elements for compatibility checks.
fn selected_fixture_elements(
    fixture_ref: &FixtureRef,
    fixture_data_provider: &FixtureDataProviderExt,
) -> Vec<FixtureRef> {
    let Ok(fixture) = fixture_data_provider.inner.get(fixture_ref.fixture_uid) else {
        return Vec::new();
    };
    match fixture_ref.index {
        Some(_) => vec![fixture_ref.clone()],
        None => (1..=fixture.elements.len() as u32)
            .map(|index| FixtureRef {
                fixture_uid: fixture_ref.fixture_uid,
                index: Some(index),
            })
            .collect(),
    }
}

/// Describes a selector for command feedback without exposing serialization details.
fn selector_description(selector: &BlueprintSelector) -> String {
    match selector {
        BlueprintSelector::All => "all attributes".to_owned(),
        BlueprintSelector::Attribute(attribute) => attribute.to_string(),
        BlueprintSelector::Category(category) => format!("{category:?}"),
    }
}

/// Reports selected fixture elements to which the addressed Blueprint cannot apply values.
fn blueprint_compatibility_warnings(
    blueprint: &Blueprint,
    selector: &BlueprintSelector,
    selected_values: &HashMap<Attribute, ValueSource>,
    resolved_selection: &ResolvedSelection,
    fixture_data_provider: &FixtureDataProviderExt,
) -> Vec<String> {
    let mut warnings = Vec::new();
    for selected_target in resolved_selection.canonical_fixtures() {
        for element_ref in selected_fixture_elements(selected_target, fixture_data_provider) {
            let supported = selected_values.keys().any(|attribute| {
                fixture_data_provider
                    .resolve_logical_attribute_for_element(&element_ref, attribute)
                    .is_some()
            });
            if supported {
                continue;
            }

            let (fixture_id, fixture_label) = fixture_data_provider
                .inner
                .get(element_ref.fixture_uid)
                .map(|fixture| (fixture.identifiers.id, fixture.identifiers.label.clone()))
                .unwrap_or_default();
            let element_suffix = element_ref
                .index
                .map(|index| format!(" element {index}"))
                .unwrap_or_default();
            let code = if matches!(selector, BlueprintSelector::Attribute(_)) {
                "blueprint.attribute_unsupported"
            } else {
                "blueprint.no_applicable_values"
            };
            warnings.push(format!(
                "{code}: Blueprint {} \"{}\" {} applies no values to fixture {} \"{}\"{}",
                blueprint.identifiers.id,
                blueprint.identifiers.label,
                selector_description(selector),
                fixture_id,
                fixture_label,
                element_suffix,
            ));
        }
    }
    warnings
}

/// Captures final logical programmer values and rejects fixture-dependent ambiguity.
fn capture_blueprint_values(
    programmer: &Programmer,
    blueprint_data_provider: &DataProvider<Blueprint>,
    spatial_selection_resolver: &SpatialSelectionResolver,
    filter: &[BlueprintSelector],
) -> Result<HashMap<Attribute, ValueSource>, CommandError> {
    let mut values_by_fixture: HashMap<Attribute, HashMap<FixtureRef, ValueSource>> =
        HashMap::new();

    for (_, instruction) in programmer.active_instructions().iter() {
        let resolved = spatial_selection_resolver.resolve(&instruction.selection);
        let logical_values =
            if let Some(application) = &instruction.cue_instruction.blueprint_application {
                let blueprint = blueprint_data_provider
                    .get(application.blueprint_uid)
                    .map_err(|_| {
                        CommandError::new(
                            "blueprint.reference_missing",
                            format!(
                                "Cannot store Blueprint: referenced Blueprint {} is missing",
                                application.blueprint_uid
                            ),
                        )
                    })?;
                blueprint.selected_values(&application.selector)
            } else {
                instruction.cue_instruction.values.clone()
            };

        for (attribute, value) in logical_values {
            let included = filter.is_empty()
                || filter.iter().any(|selector| match selector {
                    BlueprintSelector::All => true,
                    BlueprintSelector::Attribute(selected) => selected == &attribute,
                    BlueprintSelector::Category(category) => attribute.category() == *category,
                });
            if !included {
                continue;
            }
            let fixture_values = values_by_fixture.entry(attribute).or_default();
            for selected_target in resolved.value.canonical_fixtures() {
                for element_ref in selected_fixture_elements(
                    selected_target,
                    spatial_selection_resolver.fixture_data_provider(),
                ) {
                    fixture_values.insert(element_ref, value.clone());
                }
            }
        }
    }

    let mut captured = HashMap::new();
    for (attribute, fixture_values) in values_by_fixture {
        let mut values = fixture_values.values();
        let Some(first) = values.next().cloned() else {
            continue;
        };
        if values.any(|value| value != &first) {
            return Err(CommandError::new(
                "blueprint.capture_conflict",
                format!(
                    "Cannot store Blueprint: {attribute} has different logical values across the selected fixtures"
                ),
            ));
        }
        captured.insert(attribute, first);
    }

    if captured.is_empty() {
        return Err(CommandError::new(
            "blueprint.capture_empty",
            "Cannot store an empty Blueprint",
        ));
    }
    Ok(captured)
}

/// Cohesive state for blueprint store and recall operations.
#[derive(SystemParam)]
pub struct ProgrammerBlueprintState<'w> {
    /// Publishes immediate blueprint recall failures and successes.
    responder: CommandResponder<'w>,
    /// Supplies active instructions and receives recalled blueprint contents.
    programmer: ResMut<'w, Programmer>,
    /// Dispatches blueprint store actions to the owning domain.
    actions: MessageWriter<'w, EngineActionEnvelope<BlueprintAction>>,
    /// Tracks object store actions until their terminal operation results arrive.
    workflows: ResMut<'w, StoreObjectWorkflows>,
    /// Provides existing blueprint definitions for update and recall.
    blueprint_data_provider: Res<'w, DataProvider<Blueprint>>,
    /// Declares the non-spatial selection dependency used by blueprint workflows.
    _selection_resolver: SelectionResolver<'w>,
    /// Resolves active programmer selections before blueprint storage.
    spatial_selection_resolver: SpatialSelectionResolver<'w>,
}

/// Handles events related to blueprints in the programmer
pub fn handle_blueprint_events(
    mut events_reader: MessageReader<CommandEnvelope<ProgrammerCommand>>,
    state: ProgrammerBlueprintState,
) {
    let ProgrammerBlueprintState {
        mut responder,
        mut programmer,
        mut actions,
        mut workflows,
        blueprint_data_provider,
        _selection_resolver,
        spatial_selection_resolver,
    } = state;

    for event in events_reader.read() {
        match &event.command {
            ProgrammerCommand::ApplyAttributeOperations {
                selection,
                operations,
                transitions,
                transitions_by_attribute,
            } => {
                let selection = selection
                    .clone()
                    .unwrap_or_else(|| programmer.active_spatial_selection());
                let resolved_selection = spatial_selection_resolver.resolve(&selection);
                if resolved_selection.value.is_empty() {
                    write_command_error(
                        &mut responder,
                        event.command_id.into(),
                        "programmer.selection_empty",
                        "Cannot apply attributes: no fixtures selected".to_string(),
                    );
                    continue;
                }

                let mut instructions = Vec::new();
                let mut operation_error = None;
                let mut operation_warnings = Vec::new();
                for operation in operations {
                    let (values, blueprint_application) = match &operation.source {
                        ProgrammerAttributeSource::Direct(value) => {
                            let BlueprintSelector::Attribute(attribute) = &operation.target else {
                                operation_error = Some(CommandError::new(
                                    "programmer.attribute_target_invalid",
                                    "Direct values require one logical attribute",
                                ));
                                break;
                            };
                            (HashMap::from([(attribute.clone(), value.clone())]), None)
                        }
                        ProgrammerAttributeSource::Blueprint {
                            address,
                            resolution,
                        } => {
                            let blueprint = match resolve_blueprint_address(
                                &blueprint_data_provider,
                                address,
                            ) {
                                Ok(blueprint) => blueprint,
                                Err(error) => {
                                    operation_error = Some(error);
                                    break;
                                }
                            };
                            let selected_values = blueprint.selected_values(&operation.target);
                            if selected_values.is_empty() {
                                operation_error = Some(empty_blueprint_selector_error(
                                    &blueprint,
                                    &operation.target,
                                ));
                                break;
                            }
                            operation_warnings.extend(blueprint_compatibility_warnings(
                                &blueprint,
                                &operation.target,
                                &selected_values,
                                &resolved_selection.value,
                                spatial_selection_resolver.fixture_data_provider(),
                            ));
                            match resolution {
                                BlueprintResolution::Reference => (
                                    HashMap::new(),
                                    Some(BlueprintApplication {
                                        blueprint_uid: blueprint.identifiers.uid,
                                        selector: operation.target.clone(),
                                    }),
                                ),
                                BlueprintResolution::Absolute => (selected_values, None),
                            }
                        }
                    };
                    instructions.push(BoundCueInstruction {
                        selection: selection.clone(),
                        cue_instruction: CueInstruction {
                            blueprint_application,
                            values,
                            transitions: transitions.clone(),
                            transitions_by_attribute: transitions_by_attribute.clone(),
                            transitions_by_fixture_attribute: Default::default(),
                            color_path_id: None,
                        },
                    });
                }
                if let Some(error) = operation_error {
                    if let Err(response_error) = responder.fail(event.command_id, error) {
                        tracing::error!(%response_error, "blueprint_application_failure_response");
                    }
                    continue;
                }
                for instruction in instructions {
                    programmer.add_instruction(instruction);
                }
                for warning in operation_warnings {
                    write_command_warning(&mut responder, event.command_id.into(), warning);
                }
                write_command_success(&mut responder, event.command_id.into());
            }

            ProgrammerCommand::StoreBlueprint {
                blueprint_id,
                filter,
            } => {
                tracing::debug!("Storing blueprint with ID: {}", blueprint_id);

                let values = match capture_blueprint_values(
                    &programmer,
                    &blueprint_data_provider,
                    &spatial_selection_resolver,
                    filter,
                ) {
                    Ok(values) => values,
                    Err(error) => {
                        if let Err(response_error) = responder.fail(event.command_id, error) {
                            tracing::error!(%response_error, "blueprint_store_failure_response");
                        }
                        continue;
                    }
                };

                // Create or update blueprint
                let blueprint = blueprint_data_provider
                    .from_id(*blueprint_id)
                    .ok()
                    .map(|bp_ref| {
                        let mut bp = (*bp_ref).clone();
                        bp.values = values.clone();
                        bp
                    })
                    .unwrap_or_else(|| Blueprint {
                        identifiers: Identifiers {
                            id: *blueprint_id,
                            uid: uuid::Uuid::new_v4(),
                            label: format!("Blueprint {}", blueprint_id),
                        },
                        values,
                        inclusion_settings: InclusionSettings::default(),
                        references: References::default(),
                    });

                let operation_id = OperationId::new();
                let command_id = event.command_id;
                workflows.commands.insert(operation_id, command_id);
                actions.write(EngineActionEnvelope {
                    operation_id,
                    command_id: Some(command_id),
                    undo_id: Some(event.undo_id),
                    action: BlueprintAction::StoreBlueprint(blueprint),
                });
            }

            _ => {}
        }
    }
}

/// Resumes programmer-owned object-store workflows from desk-domain action results.
pub fn resume_store_object_workflows(
    mut results: MessageReader<OperationResult<(), CommandError>>,
    mut workflows: ResMut<StoreObjectWorkflows>,
    mut responder: CommandResponder,
) {
    for result in results.read() {
        let Some(command_id) = workflows.commands.remove(&result.operation_id) else {
            continue;
        };
        let response = match &result.result {
            Ok(()) => responder.succeed(command_id),
            Err(error) => responder.fail(command_id, error.clone()),
        };
        if let Err(error) = response {
            tracing::error!(%command_id, %error, "object_store_workflow_finish_failed");
        }
    }
}
