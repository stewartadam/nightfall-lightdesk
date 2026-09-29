// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{env, hint::black_box, time::Duration};

use bevy_app::prelude::*;
use bevy_ecs::prelude::{Component, Local, Query, With};
use bevy_ecs::schedule::IntoScheduleConfigs;
use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use moonshine_kind::Instance;
use nightfall::data::Priority;
use nightfall::prelude::{
    FadeCurve, FixtureRef, Identifiers, MaterializedTransition, ObjectRef, ObjectType,
};
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::{Attribute, DmxValueResolution, ParameterValue};
use nightfall_fixture_model::prelude::*;
use nightfall_fixtures::prelude::{
    Fixture, FixtureDataProviderExt, FixtureElement, Parameter, ParameterValues,
};

/// Compositor benchmark assertion styles for validating generated output.
#[derive(Clone, Copy)]
enum AssertionShape {
    DefaultsOnly,
    Sparse,
    Dense,
}

/// Transition timing modes covered by compositor benchmarks.
#[derive(Clone, Copy)]
enum BenchTransitionMode {
    None,
    All,
}

/// Input, transition, and assertion data for one compositor benchmark scenario.
#[derive(Clone, Copy)]
struct BenchmarkCase {
    parameter_count: usize,
    layer_count: usize,
    assertion_shape: AssertionShape,
    transition_mode: BenchTransitionMode,
}

/// Marker for layers whose assertions change before every measured compositor frame.
#[derive(Component)]
struct ChangingBenchmarkLayer;

impl BenchmarkCase {
    fn id(self) -> String {
        format!(
            "{}/params={}/layers={}/transitions={}",
            self.assertion_shape.name(),
            self.parameter_count,
            self.layer_count,
            self.transition_mode.name()
        )
    }
}

impl BenchTransitionMode {
    fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::All => "all",
        }
    }
}

impl AssertionShape {
    fn name(self) -> &'static str {
        match self {
            Self::DefaultsOnly => "defaults_only",
            Self::Sparse => "sparse_assertions",
            Self::Dense => "dense_assertions",
        }
    }

    fn asserted_count(self, parameter_count: usize) -> usize {
        match self {
            Self::DefaultsOnly => 0,
            Self::Sparse => (parameter_count / 20).max(1),
            Self::Dense => parameter_count,
        }
    }
}

fn bench_compositor(c: &mut Criterion) {
    let mut group = c.benchmark_group("compositor_update");
    let layer_counts = configured_layer_counts();
    let transition_modes = configured_transition_modes();

    for parameter_count in [128, 512, 2_048, 8_192] {
        for layer_count in layer_counts.iter().copied() {
            group.throughput(Throughput::Elements(parameter_count as u64));

            for assertion_shape in [
                AssertionShape::DefaultsOnly,
                AssertionShape::Sparse,
                AssertionShape::Dense,
            ] {
                if layer_count == 0 && !matches!(assertion_shape, AssertionShape::DefaultsOnly) {
                    continue;
                }

                for transition_mode in transition_modes.iter().copied() {
                    let case = BenchmarkCase {
                        parameter_count,
                        layer_count,
                        assertion_shape,
                        transition_mode,
                    };

                    group.bench_with_input(
                        BenchmarkId::from_parameter(case.id()),
                        &case,
                        |b, case| {
                            let mut app = compositor_app(*case);
                            app.update();

                            b.iter(|| {
                                app.update();
                                black_box(
                                    app.world()
                                        .resource::<FinalLayerAttributedAssertions>()
                                        .0
                                        .absolute
                                        .len(),
                                );
                            });
                        },
                    );
                }
            }
        }
    }

    group.finish();
}

/// Compares steady frames with frames where every dense layer assertion changes.
fn bench_compositor_frame_throughput(c: &mut Criterion) {
    let case = BenchmarkCase {
        parameter_count: 2_048,
        layer_count: 16,
        assertion_shape: AssertionShape::Dense,
        transition_mode: BenchTransitionMode::None,
    };
    let mut group = c.benchmark_group("compositor_frame_throughput");
    group.throughput(Throughput::Elements(1));

    group.bench_function(BenchmarkId::new("steady_state", case.id()), |b| {
        let mut app = compositor_app(case);
        app.update();

        b.iter(|| {
            app.update();
            black_box(
                app.world()
                    .resource::<FinalLayerAttributedAssertions>()
                    .0
                    .absolute
                    .len(),
            );
        });
    });

    group.bench_function(BenchmarkId::new("all_assertions_changed", case.id()), |b| {
        let mut app = changing_compositor_app(case);
        app.update();

        b.iter(|| {
            app.update();
            black_box(
                app.world()
                    .resource::<FinalLayerAttributedAssertions>()
                    .0
                    .absolute
                    .len(),
            );
        });
    });

    group.finish();
}

/// Times compositor frames at sample-show scale, with every assertion changing and mid-fade.
///
/// Profiling the sample show under load found 17 to 47 active layers over about 1,500 fixture
/// elements, with transition application and attributed merging dominating the frame. These
/// cases use 1,536 eight-parameter elements and dense, fading layers to reproduce that shape.
fn bench_compositor_show_scale(c: &mut Criterion) {
    let mut group = c.benchmark_group("compositor_show_scale");
    for layer_count in [16, 32] {
        let case = BenchmarkCase {
            parameter_count: 1_536 * 8,
            layer_count,
            assertion_shape: AssertionShape::Dense,
            transition_mode: BenchTransitionMode::All,
        };
        group.throughput(Throughput::Elements(
            (case.parameter_count * case.layer_count) as u64,
        ));
        group.bench_function(BenchmarkId::from_parameter(case.id()), |b| {
            let mut app = changing_compositor_app(case);
            app.update();

            b.iter(|| {
                app.update();
                black_box(
                    app.world()
                        .resource::<FinalLayerAttributedAssertions>()
                        .0
                        .absolute
                        .len(),
                );
            });
        });
    }
    group.finish();
}

fn configured_layer_counts() -> Vec<usize> {
    env::var("NIGHTFALL_COMPOSITOR_BENCH_LAYERS")
        .ok()
        .map(|value| {
            value
                .split(',')
                .filter_map(|part| part.trim().parse::<usize>().ok())
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| vec![0, 1, 4, 16])
}

fn configured_transition_modes() -> Vec<BenchTransitionMode> {
    env::var("NIGHTFALL_COMPOSITOR_BENCH_TRANSITIONS")
        .ok()
        .map(|value| {
            value
                .split(',')
                .filter_map(|part| match part.trim() {
                    "none" => Some(BenchTransitionMode::None),
                    "all" => Some(BenchTransitionMode::All),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| vec![BenchTransitionMode::None])
}

fn compositor_app(case: BenchmarkCase) -> App {
    let mut app = compositor_world(case);
    app.add_systems(Update, compositor::<Parameter>);
    app
}

/// Builds a compositor app whose dense assertions change before every compositor pass.
fn changing_compositor_app(case: BenchmarkCase) -> App {
    let mut app = compositor_world(case);
    app.add_systems(
        Update,
        (mutate_benchmark_layer_assertions, compositor::<Parameter>).chain(),
    );
    app
}

/// Builds the shared parameter and layer world used by compositor benchmarks.
fn compositor_world(case: BenchmarkCase) -> App {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<FinalLayerAttributedAssertions>();

    let parameters = spawn_parameters(&mut app, case.parameter_count);
    register_fixture_data(&mut app, &parameters);

    for layer_index in 0..case.layer_count {
        spawn_layer(&mut app, &parameters, case, layer_index);
    }

    app
}

/// Alternates every benchmark assertion so each measured frame changes all output parameters.
fn mutate_benchmark_layer_assertions(
    mut frame_index: Local<usize>,
    mut layers: Query<&mut Layer, With<ChangingBenchmarkLayer>>,
) {
    let next_value = if *frame_index % 2 == 0 { 64.0 } else { 192.0 };
    *frame_index += 1;

    for mut layer in &mut layers {
        for (value, _) in layer.absolute.values_mut() {
            if let ParameterValue::Absolute { value } = value {
                *value = next_value;
            }
        }
    }
}

fn spawn_layer(
    app: &mut App,
    parameters: &[Instance<Parameter>],
    case: BenchmarkCase,
    layer_index: usize,
) {
    let asserted_count = case.assertion_shape.asserted_count(case.parameter_count);
    let priority = i8::try_from(layer_index).unwrap_or(i8::MAX);
    let mut layer = Layer::new(format!("bench layer {layer_index}"), Priority(priority));

    for assertion_index in 0..asserted_count {
        let parameter_index = (assertion_index + layer_index) % parameters.len();
        layer.absolute.insert(
            parameters[parameter_index],
            (
                ParameterValue::Absolute {
                    value: ((assertion_index + layer_index) % 256) as f32,
                },
                benchmark_transition(case.transition_mode),
            ),
        );
    }

    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: layer_index as u32 + 1,
        }),
        ChangingBenchmarkLayer,
        layer,
    ));
}

fn benchmark_transition(mode: BenchTransitionMode) -> Option<MaterializedTransition> {
    match mode {
        BenchTransitionMode::None => None,
        BenchTransitionMode::All => Some(MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        }),
    }
}

fn spawn_parameters(app: &mut App, parameter_count: usize) -> Vec<Instance<Parameter>> {
    let metadata = ParameterMetadata {
        dmx_slots: Default::default(),
        functions: Vec::new(),
        default_dmx: None,
        highlight_dmx: None,
        resolution: DmxValueResolution::Coarse,
        attribute: Attribute::Intensity,
        native_unit: Attribute::Intensity.native_unit(),
        value_polarity: Attribute::Intensity.value_polarity(),
        min: 0.0,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: false,
        merge_type: MergeStrategy::LTP,
        use_grandmaster: false,
    };

    (0..parameter_count)
        .map(|index| {
            let mut values = ParameterValues::default();
            values.default_value = (index % 256) as f32;
            values.current_value = 255.0 - values.default_value;

            let entity = app
                .world_mut()
                .spawn(Parameter {
                    metadata: metadata.clone(),
                    values,
                })
                .id();

            unsafe { Instance::from_entity_unchecked(entity) }
        })
        .collect()
}

fn register_fixture_data(app: &mut App, parameters: &[Instance<Parameter>]) {
    let parameter_metadata = ParameterMetadata {
        dmx_slots: Default::default(),
        functions: Vec::new(),
        default_dmx: None,
        highlight_dmx: None,
        resolution: DmxValueResolution::Coarse,
        attribute: Attribute::Intensity,
        native_unit: Attribute::Intensity.native_unit(),
        value_polarity: Attribute::Intensity.value_polarity(),
        min: 0.0,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: false,
        merge_type: MergeStrategy::LTP,
        use_grandmaster: false,
    };
    let fixture = Fixture {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "bench fixture".to_owned(),
        },
        make: "bench".to_owned(),
        model: "bench".to_owned(),
        elements: parameters
            .iter()
            .enumerate()
            .map(|(index, _)| FixtureElement {
                label: format!("element {index}"),
                parameters: vec![parameter_metadata.clone()],
            })
            .collect(),
        ..Default::default()
    };

    let mut data_provider = app
        .world_mut()
        .get_resource_mut::<FixtureDataProviderExt>()
        .expect("fixture data provider must be inserted");
    let _ = data_provider.inner.add(fixture.clone());

    for (index, parameter) in parameters.iter().enumerate() {
        data_provider.add_parameter(
            FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(index as u32 + 1),
            },
            Attribute::Intensity,
            *parameter,
        );
    }
}

criterion_group!(
    benches,
    bench_compositor,
    bench_compositor_frame_throughput,
    bench_compositor_show_scale,
    bench_compositor_show_scale_mixed
);
criterion_main!(benches);

/// Marker for layers whose compositing context advances every measured frame, like a fading cue.
#[derive(Component)]
struct FadingBenchmarkLayer;

/// Where fading layers sit in the priority stack of a mixed show-scale benchmark.
#[derive(Clone, Copy)]
enum FadingPosition {
    /// Fading layers have the highest priorities, above every settled layer.
    Top,
    /// Fading layers have the lowest priorities, below every settled layer.
    Bottom,
}

impl FadingPosition {
    /// Returns the benchmark id fragment for this position.
    fn name(self) -> &'static str {
        match self {
            Self::Top => "top",
            Self::Bottom => "bottom",
        }
    }
}

/// Benchmarks show-scale frames where most dense layers have finished fading and only a few are
/// still mid-fade, which is the usual shape of a running show between cue changes.
fn bench_compositor_show_scale_mixed(c: &mut Criterion) {
    let mut group = c.benchmark_group("compositor_show_scale_mixed");
    let parameter_count = 1_536 * 8;
    let layer_count = 32;
    for (fading_count, position) in [
        (1, FadingPosition::Top),
        (4, FadingPosition::Top),
        (1, FadingPosition::Bottom),
    ] {
        group.bench_function(
            BenchmarkId::from_parameter(format!(
                "params={parameter_count}/layers={layer_count}/fading={fading_count}/{}",
                position.name()
            )),
            |b| {
                let mut app =
                    mixed_compositor_app(parameter_count, layer_count, fading_count, position);
                app.update();

                b.iter(|| {
                    app.update();
                    black_box(
                        app.world()
                            .resource::<FinalLayerAttributedAssertions>()
                            .0
                            .absolute
                            .len(),
                    );
                });
            },
        );
    }
    group.finish();
}

/// Builds a compositor app with dense layers that have all finished fading except `fading_count`
/// layers at `position`, whose compositing contexts advance before every compositor pass.
fn mixed_compositor_app(
    parameter_count: usize,
    layer_count: usize,
    fading_count: usize,
    position: FadingPosition,
) -> App {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<FinalLayerAttributedAssertions>();

    let parameters = spawn_parameters(&mut app, parameter_count);
    register_fixture_data(&mut app, &parameters);

    for layer_index in 0..layer_count {
        let is_fading = match position {
            FadingPosition::Top => layer_index >= layer_count - fading_count,
            FadingPosition::Bottom => layer_index < fading_count,
        };
        let priority = i8::try_from(layer_index).unwrap_or(i8::MAX);
        let mut layer = Layer::new(format!("bench layer {layer_index}"), Priority(priority));
        for (assertion_index, parameter) in parameters.iter().enumerate() {
            layer.absolute.insert(
                *parameter,
                (
                    ParameterValue::Absolute {
                        value: ((assertion_index + layer_index) % 256) as f32,
                    },
                    benchmark_transition(BenchTransitionMode::All),
                ),
            );
        }
        let context = LayerCompositingContext {
            position: if is_fading {
                Duration::ZERO
            } else {
                Duration::from_secs(10)
            },
            released_at: None,
        };
        let mut entity = app.world_mut().spawn((
            ObjectRefMarker(ObjectRef::ById {
                object_type: ObjectType::Cue,
                id: layer_index as u32 + 1,
            }),
            layer,
            context,
        ));
        if is_fading {
            entity.insert(FadingBenchmarkLayer);
        }
    }

    app.add_systems(
        Update,
        (advance_fading_layers, compositor::<Parameter>).chain(),
    );
    app
}

/// Advances fading layers by one 60 fps frame, wrapping inside the one-second fade so they never
/// finish.
fn advance_fading_layers(
    mut contexts: Query<&mut LayerCompositingContext, With<FadingBenchmarkLayer>>,
) {
    for mut context in &mut contexts {
        context.position = Duration::from_millis((context.position.as_millis() as u64 + 16) % 900);
    }
}
