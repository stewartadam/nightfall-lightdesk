// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bounded outbound queue for one websocket client.
//!
//! A client that reads slower than the engine publishes falls behind. Between two ordered messages,
//! its queue keeps at most one copy of each droppable snapshot type: a newer snapshot replaces the
//! queued one in place. A snapshot is never replaced across an ordered message, so every snapshot
//! keeps its order relative to ordered messages, exactly as published. Ordered messages are never
//! dropped. When the queued bytes would exceed the limit, the queue
//! is discarded and the client is closed with [`LAGGING_CLIENT_CLOSE_CODE`], so it reconnects and
//! resyncs from complete state instead of applying a partial stream.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{CloseFrame, Message};
use nightfall_engine::prelude::DISCRIMINATOR_DROPPABLE;
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
    snapshot_type: Option<Arc<str>>,
    bytes: usize,
}

impl Publication {
    /// Wraps one encoded publication, reading the message type of droppable snapshots so later
    /// snapshots of the same type can replace it in a lagging client's queue.
    pub(crate) fn from_encoded(encoded: Vec<u8>) -> Self {
        let snapshot_type = match encoded.split_first() {
            Some((&DISCRIMINATOR_DROPPABLE, cbor)) => peek_message_type(cbor).map(Arc::from),
            _ => None,
        };
        Self::ordered_or_snapshot(Message::Binary(encoded.into()), snapshot_type)
    }

    /// Wraps a message that must be delivered in order and never replaced.
    pub(crate) fn ordered(message: Message) -> Self {
        Self::ordered_or_snapshot(message, None)
    }

    /// Builds a publication, measuring the payload bytes it holds in a queue.
    fn ordered_or_snapshot(message: Message, snapshot_type: Option<Arc<str>>) -> Self {
        let bytes = match &message {
            Message::Binary(bytes) => bytes.len(),
            Message::Text(text) => text.len(),
            _ => 0,
        };
        Self {
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
    /// Replaced a pending snapshot of the same type in place.
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
    entries: VecDeque<Publication>,
    /// Sequence number of `entries[0]`; entries are numbered consecutively from it.
    head_seq: u64,
    /// Sequence number of the newest queued entry of each droppable snapshot type.
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
        self.entries.push_back(Publication::ordered(close));
        self.closed = true;
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
    /// A droppable snapshot replaces a queued snapshot of the same type at its queue position when
    /// no ordered message was queued after it. Anything else is appended. If the queue would exceed its byte limit, it is discarded and
    /// replaced by a lagging close frame.
    pub(crate) fn publish(&self, publication: &Publication) -> Enqueued {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Enqueued::Closed;
        }

        // A pending snapshot is replaced only while no ordered message follows it, so neither the
        // older nor the newer snapshot changes position relative to an ordered message.
        let pending = publication
            .snapshot_type
            .as_ref()
            .and_then(|snapshot_type| state.pending_snapshots.get(snapshot_type).copied())
            .filter(|&seq| state.last_ordered_seq.is_none_or(|ordered| seq > ordered));
        let replaced_bytes = pending.map_or(0, |seq| {
            let index = (seq - state.head_seq) as usize;
            state.entries[index].bytes
        });

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
        let outcome = if let Some(seq) = pending {
            let index = (seq - state.head_seq) as usize;
            state.entries[index] = publication.clone();
            state.coalesced += 1;
            Enqueued::Coalesced
        } else {
            let seq = state.head_seq + state.entries.len() as u64;
            match &publication.snapshot_type {
                Some(snapshot_type) => {
                    state.pending_snapshots.insert(snapshot_type.clone(), seq);
                }
                None => state.last_ordered_seq = Some(seq),
            }
            state.entries.push_back(publication.clone());
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
            .push_back(Publication::ordered(Message::Close(None)));
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
        let Some(entry) = state.entries.pop_front() else {
            return Err(if state.closed {
                TryNextError::Closed
            } else {
                TryNextError::Empty
            });
        };
        let seq = state.head_seq;
        state.head_seq += 1;
        state.queued_bytes -= entry.bytes;
        if let Some(snapshot_type) = &entry.snapshot_type
            && state.pending_snapshots.get(snapshot_type) == Some(&seq)
        {
            state.pending_snapshots.remove(snapshot_type);
        }
        Ok(entry.message)
    }

    /// Number of snapshots replaced in place because this client had not yet received them.
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

    /// Verifies the message type is read only from droppable publications.
    #[test]
    fn classifies_only_droppable_snapshots() {
        let snapshot = encoded(DISCRIMINATOR_DROPPABLE, &TestMessage::Snapshot(1));
        let ordered = encoded(DISCRIMINATOR_NON_DROPPABLE, &TestMessage::Snapshot(1));
        assert_eq!(snapshot.snapshot_type.as_deref(), Some("Snapshot"));
        assert_eq!(ordered.snapshot_type, None);
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
        assert_eq!(state.queued_bytes, state.entries[0].bytes);
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
