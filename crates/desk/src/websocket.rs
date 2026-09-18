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

use std::collections::HashMap;
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
use nightfall_clips::{Clip, ClipCommand, MaterializedClip};
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::universe::ConsoleDmxUniverses;
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
    TIMELINE_ACTIONS_MS, TIMELINE_AUDIO_MS, TIMELINE_LAYER_GENERATION_MS,
    TIMELINE_LOOKAHEAD_ASSERTIONS_MS, TIMELINE_LOOKAHEAD_LAYERS_MS, TIMELINE_LOOKAHEAD_SOURCES_MS,
    TIMELINE_PARAMETERS_MS, TIMELINE_SEEK_MS, TIMELINE_UPDATE_MS,
    register_websocket_performance_diagnostics,
};
use inbound::flush_pending_ui_notifications;
pub use inbound::*;
pub use instances::*;
pub use layers::send_layer_stack;
#[cfg(test)]
use layers::{computed_transition_fixture_state, is_transition_active};
pub use metrics::send_metrics;
pub use nightfall_fixtures::websocket::{
    PARAMETER_STATE_BROADCAST_MS, PARAMETER_STATE_BUILD_MS, send_parameter_state,
};
pub(crate) use resync::{handle_low_freq_updates, handle_resync_state};
pub use wire::{
    DeskMetrics, InstanceInfo, OutboundBlueprintDependency, UndoStackEntryMessage, UndoStateMessage,
};
use wire::{
    DeskWsMessage, OutboundClipLocal, OutboundElementComputedState, OutboundElementParameterValues,
    OutboundElementTransitionState, OutboundLayerState,
};

#[cfg(test)]
mod tests;
