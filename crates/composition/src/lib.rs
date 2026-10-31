// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The show engine's plugin list, shared by every host.
//!
//! [`ShowPlugins`] adds the plugins that run the same in the native app and the browser demo,
//! in the order they must be built. Each host builds the group and inserts its own plugins next
//! to the one they depend on with [`PluginGroupBuilder::add_after`], such as the native
//! websocket server, audio and network transports, or the demo's built-in fixture library.

#![warn(missing_docs)]

use bevy_app::{PluginGroup, PluginGroupBuilder};
use nightfall_actions::ActionsPlugin;
use nightfall_boards::prelude::BoardsPlugin;
use nightfall_cues::prelude::CuePlugin;
use nightfall_desk::{prelude::DeskPlugin, resources::log_config::LogConfig};
use nightfall_engine::{EnginePlugin, prelude::ClientBridgePlugin};
use nightfall_fixtures::prelude::{FixtureCompositorPlugin, FixturePlugin};
use nightfall_flow::prelude::FlowPlugin;
use nightfall_fx::prelude::FxPlugin;
use nightfall_macros::prelude::MacrosPlugin;
use nightfall_programmer::prelude::ProgrammerPlugin;
use nightfall_references::ReferencesPlugin;
use nightfall_scene_objects::prelude::SceneObjectPlugin;
use nightfall_tempo::prelude::TempoPlugin;
use nightfall_timecode::prelude::TimecodePlugin;
use nightfall_timeline::prelude::TimelinePlugin;
use nightfall_undo::prelude::UndoPlugin;

/// Plugins every host runs, from the engine core through the show domains to the timeline.
pub struct ShowPlugins {
    /// Log filter handle the desk's log-level commands update.
    pub log_config: LogConfig,
    /// Timeline plugin, configured by the host for its audio and beat detection support.
    pub timeline: TimelinePlugin,
}

impl PluginGroup for ShowPlugins {
    /// Lists the shared plugins in build order. Engine, undo, client bridge and actions come
    /// first because later plugins assert they are present; fixtures and scene objects precede
    /// the compositor and desk that read them; FX precedes flow, which hosts FX nodes.
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .add(EnginePlugin)
            .add(UndoPlugin)
            .add(ClientBridgePlugin)
            .add(ActionsPlugin)
            .add(FixturePlugin)
            .add(SceneObjectPlugin)
            .add(FixtureCompositorPlugin)
            .add(DeskPlugin {
                log_config: self.log_config,
            })
            .add(ProgrammerPlugin)
            .add(CuePlugin)
            .add(BoardsPlugin)
            .add(MacrosPlugin)
            .add(TempoPlugin)
            .add(FxPlugin)
            .add(FlowPlugin)
            .add(ReferencesPlugin)
            .add(TimecodePlugin)
            .add(self.timeline)
    }
}
