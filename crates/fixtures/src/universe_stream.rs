// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! DMX universe stream for the DMX universe panel and patch views.
//!
//! Clients get two messages:
//!
//! - `DmxUniverseList`, broadcast to every client, names each output and input universe without
//!   its channel values. It is published only when it changes, and again on every resync.
//! - `DmxUniverseChannels` carries channel values, and only for the universes a client watches
//!   through [`DMX_UNIVERSE_WATCH_MODULE`]. Each watching client gets its own message, published
//!   when the watched values change, at most [`STREAM_INTERVAL`] apart unless the watch itself
//!   changed.
//!
//! A large rig has hundreds of universes while a DMX panel shows one, so sending every universe's
//! channels to every client would cost far more than the panel needs.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use bevy_ecs::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_io::{BindingTransport, OutputTransport};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use web_time::Instant;

use crate::output_frames::{OutputDmxFrames, output_transport_label};
use crate::parameter_state::WireBytes;
use crate::universe::{ConsoleDmxUniverses, InputDmxUniverses, InputUniverseStaleTimeout};
use crate::websocket::FixtureWsMessage;

/// Update module a client sends to choose the universes whose channel values it receives.
pub const DMX_UNIVERSE_WATCH_MODULE: &str = "DmxUniverseWatch";

/// Shortest time between two publications of unchanged watches.
pub const STREAM_INTERVAL: Duration = Duration::from_millis(100);

/// Most universes one client can watch at once.
pub const MAX_WATCHED_UNIVERSES: usize = 64;

/// Label of the numbering space for console-space output universes.
pub const CONSOLE_SPACE_LABEL: &str = "Console";

/// DMX input/output mode.
#[typeshare::typeshare]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum DmxIoMode {
    /// Values received from a transport.
    Input,
    /// Values the console outputs.
    Output,
}

/// Identifies one universe the DMX panel can show.
#[typeshare::typeshare]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct DmxUniverseKey {
    /// Universe number within its numbering space.
    pub universe_id: u16,
    /// Whether the universe is received or output.
    pub io_mode: DmxIoMode,
    /// Display label of the numbering space: `Console` for console-space output universes,
    /// otherwise the transport (`sACN`, `sACN → 10.0.0.4`, `Art-Net`, `USB`…) using wire
    /// numbering. Input universes carry their input transport family.
    pub transport: String,
}

/// One universe in the `DmxUniverseList`, without its channel values.
#[typeshare::typeshare]
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct DmxUniverseSummary {
    /// Universe number within its numbering space.
    pub universe_id: u16,
    /// Whether the universe is received or output.
    pub io_mode: DmxIoMode,
    /// Numbering space label, as in [`DmxUniverseKey::transport`].
    pub transport: String,
    /// Concrete output transport of a wire output universe; `None` for console space and input.
    pub output_transport: Option<OutputTransport>,
    /// Whether an input universe stopped receiving frames; `None` for output.
    pub is_stale: Option<bool>,
    /// Whether an input universe's latest frame came from this console; `None` for output.
    pub is_self: Option<bool>,
}

/// Channel values of one watched universe in a `DmxUniverseChannels` message.
#[typeshare::typeshare]
#[derive(Debug, Serialize)]
pub struct DmxUniverseChannels<'a> {
    /// Universe number within its numbering space.
    pub universe_id: u16,
    /// Whether the universe is received or output.
    pub io_mode: DmxIoMode,
    /// Numbering space label, as in [`DmxUniverseKey::transport`].
    pub transport: &'a str,
    /// One byte per channel, starting at address 1.
    #[typeshare(serialized_as = "Uint8Array<ArrayBufferLike>")]
    pub channels: WireBytes<'a>,
    /// Milliseconds since an input universe last received a frame; `None` for output.
    pub frame_age_ms: Option<u32>,
}

/// Payload of a [`DMX_UNIVERSE_WATCH_MODULE`] update. It replaces the sender's previous watch; an
/// empty list stops the sender's channel values.
#[typeshare::typeshare]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DmxUniverseWatch {
    /// Universes whose channel values the sender receives.
    pub universes: Vec<DmxUniverseKey>,
}

/// What one client watches and what it was last sent.
#[derive(Debug, Default)]
struct Watcher {
    universes: Vec<DmxUniverseKey>,
    /// Watched channel values and frame ages as last published, to skip identical messages.
    last_sent: Option<Vec<u8>>,
}

/// Engine-side state of the DMX universe stream.
#[derive(Resource, Default)]
pub struct DmxUniverseStream {
    /// List last broadcast; `None` publishes it at the next opportunity.
    last_list: Option<Vec<DmxUniverseSummary>>,
    watchers: HashMap<Audience, Watcher>,
    /// Watchers whose watch changed since their last publication, sent without waiting.
    pending: Vec<Audience>,
    last_tick: Option<Instant>,
}

impl DmxUniverseStream {
    /// Replaces the universes `audience` watches, so its next message follows without waiting.
    /// Duplicate keys are dropped and at most [`MAX_WATCHED_UNIVERSES`] are kept, so a client's
    /// request cannot grow the per-frame work without bound.
    pub fn watch(&mut self, audience: Audience, mut universes: Vec<DmxUniverseKey>) {
        let mut seen = HashSet::new();
        universes.retain(|key| seen.insert(key.clone()));
        universes.truncate(MAX_WATCHED_UNIVERSES);
        if universes.is_empty() {
            self.watchers.remove(&audience);
            return;
        }
        let watcher = self.watchers.entry(audience).or_default();
        watcher.universes = universes;
        watcher.last_sent = None;
        self.pending.push(audience);
    }

    /// Forgets everything kept for a client that disconnected.
    pub fn forget(&mut self, audience: Audience) {
        self.watchers.remove(&audience);
    }

    /// Republishes the universe list at the next opportunity, for a client that resyncs.
    pub fn request_list(&mut self) {
        self.last_list = None;
    }

    /// Returns whether a publication is due at `now`: the interval elapsed, a watch changed, or
    /// the list must be republished. Records `now` as the last tick when the interval elapsed.
    fn due(&mut self, now: Instant) -> Due {
        let interval_elapsed = self
            .last_tick
            .is_none_or(|last| now.saturating_duration_since(last) >= STREAM_INTERVAL);
        if interval_elapsed {
            self.last_tick = Some(now);
        }
        Due {
            interval_elapsed,
            any: interval_elapsed || !self.pending.is_empty() || self.last_list.is_none(),
        }
    }
}

/// Outcome of [`DmxUniverseStream::due`].
struct Due {
    /// Whether the regular interval elapsed, so every watcher is checked for changes.
    interval_elapsed: bool,
    /// Whether anything must be checked at all this frame.
    any: bool,
}

/// One universe as the stream sees it in the current frame, borrowing its channel values.
pub(crate) struct UniverseSource<'a> {
    pub(crate) key: DmxUniverseKey,
    pub(crate) output_transport: Option<OutputTransport>,
    pub(crate) channels: &'a [ChannelDmxValue; MAX_CHANNELS_PER_UNIVERSE],
    pub(crate) frame_age_ms: Option<u32>,
    pub(crate) is_stale: Option<bool>,
    pub(crate) is_self: Option<bool>,
}

impl UniverseSource<'_> {
    /// Returns the list entry for this universe.
    fn summary(&self) -> DmxUniverseSummary {
        DmxUniverseSummary {
            universe_id: self.key.universe_id,
            io_mode: self.key.io_mode,
            transport: self.key.transport.clone(),
            output_transport: self.output_transport.clone(),
            is_stale: self.is_stale,
            is_self: self.is_self,
        }
    }
}

/// Returns the operator-facing label of a binding (input) transport.
pub(crate) fn binding_transport_label(transport: BindingTransport) -> &'static str {
    match transport {
        BindingTransport::Sacn => "sACN",
        BindingTransport::ArtNet => "Art-Net",
        BindingTransport::Udmx => "USB",
    }
}

/// Returns the sort rank of an input transport, so inputs list in a stable family order.
fn input_transport_rank(transport: BindingTransport) -> u8 {
    match transport {
        BindingTransport::Sacn => 0,
        BindingTransport::ArtNet => 1,
        BindingTransport::Udmx => 2,
    }
}

/// Lists every universe the DMX panel can show this frame.
///
/// Console-space universes come first under the `Console` label with console numbering, sorted by
/// number. Every composed wire frame follows as-is under its concrete transport label (for
/// example `sACN` or `sACN → 10.0.0.4`) with wire numbering, so the panel shows exactly the frames
/// the output drivers transmit. Input universes that have received a frame come last, by
/// transport family and number.
pub(crate) fn collect_universes<'a>(
    console: &'a ConsoleDmxUniverses,
    output_frames: &'a OutputDmxFrames,
    inputs: &'a InputDmxUniverses,
    stale_after_ms: u32,
    now: Instant,
) -> Vec<UniverseSource<'a>> {
    let mut console_universes: Vec<_> = console.iter().collect();
    console_universes.sort_unstable_by_key(|(universe_id, _)| *universe_id);
    let console_sources = console_universes
        .into_iter()
        .map(|(universe_id, channels)| UniverseSource {
            key: DmxUniverseKey {
                universe_id,
                io_mode: DmxIoMode::Output,
                transport: CONSOLE_SPACE_LABEL.to_string(),
            },
            output_transport: None,
            channels,
            frame_age_ms: None,
            is_stale: None,
            is_self: None,
        });
    let wire_sources = output_frames.iter().map(|frame| UniverseSource {
        key: DmxUniverseKey {
            universe_id: frame.universe,
            io_mode: DmxIoMode::Output,
            transport: output_transport_label(&frame.transport),
        },
        output_transport: Some(frame.transport.clone()),
        channels: &frame.channels,
        frame_age_ms: None,
        is_stale: None,
        is_self: None,
    });
    let mut input_sources: Vec<_> = inputs
        .iter()
        .filter_map(|(transport, universe_id, channels)| {
            let frame_age_ms = inputs.frame_age_ms(transport, universe_id, now)?;
            Some((
                input_transport_rank(transport),
                UniverseSource {
                    key: DmxUniverseKey {
                        universe_id,
                        io_mode: DmxIoMode::Input,
                        transport: binding_transport_label(transport).to_string(),
                    },
                    output_transport: None,
                    channels,
                    frame_age_ms: Some(frame_age_ms),
                    is_stale: Some(frame_age_ms >= stale_after_ms),
                    is_self: Some(
                        inputs
                            .is_self_frame(transport, universe_id)
                            .unwrap_or(false),
                    ),
                },
            ))
        })
        .collect();
    input_sources.sort_by_key(|(rank, source)| (*rank, source.key.universe_id));

    console_sources
        .chain(wire_sources)
        .chain(input_sources.into_iter().map(|(_, source)| source))
        .collect()
}

/// Publishes the universe list when it changed and each watcher's channel values when they
/// changed.
pub fn send_dmx_universes(
    console: Res<ConsoleDmxUniverses>,
    inputs: Res<InputDmxUniverses>,
    input_stale_timeout: Res<InputUniverseStaleTimeout>,
    output_frames: Res<OutputDmxFrames>,
    mut stream: ResMut<DmxUniverseStream>,
    broadcaster: Res<ClientEventSink>,
) {
    let now = Instant::now();
    let due = stream.due(now);
    if !due.any {
        return;
    }
    let stale_after_ms = input_stale_timeout.0.as_millis() as u32;
    let sources = collect_universes(&console, &output_frames, &inputs, stale_after_ms, now);

    let list: Vec<DmxUniverseSummary> = sources.iter().map(UniverseSource::summary).collect();
    if stream.last_list.as_ref() != Some(&list) {
        broadcaster.publish(
            DISCRIMINATOR_DROPPABLE,
            &FixtureWsMessage::DmxUniverseList(&list),
        );
        stream.last_list = Some(list);
    }

    let pending = std::mem::take(&mut stream.pending);
    if stream.watchers.is_empty() {
        return;
    }
    let by_key: HashMap<&DmxUniverseKey, &UniverseSource> =
        sources.iter().map(|source| (&source.key, source)).collect();
    for (audience, watcher) in &mut stream.watchers {
        if !due.interval_elapsed && !pending.contains(audience) {
            continue;
        }
        let watched: Vec<&UniverseSource> = watcher
            .universes
            .iter()
            .filter_map(|key| by_key.get(key).copied())
            .collect();
        let mut signature = Vec::with_capacity(watched.len() * (MAX_CHANNELS_PER_UNIVERSE + 5));
        for source in &watched {
            signature.extend_from_slice(source.channels);
            signature.extend_from_slice(&source.frame_age_ms.unwrap_or(u32::MAX).to_le_bytes());
        }
        if watcher.last_sent.as_ref() == Some(&signature) {
            continue;
        }
        let channels: Vec<DmxUniverseChannels> = watched
            .iter()
            .map(|source| DmxUniverseChannels {
                universe_id: source.key.universe_id,
                io_mode: source.key.io_mode,
                transport: &source.key.transport,
                channels: WireBytes(source.channels),
                frame_age_ms: source.frame_age_ms,
            })
            .collect();
        broadcaster.publish_to(
            *audience,
            DISCRIMINATOR_DROPPABLE,
            &FixtureWsMessage::DmxUniverseChannels(&channels),
        );
        watcher.last_sent = Some(signature);
    }
}

/// Applies a client's [`DMX_UNIVERSE_WATCH_MODULE`] update, replacing what it watches.
pub fn deserialize_dmx_universe_watch(
    world: &mut World,
    json: Value,
    sender: Audience,
) -> Result<(), String> {
    let watch: DmxUniverseWatch = serde_json::from_value(json)
        .map_err(|error| format!("Failed to parse DmxUniverseWatch: {error}"))?;
    world
        .resource_mut::<DmxUniverseStream>()
        .watch(sender, watch.universes);
    Ok(())
}

/// Drops the watches of clients that disconnected.
pub fn forget_disconnected_watchers(
    mut disconnected: MessageReader<ClientDisconnected>,
    mut stream: ResMut<DmxUniverseStream>,
) {
    for message in disconnected.read() {
        stream.forget(Audience::Client(message.client));
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};

    use super::*;

    /// Builds an app that runs the stream against controllable universe resources and captures
    /// every published frame.
    fn stream_app() -> (App, async_channel::Receiver<OutboundFrame>) {
        let mut app = App::new();
        let (tx, rx) = async_channel::unbounded();
        app.insert_resource(ClientEventSink::new(tx));
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<InputUniverseStaleTimeout>();
        app.init_resource::<OutputDmxFrames>();
        app.init_resource::<DmxUniverseStream>();
        app.add_message::<ClientDisconnected>();
        app.add_systems(
            Update,
            (forget_disconnected_watchers, send_dmx_universes).chain(),
        );
        (app, rx)
    }

    /// Sets one console channel, creating its universe when needed.
    fn set_console(app: &mut App, universe: u16, address: u16, value: u8) {
        app.world_mut()
            .resource_mut::<ConsoleDmxUniverses>()
            .set_value(
                universe,
                address,
                value,
                crate::universe::ConsoleChannelOrigin::ManualCommand,
            );
    }

    /// Returns the console-space key of one universe.
    fn console_key(universe_id: u16) -> DmxUniverseKey {
        DmxUniverseKey {
            universe_id,
            io_mode: DmxIoMode::Output,
            transport: CONSOLE_SPACE_LABEL.to_string(),
        }
    }

    /// Channel bytes decoded from one CBOR byte string.
    #[derive(Debug, PartialEq)]
    struct Bytes(Vec<u8>);

    impl<'de> Deserialize<'de> for Bytes {
        /// Accepts a CBOR byte string, the encoding [`WireBytes`] produces.
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            /// Collects a borrowed or owned byte string.
            struct BytesVisitor;
            impl serde::de::Visitor<'_> for BytesVisitor {
                type Value = Bytes;
                /// Names the expected input in decode errors.
                fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                    formatter.write_str("a byte string")
                }
                /// Copies the byte string.
                fn visit_bytes<E>(self, bytes: &[u8]) -> Result<Bytes, E> {
                    Ok(Bytes(bytes.to_vec()))
                }
            }
            deserializer.deserialize_bytes(BytesVisitor)
        }
    }

    /// One `DmxUniverseList` entry as a client decodes it.
    #[derive(Debug, Deserialize)]
    struct ListEntry {
        universe_id: u16,
        transport: String,
    }

    /// One `DmxUniverseChannels` entry as a client decodes it.
    #[derive(Debug, Deserialize)]
    struct ChannelsEntry {
        universe_id: u16,
        transport: String,
        channels: Bytes,
    }

    /// A published stream message as a client decodes it.
    #[derive(Debug, Deserialize)]
    #[serde(tag = "type", content = "data")]
    enum Decoded {
        DmxUniverseList(Vec<ListEntry>),
        DmxUniverseChannels(Vec<ChannelsEntry>),
    }

    /// Decodes every published frame with the audience it was addressed to.
    fn drain(rx: &async_channel::Receiver<OutboundFrame>) -> Vec<(Audience, Decoded)> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .map(|frame| {
                assert_eq!(frame.bytes[0], DISCRIMINATOR_DROPPABLE);
                let decoded = minicbor_serde::from_slice(&frame.bytes[1..]).expect("frame decodes");
                (frame.audience, decoded)
            })
            .collect()
    }

    /// Forces the regular interval to have elapsed before the next update.
    fn expire_interval(app: &mut App) {
        app.world_mut()
            .resource_mut::<DmxUniverseStream>()
            .last_tick = None;
    }

    /// The list goes out once, without channel values, and not again while nothing changes;
    /// without a watcher no channel values are published at all.
    #[test]
    fn list_is_published_only_when_it_changes() {
        let (mut app, rx) = stream_app();
        set_console(&mut app, 1, 1, 255);
        set_console(&mut app, 2, 1, 10);

        app.update();
        let published = drain(&rx);
        assert_eq!(published.len(), 1);
        let (Audience::All, Decoded::DmxUniverseList(list)) = &published[0] else {
            panic!("expected a broadcast list, got {published:?}");
        };
        let ids: Vec<_> = list
            .iter()
            .map(|entry| (entry.transport.as_str(), entry.universe_id))
            .collect();
        assert_eq!(ids, vec![("Console", 1), ("Console", 2)]);

        set_console(&mut app, 1, 1, 0);
        expire_interval(&mut app);
        app.update();
        assert!(
            drain(&rx).is_empty(),
            "unchanged list or values were resent"
        );

        set_console(&mut app, 3, 1, 10);
        expire_interval(&mut app);
        app.update();
        let published = drain(&rx);
        assert!(
            matches!(
                published.as_slice(),
                [(Audience::All, Decoded::DmxUniverseList(_))]
            ),
            "expected only the list, got {published:?}"
        );
    }

    /// A resync republishes the unchanged list for the client that asked.
    #[test]
    fn resync_republishes_the_list() {
        let (mut app, rx) = stream_app();
        set_console(&mut app, 1, 1, 255);
        app.update();
        drain(&rx);

        app.world_mut()
            .resource_mut::<DmxUniverseStream>()
            .request_list();
        app.update();
        let published = drain(&rx);
        assert!(
            matches!(
                published.as_slice(),
                [(Audience::All, Decoded::DmxUniverseList(_))]
            ),
            "expected only the list, got {published:?}"
        );
    }

    /// A watcher gets only its universe's values: at once when it starts watching, then only
    /// when the values change, never to other clients.
    #[test]
    fn watcher_receives_only_its_universe_when_it_changes() {
        let (mut app, rx) = stream_app();
        set_console(&mut app, 1, 1, 255);
        set_console(&mut app, 2, 3, 42);
        app.update();
        drain(&rx);

        let watcher = Audience::Client(ClientId(4));
        app.world_mut()
            .resource_mut::<DmxUniverseStream>()
            .watch(watcher, vec![console_key(2)]);
        app.update();
        let published = drain(&rx);
        assert_eq!(published.len(), 1);
        let (audience, Decoded::DmxUniverseChannels(universes)) = &published[0] else {
            panic!("expected channel values, got {published:?}");
        };
        assert_eq!(*audience, watcher);
        assert_eq!(universes.len(), 1);
        assert_eq!(universes[0].universe_id, 2);
        assert_eq!(universes[0].transport, "Console");
        assert_eq!(universes[0].channels.0.len(), MAX_CHANNELS_PER_UNIVERSE);
        assert_eq!(universes[0].channels.0[2], 42);

        expire_interval(&mut app);
        app.update();
        assert!(drain(&rx).is_empty(), "unchanged values were resent");

        set_console(&mut app, 1, 1, 0);
        expire_interval(&mut app);
        app.update();
        assert!(
            drain(&rx).is_empty(),
            "an unwatched universe triggered a send"
        );

        set_console(&mut app, 2, 3, 43);
        expire_interval(&mut app);
        app.update();
        let published = drain(&rx);
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].0, watcher);
    }

    /// Changed values wait for the interval, while a changed watch is answered at once.
    #[test]
    fn value_changes_wait_for_the_interval() {
        let (mut app, rx) = stream_app();
        set_console(&mut app, 1, 1, 255);
        let watcher = Audience::Client(ClientId(1));
        app.world_mut()
            .resource_mut::<DmxUniverseStream>()
            .watch(watcher, vec![console_key(1)]);
        app.update();
        drain(&rx);

        set_console(&mut app, 1, 1, 1);
        app.update();
        assert!(
            drain(&rx).is_empty(),
            "values were sent before the interval"
        );

        expire_interval(&mut app);
        app.update();
        assert_eq!(drain(&rx).len(), 1);
    }

    /// Disconnecting or sending an empty watch stops a client's channel values.
    #[test]
    fn disconnect_and_empty_watch_stop_values() {
        let (mut app, rx) = stream_app();
        set_console(&mut app, 1, 1, 255);
        let first = Audience::Client(ClientId(1));
        let second = Audience::Client(ClientId(2));
        {
            let mut stream = app.world_mut().resource_mut::<DmxUniverseStream>();
            stream.watch(first, vec![console_key(1)]);
            stream.watch(second, vec![console_key(1)]);
        }
        app.update();
        drain(&rx);

        app.world_mut().write_message(ClientDisconnected {
            client: ClientId(1),
        });
        app.world_mut()
            .resource_mut::<DmxUniverseStream>()
            .watch(second, Vec::new());
        set_console(&mut app, 1, 1, 7);
        expire_interval(&mut app);
        app.update();
        assert!(drain(&rx).is_empty());
        assert!(
            app.world()
                .resource::<DmxUniverseStream>()
                .watchers
                .is_empty()
        );
    }

    /// A watch keeps each universe once and no more than the limit.
    #[test]
    fn watch_drops_duplicates_and_caps_its_size() {
        let mut stream = DmxUniverseStream::default();
        let watcher = Audience::Client(ClientId(1));
        let mut keys: Vec<_> = (1..=MAX_WATCHED_UNIVERSES as u16 + 10)
            .map(console_key)
            .collect();
        keys.insert(1, console_key(1));

        stream.watch(watcher, keys);

        let watched = &stream.watchers[&watcher].universes;
        assert_eq!(watched.len(), MAX_WATCHED_UNIVERSES);
        assert_eq!(watched[0], console_key(1));
        assert_eq!(watched[1], console_key(2));
    }

    /// The watch update reaches the stream under the sender's identity.
    #[test]
    fn watch_update_is_keyed_by_sender() {
        let mut world = World::new();
        world.init_resource::<DmxUniverseStream>();
        let sender = Audience::Client(ClientId(3));

        deserialize_dmx_universe_watch(
            &mut world,
            serde_json::json!({
                "universes": [{ "universe_id": 5, "io_mode": "output", "transport": "Console" }]
            }),
            sender,
        )
        .expect("watch parses");

        let stream = world.resource::<DmxUniverseStream>();
        assert_eq!(stream.watchers[&sender].universes, vec![console_key(5)]);
        assert_eq!(stream.pending, vec![sender]);
    }
}
