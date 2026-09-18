// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for cue commands.
//!
//! This module handles self-registration with the websocket infrastructure and
//! owns all cue-related websocket forwarding logic.

use bevy_ecs::prelude::*;
use moonshine_kind::InstanceRef;
use nightfall::prelude::ColorPath;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::{FixtureDataProviderExt, Parameter};
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_instances::InstanceOptions;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::CueCommand;
use crate::cue::{Cue, Sequence};
use crate::duration::{CueDurationProfile, CueDurationResolver};
use crate::materialized_sequence::MaterializedSequence;

/// Resolved cue timing profile for UI/status surfaces.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct CueDurationProfileMessage {
    /// Cue definition UID.
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub cue_uid: Uuid,
    /// Operator-facing cue ID.
    pub cue_id: u32,
    /// Resolved duration profile for the cue definition.
    pub profile: CueDurationProfile,
}

/// Backend-authored lookahead state for one visible sequence editor row.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct SequenceLookaheadRowState {
    /// Cue definition UID for this row.
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub cue_uid: Uuid,
    /// Optional cue part ID. `None` addresses the cue row; `Some(0)` addresses the top-level part.
    pub part_id: Option<u32>,
    /// Whether this row owns lookahead values.
    pub lookahead_enabled: bool,
    /// Downstream source cue IDs whose lookahead assertions may apply from this cue row.
    pub source_cue_ids: Vec<u32>,
}

/// Backend-authored lookahead projection for one sequence.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct SequenceLookaheadStateMessage {
    /// Sequence definition UID.
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub sequence_uid: Uuid,
    /// Lookahead row state keyed by cue and optional part ID.
    pub rows: Vec<SequenceLookaheadRowState>,
}

/// UI payload for removing a cue definition from keyed stores.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct RemovedCueDefinition {
    /// Cue definition UID.
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub uid: Uuid,
}

/// UI payload for removing a sequence definition from keyed stores.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct RemovedSequenceDefinition {
    /// Sequence definition UID.
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub uid: Uuid,
}

/// Committed backend cue definition change ready for websocket publication.
#[derive(Clone, Debug, Message)]
pub enum CueDefinitionChange {
    /// A cue definition was inserted or updated.
    Updated(Box<Cue>),
    /// A cue definition was removed.
    Removed {
        /// Removed cue definition UID.
        uid: Uuid,
    },
}

/// Committed backend sequence definition change ready for websocket publication.
#[derive(Clone, Debug, Message)]
pub enum SequenceDefinitionChange {
    /// A sequence definition was inserted or updated.
    Updated(Box<Sequence>),
    /// A sequence definition was removed.
    Removed {
        /// Removed sequence definition UID.
        uid: Uuid,
    },
}

/// Tracks whether sequence lookahead websocket state should be rebroadcast.
#[derive(Resource, Default)]
pub struct SequenceLookaheadStateDirty(bool);

impl SequenceLookaheadStateDirty {
    /// Marks sequence lookahead projection state for rebroadcast.
    pub(crate) fn mark(&mut self) {
        self.0 = true;
    }

    /// Returns and clears whether sequence lookahead projection state is dirty.
    pub(crate) fn take(&mut self) -> bool {
        let is_dirty = self.0;
        self.0 = false;
        is_dirty
    }
}

/// Wrapper for serializing cue lists with WsOutbound-compatible format
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum CueWsMessage<'a> {
    /// List of all cues
    CueDefinitions(&'a [Cue]),
    /// One committed cue definition update.
    CueDefinitionUpdated(&'a Cue),
    /// One committed cue definition removal.
    CueDefinitionRemoved(&'a RemovedCueDefinition),
    /// List of all sequences
    SequenceDefinitions(&'a [Sequence]),
    /// One committed sequence definition update.
    SequenceDefinitionUpdated(&'a Sequence),
    /// One committed sequence definition removal.
    SequenceDefinitionRemoved(&'a RemovedSequenceDefinition),
    /// List of all color path definitions
    ColorPathDefinitions(&'a [ColorPath]),
    /// Resolved timing profiles for all cues
    CueDurationProfiles(&'a [CueDurationProfileMessage]),
    /// Resolved timing profile for one committed cue definition update.
    CueDurationProfileUpdated(&'a CueDurationProfileMessage),
    /// Timing profile removal for one removed cue definition.
    CueDurationProfileRemoved(&'a RemovedCueDefinition),
    /// Backend-authored lookahead projections for all sequences
    SequenceLookaheadStates(&'a [SequenceLookaheadStateMessage]),
    /// A cue command for reactive UI handling
    CueCommand(&'a CueCommand),
}

/// Builds one UI-facing duration profile for a cue definition.
pub fn cue_duration_profile_message(
    cue: &Cue,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver,
) -> CueDurationProfileMessage {
    CueDurationProfileMessage {
        cue_uid: cue.identifiers.uid,
        cue_id: cue.identifiers.id,
        profile: fixture_data_provider.cue_duration_profile(cue, selection_resolver),
    }
}

/// Builds UI-facing duration profiles from the same cue-domain resolver used by timeline planning.
pub fn cue_duration_profile_messages(
    cue_data_provider: &DataProvider<Cue>,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver,
) -> Vec<CueDurationProfileMessage> {
    cue_data_provider
        .iter()
        .map(|entry| {
            let cue = entry.value();
            cue_duration_profile_message(cue, fixture_data_provider, selection_resolver)
        })
        .collect()
}

/// Builds backend-authored lookahead row state for sequence editor surfaces.
pub fn sequence_lookahead_state_messages(
    seq_data_provider: &DataProvider<Sequence>,
    cue_data_provider: &DataProvider<Cue>,
    fixture_data_provider: &Res<FixtureDataProviderExt>,
    parameter_query: &Query<InstanceRef<Parameter>>,
    selection_resolver: &SpatialSelectionResolver,
) -> Vec<SequenceLookaheadStateMessage> {
    seq_data_provider
        .iter()
        .map(|entry| {
            let sequence = entry.value();
            let steps = sequence
                .steps
                .iter()
                .filter_map(|cue_uid| cue_data_provider.get((*cue_uid).into()).ok())
                .map(|cue| (*cue).clone())
                .collect::<Vec<_>>();
            let mut materialized = MaterializedSequence::materialize_from_steps(
                sequence,
                steps.clone(),
                fixture_data_provider,
                parameter_query,
                selection_resolver,
            );
            let mut rows = Vec::new();

            for (index, cue) in steps.iter().enumerate() {
                materialized.set_position(index as u32 + 1);
                let source_cue_ids = materialized.lookahead_source_cue_ids_for_all_dark_fixtures(
                    fixture_data_provider,
                    parameter_query,
                    InstanceOptions {
                        lookahead_enabled: None,
                    },
                );
                rows.push(SequenceLookaheadRowState {
                    cue_uid: cue.identifiers.uid,
                    part_id: None,
                    lookahead_enabled: cue.lookahead == Some(true)
                        || cue.parts.iter().any(|part| part.lookahead == Some(true)),
                    source_cue_ids,
                });
                rows.push(SequenceLookaheadRowState {
                    cue_uid: cue.identifiers.uid,
                    part_id: Some(0),
                    lookahead_enabled: cue.lookahead == Some(true),
                    source_cue_ids: Vec::new(),
                });
                rows.extend(cue.parts.iter().map(|part| SequenceLookaheadRowState {
                    cue_uid: cue.identifiers.uid,
                    part_id: Some(part.identifiers.id),
                    lookahead_enabled: part.lookahead == Some(true),
                    source_cue_ids: Vec::new(),
                }));
            }

            SequenceLookaheadStateMessage {
                sequence_uid: sequence.identifiers.uid,
                rows,
            }
        })
        .collect()
}

/// Deserialize and dispatch CueCommand from JSON.
///
/// This function is registered with the `CommandDeserializerRegistry` to handle
/// incoming cue commands from the UI. It deserializes the JSON payload into a
/// `CueCommand` and queues it through pending command dispatch so undo can
/// capture an inverse before domain handlers mutate cue state.
///
pub fn deserialize_cue_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: CueCommand =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse CueCommand: {}", e))?;

    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));

    Ok(())
}

/// Deserializes and queues a cue preview command for semantic dispatch.
pub fn deserialize_cue_preview_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: crate::events::CuePreviewCommand = serde_json::from_value(json)
        .map_err(|e| format!("Failed to parse CuePreviewCommand: {}", e))?;

    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));

    Ok(())
}

/// Send cues to UI on DataProvider changes.
///
/// This system monitors the cue DataProvider for changes and broadcasts
/// the full cue list to connected WebSocket clients.
pub fn send_cues(
    cue_data_provider: &DataProvider<Cue>,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver,
    broadcaster: &ClientEventSink,
) {
    let cues: Vec<Cue> = cue_data_provider
        .iter()
        .map(|entry| entry.value().clone())
        .collect();
    let profiles =
        cue_duration_profile_messages(cue_data_provider, fixture_data_provider, selection_resolver);

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &CueWsMessage::CueDefinitions(&cues),
    );
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &CueWsMessage::CueDurationProfiles(&profiles),
    );
    tracing::trace!("Sending cue definitions to websocket clients");
}

/// Send resolved cue duration profiles to UI without sending cue definitions.
pub fn send_cue_duration_profiles(
    cue_data_provider: &DataProvider<Cue>,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver,
    broadcaster: &ClientEventSink,
) {
    let profiles =
        cue_duration_profile_messages(cue_data_provider, fixture_data_provider, selection_resolver);

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &CueWsMessage::CueDurationProfiles(&profiles),
    );
    tracing::trace!("Sending cue duration profiles to websocket clients");
}

/// Send one committed cue definition update and its resolved duration profile.
pub fn send_cue_definition_update(
    cue: &Cue,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver,
    broadcaster: &ClientEventSink,
) {
    let profile = cue_duration_profile_message(cue, fixture_data_provider, selection_resolver);

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &CueWsMessage::CueDefinitionUpdated(cue),
    );
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &CueWsMessage::CueDurationProfileUpdated(&profile),
    );
    tracing::trace!(
        cue_uid = %cue.identifiers.uid,
        "Sending cue definition update to websocket clients"
    );
}

/// Send one committed cue definition removal and remove its duration profile.
pub fn send_cue_definition_removal(uid: Uuid, broadcaster: &ClientEventSink) {
    let removed = RemovedCueDefinition { uid };

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &CueWsMessage::CueDefinitionRemoved(&removed),
    );
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &CueWsMessage::CueDurationProfileRemoved(&removed),
    );
    tracing::trace!(
        cue_uid = %uid,
        "Sending cue definition removal to websocket clients"
    );
}

/// Send sequences to UI on DataProvider changes.
///
/// This system monitors the sequence DataProvider for changes and broadcasts
/// the full sequence list to connected WebSocket clients.
pub fn send_sequences(seq_data_provider: &DataProvider<Sequence>, broadcaster: &ClientEventSink) {
    let sequences: Vec<Sequence> = seq_data_provider
        .iter()
        .map(|entry| entry.value().clone())
        .collect();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &CueWsMessage::SequenceDefinitions(&sequences),
    );
    tracing::trace!("Sending sequence definitions to websocket clients");
}

/// Send one committed sequence definition update.
pub fn send_sequence_definition_update(sequence: &Sequence, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &CueWsMessage::SequenceDefinitionUpdated(sequence),
    );
    tracing::trace!(
        sequence_uid = %sequence.identifiers.uid,
        "Sending sequence definition update to websocket clients"
    );
}

/// Send one committed sequence definition removal.
pub fn send_sequence_definition_removal(uid: Uuid, broadcaster: &ClientEventSink) {
    let removed = RemovedSequenceDefinition { uid };

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &CueWsMessage::SequenceDefinitionRemoved(&removed),
    );
    tracing::trace!(
        sequence_uid = %uid,
        "Sending sequence definition removal to websocket clients"
    );
}

/// Send color paths to UI on DataProvider changes.
pub fn send_color_paths(
    color_path_data_provider: Res<DataProvider<ColorPath>>,
    broadcaster: ClientEventSink,
) {
    let color_paths: Vec<ColorPath> = color_path_data_provider
        .iter()
        .map(|entry| entry.value().clone())
        .collect();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &CueWsMessage::ColorPathDefinitions(&color_paths),
    );
    tracing::trace!("Sending color path definitions to websocket clients");
}

/// Send backend-authored sequence lookahead state to UI.
pub fn send_sequence_lookahead_states(
    seq_data_provider: &DataProvider<Sequence>,
    cue_data_provider: &DataProvider<Cue>,
    fixture_data_provider: &Res<FixtureDataProviderExt>,
    parameter_query: &Query<InstanceRef<Parameter>>,
    selection_resolver: &SpatialSelectionResolver,
    broadcaster: &ClientEventSink,
) {
    let states = sequence_lookahead_state_messages(
        seq_data_provider,
        cue_data_provider,
        fixture_data_provider,
        parameter_query,
        selection_resolver,
    );

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &CueWsMessage::SequenceLookaheadStates(&states),
    );
    tracing::debug!(
        state_count = states.len(),
        "Sending sequence lookahead states to websocket clients"
    );
}

/// Forward cue commands to the UI for reactive handling.
///
/// Note: CRUD commands (StoreCue, RenameCue, DeleteCue, StoreSequence,
/// RenameSequence, DeleteSequence) are intentionally NOT forwarded here
/// because the command echo would be sent before we know if the operation
/// succeeded. Instead, domain handlers emit committed definition changes after
/// backend stores are updated.
pub fn forward_commands(
    mut events: MessageReader<CommandEnvelope<CueCommand>>,
    _broadcaster: Res<ClientEventSink>,
) {
    // Drain the events to avoid them accumulating
    for _event in events.read() {
        // CRUD commands are not forwarded - rely on change detection instead
    }
}

/// Send duration profiles when fixture data changes cue timing resolution.
pub fn send_cues_on_change(
    cue_data_provider: Res<DataProvider<Cue>>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    selection_resolver: SpatialSelectionResolver,
    broadcaster: Res<ClientEventSink>,
) {
    if fixture_data_provider.is_changed() {
        send_cue_duration_profiles(
            &cue_data_provider,
            &fixture_data_provider,
            &selection_resolver,
            &broadcaster,
        );
    }
}

/// Send committed cue definition changes.
pub fn send_cue_definition_changes(
    mut events: MessageReader<CueDefinitionChange>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    selection_resolver: SpatialSelectionResolver,
    broadcaster: Res<ClientEventSink>,
) {
    for event in events.read() {
        match event {
            CueDefinitionChange::Updated(cue) => send_cue_definition_update(
                cue,
                &fixture_data_provider,
                &selection_resolver,
                &broadcaster,
            ),
            CueDefinitionChange::Removed { uid } => {
                send_cue_definition_removal(*uid, &broadcaster);
            }
        }
    }
}

/// Send committed sequence definition changes.
pub fn send_sequence_definition_changes(
    mut events: MessageReader<SequenceDefinitionChange>,
    broadcaster: Res<ClientEventSink>,
) {
    for event in events.read() {
        match event {
            SequenceDefinitionChange::Updated(sequence) => {
                send_sequence_definition_update(sequence, &broadcaster);
            }
            SequenceDefinitionChange::Removed { uid } => {
                send_sequence_definition_removal(*uid, &broadcaster);
            }
        }
    }
}

/// Send color path definitions when DataProvider<ColorPath> changes.
pub fn send_color_paths_on_change(
    color_path_data_provider: Res<DataProvider<ColorPath>>,
    broadcaster: Res<ClientEventSink>,
) {
    if color_path_data_provider.is_changed() {
        send_color_paths(color_path_data_provider, broadcaster.clone());
    }
}

/// Send sequence lookahead state when its backend inputs change.
pub fn send_sequence_lookahead_states_on_change(
    seq_data_provider: Res<DataProvider<Sequence>>,
    cue_data_provider: Res<DataProvider<Cue>>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    parameter_query: Query<InstanceRef<Parameter>>,
    selection_resolver: SpatialSelectionResolver,
    broadcaster: Res<ClientEventSink>,
) {
    if seq_data_provider.is_changed()
        || cue_data_provider.is_changed()
        || fixture_data_provider.is_changed()
    {
        send_sequence_lookahead_states(
            &seq_data_provider,
            &cue_data_provider,
            &fixture_data_provider,
            &parameter_query,
            &selection_resolver,
            &broadcaster,
        );
    }
}

/// Send sequence lookahead state after cue definition commands mutate backend stores.
pub fn send_sequence_lookahead_states_after_cue_commands(
    mut dirty: ResMut<SequenceLookaheadStateDirty>,
    seq_data_provider: Res<DataProvider<Sequence>>,
    cue_data_provider: Res<DataProvider<Cue>>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    parameter_query: Query<InstanceRef<Parameter>>,
    selection_resolver: SpatialSelectionResolver,
    broadcaster: Res<ClientEventSink>,
) {
    if dirty.take() {
        send_sequence_lookahead_states(
            &seq_data_provider,
            &cue_data_provider,
            &fixture_data_provider,
            &parameter_query,
            &selection_resolver,
            &broadcaster,
        );
    }
}

/// Handle ResyncState by sending cues and sequences immediately
pub fn handle_resync_state(
    mut events: MessageReader<ResyncRequested>,
    cue_data_provider: Res<DataProvider<Cue>>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    selection_resolver: SpatialSelectionResolver,
    seq_data_provider: Res<DataProvider<Sequence>>,
    parameter_query: Query<InstanceRef<Parameter>>,
    color_path_data_provider: Res<DataProvider<ColorPath>>,
    broadcaster: Res<ClientEventSink>,
) {
    let should_resync = events.read().next().is_some();

    if !should_resync {
        return;
    }

    send_cues(
        &cue_data_provider,
        &fixture_data_provider,
        &selection_resolver,
        &broadcaster,
    );
    send_sequences(&seq_data_provider, &broadcaster);
    send_sequence_lookahead_states(
        &seq_data_provider,
        &cue_data_provider,
        &fixture_data_provider,
        &parameter_query,
        &selection_resolver,
        &broadcaster,
    );
    send_color_paths(color_path_data_provider, broadcaster.clone());
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

    use bevy_app::App;
    use bevy_ecs::system::SystemState;
    use moonshine_kind::{Instance, InstanceRef};
    use nightfall::prelude::{
        FixtureRef, Group, Identifiers, PartialTransition, SelectionExpr, SpatialSelection,
        TransitionMode, ValueSource,
    };
    use nightfall_dmx::prelude::{Attribute, ParameterValue};
    use nightfall_fixtures::prelude::{
        Fixture, FixtureElement, Parameter, ParameterMetadata, ParameterValues,
    };
    use serde::Serialize;

    use super::*;
    use crate::cue::{BoundCueInstruction, CueInstruction};

    /// Serializes one websocket payload through the backend CBOR codec and decodes it for assertions.
    fn cbor_payload_value<T: Serialize>(payload: &T) -> serde_json::Value {
        let encoded = minicbor_serde::to_vec(payload).expect("payload should encode as CBOR");
        minicbor_serde::from_slice(&encoded).expect("payload should decode as JSON value")
    }

    #[test]
    /// Verifies websocket cue commands pass through undo-aware pending dispatch.
    fn deserialize_cue_command_queues_pending_command_with_undo_id() {
        let mut world = World::new();
        world.insert_resource(PendingCommandBuffer::default());

        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        deserialize_cue_command(
            &mut world,
            serde_json::json!({
                "type": "RenameCue",
                "data": {
                    "sequence_id": 1,
                    "cue_id": 2,
                    "new_sequence_id": 3,
                    "new_cue_id": 4
                }
            }),
            command_id,
            undo_id,
        )
        .expect("cue command should deserialize");

        let pending_commands = world
            .resource_mut::<PendingCommandBuffer>()
            .drain()
            .into_iter()
            .collect::<Vec<_>>();
        assert_eq!(pending_commands.len(), 1);
        assert_eq!(pending_commands[0].command_id, command_id);
        assert_eq!(pending_commands[0].undo_id, undo_id);
        assert!(matches!(
            pending_commands[0]
                .payload
                .as_any()
                .downcast_ref::<CueCommand>(),
            Some(CueCommand::RenameCue {
                sequence_id: 1,
                cue_id: 2,
                new_sequence_id: 3,
                new_cue_id: 4,
            })
        ));
    }

    /// Verifies direct UUID fields in cue websocket payloads serialize as UI string keys.
    #[test]
    fn cue_websocket_payload_uuids_serialize_as_strings() {
        let cue_uid = Uuid::from_u128(0x1234567890abcdef1234567890abcdef);
        let sequence_uid = Uuid::from_u128(0xfedcba0987654321fedcba0987654321);

        let profile = CueDurationProfileMessage {
            cue_uid,
            cue_id: 7,
            profile: CueDurationProfile::default(),
        };
        let profile_value = cbor_payload_value(&CueWsMessage::CueDurationProfileUpdated(&profile));
        assert_eq!(
            profile_value["data"]["cue_uid"],
            cue_uid.simple().to_string()
        );

        let removed_cue = RemovedCueDefinition { uid: cue_uid };
        let removed_cue_value =
            cbor_payload_value(&CueWsMessage::CueDefinitionRemoved(&removed_cue));
        assert_eq!(
            removed_cue_value["data"]["uid"],
            cue_uid.simple().to_string()
        );

        let removed_sequence = RemovedSequenceDefinition { uid: sequence_uid };
        let removed_sequence_value =
            cbor_payload_value(&CueWsMessage::SequenceDefinitionRemoved(&removed_sequence));
        assert_eq!(
            removed_sequence_value["data"]["uid"],
            sequence_uid.simple().to_string()
        );

        let lookahead = SequenceLookaheadStateMessage {
            sequence_uid,
            rows: vec![SequenceLookaheadRowState {
                cue_uid,
                part_id: None,
                lookahead_enabled: true,
                source_cue_ids: Vec::new(),
            }],
        };
        let lookahead_value =
            cbor_payload_value(&CueWsMessage::SequenceLookaheadStates(&[lookahead]));
        assert_eq!(
            lookahead_value["data"][0]["sequence_uid"],
            sequence_uid.simple().to_string()
        );
        assert_eq!(
            lookahead_value["data"][0]["rows"][0]["cue_uid"],
            cue_uid.simple().to_string()
        );
    }

    /// Verifies UI-facing cue duration profiles use the cue-domain duration resolver.
    #[test]
    fn cue_duration_profile_messages_resolve_cue_timing() {
        let mut app = App::new();
        app.insert_resource(DataProvider::<Group>::default());
        app.insert_resource(FixtureDataProviderExt::default());

        let fixture_uid = Uuid::new_v4();
        let fixture_ref = FixtureRef {
            fixture_uid,
            index: Some(1),
        };
        let parameter_metadata = ParameterMetadata {
            attribute: Attribute::Intensity,
            ..Default::default()
        };
        let parameter = unsafe {
            Instance::<Parameter>::from_entity_unchecked(
                app.world_mut()
                    .spawn(Parameter {
                        metadata: parameter_metadata.clone(),
                        values: ParameterValues::default(),
                    })
                    .id(),
            )
        };
        let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        fixtures
            .inner
            .add(Fixture {
                identifiers: Identifiers {
                    id: 1,
                    uid: fixture_uid,
                    label: "fixture-1".to_owned(),
                },
                elements: vec![FixtureElement {
                    label: "main".to_owned(),
                    parameters: vec![parameter_metadata],
                }],
                ..Default::default()
            })
            .expect("test fixture should be stored");
        fixtures.add_parameter(fixture_ref.clone(), Attribute::Intensity, parameter);
        drop(fixtures);

        let cue_uid = Uuid::new_v4();
        let mut cues = DataProvider::<Cue>::default();
        cues.add(Cue {
            identifiers: Identifiers {
                id: 7,
                uid: cue_uid,
                label: "timed cue".to_owned(),
            },
            transitions: PartialTransition {
                delay_in: Some(TransitionMode::Fixed(Duration::from_millis(200))),
                fade_in: Some(TransitionMode::Fixed(Duration::from_millis(500))),
                fade_out: Some(TransitionMode::Fixed(Duration::from_millis(300))),
                ..Default::default()
            },
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![fixture_ref])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("test cue should be stored");

        let mut system_state =
            SystemState::<(Res<FixtureDataProviderExt>, SpatialSelectionResolver)>::new(
                app.world_mut(),
            );
        let (fixture_data_provider, selection_resolver) = system_state
            .get(app.world_mut())
            .expect("test system parameters should be available");
        let profiles =
            cue_duration_profile_messages(&cues, &fixture_data_provider, &selection_resolver);

        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].cue_uid, cue_uid);
        assert_eq!(profiles[0].cue_id, 7);
        assert_eq!(profiles[0].profile.max_delay_in, Duration::from_millis(200));
        assert_eq!(profiles[0].profile.max_fade_in, Duration::from_millis(500));
        assert_eq!(
            profiles[0].profile.assertion_duration,
            Duration::from_millis(700)
        );
        assert_eq!(
            profiles[0].profile.release_duration,
            Duration::from_millis(300)
        );
    }

    /// Verifies sequence Lookahead row states are derived from backend materialization.
    #[test]
    fn sequence_lookahead_state_messages_resolve_source_cues() {
        let mut app = App::new();
        app.insert_resource(DataProvider::<Group>::default());
        app.insert_resource(FixtureDataProviderExt::default());

        let fixture_uid = Uuid::new_v4();
        let fixture_ref = FixtureRef {
            fixture_uid,
            index: Some(1),
        };
        let intensity_metadata = ParameterMetadata {
            attribute: Attribute::Intensity,
            ..Default::default()
        };
        let pan_metadata = ParameterMetadata {
            attribute: Attribute::Pan,
            ..Default::default()
        };
        let intensity_parameter = unsafe {
            Instance::<Parameter>::from_entity_unchecked(
                app.world_mut()
                    .spawn(Parameter {
                        metadata: intensity_metadata.clone(),
                        values: ParameterValues::default(),
                    })
                    .id(),
            )
        };
        let pan_parameter = unsafe {
            Instance::<Parameter>::from_entity_unchecked(
                app.world_mut()
                    .spawn(Parameter {
                        metadata: pan_metadata.clone(),
                        values: ParameterValues::default(),
                    })
                    .id(),
            )
        };
        let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        fixtures
            .inner
            .add(Fixture {
                identifiers: Identifiers {
                    id: 1,
                    uid: fixture_uid,
                    label: "fixture-1".to_owned(),
                },
                elements: vec![FixtureElement {
                    label: "main".to_owned(),
                    parameters: vec![intensity_metadata, pan_metadata],
                }],
                ..Default::default()
            })
            .expect("test fixture should be stored");
        fixtures.add_parameter(
            fixture_ref.clone(),
            Attribute::Intensity,
            intensity_parameter,
        );
        fixtures.add_parameter(fixture_ref.clone(), Attribute::Pan, pan_parameter);
        drop(fixtures);

        let cue_one_uid = Uuid::new_v4();
        let cue_two_uid = Uuid::new_v4();
        let sequence_uid = Uuid::new_v4();
        let mut cues = DataProvider::<Cue>::default();
        cues.add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: cue_one_uid,
                label: "dark".to_owned(),
            },
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                    fixture_ref.clone(),
                ])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 0.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("first cue should be stored");
        cues.add(Cue {
            identifiers: Identifiers {
                id: 2,
                uid: cue_two_uid,
                label: "lookahead source".to_owned(),
            },
            lookahead: Some(true),
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![fixture_ref])),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Pan,
                        ValueSource::Inline(ParameterValue::Absolute { value: 45.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("second cue should be stored");

        let mut sequences = DataProvider::<Sequence>::default();
        sequences
            .add(Sequence {
                identifiers: Identifiers {
                    id: 1,
                    uid: sequence_uid,
                    label: "sequence".to_owned(),
                },
                steps: vec![cue_one_uid.into(), cue_two_uid.into()],
                ..Default::default()
            })
            .expect("sequence should be stored");

        let mut system_state = SystemState::<(
            Res<FixtureDataProviderExt>,
            Query<InstanceRef<Parameter>>,
            SpatialSelectionResolver,
        )>::new(app.world_mut());
        let (fixture_data_provider, parameter_query, selection_resolver) = system_state
            .get(app.world_mut())
            .expect("test system parameters should be available");
        let states = sequence_lookahead_state_messages(
            &sequences,
            &cues,
            &fixture_data_provider,
            &parameter_query,
            &selection_resolver,
        );

        assert_eq!(states.len(), 1);
        assert_eq!(states[0].sequence_uid, sequence_uid);
        let cue_one_row = states[0]
            .rows
            .iter()
            .find(|row| row.cue_uid == cue_one_uid && row.part_id.is_none())
            .expect("cue one row should exist");
        assert_eq!(cue_one_row.source_cue_ids, vec![2]);
        assert!(!cue_one_row.lookahead_enabled);
        let cue_two_row = states[0]
            .rows
            .iter()
            .find(|row| row.cue_uid == cue_two_uid && row.part_id.is_none())
            .expect("cue two row should exist");
        assert_eq!(cue_two_row.source_cue_ids, Vec::<u32>::new());
        assert!(cue_two_row.lookahead_enabled);
    }
}
