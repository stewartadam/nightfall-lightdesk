// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    collections::HashMap,
    env,
    hint::black_box,
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, RwLock},
    time::Duration,
};

use app_runtime::{WorldBootstrap, WorldFactory};
use bevy::prelude::{App, DetectChangesMut};
use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use moonshine_kind::Instance;
use nightfall::prelude::{FixtureRef, Identifiers, SelectionExpr, SpatialSelection, ValueSource};
use nightfall_clips::{Clip, Source};
use nightfall_config::{RuntimeConfig, TransportConfig};
use nightfall_cues::prelude::{BoundCueInstruction, Cue, CueInstruction, Sequence};
use nightfall_desk::resources::log_config::{LogConfig, TracingTarget};
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::{DataProvider, EngineOperationEnvelope};
use nightfall_fixture_model::prelude::*;
use nightfall_fixtures::prelude::{
    Fixture, FixtureDataProviderExt, FixtureElement, Parameter, ParameterValues,
};
use nightfall_framepace::{FramepaceSettings, Limiter};
use nightfall_timecode::prelude::{Timecode, TimecodeGenerator, TimecodeRate, TimecodeSource};
use nightfall_timeline::prelude::{
    Action, ActionKind, MaterializedTimeline, Timeline, TimelineLookaheadActionStatuses,
    TimelineLookaheadMode, TimelineOperation, Track,
};
use uuid::Uuid;

const DEFAULT_FIXTURE_COUNTS: &[usize] = &[16, 128];
const DEFAULT_START_COUNTS: &[usize] = &[4, 32];

/// Timeline and timecode ID used by the seeded benchmark show.
const TIMELINE_ID: u32 = 1;

/// Spacing between upcoming sequence starts on the benchmark timeline.
const START_SPACING: Duration = Duration::from_secs(10);

/// Frame shape measured by a timeline lookahead benchmark case.
#[derive(Clone, Copy)]
enum FrameKind {
    /// Nothing changes between frames, so lookahead reuses cached providers and layers.
    Steady,
    /// Cue definitions are marked changed before every frame, forcing providers to
    /// rematerialize and footprints and layers to be rebuilt, as when editing a cue while a
    /// timeline is armed.
    CuesChanged,
}

impl FrameKind {
    /// Returns the benchmark ID segment for this frame kind.
    fn name(self) -> &'static str {
        match self {
            Self::Steady => "steady",
            Self::CuesChanged => "cues_changed",
        }
    }
}

/// Registers the timeline lookahead frame benchmarks.
fn bench_timeline_lookahead(c: &mut Criterion) {
    let fixture_counts = configured_counts(
        "NIGHTFALL_TIMELINE_LOOKAHEAD_BENCH_FIXTURE_COUNTS",
        DEFAULT_FIXTURE_COUNTS,
    );
    let start_counts = configured_counts(
        "NIGHTFALL_TIMELINE_LOOKAHEAD_BENCH_START_COUNTS",
        DEFAULT_START_COUNTS,
    );
    // The backend's websocket and OSC services spawn onto the ambient Tokio runtime.
    let runtime = tokio::runtime::Runtime::new().expect("Tokio runtime should start");
    let _runtime_guard = runtime.enter();
    let mut group = c.benchmark_group("timeline_lookahead_frame");

    for frame_kind in [FrameKind::Steady, FrameKind::CuesChanged] {
        for mode in [
            TimelineLookaheadMode::Enabled,
            TimelineLookaheadMode::Disabled,
        ] {
            for &fixture_count in &fixture_counts {
                for &start_count in &start_counts {
                    let mut app = lookahead_app(fixture_count, start_count, mode);
                    let id = format!(
                        "{}/{}/fixtures={fixture_count}/starts={start_count}",
                        frame_kind.name(),
                        mode_name(mode),
                    );
                    group.bench_function(BenchmarkId::from_parameter(id), |b| {
                        b.iter(|| {
                            if matches!(frame_kind, FrameKind::CuesChanged) {
                                app.world_mut()
                                    .resource_mut::<DataProvider<Cue>>()
                                    .set_changed();
                            }
                            app.update();
                            black_box(
                                app.world()
                                    .resource::<TimelineLookaheadActionStatuses>()
                                    .statuses
                                    .len(),
                            )
                        });
                    });
                }
            }
        }
    }

    group.finish();
}

/// Builds the live backend with a paused, started timeline holding `start_count` upcoming
/// sequence starts over `fixture_count` dark fixtures, then warms it until lookahead state
/// has settled.
///
/// Each sequence's first cue moves Pan and Tilt for a quarter of the rig, with windows that
/// overlap their neighbours so later starts exercise intervening-fixture blocking.
fn lookahead_app(fixture_count: usize, start_count: usize, mode: TimelineLookaheadMode) -> App {
    let factory = WorldFactory::for_config(bench_log_config(), bench_runtime_config());
    let mut app = factory
        .build(WorldBootstrap::Empty {
            showfile_name: None,
        })
        .expect("empty backend app should initialize");
    // Frames must run back to back; the live frame limiter would otherwise sleep each update.
    app.world_mut().resource_mut::<FramepaceSettings>().limiter = Limiter::Off;

    let fixtures = (0..fixture_count)
        .map(|index| add_fixture(&mut app, index))
        .collect::<Vec<_>>();
    let window = (fixture_count / 4).max(1);

    let actions = (0..start_count)
        .map(|index| {
            let window_start = (index * window / 2) % fixture_count.max(1);
            let selection = fixtures
                .iter()
                .cycle()
                .skip(window_start)
                .take(window)
                .cloned()
                .collect::<Vec<_>>();
            let clip_uid = add_sequence_clip(&mut app, index, selection);
            Action {
                id: format!("start-{index}"),
                label: format!("Start {index}"),
                position: START_SPACING * (index as u32 + 1),
                duration: Duration::ZERO,
                action: ActionKind::StartClip(clip_uid),
            }
        })
        .collect();

    start_timeline(&mut app, actions, mode);
    factory.warm_up(&mut app, 8);

    if mode == TimelineLookaheadMode::Enabled {
        let status_count = app
            .world()
            .resource::<TimelineLookaheadActionStatuses>()
            .statuses
            .len();
        assert_eq!(
            status_count, start_count,
            "every upcoming sequence start should report a lookahead status"
        );
    }

    app
}

/// Spawns one fixture with Intensity, Pan and Tilt parameters and registers it for lookup.
fn add_fixture(app: &mut App, index: usize) -> FixtureRef {
    let fixture_uid = Uuid::from_u128(index as u128 + 1);
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let attributes = [Attribute::Intensity, Attribute::Pan, Attribute::Tilt];
    let metadata = attributes
        .iter()
        .map(|attribute| ParameterMetadata {
            attribute: attribute.clone(),
            ..Default::default()
        })
        .collect::<Vec<_>>();
    let parameters = metadata
        .iter()
        .map(|metadata| {
            let entity = app
                .world_mut()
                .spawn(Parameter {
                    metadata: metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id();
            // SAFETY: the entity was just spawned with a `Parameter` component.
            unsafe { Instance::<Parameter>::from_entity_unchecked(entity) }
        })
        .collect::<Vec<_>>();

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
                parameters: metadata,
            }],
            ..Default::default()
        })
        .expect("benchmark fixture should be stored");
    for (attribute, parameter) in attributes.into_iter().zip(parameters) {
        fixtures.add_parameter(fixture_ref.clone(), attribute, parameter);
    }
    fixture_ref
}

/// Stores a one-cue sequence that raises and positions `selection`, plus a clip playing it,
/// and returns the clip UID.
fn add_sequence_clip(app: &mut App, index: usize, selection: Vec<FixtureRef>) -> Uuid {
    let position = 10.0 + (index % 8) as f64 * 10.0;
    let cue = Cue {
        identifiers: Identifiers {
            id: index as u32 + 1,
            uid: Uuid::from_u128(0x1_0000 + index as u128),
            label: format!("cue-{index}"),
        },
        instructions: vec![BoundCueInstruction {
            selection: SpatialSelection::identity(SelectionExpr::Resolved(selection)),
            cue_instruction: CueInstruction {
                values: HashMap::from([
                    (
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: 100.0.into(),
                        }),
                    ),
                    (
                        Attribute::Pan,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: position.into(),
                        }),
                    ),
                    (
                        Attribute::Tilt,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: (100.0 - position).into(),
                        }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    let cue_uid = cue.identifiers.uid;
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(cue)
        .expect("benchmark cue should be stored");

    let sequence_uid = Uuid::from_u128(0x2_0000 + index as u128);
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: index as u32 + 1,
                uid: sequence_uid,
                label: format!("sequence-{index}"),
            },
            steps: vec![cue_uid.into()],
            ..Default::default()
        })
        .expect("benchmark sequence should be stored");

    let clip_uid = Uuid::from_u128(0x3_0000 + index as u128);
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: index as u32 + 1,
            uid: clip_uid,
            label: format!("clip-{index}"),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });
    clip_uid
}

/// Stores and starts a timeline holding `actions` on one track, driven by a paused internal
/// timecode parked at zero so every action stays upcoming.
fn start_timeline(app: &mut App, actions: Vec<Action>, mode: TimelineLookaheadMode) {
    let timecode = Timecode {
        identifiers: Identifiers {
            id: TIMELINE_ID,
            uid: Uuid::from_u128(0x4_0000),
            label: "benchmark-timecode".to_owned(),
        },
        rate: TimecodeRate::Fps30,
        source: TimecodeSource::Internal,
    };
    let timecode_uid = timecode.identifiers.uid;
    app.world_mut()
        .resource_mut::<DataProvider<Timecode>>()
        .add(timecode.clone())
        .expect("benchmark timecode should be stored");
    app.world_mut().spawn(TimecodeGenerator::new(timecode));

    let timeline = Timeline {
        identifiers: Identifiers {
            id: TIMELINE_ID,
            uid: Uuid::from_u128(0x5_0000),
            label: "benchmark-timeline".to_owned(),
        },
        timecode_uid,
        lookahead: mode,
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
    };
    app.world_mut()
        .resource_mut::<DataProvider<Timeline>>()
        .add(timeline.clone())
        .expect("benchmark timeline should be stored");
    app.world_mut().spawn(MaterializedTimeline::new(timeline));
    app.world_mut()
        .write_message(EngineOperationEnvelope::detached(TimelineOperation::Start(
            TIMELINE_ID,
        )));
}

/// Returns the benchmark ID segment for a timeline lookahead mode.
fn mode_name(mode: TimelineLookaheadMode) -> &'static str {
    match mode {
        TimelineLookaheadMode::Enabled => "enabled",
        TimelineLookaheadMode::Disabled => "disabled",
        TimelineLookaheadMode::Inherit => "inherit",
    }
}

/// Builds a logging configuration that discards backend log output.
fn bench_log_config() -> LogConfig {
    LogConfig::new(|_| Ok(()), Arc::new(RwLock::new(TracingTarget::default())))
}

/// Builds a runtime configuration with every transport disabled and the websocket and OSC
/// listeners on ephemeral loopback ports, so benchmark apps never collide with each other or
/// with a running Nightfall instance.
fn bench_runtime_config() -> RuntimeConfig {
    RuntimeConfig {
        server_port: 0,
        osc_bind_addr: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
        transports: TransportConfig {
            network_input_enabled: false,
            network_output_enabled: false,
            usb_output_enabled: false,
        },
        ..Default::default()
    }
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

criterion_group!(benches, bench_timeline_lookahead);
criterion_main!(benches);
