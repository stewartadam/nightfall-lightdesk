// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Waveform node implementation.

use nightfall_waveform::prelude::WaveformKind;

use crate::nodes::{FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory};
use crate::types::{
    FlowPortDefinition, FlowPortDirection, FlowPortId, FlowPortType, FlowValue, FlowWaveform,
};

/// Node kind identifier for the waveform node.
pub const WAVEFORM_KIND: &str = "waveform";
/// Port id for the waveform kind input.
pub const WAVEFORM_IN_KIND: FlowPortId = 1;
/// Port id for the waveform rate (cycle length in seconds) input.
pub const WAVEFORM_IN_RATE: FlowPortId = 2;
/// Port id for the waveform amplitude input.
pub const WAVEFORM_IN_AMPLITUDE: FlowPortId = 3;
/// Port id for the waveform phase offset input.
pub const WAVEFORM_IN_PHASE: FlowPortId = 4;
/// Port id for the waveform base value input.
pub const WAVEFORM_IN_BASE: FlowPortId = 5;
/// Port id for the waveform duty cycle input.
pub const WAVEFORM_IN_DUTY_CYCLE: FlowPortId = 6;
/// Port id for the waveform output.
pub const WAVEFORM_OUT: FlowPortId = 7;

/// Get the default waveform parameters.
pub fn default_waveform() -> FlowWaveform {
    FlowWaveform {
        kind: WaveformKind::Sin,
        rate_secs: 1.0,
        amplitude: 1.0,
        phase: 0.0,
        base: 0.0,
        duty_cycle: None,
    }
}

/// Get the default waveform as a FlowValue.
pub fn default_waveform_value() -> FlowValue {
    FlowValue::Waveform(default_waveform())
}

/// Factory for creating waveform nodes.
pub struct WaveformFactory;

impl FlowNodeFactory for WaveformFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        let defaults = default_waveform();
        FlowNodeDescriptor {
            kind: WAVEFORM_KIND.to_string(),
            label: "Waveform".to_string(),
            category: crate::nodes::FlowNodeCategory::Generator,
            ports: vec![
                FlowPortDefinition {
                    port_id: WAVEFORM_IN_KIND,
                    name: "Kind".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::WaveformKind,
                    is_optional: true,
                    default_value: Some(FlowValue::WaveformKind(defaults.kind)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: WAVEFORM_IN_RATE,
                    name: "Rate (s)".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Number,
                    is_optional: true,
                    default_value: Some(FlowValue::Number(defaults.rate_secs)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: WAVEFORM_IN_AMPLITUDE,
                    name: "Amplitude".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Number,
                    is_optional: true,
                    default_value: Some(FlowValue::Number(defaults.amplitude)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: WAVEFORM_IN_PHASE,
                    name: "Phase".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Number,
                    is_optional: true,
                    default_value: Some(FlowValue::Number(defaults.phase)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: WAVEFORM_IN_BASE,
                    name: "Base".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Number,
                    is_optional: true,
                    default_value: Some(FlowValue::Number(defaults.base)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: WAVEFORM_IN_DUTY_CYCLE,
                    name: "Duty Cycle".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Number,
                    is_optional: true,
                    default_value: Some(FlowValue::Number(defaults.duty_cycle.unwrap_or(1.0))),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: WAVEFORM_OUT,
                    name: "Waveform".to_string(),
                    direction: FlowPortDirection::Output,
                    port_type: FlowPortType::Waveform,
                    is_optional: false,
                    default_value: None,
                    enum_options: None,
                },
            ],
        }
    }

    fn create(&self) -> Box<dyn FlowNode> {
        Box::new(WaveformNode)
    }
}

/// A node that creates a waveform from input parameters.
pub struct WaveformNode;

impl FlowNode for WaveformNode {
    fn execute(
        &mut self,
        inputs: &crate::nodes::FlowPortValues,
        outputs: &mut crate::nodes::FlowPortValues,
        _input_triggers: &crate::nodes::FlowTriggerValues,
        _output_triggers: &mut crate::nodes::FlowTriggerValues,
        _ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        let defaults = default_waveform();

        let kind = match inputs.get(&WAVEFORM_IN_KIND) {
            Some(FlowValue::WaveformKind(value)) => *value,
            _ => defaults.kind,
        };
        let rate_secs = number_input(inputs, WAVEFORM_IN_RATE, defaults.rate_secs);
        let amplitude = number_input(inputs, WAVEFORM_IN_AMPLITUDE, defaults.amplitude);
        let phase = number_input(inputs, WAVEFORM_IN_PHASE, defaults.phase);
        let base = number_input(inputs, WAVEFORM_IN_BASE, defaults.base);
        let duty_cycle = number_input(
            inputs,
            WAVEFORM_IN_DUTY_CYCLE,
            defaults.duty_cycle.unwrap_or(1.0),
        );

        let waveform = FlowWaveform {
            kind,
            rate_secs,
            amplitude,
            phase,
            base,
            duty_cycle: Some(duty_cycle),
        };
        outputs.insert(WAVEFORM_OUT, FlowValue::Waveform(waveform));
        Ok(())
    }
}

fn number_input(inputs: &crate::nodes::FlowPortValues, port_id: FlowPortId, fallback: f32) -> f32 {
    match inputs.get(&port_id) {
        Some(FlowValue::Number(value)) => *value,
        _ => fallback,
    }
}
