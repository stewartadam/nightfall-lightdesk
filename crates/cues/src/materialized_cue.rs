// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Module to materialize cues and generate their layers
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_instances::{
    InstanceClock, InstancePosition, InstanceStatus, Owner, activation_epoch_ms,
};
use nightfall_selection::filter_existing_selection;
use partially::Partial;
use smart_default::SmartDefault;
use web_time::Instant;

use crate::materialized_sequence::PlaybackReleaseTiming;
use crate::prelude::*;

/// Materialize a cue with by-attribute or references into instructions by-parameter
#[derive(Component, SmartDefault)]
pub struct MaterializedCue {
    /// The cue this materialized cue is based on
    pub cue: Cue,
    /// The values of the materialized cue
    #[default(_code = "Layer::new(\"materialized_cue internal\".to_owned(), Priority::default())")]
    pub values: Layer,
    /// Ordered part layers, with the cue body represented as part 0.
    pub part_layers: Vec<MaterializedCuePartLayer>,
    /// Release timing overrides materialized from timing-only instruction data.
    pub release_timing_overrides: ParameterMap<MaterializedTransition>,
    /// Parameters that should be cleared from the sequence tracking layer at this cue.
    pub release_values: HashSet<ParameterRef>,
    /// Assertion-side timing for release markers materialized by parameter.
    pub release_value_transitions: ParameterMap<MaterializedTransition>,
    /// HTP parameters whose authored assertion timing omitted transition-out fields.
    pub implicit_htp_assertion_timing: HashSet<ParameterRef>,
    /// Position parameters that should opt out of lookahead while this cue is active.
    pub hold_position_values: HashSet<ParameterRef>,
    /// Absolute parameters authored by cue parts with lookahead enabled.
    pub lookahead_parameters: HashSet<ParameterRef>,
    /// Color-vector parameter groups whose values are derived from assigned color paths.
    pub color_path_groups: Vec<MaterializedColorPathGroup>,
    /// Scalar color parameter groups whose values are derived from assigned color paths.
    pub color_path_scalar_groups: Vec<MaterializedColorPathScalarGroup>,
    /// The priority of the sequence. Higher is rendered last.
    pub priority: Priority,
    /// UI-facing host activation timestamp for status metadata.
    #[default(_code = "Instant::now()")]
    pub activation_time: Instant,
    /// Source-local playback position where the cue was started.
    pub start_position: Duration,
    /// Source-local playback position where the cue was released.
    pub release_position: Option<Duration>,
    /// Maximum resolved from individual transitions
    pub max_fade_in: Duration,
    /// Maximum resolved from individual transitions
    pub max_delay_in: Duration,
    /// Maximum resolved from individual transitions
    pub max_fade_out: Duration,
    /// Maximum resolved delay and fade duration for asserting cue values
    pub max_assertion_duration: Duration,
    /// Resolved cue-duration profile accumulated while materializing values.
    pub duration_profile: CueDurationProfile,
}

/// One ordered materialized layer for part 0 or an authored cue part.
#[derive(Clone, Debug)]
pub struct MaterializedCuePartLayer {
    /// Values asserted by this cue part layer.
    pub values: Layer,
    /// Absolute parameters authored by this cue part with lookahead enabled.
    pub lookahead_parameters: HashSet<ParameterRef>,
    /// Parameters released by this cue part layer.
    pub release_values: HashSet<ParameterRef>,
    /// Assertion-side timing for release markers in this cue part layer.
    pub release_value_transitions: ParameterMap<MaterializedTransition>,
    /// Color-vector path groups derived from this layer's instructions.
    pub color_path_groups: Vec<MaterializedColorPathGroup>,
    /// Scalar color path groups derived from this layer's instructions.
    pub color_path_scalar_groups: Vec<MaterializedColorPathScalarGroup>,
}

/// Fixture color-vector family controlled by one assigned color path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MaterializedColorPathModel {
    /// Additive red, green, and blue emitters.
    Rgb,
    /// Subtractive cyan, magenta, and yellow emitters.
    Cmy,
}

impl MaterializedColorPathModel {
    /// Returns the ordered fixture attributes represented by this model.
    pub fn attributes(self) -> [Attribute; 3] {
        match self {
            Self::Rgb => [Attribute::Red, Attribute::Green, Attribute::Blue],
            Self::Cmy => [Attribute::Cyan, Attribute::Magenta, Attribute::Yellow],
        }
    }

    /// Returns optional auxiliary color emitters that should follow this path's timing.
    pub fn auxiliary_attributes(self) -> [Attribute; 5] {
        [
            Attribute::White,
            Attribute::Amber,
            Attribute::WarmWhite,
            Attribute::CoolWhite,
            Attribute::UV,
        ]
    }

    /// Returns color-mix emitters that can be derived from sampled RGB output.
    pub fn decomposed_attributes(self) -> &'static [Attribute] {
        match self {
            Self::Rgb => &[
                Attribute::White,
                Attribute::WarmWhite,
                Attribute::CoolWhite,
                Attribute::Amber,
            ],
            Self::Cmy => &[],
        }
    }

    /// Converts normalized model channel values into RGB sampling space.
    pub fn to_rgb(self, channels: [f32; 3]) -> ColorPathRgb {
        match self {
            Self::Rgb => ColorPathRgb {
                red: channels[0],
                green: channels[1],
                blue: channels[2],
            },
            Self::Cmy => ColorPathRgb {
                red: 1.0 - channels[0],
                green: 1.0 - channels[1],
                blue: 1.0 - channels[2],
            },
        }
        .clamped()
    }

    /// Converts an RGB sample back into normalized model channel values.
    pub fn from_rgb(self, color: ColorPathRgb) -> [f32; 3] {
        let color = color.clamped();
        match self {
            Self::Rgb => [color.red, color.green, color.blue],
            Self::Cmy => [1.0 - color.red, 1.0 - color.green, 1.0 - color.blue],
        }
    }
}

/// Runtime three-channel color-vector group controlled by one assigned color path.
#[derive(Clone, Debug)]
pub struct MaterializedColorPathGroup {
    /// Color path definition selected by the authored cue instruction.
    pub path: ColorPath,
    /// Color-vector model used to map fixture emitters into RGB sampling space.
    pub model: MaterializedColorPathModel,
    /// First emitter parameter: red for RGB, cyan for CMY.
    pub red: Instance<Parameter>,
    /// Second emitter parameter: green for RGB, magenta for CMY.
    pub green: Instance<Parameter>,
    /// Third emitter parameter: blue for RGB, yellow for CMY.
    pub blue: Instance<Parameter>,
    /// Additional color emitters, such as white or amber, governed by this path's timing.
    pub auxiliary_emitters: Vec<(Attribute, Instance<Parameter>)>,
    /// Color-mix emitters derived from the sampled RGB color instead of independently authored values.
    pub decomposed_emitters: Vec<(Attribute, Instance<Parameter>)>,
}

/// Runtime scalar color emitters controlled by one assigned color path.
#[derive(Clone, Debug)]
pub struct MaterializedColorPathScalarGroup {
    /// Color path definition selected by the authored cue instruction.
    pub path: ColorPath,
    /// Color emitter parameters governed by this path's timing.
    pub emitters: Vec<(Attribute, Instance<Parameter>)>,
}

/// Index implementation to lookup by the triggering clip's UUID
impl HasIdentifiers for MaterializedCue {
    fn identifiers(&self) -> &Identifiers {
        self.cue.identifiers()
    }
}

mod materialization;
mod release;
mod state;
mod systems;

pub use systems::{
    despawn_materialized_cues, paint_materialized_cues, release_materialized_cues,
    sync_cue_playback_runtime_status,
};

#[cfg(test)]
mod tests;
