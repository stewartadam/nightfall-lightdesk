// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Websocket ingress for board commands and publication of boards and button states.

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use nightfall::prelude::*;
use nightfall_clips::{Clip, MaterializedClip};
use nightfall_engine::prelude::*;
use serde::Serialize;

use crate::status::{BoardObjects, BoardStatus};

/// Board messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum BoardWsMessage<'a> {
    /// Every board definition.
    BoardDefinitions(&'a [Board]),
    /// Resolved buttons and live states for every board.
    BoardStates(&'a [BoardStatus]),
}

/// Collects board definitions in ID order.
fn sorted_boards(boards: &DataProvider<Board>) -> Vec<Board> {
    let mut boards: Vec<Board> = boards.iter().map(|entry| entry.value().clone()).collect();
    boards.sort_by_key(|board| board.identifiers.id);
    boards
}

/// The board definitions feed.
#[derive(SystemParam)]
pub(crate) struct BoardsFeed<'w> {
    boards: Res<'w, DataProvider<Board>>,
}

impl ClientFeed for BoardsFeed<'static> {
    /// Publishes every board definition in ID order.
    fn publish(feed: &BoardsFeed<'_>, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &BoardWsMessage::BoardDefinitions(&sorted_boards(&feed.boards)),
        );
    }
}

/// The board button states feed. Resync replays it; [`send_board_states_on_change`] sends it to
/// every client only when the resolved states differ from the last ones sent.
#[derive(SystemParam)]
pub(crate) struct BoardStatesFeed<'w, 's> {
    boards: Res<'w, DataProvider<Board>>,
    objects: BoardObjects<'w, 's>,
}

impl ClientFeed for BoardStatesFeed<'static, 'static> {
    /// Publishes every board's resolved buttons and live states.
    fn publish(feed: &BoardStatesFeed<'_, '_>, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &BoardWsMessage::BoardStates(&board_statuses(&feed.boards, &feed.objects)),
        );
    }
}

/// Resolves every board's buttons and their live states.
fn board_statuses(boards: &DataProvider<Board>, objects: &BoardObjects) -> Vec<BoardStatus> {
    let context = objects.state_context();
    sorted_boards(boards)
        .iter()
        .map(|board| objects.board_status(&context, board))
        .collect()
}

/// Publishes button states when any input that decides them changes and the result differs.
///
/// Runs where clip removals are still visible, and compares against the last publication so
/// unrelated Programmer or clip churn does not resend identical states.
#[allow(clippy::too_many_arguments)]
pub fn send_board_states_on_change(
    boards: Res<DataProvider<Board>>,
    objects: BoardObjects,
    added_runs: Query<(), Added<MaterializedClip>>,
    mut removed_runs: RemovedComponents<MaterializedClip>,
    changed_clips: Query<(), Changed<Clip>>,
    mut removed_clips: RemovedComponents<Clip>,
    mut last_sent: Local<Option<Vec<BoardStatus>>>,
    broadcaster: Res<ClientEventSink>,
) {
    let clip_activity = !added_runs.is_empty()
        || removed_runs.read().count() > 0
        || !changed_clips.is_empty()
        || removed_clips.read().count() > 0;
    if !(boards.is_changed() || objects.changed() || clip_activity || last_sent.is_none()) {
        return;
    }
    let statuses = board_statuses(&boards, &objects);
    if last_sent.as_ref() == Some(&statuses) {
        return;
    }
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &BoardWsMessage::BoardStates(&statuses),
    );
    *last_sent = Some(statuses);
}
