// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Flow engine types, protocol definitions, and plugin wiring.

#![warn(missing_docs)]

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_instances::{
    ClipInstanceAttachment, ClipInstanceRequest, DomainInstanceReconstructionRequest,
};
use serde::{Deserialize, Serialize};

mod object_lookup;

pub mod ast_conv;
pub mod builtin_nodes;
pub mod definition;
pub mod events;
pub mod nodes;
pub mod protocol;
pub mod runtime;
pub mod types;
pub mod websocket;

pub use definition::FlowDefinition;
pub use events::{MaterializedFlowReconstructionHandle, spawn_reconstructed_flow_for_clip};
pub use nodes::*;
pub use protocol::*;
pub use runtime::{FlowInstance, FlowRuntime, FlowTriggerState};
pub use types::*;

/// Prelude for ergonomic imports.
pub mod prelude {
    pub use nightfall_waveform::prelude::WaveformKind;

    pub use crate::definition::FlowDefinition;
    pub use crate::nodes::{
        FlowNode, FlowNodeCategory, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory,
        FlowNodeRegistry, FlowPortValues, FlowTriggerValues,
    };
    pub use crate::protocol::{
        FlowAck, FlowDefinitionSnapshot, FlowDelta, FlowDeltaOp, FlowPortValueDelta, FlowSnapshot,
        FlowTriggerDelta,
    };
    pub use crate::runtime::FlowInstance;
    pub use crate::runtime::{FlowRuntime, FlowTriggerState};
    pub use crate::types::{
        FlowColor, FlowEdgeDefinition, FlowId, FlowNodeDefinition, FlowNodeId, FlowPortDefinition,
        FlowPortDirection, FlowPortId, FlowPortRef, FlowPortType, FlowValue, FlowWaveform,
    };
    pub use crate::{FlowCommand, FlowPlugin};
}

/// Plugin for handling flow definitions and UI protocol.
pub struct FlowPlugin;
impl Plugin for FlowPlugin {
    /// Retains persisted definitions while gating experimental command and playback systems.
    fn build(&self, app: &mut App) {
        object_lookup::register_object_lookups(app);

        tracing::debug!("Registering FlowPlugin");
        app.init_resource::<DataProvider<definition::FlowDefinition>>();
        app.init_resource::<nodes::FlowNodeRegistry>();
        app.add_message::<DomainInstanceReconstructionRequest>();

        register_ingress_command::<FlowCommand>(app);
        app.add_message::<events::FlowCommandResult>();
        register_engine_action::<events::FlowPlaybackAction>(app);
        app.add_message::<EventEnvelope<ClipInstanceAttachment>>();
        app.add_message::<RequestEnvelope<ClipInstanceRequest>>();
        nightfall_engine::protocol::dispatch_ast::register_converter::<ast_conv::FlowAstConverter>(
        );
        register_command_deserializer::<FlowCommand>(app, websocket::deserialize_flow_command);

        app.add_systems(
            Update,
            (
                events::handle_events,
                events::crud_events,
                events::handle_playback_commands,
                events::handle_domain_playback_reconstruction_requests,
            )
                .chain()
                .run_if(experimental_flows_enabled)
                .before(events::finish_flow_commands)
                .in_set(EventHandling),
        );
        app.add_systems(
            Update,
            (
                events::reject_disabled_commands.run_if(not(experimental_flows_enabled)),
                events::finish_flow_commands,
            )
                .chain()
                .in_set(EventHandling),
        );
        app.add_systems(
            Update,
            (
                runtime::publish_runtime_deltas,
                websocket::forward_flow_commands,
                websocket::send_flows_on_change,
            )
                .in_set(ClientOutput),
        );
        app.add_systems(
            Update,
            (
                runtime::evaluate_flow_instances,
                runtime::sync_flow_playback_runtime_status,
            )
                .run_if(experimental_flows_enabled)
                .in_set(LayerGeneration),
        );
        app.add_systems(
            Update,
            events::cleanup_released_flow_instances.in_set(VdimProcessing),
        );
        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );

        {
            let mut registry = app.world_mut().resource_mut::<nodes::FlowNodeRegistry>();
            if let Err(err) = builtin_nodes::register_builtin_nodes(&mut registry) {
                tracing::warn!("Failed to register builtin flow nodes: {}", err);
            }
        }
    }
}

/// Returns the host-authored opt-in policy, conservatively disabling flows without a host.
pub fn experimental_flows_enabled(capabilities: Option<Res<RuntimeCapabilities>>) -> bool {
    capabilities.is_some_and(|capabilities| capabilities.experimental_flows)
}

/// Engine commands for flow operations.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum FlowCommand {
    /// Store a flow definition.
    StoreFlow(definition::FlowDefinition),
    /// Rename a flow definition.
    RenameFlow {
        /// ID of the flow to rename.
        id: u32,
        /// New ID for the flow.
        new_id: u32,
    },
    /// Delete a flow definition.
    DeleteFlow(u32),
    /// Apply a flow delta to a definition.
    ApplyDelta(protocol::FlowDelta),
    /// Start a flow playback.
    StartFlow(u32),
    /// Stop a flow playback.
    StopFlow(u32),
    /// Go/advance a flow playback.
    GoFlow(u32),
}

impl IngressCommand for FlowCommand {}
