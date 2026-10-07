// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_app::prelude::*;
use nightfall::prelude::Group;
use nightfall_desk::systems::event_handlers::instance_events::handle_events;
use nightfall_engine::prelude::{
    CommandError, DataProvider, EngineActionEnvelope, OperationResult,
};
use nightfall_fixtures::prelude::{
    ConsoleChannelOrigin, ConsoleDmxUniverses, FixtureDataProviderExt,
};
use nightfall_instances::{PlaybackAction, PlaybackScope};
use nightfall_io::BindingTransport;

/// Verifies releasing every parameter frees every console slot instead of leaving system-owned
/// zeros, so released console universes stop being routed to transports.
#[test]
fn test_release_all_frees_dmx_universes() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<PlaybackAction>>();
    app.add_message::<OperationResult<(), CommandError>>();
    app.insert_resource(FixtureDataProviderExt::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(ConsoleDmxUniverses::default());
    app.add_systems(Update, handle_events);

    {
        let mut universes = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
        universes.set_value(1, 1, 255, ConsoleChannelOrigin::ManualCommand);
        universes.set_value(1, 2, 128, ConsoleChannelOrigin::OutputBinding);
        universes.set_value(
            2,
            1,
            64,
            ConsoleChannelOrigin::InputTransport {
                transport: BindingTransport::Sacn,
                universe: 4,
            },
        );
    }

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(
            PlaybackAction::ReleaseParameters {
                scope: PlaybackScope::All,
            },
        ));
    app.update();

    let universes = app.world().resource::<ConsoleDmxUniverses>();
    assert_eq!(universes.get_origin(1, 1), None);
    assert_eq!(universes.get_origin(2, 1), None);
    assert!(
        !universes.has_universe(1) && !universes.has_universe(2),
        "released console universes should no longer be output"
    );
}
