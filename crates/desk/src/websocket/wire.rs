// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Desk websocket wire schemas and attribute-key serialization helpers.

use super::*;

mod attribute_keyed_map_vec {
    use std::collections::HashMap;
    use std::str::FromStr;

    use nightfall_dmx::prelude::Attribute;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    /// Serialize per-element attribute maps using canonical keys, preserving custom labels.
    pub fn serialize<S, V>(maps: &[HashMap<Attribute, V>], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
        V: Serialize,
    {
        let keyed: Vec<HashMap<String, &V>> = maps
            .iter()
            .map(|map| {
                map.iter()
                    .map(|(attribute, value)| (attribute.key(), value))
                    .collect()
            })
            .collect();
        keyed.serialize(serializer)
    }

    /// Deserialize per-element attribute maps from canonical keys, treating unknown keys as custom labels.
    pub fn deserialize<'de, D, V>(deserializer: D) -> Result<Vec<HashMap<Attribute, V>>, D::Error>
    where
        D: Deserializer<'de>,
        V: Deserialize<'de>,
    {
        let keyed = Vec::<HashMap<String, V>>::deserialize(deserializer)?;
        Ok(keyed
            .into_iter()
            .map(|map| {
                map.into_iter()
                    .map(|(key, value)| (attribute_from_key(key), value))
                    .collect()
            })
            .collect())
    }

    /// Resolve a serialized attribute key back into an Attribute value.
    fn attribute_from_key(key: String) -> Attribute {
        Attribute::from_str(&key).unwrap_or(Attribute::Custom { label: key })
    }
}

/// Local outbound clip representation used for UI serialization
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub(super) struct OutboundClipLocal {
    pub(super) clip: Clip,
    /// Whether this clip has an active playback
    pub(super) is_active: bool,
}

/// Information about an active playback for UI display
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct InstanceInfo {
    /// Unique runtime identifier for this playback
    pub instance_id: InstanceId,
    /// What kind of playback (Cue, Sequence, Fx, Flow, Programmer)
    pub kind: InstanceKind,
    /// Operator-facing playback type label.
    pub display_kind: InstanceDisplayKind,
    /// Optional display name
    pub name: Option<String>,
    /// Tags associated with this playback
    pub tags: Vec<String>,
    /// Source object that produced this playback, if known.
    pub object_ref: Option<ObjectRef>,
    /// Whether this playback is owned by an editor preview workflow.
    pub is_preview: bool,
    /// Whether this playback is fading out after a stop/release command.
    pub is_releasing: bool,
    /// Whether this playback clock is currently frozen or held at zero rate.
    pub is_paused: bool,
    /// Wall-clock timestamp when this playback began releasing, if applicable.
    pub release_epoch_ms: Option<f64>,
    /// Wall-clock timestamp when this playback was activated, if available.
    pub activation_epoch_ms: Option<f64>,
    /// Source-local elapsed duration for the currently visible transition segment.
    pub transition_elapsed: Option<Duration>,
    /// Owner component UIDs attached to this playback.
    pub owner_uids: Vec<Uuid>,
    /// Playback priority resolved from the bound clip, if available.
    pub priority: Option<Priority>,
    /// ID of the clip bound to this playback, if any
    pub bound_clip_id: Option<u32>,
    /// Current intensity scale (0.0-1.0)
    pub intensity_scale: f32,
    /// Current rate multiplier
    pub rate: f32,
    /// Runtime master scale applied on top of the current rate.
    pub rate_master_scale: f32,
    /// Current effective rate after master scaling.
    pub effective_rate: f64,
    /// Backend-authored clock and phase state for an editor-owned Step FX preview.
    pub step_fx_preview: Option<StepFxPreviewPlaybackStatus>,
    /// Source-specific runtime status.
    pub status: InstanceStatus,
}

/// Developer-visible metadata for one undo or redo stack group.
#[typeshare::typeshare]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct UndoStackEntryMessage {
    /// Zero-based position in execution order, where 0 is the next group to apply.
    pub order: u32,
    /// Human-readable description for the grouped operation.
    pub description: String,
    /// Number of commands grouped into this undoable operation.
    pub entry_count: u32,
    /// Age of the grouped operation when this message was emitted.
    pub age_ms: u32,
    /// Whether this group was preserved from a redo branch by GURQ.
    pub is_gurq_preserved: bool,
    /// Batch ID linking commands that undo or redo together.
    pub undo_id: String,
    /// Human-readable descriptions for commands in this group.
    pub entry_descriptions: Vec<String>,
    /// Correlation IDs linking grouped commands to the original command envelopes.
    pub correlation_ids: Vec<String>,
}

/// Current state of the undo/redo system for UI display
#[typeshare::typeshare]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct UndoStateMessage {
    /// Whether there are operations available to undo
    pub can_undo: bool,
    /// Whether there are operations available to redo
    pub can_redo: bool,
    /// Description of the next undo operation
    pub undo_description: Option<String>,
    /// Description of the next redo operation
    pub redo_description: Option<String>,
    /// Number of items in the undo stack
    pub undo_depth: u32,
    /// Number of items in the redo stack
    pub redo_depth: u32,
    /// Undo stack groups in undo execution order.
    pub undo_stack: Vec<UndoStackEntryMessage>,
    /// Redo stack groups in redo execution order.
    pub redo_stack: Vec<UndoStackEntryMessage>,
}

/// Engine performance metrics for UI instrumentation panel
#[typeshare::typeshare]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DeskMetrics {
    /// Frames per second (smoothed)
    pub fps: Option<f64>,
    /// Frame time in milliseconds (smoothed)
    pub frame_time_ms: Option<f64>,
    /// Total entity count in the ECS world
    pub entity_count: Option<u32>,
    /// Time spent in frame pacing in milliseconds
    pub framepace_time_ms: Option<f64>,
    /// Oversleep duration from frame pacing in milliseconds
    pub framepace_oversleep_ms: Option<f64>,
    /// Number of active compositor layers
    pub active_layers: u32,
    /// Number of active DMX universes
    pub active_universes: u32,
    /// Time spent sending Art-Net universes in milliseconds
    pub artnet_send_time_ms: Option<f64>,
    /// Number of Art-Net universes sent
    pub artnet_universe_count: u32,
    /// Time spent sending sACN universes in milliseconds
    pub sacn_send_time_ms: Option<f64>,
    /// Number of sACN universes sent
    pub sacn_universe_count: u32,
    /// Time spent building the outbound parameter state snapshot
    pub parameter_state_build_ms: Option<f64>,
    /// Time spent serializing and broadcasting the parameter state snapshot
    pub parameter_state_broadcast_ms: Option<f64>,
    /// Time spent building the outbound layer stack snapshot
    pub layer_stack_build_ms: Option<f64>,
    /// Time spent deriving layer transition-state metadata
    pub layer_stack_transition_build_ms: Option<f64>,
    /// Time spent serializing and broadcasting the layer stack snapshot
    pub layer_stack_broadcast_ms: Option<f64>,
    /// Time spent in the scheduled timeline layer generation group
    pub timeline_layer_generation_ms: Option<f64>,
    /// Time spent updating active timeline positions
    pub timeline_update_ms: Option<f64>,
    /// Time spent synchronizing timeline audio state
    pub timeline_audio_ms: Option<f64>,
    /// Time spent materializing timeline lookahead sources
    pub timeline_lookahead_sources_ms: Option<f64>,
    /// Time spent populating materialized timeline lookahead assertions
    pub timeline_lookahead_assertions_ms: Option<f64>,
    /// Time spent updating timeline-owned lookahead layers
    pub timeline_lookahead_layers_ms: Option<f64>,
    /// Time spent processing live timeline actions
    pub timeline_actions_ms: Option<f64>,
    /// Time spent applying timeline parameter tracks
    pub timeline_parameters_ms: Option<f64>,
    /// Time spent handling timeline seek reconstruction
    pub timeline_seek_ms: Option<f64>,
    /// Recent network output send failures
    pub network_output_send_failures: Vec<NetworkOutputSendFailure>,
}

/// Wrapper for serializing cue lists with WsOutbound-compatible format
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub(super) enum DeskWsMessage<'a> {
    /// Definition of all groups
    GroupDefinitions(&'a [Group]),
    /// Definition of all masters
    MasterDefinitions(&'a [Master]),
    /// Definition of all clips
    ClipDefinitions(&'a [OutboundClipLocal]),
    /// Definition of all blueprints
    BlueprintDefinitions(&'a [Blueprint]),
    /// Reverse dependencies for every Blueprint with a live authored reference.
    BlueprintDependencies(&'a [OutboundBlueprintDependency]),
    /// Current desk settings
    Settings(&'a DeskSettings),
    /// Current IO runtime settings
    IoSettings(&'a IoRuntimeSettings),
    /// Host-owned external control settings and listener status.
    ExternalControlState(&'a ExternalControlState),
    /// Network interfaces list
    AvailableNetworkInterfaces(&'a [NetworkInterfaceInfo]),
    /// Current/default network interface status
    NetworkInterfaceStatus(&'a NetworkInterfaceStatus),
    /// Audio devices list (map of stable id -> display name)
    AvailableAudioDevices(
        #[typeshare(serialized_as = "Record<String, String>")]
        &'a std::collections::HashMap<String, String>,
    ),
    /// Compatible USB DMX devices list
    AvailableUsbDmxDevices(&'a [UsbDmxDeviceInfo]),
    /// A desk command
    DeskCommand(&'a DeskCommand),
    /// UI-only notification
    UiNotification(&'a UiNotification),
    /// A group command
    #[allow(dead_code)]
    GroupCommand(&'a GroupCommand),
    /// An clip command
    ClipCommand(&'a ClipCommand),
    /// A blueprint command
    #[allow(dead_code)]
    BlueprintCommand(&'a BlueprintCommand),
    /// Layer stack with computed values (sorted by priority)
    LayerStack(&'a [OutboundLayerState]),
    /// Engine performance metrics
    Metrics(&'a DeskMetrics),
    /// Active instances list
    ActiveInstances(&'a [InstanceInfo]),
    /// Backend-owned control state
    Controls(&'a [ControlSnapshot]),
    /// Current undo/redo state
    UndoState(&'a UndoStateMessage),
}

/// One Blueprint's current reverse-dependency descriptions.
#[derive(Clone, Debug, Serialize)]
#[typeshare::typeshare]
pub struct OutboundBlueprintDependency {
    /// Stable Blueprint identity used as the dependency lookup key.
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub blueprint_uid: Uuid,
    /// Authored programmer, cue, and sequence objects retaining the live reference.
    pub dependents: Vec<String>,
}

/// Typeshare helper to avoid tuple types
#[serde_with::serde_as]
#[typeshare::typeshare]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct OutboundElementParameterValues {
    /// Unique ID of the fixture this state applies to
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub(super) fixture_uid: Uuid,
    /// Contains the attributes for each fixture element
    #[typeshare(serialized_as = "Array<Record<String, ParameterValue>>")]
    #[serde(with = "attribute_keyed_map_vec")]
    pub(super) parameters: Vec<HashMap<Attribute, ParameterValue>>,
}

/// Typeshare helper to avoid tuple types
#[typeshare::typeshare]
#[serde_with::serde_as]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct OutboundElementComputedState {
    /// Unique ID of the fixture this state applies to
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub(super) fixture_uid: Uuid,
    /// Contains the attributes for each fixture element
    #[typeshare(serialized_as = "Array<Record<String, ParameterDmxValue>>")]
    #[serde(with = "attribute_keyed_map_vec")]
    pub(super) parameters: Vec<HashMap<Attribute, ParameterDmxValue>>,
}

/// Typeshare helper to avoid tuple types
#[serde_with::serde_as]
#[typeshare::typeshare]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct OutboundElementTransitionState {
    /// Unique ID of the fixture this state applies to
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub(super) fixture_uid: Uuid,
    /// Contains transition-active flags for each fixture element attribute
    #[typeshare(serialized_as = "Array<Record<String, boolean>>")]
    #[serde(with = "attribute_keyed_map_vec")]
    pub(super) parameters: Vec<HashMap<Attribute, bool>>,
}

/// Wire representation of a single layer's computation information sent to the UI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub(super) struct OutboundLayerState {
    /// Creator name of the layer (cue / programmer / etc.)
    pub creator: String,
    /// Source object that created the layer, if available
    pub object_ref: Option<ObjectRef>,
    /// Numeric priority – lower values are merged first
    pub priority: Priority,
    /// Whether this layer is fading out before removal
    pub is_releasing: bool,
    /// Current source-specific playback position for playback-backed layers.
    pub runtime_position: Option<InstancePosition>,
    /// Asserted absolute parameter values for this layer, in the same shape as `ParameterState`
    pub asserted_absolute_values: Vec<OutboundElementParameterValues>,
    /// Asserted relative parameter values for this layer, in the same shape as `ParameterState`
    pub asserted_relative_values: Vec<OutboundElementParameterValues>,
    /// Backend-owned lookahead assertions, such as lookahead values.
    pub lookahead_asserted_values: Vec<OutboundElementParameterValues>,
    /// Computed parameter values for this layer, in the same shape as `ParameterState`
    pub computed_values: Vec<OutboundElementComputedState>,
    /// Transition-active flags for computed parameter values in this layer
    pub computed_transitioning: Vec<OutboundElementTransitionState>,
}
