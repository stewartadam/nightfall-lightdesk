// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Input-only and render engine updates.
//!
//! Every engine update runs the input sets ([`InputHandling`](crate::InputHandling),
//! [`EventHandling`](crate::EventHandling), [`ResyncHandling`](crate::ResyncHandling) and
//! [`ClientFeedback`](crate::ClientFeedback)) so commands are handled and acknowledged as soon as
//! they arrive. Only render updates also run the render sets, from
//! [`ClockUpdate`](crate::ClockUpdate) through [`DmxOutput`](crate::DmxOutput) and
//! [`ClientOutput`](crate::ClientOutput). The frame limiter decides which kind the next update is
//! and records it in [`RenderPass`]: updates on the render grid render, updates started early by
//! a [`FrameWaker`](crate::frame_waker::FrameWaker) wake only handle input.
//!
//! Messages and component removals written in input-only updates must survive until the next
//! render reads them, so message buffers are only swapped after render updates (see
//! [`gate_message_updates`]) and removals that render systems need are re-published as
//! [`ComponentRemoved`] messages (see [`add_removal_messages`]).

use std::marker::PhantomData;

use bevy_app::prelude::*;
use bevy_ecs::lifecycle::Remove;
use bevy_ecs::message::{MessageRegistry, ShouldUpdateMessages};
use bevy_ecs::prelude::*;

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
    /// Returns whether the current update runs the render sets.
    pub fn renders(&self) -> bool {
        self.renders
    }

    /// Marks whether the update about to start runs the render sets.
    pub fn set_renders(&mut self, renders: bool) {
        self.renders = renders;
    }
}

/// Run condition for systems that only run in render updates.
pub fn render_due(pass: Option<Res<RenderPass>>) -> bool {
    pass.is_none_or(|pass| pass.renders)
}

/// Lets message buffers swap only once a render update has run.
///
/// Bevy swaps message buffers at the start of an update when [`MessageRegistry::should_update`]
/// allows it, so a message lives for two swaps. Swapping only after render updates keeps every
/// message written in an input-only update readable until the next render, however many
/// input-only updates come first. Readers in input sets run on every update and keep their own
/// cursor, so they still see each message exactly once.
///
/// Runs in [`PostUpdate`], after `bevy_time`'s fixed-timestep signal, which it replaces, and
/// before the frame limiter decides what the next update is.
pub fn gate_message_updates(
    pass: Option<Res<RenderPass>>,
    registry: Option<ResMut<MessageRegistry>>,
) {
    let Some(mut registry) = registry else {
        return;
    };
    registry.should_update = if render_due(pass) {
        ShouldUpdateMessages::Ready
    } else {
        ShouldUpdateMessages::Waiting
    };
}

/// Message published when component `C` is removed from an entity or the entity is despawned.
///
/// Unlike [`RemovedComponents`], which drops removals after two updates, these messages follow
/// [`gate_message_updates`], so systems in render sets see removals made in input-only updates.
#[derive(Message, Debug, Clone, Copy)]
pub struct ComponentRemoved<C: Component> {
    /// Entity the component was removed from.
    pub entity: Entity,
    _component: PhantomData<fn() -> C>,
}

impl<C: Component> ComponentRemoved<C> {
    /// Creates a removal message for `entity`.
    pub fn new(entity: Entity) -> Self {
        Self {
            entity,
            _component: PhantomData,
        }
    }
}

/// Publishes a [`ComponentRemoved<C>`] message whenever `C` is removed.
///
/// Safe to call from several plugins for the same component; only the first call registers the
/// observer.
pub fn add_removal_messages<C: Component>(app: &mut App) {
    if app
        .world()
        .contains_resource::<Messages<ComponentRemoved<C>>>()
    {
        return;
    }
    app.add_message::<ComponentRemoved<C>>();
    app.add_observer(
        |removed: On<Remove, C>, mut messages: MessageWriter<ComponentRemoved<C>>| {
            messages.write(ComponentRemoved::new(removed.entity));
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Message)]
    struct Ping;

    #[derive(Component)]
    struct Marker;

    #[derive(Resource, Default)]
    struct Seen {
        pings: usize,
        removals: usize,
    }

    /// Builds an app whose render-gated reader counts pings and `Marker` removals.
    fn gated_app() -> App {
        let mut app = App::new();
        app.add_plugins(bevy_time::TimePlugin);
        app.init_resource::<RenderPass>();
        app.init_resource::<Seen>();
        app.add_message::<Ping>();
        add_removal_messages::<Marker>(&mut app);
        app.add_systems(PostUpdate, gate_message_updates);
        app.add_systems(
            Update,
            (|mut pings: MessageReader<Ping>,
              mut removals: MessageReader<ComponentRemoved<Marker>>,
              mut seen: ResMut<Seen>| {
                seen.pings += pings.read().count();
                seen.removals += removals.read().count();
            })
            .run_if(render_due),
        );
        app
    }

    /// Runs one update as a render or input-only update.
    fn run(app: &mut App, renders: bool) {
        app.world_mut()
            .resource_mut::<RenderPass>()
            .set_renders(renders);
        app.update();
    }

    /// Messages and removals from input-only updates reach a render reader after many input-only
    /// updates, and are not seen twice.
    #[test]
    fn input_only_updates_keep_messages_for_the_next_render() {
        let mut app = gated_app();
        run(&mut app, true);

        app.world_mut().write_message(Ping);
        let entity = app.world_mut().spawn(Marker).id();
        app.world_mut().entity_mut(entity).remove::<Marker>();
        for _ in 0..10 {
            run(&mut app, false);
        }
        run(&mut app, true);
        run(&mut app, true);

        let seen = app.world().resource::<Seen>();
        assert_eq!(seen.pings, 1);
        assert_eq!(seen.removals, 1);
    }

    /// Render updates swap message buffers, so old messages are dropped after two renders.
    #[test]
    fn render_updates_drop_messages_after_two_swaps() {
        let mut app = gated_app();
        run(&mut app, false);
        app.world_mut().write_message(Ping);
        run(&mut app, false);
        run(&mut app, true);
        run(&mut app, true);
        run(&mut app, true);

        let messages = app.world().resource::<Messages<Ping>>();
        assert!(messages.is_empty());
    }
}
