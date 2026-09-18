// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Runtime state for flow evaluation and UI value tracking.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
#[cfg(feature = "fx-module")]
use nightfall_engine::prelude::DataProvider;
use nightfall_engine::prelude::{
    ClientEventSink, DISCRIMINATOR_NON_DROPPABLE, EngineActionEnvelope, RequestEnvelope,
};
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
#[cfg(feature = "fx-module")]
use nightfall_fx_module::prelude::StoredFxModule;
#[cfg(test)]
use nightfall_instances::InstanceClockSource;
use nightfall_instances::{ClipInstanceRequest, InstanceClock, InstancePosition, InstanceStatus};
use nightfall_timecode::prelude::*;
use serde::{Deserialize, Serialize};

use crate::builtin_nodes::{
    CLIP_ACTION_KIND, CLIP_IN_ACTION, CLIP_IN_ID, CLIP_IN_TRIGGER, RENDER_LAYER_KIND,
    TIMECODE_ACTION_KIND, TIMECODE_IN_ACTION, TIMECODE_IN_ID, TIMECODE_IN_TRIGGER,
    WAVEFORM_FX_KIND, waveform_fx::build_waveform_layer,
};
#[cfg(feature = "fx-module")]
use crate::builtin_nodes::{
    FX_MODULE_KIND, fx_module::FlowFxModuleRuntime, fx_module::build_fx_module_layer,
    fx_module::teardown_fx_module_runtime,
};
use crate::definition::FlowDefinition;
use crate::nodes::{
    FlowNode, FlowNodeContext, FlowNodeRegistry, FlowPortValues, FlowTriggerValues,
};
use crate::protocol::{FlowPortRuntimeValue, FlowPortValueDelta, FlowSnapshot, FlowTriggerDelta};
use crate::types::{
    FlowEdgeDefinition, FlowId, FlowNodeDefinition, FlowNodeId, FlowPortDefinition,
    FlowPortDirection, FlowPortId, FlowPortRef, FlowPortType, FlowPortVersion, FlowSeq, FlowValue,
    FlowVersion,
};
use crate::websocket::FlowWsMessage;

/// Runtime state for a flow definition.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FlowRuntime {
    /// Current flow definition.
    pub definition: FlowDefinition,
    /// Port values keyed by port reference.
    pub ports: HashMap<FlowPortRef, FlowPortState>,
    /// Trigger state keyed by port reference.
    pub triggers: HashMap<FlowPortRef, FlowTriggerState>,
}

impl FlowRuntime {
    /// Create a new runtime from a flow definition.
    pub fn new(definition: FlowDefinition) -> Self {
        let mut runtime = Self {
            definition,
            ports: HashMap::new(),
            triggers: HashMap::new(),
        };
        runtime.rebuild_ports();
        runtime
    }

    /// Flow id for this runtime.
    pub fn flow_id(&self) -> FlowId {
        self.definition.flow_id()
    }

    /// Flow version for this runtime.
    pub fn flow_version(&self) -> FlowVersion {
        self.definition.flow_version
    }

    /// Apply a delta to the definition and rebuild port cache.
    pub fn apply_delta(&mut self, delta: &crate::protocol::FlowDelta) -> FlowDeltaApplyResult {
        let before = self.definition.flow_version;
        let result = self.definition.apply_delta(delta);
        if result.applied_version != before {
            self.rebuild_ports();
        }
        FlowDeltaApplyResult {
            applied_version: result.applied_version,
            errors: result.errors,
        }
    }

    /// Set a port value, incrementing its version.
    pub fn set_port_value(&mut self, port: FlowPortRef, value: FlowValue) -> Result<(), String> {
        self.set_port_value_if_changed(port, value).map(|_| ())
    }

    /// Set a port value only when it changes. Returns true if updated.
    pub fn set_port_value_if_changed(
        &mut self,
        port: FlowPortRef,
        value: FlowValue,
    ) -> Result<bool, String> {
        let port_def = self
            .definition
            .find_port(port.node_id, port.port_id)
            .ok_or_else(|| "port not found".to_string())?;
        if !port_def.port_type.matches_value(&value) {
            return Err("value type mismatch".to_string());
        }

        let mut is_new = false;
        let entry = self.ports.entry(port).or_insert_with(|| {
            is_new = true;
            FlowPortState {
                port_id: port.port_id,
                port_type: port_def.port_type,
                value: value.clone(),
                version: 1, // Start at 1 so new ports get their deltas published
            }
        });
        // For new entries, the value is already set correctly
        if is_new {
            return Ok(true);
        }
        // For existing entries, only update if the value changed
        if entry.value == value {
            return Ok(false);
        }

        entry.value = value;
        entry.version = entry.version.saturating_add(1);
        Ok(true)
    }

    /// Emit a trigger on a trigger port.
    pub fn emit_trigger(&mut self, port: FlowPortRef) -> Result<(), String> {
        self.emit_trigger_count(port, 1)
    }

    /// Emit multiple trigger events on a trigger port.
    pub fn emit_trigger_count(&mut self, port: FlowPortRef, count: u32) -> Result<(), String> {
        if count == 0 {
            return Ok(());
        }
        let port_def = self
            .definition
            .find_port(port.node_id, port.port_id)
            .ok_or_else(|| "port not found".to_string())?;
        if port_def.port_type != FlowPortType::Trigger {
            return Err("port is not a trigger".to_string());
        }

        let entry = self
            .triggers
            .entry(port)
            .or_insert_with(|| FlowTriggerState { seq: 0, count: 0 });
        entry.seq = entry.seq.saturating_add(count);
        entry.count = entry.count.saturating_add(count);
        Ok(())
    }

    /// Clear trigger counts after evaluation.
    pub fn clear_trigger_counts(&mut self) {
        for trigger in self.triggers.values_mut() {
            trigger.count = 0;
        }
    }

    /// Build a runtime snapshot for UI sync.
    pub fn snapshot(&self) -> FlowSnapshot {
        let ports = self
            .ports
            .iter()
            .map(|(port_ref, state)| FlowPortRuntimeValue {
                node_id: port_ref.node_id,
                port_id: port_ref.port_id,
                port_version: state.version,
                value: state.value.clone(),
            })
            .collect();
        FlowSnapshot {
            flow_id: self.flow_id(),
            flow_version: self.flow_version(),
            ports,
        }
    }

    fn rebuild_ports(&mut self) {
        let mut connected_inputs = HashSet::new();
        for edge in &self.definition.edges {
            connected_inputs.insert(edge.to);
        }

        let mut next_ports = HashMap::new();
        for node in &self.definition.nodes {
            for port in &node.ports {
                let port_ref = FlowPortRef {
                    node_id: node.node_id,
                    port_id: port.port_id,
                };

                let has_input_edge = connected_inputs.contains(&port_ref);

                if let Some(existing) = self.ports.get(&port_ref) {
                    if existing.port_type == port.port_type {
                        if port.direction == FlowPortDirection::Input
                            && !has_input_edge
                            && port.default_value.is_some()
                        {
                            // Respect updated defaults for unconnected inputs.
                        } else {
                            next_ports.insert(port_ref, existing.clone());
                            continue;
                        }
                    }
                }

                if let Some(default_value) = &port.default_value {
                    if port.port_type.matches_value(default_value) {
                        next_ports.insert(
                            port_ref,
                            FlowPortState {
                                port_id: port.port_id,
                                port_type: port.port_type,
                                value: default_value.clone(),
                                version: 1, // Start at 1 for consistency with set_port_value_if_changed
                            },
                        );
                        continue;
                    }
                }

                if let Some(existing) = self.ports.get(&port_ref) {
                    if existing.port_type == port.port_type {
                        next_ports.insert(port_ref, existing.clone());
                    }
                }
            }
        }

        self.ports = next_ports;
        self.triggers.retain(|port, _| {
            self.definition
                .find_port(port.node_id, port.port_id)
                .is_some_and(|def| def.port_type == FlowPortType::Trigger)
        });
    }
}

/// Active flow instance in the ECS world.
#[derive(Component)]
pub struct FlowInstance {
    /// Flow id for lookup.
    pub flow_id: FlowId,
    /// Runtime state.
    pub runtime: FlowRuntime,
    /// Last sent port versions for delta streaming.
    pub last_sent_ports: HashMap<FlowPortRef, FlowPortVersion>,
    /// Last sent trigger sequence for delta streaming.
    pub last_sent_triggers: HashMap<FlowPortRef, FlowSeq>,
    /// Node instances keyed by node id.
    nodes: HashMap<FlowNodeId, FlowNodeInstance>,
    /// Last source-local evaluation position for deterministic time-based nodes.
    last_position: Duration,
    /// Cached selections for waveform FX nodes to allow release.
    waveform_selections: HashMap<FlowNodeId, HashSet<FixtureRef>>,
    /// Cached attribute labels for waveform FX nodes to allow release.
    waveform_attributes: HashMap<FlowNodeId, HashSet<String>>,
    /// Phase accumulator for waveform FX nodes (0..1).
    waveform_phases: HashMap<FlowNodeId, f32>,
    /// Runtime state for native FX-module nodes.
    #[cfg(feature = "fx-module")]
    fx_module_runtimes: HashMap<FlowNodeId, FlowFxModuleRuntime>,
    is_running: bool,
}

impl FlowInstance {
    /// Create a new flow instance from a definition.
    pub fn new(flow_id: FlowId, runtime: FlowRuntime, registry: &FlowNodeRegistry) -> Self {
        let mut instance = Self {
            flow_id,
            runtime,
            last_sent_ports: HashMap::new(),
            last_sent_triggers: HashMap::new(),
            nodes: HashMap::new(),
            last_position: Duration::ZERO,
            waveform_selections: HashMap::new(),
            waveform_attributes: HashMap::new(),
            waveform_phases: HashMap::new(),
            #[cfg(feature = "fx-module")]
            fx_module_runtimes: HashMap::new(),
            is_running: true,
        };
        instance.rebuild_nodes(registry);
        instance
    }

    pub(crate) fn is_running(&self) -> bool {
        self.is_running
    }

    pub(crate) fn stop(&mut self) {
        self.is_running = false;
        #[cfg(feature = "fx-module")]
        for (_, runtime) in self.fx_module_runtimes.drain() {
            let _ = teardown_fx_module_runtime(runtime);
        }
    }

    pub(crate) fn restart(&mut self) {
        self.is_running = true;
        self.last_position = Duration::ZERO;
        let ctx = FlowNodeContext {
            position: Duration::ZERO,
            frame_delta: Duration::ZERO,
        };
        for node in self.nodes.values_mut() {
            node.node.reset(&ctx);
            node.last_input_versions.clear();
            node.last_trigger_seq.clear();
            node.has_run = false;
        }
        self.waveform_phases.clear();
        #[cfg(feature = "fx-module")]
        for (_, runtime) in self.fx_module_runtimes.drain() {
            let _ = teardown_fx_module_runtime(runtime);
        }
    }

    pub(crate) fn reset_timing(&mut self) {
        self.last_position = Duration::ZERO;
        self.waveform_phases.clear();
        #[cfg(feature = "fx-module")]
        for (_, runtime) in self.fx_module_runtimes.drain() {
            let _ = teardown_fx_module_runtime(runtime);
        }
    }

    /// Rebuild node instances to match the current definition.
    pub fn rebuild_nodes(&mut self, registry: &FlowNodeRegistry) {
        let mut next_nodes = HashMap::new();
        for node_def in &self.runtime.definition.nodes {
            let reuse = self
                .nodes
                .remove(&node_def.node_id)
                .filter(|existing| existing.kind == node_def.kind);

            let instance = if let Some(mut existing) = reuse {
                existing.last_input_versions.clear();
                existing.last_trigger_seq.clear();
                existing.has_run = false;
                existing
            } else {
                let Some(node) = registry.create(&node_def.kind) else {
                    tracing::warn!("Flow node kind '{}' is not registered", node_def.kind);
                    continue;
                };
                FlowNodeInstance {
                    kind: node_def.kind.clone(),
                    node,
                    last_input_versions: HashMap::new(),
                    last_trigger_seq: HashMap::new(),
                    has_run: false,
                }
            };

            next_nodes.insert(node_def.node_id, instance);
        }

        self.nodes = next_nodes;
    }
}

/// Keeps generic playback runtime status in sync with active flow elapsed time.
pub fn sync_flow_playback_runtime_status(
    mut query: Query<(Option<&InstanceClock>, &mut InstanceStatus), With<FlowInstance>>,
) {
    for (clock, mut status) in query.iter_mut() {
        let elapsed = clock.map(|clock| clock.position).unwrap_or_default();
        status.position = InstancePosition::Time { elapsed };
        status.transition_elapsed = Some(elapsed);
    }
}

/// Node instance bookkeeping for change detection.
struct FlowNodeInstance {
    kind: String,
    node: Box<dyn FlowNode>,
    last_input_versions: HashMap<FlowPortId, FlowPortVersion>,
    last_trigger_seq: HashMap<FlowPortId, FlowSeq>,
    has_run: bool,
}

/// Evaluate node graphs and update runtime port values/triggers.
pub fn evaluate_flow_instances(
    mut commands: Commands,
    mut instances: Query<(Entity, &mut FlowInstance, Option<&InstanceClock>)>,
    registry: Res<FlowNodeRegistry>,
    #[cfg(feature = "fx-module")] fx_module_data_provider: Option<
        Res<DataProvider<StoredFxModule>>,
    >,
    selection_resolver: SpatialSelectionResolver,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    mut clip_events: MessageWriter<RequestEnvelope<ClipInstanceRequest>>,
    mut timecode_actions: MessageWriter<EngineActionEnvelope<TimecodeAction>>,
) {
    for (entity, mut instance, clock) in instances.iter_mut() {
        if !instance.is_running {
            continue;
        }
        #[cfg(feature = "fx-module")]
        let playback_position = clock.map(|clock| clock.position);
        let (evaluation_position, frame_delta) = if let Some(clock) = clock {
            instance.last_position = clock.position;
            (clock.position, clock.delta)
        } else {
            (Duration::ZERO, Duration::ZERO)
        };
        let flow_id = instance.runtime.flow_id();

        let definition = instance.runtime.definition.clone();
        let edges_by_input = build_edge_sources(&definition.edges);
        let node_lookup: HashMap<FlowNodeId, &FlowNodeDefinition> = definition
            .nodes
            .iter()
            .map(|node| (node.node_id, node))
            .collect();
        let layer_output_sources: HashSet<FlowNodeId> = definition
            .edges
            .iter()
            .filter(|edge| {
                node_lookup
                    .get(&edge.to.node_id)
                    .map(|target| target.kind == RENDER_LAYER_KIND)
                    .unwrap_or(false)
            })
            .filter(|edge| {
                node_lookup
                    .get(&edge.from.node_id)
                    .and_then(|source| {
                        source
                            .ports
                            .iter()
                            .find(|port| port.port_id == edge.from.port_id)
                    })
                    .map(|port| port.port_type == FlowPortType::Layer)
                    .unwrap_or(false)
            })
            .map(|edge| edge.from.node_id)
            .collect();
        let ordered_nodes = order_nodes(&definition);
        let ctx = FlowNodeContext {
            position: evaluation_position,
            frame_delta,
        };

        let mut flow_layer = Layer::new(
            instance.runtime.definition.identifiers.label.clone(),
            Priority::default(),
        );
        let mut has_layer = false;

        let mut nodes = std::mem::take(&mut instance.nodes);
        let mut waveform_selections = std::mem::take(&mut instance.waveform_selections);
        let mut waveform_attributes = std::mem::take(&mut instance.waveform_attributes);
        let mut waveform_phases = std::mem::take(&mut instance.waveform_phases);
        #[cfg(feature = "fx-module")]
        let mut fx_module_runtimes = std::mem::take(&mut instance.fx_module_runtimes);
        {
            let runtime = &mut instance.runtime;
            for node_def in ordered_nodes {
                let needs_rebuild = match nodes.get(&node_def.node_id) {
                    Some(existing) => existing.kind != node_def.kind,
                    None => true,
                };
                if needs_rebuild {
                    let Some(node) = registry.create(&node_def.kind) else {
                        tracing::warn!("Flow node kind '{}' is not registered", node_def.kind);
                        continue;
                    };
                    nodes.insert(
                        node_def.node_id,
                        FlowNodeInstance {
                            kind: node_def.kind.clone(),
                            node,
                            last_input_versions: HashMap::new(),
                            last_trigger_seq: HashMap::new(),
                            has_run: false,
                        },
                    );
                }

                let Some(node_instance) = nodes.get_mut(&node_def.node_id) else {
                    continue;
                };

                let (inputs, input_versions) =
                    build_input_values(runtime, node_def, &edges_by_input);
                let (input_triggers, trigger_seqs) =
                    build_input_triggers(runtime, node_def, &edges_by_input);

                let should_run = if node_instance.node.is_pure() {
                    !node_instance.has_run
                        || node_instance.last_input_versions != input_versions
                        || node_instance.last_trigger_seq != trigger_seqs
                } else {
                    true
                };

                if !should_run {
                    continue;
                }

                let mut outputs = HashMap::new();
                let mut output_triggers = HashMap::new();

                if let Err(err) = node_instance.node.execute(
                    &inputs,
                    &mut outputs,
                    &input_triggers,
                    &mut output_triggers,
                    &ctx,
                ) {
                    tracing::warn!("Flow node {} execution failed: {}", node_def.node_id, err);
                }

                if node_def.kind == WAVEFORM_FX_KIND
                    && layer_output_sources.contains(&node_def.node_id)
                {
                    let layer_creator =
                        format_flow_layer_creator(flow_id, node_def.node_id, &node_def.label);
                    if let Some(layer) = build_waveform_layer(
                        node_def,
                        frame_delta,
                        &inputs,
                        &selection_resolver,
                        &fixture_data_provider,
                        &mut waveform_selections,
                        &mut waveform_attributes,
                        &mut waveform_phases,
                        &layer_creator,
                    ) {
                        flow_layer.squash(layer);
                        has_layer = true;
                    }
                }
                #[cfg(feature = "fx-module")]
                if node_def.kind == FX_MODULE_KIND
                    && layer_output_sources.contains(&node_def.node_id)
                {
                    if let Some(fx_module_data_provider) = fx_module_data_provider.as_deref() {
                        if let Some(layer) = build_fx_module_layer(
                            node_def,
                            &inputs,
                            &selection_resolver,
                            fx_module_data_provider,
                            &fixture_data_provider,
                            &mut fx_module_runtimes,
                            evaluation_position,
                            playback_position,
                            clock.map(|_| frame_delta),
                        ) {
                            flow_layer.squash(layer);
                            has_layer = true;
                        }
                    }
                }

                dispatch_action_commands(
                    node_def,
                    &inputs,
                    &input_triggers,
                    &mut clip_events,
                    &mut timecode_actions,
                );
                apply_output_values(runtime, node_def, outputs, output_triggers);

                node_instance.last_input_versions = input_versions;
                node_instance.last_trigger_seq = trigger_seqs;
                node_instance.has_run = true;
            }
        }
        instance.nodes = nodes;
        instance.waveform_selections = waveform_selections;
        instance.waveform_attributes = waveform_attributes;
        instance.waveform_phases = waveform_phases;
        #[cfg(feature = "fx-module")]
        let active_fx_module_nodes: HashSet<FlowNodeId> = definition
            .nodes
            .iter()
            .filter(|node| {
                node.kind == FX_MODULE_KIND && layer_output_sources.contains(&node.node_id)
            })
            .map(|node| node.node_id)
            .collect();
        #[cfg(feature = "fx-module")]
        let stale_fx_module_nodes: Vec<FlowNodeId> = fx_module_runtimes
            .keys()
            .copied()
            .filter(|node_id| !active_fx_module_nodes.contains(node_id))
            .collect();
        #[cfg(feature = "fx-module")]
        for node_id in stale_fx_module_nodes {
            if let Some(runtime) = fx_module_runtimes.remove(&node_id) {
                let _ = teardown_fx_module_runtime(runtime);
            }
        }
        #[cfg(feature = "fx-module")]
        {
            instance.fx_module_runtimes = fx_module_runtimes;
        }

        if has_layer {
            let marker = ObjectRefMarker(ObjectRef::ByUid {
                object_type: ObjectType::Flow,
                uid: instance.runtime.definition.identifiers.uid,
            });
            let mut entity_commands = commands.entity(entity);
            entity_commands.insert((flow_layer, marker));
            if let Some(clock) = clock {
                entity_commands.insert(LayerCompositingContext {
                    position: clock.position,
                    released_at: None,
                });
            } else {
                entity_commands.remove::<LayerCompositingContext>();
            }
        } else {
            commands.entity(entity).remove::<Layer>();
            commands.entity(entity).remove::<ObjectRefMarker>();
            commands.entity(entity).remove::<LayerCompositingContext>();
        }
    }
}

/// Publish port value and trigger deltas for all active flow instances.
pub fn publish_runtime_deltas(
    mut instances: Query<&mut FlowInstance>,
    broadcaster: Res<ClientEventSink>,
) {
    for mut instance in instances.iter_mut() {
        let flow_id = instance.runtime.flow_id();
        let flow_version = instance.runtime.flow_version();

        let port_updates: Vec<(FlowPortRef, FlowPortVersion)> = {
            let mut updates = Vec::new();
            for (port_ref, state) in instance.runtime.ports.iter() {
                let last = instance.last_sent_ports.get(port_ref).copied().unwrap_or(0);
                if state.version > last {
                    let delta = FlowPortValueDelta {
                        flow_id,
                        flow_version,
                        node_id: port_ref.node_id,
                        port_id: port_ref.port_id,
                        port_version: state.version,
                        value: state.value.clone(),
                    };
                    broadcaster.publish(
                        DISCRIMINATOR_NON_DROPPABLE,
                        &FlowWsMessage::FlowPortValueDelta(&delta),
                    );
                    updates.push((*port_ref, state.version));
                }
            }
            updates
        };

        for (port_ref, version) in port_updates {
            instance.last_sent_ports.insert(port_ref, version);
        }

        let trigger_updates: Vec<(FlowPortRef, FlowSeq)> = {
            let mut updates = Vec::new();
            for (port_ref, trigger) in instance.runtime.triggers.iter() {
                let last = instance
                    .last_sent_triggers
                    .get(port_ref)
                    .copied()
                    .unwrap_or(0);
                if trigger.seq != last && trigger.count > 0 {
                    let delta = FlowTriggerDelta {
                        flow_id,
                        flow_version,
                        node_id: port_ref.node_id,
                        port_id: port_ref.port_id,
                        seq: trigger.seq,
                        count: trigger.count,
                    };
                    broadcaster.publish(
                        DISCRIMINATOR_NON_DROPPABLE,
                        &FlowWsMessage::FlowTriggerDelta(&delta),
                    );
                    updates.push((*port_ref, trigger.seq));
                }
            }
            updates
        };

        for (port_ref, seq) in trigger_updates {
            instance.last_sent_triggers.insert(port_ref, seq);
        }

        instance.runtime.clear_trigger_counts();
    }
}

/// Port state held by the runtime.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FlowPortState {
    /// Port id.
    pub port_id: FlowPortId,
    /// Port type.
    pub port_type: FlowPortType,
    /// Current value.
    pub value: FlowValue,
    /// Port version.
    pub version: FlowPortVersion,
}

/// Trigger state held by the runtime.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FlowTriggerState {
    /// Event sequence.
    pub seq: FlowSeq,
    /// Count of events since last evaluation.
    pub count: u32,
}

/// Result of applying a delta to the runtime.
#[derive(Clone, Debug, PartialEq)]
pub struct FlowDeltaApplyResult {
    /// Updated flow version.
    pub applied_version: FlowVersion,
    /// Collected errors, if any.
    pub errors: Vec<crate::protocol::FlowDeltaError>,
}

fn build_edge_sources(edges: &[FlowEdgeDefinition]) -> HashMap<FlowPortRef, Vec<FlowPortRef>> {
    let mut sources: HashMap<FlowPortRef, Vec<FlowPortRef>> = HashMap::new();
    for edge in edges {
        sources.entry(edge.to).or_default().push(edge.from);
    }
    sources
}

fn order_nodes(definition: &FlowDefinition) -> Vec<&FlowNodeDefinition> {
    let mut indegree: HashMap<FlowNodeId, usize> = HashMap::new();
    let mut outgoing: HashMap<FlowNodeId, Vec<FlowNodeId>> = HashMap::new();
    let mut node_lookup: HashMap<FlowNodeId, &FlowNodeDefinition> = HashMap::new();

    for node in &definition.nodes {
        indegree.insert(node.node_id, 0);
        node_lookup.insert(node.node_id, node);
    }

    for edge in &definition.edges {
        let from = edge.from.node_id;
        let to = edge.to.node_id;
        if from == to {
            continue;
        }
        outgoing.entry(from).or_default().push(to);
        if let Some(entry) = indegree.get_mut(&to) {
            *entry += 1;
        }
    }

    let mut queue = VecDeque::new();
    for node in &definition.nodes {
        if indegree.get(&node.node_id).copied().unwrap_or(0) == 0 {
            queue.push_back(node.node_id);
        }
    }

    let mut ordered_ids = Vec::with_capacity(definition.nodes.len());
    let mut seen = HashSet::new();
    while let Some(node_id) = queue.pop_front() {
        if !seen.insert(node_id) {
            continue;
        }
        ordered_ids.push(node_id);
        if let Some(children) = outgoing.get(&node_id) {
            for child in children {
                if let Some(entry) = indegree.get_mut(child) {
                    if *entry > 0 {
                        *entry -= 1;
                        if *entry == 0 {
                            queue.push_back(*child);
                        }
                    }
                }
            }
        }
    }

    if ordered_ids.len() < definition.nodes.len() {
        for node in &definition.nodes {
            if seen.insert(node.node_id) {
                ordered_ids.push(node.node_id);
            }
        }
    }

    ordered_ids
        .into_iter()
        .filter_map(|node_id| node_lookup.get(&node_id).copied())
        .collect()
}

fn build_input_values(
    runtime: &mut FlowRuntime,
    node_def: &FlowNodeDefinition,
    edges_by_input: &HashMap<FlowPortRef, Vec<FlowPortRef>>,
) -> (FlowPortValues, HashMap<FlowPortId, FlowPortVersion>) {
    let mut inputs = HashMap::new();
    let mut versions = HashMap::new();

    for port in node_def
        .ports
        .iter()
        .filter(|port| port.direction == FlowPortDirection::Input)
    {
        if port.port_type == FlowPortType::Trigger {
            continue;
        }

        let port_ref = FlowPortRef {
            node_id: node_def.node_id,
            port_id: port.port_id,
        };

        let value = edges_by_input
            .get(&port_ref)
            .and_then(|sources| {
                if sources.len() > 1 {
                    tracing::warn!(
                        "Flow node {} port {} has multiple input sources",
                        node_def.node_id,
                        port.port_id
                    );
                }
                sources.iter().find_map(|source| {
                    runtime.ports.get(source).and_then(|state| {
                        port.port_type
                            .matches_value(&state.value)
                            .then(|| state.value.clone())
                    })
                })
            })
            .or_else(|| {
                runtime.ports.get(&port_ref).and_then(|state| {
                    port.port_type
                        .matches_value(&state.value)
                        .then(|| state.value.clone())
                })
            })
            .or_else(|| {
                port.default_value
                    .as_ref()
                    .filter(|value| port.port_type.matches_value(value))
                    .cloned()
            });

        if let Some(value) = value {
            if let Err(err) = runtime.set_port_value_if_changed(port_ref, value.clone()) {
                tracing::warn!(
                    "Failed to set input value for node {} port {}: {}",
                    node_def.node_id,
                    port.port_id,
                    err
                );
                continue;
            }

            if let Some(state) = runtime.ports.get(&port_ref) {
                versions.insert(port.port_id, state.version);
            }
            inputs.insert(port.port_id, value);
        }
    }

    (inputs, versions)
}

fn build_input_triggers(
    runtime: &mut FlowRuntime,
    node_def: &FlowNodeDefinition,
    edges_by_input: &HashMap<FlowPortRef, Vec<FlowPortRef>>,
) -> (FlowTriggerValues, HashMap<FlowPortId, FlowSeq>) {
    let mut triggers = HashMap::new();
    let mut sequences = HashMap::new();

    for port in node_def
        .ports
        .iter()
        .filter(|port| port.direction == FlowPortDirection::Input)
    {
        if port.port_type != FlowPortType::Trigger {
            continue;
        }

        let port_ref = FlowPortRef {
            node_id: node_def.node_id,
            port_id: port.port_id,
        };

        let mut seq = 0;
        let mut count: u32 = 0;

        if let Some(sources) = edges_by_input.get(&port_ref) {
            if sources.len() > 1 {
                tracing::warn!(
                    "Flow node {} trigger port {} has multiple input sources",
                    node_def.node_id,
                    port.port_id
                );
            }
            for source in sources {
                if let Some(state) = runtime.triggers.get(source) {
                    seq = seq.max(state.seq);
                    count = count.saturating_add(state.count);
                }
            }
        }

        let trigger_state = FlowTriggerState { seq, count };
        triggers.insert(port.port_id, trigger_state);
        sequences.insert(port.port_id, seq);

        if count > 0 {
            if let Err(err) = runtime.emit_trigger_count(port_ref, count) {
                tracing::warn!(
                    "Failed to emit trigger for node {} port {}: {}",
                    node_def.node_id,
                    port.port_id,
                    err
                );
            }
        }
    }

    (triggers, sequences)
}

fn apply_output_values(
    runtime: &mut FlowRuntime,
    node_def: &FlowNodeDefinition,
    outputs: FlowPortValues,
    output_triggers: FlowTriggerValues,
) {
    for (port_id, value) in outputs {
        let Some(port_def) = find_port_definition(node_def, port_id) else {
            tracing::warn!(
                "Flow node {} output {} is not a defined port",
                node_def.node_id,
                port_id
            );
            continue;
        };
        if port_def.direction != FlowPortDirection::Output
            || port_def.port_type == FlowPortType::Trigger
        {
            tracing::warn!(
                "Flow node {} output {} targets a non-output port",
                node_def.node_id,
                port_id
            );
            continue;
        }

        let port_ref = FlowPortRef {
            node_id: node_def.node_id,
            port_id,
        };

        if let Err(err) = runtime.set_port_value_if_changed(port_ref, value) {
            tracing::warn!(
                "Failed to set output value for node {} port {}: {}",
                node_def.node_id,
                port_id,
                err
            );
        }
    }

    for (port_id, trigger_state) in output_triggers {
        if trigger_state.count == 0 {
            continue;
        }

        let Some(port_def) = find_port_definition(node_def, port_id) else {
            tracing::warn!(
                "Flow node {} trigger {} is not a defined port",
                node_def.node_id,
                port_id
            );
            continue;
        };
        if port_def.direction != FlowPortDirection::Output
            || port_def.port_type != FlowPortType::Trigger
        {
            tracing::warn!(
                "Flow node {} trigger {} targets a non-trigger output port",
                node_def.node_id,
                port_id
            );
            continue;
        }

        let port_ref = FlowPortRef {
            node_id: node_def.node_id,
            port_id,
        };

        if let Err(err) = runtime.emit_trigger_count(port_ref, trigger_state.count) {
            tracing::warn!(
                "Failed to emit trigger for node {} port {}: {}",
                node_def.node_id,
                port_id,
                err
            );
        }
    }
}

fn format_flow_layer_creator(flow_id: FlowId, node_id: FlowNodeId, label: &str) -> String {
    format!("Flow {} · Node {} · {}", flow_id, node_id, label)
}

fn dispatch_action_commands(
    node_def: &FlowNodeDefinition,
    inputs: &FlowPortValues,
    input_triggers: &FlowTriggerValues,
    clip_events: &mut MessageWriter<RequestEnvelope<ClipInstanceRequest>>,
    timecode_actions: &mut MessageWriter<EngineActionEnvelope<TimecodeAction>>,
) {
    match node_def.kind.as_str() {
        CLIP_ACTION_KIND => dispatch_clip_action(inputs, input_triggers, clip_events),
        TIMECODE_ACTION_KIND => dispatch_timecode_action(inputs, input_triggers, timecode_actions),
        _ => {}
    }
}

fn dispatch_clip_action(
    inputs: &FlowPortValues,
    input_triggers: &FlowTriggerValues,
    clip_events: &mut MessageWriter<RequestEnvelope<ClipInstanceRequest>>,
) {
    let count = input_triggers
        .get(&CLIP_IN_TRIGGER)
        .map(|trigger| trigger.count)
        .unwrap_or(0);
    if count == 0 {
        return;
    }

    let id = int_input_or(inputs, CLIP_IN_ID, 1);
    if id <= 0 {
        tracing::warn!("Clip action node has invalid clip id {}", id);
        return;
    }
    let id = id as u32;

    let action = string_input_or(inputs, CLIP_IN_ACTION, "start");
    let action = action.trim().to_ascii_lowercase();
    match action.as_str() {
        "start" | "on" => {
            clip_events.write(RequestEnvelope::detached(ClipInstanceRequest::Start(
                IdExpr::Single(id),
            )));
        }
        "stop" | "off" => {
            clip_events.write(RequestEnvelope::detached(ClipInstanceRequest::Stop(
                IdExpr::Single(id),
            )));
        }
        "go" | "next" => {
            for _ in 0..count {
                clip_events.write(RequestEnvelope::detached(ClipInstanceRequest::Go(
                    IdExpr::Single(id),
                )));
            }
        }
        other => {
            tracing::warn!("Clip action node has unknown action '{}'", other);
        }
    }
}

fn dispatch_timecode_action(
    inputs: &FlowPortValues,
    input_triggers: &FlowTriggerValues,
    timecode_actions: &mut MessageWriter<EngineActionEnvelope<TimecodeAction>>,
) {
    let count = input_triggers
        .get(&TIMECODE_IN_TRIGGER)
        .map(|trigger| trigger.count)
        .unwrap_or(0);
    if count == 0 {
        return;
    }

    let id = int_input_or(inputs, TIMECODE_IN_ID, 1);
    if id <= 0 {
        tracing::warn!("Timecode action node has invalid timecode id {}", id);
        return;
    }
    let id = id as u32;

    let action = string_input_or(inputs, TIMECODE_IN_ACTION, "start");
    let action = action.trim().to_ascii_lowercase();
    match action.as_str() {
        "start" | "on" => {
            timecode_actions.write(EngineActionEnvelope::detached(TimecodeAction::Start(id)));
        }
        "stop" | "off" => {
            timecode_actions.write(EngineActionEnvelope::detached(TimecodeAction::Stop(id)));
        }
        "pause" => {
            timecode_actions.write(EngineActionEnvelope::detached(TimecodeAction::Pause(id)));
        }
        other => {
            tracing::warn!("Timecode action node has unknown action '{}'", other);
        }
    }
}

fn int_input_or(inputs: &FlowPortValues, port_id: FlowPortId, fallback: i32) -> i32 {
    match inputs.get(&port_id) {
        Some(FlowValue::Int(value)) => *value,
        _ => fallback,
    }
}

fn string_input_or(inputs: &FlowPortValues, port_id: FlowPortId, fallback: &str) -> String {
    match inputs.get(&port_id) {
        Some(FlowValue::String(value)) => value.clone(),
        _ => fallback.to_string(),
    }
}

fn find_port_definition(
    node_def: &FlowNodeDefinition,
    port_id: FlowPortId,
) -> Option<&FlowPortDefinition> {
    node_def.ports.iter().find(|port| port.port_id == port_id)
}

#[cfg(test)]
mod tests {
    use std::{
        path::Path,
        process::Command,
        sync::{Mutex, OnceLock},
        time::Duration,
    };

    use bevy_app::{App, Update};
    use moonshine_kind::prelude::Instance;
    use nightfall_dmx::prelude::{Attribute, ParameterValue};
    use nightfall_fixtures::prelude::{FixtureElement, Parameter, ParameterMetadata};
    use uuid::Uuid;
    use wit_component::ComponentEncoder;

    use super::*;
    use crate::builtin_nodes::register_builtin_nodes;
    use crate::builtin_nodes::{
        FX_MODULE_IN_ID, FX_MODULE_IN_SELECTION, FX_MODULE_KIND, FX_MODULE_OUT_LAYER,
        RENDER_LAYER_IN_LAYER, RENDER_LAYER_KIND,
    };

    /// Verifies flow runtime status reports playback-clock elapsed when available.
    #[test]
    fn sync_flow_status_uses_instance_clock_position() {
        let mut app = App::new();
        let registry = FlowNodeRegistry::default();
        let definition = FlowDefinition::new(Identifiers {
            id: 3,
            uid: Uuid::new_v4(),
            label: "Clocked Flow".to_string(),
        });
        let instance = FlowInstance::new(3, FlowRuntime::new(definition), &registry);
        let mut clock = InstanceClock {
            source: InstanceClockSource::ExternalPosition,
            ..Default::default()
        };
        clock.seek_to(Duration::from_millis(875));

        app.world_mut()
            .spawn((instance, clock, InstanceStatus::default()));
        app.add_systems(Update, sync_flow_playback_runtime_status);
        app.update();

        let mut status_query = app.world_mut().query::<&InstanceStatus>();
        let status = status_query
            .single(app.world())
            .expect("flow status should exist");
        assert_eq!(
            status.position,
            InstancePosition::Time {
                elapsed: Duration::from_millis(875)
            }
        );
    }

    /// Verifies unclocked flow runtime status does not advance from host start time.
    #[test]
    fn sync_flow_status_without_clock_uses_zero_elapsed() {
        let mut app = App::new();
        let registry = FlowNodeRegistry::default();
        let definition = FlowDefinition::new(Identifiers {
            id: 3,
            uid: Uuid::new_v4(),
            label: "Unclocked Flow".to_string(),
        });
        let instance = FlowInstance::new(3, FlowRuntime::new(definition), &registry);

        app.world_mut().spawn((instance, InstanceStatus::default()));
        app.add_systems(Update, sync_flow_playback_runtime_status);
        app.update();

        let mut status_query = app.world_mut().query::<&InstanceStatus>();
        let status = status_query
            .single(app.world())
            .expect("flow status should exist");
        assert_eq!(
            status.position,
            InstancePosition::Time {
                elapsed: Duration::ZERO
            }
        );
    }

    /// Verifies invalid edge values do not repeatedly rewrite mismatched input ports.
    #[test]
    fn mismatched_input_edge_uses_existing_typed_input_value() {
        let source_ref = FlowPortRef {
            node_id: 1,
            port_id: 1,
        };
        let target_ref = FlowPortRef {
            node_id: 2,
            port_id: 1,
        };
        let definition = FlowDefinition {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "Mismatched Edge".to_string(),
            },
            flow_version: 1,
            nodes: vec![
                FlowNodeDefinition {
                    node_id: source_ref.node_id,
                    kind: "source".to_string(),
                    label: "Source".to_string(),
                    ports: vec![FlowPortDefinition {
                        port_id: source_ref.port_id,
                        name: "number".to_string(),
                        direction: FlowPortDirection::Output,
                        port_type: FlowPortType::Number,
                        default_value: Some(FlowValue::Number(1.0)),
                        ..Default::default()
                    }],
                    position: None,
                },
                FlowNodeDefinition {
                    node_id: target_ref.node_id,
                    kind: "target".to_string(),
                    label: "Target".to_string(),
                    ports: vec![FlowPortDefinition {
                        port_id: target_ref.port_id,
                        name: "text".to_string(),
                        direction: FlowPortDirection::Input,
                        port_type: FlowPortType::String,
                        default_value: Some(FlowValue::String("fallback".to_string())),
                        ..Default::default()
                    }],
                    position: None,
                },
            ],
            edges: vec![FlowEdgeDefinition {
                from: source_ref,
                to: target_ref,
            }],
        };
        let mut runtime = FlowRuntime::new(definition);
        runtime
            .set_port_value(source_ref, FlowValue::Number(2.0))
            .expect("source number output should accept number values");
        let target = runtime
            .definition
            .nodes
            .iter()
            .find(|node| node.node_id == target_ref.node_id)
            .expect("target node should exist")
            .clone();
        let edges_by_input = build_edge_sources(&runtime.definition.edges);

        let (first_inputs, first_versions) =
            build_input_values(&mut runtime, &target, &edges_by_input);
        let (second_inputs, second_versions) =
            build_input_values(&mut runtime, &target, &edges_by_input);

        assert_eq!(
            first_inputs.get(&target_ref.port_id),
            Some(&FlowValue::String("fallback".to_string()))
        );
        assert_eq!(first_inputs, second_inputs);
        assert_eq!(first_versions, second_versions);
        assert_eq!(
            runtime.ports.get(&target_ref).map(|state| &state.value),
            Some(&FlowValue::String("fallback".to_string()))
        );
    }

    #[test]
    fn fx_module_flow_node_renders_layer_with_selection_override() {
        with_test_module_data_dir("sparkle", || {
            let mut app = setup_flow_fx_module_app();

            app.update();
            let (parameter, value) = flow_layer_output(&mut app);
            assert_eq!(value, 5.0);

            let fixture_parameters = fixture_parameters(&mut app);
            assert_eq!(parameter, fixture_parameters[1]);
            assert_ne!(parameter, fixture_parameters[0]);

            app.update();
            let (parameter, value) = flow_layer_output(&mut app);
            assert_eq!(parameter, fixture_parameters[1]);
            assert_eq!(value, 6.0);
        });
    }

    /// Verifies clocked flow layers expose playback-clock transition timing to the compositor.
    #[test]
    fn flow_layer_mirrors_instance_clock_to_layer_compositing_context() {
        with_test_module_data_dir("sparkle", || {
            let mut app = setup_flow_fx_module_app();
            let mut clock = InstanceClock {
                source: InstanceClockSource::ExternalPosition,
                ..Default::default()
            };
            clock.seek_to(Duration::from_millis(333));
            let entity = app
                .world_mut()
                .query_filtered::<Entity, With<FlowInstance>>()
                .single(app.world())
                .expect("flow instance entity should exist");
            app.world_mut().entity_mut(entity).insert(clock);

            app.update();

            let compositing_context = app
                .world_mut()
                .query::<&LayerCompositingContext>()
                .single(app.world())
                .expect("flow layer should expose playback-clock transition timing");
            assert_eq!(compositing_context.position, Duration::from_millis(333));
            assert_eq!(compositing_context.released_at, None);
        });
    }

    /// Verifies nested FX module nodes render from the flow playback-clock position.
    #[test]
    fn fx_module_flow_node_uses_instance_clock_for_elapsed_time() {
        with_test_module_data_dir("sparkle", || {
            let mut app = setup_flow_fx_module_app();
            let mut definition = app
                .world()
                .resource::<DataProvider<StoredFxModule>>()
                .from_id(1)
                .expect("stored fx module should exist")
                .clone();
            definition.config =
                HashMap::from([(String::from("mode"), String::from("elapsed-millis"))]);
            app.world_mut()
                .resource_mut::<DataProvider<StoredFxModule>>()
                .add(definition)
                .expect("fx module config update should keep the same uid");

            let mut clock = InstanceClock {
                source: InstanceClockSource::ExternalPosition,
                ..Default::default()
            };
            clock.seek_to(Duration::from_millis(333));
            let entity = app
                .world_mut()
                .query_filtered::<Entity, With<FlowInstance>>()
                .single(app.world())
                .expect("flow instance entity should exist");
            app.world_mut().entity_mut(entity).insert(clock);

            app.update();

            let (_, value) = flow_layer_output(&mut app);
            assert_eq!(value, 333.0);
        });
    }

    /// Verifies nested FX module nodes render from the flow playback-clock delta.
    #[test]
    fn fx_module_flow_node_uses_instance_clock_for_frame_delta() {
        with_test_module_data_dir("sparkle", || {
            let mut app = setup_flow_fx_module_app();
            let mut definition = app
                .world()
                .resource::<DataProvider<StoredFxModule>>()
                .from_id(1)
                .expect("stored fx module should exist")
                .clone();
            definition.config =
                HashMap::from([(String::from("mode"), String::from("delta-millis"))]);
            app.world_mut()
                .resource_mut::<DataProvider<StoredFxModule>>()
                .add(definition)
                .expect("fx module config update should keep the same uid");

            let clock = InstanceClock {
                source: InstanceClockSource::ExternalPosition,
                position: Duration::from_millis(333),
                previous_position: Duration::from_millis(316),
                delta: Duration::from_millis(17),
                ..Default::default()
            };
            let entity = app
                .world_mut()
                .query_filtered::<Entity, With<FlowInstance>>()
                .single(app.world())
                .expect("flow instance entity should exist");
            app.world_mut().entity_mut(entity).insert(clock);

            app.update();

            let (_, value) = flow_layer_output(&mut app);
            assert_eq!(value, 17.0);
        });
    }

    /// Verifies unclocked flow evaluation uses zero frame delta.
    #[test]
    fn fx_module_flow_node_without_clock_uses_zero_frame_delta() {
        with_test_module_data_dir("sparkle", || {
            let mut app = setup_flow_fx_module_app();
            let mut definition = app
                .world()
                .resource::<DataProvider<StoredFxModule>>()
                .from_id(1)
                .expect("stored fx module should exist")
                .clone();
            definition.config =
                HashMap::from([(String::from("mode"), String::from("delta-millis"))]);
            app.world_mut()
                .resource_mut::<DataProvider<StoredFxModule>>()
                .add(definition)
                .expect("fx module config update should keep the same uid");

            app.update();

            let (_, value) = flow_layer_output(&mut app);
            assert_eq!(value, 0.0);
        });
    }

    #[test]
    fn fx_module_runtime_is_recreated_after_layer_edge_is_restored() {
        with_test_module_data_dir("sparkle", || {
            let mut app = setup_flow_fx_module_app();

            app.update();
            let (_, initial_value) = flow_layer_output(&mut app);
            assert_eq!(initial_value, 5.0);
            assert_eq!(fx_module_runtime_count(&mut app), 1);

            {
                let mut query = app.world_mut().query::<&mut FlowInstance>();
                let mut instance = query
                    .single_mut(app.world_mut())
                    .expect("flow instance should exist");
                instance.runtime.definition.edges.clear();
            }

            app.update();
            assert_eq!(fx_module_runtime_count(&mut app), 0);
            assert_eq!(flow_layer_count(&mut app), 0);

            {
                let mut query = app.world_mut().query::<&mut FlowInstance>();
                let mut instance = query
                    .single_mut(app.world_mut())
                    .expect("flow instance should exist");
                instance.runtime.definition.edges.push(FlowEdgeDefinition {
                    from: FlowPortRef {
                        node_id: 10,
                        port_id: FX_MODULE_OUT_LAYER,
                    },
                    to: FlowPortRef {
                        node_id: 11,
                        port_id: RENDER_LAYER_IN_LAYER,
                    },
                });
            }

            app.update();
            let (_, restarted_value) = flow_layer_output(&mut app);
            assert_eq!(restarted_value, 5.0);
            assert_eq!(fx_module_runtime_count(&mut app), 1);
        });
    }

    fn setup_flow_fx_module_app() -> App {
        let mut app = App::new();
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(DataProvider::<Group>::default());
        app.insert_resource(DataProvider::<StoredFxModule>::default());
        app.insert_resource(Messages::<RequestEnvelope<ClipInstanceRequest>>::default());
        app.insert_resource(Messages::<EngineActionEnvelope<TimecodeAction>>::default());

        let mut registry = FlowNodeRegistry::default();
        register_builtin_nodes(&mut registry).expect("register builtin nodes");
        app.insert_resource(registry);
        app.add_systems(Update, evaluate_flow_instances);

        let fixture_one_uid = Uuid::new_v4();
        let fixture_two_uid = Uuid::new_v4();
        let parameter_one = spawn_parameter(app.world_mut(), Attribute::Intensity);
        let parameter_two = spawn_parameter(app.world_mut(), Attribute::Intensity);
        seed_fixture_provider(
            app.world_mut(),
            Fixture {
                identifiers: Identifiers {
                    id: 1,
                    uid: fixture_one_uid,
                    label: "fixture-1".to_string(),
                },
                elements: vec![FixtureElement {
                    label: "Element 1".to_string(),
                    parameters: vec![ParameterMetadata {
                        attribute: Attribute::Intensity,
                        native_unit: Attribute::Intensity.native_unit(),
                        value_polarity: Attribute::Intensity.value_polarity(),
                        ..Default::default()
                    }],
                }],
                ..Default::default()
            },
            vec![(
                FixtureRef {
                    fixture_uid: fixture_one_uid,
                    index: Some(1),
                },
                Attribute::Intensity,
                parameter_one,
            )],
        );
        seed_fixture_provider(
            app.world_mut(),
            Fixture {
                identifiers: Identifiers {
                    id: 2,
                    uid: fixture_two_uid,
                    label: "fixture-2".to_string(),
                },
                elements: vec![FixtureElement {
                    label: "Element 1".to_string(),
                    parameters: vec![ParameterMetadata {
                        attribute: Attribute::Intensity,
                        native_unit: Attribute::Intensity.native_unit(),
                        value_polarity: Attribute::Intensity.value_polarity(),
                        ..Default::default()
                    }],
                }],
                ..Default::default()
            },
            vec![(
                FixtureRef {
                    fixture_uid: fixture_two_uid,
                    index: Some(1),
                },
                Attribute::Intensity,
                parameter_two,
            )],
        );

        app.world_mut()
            .resource_mut::<DataProvider<StoredFxModule>>()
            .add(StoredFxModule {
                identifiers: Identifiers {
                    id: 1,
                    uid: Uuid::new_v4(),
                    label: "sparkle".to_string(),
                },
                module_name: "sparkle".to_string(),
                selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                    fixture_id: 1,
                    element_index: Some(1),
                })
                .into(),
                config: HashMap::from([(String::from("rand"), String::from("5"))]),
            })
            .expect("store fx module definition");

        let (fx_module_ports, render_ports) = {
            let registry = app.world().resource::<FlowNodeRegistry>();
            (
                registry
                    .descriptor(FX_MODULE_KIND)
                    .expect("fx module descriptor")
                    .ports,
                registry
                    .descriptor(RENDER_LAYER_KIND)
                    .expect("render layer descriptor")
                    .ports,
            )
        };

        let mut fx_module_node = FlowNodeDefinition {
            node_id: 10,
            kind: FX_MODULE_KIND.to_string(),
            label: "FX Module".to_string(),
            ports: fx_module_ports,
            position: None,
        };
        fx_module_node
            .ports
            .iter_mut()
            .find(|port| port.port_id == FX_MODULE_IN_ID)
            .expect("fx module id port")
            .default_value = Some(FlowValue::Int(1));
        fx_module_node
            .ports
            .iter_mut()
            .find(|port| port.port_id == FX_MODULE_IN_SELECTION)
            .expect("fx module selection port")
            .default_value = Some(FlowValue::Selection(
            SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 2,
                element_index: Some(1),
            })
            .into(),
        ));

        let render_node = FlowNodeDefinition {
            node_id: 11,
            kind: RENDER_LAYER_KIND.to_string(),
            label: "Render Layer".to_string(),
            ports: render_ports,
            position: None,
        };

        let definition = FlowDefinition {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "Flow 1".to_string(),
            },
            flow_version: 1,
            nodes: vec![fx_module_node, render_node],
            edges: vec![FlowEdgeDefinition {
                from: FlowPortRef {
                    node_id: 10,
                    port_id: FX_MODULE_OUT_LAYER,
                },
                to: FlowPortRef {
                    node_id: 11,
                    port_id: RENDER_LAYER_IN_LAYER,
                },
            }],
        };

        let instance = {
            let registry = app.world().resource::<FlowNodeRegistry>();
            FlowInstance::new(1, FlowRuntime::new(definition), &registry)
        };
        app.world_mut().spawn(instance);

        app
    }

    fn flow_layer_output(app: &mut App) -> (Instance<Parameter>, f32) {
        let mut query = app.world_mut().query::<&Layer>();
        let layer = query
            .single(app.world())
            .expect("exactly one flow layer should be active");
        let (parameter, (value, _)) = layer
            .absolute
            .iter()
            .next()
            .expect("flow layer should contain one absolute parameter value");

        let value = match value {
            ParameterValue::Absolute { value } => *value,
            other => panic!("expected absolute value, got {:?}", other),
        };

        (parameter_instance(parameter), value)
    }

    fn parameter_instance(parameter: ParameterRef) -> Instance<Parameter> {
        // SAFETY: Test layers are produced from fixture-backed parameters in this module.
        unsafe { Instance::from_entity_unchecked(parameter.entity()) }
    }

    fn fixture_parameters(app: &mut App) -> Vec<Instance<Parameter>> {
        let provider = app.world().resource::<FixtureDataProviderExt>();
        let fixture_one = provider.parameter_for_element_attribute(
            &FixtureRef {
                fixture_uid: provider
                    .inner
                    .from_id(1)
                    .expect("fixture 1")
                    .identifiers
                    .uid,
                index: Some(1),
            },
            &Attribute::Intensity,
        );
        let fixture_two = provider.parameter_for_element_attribute(
            &FixtureRef {
                fixture_uid: provider
                    .inner
                    .from_id(2)
                    .expect("fixture 2")
                    .identifiers
                    .uid,
                index: Some(1),
            },
            &Attribute::Intensity,
        );
        vec![fixture_one, fixture_two]
    }

    fn flow_layer_count(app: &mut App) -> usize {
        let mut query = app.world_mut().query::<&Layer>();
        query.iter(app.world()).count()
    }

    fn fx_module_runtime_count(app: &mut App) -> usize {
        let mut query = app.world_mut().query::<&FlowInstance>();
        query
            .single(app.world())
            .expect("flow instance should exist")
            .fx_module_runtimes
            .len()
    }

    fn spawn_parameter(world: &mut World, attribute: Attribute) -> Instance<Parameter> {
        let parameter_entity = world
            .spawn(Parameter {
                metadata: ParameterMetadata {
                    attribute,
                    ..Default::default()
                },
                values: Default::default(),
            })
            .id();

        // SAFETY: parameter_entity was just spawned in this world with a Parameter component.
        unsafe { Instance::from_entity_unchecked(parameter_entity) }
    }

    fn seed_fixture_provider(
        world: &mut World,
        fixture: Fixture,
        parameters: Vec<(FixtureRef, Attribute, Instance<Parameter>)>,
    ) {
        let mut fixture_data_provider = world.resource_mut::<FixtureDataProviderExt>();
        fixture_data_provider
            .inner
            .add(fixture)
            .expect("fixture should be insertable");
        for (fixture_ref, attribute, parameter) in parameters {
            fixture_data_provider.add_parameter(fixture_ref, attribute, parameter);
        }
    }

    /// Runs a test with a serialized typed data-directory configuration.
    fn with_test_module_data_dir(test_module_name: &str, test: impl FnOnce()) {
        static CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = CONFIG_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();

        let temp_root =
            std::env::temp_dir().join(format!("nightfall-flow-fx-module-{}", Uuid::new_v4()));
        let module_dir = temp_root.join("fx-modules");
        std::fs::create_dir_all(&module_dir).expect("create module directory");
        std::fs::write(
            module_dir.join(format!("{test_module_name}.wasm")),
            test_component_bytes(),
        )
        .expect("write module component");

        nightfall::set_nightfall_data_dir(Some(temp_root.clone()));
        test();
        nightfall::set_nightfall_data_dir(None);

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    fn test_component_bytes() -> &'static [u8] {
        static COMPONENT: OnceLock<Vec<u8>> = OnceLock::new();
        COMPONENT.get_or_init(build_test_component).as_slice()
    }

    fn build_test_component() -> Vec<u8> {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../fx-module")
            .join("tests")
            .join("guest-module")
            .join("Cargo.toml");
        let guest_dir = manifest.parent().unwrap();

        let status = Command::new("cargo")
            .arg("build")
            .arg("--manifest-path")
            .arg(&manifest)
            .arg("--target")
            .arg("wasm32-unknown-unknown")
            .current_dir(guest_dir)
            .status()
            .expect("failed to build flow test module component");
        assert!(status.success(), "module component build failed");

        let guest_wasm = guest_dir
            .join("target")
            .join("wasm32-unknown-unknown")
            .join("debug")
            .join("fx_module_test_module.wasm");
        let module = std::fs::read(&guest_wasm).expect("failed to read module wasm");

        ComponentEncoder::default()
            .module(&module)
            .expect("failed to attach module to component encoder")
            .encode()
            .expect("failed to encode component")
    }
}
