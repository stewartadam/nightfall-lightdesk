// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Core flow types shared by runtime and UI protocol.

use nightfall::prelude::SpatialSelection;
use nightfall_waveform::prelude::WaveformKind;
use serde::{Deserialize, Serialize};

/// Flow identifier.
#[typeshare::typeshare]
pub type FlowId = u32;
/// Node identifier, stable within a flow.
#[typeshare::typeshare]
pub type FlowNodeId = u32;
/// Port identifier, stable within a node.
#[typeshare::typeshare]
pub type FlowPortId = u32;
/// Flow version, increments on topology/config changes.
#[typeshare::typeshare]
pub type FlowVersion = u32;
/// Port version, increments on port value changes.
#[typeshare::typeshare]
pub type FlowPortVersion = u32;
/// Event sequence id for Trigger ports.
#[typeshare::typeshare]
pub type FlowSeq = u32;

/// Direction of a port on a node.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
#[typeshare::typeshare]
pub enum FlowPortDirection {
    /// Input port.
    #[default]
    Input,
    /// Output port.
    Output,
}

/// Port type used for validation and UI rendering.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
#[typeshare::typeshare]
pub enum FlowPortType {
    /// Numeric value (f32).
    #[default]
    Number,
    /// Integer value (i64).
    Int,
    /// Boolean value.
    Bool,
    /// Color value (RGBW).
    Color,
    /// Selection expression.
    Selection,
    /// Attribute label.
    Attribute,
    /// Waveform definition.
    Waveform,
    /// Waveform kind (shape selector).
    WaveformKind,
    /// Layer output summary.
    Layer,
    /// Trigger/event port used to signal discrete, payload-less events,
    /// represented by a monotonically increasing [`FlowSeq`] value for each
    /// activation.
    Trigger,
    /// Free-form string.
    String,
}

/// An option for an enum-constrained Int port.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowEnumOption {
    /// Integer value for this option.
    pub value: i32,
    /// Display label for this option.
    pub label: String,
}

/// A node's port definition.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[typeshare::typeshare]
pub struct FlowPortDefinition {
    /// Stable port identifier.
    #[serde(default)]
    pub port_id: FlowPortId,
    /// UI label for the port.
    #[serde(default)]
    pub name: String,
    /// Input or output.
    #[serde(default)]
    pub direction: FlowPortDirection,
    /// Port data type.
    #[serde(default)]
    pub port_type: FlowPortType,
    /// Whether the port is optional.
    #[serde(default)]
    pub is_optional: bool,
    /// Default value if not connected.
    #[serde(default)]
    pub default_value: Option<FlowValue>,
    /// For Int ports, optional enum options to display as a dropdown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enum_options: Option<Vec<FlowEnumOption>>,
}

/// Position of a node in the UI canvas.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowNodePosition {
    /// X coordinate.
    pub x: f32,
    /// Y coordinate.
    pub y: f32,
}

/// A node instance in a flow definition.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowNodeDefinition {
    /// Stable node identifier.
    pub node_id: FlowNodeId,
    /// Node kind identifier (e.g. "metronome", "waveform").
    pub kind: String,
    /// Display label.
    pub label: String,
    /// Port definitions.
    pub ports: Vec<FlowPortDefinition>,
    /// Optional UI position.
    pub position: Option<FlowNodePosition>,
}

/// Reference to a specific port.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[typeshare::typeshare]
pub struct FlowPortRef {
    /// Node identifier.
    pub node_id: FlowNodeId,
    /// Port identifier.
    pub port_id: FlowPortId,
}

/// Edge connecting an output port to an input port.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowEdgeDefinition {
    /// Output port reference.
    pub from: FlowPortRef,
    /// Input port reference.
    pub to: FlowPortRef,
}

/// RGBAW color value for UI display.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowColor {
    /// Red channel (0.0-1.0).
    pub r: f32,
    /// Green channel (0.0-1.0).
    pub g: f32,
    /// Blue channel (0.0-1.0).
    pub b: f32,
    /// White channel (0.0-1.0).
    pub w: f32,
}

fn default_duty_cycle() -> Option<f32> {
    Some(1.0)
}

/// Waveform definition used by flow nodes.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowWaveform {
    /// Waveform shape.
    pub kind: WaveformKind,
    /// Cycle length in seconds.
    pub rate_secs: f32,
    /// Amplitude.
    pub amplitude: f32,
    /// Phase offset in radians.
    pub phase: f32,
    /// Base value added to the waveform output.
    pub base: f32,
    /// Duty cycle (0.0-1.0, controls what portion of the cycle the waveform occupies).
    #[serde(default = "default_duty_cycle")]
    pub duty_cycle: Option<f32>,
}

/// Lightweight layer summary for UI display.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowLayerSummary {
    /// Layer label.
    pub label: String,
}

/// Typed value carried on a port.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum FlowValue {
    /// Floating point value.
    Number(f32),
    /// Integer value.
    Int(i32),
    /// Boolean value.
    Bool(bool),
    /// String value.
    String(String),
    /// Color value.
    Color(FlowColor),
    /// Spatial selection.
    Selection(SpatialSelection),
    /// Attribute label (e.g. "Intensity").
    AttributeLabel(String),
    /// Multiple attribute labels.
    AttributeLabels(Vec<String>),
    /// Waveform definition.
    Waveform(FlowWaveform),
    /// Waveform kind (shape).
    WaveformKind(WaveformKind),
    /// Layer summary.
    LayerSummary(FlowLayerSummary),
}

impl FlowPortType {
    /// Returns true if the value matches this port type.
    pub fn matches_value(&self, value: &FlowValue) -> bool {
        matches!(
            (self, value),
            (FlowPortType::Number, FlowValue::Number(_))
                | (FlowPortType::Int, FlowValue::Int(_))
                | (FlowPortType::Bool, FlowValue::Bool(_))
                | (FlowPortType::String, FlowValue::String(_))
                | (FlowPortType::Color, FlowValue::Color(_))
                | (FlowPortType::Selection, FlowValue::Selection(_))
                | (FlowPortType::Attribute, FlowValue::AttributeLabel(_))
                | (FlowPortType::Attribute, FlowValue::AttributeLabels(_))
                | (FlowPortType::Waveform, FlowValue::Waveform(_))
                | (FlowPortType::WaveformKind, FlowValue::WaveformKind(_))
                | (FlowPortType::Layer, FlowValue::LayerSummary(_))
        )
    }
}
