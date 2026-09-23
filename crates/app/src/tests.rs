// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use bevy::prelude::{App, AppExit, IntoScheduleConfigs, MessageWriter, Messages, Update};
use bevy_state::{
    app::{AppExtStates, StatesPlugin},
    prelude::State,
};
use moonshine_kind::Instance;
use nightfall::prelude::{
    Blueprint, FixtureRef, Identifiers, PartialTransition, SelectionExpr, SpatialSelection,
    TransitionMode, ValueSource,
};
use nightfall_clips::{Clip, Source};
use nightfall_compositor::prelude::ReleaseMarker;
use nightfall_config::{RuntimeConfig, TransportConfig};
use nightfall_cues::prelude::{
    BoundCueInstruction, Cue, CueInstruction, MaterializedSequence, Sequence,
};
use nightfall_desk::{
    prelude::{ToastLevel, UiNotification, UiNotificationState, set_control_action},
    resources::log_config::{LogConfig, TracingTarget},
};
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::{
    AppState, ClientOutput, ClockUpdate, CommandEnvelope, CommandNotice, CommandOrigin,
    CommandOutcome, CommandReply, CommandResult, CommandTracker, DataProvider, DmxOutput,
    EngineActionEnvelope, EventHandling, FinishedCommand, ReplyTarget, ResyncRequested,
};
use nightfall_fixtures::prelude::{
    Fixture, FixtureDataProviderExt, FixtureElement, OutputBindings, OutputSource, Parameter,
    ParameterMetadata, ParameterValues,
};
#[cfg(feature = "midi")]
use nightfall_input_midi::prelude::*;
use nightfall_instances::InstanceClock;
use nightfall_io::IoRuntimeSettings;
use nightfall_timecode::prelude::{
    Timecode, TimecodeCommand, TimecodeGenerator, TimecodeRate, TimecodeSource,
};
use nightfall_timeline::prelude::{
    Action, ActionKind, MaterializedTimeline, Timeline, TimelineAction, Track,
};
use uuid::Uuid;

use super::{
    CommandProcessingState, PendingWorldSwap, RuntimeOutputState, SwapOrchestrator, WorldBootstrap,
    WorldFactory,
    composition::{PeriodicDraftAutosaveTimer, ShowfileHandling},
    desktop_shell::{
        file_explorer_command, resolve_open_data_dir_path, resolve_open_log_file_path,
    },
    session::{
        complete_and_publish_world_swap_success, queue_current_showfile_changed,
        queue_post_swap_resync, run_world_swap_session_loop,
    },
    startup_commands::{normalize_command_input, queue_startup_command},
    world_factory::{bootstrap_world_with_fallback, initial_world_bootstrap},
};

/// Build a no-op logging configuration suitable for isolated backend tests.
fn test_log_config() -> LogConfig {
    LogConfig::new(|_| Ok(()), Arc::new(RwLock::new(TracingTarget::default())))
}

/// Returns the current backend lifecycle state for assertions.
fn lifecycle_state(app: &App) -> AppState {
    *app.world().resource::<State<AppState>>().get()
}

#[test]
fn normalize_command_input_rejects_blank_values() {
    assert_eq!(normalize_command_input(String::new()), None);
    assert_eq!(normalize_command_input("  \n\t ".to_string()), None);
}

#[test]
fn normalize_command_input_trims_values() {
    assert_eq!(
        normalize_command_input("  fps 5  ".to_string()),
        Some("fps 5".to_string())
    );
}

/// Builds a backend app through the same plugin groups used by the live application.
fn build_empty_backend_app() -> App {
    WorldFactory::new(test_log_config(), false, false, false)
        .build(WorldBootstrap::Empty {
            showfile_name: None,
        })
        .expect("empty backend app should initialize")
}

/// Creates one fixture intensity parameter and registers it with fixture lookup resources.
fn add_test_intensity_parameter(app: &mut App) -> FixtureRef {
    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let parameter_metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        ..Default::default()
    };
    let parameter = unsafe {
        Instance::<Parameter>::from_entity_unchecked(
            app.world_mut()
                .spawn(Parameter {
                    metadata: parameter_metadata.clone(),
                    values: ParameterValues::default(),
                })
                .id(),
        )
    };
    let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    fixtures
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "timeline-release-test-fixture".to_owned(),
            },
            elements: vec![FixtureElement {
                label: "main".to_owned(),
                parameters: vec![parameter_metadata],
            }],
            ..Default::default()
        })
        .expect("test fixture should be stored");
    fixtures.add_parameter(fixture_ref.clone(), Attribute::Intensity, parameter);
    fixture_ref
}

/// Builds a cue that asserts a single intensity value against the provided fixture.
fn test_intensity_cue(
    id: u32,
    label: &str,
    fixture_ref: &FixtureRef,
    value: f64,
    transitions: PartialTransition,
) -> Cue {
    Cue {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            label: label.to_owned(),
        },
        transitions,
        instructions: vec![BoundCueInstruction {
            selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![
                fixture_ref.clone(),
            ])),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Intensity,
                    ValueSource::Inline(ParameterValue::Absolute { value }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    }
}

/// Seeds a sequence-backed clip that is started by a live materialized timeline.
fn seed_timeline_started_sequence(app: &mut App) -> u32 {
    let fixture_ref = add_test_intensity_parameter(app);
    let cue = test_intensity_cue(
        1,
        "cue-1",
        &fixture_ref,
        100.0,
        PartialTransition::default(),
    );
    let cue_uid = cue.identifiers.uid;
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(cue)
        .expect("test cue should be stored");

    let sequence_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: sequence_uid,
                label: "timeline-release-test-sequence".to_owned(),
            },
            steps: vec![cue_uid.into()],
            release_cue: test_intensity_cue(
                99,
                "release",
                &fixture_ref,
                0.0,
                PartialTransition {
                    fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
                    ..Default::default()
                },
            ),
            ..Default::default()
        })
        .expect("test sequence should be stored");

    let timeline_id = 314;
    let clip_uid = Uuid::new_v4();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 31,
            uid: clip_uid,
            label: "timeline-release-test-clip".to_owned(),
        },
        source: Some(Source::Sequence(sequence_uid)),
        ..Default::default()
    });

    let timecode = Timecode {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-release-test-timecode".to_owned(),
        },
        rate: TimecodeRate::Fps30,
        source: TimecodeSource::Internal,
    };
    app.world_mut()
        .resource_mut::<DataProvider<Timecode>>()
        .add(timecode.clone())
        .expect("test timecode should be stored");
    let timecode_uid = timecode.identifiers.uid;
    app.world_mut().spawn(TimecodeGenerator::new(timecode));

    let timeline = Timeline {
        identifiers: Identifiers {
            id: timeline_id,
            uid: Uuid::new_v4(),
            label: "timeline-release-test-timeline".to_owned(),
        },
        timecode_uid,
        tracks: vec![Track {
            id: "track-1".to_owned(),
            label: "Track 1".to_owned(),
            muted: false,
            solo: false,
            expanded: false,
            actions: vec![Action {
                id: "start-sequence".to_owned(),
                label: "Start Sequence".to_owned(),
                position: Duration::from_millis(100),
                duration: Duration::ZERO,
                action: ActionKind::StartClip(clip_uid),
            }],
            automation_lanes: Vec::new(),
        }],
        ..Default::default()
    };
    app.world_mut()
        .resource_mut::<DataProvider<Timeline>>()
        .add(timeline.clone())
        .expect("test timeline should be stored");
    app.world_mut().spawn(MaterializedTimeline::new(timeline));
    app.world_mut()
        .write_message(EngineActionEnvelope::detached(TimelineAction::Start(
            timeline_id,
        )));
    app.update();
    timeline_id
}

/// Sets the only seeded timecode to a concrete transport state for timeline processing.
fn set_seeded_timecode(app: &mut App, position: Duration, active: bool) {
    let world = app.world_mut();
    let mut query = world.query::<&mut TimecodeGenerator>();
    let mut timecode = query
        .single_mut(world)
        .expect("test should seed one timecode generator");
    timecode.state.current_time = position;
    timecode.accumulated_time = position;
    timecode.state.is_active = active;
}

/// Submits a tracked timecode command through the backend's semantic ingress message.
fn submit_timecode_command(app: &mut App, command: TimecodeCommand) {
    let envelope = CommandEnvelope::new(command, CommandOrigin::Cli, ReplyTarget::Detached);
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("timecode command should register");
    app.world_mut().write_message(envelope);
}

/// Counts materialized sequence entities currently alive in the backend app.
fn materialized_sequence_count(app: &mut App) -> usize {
    app.world_mut()
        .query::<&MaterializedSequence>()
        .iter(app.world())
        .count()
}

/// Verifies a paused timeline-started sequence release clears in the live backend schedule.
#[tokio::test]
async fn live_backend_timeline_stop_clears_paused_sequence_release() {
    let mut app = build_empty_backend_app();
    let timeline_id = seed_timeline_started_sequence(&mut app);

    set_seeded_timecode(&mut app, Duration::from_millis(100), true);
    app.update();
    app.update();
    set_seeded_timecode(&mut app, Duration::from_millis(1600), true);
    app.update();
    app.update();
    assert_eq!(
        materialized_sequence_count(&mut app),
        1,
        "timeline should start one sequence playback through the backend schedule"
    );

    submit_timecode_command(&mut app, TimecodeCommand::PauseTimecode(timeline_id));
    app.update();
    app.update();
    {
        let mut clock_query = app.world_mut().query::<&InstanceClock>();
        let clock = clock_query
            .single(app.world())
            .expect("paused timeline sequence should keep one playback clock");
        assert!(
            clock.frozen,
            "paused timeline should freeze the timeline-started sequence clock"
        );
    }

    submit_timecode_command(&mut app, TimecodeCommand::StopTimecode(timeline_id));
    app.update();
    app.update();
    {
        let world = app.world_mut();
        let mut release_query = world.query::<(
            &MaterializedSequence,
            &mut ReleaseMarker,
            &mut InstanceClock,
        )>();
        let (sequence, mut release_marker, mut clock) = release_query
            .single_mut(world)
            .expect("stopped timeline sequence should enter release");
        let release_started = sequence
            .release_started_position()
            .expect("released timeline sequence should have a source-local release anchor");
        clock.position = release_started;
        clock.delta = Duration::from_millis(16);
        release_marker.start_time = Instant::now() - Duration::from_secs(10);
    }

    app.update();
    app.update();
    assert_eq!(
        materialized_sequence_count(&mut app),
        0,
        "aged paused timeline release should clear without resuming timecode"
    );
}

/// Verifies default typed configuration enables startup transport states.
#[test]
fn typed_config_defaults_to_enabled_transport_states() {
    let factory = WorldFactory::for_config(test_log_config(), RuntimeConfig::default());

    assert!(factory.transport_policy.allow_network_input);
    assert!(factory.transport_policy.allow_network_output);
    assert!(factory.transport_policy.allow_usb_output);
}

/// Verifies typed transport settings initialize panel-controlled runtime state.
#[test]
fn typed_config_sets_transport_states() {
    let runtime_config = RuntimeConfig {
        transports: TransportConfig {
            network_input_enabled: false,
            network_output_enabled: false,
            usb_output_enabled: false,
        },
        ..RuntimeConfig::default()
    };
    let factory = WorldFactory::for_config(test_log_config(), runtime_config);

    assert!(!factory.transport_policy.allow_network_input);
    assert!(!factory.transport_policy.allow_network_output);
    assert!(!factory.transport_policy.allow_usb_output);
}

/// Verifies startup transport states initialize settings without removing panel control.
#[test]
fn world_factory_build_propagates_usb_enabled_state() {
    let factory = WorldFactory::new(test_log_config(), true, true, false);

    let app = factory
        .build(WorldBootstrap::SampleData {
            showfile_name: None,
        })
        .expect("world factory build");
    let settings = app.world().resource::<IoRuntimeSettings>();

    assert!(settings.network_output_enabled);
    assert!(settings.network_input_enabled);
    assert!(!settings.usb_output_enabled);
}

/// Verifies the default backend world starts without loaded show data.
#[test]
fn world_factory_empty_bootstrap_starts_initializing_without_showfile() {
    let factory = WorldFactory::new(test_log_config(), false, false, false);

    let app = factory
        .build(WorldBootstrap::Empty {
            showfile_name: None,
        })
        .expect("empty world factory build");

    assert_eq!(lifecycle_state(&app), AppState::Initializing);
    assert_eq!(
        app.world()
            .resource::<super::systems::showfile_events::CurrentShowfile>()
            .name(),
        None
    );
}

/// Verifies named empty bootstraps are command-ready after construction.
#[test]
fn world_factory_named_empty_bootstrap_starts_ready() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().expect("create showfile root");
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::clear_active_show_data_dir();

    let factory = WorldFactory::new(test_log_config(), false, false, false);

    let app = factory
        .build(WorldBootstrap::Empty {
            showfile_name: Some("demo".to_string()),
        })
        .expect("named empty world factory build");

    assert_eq!(lifecycle_state(&app), AppState::Ready);
    assert_eq!(
        app.world()
            .resource::<super::systems::showfile_events::CurrentShowfile>()
            .name(),
        Some("demo")
    );

    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}

/// New empty and sample worlds cannot replace saved shows or previously created drafts.
#[test]
fn new_world_preserves_existing_showfiles() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().unwrap();
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::clear_active_show_data_dir();
    let factory = WorldFactory::new(test_log_config(), false, false, false);
    for parent in [root.path().to_path_buf(), root.path().join("drafts")] {
        let existing = parent.join("Tour.nightfall-show");
        std::fs::create_dir_all(&existing).unwrap();
        let snapshot = existing.join("showfile.json");
        std::fs::write(&snapshot, b"existing show contents").unwrap();
        for bootstrap in [
            WorldBootstrap::Empty {
                showfile_name: Some("Tour".to_string()),
            },
            WorldBootstrap::SampleData {
                showfile_name: Some(" tour ".to_string()),
            },
        ] {
            assert!(factory.build(bootstrap).is_err());
            assert_eq!(std::fs::read(&snapshot).unwrap(), b"existing show contents");
        }
        std::fs::remove_dir_all(existing).unwrap();
    }
    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}

/// Verifies named empty bootstraps leave a recoverable draft for restart flows.
#[test]
fn world_factory_named_empty_bootstrap_persists_initial_draft() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().expect("create showfile root");
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::clear_active_show_data_dir();

    let factory = WorldFactory::new(test_log_config(), false, false, false);
    let app = factory
        .build(WorldBootstrap::Empty {
            showfile_name: Some("test2".to_string()),
        })
        .expect("named empty world factory build");

    assert_eq!(lifecycle_state(&app), AppState::Ready);
    assert!(
        root.path()
            .join("drafts")
            .join("test2.nightfall-show")
            .join("showfile.json.gz")
            .is_file(),
        "expected initial draft snapshot for named showfile"
    );
    assert!(
        root.path()
            .join("drafts")
            .join("test2.nightfall-show")
            .join("showfile-manifest.json")
            .is_file(),
        "expected initial draft manifest for named showfile"
    );
    assert!(
        !root.path().join("test2.nightfall-show").exists(),
        "new showfile draft should not create a saved showfile"
    );

    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}

/// Verifies new-show UI notifications use the normalized active showfile name.
#[test]
fn new_showfile_current_showfile_notification_uses_normalized_name() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().expect("create showfile root");
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::clear_active_show_data_dir();

    let correlation_id = uuid::Uuid::new_v4();
    let request = PendingWorldSwap::NewShowfile {
        correlation_id,
        showfile_name: Some("demo.nightfall-show".to_string()),
        include_sample_data: false,
    };
    let factory = WorldFactory::new(test_log_config(), false, false, false);
    let mut app = factory
        .build(request.bootstrap())
        .expect("named empty world factory build");

    queue_current_showfile_changed(&mut app, &request);

    let notifications: Vec<_> = app
        .world_mut()
        .resource_mut::<UiNotificationState>()
        .take_for_resync()
        .collect();
    assert_eq!(notifications.len(), 1);
    let UiNotification::CurrentShowfileChanged { name, .. } = &notifications[0] else {
        panic!("expected current showfile changed command");
    };
    assert_eq!(name.as_deref(), Some("demo"));

    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}

/// Verifies explicit sample-data bootstraps are command-ready after construction.
#[test]
fn world_factory_sample_data_bootstrap_starts_ready() {
    let factory = WorldFactory::new(test_log_config(), false, false, false);

    let app = factory
        .build(WorldBootstrap::SampleData {
            showfile_name: None,
        })
        .expect("sample data world factory build");

    assert_eq!(lifecycle_state(&app), AppState::Ready);
}

/// Verify sample faders reference the intended clips and survive the portable snapshot path.
#[test]
fn world_factory_sample_data_seeds_fader_assignments() {
    use nightfall_desk::prelude::{ControlAssignment, Controls};
    let factory = WorldFactory::new(test_log_config(), false, false, false);
    let mut app = factory
        .build(WorldBootstrap::SampleData {
            showfile_name: None,
        })
        .expect("sample world");
    let assignments = app.world().resource::<Controls>().assignments();
    assert_eq!(
        &assignments[..5],
        &[1, 2, 26, 28, 30].map(|id| Some(ControlAssignment::Clip(id)))
    );
    assert!(assignments[5..].iter().all(Option::is_none));
    let snapshot = nightfall_showfile::snapshot_from_world(app.world_mut()).unwrap();
    for id in [1, 2, 26, 28, 30] {
        assert!(snapshot.clips.iter().any(|clip| clip.identifiers.id == id));
    }
    assert_eq!(snapshot.control_assignments, assignments);
}

/// Verifies sample startup exposes populated Color and Position Blueprints.
#[test]
fn world_factory_sample_data_bootstrap_seeds_blueprints() {
    let factory = WorldFactory::new(test_log_config(), false, false, false);
    let app = factory
        .build(WorldBootstrap::SampleData {
            showfile_name: None,
        })
        .expect("sample data world factory build");
    let blueprints = app.world().resource::<DataProvider<Blueprint>>();

    let warm_amber = blueprints.from_id(1).expect("Color Blueprint should exist");
    assert_eq!(warm_amber.identifiers.label, "Warm Amber");
    assert!(matches!(
        warm_amber.values.get(&Attribute::Red),
        Some(ValueSource::Inline(ParameterValue::AbsolutePercent { value }))
            if (value.as_f32() - 1.0).abs() < f32::EPSILON
    ));
    assert!(matches!(
        warm_amber.values.get(&Attribute::Green),
        Some(ValueSource::Inline(ParameterValue::AbsolutePercent { value }))
            if (value.as_f32() - 0.627).abs() < f32::EPSILON
    ));
    assert!(matches!(
        warm_amber.values.get(&Attribute::Blue),
        Some(ValueSource::Inline(ParameterValue::AbsolutePercent { value }))
            if (value.as_f32() - 0.094).abs() < f32::EPSILON
    ));

    let position = blueprints
        .from_id(2)
        .expect("Position Blueprint should exist");
    assert_eq!(position.identifiers.label, "Pan 25 Tilt 75");
    assert!(matches!(
        position.values.get(&Attribute::Pan),
        Some(ValueSource::Inline(ParameterValue::AbsolutePercent { value }))
            if (value.as_f32() - 0.25).abs() < f32::EPSILON
    ));
    assert!(matches!(
        position.values.get(&Attribute::Tilt),
        Some(ValueSource::Inline(ParameterValue::AbsolutePercent { value }))
            if (value.as_f32() - 0.75).abs() < f32::EPSILON
    ));
}

/// Verifies normal process startup does not implicitly load the saved default showfile.
#[test]
fn initial_world_bootstrap_defaults_to_empty_world() {
    assert_eq!(
        initial_world_bootstrap(false),
        WorldBootstrap::Empty {
            showfile_name: None,
        }
    );
}

/// Verifies explicit sample-data startup remains available for development fixtures.
#[test]
fn initial_world_bootstrap_can_seed_sample_data_explicitly() {
    assert_eq!(
        initial_world_bootstrap(true),
        WorldBootstrap::SampleData {
            showfile_name: None
        }
    );
}

/// Verifies the open-data helper creates the typed configured directory.
#[test]
fn resolve_open_data_dir_path_creates_configured_directory() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let temp_root = std::env::temp_dir().join(format!(
        "nightfall-open-data-dir-test-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let override_dir = temp_root.join("data-root");

    nightfall::set_nightfall_data_dir(Some(override_dir.clone()));

    let resolved = resolve_open_data_dir_path().expect("resolve open data dir path");
    assert_eq!(resolved, override_dir);
    assert!(
        resolved.is_dir(),
        "expected created directory at {}",
        resolved.display()
    );

    nightfall::set_nightfall_data_dir(None);
    std::fs::remove_dir_all(&temp_root).expect("cleanup temp root");
}

/// Verifies the open-log helper uses the application log filename.
#[test]
fn resolve_open_log_file_path_uses_application_log_name() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let temp_root = std::env::temp_dir().join(format!(
        "nightfall-open-log-path-test-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let override_dir = temp_root.join("data-root");

    nightfall::set_nightfall_data_dir(Some(override_dir.clone()));

    let resolved = resolve_open_log_file_path().expect("resolve open log file path");
    assert_eq!(resolved, override_dir.join("nightfall.log"));
    assert!(
        override_dir.is_dir(),
        "expected log parent directory to exist"
    );

    nightfall::set_nightfall_data_dir(None);
    std::fs::remove_dir_all(&temp_root).expect("cleanup temp root");
}

#[test]
fn file_explorer_command_matches_current_platform() {
    let path = Path::new("test-dir");
    let (program, args) = file_explorer_command(path).expect("file explorer command");

    #[cfg(target_os = "windows")]
    assert_eq!(program, "explorer.exe");
    #[cfg(target_os = "macos")]
    assert_eq!(program, "open");
    #[cfg(target_os = "linux")]
    assert_eq!(program, "xdg-open");

    assert_eq!(args, vec![path.as_os_str().to_owned()]);
}

#[cfg(not(target_os = "windows"))]
#[test]
/// Preserve the log path as one argument to the platform file launcher.
fn file_open_command_matches_current_platform() {
    let path = Path::new("test-log.txt");
    let (program, args) = crate::desktop_shell::file_open_command(path).expect("file open command");

    #[cfg(target_os = "macos")]
    assert_eq!(program, "open");
    #[cfg(target_os = "linux")]
    assert_eq!(program, "xdg-open");

    assert_eq!(args, vec![path.as_os_str().to_owned()]);
}

#[cfg(not(target_os = "windows"))]
#[test]
/// Preserve the complete external URL as one argument to the platform browser launcher.
fn url_open_command_matches_current_platform() {
    let url = "https://github.com/example/project/issues/new?title=Bug%20report&body=Details%0AUnicode%20%E2%9C%93";
    let (program, args) = crate::desktop_shell::url_open_command(url).expect("url open command");

    #[cfg(target_os = "macos")]
    assert_eq!(program, "open");
    #[cfg(target_os = "linux")]
    assert_eq!(program, "xdg-open");

    assert_eq!(args, vec![std::ffi::OsString::from(url)]);
}

#[test]
fn world_factory_build_propagates_network_enabled_states() {
    let factory = WorldFactory::new(test_log_config(), false, true, true);

    let app = factory
        .build(WorldBootstrap::SampleData {
            showfile_name: None,
        })
        .expect("world factory build");
    let settings = app.world().resource::<IoRuntimeSettings>();
    assert!(!settings.network_output_enabled);
    assert!(settings.network_input_enabled);
    assert!(settings.usb_output_enabled);
}

/// Verifies the inner wash arc is seeded with output disabled even when transports are enabled.
#[test]
fn sample_data_build_seeds_rotating_wash_beam_with_disabled_output() {
    let factory = WorldFactory::new(test_log_config(), false, false, true);

    let app = factory
        .build(WorldBootstrap::SampleData {
            showfile_name: None,
        })
        .expect("world factory build");
    let fixture_provider = app.world().resource::<FixtureDataProviderExt>();
    let fixture = fixture_provider
        .inner
        .iter()
        .find(|fixture| fixture.identifiers.id == 1010)
        .expect("sample data should include Generic wash beam");

    assert_eq!(fixture.make, "Generic");
    assert_eq!(fixture.model, "12-segment Rotating Wash Beam");
    assert_eq!(fixture.elements.len(), 37);
    assert_eq!(fixture.placement.position.x, -2.25);
    assert_eq!(fixture.placement.position.y, 0.25);
    assert_eq!(fixture.placement.position.z, -2.5);

    assert!(app.world().resource::<OutputBindings>().bindings.is_empty());
    let disabled = app
        .world()
        .resource::<nightfall_fixtures::prelude::DisabledBindings>();
    assert_eq!(disabled.bindings.len(), 56);
    assert!(disabled.bindings.iter().any(|binding| matches!(binding,
        nightfall_fixtures::prelude::DisabledBinding::Output {
            source: OutputSource::Fixture { uids, .. }, ..
        } if uids.contains(&fixture.identifiers.uid)
    )));
}

/// Verifies fixture 601 white output is scaled by its virtual dimmer.
#[tokio::test]
async fn sample_data_fixture_601_white_output_follows_virtual_dimmer() {
    let factory = WorldFactory::new(test_log_config(), false, false, true);

    let mut app = factory
        .build(WorldBootstrap::SampleData {
            showfile_name: None,
        })
        .expect("world factory build");
    let fixture_uid = {
        let fixture_provider = app.world().resource::<FixtureDataProviderExt>();
        fixture_provider
            .inner
            .iter()
            .find(|fixture| fixture.identifiers.id == 601)
            .expect("sample data should include fixture 601")
            .identifiers
            .uid
    };
    let first_white_element = FixtureRef {
        fixture_uid,
        index: Some(4),
    };

    queue_startup_command(&mut app, "test", "fix 601 white @ 100 int @ 100".to_owned());
    for _ in 0..10 {
        app.update();
    }

    let first_white_value = {
        let fixture_provider = app.world().resource::<FixtureDataProviderExt>();
        let white_parameter = fixture_provider
            .try_parameter_for_element_attribute(&first_white_element, &Attribute::White)
            .expect("fixture 601 first strobe dimmer should expose white");
        app.world()
            .get::<Parameter>(white_parameter.entity())
            .expect("white parameter entity should exist")
            .values
            .current_value
    };
    assert_eq!(
        first_white_value, 255.0,
        "fixture 601 first white channel should reach full output"
    );

    queue_startup_command(&mut app, "test", "fix 601 white @ 100 int @ 0".to_owned());
    for _ in 0..10 {
        app.update();
    }

    let first_white_value = {
        let fixture_provider = app.world().resource::<FixtureDataProviderExt>();
        let white_parameter = fixture_provider
            .try_parameter_for_element_attribute(&first_white_element, &Attribute::White)
            .expect("fixture 601 first strobe dimmer should expose white");
        app.world()
            .get::<Parameter>(white_parameter.entity())
            .expect("white parameter entity should exist")
            .values
            .current_value
    };
    assert_eq!(
        first_white_value, 0.0,
        "fixture 601 first white channel should be scaled by virtual dimmer"
    );
}

/// Verifies an element-level virtual dimmer edit overrides a broader fixture intensity assertion.
#[tokio::test]
async fn sample_data_element_virtual_dimmer_overrides_parent_fixture_intensity() {
    let factory = WorldFactory::new(test_log_config(), false, false, true);

    let mut app = factory
        .build(WorldBootstrap::SampleData {
            showfile_name: None,
        })
        .expect("world factory build");
    let fixture_uid = {
        let fixture_provider = app.world().resource::<FixtureDataProviderExt>();
        fixture_provider
            .inner
            .iter()
            .find(|fixture| fixture.identifiers.id == 601)
            .expect("sample data should include fixture 601")
            .identifiers
            .uid
    };
    let first_white_element = FixtureRef {
        fixture_uid,
        index: Some(4),
    };

    queue_startup_command(&mut app, "test", "fix 601 white @ 100 int @ 100".to_owned());
    for _ in 0..10 {
        app.update();
    }

    queue_startup_command(&mut app, "test", "fix 601.4 int @ 80".to_owned());
    for _ in 0..10 {
        app.update();
    }

    let element_vdim_value = {
        let fixture_provider = app.world().resource::<FixtureDataProviderExt>();
        let vdim_parameter = fixture_provider
            .try_parameter_for_element_attribute(&first_white_element, &Attribute::VirtualIntensity)
            .expect("fixture 601 first strobe dimmer should expose virtual intensity");
        app.world()
            .get::<Parameter>(vdim_parameter.entity())
            .expect("virtual intensity parameter entity should exist")
            .values
            .current_value
    };
    assert!(
        (element_vdim_value - 204.0).abs() < f64::EPSILON,
        "element virtual intensity should be 80%, got {element_vdim_value}"
    );
}

/// Verifies wash-beam LED strip elements expose virtual dimmers for visualizer output.
#[tokio::test]
async fn sample_data_generic_strip_element_intensity_scales_red_output() {
    let factory = WorldFactory::new(test_log_config(), false, false, true);

    let mut app = factory
        .build(WorldBootstrap::SampleData {
            showfile_name: None,
        })
        .expect("world factory build");
    let fixture_uid = {
        let fixture_provider = app.world().resource::<FixtureDataProviderExt>();
        fixture_provider
            .inner
            .iter()
            .find(|fixture| fixture.identifiers.id == 1010)
            .expect("sample data should include fixture 1010")
            .identifiers
            .uid
    };
    let first_top_strip_pixel = FixtureRef {
        fixture_uid,
        index: Some(14),
    };
    let last_top_strip_pixel = FixtureRef {
        fixture_uid,
        index: Some(25),
    };

    queue_startup_command(
        &mut app,
        "test",
        "fix 1010.(14>25) red @ 100 int @ 0".to_owned(),
    );
    for _ in 0..10 {
        app.update();
    }

    let red_at_zero_intensity_start = {
        let fixture_provider = app.world().resource::<FixtureDataProviderExt>();
        let red_parameter = fixture_provider
            .try_parameter_for_element_attribute(&first_top_strip_pixel, &Attribute::Red)
            .expect("fixture 1010 top strip pixel should expose red");
        app.world()
            .get::<Parameter>(red_parameter.entity())
            .expect("red parameter entity should exist")
            .values
            .current_value
    };
    let red_at_zero_intensity_end = {
        let fixture_provider = app.world().resource::<FixtureDataProviderExt>();
        let red_parameter = fixture_provider
            .try_parameter_for_element_attribute(&last_top_strip_pixel, &Attribute::Red)
            .expect("fixture 1010 top strip pixel should expose red");
        app.world()
            .get::<Parameter>(red_parameter.entity())
            .expect("red parameter entity should exist")
            .values
            .current_value
    };
    assert_eq!(
        red_at_zero_intensity_start, 0.0,
        "first strip red output should be scaled down by element virtual intensity"
    );
    assert_eq!(
        red_at_zero_intensity_end, 0.0,
        "last strip red output should be scaled down by element virtual intensity"
    );

    queue_startup_command(
        &mut app,
        "test",
        "fix 1010.(14>25) int @ 100 red @ 100".to_owned(),
    );
    for _ in 0..10 {
        app.update();
    }

    let vdim_at_full_intensity_start = {
        let fixture_provider = app.world().resource::<FixtureDataProviderExt>();
        let vdim_parameter = fixture_provider
            .try_parameter_for_logical_attribute(&first_top_strip_pixel, &Attribute::Intensity)
            .expect("fixture 1010 top strip pixel should resolve intensity to virtual dimmer");
        app.world()
            .get::<Parameter>(vdim_parameter.instance.entity())
            .expect("virtual intensity parameter entity should exist")
            .values
            .current_value
    };
    assert_eq!(
        vdim_at_full_intensity_start, 255.0,
        "first strip should hold a full element virtual intensity value"
    );

    let red_at_full_intensity_start = {
        let fixture_provider = app.world().resource::<FixtureDataProviderExt>();
        let red_parameter = fixture_provider
            .try_parameter_for_element_attribute(&first_top_strip_pixel, &Attribute::Red)
            .expect("fixture 1010 top strip pixel should expose red");
        app.world()
            .get::<Parameter>(red_parameter.entity())
            .expect("red parameter entity should exist")
            .values
            .current_value
    };
    let red_at_full_intensity_end = {
        let fixture_provider = app.world().resource::<FixtureDataProviderExt>();
        let red_parameter = fixture_provider
            .try_parameter_for_element_attribute(&last_top_strip_pixel, &Attribute::Red)
            .expect("fixture 1010 top strip pixel should expose red");
        app.world()
            .get::<Parameter>(red_parameter.entity())
            .expect("red parameter entity should exist")
            .values
            .current_value
    };
    assert_eq!(
        red_at_full_intensity_start, 255.0,
        "first strip red output should be visible when element virtual intensity is full"
    );
    assert_eq!(
        red_at_full_intensity_end, 255.0,
        "last strip red output should be visible when element virtual intensity is full"
    );
}

#[cfg(feature = "midi")]
#[test]
fn sample_data_build_seeds_default_midi_mapping() {
    let factory = WorldFactory::new(test_log_config(), false, false, true);

    let app = factory
        .build(WorldBootstrap::SampleData {
            showfile_name: None,
        })
        .expect("world factory build");
    let mappings = app.world().resource::<MidiMappings>().mappings();

    assert!(mappings.iter().any(|mapping| {
        mapping.device_name == "Grid"
            && mapping.channel == 176
            && mapping.note == 36
            && mapping.velocity.is_none()
            && mapping.action == set_control_action(1)
    }));
}

/// Test resource used to count update frames run by `WorldFactory::warm_up`.
#[derive(bevy::prelude::Resource)]
struct TickCounter(usize);

#[test]
fn world_factory_warm_up_runs_requested_updates() {
    let factory = WorldFactory::new(test_log_config(), false, false, true);

    let mut app = App::new();
    app.insert_resource(TickCounter(0));
    app.add_systems(Update, |mut counter: bevy::prelude::ResMut<TickCounter>| {
        counter.0 += 1;
    });

    factory.warm_up(&mut app, 3);
    let counter = app.world().resource::<TickCounter>();
    assert_eq!(counter.0, 3);
}

#[test]
fn bootstrap_world_with_fallback_uses_sample_data_after_showfile_error() {
    let mut attempts = Vec::new();
    let (_app, ui_notifications) = bootstrap_world_with_fallback(
        |bootstrap| {
            attempts.push(bootstrap.clone());
            match bootstrap {
                WorldBootstrap::Empty { .. } => Ok(App::new()),
                WorldBootstrap::Showfile { .. } => Err("missing showfile".to_string()),
                WorldBootstrap::SampleData { .. } => Ok(App::new()),
            }
        },
        WorldBootstrap::Showfile {
            name: None,
            source: std::path::PathBuf::from("default.nightfall-show"),
        },
    )
    .expect("bootstrap with fallback");

    assert_eq!(
        attempts,
        vec![
            WorldBootstrap::Showfile {
                name: None,
                source: std::path::PathBuf::from("default.nightfall-show"),
            },
            WorldBootstrap::SampleData {
                showfile_name: None
            }
        ]
    );
    assert_eq!(ui_notifications.len(), 1);
    assert!(matches!(
        &ui_notifications[0],
        UiNotification::ShowToast {
            level: ToastLevel::Error,
            message,
        } if message.contains("missing showfile")
            && message.contains("loaded sample data instead")
    ));
}

#[test]
fn bootstrap_world_with_fallback_reports_secondary_failure() {
    let mut attempts = Vec::new();
    let error = bootstrap_world_with_fallback(
        |bootstrap| {
            attempts.push(bootstrap.clone());
            match bootstrap {
                WorldBootstrap::Empty { .. } => Ok(App::new()),
                WorldBootstrap::Showfile { .. } => Err("bad showfile".to_string()),
                WorldBootstrap::SampleData { .. } => Err("sample data unavailable".to_string()),
            }
        },
        WorldBootstrap::Showfile {
            name: None,
            source: std::path::PathBuf::from("default.nightfall-show"),
        },
    )
    .expect_err("fallback should fail when sample data bootstrap fails");

    assert_eq!(
        attempts,
        vec![
            WorldBootstrap::Showfile {
                name: None,
                source: std::path::PathBuf::from("default.nightfall-show"),
            },
            WorldBootstrap::SampleData {
                showfile_name: None
            }
        ]
    );
    assert!(error.contains("bad showfile"), "unexpected error: {error}");
    assert!(
        error.contains("sample data unavailable"),
        "unexpected error: {error}"
    );
}

#[test]
fn world_swap_runner_returns_on_app_exit() {
    let factory = WorldFactory::new(test_log_config(), false, false, true);
    let mut app = App::new();
    app.add_systems(Update, |mut app_exit: MessageWriter<AppExit>| {
        app_exit.write(AppExit::Success);
    });

    let exit = run_world_swap_session_loop(app, factory);
    assert!(matches!(exit, AppExit::Success));
}

#[test]
fn queue_post_swap_resync_emits_resync_request() {
    let mut app = App::new();
    app.add_message::<ResyncRequested>();

    queue_post_swap_resync(&mut app);

    let messages: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<ResyncRequested>>()
        .drain()
        .collect();
    assert_eq!(messages.len(), 1);
    assert!(messages[0].command_id.is_none());
}

#[test]
fn world_swap_success_emits_command_result_for_original_request() {
    let correlation_id = uuid::Uuid::new_v4();
    let request = PendingWorldSwap::LoadShowfile {
        correlation_id,
        showfile_name: Some("demo".to_string()),
        source: std::path::PathBuf::from("default.nightfall-show"),
    };
    let mut app = App::new();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.init_resource::<CommandTracker>();
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            correlation_id.into(),
            correlation_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::ClientBroadcast,
        )
        .expect("world swap command should register");

    complete_and_publish_world_swap_success(&mut app, &request);

    let messages: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].command_id, correlation_id.into());
    assert!(matches!(
        messages[0].outcome,
        CommandOutcome::Succeeded { .. }
    ));
}

#[test]
fn staged_world_keeps_runtime_states_paused_until_commit() {
    let factory = WorldFactory::new(test_log_config(), false, false, true);
    let active_app = factory
        .build(WorldBootstrap::SampleData {
            showfile_name: None,
        })
        .expect("active app build");
    let orchestrator = SwapOrchestrator::new(active_app);

    let staged_app = orchestrator
        .stage_world(
            &factory,
            WorldBootstrap::SampleData {
                showfile_name: None,
            },
            0,
        )
        .expect("staged app build");
    let command_state = staged_app
        .world()
        .resource::<State<CommandProcessingState>>();
    assert_eq!(*command_state.get(), CommandProcessingState::Paused);
    let output_state = staged_app.world().resource::<State<RuntimeOutputState>>();
    assert_eq!(*output_state.get(), RuntimeOutputState::Paused);
}

/// Test resource used to verify client output systems obey runtime pause state.
#[derive(bevy::prelude::Resource, Default)]
struct ClientOutputTickCounter(usize);

fn tick_client_output_counter(mut counter: bevy::prelude::ResMut<ClientOutputTickCounter>) {
    counter.0 += 1;
}

/// Test resource that records system-set execution order within one update.
#[derive(bevy::prelude::Resource, Default)]
struct HandlingOrderLog(Vec<&'static str>);

/// Verifies periodic draft autosave waits for the full configured interval.
#[test]
fn periodic_draft_autosave_timer_waits_for_one_minute() {
    let mut timer = PeriodicDraftAutosaveTimer::default();

    assert!(!timer.tick(Duration::from_secs(59)));
    assert!(timer.tick(Duration::from_secs(1)));
}

/// Verifies periodic draft autosave repeats after each configured interval.
#[test]
fn periodic_draft_autosave_timer_repeats_after_interval() {
    let mut timer = PeriodicDraftAutosaveTimer::default();

    assert!(timer.tick(Duration::from_secs(60)));
    assert!(!timer.tick(Duration::from_secs(30)));
    assert!(timer.tick(Duration::from_secs(30)));
}

/// Ensures showfile commands collect snapshots after same-frame domain mutations.
#[test]
fn showfile_handling_runs_after_event_handling() {
    let mut app = App::new();
    app.add_plugins(StatesPlugin);
    app.insert_state(CommandProcessingState::Running);
    app.insert_state(RuntimeOutputState::Running);
    app.insert_resource(HandlingOrderLog::default());
    app.configure_sets(
        Update,
        (
            EventHandling.run_if(bevy_state::condition::in_state(
                super::CommandProcessingState::Running,
            )),
            ShowfileHandling
                .run_if(bevy_state::condition::in_state(
                    super::CommandProcessingState::Running,
                ))
                .after(EventHandling)
                .before(ClockUpdate),
        ),
    );
    app.add_systems(
        Update,
        (
            (|mut log: bevy::prelude::ResMut<HandlingOrderLog>| {
                log.0.push("event");
            })
            .in_set(EventHandling),
            (|mut log: bevy::prelude::ResMut<HandlingOrderLog>| {
                log.0.push("showfile");
            })
            .in_set(ShowfileHandling),
        ),
    );

    app.update();

    let log = app.world().resource::<HandlingOrderLog>();
    assert_eq!(log.0, vec!["event", "showfile"]);
}

#[test]
fn client_output_set_respects_runtime_output_state() {
    let mut app = App::new();
    app.add_plugins(StatesPlugin);
    app.insert_state(CommandProcessingState::Running);
    app.insert_state(RuntimeOutputState::Paused);
    app.insert_resource(ClientOutputTickCounter::default());
    app.configure_sets(
        Update,
        ClientOutput.run_if(bevy_state::condition::in_state(RuntimeOutputState::Running)),
    );
    app.add_systems(Update, tick_client_output_counter.in_set(ClientOutput));

    app.update();
    let counter = app.world().resource::<ClientOutputTickCounter>();
    assert_eq!(counter.0, 0);

    app.insert_state(RuntimeOutputState::Running);
    app.update();
    let counter = app.world().resource::<ClientOutputTickCounter>();
    assert_eq!(counter.0, 1);
}

/// Test resource used to verify DMX output systems obey runtime pause state.
#[derive(bevy::prelude::Resource, Default)]
struct DmxTickCounter(usize);

fn tick_dmx_counter(mut counter: bevy::prelude::ResMut<DmxTickCounter>) {
    counter.0 += 1;
}

#[test]
fn dmx_output_set_respects_runtime_output_state() {
    let mut app = App::new();
    app.add_plugins(StatesPlugin);
    app.insert_state(CommandProcessingState::Running);
    app.insert_state(RuntimeOutputState::Paused);
    app.insert_resource(DmxTickCounter::default());
    app.configure_sets(
        Update,
        DmxOutput.run_if(bevy_state::condition::in_state(RuntimeOutputState::Running)),
    );
    app.add_systems(Update, tick_dmx_counter.in_set(DmxOutput));

    app.update();
    let counter = app.world().resource::<DmxTickCounter>();
    assert_eq!(counter.0, 0);

    app.insert_state(RuntimeOutputState::Running);
    app.update();
    let counter = app.world().resource::<DmxTickCounter>();
    assert_eq!(counter.0, 1);
}

/// Ensures the default rig contains the six built-in fixture families and serializable layouts.
#[test]
fn sample_fixtures_are_generic_and_self_contained() {
    let factory = WorldFactory::new(test_log_config(), false, false, true);
    let app = factory
        .build(WorldBootstrap::SampleData {
            showfile_name: None,
        })
        .expect("sample world");
    let provider = app.world().resource::<FixtureDataProviderExt>();
    for fixture in provider.inner.iter() {
        assert_eq!(
            fixture.make, "Generic",
            "fixture {}",
            fixture.identifiers.id
        );
        assert!(
            fixture.layout.is_some(),
            "fixture {} lacks a layout",
            fixture.identifiers.id
        );
        let text = format!("{} {}", fixture.model, fixture.identifiers.label).to_lowercase();
        for brand in ["valava", "yuer", "martin", "chauvet"] {
            assert!(
                !text.contains(brand),
                "fixture {} contains {brand}",
                fixture.identifiers.id
            );
        }
    }
    assert_eq!(provider.inner.iter().count(), 56);
    for (id, count) in [
        (310, 40),
        (501, 1),
        (601, 115),
        (602, 119),
        (1004, 72),
        (1010, 37),
    ] {
        let fixture = provider
            .inner
            .iter()
            .find(|fixture| fixture.identifiers.id == id)
            .expect("built-in sample fixture");
        assert_eq!(fixture.elements.len(), count);
        let serialized = serde_json::to_string(&fixture).unwrap();
        let restored: nightfall_fixtures::fixture::Fixture =
            serde_json::from_str(&serialized).unwrap();
        assert_eq!(restored.layout, fixture.layout);
    }
}

/// Creates and reloads a complete sample draft with no installed fixture or media assets.
#[test]
fn named_sample_show_is_standalone_and_recoverable() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().expect("empty data root");
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::clear_active_show_data_dir();

    let factory = WorldFactory::new(test_log_config(), false, false, false);
    let request = PendingWorldSwap::NewShowfile {
        correlation_id: Uuid::new_v4(),
        showfile_name: Some("Sample Tour.nightfall-show".to_string()),
        include_sample_data: true,
    };
    let mut app = factory
        .build(request.bootstrap())
        .expect("create named sample show");
    assert_eq!(lifecycle_state(&app), AppState::Ready);
    assert_eq!(
        app.world()
            .resource::<super::systems::showfile_events::CurrentShowfile>()
            .name(),
        Some("Sample Tour")
    );
    assert!(
        app.world_mut()
            .query::<&TimecodeGenerator>()
            .iter(app.world())
            .all(|generator| !generator.state.is_active)
    );
    let draft = root.path().join("drafts/Sample Tour.nightfall-show");
    let snapshot = crate::systems::showfile_events::read_showfile_snapshot_from_path(&draft)
        .expect("decode sample draft");
    assert!(!snapshot.fixtures.is_empty());
    assert!(!snapshot.cues.is_empty());
    assert!(!snapshot.clips.is_empty());
    assert!(!snapshot.timelines.is_empty());
    assert!(
        snapshot
            .fixtures
            .iter()
            .all(|fixture| fixture.library_asset_etag.is_none())
    );
    assert_eq!(snapshot.timelines.len(), 2);
    for (timeline, asset) in snapshot
        .timelines
        .iter()
        .zip(crate::sample_data::SAMPLE_AUDIO)
    {
        assert!(timeline.audio_enabled);
        assert_eq!(timeline.audio_path, asset.relative_path);
        assert_eq!(
            std::fs::read(draft.join(&timeline.audio_path)).expect("installed bundled audio"),
            std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("assets/sample-audio")
                    .join(asset.filename)
            )
            .expect("source audio")
        );
    }
    assert!(
        snapshot.fx_module.is_empty(),
        "sample effects must not require installed WASM modules"
    );
    assert_eq!(snapshot.scene_objects.len(), 3);
    assert!(
        snapshot.scene_objects.iter().all(|object| matches!(
            &object.properties,
            nightfall_scene_objects::SceneObjectProperties::StageElement(properties)
                if properties.model_path.is_empty()
        )),
        "sample stage must use built-in primitives"
    );
    assert!(snapshot.bindings.output.is_empty());
    assert_eq!(snapshot.bindings.disabled.len(), 56);

    // Resolve every programmed selection against the generated inventory, including cue parts.
    let mut selections: Vec<_> = snapshot
        .groups
        .iter()
        .map(|group| group.selection.clone())
        .collect();
    selections.extend(snapshot.fx.iter().map(|fx| fx.selection.clone()));
    selections.extend(snapshot.step_fx.iter().map(|fx| fx.selection.clone()));
    for cue in &snapshot.cues {
        selections.extend(
            cue.clone()
                .flatten_instructions()
                .instructions
                .into_iter()
                .map(|instruction| instruction.selection),
        );
    }
    for flow in &snapshot.flows {
        for node in &flow.nodes {
            for port in &node.ports {
                if let Some(nightfall_flow::prelude::FlowValue::Selection(selection)) =
                    &port.default_value
                {
                    // Connected flow inputs use an empty fallback until their upstream node supplies a selection.
                    if selection != &SpatialSelection::default() {
                        selections.push(selection.clone());
                    }
                }
            }
        }
    }
    let mut state = bevy::ecs::system::SystemState::<
        nightfall_fixtures::prelude::SpatialSelectionResolver,
    >::new(app.world_mut());
    let resolver = state.get(app.world()).expect("selection resolver");
    let strobe_uids: std::collections::BTreeSet<_> = snapshot
        .fixtures
        .iter()
        .filter(|fixture| {
            (601..=606).contains(&fixture.identifiers.id)
                || (1004..=1009).contains(&fixture.identifiers.id)
        })
        .map(|fixture| fixture.identifiers.uid)
        .collect();
    for cue in snapshot.cues.iter().filter(|cue| {
        [
            "Red 100%",
            "Red Fade Out",
            "Green 100%",
            "Green Fade Out",
            "Blue 100%",
            "Blue Fade Out",
        ]
        .contains(&cue.identifiers.label.as_str())
    }) {
        for instruction in &cue.instructions {
            let selected: std::collections::BTreeSet<_> = resolver
                .resolve(&instruction.selection)
                .value
                .canonical
                .into_iter()
                .map(|fixture| fixture.fixture_uid)
                .collect();
            assert_eq!(
                selected, strobe_uids,
                "{} must target all strobes",
                cue.identifiers.label
            );
        }
    }
    let fanned_cue = snapshot
        .cues
        .iter()
        .find(|cue| cue.identifiers.id == 30)
        .expect("cue 30.30");
    assert_eq!(
        fanned_cue.instructions[0]
            .cue_instruction
            .values
            .get(&Attribute::Tilt),
        Some(&ValueSource::Inline(ParameterValue::AbsolutePercent {
            value: (-0.3).into()
        }))
    );
    for selection in selections {
        let resolved = resolver.resolve(&selection);
        assert!(
            !resolved.is_partial(),
            "sample selection {selection:?}: {:?}",
            resolved.issues
        );
        assert!(
            !resolved.value.canonical.is_empty(),
            "sample selection must not be empty: {selection:?}"
        );
    }
    assert!(!root.path().join("Sample Tour.nightfall-show").exists());
    let fixture_count = snapshot.fixtures.len();
    drop(app);
    nightfall::clear_active_show_data_dir();
    let recovered = factory
        .build(WorldBootstrap::Showfile {
            name: Some("Sample Tour".to_string()),
            source: draft,
        })
        .expect("recover standalone sample draft");
    assert_eq!(
        recovered
            .world()
            .resource::<FixtureDataProviderExt>()
            .inner
            .iter()
            .count(),
        fixture_count
    );
    assert_eq!(
        recovered
            .world()
            .resource::<DataProvider<Timeline>>()
            .iter()
            .count(),
        snapshot.timelines.len()
    );
    assert_eq!(
        recovered
            .world()
            .resource::<nightfall_scene_objects::prelude::SceneObjectDataProvider>()
            .iter()
            .count(),
        3
    );
    assert!(
        recovered
            .world()
            .resource::<OutputBindings>()
            .bindings
            .is_empty()
    );
    for asset in crate::sample_data::SAMPLE_AUDIO {
        assert_eq!(
            std::fs::read(
                nightfall::active_show_data_dir()
                    .unwrap()
                    .join(asset.relative_path)
            )
            .expect("recovered bundled audio"),
            std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("assets/sample-audio")
                    .join(asset.filename)
            )
            .expect("source audio")
        );
    }
    drop(recovered);
    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}

/// Installs bundled audio for unnamed CLI/fallback samples before the runtime starts.
#[test]
fn unnamed_sample_show_installs_bundled_audio_before_runtime() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().expect("empty sample data root");
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::clear_active_show_data_dir();
    let factory = WorldFactory::new(test_log_config(), false, false, false);
    let mut app = factory
        .build(WorldBootstrap::SampleData {
            showfile_name: None,
        })
        .expect("in-memory sample world");
    assert!(!root.path().join("drafts/default.nightfall-show").exists());
    crate::world_factory::persist_pending_sample_draft(&mut app)
        .expect("install runtime sample assets");
    let draft = root.path().join("drafts/default.nightfall-show");
    assert!(draft.join("showfile.json.gz").is_file());
    for asset in crate::sample_data::SAMPLE_AUDIO {
        assert_eq!(
            std::fs::read(draft.join(asset.relative_path)).expect("installed sample audio"),
            std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("assets/sample-audio")
                    .join(asset.filename)
            )
            .expect("source audio")
        );
    }
    drop(app);
    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}

/// External resource updates affect new shows without altering existing show-owned audio.
#[test]
fn sample_audio_resources_can_change_without_recompilation() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().unwrap();
    let resources = tempfile::tempdir().unwrap();
    let audio = resources.path().join("sample-audio");
    std::fs::create_dir(&audio).unwrap();
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::clear_active_show_data_dir();
    let config = RuntimeConfig {
        resource_dir: Some(resources.path().to_path_buf()),
        ..RuntimeConfig::default()
    };
    let factory = WorldFactory::for_config(test_log_config(), config);
    for name in ["First", "Second"] {
        for asset in crate::sample_data::SAMPLE_AUDIO {
            std::fs::write(
                audio.join(asset.filename),
                format!("ID3 {name} {}", asset.filename),
            )
            .unwrap();
        }
        factory
            .build(WorldBootstrap::SampleData {
                showfile_name: Some(name.to_string()),
            })
            .unwrap();
    }
    for name in ["First", "Second"] {
        for asset in crate::sample_data::SAMPLE_AUDIO {
            assert_eq!(
                std::fs::read(
                    root.path()
                        .join(format!("drafts/{name}.nightfall-show"))
                        .join(asset.relative_path)
                )
                .unwrap(),
                format!("ID3 {name} {}", asset.filename).as_bytes()
            );
        }
    }
    std::fs::write(
        audio.join("lofi.mp3"),
        b"version https://git-lfs.github.com/spec/v1\n",
    )
    .unwrap();
    assert!(
        factory
            .build(WorldBootstrap::SampleData {
                showfile_name: Some("Pointer".into())
            })
            .is_err()
    );
    assert!(!root.path().join("drafts/Pointer.nightfall-show").exists());
    std::fs::remove_dir_all(&audio).unwrap();
    assert!(
        factory
            .build(WorldBootstrap::SampleData {
                showfile_name: Some("Missing".into())
            })
            .is_err()
    );
    assert!(!root.path().join("drafts/Missing.nightfall-show").exists());
    factory
        .build(WorldBootstrap::Empty {
            showfile_name: Some("Empty".into()),
        })
        .unwrap();
    factory
        .build(WorldBootstrap::Showfile {
            name: Some("First".into()),
            source: root.path().join("drafts/First.nightfall-show"),
        })
        .unwrap();
    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}
