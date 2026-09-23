// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

wit_bindgen::generate!({
    path: "../../wit",
    world: "fx-module",
});

use std::cell::RefCell;

use exports::nightfall::fx_module::guest::Guest;
use nightfall::fx_module::shared::{
    ErrorCode, FxModuleError, FxModuleLayer, InitInput, LayerInstruction, ParameterValue,
    RenderInput,
};

/// Guest module fixture used by FX module runtime integration tests.
struct TestGuest;

/// Mutable counter state owned by the example FX module.
struct State {
    seed: u64,
    renders: u32,
    fixture_metadata_mode: bool,
    invalid_fixture_uid_mode: bool,
    elapsed_millis_mode: bool,
    delta_millis_mode: bool,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

impl Guest for TestGuest {
    fn init(input: InitInput) -> Result<(), FxModuleError> {
        STATE.with(|state| {
            *state.borrow_mut() = Some(State {
                seed: input.random_seed.unwrap_or_default(),
                renders: 0,
                fixture_metadata_mode: input
                    .config_json
                    .contains("\"mode\":\"fixture-metadata\""),
                invalid_fixture_uid_mode: input
                    .config_json
                    .contains("\"mode\":\"invalid-fixture-uid\""),
                elapsed_millis_mode: input.config_json.contains("\"mode\":\"elapsed-millis\""),
                delta_millis_mode: input.config_json.contains("\"mode\":\"delta-millis\""),
            });
        });
        Ok(())
    }

    fn render(input: RenderInput) -> Result<FxModuleLayer, FxModuleError> {
        let target = input.selection.into_iter().next().ok_or_else(|| FxModuleError {
            code: ErrorCode::InvalidInput,
            message: "selection is required".to_string(),
        })?;

        let fixture_metadata_mode = STATE.with(|state| {
            state
                .borrow()
                .as_ref()
                .expect("guest state should be initialized")
                .fixture_metadata_mode
        });
        if fixture_metadata_mode {
            return render_fixture_metadata_layer(target);
        }

        let invalid_fixture_uid_mode = STATE.with(|state| {
            state
                .borrow()
                .as_ref()
                .expect("guest state should be initialized")
                .invalid_fixture_uid_mode
        });
        if invalid_fixture_uid_mode {
            return Ok(FxModuleLayer {
                absolute: vec![LayerInstruction {
                    fixture_uid: "not-a-uuid".to_string(),
                    element_index: target.element_index,
                    attribute: "Intensity".to_string(),
                    value: ParameterValue::Absolute(1.0),
                    materialized_transition: None,
                }],
                relative: vec![],
            });
        }

        let elapsed_millis_mode = STATE.with(|state| {
            state
                .borrow()
                .as_ref()
                .expect("guest state should be initialized")
                .elapsed_millis_mode
        });
        if elapsed_millis_mode {
            return Ok(FxModuleLayer {
                absolute: vec![LayerInstruction {
                    fixture_uid: target.fixture_uid,
                    element_index: target.element_index,
                    attribute: "Intensity".to_string(),
                    value: ParameterValue::Absolute(
                        input.elapsed_since_start_micros as f64 / 1_000.0,
                    ),
                    materialized_transition: None,
                }],
                relative: vec![],
            });
        }

        let delta_millis_mode = STATE.with(|state| {
            state
                .borrow()
                .as_ref()
                .expect("guest state should be initialized")
                .delta_millis_mode
        });
        if delta_millis_mode {
            return Ok(FxModuleLayer {
                absolute: vec![LayerInstruction {
                    fixture_uid: target.fixture_uid,
                    element_index: target.element_index,
                    attribute: "Intensity".to_string(),
                    value: ParameterValue::Absolute(input.delta_micros as f64 / 1_000.0),
                    materialized_transition: None,
                }],
                relative: vec![],
            });
        }

        let value = STATE.with(|state| {
            let mut state = state.borrow_mut();
            let state = state.as_mut().expect("guest state should be initialized");
            let value = state.seed as f64 + state.renders as f64;
            state.renders += 1;
            value
        });

        Ok(FxModuleLayer {
            absolute: vec![LayerInstruction {
                fixture_uid: target.fixture_uid,
                element_index: target.element_index,
                attribute: "Intensity".to_string(),
                value: ParameterValue::Absolute(value),
                materialized_transition: None,
            }],
            relative: vec![],
        })
    }

    fn teardown() -> Result<(), FxModuleError> {
        STATE.with(|state| {
            *state.borrow_mut() = None;
        });
        Ok(())
    }
}

fn render_fixture_metadata_layer(
    target: nightfall::fx_module::shared::SelectedTarget,
) -> Result<FxModuleLayer, FxModuleError> {
    let fixture = nightfall::fx_module::host::get_fixture(&target.fixture_uid)?
        .ok_or_else(|| FxModuleError {
            code: ErrorCode::HostAccessFailed,
            message: format!("fixture {} was not found", target.fixture_uid),
        })?;
    let selected_element = target
        .element_index
        .and_then(|index| index.checked_sub(1))
        .and_then(|index| fixture.elements.get(index as usize))
        .or_else(|| fixture.elements.first())
        .ok_or_else(|| FxModuleError {
            code: ErrorCode::InvalidInput,
            message: "fixture metadata did not include a selected element".to_string(),
        })?;
    let first_parameter = selected_element
        .parameters
        .first()
        .ok_or_else(|| FxModuleError {
            code: ErrorCode::InvalidInput,
            message: "fixture metadata did not include parameter metadata".to_string(),
        })?;

    let mut value = selected_element.parameters.len() as f64;
    if first_parameter.attribute == "Intensity" {
        value += 10.0;
    }
    if first_parameter.is_snap {
        value += 100.0;
    }
    if first_parameter.use_grandmaster {
        value += 1_000.0;
    }
    if matches!(
        first_parameter.merge_type,
        nightfall::fx_module::shared::MergeStrategy::Ltp
    ) {
        value += 10_000.0;
    }

    Ok(FxModuleLayer {
        absolute: vec![LayerInstruction {
            fixture_uid: target.fixture_uid,
            element_index: target.element_index,
            attribute: "Intensity".to_string(),
            value: ParameterValue::Absolute(value),
            materialized_transition: None,
        }],
        relative: vec![],
    })
}

export!(TestGuest);
