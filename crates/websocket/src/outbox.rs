// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bounded outbound queue for one websocket client.
//!
//! A client that reads slower than the engine publishes falls behind. Between two ordered messages,
//! a newer droppable snapshot replaces everything of its type still queued: it takes the position
//! of the oldest such entry and the rest are discarded. A snapshot is never replaced across an
//! ordered message, so every snapshot keeps its order relative to ordered messages, exactly as
//! published. A delta builds on everything of its type before it, so it is always appended and
//! never replaces anything; the next snapshot of its type collapses it along with the rest.
//! Ordered messages are never dropped. When the queued bytes would exceed the limit, the queue is
//! discarded and the client is closed with [`LAGGING_CLIENT_CLOSE_CODE`], so it reconnects and
//! resyncs from complete state instead of applying a partial stream.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{CloseFrame, Message};
use nightfall_engine::prelude::{DISCRIMINATOR_DELTA, DISCRIMINATOR_DROPPABLE};
use tokio::sync::Notify;

/// Queued bytes beyond which a client is considered unable to keep up and is disconnected.
///
/// Well above a full resync of a large show, so only a client that has stopped reading for a
/// sustained period reaches it.
pub(crate) const OUTBOX_BYTE_LIMIT: usize = 64 * 1024 * 1024;

/// Close code sent to a client whose queue exceeded [`OUTBOX_BYTE_LIMIT`].
///
/// Clients reconnect immediately on this code and resync. Codes 4000-4999 are reserved for
/// application use by RFC 6455.
pub(crate) const LAGGING_CLIENT_CLOSE_CODE: u16 = 4001;

/// One encoded publication, classified once for every client that receives it.
#[derive(Clone)]
pub(crate) struct Publication {
    message: Message,
    /// Message type of a snapshot or delta, shared with the snapshots it may replace or yield to.
    snapshot_type: Option<Arc<str>>,
    /// Whether this is a delta, which is always appended rather than replacing a queued snapshot.
    delta: bool,
    bytes: usize,
}

impl Publication {
    /// Wraps one encoded publication, reading the message type of droppable snapshots and deltas
    /// so they can be coalesced in a lagging client's queue.
    pub(crate) fn from_encoded(encoded: Vec<u8>) -> Self {
        let (snapshot_type, delta) = match encoded.split_first() {
            Some((&DISCRIMINATOR_DROPPABLE, cbor)) => (peek_message_type(cbor), false),
            Some((&DISCRIMINATOR_DELTA, cbor)) => (peek_message_type(cbor), true),
            _ => (None, false),
        };
        let snapshot_type = snapshot_type.map(Arc::from);
        Self::new(Message::Binary(encoded.into()), snapshot_type, delta)
    }

    /// Wraps a message that must be delivered in order and never replaced.
    pub(crate) fn ordered(message: Message) -> Self {
        Self::new(message, None, false)
    }

    /// Builds a publication, measuring the payload bytes it holds in a queue. A delta whose type
    /// cannot be read is treated as ordered, so no snapshot can ever replace it.
    fn new(message: Message, snapshot_type: Option<Arc<str>>, delta: bool) -> Self {
        let bytes = match &message {
            Message::Binary(bytes) => bytes.len(),
            Message::Text(text) => text.len(),
            _ => 0,
        };
        Self {
            delta: delta && snapshot_type.is_some(),
            message,
            snapshot_type,
            bytes,
        }
    }
}

/// Reads the `type` field that leads every tagged client message map, without decoding the
/// payload behind it.
fn peek_message_type(cbor: &[u8]) -> Option<&str> {
    let mut decoder = minicbor::Decoder::new(cbor);
    if decoder.map().ok()? == Some(0) {
        return None;
    }
    if decoder.str().ok()? != "type" {
        return None;
    }
    decoder.str().ok()
}

/// What happened to a publication offered to a client's outbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Enqueued {
    /// Appended to the end of the queue.
    Queued,
    /// Replaced the pending entries of the same type, taking the position of the oldest one.
    Coalesced,
    /// The queue exceeded its limit; it was discarded and a lagging close frame queued instead.
    Overflowed,
    /// The outbox no longer accepts messages.
    Closed,
}

impl Enqueued {
    /// Whether the client should stay registered for future broadcasts.
    pub(crate) fn keeps_client(self) -> bool {
        matches!(self, Self::Queued | Self::Coalesced)
    }
}

/// Why [`ClientOutbox::try_next`] returned no message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TryNextError {
    /// Nothing is queued yet.
    Empty,
    /// The outbox is closed and fully drained.
    Closed,
}

/// Bounded outbound queue for one connected client, drained by that client's send task.
pub(crate) struct ClientOutbox {
    state: Mutex<OutboxState>,
    ready: Notify,
    byte_limit: usize,
}

/// Queue contents guarded by the outbox lock.
#[derive(Default)]
struct OutboxState {
    /// Queued publications; `None` marks an entry a newer snapshot discarded, skipped when sent.
    entries: VecDeque<Option<Publication>>,
    /// Sequence number of `entries[0]`; entries are numbered consecutively from it.
    head_seq: u64,
    /// Sequence number of the oldest queued snapshot or delta of each type that a newer snapshot
    /// may still replace.
    pending_snapshots: HashMap<Arc<str>, u64>,
    /// Sequence number of the most recently queued ordered message, if any was ever queued.
    last_ordered_seq: Option<u64>,
    queued_bytes: usize,
    coalesced: u64,
    closed: bool,
}

impl OutboxState {
    /// Discards every queued message and leaves only `close`, rejecting later publications.
    fn close_with(&mut self, close: Message) {
        self.entries.clear();
        self.pending_snapshots.clear();
        self.queued_bytes = 0;
        self.entries.push_back(Some(Publication::ordered(close)));
        self.closed = true;
    }

    /// Returns the queued bytes of the entry at `seq` and every later entry of `snapshot_type`,
    /// which a snapshot replacing the pending entry at `seq` discards.
    fn superseded_bytes(&self, snapshot_type: &str, seq: u64) -> usize {
        self.entries
            .range((seq - self.head_seq) as usize..)
            .flatten()
            .filter(|entry| entry.snapshot_type.as_deref() == Some(snapshot_type))
            .map(|entry| entry.bytes)
            .sum()
    }
}

impl ClientOutbox {
    /// Creates an empty outbox that disconnects its client beyond `byte_limit` queued bytes.
    pub(crate) fn new(byte_limit: usize) -> Self {
        Self {
            state: Mutex::default(),
            ready: Notify::new(),
            byte_limit,
        }
    }

    /// Offers one publication to this client.
    ///
    /// A droppable snapshot replaces the queued snapshots and deltas of the same type when no
    /// ordered message was queued after the oldest of them: it takes that entry's position and the
    /// later ones are discarded. Anything else, deltas included, is appended. If the queue would
    /// exceed its byte limit, it is discarded and replaced by a lagging close frame.
    pub(crate) fn publish(&self, publication: &Publication) -> Enqueued {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Enqueued::Closed;
        }

        // Pending entries are replaced only while no ordered message follows them, so neither the
        // older entries nor the newer snapshot change position relative to an ordered message.
        let pending = publication
            .snapshot_type
            .as_ref()
            .and_then(|snapshot_type| state.pending_snapshots.get(snapshot_type).copied())
            .filter(|&seq| state.last_ordered_seq.is_none_or(|ordered| seq > ordered));
        let replaced = pending.filter(|_| !publication.delta);
        let replaced_bytes = match (replaced, &publication.snapshot_type) {
            (Some(seq), Some(snapshot_type)) => state.superseded_bytes(snapshot_type, seq),
            _ => 0,
        };

        if state.queued_bytes - replaced_bytes + publication.bytes > self.byte_limit {
            tracing::warn!(
                queued_bytes = state.queued_bytes,
                coalesced = state.coalesced,
                "Disconnecting websocket client that fell behind"
            );
            state.close_with(Message::Close(Some(CloseFrame {
                code: LAGGING_CLIENT_CLOSE_CODE,
                reason: "client fell behind".into(),
            })));
            drop(state);
            self.ready.notify_one();
            return Enqueued::Overflowed;
        }

        state.queued_bytes = state.queued_bytes - replaced_bytes + publication.bytes;
        let outcome = if let Some(seq) = replaced {
            let start = (seq - state.head_seq) as usize;
            let mut superseded = 0;
            for entry in state.entries.range_mut(start..) {
                if entry
                    .as_ref()
                    .is_some_and(|queued| queued.snapshot_type == publication.snapshot_type)
                {
                    *entry = None;
                    superseded += 1;
                }
            }
            state.entries[start] = Some(publication.clone());
            state.coalesced += superseded;
            Enqueued::Coalesced
        } else {
            let seq = state.head_seq + state.entries.len() as u64;
            match &publication.snapshot_type {
                Some(_) if pending.is_some() => {}
                Some(snapshot_type) => {
                    state.pending_snapshots.insert(snapshot_type.clone(), seq);
                }
                None => state.last_ordered_seq = Some(seq),
            }
            state.entries.push_back(Some(publication.clone()));
            Enqueued::Queued
        };
        drop(state);
        self.ready.notify_one();
        outcome
    }

    /// Queues one ordered message for this client, such as a heartbeat response.
    pub(crate) fn push(&self, message: Message) -> Enqueued {
        self.publish(&Publication::ordered(message))
    }

    /// Queues a close frame behind the pending messages and stops accepting new ones.
    pub(crate) fn close(&self) {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return;
        }
        state
            .entries
            .push_back(Some(Publication::ordered(Message::Close(None))));
        state.closed = true;
        drop(state);
        self.ready.notify_one();
    }

    /// Waits for the next message to send, returning `None` once the outbox is closed and drained.
    pub(crate) async fn next(&self) -> Option<Message> {
        loop {
            match self.try_next() {
                Ok(message) => return Some(message),
                Err(TryNextError::Closed) => return None,
                Err(TryNextError::Empty) => self.ready.notified().await,
            }
        }
    }

    /// Takes the next queued message without waiting, or reports why there is none.
    pub(crate) fn try_next(&self) -> Result<Message, TryNextError> {
        let mut state = self.state.lock().unwrap();
        loop {
            let Some(entry) = state.entries.pop_front() else {
                return Err(if state.closed {
                    TryNextError::Closed
                } else {
                    TryNextError::Empty
                });
            };
            let seq = state.head_seq;
            state.head_seq += 1;
            let Some(entry) = entry else {
                continue;
            };
            state.queued_bytes -= entry.bytes;
            if let Some(snapshot_type) = &entry.snapshot_type
                && state.pending_snapshots.get(snapshot_type) == Some(&seq)
            {
                // The next queued entry of the type, if any, is the oldest one left to replace.
                let next = state
                    .entries
                    .iter()
                    .position(|queued| {
                        queued.as_ref().is_some_and(|queued| {
                            queued.snapshot_type.as_ref() == Some(snapshot_type)
                        })
                    })
                    .map(|index| state.head_seq + index as u64);
                match next {
                    Some(next) => state.pending_snapshots.insert(snapshot_type.clone(), next),
                    None => state.pending_snapshots.remove(snapshot_type),
                };
            }
            return Ok(entry.message);
        }
    }

    /// Number of queued snapshots and deltas a newer snapshot replaced before this client
    /// received them.
    pub(crate) fn coalesced_count(&self) -> u64 {
        self.state.lock().unwrap().coalesced
    }
}

#[cfg(test)]
mod tests {
    use nightfall_engine::prelude::{DISCRIMINATOR_NON_DROPPABLE, EncodedClientMessage};
    use serde::Serialize;

    use super::*;

    /// Tagged client message shape shared by every engine publication.
    #[derive(Serialize)]
    #[serde(tag = "type", content = "data")]
    enum TestMessage {
        Snapshot(u32),
        Other(u32),
        Result(u32),
    }

    /// Encodes a test message the way the engine's client sink publishes it.
    fn encoded(discriminator: u8, message: &TestMessage) -> Publication {
        let bytes = EncodedClientMessage::new(discriminator, message)
            .expect("test message encodes")
            .to_bytes();
        Publication::from_encoded(bytes)
    }

    /// Decodes the payload of a queued message back to its type and data for assertions.
    fn decoded(message: Message) -> (String, u32) {
        let Message::Binary(bytes) = message else {
            panic!("expected a binary message, got {message:?}");
        };
        let value: serde_json::Value = minicbor_serde::from_slice(&bytes[1..]).unwrap();
        (
            value["type"].as_str().unwrap().to_owned(),
            value["data"].as_u64().unwrap() as u32,
        )
    }

    /// Drains every message currently queued without waiting for more.
    fn drain(outbox: &ClientOutbox) -> Vec<Message> {
        std::iter::from_fn(|| outbox.try_next().ok()).collect()
    }

    /// Verifies the message type is read only from droppable publications and deltas.
    #[test]
    fn classifies_only_droppable_snapshots() {
        let snapshot = encoded(DISCRIMINATOR_DROPPABLE, &TestMessage::Snapshot(1));
        let ordered = encoded(DISCRIMINATOR_NON_DROPPABLE, &TestMessage::Snapshot(1));
        let delta = encoded(DISCRIMINATOR_DELTA, &TestMessage::Snapshot(1));
        assert_eq!(snapshot.snapshot_type.as_deref(), Some("Snapshot"));
        assert!(!snapshot.delta);
        assert_eq!(ordered.snapshot_type, None);
        assert_eq!(delta.snapshot_type.as_deref(), Some("Snapshot"));
        assert!(delta.delta);
    }

    /// Verifies newer snapshots replace queued ones of the same type in place, but never across
    /// an ordered message, so each snapshot keeps its published order relative to ordered
    /// messages in both directions.
    #[tokio::test]
    async fn snapshots_coalesce_in_place_between_ordered_messages() {
        let outbox = ClientOutbox::new(OUTBOX_BYTE_LIMIT);
        let publications = [
            encoded(DISCRIMINATOR_DROPPABLE, &TestMessage::Snapshot(1)),
            encoded(DISCRIMINATOR_DROPPABLE, &TestMessage::Other(1)),
            encoded(DISCRIMINATOR_DROPPABLE, &TestMessage::Snapshot(2)),
            encoded(DISCRIMINATOR_NON_DROPPABLE, &TestMessage::Result(1)),
            encoded(DISCRIMINATOR_DROPPABLE, &TestMessage::Other(2)),
            encoded(DISCRIMINATOR_DROPPABLE, &TestMessage::Snapshot(3)),
            encoded(DISCRIMINATOR_DROPPABLE, &TestMessage::Snapshot(4)),
            encoded(DISCRIMINATOR_DROPPABLE, &TestMessage::Other(3)),
        ];
        let outcomes: Vec<_> = publications.iter().map(|p| outbox.publish(p)).collect();
        assert_eq!(
            outcomes,
            [
                Enqueued::Queued,
                Enqueued::Queued,
                Enqueued::Coalesced,
                Enqueued::Queued,
                Enqueued::Queued,
                Enqueued::Queued,
                Enqueued::Coalesced,
                Enqueued::Coalesced,
            ]
        );

        let received: Vec<_> = drain(&outbox).into_iter().map(decoded).collect();
        assert_eq!(
            received,
            [
                ("Snapshot".to_owned(), 2),
                ("Other".to_owned(), 1),
                ("Result".to_owned(), 1),
                ("Other".to_owned(), 3),
                ("Snapshot".to_owned(), 4),
            ]
        );
        assert_eq!(outbox.coalesced_count(), 3);
    }

    /// Verifies deltas are always queued in order, and a full snapshot replaces every queued
    /// snapshot and delta of its type at the position of the oldest, but never across an ordered
    /// message, while entries of other types keep their place.
    #[tokio::test]
    async fn snapshots_collapse_queued_deltas() {
        let outbox = ClientOutbox::new(OUTBOX_BYTE_LIMIT);
        let publications = [
            encoded(DISCRIMINATOR_DELTA, &TestMessage::Snapshot(1)),
            encoded(DISCRIMINATOR_DROPPABLE, &TestMessage::Other(1)),
            encoded(DISCRIMINATOR_DELTA, &TestMessage::Snapshot(2)),
            encoded(DISCRIMINATOR_DROPPABLE, &TestMessage::Snapshot(3)),
            encoded(DISCRIMINATOR_DELTA, &TestMessage::Snapshot(4)),
            encoded(DISCRIMINATOR_NON_DROPPABLE, &TestMessage::Result(1)),
            encoded(DISCRIMINATOR_DELTA, &TestMessage::Snapshot(5)),
            encoded(DISCRIMINATOR_DELTA, &TestMessage::Snapshot(6)),
        ];
        let outcomes: Vec<_> = publications.iter().map(|p| outbox.publish(p)).collect();
        assert_eq!(
            outcomes,
            [
                Enqueued::Queued,
                Enqueued::Queued,
                Enqueued::Queued,
                Enqueued::Coalesced,
                Enqueued::Queued,
                Enqueued::Queued,
                Enqueued::Queued,
                Enqueued::Queued,
            ]
        );
        assert_eq!(outbox.coalesced_count(), 2);
        let received: Vec<_> = drain(&outbox).into_iter().map(decoded).collect();
        assert_eq!(
            received,
            [
                ("Snapshot".to_owned(), 3),
                ("Other".to_owned(), 1),
                ("Snapshot".to_owned(), 4),
                ("Result".to_owned(), 1),
                ("Snapshot".to_owned(), 5),
                ("Snapshot".to_owned(), 6),
            ]
        );
        let state = outbox.state.lock().unwrap();
        assert_eq!(state.queued_bytes, 0);
        assert!(state.pending_snapshots.is_empty());
    }

    /// Verifies that once the oldest pending entry of a type is sent, a snapshot still collapses
    /// the deltas of that type queued behind it instead of being appended after them.
    #[tokio::test]
    async fn sending_the_oldest_delta_keeps_the_rest_replaceable() {
        let outbox = ClientOutbox::new(OUTBOX_BYTE_LIMIT);
        for value in 1..=3 {
            outbox.publish(&encoded(DISCRIMINATOR_DELTA, &TestMessage::Snapshot(value)));
        }
        assert_eq!(
            decoded(outbox.next().await.unwrap()),
            ("Snapshot".into(), 1)
        );

        let outcome = outbox.publish(&encoded(DISCRIMINATOR_DROPPABLE, &TestMessage::Snapshot(4)));
        assert_eq!(outcome, Enqueued::Coalesced);
        let received: Vec<_> = drain(&outbox).into_iter().map(decoded).collect();
        assert_eq!(received, [("Snapshot".to_owned(), 4)]);
        assert_eq!(outbox.state.lock().unwrap().queued_bytes, 0);
    }

    /// Verifies a snapshot published after the pending one was sent is queued again rather than
    /// replacing a message that already left.
    #[tokio::test]
    async fn sent_snapshots_are_not_replaced() {
        let outbox = ClientOutbox::new(OUTBOX_BYTE_LIMIT);
        outbox.publish(&encoded(DISCRIMINATOR_DROPPABLE, &TestMessage::Snapshot(1)));
        outbox.publish(&encoded(
            DISCRIMINATOR_NON_DROPPABLE,
            &TestMessage::Result(1),
        ));
        assert_eq!(
            decoded(outbox.next().await.unwrap()),
            ("Snapshot".into(), 1)
        );

        let outcome = outbox.publish(&encoded(DISCRIMINATOR_DROPPABLE, &TestMessage::Snapshot(2)));
        assert_eq!(outcome, Enqueued::Queued);
        let received: Vec<_> = drain(&outbox).into_iter().map(decoded).collect();
        assert_eq!(
            received,
            [("Result".to_owned(), 1), ("Snapshot".to_owned(), 2)]
        );
    }

    /// Verifies ordered messages are never coalesced, and that exceeding the byte limit discards
    /// the queue in favor of a single lagging close frame.
    #[tokio::test]
    async fn ordered_overflow_closes_the_client() {
        let one = encoded(DISCRIMINATOR_NON_DROPPABLE, &TestMessage::Result(1));
        let outbox = ClientOutbox::new(one.bytes * 3);
        for _ in 0..3 {
            assert_eq!(outbox.publish(&one), Enqueued::Queued);
        }
        assert_eq!(outbox.publish(&one), Enqueued::Overflowed);
        assert_eq!(outbox.publish(&one), Enqueued::Closed);

        let Some(Message::Close(Some(frame))) = outbox.next().await else {
            panic!("expected the lagging close frame first");
        };
        assert_eq!(frame.code, LAGGING_CLIENT_CLOSE_CODE);
        assert!(outbox.next().await.is_none());
    }

    /// Verifies a client that never reads stays bounded while only snapshots are published.
    #[tokio::test]
    async fn unread_snapshots_stay_bounded() {
        let outbox = ClientOutbox::new(OUTBOX_BYTE_LIMIT);
        for value in 0..10_000 {
            let outcome = outbox.publish(&encoded(
                DISCRIMINATOR_DROPPABLE,
                &TestMessage::Snapshot(value),
            ));
            assert!(outcome.keeps_client());
        }
        let state = outbox.state.lock().unwrap();
        assert_eq!(state.entries.len(), 1);
        assert_eq!(state.queued_bytes, state.entries[0].as_ref().unwrap().bytes);
    }

    /// Verifies a regular close lets pending messages drain before the close frame.
    #[tokio::test]
    async fn close_drains_pending_messages_first() {
        let outbox = ClientOutbox::new(OUTBOX_BYTE_LIMIT);
        outbox.publish(&encoded(
            DISCRIMINATOR_NON_DROPPABLE,
            &TestMessage::Result(1),
        ));
        outbox.close();
        assert_eq!(outbox.push(Message::Close(None)), Enqueued::Closed);

        assert_eq!(decoded(outbox.next().await.unwrap()), ("Result".into(), 1));
        assert!(matches!(outbox.next().await, Some(Message::Close(None))));
        assert!(outbox.next().await.is_none());
    }

    /// Verifies a waiting send task wakes when a message is published.
    #[tokio::test]
    async fn next_wakes_on_publish() {
        let outbox = Arc::new(ClientOutbox::new(OUTBOX_BYTE_LIMIT));
        let waiter = tokio::spawn({
            let outbox = outbox.clone();
            async move { outbox.next().await }
        });
        tokio::task::yield_now().await;
        outbox.publish(&encoded(
            DISCRIMINATOR_NON_DROPPABLE,
            &TestMessage::Result(7),
        ));
        let message = waiter.await.unwrap().expect("message delivered");
        assert_eq!(decoded(message), ("Result".into(), 7));
    }
}
