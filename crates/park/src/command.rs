// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Commands that park and unpark fixture parameters, and the handler that applies them.

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use moonshine_kind::Instance;
use nightfall::prelude::*;
use nightfall_dmx::prelude::{Attribute, ParameterDmxValue, ParameterValue};
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_programming::prelude::Programmer;
use nightfall_selection_runtime::SpatialSelectionResolver;
use serde::{Deserialize, Serialize};

use crate::state::{ParameterKey, ParkedParameter, ParkedParameters};

/// User commands that park and unpark fixture parameters.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum ParkCommand {
    /// Park the selected parameters at a value, or at the value each one outputs right now.
    Park {
        /// Fixtures to park, or `None` for the programmer's active selection.
        selection: Option<SpatialSelection>,
        /// Attributes to park on those fixtures, or empty for every parameter.
        attributes: Vec<Attribute>,
        /// Value to park at, resolved per parameter like a programmer value, or `None` to park
        /// at the current output.
        #[serde(default)]
        value: Option<ParameterValue>,
    },
    /// Unpark the selected parameters so they follow playback again.
    Unpark {
        /// Fixtures to unpark, or `None` for the programmer's active selection.
        selection: Option<SpatialSelection>,
        /// Attributes to unpark on those fixtures, or empty for every parameter.
        attributes: Vec<Attribute>,
    },
    /// Unpark exactly these parameters.
    UnparkParameters(Vec<ParameterKey>),
    /// Unpark every parked parameter.
    UnparkAll,
    /// Replace every parked parameter with these entries (used by undo).
    RestoreParked(Vec<ParkedParameter>),
}

impl IngressCommand for ParkCommand {}

/// Reads what a park command needs to turn a selection into parameters and their outputs.
#[derive(SystemParam)]
pub struct ParkTargetResolver<'w, 's> {
    programmer: Res<'w, Programmer>,
    selection_resolver: SpatialSelectionResolver<'w>,
    fixtures: Res<'w, FixtureDataProviderExt>,
    parameters: Query<'w, 's, &'static Parameter>,
}

impl ParkTargetResolver<'_, '_> {
    /// Resolves a selection, or the active selection when `selection` is `None`, to the patched
    /// parameters matching `attributes` (every parameter when empty).
    ///
    /// An `Intensity` request on an element without an intensity parameter matches its virtual
    /// intensity, the same fallback the programmer uses.
    fn parameters(
        &self,
        selection: Option<&SpatialSelection>,
        attributes: &[Attribute],
    ) -> Result<Vec<(ParameterKey, Instance<Parameter>)>, CommandError> {
        let active;
        let selection = match selection {
            Some(selection) => selection,
            None => {
                active = self.programmer.active_spatial_selection();
                &active
            }
        };
        if selection.is_empty() {
            return Err(CommandError::new(
                "park.selection_empty",
                "Select fixtures to park or unpark",
            ));
        }
        let resolved = self.selection_resolver.resolve(selection).into_value();
        let index = self.fixtures.parameter_index();
        let mut targets = Vec::new();
        for fixture_ref in resolved.canonical_fixtures() {
            for element in self.fixtures.element_refs(fixture_ref).unwrap_or_default() {
                if attributes.is_empty() {
                    targets.extend(index.element_parameters(&element).iter().map(
                        |(attribute, parameter)| {
                            let key = ParameterKey {
                                element: element.clone(),
                                attribute: attribute.clone(),
                            };
                            (key, *parameter)
                        },
                    ));
                    continue;
                }
                for requested in attributes {
                    if let Some((attribute, parameter)) =
                        index.parameter_for_logical_attribute(&element, requested)
                    {
                        let key = ParameterKey {
                            element: element.clone(),
                            attribute: attribute.clone(),
                        };
                        targets.push((key, parameter));
                    }
                }
            }
        }
        targets.sort_by(|(left, _), (right, _)| left.cmp(right));
        targets.dedup_by(|(left, _), (right, _)| left == right);
        Ok(targets)
    }

    /// Returns the logical value to park a parameter at: `value` resolved against the
    /// parameter's range and clamped to it, or the value the parameter outputs now, after every
    /// output stage.
    fn park_value(
        &self,
        parameter: Instance<Parameter>,
        value: Option<&ParameterValue>,
    ) -> Option<ParameterDmxValue> {
        let parameter = self.parameters.get(parameter.entity()).ok()?;
        Some(match value {
            Some(value) => parameter.resolve_value(value).clamp(
                parameter.metadata.logical_min(),
                parameter.metadata.logical_max(),
            ),
            None => parameter.values.current_value,
        })
    }
}

/// Applies park commands to the parked set and finishes each command.
pub fn handle_park_commands(
    mut events: MessageReader<CommandEnvelope<ParkCommand>>,
    mut parked: ResMut<ParkedParameters>,
    resolver: ParkTargetResolver,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let response = match apply_park_command(&event.command, &mut parked, &resolver) {
            Ok(None) => responder.succeed(event.command_id),
            Ok(Some(notice)) => responder
                .notice(event.command_id, NoticeLevel::Info, notice)
                .and_then(|()| responder.succeed(event.command_id)),
            Err(error) => responder.fail(event.command_id, error),
        };
        if let Err(error) = response {
            tracing::error!(command_id = %event.command_id, %error, "park_command_completion_failed");
        }
    }
}

/// Applies one park command, returning a notice for a command that changed nothing.
fn apply_park_command(
    command: &ParkCommand,
    parked: &mut ResMut<ParkedParameters>,
    resolver: &ParkTargetResolver,
) -> Result<Option<String>, CommandError> {
    match command {
        ParkCommand::Park {
            selection,
            attributes,
            value,
        } => {
            let targets = resolver.parameters(selection.as_ref(), attributes)?;
            if targets.is_empty() {
                return Err(CommandError::new(
                    "park.no_parameters",
                    "The selection has no matching parameters to park",
                ));
            }
            for (key, parameter) in targets {
                if let Some(value) = resolver.park_value(parameter, value.as_ref()) {
                    parked.park(key, value);
                }
            }
            Ok(None)
        }
        ParkCommand::Unpark {
            selection,
            attributes,
        } => {
            let targets = resolver.parameters(selection.as_ref(), attributes)?;
            Ok(unpark_keys(parked, targets.into_iter().map(|(key, _)| key)))
        }
        ParkCommand::UnparkParameters(keys) => Ok(unpark_keys(parked, keys.iter().cloned())),
        ParkCommand::UnparkAll => {
            if parked.is_empty() {
                return Ok(Some("Nothing is parked".to_string()));
            }
            parked.clear();
            Ok(None)
        }
        ParkCommand::RestoreParked(entries) => {
            let restored = ParkedParameters::from_entries(entries.iter().cloned());
            if **parked != restored {
                **parked = restored;
            }
            Ok(None)
        }
    }
}

/// Unparks `keys`, returning a notice when none of them was parked.
///
/// The parked set is only borrowed mutably once something is parked, so a no-op unpark leaves
/// it unchanged for change detection.
fn unpark_keys(
    parked: &mut ResMut<ParkedParameters>,
    keys: impl IntoIterator<Item = ParameterKey>,
) -> Option<String> {
    let keys: Vec<_> = keys
        .into_iter()
        .filter(|key| parked.value(key).is_some())
        .collect();
    if keys.is_empty() {
        return Some("Nothing in the selection is parked".to_string());
    }
    for key in &keys {
        parked.unpark(key);
    }
    None
}
