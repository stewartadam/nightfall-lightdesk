// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Standalone sample show built from inline data and compiled-in fixture profiles.
//!
//! Population uses compiled-in profiles and audio, without installed GDTF/OFL
//! files, scene models, or WASM effects. Media is copied into each new show.
#![allow(clippy::type_complexity)]
use std::{collections::HashMap, str::FromStr, time::Duration};

use bevy::{ecs::system::SystemState, prelude::*};
use moonshine_kind::prelude::*;
use nightfall::prelude::*;
use nightfall_clips::{Clip, Source};
use nightfall_cues::prelude::*;
#[cfg(feature = "midi")]
use nightfall_desk::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::placement::{FixturePlacement, PlacementPosition, PlacementRotation};
use nightfall_fixtures::prelude::*;
use nightfall_flow::builtin_nodes as flow_nodes;
use nightfall_flow::prelude::*;
use nightfall_fx::prelude::*;
#[cfg(feature = "midi")]
use nightfall_input_midi::prelude::*;
use nightfall_timecode::prelude::*;
use nightfall_timeline::prelude::*;
use nightfall_waveform::prelude::WaveformKind;
use uuid::Uuid;

mod audio;
mod blueprints;
mod cues;
mod effects;
mod fixtures;
mod flows;
mod groups;
mod input_mappings;
mod timelines;

pub(crate) use audio::SAMPLE_AUDIO;

/// Populate a deterministic sample world in dependency-safe domain order.
pub fn populate_sample_entities(world: &mut World) {
    fixtures::add_fixtures(world);
    groups::add_groups(world);
    blueprints::add_blueprints(world);
    cues::add_abs_128_cue(world);
    cues::add_abs_255_cue(world);
    cues::add_rel_cue(world);
    cues::add_fanned_timing_cue(world);
    cues::add_color_fade_sequences(world);
    effects::add_bstrip_fx(world);
    effects::add_visualizer_demo_fx(world);
    flows::add_flows(world);
    timelines::add_tc(world);
    input_mappings::add_midi_mappings(world);
}
