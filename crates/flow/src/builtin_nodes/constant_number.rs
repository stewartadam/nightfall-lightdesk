// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Constant number node implementation.

use crate::nodes::{FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory};
use crate::types::{FlowPortDefinition, FlowPortDirection, FlowPortId, FlowPortType, FlowValue};

/// Node kind identifier for the constant number node.
pub const CONSTANT_NUMBER_KIND: &str = "constant_number";
/// Port id for the constant number input.
pub const CONSTANT_NUMBER_IN: FlowPortId = 1;
/// Port id for the constant number output.
pub const CONSTANT_NUMBER_OUT: FlowPortId = 2;

/// Factory for creating constant number nodes.
pub struct ConstantNumberFactory;

impl FlowNodeFactory for ConstantNumberFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        FlowNodeDescriptor {
            kind: CONSTANT_NUMBER_KIND.to_string(),
            label: "Number".to_string(),
            category: crate::nodes::FlowNodeCategory::Generator,
            ports: vec![
                FlowPortDefinition {
                    port_id: CONSTANT_NUMBER_IN,
                    name: "Value".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Number,
                    is_optional: true,
                    default_value: Some(FlowValue::Number(0.0)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: CONSTANT_NUMBER_OUT,
                    name: "Value".to_string(),
                    direction: FlowPortDirection::Output,
                    port_type: FlowPortType::Number,
                    is_optional: false,
                    default_value: None,
                    enum_options: None,
                },
            ],
        }
    }

    fn create(&self) -> Box<dyn FlowNode> {
        Box::new(ConstantNumberNode)
    }
}

/// A node that passes through a constant number value.
pub struct ConstantNumberNode;

impl FlowNode for ConstantNumberNode {
    fn execute(
        &mut self,
        inputs: &crate::nodes::FlowPortValues,
        outputs: &mut crate::nodes::FlowPortValues,
        _input_triggers: &crate::nodes::FlowTriggerValues,
        _output_triggers: &mut crate::nodes::FlowTriggerValues,
        _ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        let value = match inputs.get(&CONSTANT_NUMBER_IN) {
            Some(FlowValue::Number(value)) => *value,
            _ => 0.0,
        };
        outputs.insert(CONSTANT_NUMBER_OUT, FlowValue::Number(value));
        Ok(())
    }
}
