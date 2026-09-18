// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Clip action node implementation.

use crate::nodes::{FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory};
use crate::runtime::FlowTriggerState;
use crate::types::{FlowPortDefinition, FlowPortDirection, FlowPortId, FlowPortType, FlowValue};

/// Node kind identifier for the clip action node.
pub const CLIP_ACTION_KIND: &str = "clip_action";
/// Port id for the clip action id input.
pub const CLIP_IN_ID: FlowPortId = 1;
/// Port id for the clip action verb input.
pub const CLIP_IN_ACTION: FlowPortId = 2;
/// Port id for the clip action trigger input.
pub const CLIP_IN_TRIGGER: FlowPortId = 3;
/// Port id for the clip action trigger output.
pub const CLIP_OUT_TRIGGER: FlowPortId = 4;

/// Factory for creating clip action nodes.
pub struct ClipActionFactory;

impl FlowNodeFactory for ClipActionFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        FlowNodeDescriptor {
            kind: CLIP_ACTION_KIND.to_string(),
            label: "Clip Action".to_string(),
            category: crate::nodes::FlowNodeCategory::Action,
            ports: vec![
                FlowPortDefinition {
                    port_id: CLIP_IN_ID,
                    name: "Clip Id".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Int,
                    is_optional: true,
                    default_value: Some(FlowValue::Int(1)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: CLIP_IN_ACTION,
                    name: "Action".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::String,
                    is_optional: true,
                    default_value: Some(FlowValue::String("start".to_string())),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: CLIP_IN_TRIGGER,
                    name: "Trigger".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Trigger,
                    is_optional: true,
                    default_value: None,
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: CLIP_OUT_TRIGGER,
                    name: "Fired".to_string(),
                    direction: FlowPortDirection::Output,
                    port_type: FlowPortType::Trigger,
                    is_optional: false,
                    default_value: None,
                    enum_options: None,
                },
            ],
        }
    }

    fn create(&self) -> Box<dyn FlowNode> {
        Box::new(ClipActionNode)
    }
}

/// A node that passes through clip trigger events.
pub struct ClipActionNode;

impl FlowNode for ClipActionNode {
    fn execute(
        &mut self,
        _inputs: &crate::nodes::FlowPortValues,
        _outputs: &mut crate::nodes::FlowPortValues,
        input_triggers: &crate::nodes::FlowTriggerValues,
        output_triggers: &mut crate::nodes::FlowTriggerValues,
        _ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        if let Some(trigger) = input_triggers.get(&CLIP_IN_TRIGGER) {
            if trigger.count > 0 {
                output_triggers.insert(
                    CLIP_OUT_TRIGGER,
                    FlowTriggerState {
                        seq: trigger.seq,
                        count: trigger.count,
                    },
                );
            }
        }
        Ok(())
    }
}
