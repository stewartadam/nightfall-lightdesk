// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Constant color node implementation.

use crate::nodes::{FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory};
use crate::types::{
    FlowColor, FlowPortDefinition, FlowPortDirection, FlowPortId, FlowPortType, FlowValue,
};

/// Node kind identifier for the constant color node.
pub const CONSTANT_COLOR_KIND: &str = "color";
/// Port id for the constant color red input.
pub const COLOR_IN_R: FlowPortId = 1;
/// Port id for the constant color green input.
pub const COLOR_IN_G: FlowPortId = 2;
/// Port id for the constant color blue input.
pub const COLOR_IN_B: FlowPortId = 3;
/// Port id for the constant color white input.
pub const COLOR_IN_W: FlowPortId = 4;
/// Port id for the constant color output.
pub const COLOR_OUT: FlowPortId = 5;

/// Factory for creating constant color nodes.
pub struct ConstantColorFactory;

impl FlowNodeFactory for ConstantColorFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        FlowNodeDescriptor {
            kind: CONSTANT_COLOR_KIND.to_string(),
            label: "Color".to_string(),
            category: crate::nodes::FlowNodeCategory::Generator,
            ports: vec![
                FlowPortDefinition {
                    port_id: COLOR_IN_R,
                    name: "R".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Number,
                    is_optional: true,
                    default_value: Some(FlowValue::Number(1.0)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: COLOR_IN_G,
                    name: "G".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Number,
                    is_optional: true,
                    default_value: Some(FlowValue::Number(0.0)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: COLOR_IN_B,
                    name: "B".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Number,
                    is_optional: true,
                    default_value: Some(FlowValue::Number(0.0)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: COLOR_IN_W,
                    name: "W".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Number,
                    is_optional: true,
                    default_value: Some(FlowValue::Number(0.0)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: COLOR_OUT,
                    name: "Color".to_string(),
                    direction: FlowPortDirection::Output,
                    port_type: FlowPortType::Color,
                    is_optional: false,
                    default_value: None,
                    enum_options: None,
                },
            ],
        }
    }

    fn create(&self) -> Box<dyn FlowNode> {
        Box::new(ConstantColorNode)
    }
}

/// A node that creates a color from R, G, B, W inputs.
pub struct ConstantColorNode;

impl FlowNode for ConstantColorNode {
    fn execute(
        &mut self,
        inputs: &crate::nodes::FlowPortValues,
        outputs: &mut crate::nodes::FlowPortValues,
        _input_triggers: &crate::nodes::FlowTriggerValues,
        _output_triggers: &mut crate::nodes::FlowTriggerValues,
        _ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        let r = number_input(inputs, COLOR_IN_R, 1.0).clamp(0.0, 1.0);
        let g = number_input(inputs, COLOR_IN_G, 0.0).clamp(0.0, 1.0);
        let b = number_input(inputs, COLOR_IN_B, 0.0).clamp(0.0, 1.0);
        let w = number_input(inputs, COLOR_IN_W, 0.0).clamp(0.0, 1.0);
        outputs.insert(COLOR_OUT, FlowValue::Color(FlowColor { r, g, b, w }));
        Ok(())
    }
}

fn number_input(inputs: &crate::nodes::FlowPortValues, port_id: FlowPortId, fallback: f32) -> f32 {
    match inputs.get(&port_id) {
        Some(FlowValue::Number(value)) => *value,
        _ => fallback,
    }
}
