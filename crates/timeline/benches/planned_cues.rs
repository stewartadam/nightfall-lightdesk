// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{collections::HashMap, env, hint::black_box, time::Duration};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use moonshine_kind::Instance;
use nightfall::prelude::{FixtureRef, Identifiers, SelectionExpr, SpatialSelection, ValueSource};
use nightfall_clips::{Clip, Source};
use nightfall_cues::prelude::{BoundCueInstruction, Cue, CueInstruction, Sequence};
use nightfall_cues::websocket::{CueDefinitionChange, SequenceDefinitionChange};
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::DataProvider;
use nightfall_fixture_model::prelude::*;
use nightfall_fixtures::prelude::{
    Fixture, FixtureDataProviderExt, FixtureElement, Parameter, ParameterValues,
};
use nightfall_timeline::prelude::{
    Action, ActionKind, Timeline, TimelinePlannedCuesByAction, Track,
};
use nightfall_timeline::update_timeline_planned_cues_system;
use uuid::Uuid;

const DEFAULT_CUE_COUNTS: &[usize] = &[100, 1_000];
const DEFAULT_START_COUNTS: &[usize] = &[1, 20];

/// Fixtures every benchmark cue selects.
const FIXTURE_COUNT: usize = 64;

/// Go actions placed after each clip start.
const GOS_PER_START: usize = 10;

/// Edit that triggers a recompute in a benchmark case.
#[derive(Clone, Copy)]
enum Trigger {
    /// A timeline edit, such as dropping a dragged Go; cached sequence timings are reused.
    TimelineEdit,
    /// A fixture edit, which drops cached timings so every navigated sequence is re-resolved.
    FixtureEdit,
}

impl Trigger {
    /// Returns the benchmark ID segment for this trigger.
    fn name(self) -> &'static str {
        match self {
            Self::TimelineEdit => "timeline_edit",
            Self::FixtureEdit => "fixture_edit",
        }
    }
}

/// Registers the planned cue recompute benchmarks.
fn bench_planned_cues(c: &mut Criterion) {
    let cue_counts = configured_counts(
        "NIGHTFALL_PLANNED_CUES_BENCH_CUE_COUNTS",
        DEFAULT_CUE_COUNTS,
    );
    let start_counts = configured_counts(
        "NIGHTFALL_PLANNED_CUES_BENCH_START_COUNTS",
        DEFAULT_START_COUNTS,
    );
    let mut group = c.benchmark_group("timeline_planned_cues_recompute");

    for trigger in [Trigger::TimelineEdit, Trigger::FixtureEdit] {
        for &cue_count in &cue_counts {
            for &start_count in &start_counts {
                let mut app = planned_cues_app(cue_count, start_count);
                let id = format!("{}/cues={cue_count}/starts={start_count}", trigger.name());
                group.bench_function(BenchmarkId::from_parameter(id), |b| {
                    b.iter(|| {
                        match trigger {
                            Trigger::TimelineEdit => app
                                .world_mut()
                                .resource_mut::<DataProvider<Timeline>>()
                                .set_changed(),
                            Trigger::FixtureEdit => app
                                .world_mut()
                                .resource_mut::<FixtureDataProviderExt>()
                                .set_changed(),
                        }
                        app.update();
                        black_box(
                            app.world()
                                .resource::<TimelinePlannedCuesByAction>()
                                .cues
                                .len(),
                        )
                    });
                });
            }
        }
    }

    group.finish();
}

/// Builds an app running only the planned cue system over one `cue_count`-step sequence clip that
/// a timeline starts `start_count` times, each start followed by [`GOS_PER_START`] Go actions.
fn planned_cues_app(cue_count: usize, start_count: usize) -> App {
    let mut app = App::new();
    nightfall_desk::automation_actions::register_desk_actions(&mut app);
    app.init_resource::<DataProvider<Timeline>>();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Sequence>>();
    app.init_resource::<DataProvider<nightfall::prelude::Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<TimelinePlannedCuesByAction>();
    app.add_message::<CueDefinitionChange>();
    app.add_message::<SequenceDefinitionChange>();
    app.add_systems(Update, update_timeline_planned_cues_system);

    let fixtures = (0..FIXTURE_COUNT)
        .map(|index| add_fixture(&mut app, index))
        .collect::<Vec<_>>();
    let steps = (0..cue_count)
        .map(|index| add_cue(&mut app, index, fixtures.clone()).into())
        .collect();
    let sequence_uid = Uuid::from_u128(0x2_0000);
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "benchmark-sequence".to_owned(),
            },
            steps,
            ..Default::default()
        })
        .expect("benchmark sequence should be stored");
    let clip_uid = Uuid::from_u128(0x3_0000);
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 1,
            uid: clip_uid,
            label: "benchmark-clip".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let actions = (0..start_count)
        .flat_map(|start| {
            (0..=GOS_PER_START).map(move |step| {
                let action = if step == 0 {
                    ActionKind::StartClip(clip_uid)
                } else {
                    ActionKind::AdvanceSequence(clip_uid)
                };
                Action {
                    id: format!("action-{start}-{step}"),
                    label: String::new(),
                    position: Duration::from_secs((start * (GOS_PER_START + 1) + step) as u64),
                    duration: Duration::ZERO,
                    action: action.to_reference(),
                }
            })
        })
        .collect();
    app.world_mut()
        .resource_mut::<DataProvider<Timeline>>()
        .add(Timeline {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::from_u128(0x5_0000),
                label: "benchmark-timeline".to_owned(),
            },
            tracks: vec![Track {
                id: "track-1".to_owned(),
                label: "Track 1".to_owned(),
                muted: false,
                solo: false,
                expanded: false,
                actions,
                automation_lanes: Vec::new(),
            }],
            ..Default::default()
        })
        .expect("benchmark timeline should be stored");

    app.update();
    assert_eq!(
        app.world()
            .resource::<TimelinePlannedCuesByAction>()
            .cues
            .len(),
        start_count * GOS_PER_START,
        "every Go should resolve a planned cue"
    );
    app
}

/// Spawns one fixture with an Intensity parameter and registers it for lookup.
fn add_fixture(app: &mut App, index: usize) -> FixtureRef {
    let fixture_uid = Uuid::from_u128(index as u128 + 1);
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        ..Default::default()
    };
    let entity = app
        .world_mut()
        .spawn(Parameter {
            metadata: metadata.clone(),
            values: ParameterValues::default(),
        })
        .id();
    // SAFETY: the entity was just spawned with a `Parameter` component.
    let parameter = unsafe { Instance::<Parameter>::from_entity_unchecked(entity) };

    let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    fixtures
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: index as u32 + 1,
                uid: fixture_uid,
                label: format!("fixture-{index}"),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![metadata],
            }],
            ..Default::default()
        })
        .expect("benchmark fixture should be stored");
    fixtures.add_parameter(fixture_ref.clone(), Attribute::Intensity, parameter);
    fixture_ref
}

/// Stores a manual cue that sets every fixture's intensity, returning its UID.
fn add_cue(app: &mut App, index: usize, selection: Vec<FixtureRef>) -> Uuid {
    let uid = Uuid::from_u128(0x1_0000 + index as u128);
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(Cue {
            identifiers: Identifiers {
                id: index as u32 + 1,
                uid,
                label: format!("cue-{index}"),
            },
            instructions: vec![BoundCueInstruction {
                selection: SpatialSelection::identity(SelectionExpr::Resolved(selection)),
                cue_instruction: CueInstruction {
                    values: HashMap::from([(
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: ((index % 100) as f64).into(),
                        }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .expect("benchmark cue should be stored");
    uid
}

/// Reads a comma-separated count list from the environment, falling back to `defaults`.
fn configured_counts(variable: &str, defaults: &[usize]) -> Vec<usize> {
    env::var(variable)
        .ok()
        .map(|value| {
            value
                .split(',')
                .filter_map(|part| part.trim().parse::<usize>().ok())
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| defaults.to_vec())
}

criterion_group!(benches, bench_planned_cues);
criterion_main!(benches);
