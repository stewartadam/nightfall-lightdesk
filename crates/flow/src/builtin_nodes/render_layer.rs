// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Render layer node implementation.

use crate::nodes::{FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory};
use crate::types::{FlowPortDefinition, FlowPortDirection, FlowPortId, FlowPortType};

/// Node kind identifier for the render layer node.
pub const RENDER_LAYER_KIND: &str = "render_layer";
/// Port id for the render layer input.
pub const RENDER_LAYER_IN_LAYER: FlowPortId = 1;

/// Factory for creating render layer nodes.
pub struct RenderLayerFactory;

impl FlowNodeFactory for RenderLayerFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        FlowNodeDescriptor {
            kind: RENDER_LAYER_KIND.to_string(),
            label: "Render Layer".to_string(),
            category: crate::nodes::FlowNodeCategory::Utility,
            ports: vec![FlowPortDefinition {
                port_id: RENDER_LAYER_IN_LAYER,
                name: "Layer".to_string(),
                direction: FlowPortDirection::Input,
                port_type: FlowPortType::Layer,
                is_optional: false,
                default_value: None,
                enum_options: None,
            }],
        }
    }

    fn create(&self) -> Box<dyn FlowNode> {
        Box::new(RenderLayerNode)
    }
}

/// A node that renders a layer.
pub struct RenderLayerNode;

impl FlowNode for RenderLayerNode {
    fn execute(
        &mut self,
        _inputs: &crate::nodes::FlowPortValues,
        _outputs: &mut crate::nodes::FlowPortValues,
        _input_triggers: &crate::nodes::FlowTriggerValues,
        _output_triggers: &mut crate::nodes::FlowTriggerValues,
        _ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        Ok(())
    }
}
