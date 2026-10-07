// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Input updates and render passes.
//!
//! Every engine update runs [`Update`], whose input sets ([`InputHandling`](crate::InputHandling),
//! [`EventHandling`](crate::EventHandling) and [`ResyncHandling`](crate::ResyncHandling)) apply
//! commands and input to world state as soon as they arrive, and [`PostUpdate`], whose
//! [`ClientFeedback`](crate::ClientFeedback) set acknowledges them. Only updates the frame limiter
//! marks as render passes in [`RenderPass`] also run the [`Render`] schedule, from
//! [`ClockUpdate`](crate::ClockUpdate) through [`DmxOutput`](crate::DmxOutput) and
//! [`ClientOutput`](crate::ClientOutput). Updates started early by a
//! [`FrameWaker`](crate::frame_waker::FrameWaker) wake only handle input.
//!
//! Render systems read world state, never input messages or [`RemovedComponents`]. Messages
//! expire after two buffer swaps (with `bevy_time`, two fixed-timestep ticks) and removals after
//! two updates, and any number of input-only updates can run between two render passes. Input
//! that render systems depend on is applied to components or resources in the input sets
//! instead, and removals are handled by observers when they happen.

use bevy_app::{MainScheduleOrder, prelude::*};
use bevy_ecs::{prelude::*, schedule::ScheduleLabel};

/// Schedule of render passes: clocks, layer generation, compositing, virtual dimming and output.
///
/// Runs after [`Update`] and before [`PostUpdate`] in updates that render. Systems in it must only
/// read world state; see the [module docs](self).
#[derive(ScheduleLabel, Debug, Clone, PartialEq, Eq, Hash)]
pub struct Render;

/// Main-schedule step that runs [`Render`] when the current update renders.
#[derive(ScheduleLabel, Debug, Clone, PartialEq, Eq, Hash)]
struct RunRender;

/// Whether the current engine update renders, or only handles input.
///
/// Defaults to rendering, so hosts without a frame limiter (tests, the browser runtime) render on
/// every update as before.
#[derive(Resource, Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderPass {
    renders: bool,
}

impl Default for RenderPass {
    fn default() -> Self {
        Self { renders: true }
    }
}

impl RenderPass {
    /// Returns whether the current update runs the [`Render`] schedule.
    pub fn renders(&self) -> bool {
        self.renders
    }

    /// Marks whether the update about to start runs the [`Render`] schedule.
    pub fn set_renders(&mut self, renders: bool) {
        self.renders = renders;
    }
}

/// Adds the [`Render`] schedule to the main schedule order, right after [`Update`].
///
/// [`EnginePlugin`](crate::EnginePlugin) calls this; apps built without it, such as plugin tests,
/// call it so their render systems run. Calling it again has no effect.
pub fn add_render_schedule(app: &mut App) {
    if app
        .world()
        .resource::<MainScheduleOrder>()
        .labels
        .contains(&RunRender.intern())
    {
        return;
    }
    app.init_resource::<RenderPass>();
    app.init_schedule(Render);
    app.init_schedule(RunRender);
    app.world_mut()
        .resource_mut::<MainScheduleOrder>()
        .insert_after(Update, RunRender);
    app.add_systems(RunRender, run_render);
}

/// Runs the [`Render`] schedule unless the frame limiter marked this update as input-only.
fn run_render(world: &mut World) {
    if world
        .get_resource::<RenderPass>()
        .is_none_or(RenderPass::renders)
    {
        world.run_schedule(Render);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Counts how often each schedule ran.
    #[derive(Resource, Default)]
    struct Runs {
        update: usize,
        render: usize,
        post_update_saw_render: usize,
    }

    /// Builds an app that counts runs of [`Update`] and [`Render`], and records whether
    /// [`PostUpdate`] ran after the render in the same update.
    fn counting_app() -> App {
        let mut app = App::new();
        add_render_schedule(&mut app);
        app.init_resource::<Runs>();
        app.add_systems(Update, |mut runs: ResMut<Runs>| runs.update += 1);
        app.add_systems(Render, |mut runs: ResMut<Runs>| runs.render += 1);
        app.add_systems(
            PostUpdate,
            |mut runs: ResMut<Runs>, mut last_render: Local<usize>| {
                if runs.render != *last_render {
                    runs.post_update_saw_render += 1;
                    *last_render = runs.render;
                }
            },
        );
        app
    }

    /// Input-only updates skip the render schedule, and render updates run it between `Update`
    /// and `PostUpdate`.
    #[test]
    fn render_schedule_runs_only_in_render_updates() {
        let mut app = counting_app();
        app.update();
        for _ in 0..3 {
            app.world_mut()
                .resource_mut::<RenderPass>()
                .set_renders(false);
            app.update();
        }
        app.world_mut()
            .resource_mut::<RenderPass>()
            .set_renders(true);
        app.update();

        let runs = app.world().resource::<Runs>();
        assert_eq!(runs.update, 5);
        assert_eq!(runs.render, 2);
        assert_eq!(runs.post_update_saw_render, 2);
    }
}
