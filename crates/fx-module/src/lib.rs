// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Component ABI contract and Rust SDK surface for fx module.
//!
//! The WIT definition in `wit/fx-module.wit` is the canonical component-style
//! interface. The Rust types in this crate mirror that contract and provide the
//! engine-facing conversion points needed by later runtime work.

#![warn(missing_docs)]

use std::{
    collections::{HashMap, HashSet},
    fs,
    time::Duration,
};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall::prelude::{FadeCurve, MaterializedTransition};
use nightfall::prelude::{Identifiers, SpatialSelection};
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::Fixture;
pub use nightfall_fx::prelude::StoredFxModule;
use nightfall_instances::{
    ClipInstanceAttachment, ClipInstanceRequest, ClipInstanceStartContext,
    DomainInstanceReconstructionRequest, InstanceClock,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

/// AST conversion for fx module command parsing.
pub mod ast_conv;
/// ECS event handling for stored fx module commands.
pub mod events;
/// Runtime playback and layer materialization for active fx module objects.
pub mod instances;
mod runtime;
mod undo;
/// Websocket integration for stored fx module commands and definitions.
pub mod websocket;

pub use runtime::{FxModuleComponent, FxModuleInstance, FxModuleRuntimeError};

/// Prelude for ergonomic imports.
pub mod prelude {
    pub use crate::{
        ActiveFxModuleIds, ActiveFxModuleTimings, AvailableFxModuleInfo, FxModuleClipBinding,
        FxModuleClipBindings, FxModuleCommand, FxModuleComponent, FxModuleControlAction,
        FxModuleError, FxModuleErrorCode, FxModuleGuest, FxModuleHost, FxModuleInitInput,
        FxModuleInstance, FxModuleLayer, FxModuleLayerInstruction, FxModuleMaterializedTransition,
        FxModulePlugin, FxModulePreviewUpdate, FxModuleRenderInput, FxModuleRuntimeError,
        FxModuleRuntimeNotification, ListAvailableFxModulesResponse, SelectedCell, SelectedGrid,
        SelectedTarget, StoredFxModule, StoredFxModuleRequest,
    };
}

/// Available WebAssembly fx module discovered in the app data module directory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct AvailableFxModuleInfo {
    /// Module name used by stored fx module definitions, without the `.wasm` suffix.
    pub name: String,
    /// File name found in the app data `fx-modules` directory.
    pub filename: String,
}

/// Response containing the currently available WebAssembly fx modules.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ListAvailableFxModulesResponse {
    /// Discovered module files sorted by module name.
    pub modules: Vec<AvailableFxModuleInfo>,
}

/// Store/update payload for fx module definitions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(deny_unknown_fields)]
pub struct StoredFxModuleRequest {
    /// Target stored object identifiers.
    pub identifiers: Identifiers,
    /// Plugin module name resolved under the app data `fx-modules` directory.
    pub module_name: String,
    /// Replacement spatial selection, when provided.
    pub selection: Option<SpatialSelection>,
    /// Replacement or merged config entries.
    #[typeshare(serialized_as = "Record<String, String>")]
    pub config: HashMap<String, String>,
    /// Merge new config into existing config instead of replacing it.
    pub merge: bool,
}

/// Lifecycle control commands for stored fx module objects.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum FxModuleControlAction {
    /// Start the addressed stored fx module object.
    Start(u32),
    /// Stop the addressed stored fx module object.
    Stop(u32),
}

/// Commands for stored fx module management and control.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum FxModuleCommand {
    /// Create or update a stored fx module object.
    StoreFxModule(StoredFxModuleRequest),
    /// Move a stored fx module object to a different numeric ID.
    MoveFxModule {
        /// Current numeric ID of the stored fx module object.
        id: u32,
        /// Destination numeric ID for the stored fx module object.
        new_id: u32,
    },
    /// Remove a stored fx module object by numeric ID.
    DeleteFxModule(u32),
    /// Restore an exactly identified stored fx module removed by undoable deletion.
    RestoreDeletedFxModule(StoredFxModule),
    /// Start or stop a stored fx module object.
    ControlFxModule(FxModuleControlAction),
    /// List WebAssembly fx modules currently available on disk.
    ListAvailableFxModules,
}

impl IngressCommand for FxModuleCommand {}

/// High-frequency FX module preview changes during editing.
#[derive(Debug, Clone, Serialize, Deserialize, Message)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum FxModulePreviewUpdate {
    /// Start previewing a fx module definition.
    StartPreview(StoredFxModule),
    /// Update the active fx module preview, recreating isolated runtime state.
    UpdatePreview(StoredFxModule),
    /// Stop preview and release previewed layers.
    StopPreview,
}

/// Runtime notifications emitted by active fx module evaluation.
#[derive(Debug, Clone)]
pub enum FxModuleRuntimeNotification {
    /// A stored fx module failed to instantiate when activated.
    InstantiationFailed {
        /// Numeric stored fx module ID that failed to activate.
        fx_module_id: u32,
        /// Module name resolved from the stored fx module definition.
        module_name: String,
        /// User-facing runtime error summary.
        error: String,
    },
}

/// Active fx module IDs that have been started.
#[derive(Resource, Default, Debug)]
pub struct ActiveFxModuleIds(pub HashSet<u32>);

/// Playback clocks pending application to active fx module runtimes.
#[derive(Resource, Default, Debug)]
pub struct ActiveFxModuleTimings(pub HashMap<u32, InstanceClock>);

/// Runtime clip binding for a stored fx module playback.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FxModuleClipBinding {
    /// Numeric stored fx module ID activated for this clip.
    pub fx_module_id: u32,
    /// Shared clip start metadata retained until the layer entity is available.
    pub start_context: ClipInstanceStartContext,
}

/// Clip slots currently routed to active fx module IDs.
#[derive(Resource, Default, Debug)]
pub struct FxModuleClipBindings(pub HashMap<u32, FxModuleClipBinding>);

/// Generic FX commands forwarded to the module domain and eligible for undo capture.
#[derive(Resource, Default)]
pub(crate) struct ForwardedFxModuleCommands(pub(crate) HashSet<CommandId>);

/// Plugin for stored fx module object management and control.
pub struct FxModulePlugin;

/// Discovers packaged and installed modules using the active show's runtime precedence.
pub fn list_available_fx_modules() -> Result<ListAvailableFxModulesResponse, String> {
    let data_dir = nightfall::nightfall_data_dir()
        .ok_or_else(|| "could not determine nightfall app data directory".to_string())?;
    list_available_fx_modules_in(&data_dir, nightfall::active_show_data_dir().as_deref())
}

/// Lists each resolvable module once across explicit show and application roots, sorted by name.
fn list_available_fx_modules_in(
    data_dir: &std::path::Path,
    show_root: Option<&std::path::Path>,
) -> Result<ListAvailableFxModulesResponse, String> {
    let mut modules = HashMap::new();
    for root in show_root.into_iter().chain(std::iter::once(data_dir)) {
        let module_dir = root.join("fx-modules");
        let read_dir = match fs::read_dir(&module_dir) {
            Ok(read_dir) => read_dir,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "failed to read fx module directory {}: {}",
                    module_dir.display(),
                    error
                ));
            }
        };
        for entry_result in read_dir {
            let entry = entry_result.map_err(|error| {
                format!(
                    "failed to read fx module directory entry in {}: {}",
                    module_dir.display(),
                    error
                )
            })?;
            let filename = entry.file_name().to_string_lossy().to_string();
            let Some(name) = filename.strip_suffix(".wasm") else {
                continue;
            };
            if name.is_empty() || modules.contains_key(name) {
                continue;
            }
            // Resolve catalog entries exactly as playback does, including show-local link checks.
            let Ok(path) = instances::fx_module_path_in(&filename, show_root, data_dir) else {
                continue;
            };
            if !path.is_file() {
                continue;
            }
            modules.insert(
                name.to_string(),
                AvailableFxModuleInfo {
                    name: name.to_string(),
                    filename,
                },
            );
        }
    }
    let mut modules: Vec<_> = modules.into_values().collect();
    modules.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.filename.cmp(&b.filename))
    });
    Ok(ListAvailableFxModulesResponse { modules })
}

impl Plugin for FxModulePlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<DataProvider<StoredFxModule>>();
        app.init_resource::<ActiveFxModuleIds>();
        app.init_resource::<ActiveFxModuleTimings>();
        app.init_resource::<FxModuleClipBindings>();
        app.init_resource::<ForwardedFxModuleCommands>();
        app.add_message::<DomainInstanceReconstructionRequest>();
        app.insert_non_send(instances::FxModuleRuntimeStates::default());
        app.insert_non_send(instances::PreviewFxModuleRuntimeStates::default());

        register_ingress_command::<FxModuleCommand>(app);
        app.add_message::<FxModulePreviewUpdate>();
        register_engine_action::<events::FxModulePlaybackAction>(app);
        app.add_message::<EventEnvelope<ClipInstanceAttachment>>();
        app.add_message::<RequestEnvelope<ClipInstanceRequest>>();
        app.add_message::<NotificationEnvelope<FxModuleRuntimeNotification>>();
        nightfall_engine::protocol::dispatch_ast::register_converter::<
            ast_conv::FxModuleAstConverter,
        >();
        register_command_deserializer::<FxModuleCommand>(
            app,
            websocket::deserialize_fx_module_command,
        );
        register_update_deserializer(
            app,
            "FxModulePreviewUpdate",
            websocket::deserialize_fx_module_preview_update,
        );

        app.world_mut()
            .resource_mut::<nightfall_undo::prelude::UndoRegistry>()
            .register::<FxModuleCommand>();

        app.add_systems(
            Update,
            (
                events::forward_generic_fx_management_commands
                    .before(nightfall_fx::events::crud_events),
                events::handle_events,
                events::handle_domain_playback_reconstruction_requests,
                events::handle_clip_commands,
                events::handle_preview_commands,
                instances::cleanup_inactive_fx_module,
                instances::cleanup_preview_fx_module_runtimes,
            )
                .chain()
                .in_set(EventHandling),
        );
        app.add_systems(
            Update,
            (
                websocket::forward_fx_module_commands,
                websocket::send_fx_module_on_change,
            )
                .in_set(ClientOutput),
        );
        app.add_systems(
            Update,
            instances::evaluate_fx_module.in_set(LayerGeneration),
        );
        app.add_systems(
            Update,
            instances::evaluate_preview_fx_module.in_set(LayerGeneration),
        );
        app.add_systems(
            Update,
            instances::cleanup_released_fx_module_layers.in_set(EventHandling),
        );
        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );
    }
}

/// Host input provided once when a fx module instance is created.
///
/// `config_json` is intentionally opaque to the shared ABI so each module can
/// own its own configuration schema without forcing every module through one
/// global parameter type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FxModuleInitInput {
    /// Stable runtime instance identifier for this active FX module instance.
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub fx_instance_id: Uuid,
    /// Human-readable label for logs and diagnostics.
    pub label: String,
    /// Module-owned configuration payload serialized as JSON.
    pub config_json: String,
    /// Optional deterministic random seed passed by the host at activation.
    pub random_seed: Option<u64>,
}

/// Per-tick render input for a fx module instance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FxModuleRenderInput {
    /// Monotonic host time in microseconds for the current tick.
    pub now_micros: u64,
    /// Frame delta in microseconds since the previous render call.
    pub delta_micros: u64,
    /// Elapsed time in microseconds since this instance was started.
    pub elapsed_since_start_micros: u64,
    /// Ordered, host-resolved selection for this render tick.
    pub selection: Vec<SelectedTarget>,
    /// Host-resolved spatial selection organized as projection grid cells.
    pub selection_grid: SelectedGrid,
}

/// A single selected target passed into fx module render calls.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelectedTarget {
    /// Fixture UID in simple UUID string format.
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub fixture_uid: Uuid,
    /// Optional element index for per-element selections.
    pub element_index: Option<u32>,
    /// Host-resolved attributes that are available on this selected target.
    pub available_attributes: Vec<Attribute>,
}

/// A grid cell in the host-resolved spatial selection projection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelectedCell {
    /// Zero-based X coordinate within the resolved projection grid.
    pub x: u32,
    /// Zero-based Y coordinate within the resolved projection grid.
    pub y: u32,
    /// Zero-based Z coordinate within the resolved projection grid.
    pub z: u32,
    /// Ordered targets that occupy this projection cell.
    pub targets: Vec<SelectedTarget>,
}

/// Host-resolved spatial selection organized into projection grid cells.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SelectedGrid {
    /// Number of X columns in the resolved projection.
    pub width: u32,
    /// Number of Y rows in the resolved projection.
    pub height: u32,
    /// Number of Z layers in the resolved projection.
    pub depth: u32,
    /// Row-major cells for every projection coordinate.
    pub cells: Vec<SelectedCell>,
}

/// An FX module-facing layer payload.
///
/// This intentionally excludes host-owned fields such as `creator`,
/// `priority`, and `activation_time`. The host supplies those when the payload
/// is materialized into the engine compositor `Layer`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FxModuleLayer {
    /// Absolute parameter assertions.
    pub absolute: Vec<FxModuleLayerInstruction>,
    /// Relative parameter assertions.
    pub relative: Vec<FxModuleLayerInstruction>,
}

/// A single layer instruction addressed by stable show-domain identifiers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FxModuleLayerInstruction {
    /// Fixture UID in simple UUID string format.
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub fixture_uid: Uuid,
    /// Optional element index for per-element assertions.
    pub element_index: Option<u32>,
    /// Target attribute label.
    pub attribute: Attribute,
    /// Value to assert for the addressed attribute.
    pub value: ParameterValue,
    /// Optional transition timing to attach to the asserted value.
    pub materialized_transition: Option<FxModuleMaterializedTransition>,
}

/// Guest-facing representation of transition timing on a layer value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FxModuleMaterializedTransition {
    /// Fade-in delay in microseconds.
    pub delay_in_micros: u64,
    /// Fade-in duration in microseconds.
    pub fade_in_micros: u64,
    /// Fade-in curve.
    pub curve_in: FadeCurve,
    /// Fade-out delay in microseconds.
    pub delay_out_micros: u64,
    /// Fade-out duration in microseconds.
    pub fade_out_micros: u64,
    /// Fade-out curve.
    pub curve_out: FadeCurve,
}

impl FxModuleMaterializedTransition {
    /// Convert this guest-facing transition to the engine transition type.
    pub fn to_engine(&self, start_position: Duration) -> MaterializedTransition {
        MaterializedTransition {
            delay_in: Duration::from_micros(self.delay_in_micros),
            fade_in: Duration::from_micros(self.fade_in_micros),
            curve_in: self.curve_in,
            delay_out: Duration::from_micros(self.delay_out_micros),
            fade_out: Duration::from_micros(self.fade_out_micros),
            curve_out: self.curve_out,
            start_position,
            release_position: None,
        }
    }
}

/// Error codes that an FX module guest can return to the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FxModuleErrorCode {
    /// FX module configuration was invalid.
    InvalidConfig,
    /// FX module rejected the provided render input.
    InvalidInput,
    /// FX module requested a host capability that failed.
    HostAccessFailed,
    /// FX module hit an internal runtime error.
    Internal,
}

/// Structured guest error returned from component calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Error)]
#[error("{code:?}: {message}")]
pub struct FxModuleError {
    /// Machine-readable error code.
    pub code: FxModuleErrorCode,
    /// Human-readable diagnostic message.
    pub message: String,
}

/// Host capability surface exposed to fx module guests.
pub trait FxModuleHost {
    /// Look up the fixture definition for a selected fixture.
    fn get_fixture(&self, fixture_uid: Uuid) -> Result<Option<Fixture>, FxModuleError>;
}

/// Rust SDK trait matching the exported guest lifecycle.
pub trait FxModuleGuest {
    /// Initialize a newly-activated fx module instance.
    fn init(&mut self, input: &FxModuleInitInput) -> Result<(), FxModuleError>;

    /// Render the next Layer payload for the current tick.
    fn render(&mut self, input: &FxModuleRenderInput) -> Result<FxModuleLayer, FxModuleError>;

    /// Tear down the active fx module instance.
    fn teardown(&mut self) -> Result<(), FxModuleError>;
}

#[cfg(test)]
mod tests {
    use std::fs;

    use nightfall_dmx::prelude::Percentage;

    use super::*;

    #[test]
    fn init_input_serializes_uuid_in_simple_format() {
        let input = FxModuleInitInput {
            fx_instance_id: Uuid::parse_str("12345678-1234-5678-1234-567812345678").unwrap(),
            label: "Sparkle".to_string(),
            config_json: "{\"speed\":2}".to_string(),
            random_seed: Some(5),
        };

        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(
            json.get("fx_instance_id").and_then(|value| value.as_str()),
            Some("12345678123456781234567812345678")
        );
    }

    /// Installed modules remain sorted and exclude non-module files.
    #[test]
    fn list_available_fx_modules_returns_sorted_wasm_files() {
        let temp_dir = tempfile::tempdir().unwrap();
        let module_dir = temp_dir.path().join("fx-modules");
        fs::create_dir_all(&module_dir).unwrap();
        fs::write(module_dir.join("zeta.wasm"), []).unwrap();
        fs::write(module_dir.join("alpha.wasm"), []).unwrap();
        fs::write(module_dir.join("notes.txt"), []).unwrap();

        let response = list_available_fx_modules_in(temp_dir.path(), None).unwrap();

        assert_eq!(
            response.modules,
            vec![
                AvailableFxModuleInfo {
                    name: "alpha".to_string(),
                    filename: "alpha.wasm".to_string(),
                },
                AvailableFxModuleInfo {
                    name: "zeta".to_string(),
                    filename: "zeta.wasm".to_string(),
                },
            ]
        );
    }

    /// An uninitialized installed library produces an empty catalog.
    #[test]
    fn list_available_fx_modules_treats_missing_directory_as_empty() {
        let temp_dir = tempfile::tempdir().unwrap();
        let response = list_available_fx_modules_in(temp_dir.path(), None).unwrap();

        assert!(response.modules.is_empty());
    }

    /// Packaged-only modules remain discoverable, duplicates resolve locally, and switching shows drops old entries.
    #[test]
    fn module_discovery_combines_show_and_installed_libraries() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        let show = directory.path().join("show");
        fs::create_dir_all(show.join("fx-modules")).unwrap();
        fs::write(show.join("fx-modules/shared.wasm"), b"packaged").unwrap();
        fs::write(show.join("fx-modules/local.wasm"), []).unwrap();
        fs::write(show.join("fx-modules/notes.txt"), []).unwrap();
        fs::create_dir(show.join("fx-modules/directory.wasm")).unwrap();
        let response = list_available_fx_modules_in(&data, Some(&show)).unwrap();
        assert_eq!(
            response
                .modules
                .iter()
                .map(|module| module.name.as_str())
                .collect::<Vec<_>>(),
            ["local", "shared"]
        );
        fs::create_dir_all(data.join("fx-modules")).unwrap();
        fs::write(data.join("fx-modules/shared.wasm"), b"installed").unwrap();
        fs::write(data.join("fx-modules/installed.wasm"), []).unwrap();
        let response = list_available_fx_modules_in(&data, Some(&show)).unwrap();
        assert_eq!(
            response
                .modules
                .iter()
                .map(|module| module.name.as_str())
                .collect::<Vec<_>>(),
            ["installed", "local", "shared"]
        );
        assert_eq!(
            fs::read(instances::fx_module_path_in("shared", Some(&show), &data).unwrap()).unwrap(),
            b"packaged"
        );
        let other_show = directory.path().join("other-show");
        let response = list_available_fx_modules_in(&data, Some(&other_show)).unwrap();
        assert_eq!(
            response
                .modules
                .iter()
                .map(|module| module.name.as_str())
                .collect::<Vec<_>>(),
            ["installed", "shared"]
        );
        assert_eq!(
            fs::read(instances::fx_module_path_in("shared", Some(&other_show), &data).unwrap())
                .unwrap(),
            b"installed"
        );
    }

    /// Discovery follows runtime link validation and never advertises a shadowed module that playback rejects.
    #[cfg(unix)]
    #[test]
    fn module_discovery_rejects_escaping_show_links() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        let show = directory.path().join("show");
        fs::create_dir_all(data.join("fx-modules")).unwrap();
        fs::create_dir_all(show.join("fx-modules")).unwrap();
        fs::write(data.join("fx-modules/escape.wasm"), []).unwrap();
        fs::write(show.join("component.bin"), []).unwrap();
        symlink(
            data.join("fx-modules/escape.wasm"),
            show.join("fx-modules/escape.wasm"),
        )
        .unwrap();
        symlink(
            show.join("component.bin"),
            show.join("fx-modules/safe.wasm"),
        )
        .unwrap();
        let response = list_available_fx_modules_in(&data, Some(&show)).unwrap();
        assert_eq!(
            response.modules,
            [AvailableFxModuleInfo {
                name: "safe".to_string(),
                filename: "safe.wasm".to_string()
            }]
        );
    }

    #[test]
    fn fx_module_transition_converts_to_engine_materialized_transition() {
        let start_position = Duration::from_millis(25);
        let transition = FxModuleMaterializedTransition {
            delay_in_micros: 10,
            fade_in_micros: 20,
            curve_in: FadeCurve::EaseIn,
            delay_out_micros: 30,
            fade_out_micros: 40,
            curve_out: FadeCurve::EaseOut,
        };

        let engine = transition.to_engine(start_position);

        assert_eq!(engine.delay_in, Duration::from_micros(10));
        assert_eq!(engine.fade_in, Duration::from_micros(20));
        assert_eq!(engine.curve_in, FadeCurve::EaseIn);
        assert_eq!(engine.delay_out, Duration::from_micros(30));
        assert_eq!(engine.fade_out, Duration::from_micros(40));
        assert_eq!(engine.curve_out, FadeCurve::EaseOut);
        assert_eq!(engine.start_position, start_position);
    }

    #[test]
    fn layer_instruction_round_trips_parameter_value_and_transition() {
        let instruction = FxModuleLayerInstruction {
            fixture_uid: Uuid::parse_str("87654321-4321-8765-4321-876543218765").unwrap(),
            element_index: Some(2),
            attribute: Attribute::Custom {
                label: "ColorWheel".to_string(),
            },
            value: ParameterValue::RelativePercent {
                offset: Percentage::from(0.25),
            },
            materialized_transition: Some(FxModuleMaterializedTransition {
                delay_in_micros: 100,
                fade_in_micros: 200,
                curve_in: FadeCurve::Linear,
                delay_out_micros: 300,
                fade_out_micros: 400,
                curve_out: FadeCurve::EaseInOut,
            }),
        };

        let json = serde_json::to_string(&instruction).unwrap();
        let decoded: FxModuleLayerInstruction = serde_json::from_str(&json).unwrap();

        assert_eq!(decoded, instruction);
    }
}
