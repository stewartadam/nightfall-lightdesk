// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Desk-specific WebSocket protocol integration.
//!
//! This facade preserves the public desk WebSocket API while responsibility-focused child
//! modules own wire schemas, inbound routing, state projection, metrics, and resynchronization.

use std::sync::atomic::AtomicU64;
use std::time::Duration;

use bevy_app::App;
use bevy_diagnostic::{
    Diagnostic, DiagnosticPath, Diagnostics, DiagnosticsStore, FrameTimeDiagnosticsPlugin,
    RegisterDiagnostic,
};
use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use nightfall::prelude::*;
use nightfall_clips::{Clip, ClipCommand, InstanceIndex, MaterializedClip};
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::output_frames::OutputDmxFrames;
use nightfall_fixtures::parameter_state::assertion_kind;
use nightfall_fixtures::prelude::*;
use nightfall_framepace::FramePaceStats;
use nightfall_fx::prelude::{
    ActiveStepFx, PreviewStepFxDefinition, StepFxLanePhaseOffsets, StepFxPreviewPlaybackStatus,
    StepFxPreviewSessionId, step_fx_preview_status,
};
use nightfall_instances::{
    EditorPreviewInstance, InstanceClock, InstanceCommand, InstanceControls, InstanceDisplayKind,
    InstanceId, InstanceKind, InstanceMetadata, InstancePosition, InstanceStatus, Owner,
    activation_epoch_ms,
};
use nightfall_io::{
    AvailableUsbDmxDevices, ExternalControlState, IoRuntimeSettings, NetworkInterfaceInfo,
    NetworkInterfaceState, NetworkInterfaceStatus, UsbDmxDeviceInfo,
    resolve_network_interface_status,
};
use nightfall_lookahead::LookaheadAssertions;
use nightfall_undo::prelude::{UndoGroup, UndoManager};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use web_time::Instant;

use crate::prelude::*;
use crate::{BlueprintCommand, DeskCommand, GroupCommand, SettingsCommand, UiNotification};

mod desk_state;
mod diagnostics;
mod inbound;
mod instances;
mod layers;
mod metrics;
mod resync;
mod wire;

pub use desk_state::*;
use diagnostics::record_elapsed_ms;
pub use diagnostics::{
    LAYER_STACK_BROADCAST_MS, LAYER_STACK_BUILD_MS, LAYER_STACK_TRANSITION_BUILD_MS,
    register_websocket_performance_diagnostics,
};
use inbound::flush_pending_ui_notifications;
pub use inbound::*;
pub use instances::*;
pub use layers::{LayerSnapshotData, LayerStackPublication, send_layer_stack};
#[cfg(test)]
use layers::{computed_transitioning_slots, is_transition_active};
pub use metrics::send_metrics;
pub use nightfall_fixtures::websocket::{
    PARAMETER_STATE_BROADCAST_MS, PARAMETER_STATE_BUILD_MS, send_parameter_state,
};
pub(crate) use resync::{handle_low_freq_updates, handle_resync_state};
pub use wire::{
    DeskMetrics, InstanceInfo, OutboundBlueprintDependency, UndoStackEntryMessage, UndoStateMessage,
};
use wire::{
    DeskWsMessage, OutboundClipLocal, OutboundLayerStack, OutboundLayerState, PackedBytes,
    PackedLayerAssertions,
};

#[cfg(test)]
mod tests;
