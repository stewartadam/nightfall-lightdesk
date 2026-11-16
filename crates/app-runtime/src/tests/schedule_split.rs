// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Checks that no system orders itself against work that lives in the other of `Update` and
//! `ApplyCommands`, where Bevy would silently ignore the ordering.

use bevy::ecs::schedule::graph::Direction;
use bevy::ecs::schedule::{NodeId, ScheduleGraph, ScheduleLabel, Schedules, SystemSet};
use bevy::prelude::Update;
use nightfall_engine::prelude::ApplyCommands;

use super::sample_app;

/// Returns each named set in `graph` with whether any system belongs to it, directly or through
/// a child set.
fn named_sets(graph: &ScheduleGraph) -> Vec<(&dyn SystemSet, bool)> {
    let hierarchy = graph.hierarchy().graph();
    graph
        .system_sets
        .iter()
        .filter(|(_, set, _)| !set.is_anonymous())
        .map(|(key, set, _)| {
            let mut pending = vec![NodeId::Set(key)];
            let mut populated = false;
            while let Some(node) = pending.pop() {
                for child in hierarchy.neighbors_directed(node, Direction::Outgoing) {
                    match child {
                        NodeId::System(_) => populated = true,
                        NodeId::Set(_) => pending.push(child),
                    }
                }
                if populated {
                    break;
                }
            }
            (set, populated)
        })
        .collect()
}

/// Returns the names of sets that `schedule` configures or orders against but holds no system
/// of, while `other` does hold systems of them.
///
/// Ordering only applies between systems of one schedule, so such a set is a constraint or run
/// condition that never takes effect: usually a system registered in the wrong schedule, or one
/// that orders against [`nightfall_engine::prelude::EventHandling`] from `Update` instead of
/// against [`nightfall_engine::prelude::CommandApplication`].
fn sets_only_populated_in(schedule: &ScheduleGraph, other: &ScheduleGraph) -> Vec<String> {
    let populated_there = named_sets(other)
        .into_iter()
        .filter_map(|(set, populated)| populated.then_some(set))
        .collect::<Vec<_>>();
    let mut crossing = named_sets(schedule)
        .into_iter()
        .filter(|(set, populated)| !populated && populated_there.iter().any(|there| *there == *set))
        .map(|(set, _)| format!("{set:?}"))
        .collect::<Vec<_>>();
    crossing.sort();
    crossing
}

/// Every set that `Update` orders against or configures has its systems in `Update`, and the
/// same holds for `ApplyCommands`, so no ordering between the two schedules is silently dropped.
#[tokio::test]
async fn no_ordering_crosses_the_command_schedule() {
    let mut app = sample_app();
    app.update();
    let schedules = app.world().resource::<Schedules>();
    let update = schedules
        .get(Update.intern())
        .expect("Update exists")
        .graph();
    let commands = schedules
        .get(ApplyCommands.intern())
        .expect("ApplyCommands exists")
        .graph();

    let from_update = sets_only_populated_in(update, commands);
    let from_commands = sets_only_populated_in(commands, update);

    assert!(
        from_update.is_empty(),
        "Update orders against sets whose systems run in ApplyCommands; order against \
         CommandApplication or move the system: {from_update:?}"
    );
    assert!(
        from_commands.is_empty(),
        "ApplyCommands orders against sets whose systems run in Update; move the system: \
         {from_commands:?}"
    );
}

/// The check reports an `Update` system that orders against [`EventHandling`], whose systems run
/// in `ApplyCommands`, so a misplaced registration can't pass unnoticed.
///
/// [`EventHandling`]: nightfall_engine::prelude::EventHandling
#[test]
fn ordering_against_the_other_schedule_is_reported() {
    use bevy::prelude::{App, IntoScheduleConfigs};
    use nightfall_engine::prelude::{EventHandling, add_apply_commands};

    let mut app = App::new();
    add_apply_commands(&mut app);
    app.add_systems(ApplyCommands, (|| {}).in_set(EventHandling));
    app.add_systems(Update, (|| {}).after(EventHandling));
    app.update();
    let schedules = app.world().resource::<Schedules>();
    let update = schedules
        .get(Update.intern())
        .expect("Update exists")
        .graph();
    let commands = schedules
        .get(ApplyCommands.intern())
        .expect("ApplyCommands exists")
        .graph();

    assert_eq!(sets_only_populated_in(update, commands), ["EventHandling"]);
}
