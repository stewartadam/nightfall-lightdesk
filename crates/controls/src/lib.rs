// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Masters, faders, and the per-playback intensity they drive.
//!
//! Masters scale intensity, inhibit it, or scale playback speed for the fixtures or playbacks
//! they target. The backend-owned fader bank assigns faders to clips or masters, and fader
//! buttons can flash, solo, or hold their assignment. [`ControlsPlugin`] runs their commands
//! and updates, applies them to the frame, registers their bindable actions, and publishes
//! them to clients.

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;

pub mod actions;
pub mod faders;
pub mod masters;
pub mod playback_intensity;
pub mod undo;
pub mod websocket;

pub mod prelude {
    pub use crate::ControlsPlugin;
    pub use crate::actions::{
        FADER_BUTTON_ACTION_ID, FADER_GO_ACTION_ID, FADER_LEVEL_ACTION_ID, FaderActionArguments,
        MASTER_LEVEL_ACTION_ID, MASTER_OFF_ACTION_ID, MASTER_ON_ACTION_ID, MASTER_TOGGLE_ACTION_ID,
        MasterActionArguments, fader_button_action, fader_go_action, fader_level_action,
        master_level_action, master_toggle_action,
    };
    pub use crate::faders::{
        FaderAssignment, FaderButtonMode, FaderCommand, FaderConfig, FaderSnapshot, FaderUpdate,
        Faders,
    };
    pub use crate::masters::{
        FixtureMasterTarget, InstanceMasterTarget, MASTER_INTENSITY_ATTRIBUTES, Master,
        MasterCommand, MasterKind, MasterMode, MasterTarget, add_default_show_masters,
    };
}

use crate::prelude::*;

/// Plugin that runs masters, faders, and held fader buttons.
pub struct ControlsPlugin;

impl Plugin for ControlsPlugin {
    /// Registers master and fader commands, updates, actions, and undo, and schedules the
    /// systems that apply them each frame and publish them to clients.
    fn build(&self, app: &mut App) {
        assert!(
            app.is_plugin_added::<nightfall_undo::UndoPlugin>(),
            "ControlsPlugin requires UndoPlugin (provides UndoRegistry)"
        );
        assert!(
            app.is_plugin_added::<nightfall_actions::ActionsPlugin>(),
            "ControlsPlugin requires ActionsPlugin (runs fader and master actions)"
        );
        assert!(
            app.is_plugin_added::<nightfall_clips::ClipsPlugin>(),
            "ControlsPlugin requires ClipsPlugin (provides clip and instance playback)"
        );

        actions::register_control_actions(app);

        register_client_command::<MasterCommand>(app, Undo::Captured);
        register_client_command::<FaderCommand>(app, Undo::Captured);
        app.add_message::<masters::MasterUpdate>();
        app.add_message::<FaderUpdate>();
        app.add_message::<ClientDisconnected>();
        register_update_deserializer(app, "FaderUpdate", websocket::deserialize_fader_update);
        register_update_deserializer(app, "MasterUpdate", websocket::deserialize_master_update);

        app.init_resource::<DataProvider<Master>>();
        app.init_resource::<Faders>();
        app.world_mut()
            .resource_mut::<UndoRegistry>()
            .register::<MasterCommand>();

        app.add_systems(
            Update,
            (
                faders::expand_fader_button_commands,
                faders::end_released_flashes,
            )
                .chain()
                .after(DeskEventSet::EvalExpansion)
                .in_set(PendingCommandExpansion),
        );
        app.add_systems(
            Update,
            (
                faders::handle_fader_commands,
                faders::handle_fader_updates,
                (
                    masters::handle_master_commands,
                    masters::handle_master_updates,
                )
                    .chain()
                    .after(faders::handle_fader_commands),
            )
                .in_set(EventHandling),
        );
        app.add_systems(Update, faders::sync_fader_state.after(EventHandling));

        // Speed masters scale playback speed after new instances get their clocks and before
        // clocks advance.
        app.add_systems(
            Render,
            masters::apply_playback_speed_masters
                .in_set(ClockUpdate)
                .after(nightfall_clips::playback::clocks::add_missing_instance_clocks)
                .before(nightfall_clips::playback::clocks::advance_realtime_instance_clocks),
        );
        // Apply per-playback intensity scaling to the generated layers before compositing.
        app.add_systems(
            Render,
            (
                faders::resolve_held_button_effects,
                playback_intensity::apply_playback_intensity,
            )
                .chain()
                .after(LayerGeneration)
                .before(Compositing),
        );
        // Inhibit masters cap intensity before virtual dimmers and relations scale the composited
        // values.
        app.add_systems(
            Render,
            masters::apply_master_inhibition
                .in_set(VdimProcessing)
                .before(nightfall_fixtures::VirtualIntensity),
        );

        app.add_systems(
            PostUpdate,
            // Reads clip removals, which only last two updates.
            websocket::send_faders_on_change.in_set(ClientFeedback),
        );
        app.add_systems(
            Render,
            websocket::send_masters_on_change.in_set(ClientOutput),
        );
        app.add_systems(
            Update,
            websocket::handle_resync_state
                .in_set(ResyncHandling)
                // The showfile identity follows the masters and faders it describes.
                .before(nightfall_engine::ui_notification::send_pending_ui_notifications_on_resync),
        );
    }
}
