// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The [`ApplyCommands`] schedule, which applies queued commands and operations, and reruns
//! for work that settles in dependent steps.
//!
//! Applying commands is its own schedule rather than a stretch of [`Update`]. It holds
//! [`PendingCommandExpansion`], [`PendingCommandProcessing`] and [`EventHandling`], plus the
//! systems that finish commands or keep state that command handlers read, ordered after
//! [`EventHandling`]. [`Update`] runs it once per update from [`CommandApplication`], after input
//! handling and before the systems that publish or persist what the commands changed.
//!
//! Some work can only take its next step after a handler has applied the previous one. Undo is
//! the main case: it captures each entry's inverse against the state the earlier entries left,
//! and only the owning domain's handler can apply an entry. A system with such work in progress
//! calls [`CommandRerun::request`], and [`ApplyCommands`] runs again right away, within a
//! per-update budget. Because only this schedule reruns, input handling, time-driven systems,
//! publication and the render pass run once per update whatever the reruns do.

use std::time::Duration;

use bevy_app::prelude::*;
use bevy_ecs::{prelude::*, schedule::ScheduleLabel};
use web_time::Instant;

use crate::frame_waker::FrameWaker;
use crate::{EventHandling, InputHandling, PendingCommandExpansion, PendingCommandProcessing};

/// Default for the longest one update spends rerunning [`ApplyCommands`] before leaving the
/// rest for the next update.
const DEFAULT_RERUN_BUDGET: Duration = Duration::from_millis(8);

/// Most reruns of [`ApplyCommands`] in one update, whatever the budget.
const MAX_RERUNS_PER_UPDATE: usize = 256;

/// Schedule that applies queued commands and engine operations.
///
/// Register command handlers here in [`EventHandling`], and systems that finish commands or
/// maintain state that handlers or undo inverses read here after [`EventHandling`]. Systems that
/// only publish, persist or derive output from what commands changed belong in [`Update`] after
/// [`CommandApplication`], so reruns don't repeat them.
///
/// The schedule can run several times in one update, so every system in it must be safe to
/// rerun: a run with no new input must change nothing and publish nothing. Act on messages
/// through a `MessageReader`, which yields each message once, or on state that the work itself
/// clears or marks done. Don't act on a timer, a counter, or change detection of state that
/// another system in this schedule marks changed on every run. The `rerun_safety` test in
/// `app-runtime` drives a sample show with an extra run in every update and fails when results,
/// client messages or output differ.
#[derive(ScheduleLabel, Debug, Clone, PartialEq, Eq, Hash)]
pub struct ApplyCommands;

/// [`Update`] system set holding the system that runs [`ApplyCommands`].
///
/// Order [`Update`] systems against this set, not against the sets inside [`ApplyCommands`]:
/// ordering only applies between systems of the same schedule.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct CommandApplication;

/// Requests to run [`ApplyCommands`] again in this update.
#[derive(Resource, Debug)]
pub struct CommandRerun {
    requested: bool,
    budget: Duration,
}

impl Default for CommandRerun {
    /// Starts with no request and the default per-update budget.
    fn default() -> Self {
        Self {
            requested: false,
            budget: DEFAULT_RERUN_BUDGET,
        }
    }
}

impl CommandRerun {
    /// Asks for one more run of [`ApplyCommands`] before the rest of this update.
    ///
    /// Call it from a system in [`ApplyCommands`] whose work waits on a handler that runs in a
    /// later pass. Each run clears the request, so work that still needs a run asks again. A
    /// request made outside [`ApplyCommands`] is dropped when the next update starts applying
    /// commands.
    pub fn request(&mut self) {
        self.requested = true;
    }

    /// Returns whether another run has been asked for since the last one started.
    pub fn is_requested(&self) -> bool {
        self.requested
    }

    /// Sets the longest one update spends on reruns. Tests that check work settles within one
    /// update raise it so a slow machine doesn't split the work across updates.
    pub fn set_budget(&mut self, budget: Duration) {
        self.budget = budget;
    }
}

/// Adds the [`ApplyCommands`] schedule with its set order, and the [`Update`] system that runs
/// it after [`InputHandling`]. Calling it again does nothing.
pub fn add_apply_commands(app: &mut App) {
    if app.world().contains_resource::<CommandRerun>() {
        return;
    }
    app.init_resource::<CommandRerun>();
    app.init_schedule(ApplyCommands);
    app.configure_sets(
        ApplyCommands,
        (
            PendingCommandExpansion,
            PendingCommandProcessing.after(PendingCommandExpansion),
            EventHandling.after(PendingCommandProcessing),
        ),
    );
    app.configure_sets(Update, CommandApplication.after(InputHandling));
    app.add_systems(Update, run_apply_commands.in_set(CommandApplication));
}

/// Runs [`ApplyCommands`], then reruns it while a run is requested, within the update's budget.
///
/// A rerun starts only when the time spent so far plus the longest run seen in this update still
/// fits the budget, so reruns never push a rendering frame past its output tick. When work is
/// still pending once the budget is spent, wakes the frame limiter so the next update starts
/// early and carries on. The pending request itself is dropped: the work asks again from the
/// next update's first run, so a stale request never forces a run that nothing needs.
pub fn run_apply_commands(world: &mut World) {
    let started = Instant::now();
    world.resource_mut::<CommandRerun>().requested = false;
    world.run_schedule(ApplyCommands);
    let budget = world.resource::<CommandRerun>().budget;
    let mut longest_run = started.elapsed();
    for _ in 0..MAX_RERUNS_PER_UPDATE {
        {
            let mut rerun = world.resource_mut::<CommandRerun>();
            if !rerun.requested || started.elapsed() + longest_run > budget {
                break;
            }
            rerun.requested = false;
        }
        let run_started = Instant::now();
        world.run_schedule(ApplyCommands);
        longest_run = longest_run.max(run_started.elapsed());
    }
    if std::mem::take(&mut world.resource_mut::<CommandRerun>().requested)
        && let Some(waker) = world.get_resource::<FrameWaker>()
    {
        waker.wake();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render_pass::{Render, add_render_schedule};

    /// Counts runs of each stage, and requests reruns until a target count is reached.
    #[derive(Resource, Default)]
    struct Runs {
        apply: usize,
        update: usize,
        input: usize,
        wanted: usize,
        rendered_after: Option<usize>,
    }

    /// Records one run of [`ApplyCommands`] and asks for another until `wanted` runs have
    /// happened.
    fn count_and_request(mut runs: ResMut<Runs>, mut rerun: ResMut<CommandRerun>) {
        runs.apply += 1;
        if runs.apply < runs.wanted {
            rerun.request();
        }
    }

    /// Records a run of an [`Update`] system outside [`CommandApplication`].
    fn count_update(mut runs: ResMut<Runs>) {
        runs.update += 1;
    }

    /// Records a run of the input set.
    fn count_input(mut runs: ResMut<Runs>) {
        runs.input += 1;
    }

    /// Records how many command runs had happened when the render pass started.
    fn record_render(mut runs: ResMut<Runs>) {
        runs.rendered_after = Some(runs.apply);
    }

    /// Builds an app with the command schedule and the counting systems.
    fn app(wanted: usize) -> App {
        let mut app = App::new();
        add_render_schedule(&mut app);
        add_apply_commands(&mut app);
        app.insert_resource(Runs {
            wanted,
            ..Default::default()
        });
        app.add_systems(ApplyCommands, count_and_request.in_set(EventHandling));
        app.add_systems(Update, count_update.after(CommandApplication));
        app.add_systems(Update, count_input.in_set(InputHandling));
        app.add_systems(Render, record_render);
        app
    }

    /// Verifies requested reruns all happen inside one update and before the render pass, while
    /// input handling and the rest of `Update` run once.
    #[test]
    fn requested_reruns_run_before_render_without_rerunning_update() {
        let mut app = app(4);

        app.update();

        let runs = app.world().resource::<Runs>();
        assert_eq!(runs.apply, 4);
        assert_eq!(runs.update, 1);
        assert_eq!(runs.input, 1);
        assert_eq!(runs.rendered_after, Some(4));
    }

    /// Verifies an update with no request runs the command schedule once.
    #[test]
    fn no_request_runs_commands_once() {
        let mut app = app(1);

        app.update();

        assert_eq!(app.world().resource::<Runs>().apply, 1);
    }

    /// Verifies a request that never stops is capped within the update, the leftover request
    /// is dropped, and the frame limiter is woken so the work carries on in the next update.
    #[test]
    fn endless_requests_are_capped_and_wake_the_next_update() {
        let mut app = app(usize::MAX);
        let waker = FrameWaker::default();
        app.insert_resource(waker.clone());
        let before = waker.generation();

        app.update();

        let runs = app.world().resource::<Runs>().apply;
        assert!((2..=MAX_RERUNS_PER_UPDATE + 1).contains(&runs));
        assert!(!app.world().resource::<CommandRerun>().is_requested());
        assert_ne!(waker.generation(), before);
    }
}
