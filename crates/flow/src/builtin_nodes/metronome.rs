// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Metronome node implementation.

use std::time::Duration;

use crate::nodes::{FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory};
use crate::runtime::FlowTriggerState;
use crate::types::{FlowPortDefinition, FlowPortDirection, FlowPortId, FlowPortType, FlowValue};

/// Node kind identifier for the metronome node.
pub const METRONOME_KIND: &str = "metronome";
/// Port id for the metronome BPM input.
pub const METRONOME_IN_RATE: FlowPortId = 1;
/// Port id for the metronome beat count output.
pub const METRONOME_OUT_BEAT: FlowPortId = 2;
/// Port id for the metronome trigger output.
pub const METRONOME_OUT_TRIGGER: FlowPortId = 3;

/// Factory for creating metronome nodes.
pub struct MetronomeFactory;

impl FlowNodeFactory for MetronomeFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        FlowNodeDescriptor {
            kind: METRONOME_KIND.to_string(),
            label: "Metronome".to_string(),
            category: crate::nodes::FlowNodeCategory::Event,
            ports: vec![
                FlowPortDefinition {
                    port_id: METRONOME_IN_RATE,
                    name: "Rate (BPM)".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Number,
                    is_optional: true,
                    default_value: Some(FlowValue::Number(60.0)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: METRONOME_OUT_BEAT,
                    name: "Beat".to_string(),
                    direction: FlowPortDirection::Output,
                    port_type: FlowPortType::Int,
                    is_optional: false,
                    default_value: Some(FlowValue::Int(0)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: METRONOME_OUT_TRIGGER,
                    name: "Trigger".to_string(),
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
        Box::new(MetronomeNode {
            last_tick: Duration::ZERO,
            beat: 0,
        })
    }
}

/// A node that generates metronome beats at a specified BPM.
pub struct MetronomeNode {
    last_tick: Duration,
    beat: i32,
}

impl FlowNode for MetronomeNode {
    fn execute(
        &mut self,
        inputs: &crate::nodes::FlowPortValues,
        outputs: &mut crate::nodes::FlowPortValues,
        _input_triggers: &crate::nodes::FlowTriggerValues,
        output_triggers: &mut crate::nodes::FlowTriggerValues,
        ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        let bpm = match inputs.get(&METRONOME_IN_RATE) {
            Some(FlowValue::Number(value)) => *value,
            _ => 60.0,
        };

        if bpm <= 0.0 {
            return Ok(());
        }

        let period_secs = 60.0 / bpm;
        let elapsed = ctx.position.saturating_sub(self.last_tick);
        let ticks = (elapsed.as_secs_f64() / f64::from(period_secs)).floor() as u64;

        if ticks > 0 {
            let advance = f64::from(period_secs) * ticks as f64;
            self.last_tick += Duration::from_secs_f64(advance);
            self.beat = self.beat.saturating_add(ticks as i32);

            let trigger = output_triggers
                .entry(METRONOME_OUT_TRIGGER)
                .or_insert(FlowTriggerState { seq: 0, count: 0 });
            trigger.seq = trigger.seq.saturating_add(ticks as u32);
            trigger.count = trigger
                .count
                .saturating_add(ticks.min(u32::MAX as u64) as u32);
        }

        outputs.insert(METRONOME_OUT_BEAT, FlowValue::Int(self.beat));
        Ok(())
    }

    fn is_pure(&self) -> bool {
        false
    }

    fn reset(&mut self, ctx: &FlowNodeContext) {
        self.last_tick = ctx.position;
        self.beat = 0;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

    use super::*;
    use crate::nodes::{FlowPortValues, FlowTriggerValues};

    #[test]
    fn reset_restarts_metronome_timing_and_beat_count() {
        let start = Duration::from_secs(20);
        let mut node = MetronomeNode {
            last_tick: start,
            beat: 0,
        };
        let inputs = HashMap::from([(METRONOME_IN_RATE, FlowValue::Number(60.0))]);
        let mut outputs = FlowPortValues::default();
        let mut output_triggers = FlowTriggerValues::default();

        node.execute(
            &inputs,
            &mut outputs,
            &FlowTriggerValues::default(),
            &mut output_triggers,
            &FlowNodeContext {
                position: start + Duration::from_secs(3),
                frame_delta: Duration::from_secs(3),
            },
        )
        .expect("metronome should execute");
        assert_eq!(outputs.get(&METRONOME_OUT_BEAT), Some(&FlowValue::Int(3)));

        let restart = start + Duration::from_secs(10);
        node.reset(&FlowNodeContext {
            position: restart,
            frame_delta: Duration::ZERO,
        });

        outputs.clear();
        output_triggers.clear();
        node.execute(
            &inputs,
            &mut outputs,
            &FlowTriggerValues::default(),
            &mut output_triggers,
            &FlowNodeContext {
                position: restart,
                frame_delta: Duration::ZERO,
            },
        )
        .expect("metronome should execute after reset");

        assert_eq!(outputs.get(&METRONOME_OUT_BEAT), Some(&FlowValue::Int(0)));
        assert!(output_triggers.is_empty());
    }
}
