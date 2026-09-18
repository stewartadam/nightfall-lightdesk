// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Timecode action node implementation.

use crate::nodes::{FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory};
use crate::runtime::FlowTriggerState;
use crate::types::{FlowPortDefinition, FlowPortDirection, FlowPortId, FlowPortType, FlowValue};

/// Node kind identifier for the timecode action node.
pub const TIMECODE_ACTION_KIND: &str = "timecode_action";
/// Port id for the timecode action id input.
pub const TIMECODE_IN_ID: FlowPortId = 1;
/// Port id for the timecode action verb input.
pub const TIMECODE_IN_ACTION: FlowPortId = 2;
/// Port id for the timecode action trigger input.
pub const TIMECODE_IN_TRIGGER: FlowPortId = 3;
/// Port id for the timecode action trigger output.
pub const TIMECODE_OUT_TRIGGER: FlowPortId = 4;

/// Factory for creating timecode action nodes.
pub struct TimecodeActionFactory;

impl FlowNodeFactory for TimecodeActionFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        FlowNodeDescriptor {
            kind: TIMECODE_ACTION_KIND.to_string(),
            label: "Timecode Action".to_string(),
            category: crate::nodes::FlowNodeCategory::Action,
            ports: vec![
                FlowPortDefinition {
                    port_id: TIMECODE_IN_ID,
                    name: "Timecode Id".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Int,
                    is_optional: true,
                    default_value: Some(FlowValue::Int(1)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: TIMECODE_IN_ACTION,
                    name: "Action".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::String,
                    is_optional: true,
                    default_value: Some(FlowValue::String("start".to_string())),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: TIMECODE_IN_TRIGGER,
                    name: "Trigger".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Trigger,
                    is_optional: true,
                    default_value: None,
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: TIMECODE_OUT_TRIGGER,
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
        Box::new(TimecodeActionNode)
    }
}

/// A node that passes through timecode trigger events.
pub struct TimecodeActionNode;

impl FlowNode for TimecodeActionNode {
    fn execute(
        &mut self,
        _inputs: &crate::nodes::FlowPortValues,
        _outputs: &mut crate::nodes::FlowPortValues,
        input_triggers: &crate::nodes::FlowTriggerValues,
        output_triggers: &mut crate::nodes::FlowTriggerValues,
        _ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        if let Some(trigger) = input_triggers.get(&TIMECODE_IN_TRIGGER) {
            if trigger.count > 0 {
                output_triggers.insert(
                    TIMECODE_OUT_TRIGGER,
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
