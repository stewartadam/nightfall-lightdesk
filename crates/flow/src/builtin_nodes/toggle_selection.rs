// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Toggle selection node implementation.

use nightfall::prelude::SelectionExpr;

use crate::nodes::{FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory};
use crate::types::{FlowPortDefinition, FlowPortDirection, FlowPortId, FlowPortType, FlowValue};

/// Node kind identifier for the selection toggle node.
pub const TOGGLE_SELECTION_KIND: &str = "toggle_selection";
/// Port id for the toggle selection input A.
pub const TOGGLE_IN_A: FlowPortId = 1;
/// Port id for the toggle selection input B.
pub const TOGGLE_IN_B: FlowPortId = 2;
/// Port id for the toggle trigger input.
pub const TOGGLE_IN_TRIGGER: FlowPortId = 3;
/// Port id for the toggle selection output.
pub const TOGGLE_OUT: FlowPortId = 4;

/// Factory for creating toggle selection nodes.
pub struct ToggleSelectionFactory;

impl FlowNodeFactory for ToggleSelectionFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        FlowNodeDescriptor {
            kind: TOGGLE_SELECTION_KIND.to_string(),
            label: "Toggle Selection".to_string(),
            category: crate::nodes::FlowNodeCategory::Utility,
            ports: vec![
                FlowPortDefinition {
                    port_id: TOGGLE_IN_A,
                    name: "Selection A".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Selection,
                    is_optional: true,
                    default_value: Some(FlowValue::Selection(SelectionExpr::default().into())),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: TOGGLE_IN_B,
                    name: "Selection B".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Selection,
                    is_optional: true,
                    default_value: Some(FlowValue::Selection(SelectionExpr::default().into())),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: TOGGLE_IN_TRIGGER,
                    name: "Trigger".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Trigger,
                    is_optional: true,
                    default_value: None,
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: TOGGLE_OUT,
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
        Box::new(ToggleSelectionNode { use_a: true })
    }
}

/// A node that toggles between two selections based on a trigger.
pub struct ToggleSelectionNode {
    use_a: bool,
}

impl FlowNode for ToggleSelectionNode {
    fn execute(
        &mut self,
        inputs: &crate::nodes::FlowPortValues,
        outputs: &mut crate::nodes::FlowPortValues,
        input_triggers: &crate::nodes::FlowTriggerValues,
        _output_triggers: &mut crate::nodes::FlowTriggerValues,
        _ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        let count = input_triggers
            .get(&TOGGLE_IN_TRIGGER)
            .map(|trigger| trigger.count)
            .unwrap_or(0);
        if count % 2 == 1 {
            self.use_a = !self.use_a;
        }

        let selection = if self.use_a {
            match inputs.get(&TOGGLE_IN_A) {
                Some(FlowValue::Selection(selection)) => selection.clone(),
                _ => SelectionExpr::default().into(),
            }
        } else {
            match inputs.get(&TOGGLE_IN_B) {
                Some(FlowValue::Selection(selection)) => selection.clone(),
                _ => SelectionExpr::default().into(),
            }
        };

        outputs.insert(TOGGLE_OUT, FlowValue::Selection(selection));
        Ok(())
    }

    fn is_pure(&self) -> bool {
        false
    }

    fn reset(&mut self, _ctx: &FlowNodeContext) {
        self.use_a = true;
    }
}
