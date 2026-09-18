// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use bevy_app::prelude::*;
use bevy_time::{TimePlugin, TimeUpdateStrategy};
use nightfall_timecode::{prelude::*, systems::update_timecode_system};

/// The timecode update system advances active generators from Bevy's frame delta.
#[test]
fn test_timecode_update_system() {
    // Initialize a new Bevy app with our timecode systems
    let mut app = App::new();

    app.add_plugins(TimePlugin);
    app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_millis(1)));
    app.add_systems(Update, update_timecode_system);

    // Create a new TimecodeGenerator entity
    let entity = app.world_mut().spawn(TimecodeGenerator::default()).id();

    // Start the timecode
    {
        let world = app.world_mut();
        let mut entity_mut = world.entity_mut(entity);
        let mut generator = entity_mut.get_mut::<TimecodeGenerator>().unwrap();
        generator.start();
    }

    // Run the update system
    app.update();

    // Verify that time has not advanced significantly (since updates happen in real-time)
    {
        let generator = app
            .world()
            .entity(entity)
            .get::<TimecodeGenerator>()
            .unwrap();
        assert!(generator.accumulated_time < Duration::from_millis(10));
        assert!(generator.state.is_active);
    }

    // Modify the generator to simulate time passing
    {
        let world = app.world_mut();
        let mut entity_mut = world.entity_mut(entity);
        let mut generator = entity_mut.get_mut::<TimecodeGenerator>().unwrap();
        // Simulate 100ms passing
        generator.accumulated_time = Duration::from_millis(100);
    }

    // Run the update system again
    app.update();

    // Verify time has advanced beyond our simulated amount
    {
        let generator = app
            .world_mut()
            .entity(entity)
            .get::<TimecodeGenerator>()
            .unwrap();
        assert!(generator.accumulated_time > Duration::from_millis(100));
    }

    // Set an end time and simulate reaching it
    {
        let world = app.world_mut();
        let mut entity_mut = world.entity_mut(entity);
        let mut generator = entity_mut.get_mut::<TimecodeGenerator>().unwrap();
        generator.state.end_time = Some(Duration::from_millis(150));
        generator.accumulated_time = Duration::from_millis(160); // Beyond the end time
    }

    // Run the update system again
    app.update();

    // Verify generator has stopped
    {
        let generator = app
            .world()
            .entity(entity)
            .get::<TimecodeGenerator>()
            .unwrap();
        assert!(!generator.state.is_active);
        assert_eq!(generator.accumulated_time, Duration::ZERO);
        assert_eq!(generator.state.current_time, Duration::ZERO);
    }
}
