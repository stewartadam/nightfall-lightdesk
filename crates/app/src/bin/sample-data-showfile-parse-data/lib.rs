// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, RwLock},
    time::Duration,
};

use bevy::{
    ecs::system::{SystemParam, SystemState},
    prelude::*,
};
use moonshine_kind::prelude::*;
use nightfall::prelude::*;
use nightfall_app_lib::{WorldBootstrap, WorldFactory};
use nightfall_clips::{Clip, Source};
use nightfall_cues::prelude::*;
use nightfall_desk::{
    prelude::*,
    resources::log_config::{LogConfig, TracingTarget},
};
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::placement::{FixturePlacement, PlacementPosition, PlacementRotation};
use nightfall_fixtures::prelude::*;
use nightfall_flow::{builtin_nodes as flow_nodes, prelude::*};
use nightfall_fx::prelude::*;
#[cfg(feature = "midi")]
use nightfall_input_midi::prelude::*;
#[cfg(feature = "osc")]
use nightfall_input_osc::prelude::*;
use nightfall_io::BindingTransport;
use nightfall_scene_objects::prelude::*;
use nightfall_timecode::prelude::*;
use nightfall_timeline::prelude::*;
use uuid::Uuid;

const DEFAULT_OUTPUT_PATH: &str = "crates/app/tests/data/procedural-showfile-parse-data.json";
const SNAPSHOT_LAST_SAVED_UNIX_SEC: u64 = 1_800_000_000;
const FIXTURE_UID: &str = "10000000-0000-0000-0000-000000000001";
const CUE_UID: &str = "10000000-0000-0000-0000-000000000002";
const SEQUENCE_UID: &str = "10000000-0000-0000-0000-000000000003";
const SETUP_CUE_UID: &str = "10000000-0000-0000-0000-000000000015";
const RELEASE_CUE_UID: &str = "10000000-0000-0000-0000-000000000014";
const GROUP_UID: &str = "10000000-0000-0000-0000-000000000004";
const FX_UID: &str = "10000000-0000-0000-0000-000000000005";
const FX_MODULE_UID: &str = "10000000-0000-0000-0000-000000000006";
const STEP_FX_UID: &str = "10000000-0000-0000-0000-000000000007";
const FLOW_UID: &str = "10000000-0000-0000-0000-000000000008";
const TIMECODE_UID: &str = "10000000-0000-0000-0000-000000000009";
const TIMELINE_UID: &str = "10000000-0000-0000-0000-000000000010";
const CUE_CLIP_UID: &str = "10000000-0000-0000-0000-000000000011";
const FX_CLIP_UID: &str = "10000000-0000-0000-0000-000000000012";
const FLOW_CLIP_UID: &str = "10000000-0000-0000-0000-000000000013";
const FIXTURE_MASTER_UID: &str = "10000000-0000-0000-0000-000000000016";
const PLAYBACK_MASTER_UID: &str = "10000000-0000-0000-0000-000000000017";
const SCENE_OBJECT_UID: &str = "10000000-0000-0000-0000-000000000018";
const BLUEPRINT_UID: &str = "10000000-0000-0000-0000-000000000019";

/// Parsed command-line arguments for the generator binary.
struct Args {
    output_path: PathBuf,
}

/// Run the generator binary.
pub fn run() {
    let result = parse_args()
        .and_then(|args| generate_json().map(|json| (args.output_path, json)))
        .and_then(|(output_path, json)| {
            write_output(&output_path, &json)?;
            println!(
                "Wrote procedural showfile parse data to {}",
                output_path.display()
            );
            Ok(())
        });

    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

/// Parse command-line arguments.
fn parse_args() -> Result<Args, String> {
    let mut args = env::args().skip(1);
    let first = args.next();

    match first.as_deref() {
        Some("--help") | Some("-h") => Err(usage_message()),
        Some(output_path) => {
            reject_extra_args(args)?;
            Ok(Args {
                output_path: PathBuf::from(output_path),
            })
        }
        None => Ok(Args {
            output_path: PathBuf::from(DEFAULT_OUTPUT_PATH),
        }),
    }
}

/// Reject extra positional arguments after a valid command shape.
fn reject_extra_args(mut args: impl Iterator<Item = String>) -> Result<(), String> {
    if let Some(extra) = args.next() {
        return Err(format!("unexpected argument {extra}\n{}", usage_message()));
    }
    Ok(())
}

/// Return the command usage text.
fn usage_message() -> String {
    format!(
        "usage: sample-data-showfile-parse-data [output.json]\n\nDefault output: {DEFAULT_OUTPUT_PATH}"
    )
}

/// Generate parser data from a purpose-built procedural world.
fn generate_json() -> Result<String, String> {
    let log_config = LogConfig::new(|_| Ok(()), Arc::new(RwLock::new(TracingTarget::default())));
    let factory = WorldFactory::new(log_config, false, false, false);
    let mut app = factory.build(WorldBootstrap::Empty {
        showfile_name: None,
    })?;
    populate_parser_test_world(app.world_mut())?;
    nightfall_app_lib::serialize_showfile_snapshot_json_from_world(
        app.world_mut(),
        SNAPSHOT_LAST_SAVED_UNIX_SEC,
    )
}

/// Populate a compact world that exercises representative showfile domains.
fn populate_parser_test_world(world: &mut World) -> Result<(), String> {
    let fixture_ref = add_fixture(world)?;
    add_bindings(world, fixture_ref.fixture_uid);
    add_input_mappings(world);
    add_global_variables(world);
    add_scene_object(world)?;
    add_group(world, fixture_ref.clone())?;
    add_blueprint(world)?;
    add_cue_sequence_and_clips(world, fixture_ref.clone())?;
    add_masters(world)?;
    add_fx(world, fixture_ref.clone())?;
    add_fx_module(world, fixture_ref.clone())?;
    add_step_fx(world, fixture_ref.clone());
    add_flow(world)?;
    add_timecode_and_timeline(world)?;
    Ok(())
}

/// Add a one-cell RGB fixture and its runtime parameter entities.
fn add_fixture(world: &mut World) -> Result<FixtureRef, String> {
    let fixture_uid = uuid(FIXTURE_UID);
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let parameters = vec![
        parameter_metadata(Attribute::VirtualIntensity, MergeStrategy::HTP, true),
        parameter_metadata(Attribute::Red, MergeStrategy::LTP, false),
        parameter_metadata(Attribute::Green, MergeStrategy::LTP, false),
        parameter_metadata(Attribute::Blue, MergeStrategy::LTP, false),
    ];
    let fixture = Fixture {
        identifiers: Identifiers {
            id: 1001,
            uid: fixture_uid,
            label: "Parser RGB Cell".to_owned(),
        },
        make: "nightfall".to_owned(),
        model: "Procedural Parser Cell".to_owned(),
        mode: "RGB".to_owned(),
        elements: vec![FixtureElement {
            label: "Cell 1".to_owned(),
            parameters: parameters.clone(),
        }],
        physical: None,
        placement: FixturePlacement {
            position: PlacementPosition {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            rotation: PlacementRotation {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        },
        layout: None,
        library_asset_etag: None,
    };

    let mut system_state: SystemState<(Commands, ResMut<FixtureDataProviderExt>)> =
        SystemState::new(world);
    let (mut commands, mut fixture_data_provider) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");
    for metadata in parameters {
        let attribute = metadata.attribute.clone();
        let values = if metadata.attribute == Attribute::VirtualIntensity {
            ParameterValues {
                default_value: 255.0,
                current_value: 255.0,
                highlight_value: 255.0,
            }
        } else {
            ParameterValues::default()
        };
        let entity = commands
            .spawn_instance(Parameter { metadata, values })
            .instance();
        fixture_data_provider.add_parameter(fixture_ref.clone(), attribute, entity);
    }
    fixture_data_provider
        .inner
        .add(fixture)
        .map_err(|error| format!("failed to add parser fixture: {error}"))?;
    system_state.apply(world);
    world
        .resource_mut::<FixtureDataProviderExt>()
        .set_color_path_default(fixture_ref.clone(), Some(ColorPathId(1)));

    Ok(fixture_ref)
}

/// Build fixture parameter metadata for the generated fixture.
fn parameter_metadata(
    attribute: Attribute,
    merge_type: MergeStrategy,
    use_grandmaster: bool,
) -> ParameterMetadata {
    ParameterMetadata {
        attribute: attribute.clone(),
        native_unit: attribute.native_unit(),
        value_polarity: attribute.value_polarity(),
        is_inverted: false,
        is_snap: false,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        merge_type,
        min: 0.0,
        resolution: DmxValueResolution::Coarse,
        use_grandmaster,
    }
}

/// Add output and disabled binding declarations.
fn add_bindings(world: &mut World, fixture_uid: Uuid) {
    world
        .resource_mut::<InputBindings>()
        .bindings
        .push(InputBinding {
            source: InputSource::Transport {
                transport: BindingTransport::Sacn,
                universe: Some(DmxRange::single(1)),
                address: Some(1),
            },
            target: InputTarget::Fixture {
                uids: vec![fixture_uid],
                element: Some(1),
                param: None,
            },
            priority: 0,
            clone: false,
        });
    world
        .resource_mut::<OutputBindings>()
        .bindings
        .push(OutputBinding {
            source: OutputSource::Fixture {
                uids: vec![fixture_uid],
                element: Some(1),
                param: None,
            },
            target: OutputTarget::Console {
                universe: Some(DmxRange::single(1)),
                address: Some(1),
            },
            priority: 0,
            clone: false,
        });
    world
        .resource_mut::<DisabledBindings>()
        .bindings
        .push(DisabledBinding::Output {
            source: OutputSource::Console {
                universe: Some(DmxRange::single(1)),
                address: Some(512),
            },
            priority: 10,
            clone: false,
        });
}

/// Add representative MIDI and OSC mappings when those showfile domains are enabled.
fn add_input_mappings(world: &mut World) {
    #[cfg(not(any(feature = "midi", feature = "osc")))]
    let _ = world;

    #[cfg(feature = "midi")]
    world
        .resource_mut::<MidiMappings>()
        .set_mappings(vec![MidiMapping {
            device_name: "Parser Grid".to_owned(),
            id: uuid::Uuid::from_u128(1),
            input: nightfall_input_midi::command::MidiBindingInput::Continuous,
            channel: 176,
            note: 36,
            velocity: None,
            action: set_control_action(1),
        }]);

    #[cfg(feature = "osc")]
    world
        .resource_mut::<OscMappings>()
        .set_mappings(vec![OscMapping {
            source: Some("127.0.0.1:9000".to_owned()),
            address: "/parser/fader".to_owned(),
            id: uuid::Uuid::new_v4(),
            input: nightfall_input_osc::command::OscBindingInput::Continuous {
                minimum: 0.0,
                maximum: 1.0,
            },
            arg_index: Some(0),
            arg_value: Some("0.5".to_owned()),
            action: set_control_action(2),
        }]);
}

/// Add a global variable referenced by the generated timeline parameter track.
fn add_global_variables(world: &mut World) {
    world
        .resource::<GlobalVariables>()
        .set("parser_intensity", VariableValue::Float(0.75));
}

/// Add a deterministic truss object to exercise persisted scene-object definitions.
fn add_scene_object(world: &mut World) -> Result<(), String> {
    world
        .resource_mut::<SceneObjectDataProvider>()
        .add(SceneObject {
            identifiers: Identifiers {
                id: 1,
                uid: uuid(SCENE_OBJECT_UID),
                label: "Parser Truss".to_owned(),
            },
            object_type: SceneObjectType::Truss,
            placement: SceneObjectPlacement::at_position(0.0, 5.0, 0.0),
            properties: SceneObjectProperties::Truss(TrussProperties::default()),
        })
        .map_err(|error| format!("failed to add parser scene object: {error}"))
}

/// Add a group containing the generated fixture.
fn add_group(world: &mut World, fixture_ref: FixtureRef) -> Result<(), String> {
    let mut system_state: SystemState<(ResMut<DataProvider<Group>>,)> = SystemState::new(world);
    let (mut group_data_provider,) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");
    group_data_provider
        .add(Group {
            identifiers: Identifiers {
                id: 1,
                uid: uuid(GROUP_UID),
                label: "Parser Group".to_owned(),
            },
            selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
            description: "Procedural showfile parser test group".to_owned(),
        })
        .map_err(|error| format!("failed to add parser group: {error}"))?;
    system_state.apply(world);
    Ok(())
}

/// Add an attribute blueprint with a concrete stored parameter value.
fn add_blueprint(world: &mut World) -> Result<(), String> {
    world
        .resource_mut::<DataProvider<Blueprint>>()
        .add(Blueprint {
            identifiers: Identifiers {
                id: 1,
                uid: uuid(BLUEPRINT_UID),
                label: "Parser Red Blueprint".to_owned(),
            },
            values: HashMap::from([(
                Attribute::Red,
                ValueSource::Inline(ParameterValue::AbsolutePercent {
                    value: Percentage::from(0.5),
                }),
            )]),
            inclusion_settings: InclusionSettings {
                inclusion_mode: InclusionMode::COPY,
                inclusion_filters: vec![FilterType::Attribute {
                    attribute: Attribute::Red,
                }],
                exclusion_filters: Vec::new(),
            },
            references: References::default(),
        })
        .map_err(|error| format!("failed to add parser blueprint: {error}"))
}

/// Add fixture-inhibition and playback-rate masters with distinct target scopes.
fn add_masters(world: &mut World) -> Result<(), String> {
    let mut system_state: SystemState<(ResMut<DataProvider<Master>>,)> = SystemState::new(world);
    let (mut master_data_provider,) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");
    master_data_provider
        .add(Master {
            identifiers: Identifiers {
                id: 1,
                uid: uuid(FIXTURE_MASTER_UID),
                label: "Parser Fixture Master".to_owned(),
            },
            kind: MasterKind::InhibitiveIntensity,
            target: MasterTarget::Fixtures(FixtureMasterTarget::All),
            mode: MasterMode::AlwaysOn,
            level_percent: 75.0,
        })
        .map_err(|error| format!("failed to add parser fixture master: {error}"))?;
    master_data_provider
        .add(Master {
            identifiers: Identifiers {
                id: 2,
                uid: uuid(PLAYBACK_MASTER_UID),
                label: "Parser Playback Master".to_owned(),
            },
            kind: MasterKind::PlaybackRate,
            target: MasterTarget::Instances(InstanceMasterTarget::Clips(vec![1])),
            mode: MasterMode::Toggle { active: true },
            level_percent: 125.0,
        })
        .map_err(|error| format!("failed to add parser playback master: {error}"))?;
    system_state.apply(world);
    Ok(())
}

/// Providers and spawn commands used to seed cue and sequence definitions.
#[derive(SystemParam)]
struct CueSequenceSeedParams<'w, 's> {
    commands: Commands<'w, 's>,
    cue_data_provider: ResMut<'w, DataProvider<Cue>>,
    seq_data_provider: ResMut<'w, DataProvider<Sequence>>,
}

/// Providers used to persist paired timecode and timeline definitions.
#[derive(SystemParam)]
struct TimelineSeedParams<'w> {
    timecode_data_provider: ResMut<'w, DataProvider<Timecode>>,
    timeline_data_provider: ResMut<'w, DataProvider<Timeline>>,
}

/// Add a cue, sequence, and clip that references the generated fixture.
fn add_cue_sequence_and_clips(world: &mut World, fixture_ref: FixtureRef) -> Result<(), String> {
    let mut system_state: SystemState<CueSequenceSeedParams> = SystemState::new(world);
    let CueSequenceSeedParams {
        mut commands,
        mut cue_data_provider,
        mut seq_data_provider,
    } = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");
    let cue_uid = uuid(CUE_UID);
    let sequence_uid = uuid(SEQUENCE_UID);

    cue_data_provider
        .add(Cue {
            identifiers: Identifiers {
                id: 1,
                uid: cue_uid,
                label: "Parser Cue".to_owned(),
            },
            trigger: CueTriggerType::Manual,
            transitions: PartialTransition {
                delay_in: Some(TransitionMode::Fixed(Duration::ZERO)),
                fade_in: Some(TransitionMode::Fixed(Duration::from_millis(500))),
                delay_out: Some(TransitionMode::Fixed(Duration::ZERO)),
                fade_out: Some(TransitionMode::Fixed(Duration::from_millis(250))),
                curve_in: Some(FadeCurve::Linear),
                curve_out: Some(FadeCurve::Linear),
            },
            instructions: vec![BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
                cue_instruction: CueInstruction {
                    values: HashMap::from([(
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: Percentage::from(1.0),
                        }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        })
        .map_err(|error| format!("failed to add parser cue: {error}"))?;
    seq_data_provider
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "Parser Sequence".to_owned(),
            },
            steps: vec![cue_uid.into()],
            wrap: true,
            setup_cue: Cue {
                identifiers: Identifiers {
                    id: 0,
                    uid: uuid(SETUP_CUE_UID),
                    label: "Parser Setup Cue".to_owned(),
                },
                ..Default::default()
            },
            release_cue: Cue {
                identifiers: Identifiers {
                    id: 0,
                    uid: uuid(RELEASE_CUE_UID),
                    label: "Parser Release Cue".to_owned(),
                },
                ..Default::default()
            },
            ..Default::default()
        })
        .map_err(|error| format!("failed to add parser sequence: {error}"))?;
    commands.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 1,
            uid: uuid(CUE_CLIP_UID),
            label: "Parser Sequence Clip".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });
    system_state.apply(world);
    Ok(())
}

/// Add a waveform FX and clip.
fn add_fx(world: &mut World, fixture_ref: FixtureRef) -> Result<(), String> {
    let mut system_state: SystemState<(Commands, ResMut<DataProvider<Fx>>)> =
        SystemState::new(world);
    let (mut commands, mut fx_data_provider) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");
    let fx_uid = uuid(FX_UID);
    fx_data_provider
        .add(Fx {
            identifiers: Identifiers {
                id: 1,
                uid: fx_uid,
                label: "Parser FX".to_owned(),
            },
            selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
            attributes: HashMap::from([(
                Attribute::VirtualIntensity,
                FxWaveform {
                    params: FxWaveformParams {
                        kind: WaveformKind::Sin,
                        min: 10.0,
                        max: 100.0,
                        duty_cycle: 1.0,
                    },
                    phase_range: (0.0, std::f32::consts::PI),
                    rate: Duration::from_secs(2),
                    width: Percentage::from(1.0),
                    is_relative: false,
                },
            )]),
        })
        .map_err(|error| format!("failed to add parser FX: {error}"))?;
    commands.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 2,
            uid: uuid(FX_CLIP_UID),
            label: "Parser FX Clip".to_owned(),
        },
        source: Some(Source::Fx(fx_uid)),
        ..Default::default()
    });
    system_state.apply(world);
    Ok(())
}

/// Add a stored FX module definition.
fn add_fx_module(world: &mut World, fixture_ref: FixtureRef) -> Result<(), String> {
    let mut system_state: SystemState<(ResMut<DataProvider<StoredFxModule>>,)> =
        SystemState::new(world);
    let (mut fx_module_data_provider,) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");
    fx_module_data_provider
        .add(StoredFxModule {
            identifiers: Identifiers {
                id: 1,
                uid: uuid(FX_MODULE_UID),
                label: "Parser FX Module".to_owned(),
            },
            module_name: "parser-test-module".to_owned(),
            selection: SpatialSelection {
                source: SelectionExpr::Resolved(vec![fixture_ref]),
                clauses: vec![SpatialClause::Grid(GridSize::Width(1))],
                union: Vec::new(),
            },
            config: HashMap::from([("level".to_owned(), "0.75".to_owned())]),
        })
        .map_err(|error| format!("failed to add parser FX module: {error}"))?;
    system_state.apply(world);
    Ok(())
}

/// Add a step FX component.
fn add_step_fx(world: &mut World, fixture_ref: FixtureRef) {
    world.spawn(StepFx {
        identifiers: Identifiers {
            id: 1,
            uid: uuid(STEP_FX_UID),
            label: "Parser Step FX".to_owned(),
        },
        selection: SpatialSelection {
            source: SelectionExpr::Resolved(vec![fixture_ref]),
            clauses: Vec::new(),
            union: Vec::new(),
        },
        timing: StepFxTiming {
            beat_duration: Duration::from_secs(4),
        },
        phase: StepFxPhase {
            waypoints: vec![0.0, 1.0],
            ..Default::default()
        },
        direction: FxDirection::Forward,
        cycle_scale: Default::default(),
        lanes: vec![FxLane {
            attribute: Attribute::Blue,
            timing_override: None,
            phase_override: None,
            absolute: Some(FxTrack {
                steps: vec![
                    FxStep {
                        uid: Uuid::from_u128(0x501),
                        target: ParameterValue::Absolute { value: 255.0 },
                        blueprint_uid: None,
                        width_beats: 0.5,
                        transition: Percentage::from(0.25).into(),
                        curve: CurveType::Linear(Linear {}),
                    },
                    FxStep {
                        uid: Uuid::from_u128(0x502),
                        target: ParameterValue::Absolute { value: 0.0 },
                        blueprint_uid: None,
                        width_beats: 0.5,
                        transition: Percentage::from(0.25).into(),
                        curve: CurveType::Snap(Snap {}),
                    },
                ],
            }),
            relative: None,
        }],
    });
}

/// Add a flow definition and clip.
fn add_flow(world: &mut World) -> Result<(), String> {
    let mut system_state: SystemState<(
        Commands,
        ResMut<DataProvider<FlowDefinition>>,
        Res<FlowNodeRegistry>,
    )> = SystemState::new(world);
    let (mut commands, mut flow_data_provider, registry) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");
    let flow_uid = uuid(FLOW_UID);
    flow_data_provider
        .add(FlowDefinition {
            identifiers: Identifiers {
                id: 1,
                uid: flow_uid,
                label: "Parser Flow".to_owned(),
            },
            flow_version: 0,
            nodes: vec![flow_node_with_defaults(
                &registry,
                1,
                flow_nodes::CONSTANT_SELECTION_KIND,
                "Parser Selection",
                &[(
                    flow_nodes::SELECTION_IN,
                    FlowValue::Selection(SelectionExpr::Group(GroupRefExpr::ById(1)).into()),
                )],
            )],
            edges: Vec::new(),
        })
        .map_err(|error| format!("failed to add parser flow: {error}"))?;
    commands.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 3,
            uid: uuid(FLOW_CLIP_UID),
            label: "Parser Flow Clip".to_owned(),
        },
        source: Some(Source::Flow(flow_uid)),
        ..Default::default()
    });
    system_state.apply(world);
    Ok(())
}

/// Build a flow node and apply default port values.
fn flow_node_with_defaults(
    registry: &FlowNodeRegistry,
    node_id: FlowNodeId,
    kind: &str,
    label: &str,
    defaults: &[(FlowPortId, FlowValue)],
) -> FlowNodeDefinition {
    let descriptor = registry
        .descriptor(kind)
        .unwrap_or_else(|| panic!("Flow node kind '{}' is not registered", kind));
    let mut node = FlowNodeDefinition {
        node_id,
        kind: kind.to_string(),
        label: label.to_string(),
        ports: descriptor.ports,
        position: None,
    };
    for (port_id, value) in defaults {
        if let Some(port) = node.ports.iter_mut().find(|port| port.port_id == *port_id) {
            port.default_value = Some(value.clone());
        }
    }
    node
}

/// Add one timecode and one timeline referencing the sequence clip.
fn add_timecode_and_timeline(world: &mut World) -> Result<(), String> {
    let timecode = Timecode {
        identifiers: Identifiers {
            id: 1,
            uid: uuid(TIMECODE_UID),
            label: "Parser Timecode".to_owned(),
        },
        rate: TimecodeRate::Fps30,
        source: TimecodeSource::Internal,
    };
    let timeline = Timeline {
        identifiers: Identifiers {
            id: 1,
            uid: uuid(TIMELINE_UID),
            label: "Parser Timeline".to_owned(),
        },
        timecode_uid: timecode.identifiers.uid,
        timecode_start: Duration::ZERO,
        audio_path: String::new(),
        audio_enabled: false,
        end_time: Some(Duration::from_secs(8)),
        trigger_mode: TimelineTriggerMode::FollowTimecode,
        seek_behavior: TimelineSeekBehavior::ReconstructState,
        nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior::Ignore,
        stop_behavior: TimelineStopBehavior::ResetAndReleaseOwnedActions,
        lookahead: TimelineLookaheadMode::Inherit,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Parser Track".to_owned(),
            actions: vec![Action {
                id: "item-1".to_owned(),
                label: "Start Parser Sequence".to_owned(),
                action: ActionKind::StartClip(uuid(CUE_CLIP_UID)),
                position: Duration::from_secs(1),
                duration: Duration::from_secs(2),
            }],
            muted: false,
            solo: false,
            expanded: true,
            automation_lanes: vec![AutomationLane {
                id: "param-1".to_owned(),
                name: "Intensity".to_owned(),
                color: "#ffffff".to_owned(),
                points: vec![
                    AutomationPoint {
                        position: Duration::ZERO,
                        value: 0.0,
                    },
                    AutomationPoint {
                        position: Duration::from_secs(2),
                        value: 1.0,
                    },
                ],
                parameter_type: ParameterType::GlobalVariable("parser_intensity".to_owned()),
            }],
        }],
        markers: Vec::new(),
        regions: Vec::new(),
        loop_range: None,
        bpm: 120.0,
        beats_per_bar: 4,
        use_beat_grid: false,
        beatgrid: None,
        scroll_mode: TimelineScrollMode::Free,
    };

    world.spawn(TimecodeGenerator {
        timecode: timecode.clone(),
        state: TimecodeState {
            timecode_id: timecode.identifiers.id,
            is_active: false,
            current_time: Duration::ZERO,
            start_time: None,
            end_time: None,
        },
        ..Default::default()
    });
    world.spawn(MaterializedTimeline::new(timeline.clone()));

    let mut system_state: SystemState<TimelineSeedParams> = SystemState::new(world);
    let TimelineSeedParams {
        mut timecode_data_provider,
        mut timeline_data_provider,
    } = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");
    timecode_data_provider
        .add(timecode)
        .map_err(|error| format!("failed to add parser timecode: {error}"))?;
    timeline_data_provider
        .add(timeline)
        .map_err(|error| format!("failed to add parser timeline: {error}"))?;
    system_state.apply(world);
    Ok(())
}

/// Parse a fixed UUID literal.
fn uuid(value: &str) -> Uuid {
    Uuid::from_str(value).expect("parser data UUID constants must be valid")
}

/// Write generated JSON to disk, creating parent directories if needed.
fn write_output(path: &Path, json: &str) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create output directory {}: {error}",
                parent.display()
            )
        })?;
    }
    fs::write(path, json)
        .map_err(|error| format!("failed to write output {}: {error}", path.display()))
}
