// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy::prelude::*;
use bevy_state::{
    app::{AppExtStates, StatesPlugin},
    prelude::{State, States},
};
use nightfall_engine::prelude::AppState;
use nightfall_framepace::prelude::FramepaceSettings;
use uuid::Uuid;

use crate::{WorldBootstrap, WorldFactory};

/// Runtime command/event processing state around world swap boundaries.
#[derive(States, Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum CommandProcessingState {
    /// Command/event systems are active.
    #[default]
    Running,
    /// Command/event systems are paused during transition windows.
    Paused,
}

/// Runtime output state around world swap boundaries.
#[derive(States, Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum RuntimeOutputState {
    /// Output systems are active.
    #[default]
    Running,
    /// Output systems are paused during transition windows.
    Paused,
}

/// Deferred world swap requests produced by in-world systems.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingWorldSwap {
    NewShowfile {
        correlation_id: Uuid,
        showfile_name: Option<String>,
        include_sample_data: bool,
    },
    LoadShowfile {
        correlation_id: Uuid,
        showfile_name: Option<String>,
        source: std::path::PathBuf,
    },
}

impl PendingWorldSwap {
    /// Return the command correlation ID that requested this swap.
    pub fn correlation_id(&self) -> Uuid {
        match self {
            Self::NewShowfile { correlation_id, .. } => *correlation_id,
            Self::LoadShowfile { correlation_id, .. } => *correlation_id,
        }
    }

    /// Build the world bootstrap requested by this swap.
    pub fn bootstrap(&self) -> WorldBootstrap {
        match self {
            Self::NewShowfile {
                showfile_name,
                include_sample_data,
                ..
            } => {
                if *include_sample_data {
                    WorldBootstrap::SampleData {
                        showfile_name: showfile_name.clone(),
                    }
                } else {
                    WorldBootstrap::Empty {
                        showfile_name: showfile_name.clone(),
                    }
                }
            }
            Self::LoadShowfile {
                showfile_name,
                source,
                ..
            } => WorldBootstrap::Showfile {
                name: showfile_name.clone(),
                source: source.clone(),
            },
        }
    }

    /// Return a short description for logs and error messages.
    pub fn description(&self) -> &'static str {
        match self {
            Self::NewShowfile { .. } => "new showfile",
            Self::LoadShowfile { .. } => "showfile load",
        }
    }
}

/// Deferred world swap requests produced by in-world systems.
#[derive(Resource, Debug, Clone, Default)]
pub struct PendingWorldSwapRequest {
    requests: Vec<PendingWorldSwap>,
}

impl PendingWorldSwapRequest {
    /// Queue a fresh-showfile world swap request for a command correlation id.
    pub fn request_new_showfile(
        &mut self,
        correlation_id: Uuid,
        showfile_name: Option<&str>,
        include_sample_data: bool,
    ) {
        self.requests.push(PendingWorldSwap::NewShowfile {
            correlation_id,
            showfile_name: showfile_name.map(str::to_string),
            include_sample_data,
        });
    }

    /// Queue a showfile world swap request for a command correlation id.
    pub fn request_load_showfile(
        &mut self,
        correlation_id: Uuid,
        showfile_name: Option<&str>,
        source: std::path::PathBuf,
    ) {
        self.requests.push(PendingWorldSwap::LoadShowfile {
            correlation_id,
            showfile_name: showfile_name.map(str::to_string),
            source,
        });
    }

    /// Drain queued world swap requests in FIFO order.
    pub fn take_requests(&mut self) -> Vec<PendingWorldSwap> {
        std::mem::take(&mut self.requests)
    }
}

/// Owns the active Bevy app and performs atomic world cutovers.
pub struct SwapOrchestrator {
    active_app: App,
}

impl SwapOrchestrator {
    /// Create a new orchestrator with an initial active app.
    pub fn new(mut active_app: App) -> Self {
        ensure_runtime_resources(&mut active_app);
        Self { active_app }
    }

    /// Borrow the active app.
    pub fn active_app(&self) -> &App {
        &self.active_app
    }

    /// Borrow the active app mutably.
    pub fn active_app_mut(&mut self) -> &mut App {
        &mut self.active_app
    }

    /// Stage a world with factory bootstrap and optional warm-up ticks.
    pub fn stage_world(
        &self,
        factory: &WorldFactory,
        bootstrap: WorldBootstrap,
        warm_up_ticks: usize,
    ) -> Result<App, String> {
        let mut staged_app = factory.build(bootstrap)?;
        // Keep staged worlds output-quiet until commit, including optional warm-up ticks.
        set_runtime_paused(&mut staged_app, true);
        factory.warm_up(&mut staged_app, warm_up_ticks);
        Ok(staged_app)
    }

    /// Atomically swap the active app with a staged app.
    pub fn swap(&mut self, mut staged_app: App) -> App {
        preserve_runtime_session_resources(&self.active_app, &mut staged_app);
        ensure_runtime_resources(&mut staged_app);
        set_runtime_paused(&mut staged_app, false);
        std::mem::replace(&mut self.active_app, staged_app)
    }

    /// Stage and atomically swap the active app.
    ///
    /// On failure, the current app remains active and runtime states are resumed.
    pub fn stage_and_swap(
        &mut self,
        factory: &WorldFactory,
        bootstrap: WorldBootstrap,
        warm_up_ticks: usize,
    ) -> Result<App, String> {
        self.stage_and_swap_with_before_commit(factory, bootstrap, warm_up_ticks, |_| {})
    }

    /// Stage a world, invoke a callback while the current app is still active, then swap.
    ///
    /// The callback runs only after staging succeeds and before the current app is
    /// replaced, which lets callers acknowledge commands through resources that
    /// belong to the still-active world.
    pub fn stage_and_swap_with_before_commit<F>(
        &mut self,
        factory: &WorldFactory,
        bootstrap: WorldBootstrap,
        warm_up_ticks: usize,
        before_commit: F,
    ) -> Result<App, String>
    where
        F: FnOnce(&mut App),
    {
        let previous_app_state = app_state(&mut self.active_app);
        self.active_app.insert_state(AppState::ShowLoading);
        set_runtime_paused(&mut self.active_app, true);

        let mut staged_app = match self.stage_world(factory, bootstrap, warm_up_ticks) {
            Ok(staged_app) => staged_app,
            Err(error) => {
                set_runtime_paused(&mut self.active_app, false);
                self.active_app.insert_state(previous_app_state);
                return Err(error);
            }
        };

        ensure_runtime_resources(&mut staged_app);
        staged_app.insert_state(AppState::Ready);
        before_commit(&mut self.active_app);
        Ok(self.swap(staged_app))
    }

    #[cfg(test)]
    fn stage_and_swap_with<F>(&mut self, stage: F) -> Result<App, String>
    where
        F: FnMut() -> Result<App, String>,
    {
        self.stage_and_swap_with_before_commit_with(stage, |_| {})
    }

    #[cfg(test)]
    fn stage_and_swap_with_before_commit_with<F, G>(
        &mut self,
        mut stage: F,
        before_commit: G,
    ) -> Result<App, String>
    where
        F: FnMut() -> Result<App, String>,
        G: FnOnce(&mut App),
    {
        let previous_app_state = app_state(&mut self.active_app);
        self.active_app.insert_state(AppState::ShowLoading);
        set_runtime_paused(&mut self.active_app, true);

        let mut staged_app = match stage() {
            Ok(staged_app) => staged_app,
            Err(error) => {
                set_runtime_paused(&mut self.active_app, false);
                self.active_app.insert_state(previous_app_state);
                return Err(error);
            }
        };

        ensure_runtime_resources(&mut staged_app);
        staged_app.insert_state(AppState::Ready);
        before_commit(&mut self.active_app);
        Ok(self.swap(staged_app))
    }
}

/// Return the current lifecycle state, ensuring it exists for minimal test apps.
fn app_state(app: &mut App) -> AppState {
    ensure_runtime_resources(app);
    *app.world().resource::<State<AppState>>().get()
}

/// Copy runtime session resources that should survive showfile world swaps.
fn preserve_runtime_session_resources(active_app: &App, staged_app: &mut App) {
    if let Some(framepace_settings) = active_app.world().get_resource::<FramepaceSettings>() {
        staged_app.insert_resource(framepace_settings.clone());
    }
}

/// Ensure runtime state/resources required by swap orchestration exist in the app world.
fn ensure_runtime_resources(app: &mut App) {
    if !app.is_plugin_added::<StatesPlugin>() {
        app.add_plugins(StatesPlugin);
    }
    if !app
        .world()
        .contains_resource::<State<CommandProcessingState>>()
    {
        app.init_state::<CommandProcessingState>();
    }
    if !app.world().contains_resource::<State<RuntimeOutputState>>() {
        app.init_state::<RuntimeOutputState>();
    }
    if !app.world().contains_resource::<State<AppState>>() {
        app.init_state::<AppState>();
    }
    if app
        .world()
        .get_resource::<PendingWorldSwapRequest>()
        .is_none()
    {
        app.insert_resource(PendingWorldSwapRequest::default());
    }
}

/// Set both runtime scheduling states to paused or running.
fn set_runtime_paused(app: &mut App, paused: bool) {
    ensure_runtime_resources(app);
    let command_state = if paused {
        CommandProcessingState::Paused
    } else {
        CommandProcessingState::Running
    };
    let output_state = if paused {
        RuntimeOutputState::Paused
    } else {
        RuntimeOutputState::Running
    };
    app.insert_state(command_state);
    app.insert_state(output_state);
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use nightfall_framepace::prelude::Limiter;

    use super::*;

    /// Test marker resource used to confirm which app world is active after a swap.
    #[derive(Resource)]
    struct Marker(&'static str);

    fn command_state(app: &App) -> CommandProcessingState {
        *app.world()
            .resource::<State<CommandProcessingState>>()
            .get()
    }

    fn output_state(app: &App) -> RuntimeOutputState {
        *app.world().resource::<State<RuntimeOutputState>>().get()
    }

    fn lifecycle_state(app: &App) -> AppState {
        *app.world().resource::<State<AppState>>().get()
    }

    fn marker_value(app: &App) -> &'static str {
        app.world().resource::<Marker>().0
    }

    /// Returns the manual frame rate configured on the app, if frame limiting is enabled.
    fn manual_framerate(app: &App) -> Option<f64> {
        let settings = app.world().resource::<FramepaceSettings>();
        match &settings.limiter {
            Limiter::Manual(duration) => Some(1.0 / duration.as_secs_f64()),
            Limiter::Off => None,
        }
    }

    #[test]
    fn stage_and_swap_success_replaces_active_app() {
        let mut active = App::new();
        active.insert_resource(Marker("active"));

        let mut orchestrator = SwapOrchestrator::new(active);
        let previous_app = orchestrator
            .stage_and_swap_with(|| {
                let mut staged = App::new();
                staged.insert_resource(Marker("staged"));
                Ok(staged)
            })
            .expect("stage and swap");

        assert_eq!(marker_value(&previous_app), "active");
        assert_eq!(marker_value(orchestrator.active_app()), "staged");
        assert_eq!(lifecycle_state(orchestrator.active_app()), AppState::Ready);
        assert_eq!(
            command_state(orchestrator.active_app()),
            CommandProcessingState::Running
        );
        assert_eq!(
            output_state(orchestrator.active_app()),
            RuntimeOutputState::Running
        );
    }

    /// Verifies FPS limiter settings survive while committing a staged world swap.
    #[test]
    fn stage_and_swap_preserves_framepace_settings() {
        let mut active = App::new();
        active.insert_resource(Marker("active"));
        active.insert_resource(
            FramepaceSettings::default().with_limiter(Limiter::from_framerate(5.0)),
        );

        let mut orchestrator = SwapOrchestrator::new(active);
        let _previous_app = orchestrator
            .stage_and_swap_with(|| {
                let mut staged = App::new();
                staged.insert_resource(Marker("staged"));
                staged.insert_resource(
                    FramepaceSettings::default().with_limiter(Limiter::from_framerate(44.0)),
                );
                Ok(staged)
            })
            .expect("stage and swap");

        let Some(frame_rate) = manual_framerate(orchestrator.active_app()) else {
            panic!("expected preserved manual frame limiter");
        };
        assert!((frame_rate - 5.0).abs() < f64::EPSILON);
    }

    #[test]
    fn stage_and_swap_before_commit_runs_while_active_world_is_current() {
        let mut active = App::new();
        active.insert_resource(Marker("active"));

        let mut orchestrator = SwapOrchestrator::new(active);
        let callback_marker = std::cell::Cell::new(None);
        let callback_state = std::cell::Cell::new(None);
        let _previous_app = orchestrator
            .stage_and_swap_with_before_commit_with(
                || {
                    let mut staged = App::new();
                    staged.insert_resource(Marker("staged"));
                    Ok(staged)
                },
                |active_app| {
                    callback_marker.set(Some(marker_value(active_app)));
                    callback_state.set(Some(lifecycle_state(active_app)));
                },
            )
            .expect("stage and swap");

        assert_eq!(callback_marker.get(), Some("active"));
        assert_eq!(callback_state.get(), Some(AppState::ShowLoading));
        assert_eq!(marker_value(orchestrator.active_app()), "staged");
    }

    #[test]
    fn stage_and_swap_failure_keeps_active_app() {
        let mut active = App::new();
        active.insert_resource(Marker("active"));

        let mut orchestrator = SwapOrchestrator::new(active);
        let result = orchestrator.stage_and_swap_with(|| Err("stage failed".to_string()));

        assert_eq!(result.err().as_deref(), Some("stage failed"));
        assert_eq!(marker_value(orchestrator.active_app()), "active");
        assert_eq!(
            lifecycle_state(orchestrator.active_app()),
            AppState::Initializing
        );
        assert_eq!(
            command_state(orchestrator.active_app()),
            CommandProcessingState::Running
        );
        assert_eq!(
            output_state(orchestrator.active_app()),
            RuntimeOutputState::Running
        );
    }

    #[test]
    fn pending_world_swap_request_roundtrip() {
        let correlation_new = Uuid::new_v4();
        let correlation_a = Uuid::new_v4();
        let correlation_b = Uuid::new_v4();
        let mut pending = PendingWorldSwapRequest::default();
        pending.request_new_showfile(correlation_new, Some("fresh"), false);
        pending.request_load_showfile(
            correlation_a,
            None,
            std::path::PathBuf::from("default.nightfall-show"),
        );
        pending.request_load_showfile(
            correlation_b,
            Some("demo"),
            std::path::PathBuf::from("drafts/demo.nightfall-show"),
        );

        let queued = pending.take_requests();
        assert_eq!(
            queued,
            vec![
                PendingWorldSwap::NewShowfile {
                    correlation_id: correlation_new,
                    showfile_name: Some("fresh".to_string()),
                    include_sample_data: false,
                },
                PendingWorldSwap::LoadShowfile {
                    correlation_id: correlation_a,
                    showfile_name: None,
                    source: std::path::PathBuf::from("default.nightfall-show"),
                },
                PendingWorldSwap::LoadShowfile {
                    correlation_id: correlation_b,
                    showfile_name: Some("demo".to_string()),
                    source: std::path::PathBuf::from("drafts/demo.nightfall-show"),
                },
            ]
        );
        assert!(pending.take_requests().is_empty());
    }

    #[test]
    fn ensure_runtime_resources_initializes_support_resources() {
        let mut app = App::new();
        ensure_runtime_resources(&mut app);
        assert!(
            app.world()
                .contains_resource::<State<CommandProcessingState>>()
        );
        assert!(app.world().contains_resource::<State<RuntimeOutputState>>());
        assert!(app.world().contains_resource::<PendingWorldSwapRequest>());
        assert_eq!(command_state(&app), CommandProcessingState::Running);
        assert_eq!(output_state(&app), RuntimeOutputState::Running);
    }

    #[test]
    fn set_runtime_paused_sets_both_command_and_output_states() {
        let mut app = App::new();
        ensure_runtime_resources(&mut app);

        set_runtime_paused(&mut app, true);
        assert_eq!(command_state(&app), CommandProcessingState::Paused);
        assert_eq!(output_state(&app), RuntimeOutputState::Paused);

        set_runtime_paused(&mut app, false);
        assert_eq!(command_state(&app), CommandProcessingState::Running);
        assert_eq!(output_state(&app), RuntimeOutputState::Running);
    }

    /// Test resource that increments a shared counter when an app world is dropped.
    #[derive(Resource)]
    struct DropCounter(Arc<AtomicUsize>);

    impl Drop for DropCounter {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn swap_drops_previous_active_world_deterministically() {
        let drop_count = Arc::new(AtomicUsize::new(0));
        let mut active = App::new();
        active.insert_resource(DropCounter(drop_count.clone()));

        let mut orchestrator = SwapOrchestrator::new(active);
        let staged = App::new();
        let _ = orchestrator.swap(staged);

        assert_eq!(drop_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn repeated_swaps_drop_each_replaced_world_once() {
        let drop_count = Arc::new(AtomicUsize::new(0));

        let make_app = |label: &'static str| {
            let mut app = App::new();
            app.insert_resource(Marker(label));
            app.insert_resource(DropCounter(drop_count.clone()));
            app
        };

        let mut orchestrator = SwapOrchestrator::new(make_app("active"));
        assert_eq!(drop_count.load(Ordering::SeqCst), 0);

        let _ = orchestrator
            .stage_and_swap_with(|| Ok(make_app("staged-1")))
            .expect("first swap");
        assert_eq!(marker_value(orchestrator.active_app()), "staged-1");
        assert_eq!(drop_count.load(Ordering::SeqCst), 1);

        let _ = orchestrator
            .stage_and_swap_with(|| Ok(make_app("staged-2")))
            .expect("second swap");
        assert_eq!(marker_value(orchestrator.active_app()), "staged-2");
        assert_eq!(drop_count.load(Ordering::SeqCst), 2);

        let _ = orchestrator
            .stage_and_swap_with(|| Ok(make_app("staged-3")))
            .expect("third swap");
        assert_eq!(marker_value(orchestrator.active_app()), "staged-3");
        assert_eq!(drop_count.load(Ordering::SeqCst), 3);

        drop(orchestrator);
        assert_eq!(drop_count.load(Ordering::SeqCst), 4);
    }
}
