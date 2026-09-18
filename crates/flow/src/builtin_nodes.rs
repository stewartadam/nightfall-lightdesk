// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Built-in node implementations and registration helpers.

pub mod clip_action;
pub mod color_picker;
pub mod constant_color;
pub mod constant_number;
pub mod constant_selection;
#[cfg(feature = "fx-module")]
pub mod fx_module;
pub mod metronome;
pub mod oscillator;
pub mod random_number;
pub mod render_layer;
pub mod timecode_action;
pub mod toggle_selection;
pub mod waveform;
pub mod waveform_fx;

use crate::nodes::FlowNodeRegistry;

/// Register all built-in nodes.
pub fn register_builtin_nodes(registry: &mut FlowNodeRegistry) -> Result<(), String> {
    registry.register(Box::new(constant_number::ConstantNumberFactory))?;
    registry.register(Box::new(constant_color::ConstantColorFactory))?;
    registry.register(Box::new(constant_selection::ConstantSelectionFactory))?;
    registry.register(Box::new(random_number::RandomNumberFactory))?;
    registry.register(Box::new(waveform::WaveformFactory))?;
    registry.register(Box::new(waveform_fx::WaveformFxFactory))?;
    #[cfg(feature = "fx-module")]
    registry.register(Box::new(fx_module::FxModuleFactory))?;
    registry.register(Box::new(oscillator::OscillatorFactory))?;
    registry.register(Box::new(toggle_selection::ToggleSelectionFactory))?;
    registry.register(Box::new(clip_action::ClipActionFactory))?;
    registry.register(Box::new(timecode_action::TimecodeActionFactory))?;
    registry.register(Box::new(metronome::MetronomeFactory))?;
    registry.register(Box::new(color_picker::ColorPickerFactory))?;
    registry.register(Box::new(render_layer::RenderLayerFactory))?;
    Ok(())
}

// Re-export commonly used constants for convenience
pub use clip_action::{
    CLIP_ACTION_KIND, CLIP_IN_ACTION, CLIP_IN_ID, CLIP_IN_TRIGGER, CLIP_OUT_TRIGGER,
};
pub use color_picker::{COLOR_PICKER_IN, COLOR_PICKER_KIND, COLOR_PICKER_OUT};
pub use constant_color::{
    COLOR_IN_B, COLOR_IN_G, COLOR_IN_R, COLOR_IN_W, COLOR_OUT, CONSTANT_COLOR_KIND,
};
pub use constant_number::{CONSTANT_NUMBER_IN, CONSTANT_NUMBER_KIND, CONSTANT_NUMBER_OUT};
pub use constant_selection::{CONSTANT_SELECTION_KIND, SELECTION_IN, SELECTION_OUT};
#[cfg(feature = "fx-module")]
pub use fx_module::{FX_MODULE_IN_ID, FX_MODULE_IN_SELECTION, FX_MODULE_KIND, FX_MODULE_OUT_LAYER};
pub use metronome::{METRONOME_IN_RATE, METRONOME_KIND, METRONOME_OUT_BEAT, METRONOME_OUT_TRIGGER};
pub use oscillator::{OSCILLATOR_IN_WAVEFORM, OSCILLATOR_KIND, OSCILLATOR_OUT_VALUE};
pub use random_number::{
    RANDOM_IN_MAX, RANDOM_IN_MIN, RANDOM_IN_TRIGGER, RANDOM_NUMBER_KIND, RANDOM_OUT,
};
pub use render_layer::{RENDER_LAYER_IN_LAYER, RENDER_LAYER_KIND};
pub use timecode_action::{
    TIMECODE_ACTION_KIND, TIMECODE_IN_ACTION, TIMECODE_IN_ID, TIMECODE_IN_TRIGGER,
    TIMECODE_OUT_TRIGGER,
};
pub use toggle_selection::{
    TOGGLE_IN_A, TOGGLE_IN_B, TOGGLE_IN_TRIGGER, TOGGLE_OUT, TOGGLE_SELECTION_KIND,
};
pub use waveform::{
    WAVEFORM_IN_AMPLITUDE, WAVEFORM_IN_BASE, WAVEFORM_IN_DUTY_CYCLE, WAVEFORM_IN_KIND,
    WAVEFORM_IN_PHASE, WAVEFORM_IN_RATE, WAVEFORM_KIND, WAVEFORM_OUT,
};
pub use waveform_fx::{
    WAVEFORM_FX_IN_ATTRIBUTE, WAVEFORM_FX_IN_SELECTION, WAVEFORM_FX_IN_WAVEFORM, WAVEFORM_FX_KIND,
    WAVEFORM_FX_OUT_LAYER,
};
