// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Node registry and execution traits for flow graphs.

use std::collections::HashMap;
use std::time::Duration;

use bevy_ecs::prelude::Resource;
use serde::{Deserialize, Serialize};

use crate::runtime::FlowTriggerState;
use crate::types::{FlowPortDefinition, FlowPortId, FlowValue};

/// Category for a node, used by UI grouping.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[typeshare::typeshare]
pub enum FlowNodeCategory {
    /// Generates values (oscillators, constants, colors).
    Generator,
    /// Emits triggers/events.
    Event,
    /// Issues commands or actions.
    Action,
    /// Utility nodes (math, routing, switches).
    Utility,
}

/// Descriptor for a node kind and its ports.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowNodeDescriptor {
    /// Unique node kind identifier.
    pub kind: String,
    /// Display name for UI.
    pub label: String,
    /// Category for UI grouping.
    pub category: FlowNodeCategory,
    /// Port definitions for this node kind.
    pub ports: Vec<FlowPortDefinition>,
}

/// Runtime execution context for a node.
#[derive(Clone, Copy, Debug)]
pub struct FlowNodeContext {
    /// Current source-local playback position.
    pub position: Duration,
    /// Delta since previous frame.
    pub frame_delta: Duration,
}

/// Port values keyed by port id.
pub type FlowPortValues = HashMap<FlowPortId, FlowValue>;
/// Trigger values keyed by port id.
pub type FlowTriggerValues = HashMap<FlowPortId, FlowTriggerState>;

/// Behavior interface for a node instance.
pub trait FlowNode: Send + Sync {
    /// Execute the node for this frame.
    fn execute(
        &mut self,
        inputs: &FlowPortValues,
        outputs: &mut FlowPortValues,
        input_triggers: &FlowTriggerValues,
        output_triggers: &mut FlowTriggerValues,
        ctx: &FlowNodeContext,
    ) -> Result<(), String>;

    /// Whether outputs are fully determined by inputs.
    fn is_pure(&self) -> bool {
        true
    }

    /// Reset runtime state when playback starts again.
    fn reset(&mut self, _ctx: &FlowNodeContext) {}
}

/// Factory for constructing nodes and exposing their metadata.
pub trait FlowNodeFactory: Send + Sync {
    /// Descriptor for the node kind.
    fn descriptor(&self) -> FlowNodeDescriptor;
    /// Build a new node instance.
    fn create(&self) -> Box<dyn FlowNode>;
}

/// Registry of available node kinds.
#[derive(Resource, Default)]
pub struct FlowNodeRegistry {
    factories: HashMap<String, Box<dyn FlowNodeFactory>>,
}

impl FlowNodeRegistry {
    /// Register a node factory.
    pub fn register(&mut self, factory: Box<dyn FlowNodeFactory>) -> Result<(), String> {
        let descriptor = factory.descriptor();
        let kind = descriptor.kind.clone();
        if self.factories.contains_key(&kind) {
            return Err(format!("node kind '{}' already registered", kind));
        }
        self.factories.insert(kind, factory);
        Ok(())
    }

    /// Get the descriptor for a node kind.
    pub fn descriptor(&self, kind: &str) -> Option<FlowNodeDescriptor> {
        self.factories.get(kind).map(|factory| factory.descriptor())
    }

    /// Create a new node instance for a node kind.
    pub fn create(&self, kind: &str) -> Option<Box<dyn FlowNode>> {
        self.factories.get(kind).map(|factory| factory.create())
    }

    /// List all registered node descriptors.
    pub fn list(&self) -> Vec<FlowNodeDescriptor> {
        self.factories
            .values()
            .map(|factory| factory.descriptor())
            .collect()
    }
}
