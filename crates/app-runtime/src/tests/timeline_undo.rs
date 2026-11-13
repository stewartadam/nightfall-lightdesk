// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! End-to-end undo and redo of timeline beatgrid edits in a sample-data world.

use std::time::Duration;

use nightfall_engine::prelude::DataProvider;
use nightfall_timeline::prelude::{Timeline, TimelineCommand, TimelineMarker};
use nightfall_undo::prelude::UndoCommand;
use uuid::Uuid;

use super::desk_harness::DeskHarness;

/// Sample timeline the tests edit.
const TIMELINE_ID: u32 = 1;

impl DeskHarness {
    /// Returns a copy of the sample timeline as currently stored.
    fn timeline(&self) -> Timeline {
        (*self
            .app
            .world()
            .resource::<DataProvider<Timeline>>()
            .from_id(TIMELINE_ID)
            .expect("sample timeline should exist"))
        .clone()
    }

    /// Returns the stored time of the beatgrid's first marker, if the timeline has a beatgrid.
    fn beatgrid_start(&self) -> Option<Duration> {
        self.timeline()
            .beatgrid
            .and_then(|beatgrid| beatgrid.markers.first().map(|marker| marker.time))
    }

    /// Returns the UIDs of the sample timeline's markers, in stored order.
    fn marker_uids(&self) -> Vec<Uuid> {
        self.timeline()
            .markers
            .iter()
            .map(|marker| marker.uid)
            .collect()
    }

    /// Shifts the sample timeline's beatgrid so its first beat lands at `millis`, using the
    /// stored beatgrid's audio fingerprint so the shift is never rejected as stale.
    fn shift_beatgrid(&mut self, millis: u64) {
        let audio_fingerprint = self
            .timeline()
            .beatgrid
            .map(|beatgrid| beatgrid.audio_fingerprint)
            .unwrap_or_default();
        self.succeed(TimelineCommand::SetBeatgridStart {
            timeline_id: TIMELINE_ID,
            audio_fingerprint,
            first_marker_time: Duration::from_millis(millis),
        });
    }
}

/// Undo after an earlier edit and a run of beatgrid shifts reverts the shifts as one step and
/// leaves the earlier edit in place; a second undo then reverts that edit without touching the
/// beatgrid again, and redo brings back the last shift.
#[tokio::test]
async fn beatgrid_shifts_undo_as_one_step_after_earlier_edits() {
    let mut harness = DeskHarness::new();
    let original_markers = harness.marker_uids();
    let original_beatgrid_start = harness.beatgrid_start();
    let marker_uid = Uuid::new_v4();
    harness.succeed(TimelineCommand::StoreTimelineMarker {
        timeline_id: TIMELINE_ID,
        marker: TimelineMarker {
            uid: marker_uid,
            label: "Drop".to_string(),
            time: Duration::from_secs(4),
            color: None,
        },
    });
    let markers_before_shifts = harness.marker_uids();
    let depth_before_shifts = harness.undo_ids().len();

    for millis in [100, 200, 300] {
        harness.shift_beatgrid(millis);
    }
    assert_eq!(harness.undo_ids().len(), depth_before_shifts + 1);
    assert_eq!(harness.beatgrid_start(), Some(Duration::from_millis(300)));

    harness.succeed(UndoCommand::Undo {});
    assert_eq!(harness.beatgrid_start(), original_beatgrid_start);
    assert_eq!(
        harness.marker_uids(),
        markers_before_shifts,
        "undoing the shifts should keep the earlier marker"
    );

    harness.succeed(UndoCommand::Redo {});
    assert_eq!(harness.beatgrid_start(), Some(Duration::from_millis(300)));

    harness.succeed(UndoCommand::Undo {});
    harness.succeed(UndoCommand::Undo {});
    assert_eq!(harness.marker_uids(), original_markers);
    assert_eq!(harness.beatgrid_start(), original_beatgrid_start);
}
