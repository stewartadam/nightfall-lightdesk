// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Keeps the detected input universes in step with the showfile's IO settings.

use bevy_ecs::prelude::*;
use nightfall_io::{InputUniverseVisibilityMode, IoRuntimeSettings};

use crate::universe::{InputDmxUniverses, InputUniverseStaleTimeout};

/// Copies the signal-loss timeout, which the IO plugin has already clamped, into the stale input
/// threshold, and forgets the detected input
/// universes when the visibility mode changes so the input views repopulate under the new filter.
///
/// The first mode seen is only recorded, so loading a show does not discard inputs it already
/// detected.
pub(crate) fn sync_input_universes_from_io_settings(
    settings: Res<IoRuntimeSettings>,
    mut stale_timeout: ResMut<InputUniverseStaleTimeout>,
    mut input_universes: ResMut<InputDmxUniverses>,
    mut previous_mode: Local<Option<InputUniverseVisibilityMode>>,
) {
    if !settings.is_changed() {
        return;
    }
    let timeout = settings.input_signal_loss_timeout;
    if stale_timeout.0 != timeout {
        stale_timeout.0 = timeout;
    }
    let mode = settings.input_universe_visibility_mode;
    if previous_mode.is_some_and(|previous| previous != mode) {
        input_universes.clear();
    }
    *previous_mode = Some(mode);
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use bevy_app::{App, Update};
    use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
    use nightfall_io::RouteTransport;
    use web_time::Instant;

    use super::*;

    /// Builds an app that runs the sync system over default settings.
    fn sync_app() -> App {
        let mut app = App::new();
        app.init_resource::<IoRuntimeSettings>()
            .init_resource::<InputUniverseStaleTimeout>()
            .init_resource::<InputDmxUniverses>()
            .add_systems(Update, sync_input_universes_from_io_settings);
        app.update();
        app
    }

    /// Records one detected input universe.
    fn detect_universe(app: &mut App) {
        app.world_mut()
            .resource_mut::<InputDmxUniverses>()
            .set_universe(
                RouteTransport::ArtNet,
                1,
                [0; MAX_CHANNELS_PER_UNIVERSE],
                Instant::now(),
            );
    }

    /// Verifies a new signal-loss timeout reaches the stale input threshold.
    #[test]
    fn timeout_reaches_stale_threshold() {
        let mut app = sync_app();
        app.world_mut()
            .resource_mut::<IoRuntimeSettings>()
            .input_signal_loss_timeout = Duration::from_millis(750);
        app.update();
        assert_eq!(
            app.world().resource::<InputUniverseStaleTimeout>().0,
            Duration::from_millis(750)
        );
    }

    /// Verifies only a real visibility mode change discards detected input universes.
    #[test]
    fn visibility_mode_change_clears_detected_universes() {
        let mut app = sync_app();
        detect_universe(&mut app);
        app.world_mut()
            .resource_mut::<IoRuntimeSettings>()
            .input_signal_loss_timeout = Duration::from_millis(750);
        app.update();
        assert!(
            app.world()
                .resource::<InputDmxUniverses>()
                .active_universe(RouteTransport::ArtNet, 1)
                .is_some()
        );

        app.world_mut()
            .resource_mut::<IoRuntimeSettings>()
            .input_universe_visibility_mode = InputUniverseVisibilityMode::AllDetected;
        app.update();
        assert!(
            app.world()
                .resource::<InputDmxUniverses>()
                .active_universe(RouteTransport::ArtNet, 1)
                .is_none()
        );
    }
}
