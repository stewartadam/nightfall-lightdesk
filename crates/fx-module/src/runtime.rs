// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::path::{Path, PathBuf};
use std::str::FromStr;

use nightfall::prelude::{FadeCurve, Identifiers};
use nightfall_dmx::prelude::{
    Attribute, DmxValueResolution, ParameterUnit, ParameterValue, Percentage,
};
use nightfall_fixtures::prelude::{
    BeamType, Fixture, FixtureElement, FixturePhysical, FixturePlacement, MergeStrategy,
    ParameterMetadata,
};
use thiserror::Error;
use uuid::Uuid;
use wasmtime::component::{Component, HasSelf, Linker};
use wasmtime::{Engine, Store};

use crate::{
    FxModuleError, FxModuleErrorCode, FxModuleHost, FxModuleInitInput, FxModuleLayer,
    FxModuleLayerInstruction, FxModuleMaterializedTransition, FxModuleRenderInput, SelectedCell,
    SelectedGrid, SelectedTarget,
};

mod bindings {
    wasmtime::component::bindgen!({
        path: "wit",
        world: "fx-module",
    });
}

/// Errors raised by the fx module runtime host.
#[derive(Debug, Error)]
pub enum FxModuleRuntimeError {
    /// Loading component bytes from disk failed.
    #[error("failed to load fx module component bytes from {path}: {source}")]
    Io {
        /// Resolved module path attempted by the host.
        path: PathBuf,
        /// Underlying filesystem error.
        #[source]
        source: std::io::Error,
    },
    /// Wasmtime failed to compile, link, or invoke the component.
    #[error("failed to execute fx module component")]
    Wasmtime(#[from] wasmtime::Error),
    /// The guest returned a structured FX module error.
    #[error("{0}")]
    Guest(FxModuleError),
    /// Component bytes did not validate as a fx module component.
    #[error("component validation failed: {0}")]
    Validation(String),
}

/// Compiled fx module component bytes ready for instantiation.
pub struct FxModuleComponent {
    engine: Engine,
    component: Component,
}

impl FxModuleComponent {
    /// Load and compile a fx module component from raw bytes.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, FxModuleRuntimeError> {
        let engine = Engine::default();
        let component = Component::new(&engine, bytes)
            .map_err(|error| FxModuleRuntimeError::Validation(error.to_string()))?;
        Ok(Self { engine, component })
    }

    /// Load and compile a fx module component from a file path.
    pub fn from_file(path: impl AsRef<Path>) -> Result<Self, FxModuleRuntimeError> {
        let path = path.as_ref();
        let bytes = std::fs::read(path).map_err(|source| FxModuleRuntimeError::Io {
            path: path.to_path_buf(),
            source,
        })?;

        let engine = Engine::default();
        let component = Component::new(&engine, &bytes).map_err(|error| {
            FxModuleRuntimeError::Validation(format_component_validation_error(path, &error))
        })?;

        Ok(Self { engine, component })
    }

    /// Instantiate this component with the provided host capabilities.
    pub fn instantiate<H: FxModuleHost + 'static>(
        &self,
        host: H,
    ) -> Result<FxModuleInstance<H>, FxModuleRuntimeError> {
        let mut linker = Linker::new(&self.engine);
        bindings::FxModule::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)?;

        let mut store = Store::new(&self.engine, RuntimeStore { host });
        let bindings = bindings::FxModule::instantiate(&mut store, &self.component, &linker)?;

        Ok(FxModuleInstance { store, bindings })
    }
}

/// Active instantiated fx module component.
pub struct FxModuleInstance<H: 'static> {
    store: Store<RuntimeStore<H>>,
    bindings: bindings::FxModule,
}

impl<H: FxModuleHost + 'static> FxModuleInstance<H> {
    /// Initialize the active component instance.
    pub fn init(&mut self, input: &FxModuleInitInput) -> Result<(), FxModuleRuntimeError> {
        let result = self
            .bindings
            .nightfall_fx_module_guest()
            .call_init(&mut self.store, &to_wit_init_input(input))?;
        result.map_err(from_wit_error)
    }

    /// Render the next Layer payload for the current tick.
    pub fn render(
        &mut self,
        input: &FxModuleRenderInput,
    ) -> Result<FxModuleLayer, FxModuleRuntimeError> {
        let result = self
            .bindings
            .nightfall_fx_module_guest()
            .call_render(&mut self.store, &to_wit_render_input(input))?;
        let layer = result.map_err(from_wit_error)?;
        from_wit_fx_module_layer(layer)
    }

    /// Tear down the active component instance.
    pub fn teardown(&mut self) -> Result<(), FxModuleRuntimeError> {
        let result = self
            .bindings
            .nightfall_fx_module_guest()
            .call_teardown(&mut self.store)?;
        result.map_err(from_wit_error)
    }
}

/// Registry of loaded FX module definitions and active runtime instances.
struct RuntimeStore<H> {
    host: H,
}

impl<H: FxModuleHost> bindings::nightfall::fx_module::shared::Host for RuntimeStore<H> {}

impl<H: FxModuleHost> bindings::nightfall::fx_module::host::Host for RuntimeStore<H> {
    fn get_fixture(
        &mut self,
        fixture_uid: String,
    ) -> Result<
        Option<bindings::nightfall::fx_module::shared::Fixture>,
        bindings::nightfall::fx_module::shared::FxModuleError,
    > {
        let fixture_uid = Uuid::parse_str(&fixture_uid).map_err(|error| {
            to_wit_error(&FxModuleError {
                code: FxModuleErrorCode::InvalidInput,
                message: format!("invalid fixture uid provided by guest: {error}"),
            })
        })?;

        let fixture = self
            .host
            .get_fixture(fixture_uid)
            .map_err(|error| to_wit_error(&error))?;

        Ok(fixture.map(to_wit_fixture))
    }
}

fn from_wit_error(
    error: bindings::nightfall::fx_module::shared::FxModuleError,
) -> FxModuleRuntimeError {
    FxModuleRuntimeError::Guest(FxModuleError {
        code: from_wit_error_code(error.code),
        message: error.message,
    })
}

fn from_wit_error_code(
    error: bindings::nightfall::fx_module::shared::ErrorCode,
) -> FxModuleErrorCode {
    match error {
        bindings::nightfall::fx_module::shared::ErrorCode::InvalidConfig => {
            FxModuleErrorCode::InvalidConfig
        }
        bindings::nightfall::fx_module::shared::ErrorCode::InvalidInput => {
            FxModuleErrorCode::InvalidInput
        }
        bindings::nightfall::fx_module::shared::ErrorCode::HostAccessFailed => {
            FxModuleErrorCode::HostAccessFailed
        }
        bindings::nightfall::fx_module::shared::ErrorCode::Internal => FxModuleErrorCode::Internal,
    }
}

fn format_component_validation_error(path: &Path, error: &wasmtime::Error) -> String {
    let mut message = format!("{error} [path: {}]", path.display());
    if error
        .to_string()
        .contains("failed to parse WebAssembly module")
    {
        message.push_str(
            " [hint: expected a WebAssembly component; plain wasm32-unknown-unknown guest modules must be componentized before they can be loaded as fx module]",
        );
    }
    message
}

fn to_wit_error(error: &FxModuleError) -> bindings::nightfall::fx_module::shared::FxModuleError {
    bindings::nightfall::fx_module::shared::FxModuleError {
        code: to_wit_error_code(error.code),
        message: error.message.clone(),
    }
}

fn to_wit_error_code(
    error: FxModuleErrorCode,
) -> bindings::nightfall::fx_module::shared::ErrorCode {
    match error {
        FxModuleErrorCode::InvalidConfig => {
            bindings::nightfall::fx_module::shared::ErrorCode::InvalidConfig
        }
        FxModuleErrorCode::InvalidInput => {
            bindings::nightfall::fx_module::shared::ErrorCode::InvalidInput
        }
        FxModuleErrorCode::HostAccessFailed => {
            bindings::nightfall::fx_module::shared::ErrorCode::HostAccessFailed
        }
        FxModuleErrorCode::Internal => bindings::nightfall::fx_module::shared::ErrorCode::Internal,
    }
}

fn to_wit_init_input(
    input: &FxModuleInitInput,
) -> bindings::nightfall::fx_module::shared::InitInput {
    bindings::nightfall::fx_module::shared::InitInput {
        fx_instance_id: input.fx_instance_id.simple().to_string(),
        label: input.label.clone(),
        config_json: input.config_json.clone(),
        random_seed: input.random_seed,
    }
}

fn to_wit_render_input(
    input: &FxModuleRenderInput,
) -> bindings::nightfall::fx_module::shared::RenderInput {
    bindings::nightfall::fx_module::shared::RenderInput {
        now_micros: input.now_micros,
        delta_micros: input.delta_micros,
        elapsed_since_start_micros: input.elapsed_since_start_micros,
        selection: input.selection.iter().map(to_wit_selected_target).collect(),
        selection_grid: to_wit_selected_grid(&input.selection_grid),
    }
}

fn to_wit_selected_target(
    target: &SelectedTarget,
) -> bindings::nightfall::fx_module::shared::SelectedTarget {
    bindings::nightfall::fx_module::shared::SelectedTarget {
        fixture_uid: target.fixture_uid.simple().to_string(),
        element_index: target.element_index,
        available_attributes: target
            .available_attributes
            .iter()
            .map(to_wit_attribute)
            .collect(),
    }
}

/// Convert a host-selected projection grid to the guest ABI representation.
fn to_wit_selected_grid(
    grid: &SelectedGrid,
) -> bindings::nightfall::fx_module::shared::SelectedGrid {
    bindings::nightfall::fx_module::shared::SelectedGrid {
        width: grid.width,
        height: grid.height,
        depth: grid.depth,
        cells: grid.cells.iter().map(to_wit_selected_cell).collect(),
    }
}

/// Convert a host-selected projection cell to the guest ABI representation.
fn to_wit_selected_cell(
    cell: &SelectedCell,
) -> bindings::nightfall::fx_module::shared::SelectedCell {
    bindings::nightfall::fx_module::shared::SelectedCell {
        x: cell.x,
        y: cell.y,
        z: cell.z,
        targets: cell.targets.iter().map(to_wit_selected_target).collect(),
    }
}

fn from_wit_fx_module_layer(
    layer: bindings::nightfall::fx_module::shared::FxModuleLayer,
) -> Result<FxModuleLayer, FxModuleRuntimeError> {
    Ok(FxModuleLayer {
        absolute: layer
            .absolute
            .into_iter()
            .map(from_wit_layer_instruction)
            .collect::<Result<Vec<_>, _>>()?,
        relative: layer
            .relative
            .into_iter()
            .map(from_wit_layer_instruction)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

fn from_wit_layer_instruction(
    instruction: bindings::nightfall::fx_module::shared::LayerInstruction,
) -> Result<FxModuleLayerInstruction, FxModuleRuntimeError> {
    let fixture_uid = Uuid::parse_str(&instruction.fixture_uid).map_err(|error| {
        FxModuleRuntimeError::Guest(FxModuleError {
            code: FxModuleErrorCode::InvalidInput,
            message: format!(
                "guest returned invalid fixture uid '{}': {error}",
                instruction.fixture_uid
            ),
        })
    })?;

    Ok(FxModuleLayerInstruction {
        fixture_uid,
        element_index: instruction.element_index,
        attribute: from_wit_attribute(instruction.attribute),
        value: from_wit_parameter_value(instruction.value),
        materialized_transition: instruction.materialized_transition.map(from_wit_transition),
    })
}

fn from_wit_transition(
    transition: bindings::nightfall::fx_module::shared::MaterializedTransition,
) -> FxModuleMaterializedTransition {
    FxModuleMaterializedTransition {
        delay_in_micros: transition.delay_in_micros,
        fade_in_micros: transition.fade_in_micros,
        curve_in: from_wit_fade_curve(transition.curve_in),
        delay_out_micros: transition.delay_out_micros,
        fade_out_micros: transition.fade_out_micros,
        curve_out: from_wit_fade_curve(transition.curve_out),
    }
}

fn to_wit_fixture(fixture: Fixture) -> bindings::nightfall::fx_module::shared::Fixture {
    bindings::nightfall::fx_module::shared::Fixture {
        identifiers: to_wit_identifiers(fixture.identifiers),
        make: fixture.make,
        model: fixture.model,
        mode: fixture.mode,
        elements: fixture
            .elements
            .into_iter()
            .map(to_wit_fixture_element)
            .collect(),
        physical: fixture.physical.map(to_wit_fixture_physical),
        placement: to_wit_fixture_placement(fixture.placement),
    }
}

fn to_wit_identifiers(
    identifiers: Identifiers,
) -> bindings::nightfall::fx_module::shared::Identifiers {
    bindings::nightfall::fx_module::shared::Identifiers {
        id: identifiers.id,
        uid: identifiers.uid.simple().to_string(),
        label: identifiers.label,
    }
}

fn to_wit_fixture_element(
    element: FixtureElement,
) -> bindings::nightfall::fx_module::shared::FixtureElement {
    bindings::nightfall::fx_module::shared::FixtureElement {
        label: element.label,
        parameters: element
            .parameters
            .into_iter()
            .map(to_wit_parameter_metadata)
            .collect(),
    }
}

fn to_wit_parameter_metadata(
    metadata: ParameterMetadata,
) -> bindings::nightfall::fx_module::shared::ParameterMetadata {
    bindings::nightfall::fx_module::shared::ParameterMetadata {
        resolution: to_wit_resolution(metadata.resolution),
        attribute: to_wit_attribute(&metadata.attribute),
        native_unit: to_wit_parameter_unit(metadata.native_unit),
        min: metadata.min,
        max: metadata.max,
        offset: to_wit_parameter_value(&metadata.offset),
        is_inverted: metadata.is_inverted,
        is_snap: metadata.is_snap,
        merge_type: to_wit_merge_strategy(metadata.merge_type),
        use_grandmaster: metadata.use_grandmaster,
    }
}

/// Converts parameter units into the component-model representation.
fn to_wit_parameter_unit(
    unit: ParameterUnit,
) -> bindings::nightfall::fx_module::shared::ParameterUnit {
    match unit {
        ParameterUnit::Percent => bindings::nightfall::fx_module::shared::ParameterUnit::Percent,
        ParameterUnit::Degrees => bindings::nightfall::fx_module::shared::ParameterUnit::Degrees,
    }
}

fn to_wit_fixture_physical(
    physical: FixturePhysical,
) -> bindings::nightfall::fx_module::shared::FixturePhysical {
    bindings::nightfall::fx_module::shared::FixturePhysical {
        beam_angle: physical.beam_angle,
        field_angle: physical.field_angle,
        lumens: physical.lumens,
        color_temperature: physical.color_temperature,
        beam_type: to_wit_beam_type(physical.beam_type),
    }
}

fn to_wit_fixture_placement(
    placement: FixturePlacement,
) -> bindings::nightfall::fx_module::shared::FixturePlacement {
    bindings::nightfall::fx_module::shared::FixturePlacement {
        position: bindings::nightfall::fx_module::shared::PlacementPosition {
            x: placement.position.x,
            y: placement.position.y,
            z: placement.position.z,
        },
        rotation: bindings::nightfall::fx_module::shared::PlacementRotation {
            x: placement.rotation.x,
            y: placement.rotation.y,
            z: placement.rotation.z,
        },
    }
}

fn to_wit_attribute(attribute: &Attribute) -> String {
    match attribute {
        Attribute::Custom { label } => label.clone(),
        _ => attribute.to_string(),
    }
}

fn from_wit_attribute(attribute: String) -> Attribute {
    Attribute::from_str(&attribute).unwrap_or(Attribute::Custom { label: attribute })
}

fn to_wit_parameter_value(
    value: &ParameterValue,
) -> bindings::nightfall::fx_module::shared::ParameterValue {
    match value {
        ParameterValue::Absolute { value } => {
            bindings::nightfall::fx_module::shared::ParameterValue::Absolute(*value)
        }
        ParameterValue::AbsolutePercent { value } => {
            bindings::nightfall::fx_module::shared::ParameterValue::AbsolutePercent(value.as_f32())
        }
        ParameterValue::Relative { offset } => {
            bindings::nightfall::fx_module::shared::ParameterValue::Relative(*offset)
        }
        ParameterValue::RelativePercent { offset } => {
            bindings::nightfall::fx_module::shared::ParameterValue::RelativePercent(offset.as_f32())
        }
    }
}

fn from_wit_parameter_value(
    value: bindings::nightfall::fx_module::shared::ParameterValue,
) -> ParameterValue {
    match value {
        bindings::nightfall::fx_module::shared::ParameterValue::Absolute(value) => {
            ParameterValue::Absolute { value }
        }
        bindings::nightfall::fx_module::shared::ParameterValue::AbsolutePercent(value) => {
            ParameterValue::AbsolutePercent {
                value: Percentage::from(value),
            }
        }
        bindings::nightfall::fx_module::shared::ParameterValue::Relative(value) => {
            ParameterValue::Relative { offset: value }
        }
        bindings::nightfall::fx_module::shared::ParameterValue::RelativePercent(value) => {
            ParameterValue::RelativePercent {
                offset: Percentage::from(value),
            }
        }
    }
}

fn to_wit_beam_type(beam_type: BeamType) -> bindings::nightfall::fx_module::shared::BeamType {
    match beam_type {
        BeamType::Spot => bindings::nightfall::fx_module::shared::BeamType::Spot,
        BeamType::Wash => bindings::nightfall::fx_module::shared::BeamType::Wash,
        BeamType::Fresnel => bindings::nightfall::fx_module::shared::BeamType::Fresnel,
        BeamType::Pc => bindings::nightfall::fx_module::shared::BeamType::Pc,
        BeamType::Glow => bindings::nightfall::fx_module::shared::BeamType::Glow,
    }
}

fn to_wit_resolution(
    resolution: DmxValueResolution,
) -> bindings::nightfall::fx_module::shared::DmxValueResolution {
    match resolution {
        DmxValueResolution::Coarse => {
            bindings::nightfall::fx_module::shared::DmxValueResolution::Coarse
        }
        DmxValueResolution::Fine => {
            bindings::nightfall::fx_module::shared::DmxValueResolution::Fine
        }
        DmxValueResolution::UltraFine => {
            bindings::nightfall::fx_module::shared::DmxValueResolution::UltraFine
        }
        DmxValueResolution::Uber => {
            bindings::nightfall::fx_module::shared::DmxValueResolution::Uber
        }
    }
}

fn to_wit_merge_strategy(
    merge_strategy: MergeStrategy,
) -> bindings::nightfall::fx_module::shared::MergeStrategy {
    match merge_strategy {
        MergeStrategy::HTP => bindings::nightfall::fx_module::shared::MergeStrategy::Htp,
        MergeStrategy::LTP => bindings::nightfall::fx_module::shared::MergeStrategy::Ltp,
    }
}

fn from_wit_fade_curve(curve: bindings::nightfall::fx_module::shared::FadeCurve) -> FadeCurve {
    match curve {
        bindings::nightfall::fx_module::shared::FadeCurve::Linear => FadeCurve::Linear,
        bindings::nightfall::fx_module::shared::FadeCurve::EaseIn => FadeCurve::EaseIn,
        bindings::nightfall::fx_module::shared::FadeCurve::EaseOut => FadeCurve::EaseOut,
        bindings::nightfall::fx_module::shared::FadeCurve::EaseInOut => FadeCurve::EaseInOut,
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::sync::OnceLock;

    use wit_component::ComponentEncoder;

    use super::*;

    /// Test host that accepts FX module calls without side effects.
    struct NoopHost;

    impl FxModuleHost for NoopHost {
        fn get_fixture(&self, _fixture_uid: Uuid) -> Result<Option<Fixture>, crate::FxModuleError> {
            Ok(None)
        }
    }

    #[test]
    fn instantiates_component_and_renders_stateful_output() {
        let component = FxModuleComponent::from_bytes(test_component_bytes()).unwrap();
        let mut instance = component.instantiate(NoopHost).unwrap();

        instance
            .init(&crate::FxModuleInitInput {
                fx_instance_id: Uuid::parse_str("12345678-1234-5678-1234-567812345678").unwrap(),
                label: "test".to_string(),
                config_json: "{\"attribute\":\"intensity\"}".to_string(),
                random_seed: Some(5),
            })
            .unwrap();

        let input = crate::FxModuleRenderInput {
            now_micros: 10,
            delta_micros: 10,
            elapsed_since_start_micros: 10,
            selection: vec![crate::SelectedTarget {
                fixture_uid: Uuid::parse_str("87654321-4321-8765-4321-876543218765").unwrap(),
                element_index: Some(1),
                available_attributes: vec![Attribute::Intensity],
            }],
            selection_grid: crate::SelectedGrid::default(),
        };

        let first = instance.render(&input).unwrap();
        let second = instance.render(&input).unwrap();

        assert_eq!(first.absolute.len(), 1);
        assert_eq!(second.absolute.len(), 1);
        assert_eq!(
            first.absolute[0].value,
            ParameterValue::Absolute { value: 5.0 }
        );
        assert_eq!(
            second.absolute[0].value,
            ParameterValue::Absolute { value: 6.0 }
        );

        instance.teardown().unwrap();
    }

    /// Host adapter that exposes fixture state to a running FX module.
    struct FixtureHost {
        fixture: Fixture,
    }

    impl FxModuleHost for FixtureHost {
        fn get_fixture(&self, fixture_uid: Uuid) -> Result<Option<Fixture>, crate::FxModuleError> {
            if self.fixture.identifiers.uid == fixture_uid {
                Ok(Some(self.fixture.clone()))
            } else {
                Ok(None)
            }
        }
    }

    #[test]
    fn guest_can_fetch_fixture_metadata_from_host() {
        let component = FxModuleComponent::from_bytes(test_component_bytes()).unwrap();
        let fixture_uid = Uuid::parse_str("87654321-4321-8765-4321-876543218765").unwrap();
        let fixture = Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "fixture-1".to_string(),
            },
            make: "Acme".to_string(),
            model: "Spark".to_string(),
            mode: "Standard".to_string(),
            elements: vec![FixtureElement {
                label: "Head".to_string(),
                parameters: vec![
                    ParameterMetadata {
                        attribute: Attribute::Intensity,
                        native_unit: Attribute::Intensity.native_unit(),
                        value_polarity: Attribute::Intensity.value_polarity(),
                        is_snap: true,
                        merge_type: MergeStrategy::LTP,
                        use_grandmaster: true,
                        ..Default::default()
                    },
                    ParameterMetadata {
                        attribute: Attribute::Red,
                        native_unit: Attribute::Red.native_unit(),
                        value_polarity: Attribute::Red.value_polarity(),
                        ..Default::default()
                    },
                ],
            }],
            ..Default::default()
        };
        let mut instance = component.instantiate(FixtureHost { fixture }).unwrap();

        instance
            .init(&crate::FxModuleInitInput {
                fx_instance_id: Uuid::parse_str("12345678-1234-5678-1234-567812345678").unwrap(),
                label: "metadata".to_string(),
                config_json: "{\"mode\":\"fixture-metadata\"}".to_string(),
                random_seed: None,
            })
            .unwrap();

        let output = instance
            .render(&crate::FxModuleRenderInput {
                now_micros: 10,
                delta_micros: 10,
                elapsed_since_start_micros: 10,
                selection: vec![crate::SelectedTarget {
                    fixture_uid,
                    element_index: Some(1),
                    available_attributes: vec![Attribute::Intensity, Attribute::Red],
                }],
                selection_grid: crate::SelectedGrid::default(),
            })
            .unwrap();

        assert_eq!(output.absolute.len(), 1);
        assert_eq!(
            output.absolute[0].value,
            ParameterValue::Absolute { value: 11_112.0 }
        );

        instance.teardown().unwrap();
    }

    #[test]
    fn from_file_reports_path_and_component_hint_for_core_wasm_modules() {
        let guest_wasm = build_test_guest_module_path();
        let error = match FxModuleComponent::from_file(&guest_wasm) {
            Ok(_) => panic!("expected core wasm module to fail component validation"),
            Err(error) => error,
        };
        let message = error.to_string();

        assert!(message.contains(&guest_wasm.display().to_string()));
        assert!(message.contains("failed to parse WebAssembly module"));
        assert!(message.contains("expected a WebAssembly component"));
    }

    #[test]
    fn render_returns_guest_error_for_invalid_fixture_uid() {
        let component = FxModuleComponent::from_bytes(test_component_bytes()).unwrap();
        let mut instance = component.instantiate(NoopHost).unwrap();

        instance
            .init(&crate::FxModuleInitInput {
                fx_instance_id: Uuid::parse_str("12345678-1234-5678-1234-567812345678").unwrap(),
                label: "invalid-fixture-uid".to_string(),
                config_json: "{\"mode\":\"invalid-fixture-uid\"}".to_string(),
                random_seed: None,
            })
            .unwrap();

        let error = instance
            .render(&crate::FxModuleRenderInput {
                now_micros: 10,
                delta_micros: 10,
                elapsed_since_start_micros: 10,
                selection: vec![crate::SelectedTarget {
                    fixture_uid: Uuid::parse_str("87654321-4321-8765-4321-876543218765").unwrap(),
                    element_index: Some(1),
                    available_attributes: vec![Attribute::Intensity],
                }],
                selection_grid: crate::SelectedGrid::default(),
            })
            .expect_err("invalid guest fixture uids should not panic the host");

        match error {
            FxModuleRuntimeError::Guest(plugin_error) => {
                assert_eq!(plugin_error.code, crate::FxModuleErrorCode::InvalidInput);
                assert!(plugin_error.message.contains("invalid fixture uid"));
                assert!(plugin_error.message.contains("not-a-uuid"));
            }
            other => panic!("expected guest invalid-input error, got {other:?}"),
        }
    }

    fn test_component_bytes() -> &'static [u8] {
        static COMPONENT: OnceLock<Vec<u8>> = OnceLock::new();
        COMPONENT.get_or_init(build_test_component).as_slice()
    }

    fn build_test_component() -> Vec<u8> {
        let guest_wasm = build_test_guest_module_path();
        let module = std::fs::read(&guest_wasm).expect("failed to read module wasm");

        ComponentEncoder::default()
            .module(&module)
            .expect("failed to attach module to component encoder")
            .encode()
            .expect("failed to encode component")
    }

    fn build_test_guest_module_path() -> PathBuf {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("guest-module")
            .join("Cargo.toml");
        let guest_dir = manifest.parent().unwrap();

        let status = Command::new("cargo")
            .arg("build")
            .arg("--manifest-path")
            .arg(&manifest)
            .arg("--target")
            .arg("wasm32-unknown-unknown")
            .current_dir(guest_dir)
            .status()
            .expect("failed to build test module component");
        assert!(status.success(), "module component build failed");

        guest_dir
            .join("target")
            .join("wasm32-unknown-unknown")
            .join("debug")
            .join("fx_module_test_module.wasm")
    }
}
