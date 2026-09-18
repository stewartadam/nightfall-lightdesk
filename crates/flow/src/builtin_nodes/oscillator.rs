// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Oscillator node implementation.

use std::time::Duration;

use nightfall_waveform::prelude::*;

use super::waveform::default_waveform;
use crate::nodes::{FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory};
use crate::types::{
    FlowPortDefinition, FlowPortDirection, FlowPortId, FlowPortType, FlowValue, FlowWaveform,
};

/// Node kind identifier for the oscillator node.
pub const OSCILLATOR_KIND: &str = "oscillator";
/// Port id for the oscillator waveform input.
pub const OSCILLATOR_IN_WAVEFORM: FlowPortId = 1;
/// Port id for the oscillator value output.
pub const OSCILLATOR_OUT_VALUE: FlowPortId = 2;

/// Factory for creating oscillator nodes.
pub struct OscillatorFactory;

impl FlowNodeFactory for OscillatorFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        FlowNodeDescriptor {
            kind: OSCILLATOR_KIND.to_string(),
            label: "Oscillator".to_string(),
            category: crate::nodes::FlowNodeCategory::Generator,
            ports: vec![
                FlowPortDefinition {
                    port_id: OSCILLATOR_IN_WAVEFORM,
                    name: "Waveform".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Waveform,
                    is_optional: true,
                    default_value: Some(FlowValue::Waveform(default_waveform())),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: OSCILLATOR_OUT_VALUE,
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
        Box::new(OscillatorNode {
            start_position: Duration::ZERO,
        })
    }
}

/// A node that oscillates a waveform over time.
pub struct OscillatorNode {
    start_position: Duration,
}

impl FlowNode for OscillatorNode {
    fn execute(
        &mut self,
        inputs: &crate::nodes::FlowPortValues,
        outputs: &mut crate::nodes::FlowPortValues,
        _input_triggers: &crate::nodes::FlowTriggerValues,
        _output_triggers: &mut crate::nodes::FlowTriggerValues,
        ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        let waveform = match inputs.get(&OSCILLATOR_IN_WAVEFORM) {
            Some(FlowValue::Waveform(value)) => *value,
            _ => default_waveform(),
        };

        let elapsed = ctx.position.saturating_sub(self.start_position);
        let value = sample_waveform_value(&waveform, elapsed);

        outputs.insert(OSCILLATOR_OUT_VALUE, FlowValue::Number(value));
        Ok(())
    }

    fn is_pure(&self) -> bool {
        false
    }

    fn reset(&mut self, ctx: &FlowNodeContext) {
        self.start_position = ctx.position;
    }
}

/// Sample a waveform value at a given elapsed duration.
pub fn sample_waveform_value(waveform: &FlowWaveform, elapsed: std::time::Duration) -> f32 {
    let rate_secs = waveform.rate_secs.max(0.001);
    let percent = (elapsed.as_secs_f32() / rate_secs).fract();
    let phase = waveform.phase + 2.0 * std::f32::consts::PI * percent;
    let duty_cycle = waveform.duty_cycle.unwrap_or(1.0).clamp(0.0, 1.0);
    let normalized = sample_waveform_radians(waveform.kind, phase, duty_cycle);
    let mut value = waveform.base + waveform.amplitude * normalized;
    value = value.clamp(0.0, 1.0);
    value.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

    use nightfall_waveform::prelude::WaveformKind;

    use super::*;
    use crate::nodes::{FlowPortValues, FlowTriggerValues};

    /// Verifies oscillator elapsed time is derived from source-local playback position.
    #[test]
    fn oscillator_samples_from_source_local_position() {
        let mut node = OscillatorNode {
            start_position: Duration::ZERO,
        };
        let waveform = FlowWaveform {
            kind: WaveformKind::Sawtooth,
            rate_secs: 4.0,
            amplitude: 1.0,
            phase: 0.0,
            base: 0.0,
            duty_cycle: Some(1.0),
        };
        let inputs = HashMap::from([(OSCILLATOR_IN_WAVEFORM, FlowValue::Waveform(waveform))]);
        let mut outputs = FlowPortValues::default();

        node.execute(
            &inputs,
            &mut outputs,
            &FlowTriggerValues::default(),
            &mut FlowTriggerValues::default(),
            &FlowNodeContext {
                position: Duration::from_secs(1),
                frame_delta: Duration::from_millis(16),
            },
        )
        .expect("oscillator should execute");

        assert_eq!(
            outputs.get(&OSCILLATOR_OUT_VALUE),
            Some(&FlowValue::Number(sample_waveform_value(
                &waveform,
                Duration::from_secs(1),
            )))
        );
    }

    /// Verifies resetting an oscillator anchors subsequent elapsed time to the reset position.
    #[test]
    fn oscillator_reset_anchors_elapsed_to_current_position() {
        let mut node = OscillatorNode {
            start_position: Duration::ZERO,
        };
        let waveform = FlowWaveform {
            kind: WaveformKind::Sawtooth,
            rate_secs: 4.0,
            amplitude: 1.0,
            phase: 0.0,
            base: 0.0,
            duty_cycle: Some(1.0),
        };
        let inputs = HashMap::from([(OSCILLATOR_IN_WAVEFORM, FlowValue::Waveform(waveform))]);
        let mut outputs = FlowPortValues::default();

        node.reset(&FlowNodeContext {
            position: Duration::from_secs(10),
            frame_delta: Duration::ZERO,
        });
        node.execute(
            &inputs,
            &mut outputs,
            &FlowTriggerValues::default(),
            &mut FlowTriggerValues::default(),
            &FlowNodeContext {
                position: Duration::from_secs(11),
                frame_delta: Duration::from_secs(1),
            },
        )
        .expect("oscillator should execute after reset");

        assert_eq!(
            outputs.get(&OSCILLATOR_OUT_VALUE),
            Some(&FlowValue::Number(sample_waveform_value(
                &waveform,
                Duration::from_secs(1),
            )))
        );
    }
}
