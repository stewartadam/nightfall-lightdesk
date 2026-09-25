// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Single-threaded browser host for the reduced Nightfall engine composition.

#![warn(missing_docs)]

pub mod fixture_library;

#[cfg(target_arch = "wasm32")]
use std::sync::atomic::{AtomicU8, Ordering};

use async_channel::{Receiver, Sender};
use bevy_app::App;
use bevy_ecs::prelude::*;
use bevy_state::prelude::NextState;
use bevy_time::{TimePlugin, TimeUpdateStrategy};
use nightfall_actions::ActionsPlugin;
use nightfall_cues::prelude::CuePlugin;
use nightfall_desk::{prelude::DeskPlugin, resources::log_config::LogConfig};
use nightfall_engine::EnginePlugin;
use nightfall_engine::prelude::{
    AppState, ClientBridgeHost, ClientBridgePlugin, CommandJsonEnvelope, DataProvider,
    RuntimeCapabilities, UpdateJsonEnvelope,
};
use nightfall_fixtures::prelude::{FixtureCompositorPlugin, FixturePlugin};
use nightfall_flow::prelude::FlowPlugin;
use nightfall_fx::prelude::{FxPlugin, StoredFxModule};
use nightfall_programmer::prelude::ProgrammerPlugin;
use nightfall_scene_objects::prelude::SceneObjectPlugin;
use nightfall_timecode::prelude::TimecodePlugin;
use nightfall_timeline::prelude::TimelinePlugin;
use nightfall_undo::prelude::UndoPlugin;
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::fixture_library::BuiltinFixtureLibraryPlugin;

const MAX_TICK_DELTA_MS: f64 = 100.0;
#[cfg(test)]
const TEST_SAMPLE_ID: &str = "nightfall-demo-v1";
#[cfg(test)]
const TEST_SHOWFILE_JSON: &str = include_str!("../../../test-fixtures/browser-show/showfile.json");
#[cfg(target_arch = "wasm32")]
static CONSTRUCTION_STAGE: AtomicU8 = AtomicU8::new(0);

/// Static and accumulated runtime information exposed to the worker host.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    /// Stable identifier for the deterministic sample loaded into this runtime.
    pub sample_id: String,
    /// Number of engine frames advanced since creation.
    pub tick_count: u64,
    /// Most recent caller-supplied frame delta in milliseconds.
    pub requested_delta_ms: f64,
    /// Most recent clamped frame delta in milliseconds.
    pub applied_delta_ms: f64,
    /// Upper bound applied to frame deltas after a suspended browser resumes.
    pub max_delta_ms: f64,
}

/// Browser-owned engine instance that runs entirely inside a dedicated worker.
#[wasm_bindgen]
pub struct BrowserEngine {
    app: App,
    command_tx: Sender<CommandJsonEnvelope>,
    update_tx: Sender<UpdateJsonEnvelope>,
    output_rx: Receiver<Vec<u8>>,
    runtime_info: RuntimeInfo,
}

#[wasm_bindgen]
impl BrowserEngine {
    /// Create a reduced engine from release-selected canonical showfile JSON.
    #[wasm_bindgen(constructor)]
    pub fn create(sample_id: String, showfile_json: String) -> Result<BrowserEngine, JsValue> {
        #[cfg(target_arch = "wasm32")]
        install_worker_panic_hook();
        Self::create_core(sample_id, &showfile_json).map_err(|error| JsValue::from_str(&error))
    }

    /// Submit a lifecycle-tracked JSON command envelope to the next engine tick.
    pub fn enqueue_command(&self, envelope: JsValue) -> Result<(), JsValue> {
        let envelope = serde_wasm_bindgen::from_value(envelope)
            .map_err(|error| JsValue::from_str(&format!("Invalid command envelope: {error}")))?;
        self.enqueue_command_core(envelope)
            .map_err(|error| JsValue::from_str(&error))
    }

    /// Submit an untracked high-frequency JSON update to the next engine tick.
    pub fn enqueue_update(&self, envelope: JsValue) -> Result<(), JsValue> {
        let envelope = serde_wasm_bindgen::from_value(envelope)
            .map_err(|error| JsValue::from_str(&format!("Invalid update envelope: {error}")))?;
        self.enqueue_update_core(envelope)
            .map_err(|error| JsValue::from_str(&error))
    }

    /// Advance the embedded engine by one frame with a clamped host delta.
    pub fn tick(&mut self, delta_ms: f64) -> f64 {
        self.tick_core(delta_ms)
    }

    /// Drain all encoded CBOR publications currently waiting for the worker.
    pub fn drain_output(&self) -> js_sys::Array {
        let output = js_sys::Array::new();
        for bytes in self.drain_output_core() {
            let typed = js_sys::Uint8Array::from(bytes.as_slice());
            output.push(&typed);
        }
        output
    }

    /// Return runtime identity and tick telemetry as a JavaScript object.
    pub fn runtime_info(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.runtime_info)
            .map_err(|error| JsValue::from_str(&format!("Unable to encode runtime info: {error}")))
    }
}

/// Forward Rust panic details through the worker's existing error message channel.
#[cfg(target_arch = "wasm32")]
fn install_worker_panic_hook() {
    use wasm_bindgen::JsCast;

    std::panic::set_hook(Box::new(|panic_info| {
        let construction_stage =
            construction_stage_name(CONSTRUCTION_STAGE.load(Ordering::Relaxed));
        let error = js_sys::Error::new("Embedded engine Rust stack");
        let stack = js_sys::Reflect::get(error.as_ref(), &JsValue::from_str("stack"))
            .ok()
            .and_then(|value| value.as_string())
            .unwrap_or_else(|| "JavaScript stack unavailable".to_owned());
        let message = js_sys::Object::new();
        let _ = js_sys::Reflect::set(
            &message,
            &JsValue::from_str("type"),
            &JsValue::from_str("error"),
        );
        let _ = js_sys::Reflect::set(
            &message,
            &JsValue::from_str("error"),
            &JsValue::from_str(&format!(
                "Embedded engine panic while {construction_stage}: {panic_info}\n{stack}"
            )),
        );
        let scope = js_sys::global().unchecked_into::<web_sys::DedicatedWorkerGlobalScope>();
        let _ = scope.post_message(&message);
    }));
}

/// Record the current runtime construction stage for browser panic diagnostics.
fn set_construction_stage(stage: u8) {
    #[cfg(target_arch = "wasm32")]
    CONSTRUCTION_STAGE.store(stage, Ordering::Relaxed);
    #[cfg(not(target_arch = "wasm32"))]
    let _ = stage;
}

/// Describe the runtime construction stage active when a browser panic occurred.
#[cfg(target_arch = "wasm32")]
fn construction_stage_name(stage: u8) -> &'static str {
    match stage {
        1 => "adding EnginePlugin",
        2 => "adding UndoPlugin",
        3 => "adding ClientBridgePlugin",
        4 => "adding FixturePlugin",
        5 => "adding BuiltinFixtureLibraryPlugin",
        6 => "adding FixtureCompositorPlugin",
        7 => "loading the demo showfile",
        8 => "attaching the client bridge host",
        9 => "running startup frame one",
        10 => "running startup frame two",
        11 => "running startup frame three",
        12 => "applying the ready-state frame",
        _ => "outside runtime construction",
    }
}

impl BrowserEngine {
    /// Build the engine core independently of JavaScript bindings for native verification.
    fn create_core(sample_id: String, showfile_json: &str) -> Result<Self, String> {
        if sample_id.trim().is_empty() {
            return Err("Browser demo sample ID must not be empty".to_owned());
        }

        let mut app = App::new();
        app.insert_resource(RuntimeCapabilities::embedded_demo());
        app.add_plugins(TimePlugin);
        app.insert_resource(TimeUpdateStrategy::ManualDuration(
            std::time::Duration::ZERO,
        ));
        app.add_plugins(ActionsPlugin);
        set_construction_stage(1);
        app.add_plugins(EnginePlugin);
        set_construction_stage(2);
        app.add_plugins(UndoPlugin);
        set_construction_stage(3);
        app.add_plugins(ClientBridgePlugin);
        set_construction_stage(4);
        app.add_plugins(FixturePlugin);
        set_construction_stage(5);
        app.add_plugins(BuiltinFixtureLibraryPlugin);
        set_construction_stage(6);
        app.add_plugins(FixtureCompositorPlugin);
        app.add_plugins(SceneObjectPlugin);
        app.add_plugins(DeskPlugin {
            log_config: LogConfig::disconnected(),
        });
        app.add_plugins(ProgrammerPlugin);
        app.add_plugins(CuePlugin);
        app.add_plugins(FxPlugin);
        app.init_resource::<DataProvider<StoredFxModule>>();
        app.add_plugins(FlowPlugin);
        app.add_plugins(TimecodePlugin);
        app.add_plugins(TimelinePlugin::browser_demo());
        set_construction_stage(7);
        let snapshot = nightfall_showfile::parse_showfile_snapshot_json(
            showfile_json,
            &format!("embedded browser sample {sample_id}"),
        )?;
        nightfall_showfile::apply_showfile_snapshot_to_world(app.world_mut(), snapshot)?;

        set_construction_stage(8);
        let (command_tx, update_tx, output_rx) = {
            let mut host = app.world_mut().resource_mut::<ClientBridgeHost>();
            let output_rx = host
                .take_output_receiver()
                .ok_or_else(|| "Browser runtime output receiver was already attached".to_owned())?;
            (host.command_sender(), host.update_sender(), output_rx)
        };
        settle_loaded_runtime(&mut app);
        set_construction_stage(0);

        Ok(Self {
            app,
            command_tx,
            update_tx,
            output_rx,
            runtime_info: RuntimeInfo {
                sample_id,
                tick_count: 0,
                requested_delta_ms: 0.0,
                applied_delta_ms: 0.0,
                max_delta_ms: MAX_TICK_DELTA_MS,
            },
        })
    }

    /// Queue one parsed command envelope without entering an async executor.
    fn enqueue_command_core(&self, envelope: CommandJsonEnvelope) -> Result<(), String> {
        self.command_tx
            .try_send(envelope)
            .map_err(|error| format!("Unable to enqueue browser command: {error}"))
    }

    /// Queue one parsed update envelope without entering an async executor.
    fn enqueue_update_core(&self, envelope: UpdateJsonEnvelope) -> Result<(), String> {
        self.update_tx
            .try_send(envelope)
            .map_err(|error| format!("Unable to enqueue browser update: {error}"))
    }

    /// Advance one Bevy frame and retain the host delta used for feasibility telemetry.
    fn tick_core(&mut self, delta_ms: f64) -> f64 {
        let requested_delta_ms = if delta_ms.is_finite() {
            delta_ms.max(0.0)
        } else {
            0.0
        };
        let applied_delta_ms = requested_delta_ms.min(MAX_TICK_DELTA_MS);
        self.runtime_info.requested_delta_ms = requested_delta_ms;
        self.runtime_info.applied_delta_ms = applied_delta_ms;
        self.runtime_info.tick_count += 1;
        *self.app.world_mut().resource_mut::<TimeUpdateStrategy>() =
            TimeUpdateStrategy::ManualDuration(std::time::Duration::from_secs_f64(
                applied_delta_ms / 1_000.0,
            ));
        self.app.update();
        applied_delta_ms
    }

    /// Copy all pending encoded messages into host-owned byte buffers.
    fn drain_output_core(&self) -> Vec<Vec<u8>> {
        let mut output = Vec::new();
        while let Ok(bytes) = self.output_rx.try_recv() {
            output.push(bytes);
        }
        output
    }
}

/// Run startup systems to completion and expose the loaded showfile as ready.
fn settle_loaded_runtime(app: &mut App) {
    set_construction_stage(9);
    app.update();
    set_construction_stage(10);
    app.update();
    set_construction_stage(11);
    app.update();
    app.world_mut()
        .resource_mut::<NextState<AppState>>()
        .set(AppState::Ready);
    set_construction_stage(12);
    app.update();
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use uuid::Uuid;

    use super::*;

    /// Build the tracked browser test fixture through the canonical JSON load boundary.
    pub(crate) fn sample_engine() -> BrowserEngine {
        BrowserEngine::create_core(TEST_SAMPLE_ID.to_owned(), TEST_SHOWFILE_JSON)
            .expect("runtime should initialize from the test showfile")
    }

    /// Decode one discriminator-prefixed engine publication into JSON.
    pub(crate) fn decode_publication(bytes: &[u8]) -> Value {
        assert!(
            !bytes.is_empty(),
            "publication must contain a discriminator"
        );
        minicbor_serde::from_slice(&bytes[1..]).expect("publication should contain valid CBOR")
    }

    /// Verify resync publishes the complete deterministic demo before its completion fence.
    #[test]
    fn resync_command_runs_through_browser_composition() {
        let mut engine = sample_engine();
        let command_id = Uuid::from_u128(0x8df0_f914_1491_4c43_a5e7_b53c_2fd2_0001);
        let envelope = serde_json::from_value(json!({
            "command_id": command_id,
            "module": "EngineCommand",
            "command": { "type": "ResyncState" }
        }))
        .expect("command envelope should deserialize");

        engine
            .enqueue_command_core(envelope)
            .expect("command should enqueue");
        engine.tick_core(16.0);
        engine.tick_core(16.0);
        let messages = engine
            .drain_output_core()
            .iter()
            .map(|bytes| decode_publication(bytes))
            .collect::<Vec<_>>();
        let types = messages
            .iter()
            .filter_map(|message| message.get("type").and_then(Value::as_str))
            .collect::<Vec<_>>();
        let command_id_text = command_id.simple().to_string();

        assert!(types.contains(&"FixtureDefinitions"));
        assert!(types.contains(&"ParameterState"));
        assert!(types.contains(&"ResyncComplete"));
        assert!(types.contains(&"CommandResult"));
        let capability_index = types
            .iter()
            .position(|message_type| *message_type == "RuntimeCapabilities")
            .expect("resync should publish runtime capabilities");
        let completion_index = types
            .iter()
            .position(|message_type| *message_type == "ResyncComplete")
            .expect("resync should publish its completion fence");
        assert!(capability_index < completion_index);
        let capabilities = &messages[capability_index]["data"];
        assert_eq!(capabilities["runtime_mode"], "EmbeddedDemo");
        assert_eq!(capabilities["timeline_audio"], "BundledBrowser");
        assert_eq!(capabilities["fx_modules"], "Unavailable");
        assert_eq!(capabilities["fixture_library"], "BuiltInOnly");
        let fixtures = messages
            .iter()
            .find(|message| message["type"] == "FixtureDefinitions")
            .and_then(|message| message["data"].as_array())
            .expect("fixture snapshot should be an array");
        assert_eq!(fixtures.len(), 6);
        let timelines = messages
            .iter()
            .find(|message| message["type"] == "TimelineDefinitions")
            .and_then(|message| message["data"].as_array())
            .expect("timeline snapshot should be an array");
        assert_eq!(timelines.len(), 1);
        let timeline_uid = timelines[0]["identifiers"]["uid"]
            .as_str()
            .expect("timeline should have a UID");
        let audio_path = timelines[0]["audio_path"]
            .as_str()
            .expect("timeline should have an audio path");
        assert_eq!(
            audio_path,
            format!("timeline-audio/{timeline_uid}/nightfall-demo-click.wav")
        );
        assert_eq!(timelines[0]["markers"].as_array().map(Vec::len), Some(2));
        assert_eq!(timelines[0]["regions"].as_array().map(Vec::len), Some(1));
        assert!(
            messages.iter().any(|message| {
                message.get("type") == Some(&Value::String("CommandResult".to_owned()))
                    && message.pointer("/data/command_id").and_then(Value::as_str)
                        == Some(command_id_text.as_str())
            }),
            "publications did not preserve command correlation: {messages:#?}"
        );
    }

    /// Verify timecode playback emits browser media effects through the shared output bridge.
    #[test]
    fn timecode_playback_emits_browser_audio_directives() {
        let mut engine = sample_engine();
        let envelope = serde_json::from_value(json!({
            "command_id": Uuid::new_v4(),
            "module": "TimecodeCommand",
            "command": { "type": "StartTimecode", "data": 1 }
        }))
        .expect("timecode command should deserialize");

        engine
            .enqueue_command_core(envelope)
            .expect("timecode command should enqueue");
        for _ in 0..4 {
            engine.tick_core(16.0);
        }
        let messages = engine
            .drain_output_core()
            .iter()
            .map(|bytes| decode_publication(bytes))
            .collect::<Vec<_>>();
        let directives = messages
            .iter()
            .filter(|message| message["type"] == "TimelineAudioDirective")
            .map(|message| message["data"]["type"].as_str().unwrap_or_default())
            .collect::<Vec<_>>();

        assert!(directives.contains(&"Load"), "directives: {directives:?}");
        assert!(directives.contains(&"Seek"), "directives: {directives:?}");
        assert!(directives.contains(&"Play"), "directives: {directives:?}");

        for _ in 0..60 {
            engine.tick_core(16.0);
        }
        let repeated_directives = engine
            .drain_output_core()
            .iter()
            .filter(|bytes| {
                bytes.first() == Some(&nightfall_engine::prelude::DISCRIMINATOR_NON_DROPPABLE)
            })
            .map(|bytes| decode_publication(bytes))
            .filter(|message| message["type"] == "TimelineAudioDirective")
            .collect::<Vec<_>>();
        assert!(
            repeated_directives.is_empty(),
            "steady playback must not repeatedly seek browser media: {repeated_directives:#?}"
        );
    }

    /// Verify suspended-frame deltas cannot advance the runtime by an unbounded amount.
    #[test]
    fn tick_delta_is_clamped() {
        let mut engine = sample_engine();
        assert_eq!(engine.tick_core(5_000.0), MAX_TICK_DELTA_MS);
        assert_eq!(engine.runtime_info.requested_delta_ms, 5_000.0);
        assert_eq!(engine.runtime_info.applied_delta_ms, MAX_TICK_DELTA_MS);
    }

    /// Reject malformed showfile bytes before the embedded runtime becomes ready.
    #[test]
    fn malformed_showfile_fails_construction() {
        let error = match BrowserEngine::create_core(TEST_SAMPLE_ID.to_owned(), "not-json") {
            Ok(_) => panic!("invalid showfile JSON should fail"),
            Err(error) => error,
        };
        assert!(error.contains("failed to parse showfile"), "{error}");
    }
}
