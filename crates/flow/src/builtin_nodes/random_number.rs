// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Random number node implementation.

use web_time::{SystemTime, UNIX_EPOCH};

use crate::nodes::{FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory};
use crate::types::{FlowPortDefinition, FlowPortDirection, FlowPortId, FlowPortType, FlowValue};

/// Node kind identifier for the random number node.
pub const RANDOM_NUMBER_KIND: &str = "random_number";
/// Port id for the random number min input.
pub const RANDOM_IN_MIN: FlowPortId = 1;
/// Port id for the random number max input.
pub const RANDOM_IN_MAX: FlowPortId = 2;
/// Port id for the random number trigger input.
pub const RANDOM_IN_TRIGGER: FlowPortId = 3;
/// Port id for the random number output.
pub const RANDOM_OUT: FlowPortId = 4;

/// Factory for creating random number nodes.
pub struct RandomNumberFactory;

impl FlowNodeFactory for RandomNumberFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        FlowNodeDescriptor {
            kind: RANDOM_NUMBER_KIND.to_string(),
            label: "Random".to_string(),
            category: crate::nodes::FlowNodeCategory::Generator,
            ports: vec![
                FlowPortDefinition {
                    port_id: RANDOM_IN_MIN,
                    name: "Min".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Number,
                    is_optional: true,
                    default_value: Some(FlowValue::Number(0.0)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: RANDOM_IN_MAX,
                    name: "Max".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Number,
                    is_optional: true,
                    default_value: Some(FlowValue::Number(1.0)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: RANDOM_IN_TRIGGER,
                    name: "Trigger".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Trigger,
                    is_optional: true,
                    default_value: None,
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: RANDOM_OUT,
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
        Box::new(RandomNumberNode::from_seed(random_seed()))
    }
}

/// A node that generates pseudo-random numbers.
pub struct RandomNumberNode {
    state: u64,
    last_value: f32,
    has_value: bool,
    last_min: f32,
    last_max: f32,
    has_range: bool,
}

impl RandomNumberNode {
    fn from_seed(seed: u64) -> Self {
        Self {
            state: seed,
            last_value: 0.0,
            has_value: false,
            last_min: 0.0,
            last_max: 1.0,
            has_range: false,
        }
    }

    fn next_unit(&mut self) -> f32 {
        self.state = self.state.wrapping_mul(6364136223846793005).wrapping_add(1);
        let bits = (self.state >> 33) as u32;
        bits as f32 / u32::MAX as f32
    }
}

impl FlowNode for RandomNumberNode {
    fn execute(
        &mut self,
        inputs: &crate::nodes::FlowPortValues,
        outputs: &mut crate::nodes::FlowPortValues,
        input_triggers: &crate::nodes::FlowTriggerValues,
        _output_triggers: &mut crate::nodes::FlowTriggerValues,
        _ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        let mut min = number_input(inputs, RANDOM_IN_MIN, 0.0);
        let mut max = number_input(inputs, RANDOM_IN_MAX, 1.0);
        if max < min {
            std::mem::swap(&mut min, &mut max);
        }

        let trigger_count = input_triggers
            .get(&RANDOM_IN_TRIGGER)
            .map(|trigger| trigger.count)
            .unwrap_or(0);

        let range_changed = !self.has_range || self.last_min != min || self.last_max != max;
        if range_changed {
            self.last_min = min;
            self.last_max = max;
            self.has_range = true;
        }

        let mut steps = trigger_count;
        if !self.has_value || range_changed {
            steps = steps.max(1);
        }

        if steps > 0 {
            let mut unit = 0.0;
            for _ in 0..steps {
                unit = self.next_unit();
            }
            self.last_value = min + (max - min) * unit;
            self.has_value = true;
        }

        outputs.insert(RANDOM_OUT, FlowValue::Number(self.last_value));
        Ok(())
    }

    fn is_pure(&self) -> bool {
        false
    }

    fn reset(&mut self, _ctx: &FlowNodeContext) {
        *self = Self::from_seed(random_seed());
    }
}

fn random_seed() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(1)
}

fn number_input(inputs: &crate::nodes::FlowPortValues, port_id: FlowPortId, fallback: f32) -> f32 {
    match inputs.get(&port_id) {
        Some(FlowValue::Number(value)) => *value,
        _ => fallback,
    }
}
