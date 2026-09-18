// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Color picker node implementation.

use crate::nodes::{FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory};
use crate::types::{FlowPortDefinition, FlowPortDirection, FlowPortId, FlowPortType, FlowValue};

/// Node kind identifier for the color picker node.
pub const COLOR_PICKER_KIND: &str = "color_picker";
/// Port id for the color picker input.
pub const COLOR_PICKER_IN: FlowPortId = 1;
/// Port id for the color picker output.
pub const COLOR_PICKER_OUT: FlowPortId = 2;

/// Factory for creating color picker nodes.
pub struct ColorPickerFactory;

impl FlowNodeFactory for ColorPickerFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        FlowNodeDescriptor {
            kind: COLOR_PICKER_KIND.to_string(),
            label: "Color Picker".to_string(),
            category: crate::nodes::FlowNodeCategory::Generator,
            ports: vec![
                FlowPortDefinition {
                    port_id: COLOR_PICKER_IN,
                    name: "Color".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Attribute,
                    is_optional: true,
                    default_value: Some(FlowValue::AttributeLabel("Red".to_string())),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: COLOR_PICKER_OUT,
                    name: "Attributes".to_string(),
                    direction: FlowPortDirection::Output,
                    port_type: FlowPortType::Attribute,
                    is_optional: false,
                    default_value: None,
                    enum_options: None,
                },
            ],
        }
    }

    fn create(&self) -> Box<dyn FlowNode> {
        Box::new(ColorPickerNode)
    }
}

/// A node that outputs available color options.
pub struct ColorPickerNode;

impl FlowNode for ColorPickerNode {
    fn execute(
        &mut self,
        _inputs: &crate::nodes::FlowPortValues,
        outputs: &mut crate::nodes::FlowPortValues,
        _input_triggers: &crate::nodes::FlowTriggerValues,
        _output_triggers: &mut crate::nodes::FlowTriggerValues,
        _ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        let labels = vec!["Red".to_string(), "Green".to_string(), "Blue".to_string()];
        outputs.insert(COLOR_PICKER_OUT, FlowValue::AttributeLabels(labels));
        Ok(())
    }

    fn is_pure(&self) -> bool {
        false
    }
}
