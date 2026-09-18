// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Constant selection node implementation.

use nightfall::prelude::SelectionExpr;

use crate::nodes::{FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory};
use crate::types::{FlowPortDefinition, FlowPortDirection, FlowPortId, FlowPortType, FlowValue};

/// Node kind identifier for the constant selection node.
pub const CONSTANT_SELECTION_KIND: &str = "selection";
/// Port id for the constant selection input.
pub const SELECTION_IN: FlowPortId = 1;
/// Port id for the constant selection output.
pub const SELECTION_OUT: FlowPortId = 2;

/// Factory for creating constant selection nodes.
pub struct ConstantSelectionFactory;

impl FlowNodeFactory for ConstantSelectionFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        FlowNodeDescriptor {
            kind: CONSTANT_SELECTION_KIND.to_string(),
            label: "Selection".to_string(),
            category: crate::nodes::FlowNodeCategory::Generator,
            ports: vec![
                FlowPortDefinition {
                    port_id: SELECTION_IN,
                    name: "Selection".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Selection,
                    is_optional: true,
                    default_value: Some(FlowValue::Selection(SelectionExpr::default().into())),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: SELECTION_OUT,
                    name: "Selection".to_string(),
                    direction: FlowPortDirection::Output,
                    port_type: FlowPortType::Selection,
                    is_optional: false,
                    default_value: None,
                    enum_options: None,
                },
            ],
        }
    }

    fn create(&self) -> Box<dyn FlowNode> {
        Box::new(ConstantSelectionNode)
    }
}

/// A node that passes through a constant selection value.
pub struct ConstantSelectionNode;

impl FlowNode for ConstantSelectionNode {
    fn execute(
        &mut self,
        inputs: &crate::nodes::FlowPortValues,
        outputs: &mut crate::nodes::FlowPortValues,
        _input_triggers: &crate::nodes::FlowTriggerValues,
        _output_triggers: &mut crate::nodes::FlowTriggerValues,
        _ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        let selection = match inputs.get(&SELECTION_IN) {
            Some(FlowValue::Selection(selection)) => selection.clone(),
            _ => SelectionExpr::default().into(),
        };
        outputs.insert(SELECTION_OUT, FlowValue::Selection(selection));
        Ok(())
    }
}
