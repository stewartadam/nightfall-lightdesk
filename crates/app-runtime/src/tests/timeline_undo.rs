// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! End-to-end undo and redo of timeline edits in a sample-data world.

use std::time::Duration;

use nightfall_engine::prelude::DataProvider;
use nightfall_timeline::prelude::{
    Timeline, TimelineCommand, TimelineEdit, TimelineMarker, TrackSetting,
};
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

/// Undoing a granular track edit restores only that track's setting: a marker added after the
/// edit stays, and redo applies the edit again without dropping the marker.
#[tokio::test]
async fn track_edit_undo_keeps_later_marker() {
    let mut harness = DeskHarness::new();
    let track_id = harness
        .timeline()
        .tracks
        .first()
        .expect("sample timeline should have a track")
        .id
        .clone();
    let was_muted = harness.timeline().tracks[0].muted;

    harness.succeed(TimelineCommand::EditTimeline {
        timeline_id: TIMELINE_ID,
        edit: TimelineEdit::UpdateTrack {
            track_id: track_id.clone(),
            settings: vec![TrackSetting::Muted(!was_muted)],
        },
    });
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

    // The marker is the newest undo step; undo it, then the mute, and redo both.
    harness.succeed(UndoCommand::Undo {});
    harness.succeed(UndoCommand::Undo {});
    assert_eq!(harness.timeline().tracks[0].muted, was_muted);
    harness.succeed(UndoCommand::Redo {});
    assert_eq!(harness.timeline().tracks[0].muted, !was_muted);
    harness.succeed(UndoCommand::Redo {});
    assert!(harness.marker_uids().contains(&marker_uid));

    // Solo the track after the marker exists; undoing the solo keeps the marker and the mute.
    harness.succeed(TimelineCommand::EditTimeline {
        timeline_id: TIMELINE_ID,
        edit: TimelineEdit::UpdateTrack {
            track_id,
            settings: vec![TrackSetting::Solo(true)],
        },
    });
    harness.succeed(UndoCommand::Undo {});
    let timeline = harness.timeline();
    assert!(!timeline.tracks[0].solo);
    assert_eq!(timeline.tracks[0].muted, !was_muted);
    assert!(harness.marker_uids().contains(&marker_uid));
}

/// An edit naming a track that doesn't exist fails and records no undo step.
#[tokio::test]
async fn edit_of_missing_track_fails_without_undo_step() {
    let mut harness = DeskHarness::new();
    let depth = harness.undo_ids().len();
    let command_id = harness.submit(TimelineCommand::EditTimeline {
        timeline_id: TIMELINE_ID,
        edit: TimelineEdit::DeleteTrack {
            track_id: "missing".to_string(),
        },
    });
    assert!(matches!(
        harness.wait(command_id),
        nightfall_engine::prelude::CommandOutcome::Failed(_)
    ));
    assert_eq!(harness.undo_ids().len(), depth);
}
