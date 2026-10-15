// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cues::websocket::{CueDefinitionChange, SequenceDefinitionChange};

use super::*;
use crate::prelude::TimelineSequenceActionTargets;
use crate::systems::update_timeline_sequence_action_targets_system;

/// Builds an app with one four-cue manual sequence clip, returning the clip and cue UIDs.
fn setup_sequence_target_app() -> (App, Uuid, Vec<Uuid>) {
    let mut app = App::new();
    crate::install_timeline_test_actions(&mut app);
    app.init_resource::<DataProvider<Timeline>>();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Sequence>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<TimelineSequenceActionTargets>();
    app.add_message::<CueDefinitionChange>();
    app.add_message::<SequenceDefinitionChange>();
    app.add_systems(Update, update_timeline_sequence_action_targets_system);

    let clip_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    let mut cue_uids = Vec::new();
    for id in 1..=4 {
        let uid = Uuid::new_v4();
        app.world_mut()
            .resource_mut::<DataProvider<Cue>>()
            .add(Cue {
                identifiers: Identifiers {
                    id,
                    uid,
                    label: format!("Cue {id}"),
                },
                trigger: CueTriggerType::Manual,
                ..Default::default()
            })
            .expect("manual cue should insert");
        cue_uids.push(uid);
    }
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "Manual sequence".to_owned(),
            },
            steps: cue_uids.iter().map(|uid| (*uid).into()).collect(),
            ..Default::default()
        })
        .expect("sequence should insert");
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 1,
            uid: clip_uid,
            label: "Sequence clip".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });
    (app, clip_uid, cue_uids)
}

/// Builds a one-track timeline from `(action id, kind, seconds)` triples.
fn navigation_timeline(timeline_uid: Uuid, actions: &[(&str, ActionKind, u64)]) -> Timeline {
    let mut timeline = Timeline {
        tracks: vec![Track {
            id: "sequence".to_owned(),
            label: "Sequence".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            automation_lanes: Vec::new(),
            actions: actions
                .iter()
                .map(|(id, kind, seconds)| Action {
                    id: (*id).to_owned(),
                    label: "Go".to_owned(),
                    position: Duration::from_secs(*seconds),
                    duration: Duration::ZERO,
                    action: kind.clone().to_reference(),
                })
                .collect(),
        }],
        ..Default::default()
    };
    timeline.identifiers.id = 1;
    timeline.identifiers.uid = timeline_uid;
    timeline
}

/// Replaces the stored timeline definition, as a timeline edit does.
fn store_timeline(app: &mut App, timeline: Timeline) {
    let mut provider = app.world_mut().resource_mut::<DataProvider<Timeline>>();
    let _ = provider.remove(&timeline.identifiers.uid);
    provider.add(timeline).expect("timeline should insert");
}

/// Returns each resolved navigation action ID with the cue UID it lands on.
fn resolved_targets(app: &App) -> Vec<(String, Option<Uuid>)> {
    app.world()
        .resource::<TimelineSequenceActionTargets>()
        .targets
        .iter()
        .map(|target| (target.action_id.clone(), target.cue_uid))
        .collect()
}

/// Verifies Go and Back targets follow timeline order, and update when an action is moved.
#[test]
fn sequence_action_targets_follow_action_position() {
    let (mut app, clip_uid, cues) = setup_sequence_target_app();
    let timeline_uid = Uuid::new_v4();
    store_timeline(
        &mut app,
        navigation_timeline(
            timeline_uid,
            &[
                ("start", ActionKind::StartClip(clip_uid), 1),
                ("go-a", ActionKind::AdvanceSequence(clip_uid), 2),
                ("go-b", ActionKind::AdvanceSequence(clip_uid), 3),
                ("back", ActionKind::BackSequence(clip_uid), 4),
            ],
        ),
    );
    app.update();

    assert_eq!(
        resolved_targets(&app),
        vec![
            ("back".to_owned(), Some(cues[1])),
            ("go-a".to_owned(), Some(cues[1])),
            ("go-b".to_owned(), Some(cues[2])),
        ]
    );

    store_timeline(
        &mut app,
        navigation_timeline(
            timeline_uid,
            &[
                ("start", ActionKind::StartClip(clip_uid), 1),
                ("go-a", ActionKind::AdvanceSequence(clip_uid), 5),
                ("go-b", ActionKind::AdvanceSequence(clip_uid), 3),
                ("back", ActionKind::BackSequence(clip_uid), 4),
            ],
        ),
    );
    app.update();

    assert_eq!(
        resolved_targets(&app),
        vec![
            ("back".to_owned(), Some(cues[0])),
            ("go-a".to_owned(), Some(cues[1])),
            ("go-b".to_owned(), Some(cues[1])),
        ]
    );
}

/// Verifies muted tracks neither resolve their own targets nor shift audible ones.
#[test]
fn sequence_action_targets_skip_muted_tracks() {
    let (mut app, clip_uid, cues) = setup_sequence_target_app();
    let timeline_uid = Uuid::new_v4();
    let mut timeline = navigation_timeline(
        timeline_uid,
        &[
            ("start", ActionKind::StartClip(clip_uid), 1),
            ("go", ActionKind::AdvanceSequence(clip_uid), 3),
        ],
    );
    let mut muted = navigation_timeline(
        timeline_uid,
        &[("muted-go", ActionKind::AdvanceSequence(clip_uid), 2)],
    )
    .tracks
    .remove(0);
    muted.id = "muted".to_owned();
    muted.muted = true;
    timeline.tracks.push(muted);
    store_timeline(&mut app, timeline);
    app.update();

    assert_eq!(
        resolved_targets(&app),
        vec![("go".to_owned(), Some(cues[1]))]
    );
}

/// Verifies an edit to a navigated sequence re-resolves targets from the cached replay inputs.
#[test]
fn sequence_action_targets_follow_sequence_edits() {
    let (mut app, clip_uid, cues) = setup_sequence_target_app();
    let timeline_uid = Uuid::new_v4();
    store_timeline(
        &mut app,
        navigation_timeline(
            timeline_uid,
            &[
                ("start", ActionKind::StartClip(clip_uid), 1),
                ("go", ActionKind::AdvanceSequence(clip_uid), 2),
            ],
        ),
    );
    app.update();
    assert_eq!(
        resolved_targets(&app),
        vec![("go".to_owned(), Some(cues[1]))]
    );

    let sequence_uid = app
        .world()
        .resource::<TimelineSequenceActionTargets>()
        .targets[0]
        .sequence_uid;
    let mut sequence = app
        .world()
        .resource::<DataProvider<Sequence>>()
        .get(sequence_uid)
        .expect("sequence should exist")
        .clone();
    sequence.steps.swap(1, 2);
    {
        let mut provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        provider
            .remove(&sequence_uid)
            .expect("sequence should be removable");
        provider
            .add(sequence.clone())
            .expect("sequence should insert");
    }
    app.world_mut()
        .write_message(SequenceDefinitionChange::Updated(Box::new(sequence)));
    app.update();

    assert_eq!(
        resolved_targets(&app),
        vec![("go".to_owned(), Some(cues[2]))]
    );
}

/// Verifies a cue edit outside every navigated sequence leaves published targets untouched.
#[test]
fn sequence_action_targets_skip_unrelated_cue_edits() {
    let (mut app, clip_uid, _) = setup_sequence_target_app();
    store_timeline(
        &mut app,
        navigation_timeline(
            Uuid::new_v4(),
            &[
                ("start", ActionKind::StartClip(clip_uid), 1),
                ("go", ActionKind::AdvanceSequence(clip_uid), 2),
            ],
        ),
    );
    app.update();
    app.update();

    let unrelated = Cue {
        identifiers: Identifiers {
            id: 99,
            uid: Uuid::new_v4(),
            label: "Unrelated".to_owned(),
        },
        ..Default::default()
    };
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(unrelated.clone())
        .expect("unrelated cue should insert");
    app.world_mut()
        .write_message(CueDefinitionChange::Updated(Box::new(unrelated)));
    app.world_mut()
        .resource_mut::<TimelineSequenceActionTargets>()
        .targets
        .clear();
    app.update();

    assert!(
        app.world()
            .resource::<TimelineSequenceActionTargets>()
            .targets
            .is_empty(),
        "an unrelated cue edit should not trigger a recompute"
    );
}
