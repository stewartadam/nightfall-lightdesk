// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! `log fixture ...`: traces the parameter entity behind one fixture attribute.

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::logging::report_log_command;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

use crate::data_provider_ext::FixtureDataProviderExt;

/// Requests to trace what the engine does with one fixture's values.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum FixtureTraceCommand {
    /// Trace every span about the parameter one fixture attribute resolves to.
    TraceAttribute {
        /// Fixture, and optionally element, to trace.
        fixture_ref: UnresolvedFixtureRef,
        /// Attribute whose parameter is traced.
        attribute: Attribute,
    },
}

impl IngressCommand for FixtureTraceCommand {}

/// Adds a trace filter on the parameter entity a fixture attribute resolves to.
///
/// Fails the command when the fixture, its element, or the attribute does not exist, when the
/// filter cannot be applied, or when the app has no log filter to edit.
pub fn handle_trace_fixture(
    log_config: Option<Res<LogConfig>>,
    data_provider: Res<FixtureDataProviderExt>,
    mut events: MessageReader<CommandEnvelope<FixtureTraceCommand>>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let FixtureTraceCommand::TraceAttribute {
            fixture_ref,
            attribute,
        } = &event.command;
        let outcome = log_config
            .as_deref()
            .ok_or_else(|| {
                (
                    "log.unavailable",
                    "This app has no log filter to change".to_string(),
                )
            })
            .and_then(|log_config| {
                trace_fixture_attribute(log_config, &data_provider, fixture_ref, attribute)
            });
        report_log_command(&mut responder, event.command_id, outcome);
    }
}

/// Resolves the fixture attribute to its parameter entity and adds an `entity` trace matcher.
fn trace_fixture_attribute(
    log_config: &LogConfig,
    data_provider: &FixtureDataProviderExt,
    fixture_ref: &UnresolvedFixtureRef,
    attribute: &Attribute,
) -> Result<(), (&'static str, String)> {
    let fixture = data_provider
        .inner
        .from_id(fixture_ref.fixture_id)
        .map_err(|_| {
            (
                "log.trace_fixture_not_found",
                format!("Fixture {} not found", fixture_ref.fixture_id),
            )
        })?;
    // Default to element 1 if no element index specified
    let element_index = match fixture_ref.element_index {
        Some(index) => index,
        None if fixture.elements.is_empty() => {
            return Err((
                "log.trace_fixture_has_no_elements",
                format!("Fixture {} has no elements", fixture_ref.fixture_id),
            ));
        }
        None => 1,
    };
    let element_ref = FixtureRef {
        fixture_uid: fixture.identifiers.uid,
        index: Some(element_index),
    };
    let parameter = data_provider
        .try_parameter_for_logical_attribute(&element_ref, attribute)
        .ok_or_else(|| {
            (
                "log.trace_attribute_not_found",
                format!(
                    "Fixture {} element {} does not have attribute {:?}",
                    fixture_ref.fixture_id, element_index, attribute
                ),
            )
        })?
        .instance;
    let entity = format!("{}", parameter.entity());
    log_config
        .update_target(|target| {
            target
                .field_matchers
                .insert("entity".to_string(), Some(entity));
        })
        .map_err(|error| {
            (
                "log.trace_filter_failed",
                format!("Failed to apply fixture trace filter: {error}"),
            )
        })
}
