// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The show engine's plugin groups, shared by every host.
//!
//! Each domain has its own group: [`CorePlugins`], [`DeskPlugins`], [`FxPlugins`] and
//! [`TimecodePlugins`]. [`ShowPlugins`] nests them in build order. Nesting with
//! [`PluginGroupBuilder::add_group`] flattens the groups into one list, so a host builds
//! [`ShowPlugins`] and inserts its own plugins next to the one they depend on with
//! [`PluginGroupBuilder::add_after`], such as the native websocket server, audio and network
//! transports, or the demo's built-in fixture library.

#![warn(missing_docs)]

use bevy_app::{PluginGroup, PluginGroupBuilder};
use nightfall_actions::ActionsPlugin;
use nightfall_boards::prelude::BoardsPlugin;
use nightfall_clips::ClipsPlugin;
use nightfall_controls::ControlsPlugin;
use nightfall_cues::prelude::CuePlugin;
use nightfall_desk::{prelude::DeskPlugin, resources::log_config::LogConfig};
use nightfall_engine::{EnginePlugin, prelude::ClientBridgePlugin};
use nightfall_fixtures::prelude::{FixtureCompositorPlugin, FixturePlugin};
use nightfall_flow::prelude::FlowPlugin;
use nightfall_fx::prelude::FxPlugin;
use nightfall_macros::prelude::MacrosPlugin;
use nightfall_programming::prelude::ProgrammingPlugin;
use nightfall_references::ReferencesPlugin;
use nightfall_scene_objects::prelude::SceneObjectPlugin;
use nightfall_showfile::ShowfileSettingsPlugin;
use nightfall_tempo::prelude::TempoPlugin;
use nightfall_timecode::prelude::TimecodePlugin;
use nightfall_timeline::prelude::TimelinePlugin;
use nightfall_undo::prelude::UndoPlugin;

/// Every shared show plugin: the core, desk, FX and timecode groups, nested in build order.
pub struct ShowPlugins {
    /// Log filter handle the desk's log-level commands update.
    pub log_config: LogConfig,
    /// Timeline plugin, configured by the host for its audio and beat detection support.
    pub timeline: TimelinePlugin,
}

impl PluginGroup for ShowPlugins {
    /// Nests the domain groups so the core comes before the desk that reads fixtures and scene
    /// objects, and the desk before FX, flow and the timeline that drive it.
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .add_group(CorePlugins)
            .add_group(DeskPlugins {
                log_config: self.log_config,
            })
            .add_group(FxPlugins)
            .add_group(TimecodePlugins {
                timeline: self.timeline,
            })
    }
}

/// Engine infrastructure, fixtures, scene objects, the fixture compositor and clip playback.
pub struct CorePlugins;

impl PluginGroup for CorePlugins {
    /// Lists the core plugins in build order. Engine, undo, client bridge and actions come first
    /// because later plugins assert they are present; fixtures and scene objects precede the
    /// compositor that reads them. Clip playback comes last, since the desk asserts it is present.
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .add(EnginePlugin)
            .add(UndoPlugin)
            .add(ClientBridgePlugin)
            .add(ActionsPlugin)
            .add(FixturePlugin)
            .add(SceneObjectPlugin)
            .add(FixtureCompositorPlugin)
            .add(ClipsPlugin)
    }
}

/// The desk and the show data it operates: masters and faders, programmer, cues, boards and
/// macros.
pub struct DeskPlugins {
    /// Log filter handle the desk's log-level commands update.
    pub log_config: LogConfig,
}

impl PluginGroup for DeskPlugins {
    /// Adds masters and faders before the desk, whose playback feeds read held fader buttons,
    /// and the desk before the programmer, cues, boards and macros that register against it.
    /// The showfile settings go with the desk, which saves and loads shows.
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .add(ControlsPlugin)
            .add(DeskPlugin {
                log_config: self.log_config,
            })
            .add(ProgrammingPlugin)
            .add(CuePlugin)
            .add(ShowfileSettingsPlugin)
            .add(BoardsPlugin)
            .add(MacrosPlugin)
    }
}

/// Tempo, effects, the flow graph and references.
pub struct FxPlugins;

impl PluginGroup for FxPlugins {
    /// Adds tempo before FX, which syncs to it, and FX before flow, which hosts FX nodes.
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .add(TempoPlugin)
            .add(FxPlugin)
            .add(FlowPlugin)
            .add(ReferencesPlugin)
    }
}

/// Timecode and the timeline it drives.
pub struct TimecodePlugins {
    /// Timeline plugin, configured by the host for its audio and beat detection support.
    pub timeline: TimelinePlugin,
}

impl PluginGroup for TimecodePlugins {
    /// Adds timecode before the timeline that follows it.
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .add(TimecodePlugin)
            .add(self.timeline)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies nesting flattens the domain groups into one list in build order, so hosts can
    /// target any nested plugin with `add_after` or `disable`.
    #[test]
    fn show_plugins_flatten_domain_groups_in_order() {
        let builder = ShowPlugins {
            log_config: LogConfig::disconnected(),
            timeline: TimelinePlugin::new(false),
        }
        .build()
        .add_after::<MacrosPlugin>(TestMarkerPlugin)
        .disable::<ReferencesPlugin>();
        assert!(builder.enabled::<EnginePlugin>());
        assert!(builder.enabled::<TestMarkerPlugin>());
        assert!(!builder.enabled::<ReferencesPlugin>());
        assert!(builder.contains::<TimelinePlugin>());
    }

    /// Stand-in host plugin used to check insertion into a nested group.
    struct TestMarkerPlugin;

    impl bevy_app::Plugin for TestMarkerPlugin {
        /// Registers nothing; the test only checks where the builder places it.
        fn build(&self, _app: &mut bevy_app::App) {}
    }
}
