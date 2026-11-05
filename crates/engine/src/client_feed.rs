// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Client feeds: state an owning plugin publishes to clients when it changes and replays to
//! clients that resync.
//!
//! A feed is a [`SystemParam`] that reads everything its snapshot needs and implements
//! [`ClientFeed::publish`]. [`ClientFeedAppExt::add_client_feed`] registers both directions:
//! replaying the snapshot to just the clients that asked for a resync, and publishing it to
//! every client when a run condition says the state changed or on an interval. Feeds that need
//! other placement add [`publish_client_feed`] and [`resync_client_feed`] themselves.

use std::marker::PhantomData;
use std::time::Duration;

use bevy_app::{App, PostUpdate, Update};
use bevy_ecs::intern::Interned;
use bevy_ecs::prelude::*;
use bevy_ecs::system::{StaticSystemParam, SystemParam, SystemParamItem};
use web_time::Instant;

use crate::client_bridge::ClientEventSink;
use crate::render_pass::Render;
use crate::resync::ResyncReplies;
use crate::{ClientFeedback, ClientOutput, ResyncHandling};

/// An interned system set, which a resync can be ordered after.
type InternedSystemSet = Interned<dyn SystemSet>;

/// State a plugin publishes to clients as one or more snapshot messages.
pub trait ClientFeed: SystemParam + 'static {
    /// Publishes the feed's current snapshot to `sink`, choosing each message's discriminator.
    fn publish(feed: &SystemParamItem<'_, '_, Self>, sink: &ClientEventSink);
}

/// Publishes feed `F` to every client; a no-op when no host adapter is attached.
pub fn publish_client_feed<F: ClientFeed>(
    feed: StaticSystemParam<F>,
    sink: Option<Res<ClientEventSink>>,
) {
    if let Some(sink) = sink {
        F::publish(&feed, &sink);
    }
}

/// Publishes feed `F` to the clients that asked for a resync this frame.
pub fn resync_client_feed<F: ClientFeed>(mut resync: ResyncReplies, feed: StaticSystemParam<F>) {
    if let Some(sink) = resync.sink() {
        F::publish(&feed, &sink);
    }
}

/// Run condition that passes on its first run and then at most once per `interval` of wall time.
///
/// Used to refresh feeds whose values drift continuously, and to throttle feeds whose state can
/// change every frame.
pub fn every(interval: Duration) -> impl FnMut(Local<Option<Instant>>) -> bool + Clone {
    move |mut last_passed: Local<Option<Instant>>| {
        let now = Instant::now();
        if last_passed.is_some_and(|passed_at| now.duration_since(passed_at) < interval) {
            return false;
        }
        *last_passed = Some(now);
        true
    }
}

/// A resource whose whole value is a client feed, such as a device list or a status.
pub trait ResourceFeed: Resource {
    /// Publishes the resource's current value to `sink`, choosing each message's discriminator.
    fn publish(&self, sink: &ClientEventSink);
}

/// The [`ClientFeed`] of a [`ResourceFeed`] resource.
#[derive(SystemParam)]
pub struct ResourceFeedParam<'w, R: ResourceFeed> {
    resource: Res<'w, R>,
}

impl<R: ResourceFeed> ClientFeed for ResourceFeedParam<'static, R> {
    /// Publishes the resource's current value.
    fn publish(feed: &ResourceFeedParam<'_, R>, sink: &ClientEventSink) {
        feed.resource.publish(sink);
    }
}

/// Registers client feeds on an [`App`].
pub trait ClientFeedAppExt {
    /// Adds feed `F`, replayed to resyncing clients in [`ResyncHandling`], and returns a builder
    /// that sets when it is also published to every client.
    fn add_client_feed<F: ClientFeed>(&mut self) -> ClientFeedBuilder<'_, F>;

    /// Adds resource `R` as a feed published whenever the resource changes, and returns its
    /// builder for any further publication or ordering.
    fn add_resource_feed<R: ResourceFeed>(
        &mut self,
    ) -> ClientFeedBuilder<'_, ResourceFeedParam<'static, R>> {
        self.add_resource_feed_when::<R, _>(resource_changed::<R>)
    }

    /// Adds resource `R` as a feed published whenever `changed` passes, for resources that change
    /// more often than clients need to hear about.
    fn add_resource_feed_when<R: ResourceFeed, M>(
        &mut self,
        changed: impl SystemCondition<M>,
    ) -> ClientFeedBuilder<'_, ResourceFeedParam<'static, R>>;
}

impl ClientFeedAppExt for App {
    fn add_client_feed<F: ClientFeed>(&mut self) -> ClientFeedBuilder<'_, F> {
        ClientFeedBuilder {
            app: self,
            resync_after: None,
            feed: PhantomData,
        }
    }

    fn add_resource_feed_when<R: ResourceFeed, M>(
        &mut self,
        changed: impl SystemCondition<M>,
    ) -> ClientFeedBuilder<'_, ResourceFeedParam<'static, R>> {
        self.add_client_feed::<ResourceFeedParam<R>>()
            .on_change(changed)
    }
}

/// Sets when a feed added with [`ClientFeedAppExt::add_client_feed`] is published. Its resync
/// reply is registered when the builder is dropped, after any [`Self::resync_after`].
pub struct ClientFeedBuilder<'a, F: ClientFeed> {
    app: &'a mut App,
    resync_after: Option<InternedSystemSet>,
    feed: PhantomData<fn() -> F>,
}

impl<F: ClientFeed> ClientFeedBuilder<'_, F> {
    /// Replays this feed on resync after `set`, such as another feed's [`resync_client_feed`],
    /// for snapshots that refer to state the other one sends.
    pub fn resync_after<M>(mut self, set: impl IntoSystemSet<M>) -> Self {
        self.resync_after = Some(set.into_system_set().intern());
        self
    }

    /// Publishes the feed in [`ClientFeedback`] whenever `changed` passes. That set runs every
    /// update after the render pass, so the feed sees changes made by commands and by rendering.
    pub fn on_change<M>(self, changed: impl SystemCondition<M>) -> Self {
        self.app.add_systems(
            PostUpdate,
            publish_client_feed::<F>
                .run_if(changed)
                .in_set(ClientFeedback),
        );
        self
    }

    /// Publishes the feed in [`ClientOutput`] at most once per `interval`, for values that drift
    /// with every rendered frame.
    pub fn on_interval(self, interval: Duration) -> Self {
        self.app.add_systems(
            Render,
            publish_client_feed::<F>
                .run_if(every(interval))
                .in_set(ClientOutput),
        );
        self
    }
}

impl<F: ClientFeed> Drop for ClientFeedBuilder<'_, F> {
    /// Registers the feed's resync reply, ordered after the set given to
    /// [`ClientFeedBuilder::resync_after`] if any.
    fn drop(&mut self) {
        let resync = resync_client_feed::<F>.in_set(ResyncHandling);
        match self.resync_after {
            Some(set) => self.app.add_systems(Update, resync.after(set)),
            None => self.app.add_systems(Update, resync),
        };
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use bevy_app::App;

    use super::*;
    use crate::client_bridge::DISCRIMINATOR_NON_DROPPABLE;
    use crate::prelude::{Audience, ClientId, OutboundFrame};
    use crate::resync::ResyncRequested;

    /// Counter whose value the test feed publishes.
    #[derive(Resource, Default)]
    struct Counter(u32);

    /// Test feed publishing the counter.
    #[derive(SystemParam)]
    struct CounterFeed<'w> {
        counter: Res<'w, Counter>,
    }

    impl ClientFeed for CounterFeed<'static> {
        /// Publishes the counter value.
        fn publish(feed: &CounterFeed<'_>, sink: &ClientEventSink) {
            sink.publish(DISCRIMINATOR_NON_DROPPABLE, &feed.counter.0);
        }
    }

    /// Builds an app with the counter feed and returns it with the receiver of published frames.
    fn app() -> (App, async_channel::Receiver<OutboundFrame>) {
        let mut app = App::new();
        let (tx, rx) = async_channel::unbounded();
        app.insert_resource(ClientEventSink::new(tx));
        app.init_resource::<Counter>();
        app.add_message::<ResyncRequested>();
        app.add_client_feed::<CounterFeed>()
            .on_change(resource_changed::<Counter>);
        (app, rx)
    }

    /// Returns the audiences of every frame published since the last call.
    fn drained(rx: &async_channel::Receiver<OutboundFrame>) -> Vec<Audience> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .map(|frame| frame.audience)
            .collect()
    }

    /// Verifies a feed publishes to everyone when it changes and stays quiet otherwise.
    #[test]
    fn publishes_on_change_only() {
        let (mut app, rx) = app();
        app.update();
        assert_eq!(drained(&rx), vec![Audience::All]);
        app.update();
        assert!(drained(&rx).is_empty());
        app.world_mut().resource_mut::<Counter>().0 = 1;
        app.update();
        assert_eq!(drained(&rx), vec![Audience::All]);
    }

    /// Verifies a resync replays the feed to just the requesting client.
    #[test]
    fn resync_publishes_to_requesting_client() {
        let (mut app, rx) = app();
        app.update();
        drained(&rx);
        let client = ClientId(7);
        app.world_mut().write_message(ResyncRequested {
            command_id: None,
            audience: Audience::Client(client),
        });
        app.update();
        assert_eq!(drained(&rx), vec![Audience::Client(client)]);
    }

    /// Verifies the interval condition passes first, then waits out the interval.
    #[test]
    fn every_waits_out_the_interval() {
        let passes = Arc::new(Mutex::new(0));
        let mut app = App::new();
        let counted = passes.clone();
        app.add_systems(
            Update,
            (move || *counted.lock().unwrap() += 1).run_if(every(Duration::from_secs(3600))),
        );
        app.update();
        app.update();
        assert_eq!(*passes.lock().unwrap(), 1);
    }
}
