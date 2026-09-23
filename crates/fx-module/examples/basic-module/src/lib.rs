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

use exports::nightfall::fx_module::guest::Guest;
use nightfall::fx_module::shared::{
    ErrorCode, FxModuleError, FxModuleLayer, InitInput, LayerInstruction, ParameterValue,
    RenderInput,
};

/// Example FX module used to demonstrate guest-module runtime behavior.
struct BasicModule;

/// Seeded phase state owned by the example FX module.
struct State {
    seed: u64,
}

thread_local! {
    static STATE: std::cell::RefCell<Option<State>> = const { std::cell::RefCell::new(None) };
}

impl Guest for BasicModule {
    /// Store the deterministic phase seed for subsequent renders.
    fn init(input: InitInput) -> Result<(), FxModuleError> {
        STATE.with(|state| {
            *state.borrow_mut() = Some(State {
                seed: input.random_seed.unwrap_or_default(),
            });
        });
        Ok(())
    }

    /// Render one seeded intensity pulse after validating fixture host access.
    fn render(input: RenderInput) -> Result<FxModuleLayer, FxModuleError> {
        let elapsed_secs = input.elapsed_since_start_micros as f64 / 1_000_000.0;
        let seed_phase = STATE.with(|state| {
            let state = state.borrow();
            let state = state.as_ref().expect("module state should be initialized");
            (state.seed % 97) as f64 * 0.03
        });

        let mut absolute = Vec::new();
        for (index, target) in input.selection.into_iter().enumerate() {
            if !target.available_attributes.iter().any(|attribute| {
                attribute == "Intensity" || attribute == "VirtualIntensity"
            }) {
                continue;
            }

            let fixture = nightfall::fx_module::host::get_fixture(&target.fixture_uid)?.ok_or_else(
                || FxModuleError {
                    code: ErrorCode::HostAccessFailed,
                    message: format!("fixture {} was not found", target.fixture_uid),
                },
            )?;
            if fixture.elements.is_empty() {
                continue;
            }

            let phase =
                elapsed_secs * std::f64::consts::TAU + seed_phase + index as f64 * 0.35;
            let value = ((phase.sin() + 1.0) * 0.5 * 255.0).clamp(0.0, 255.0);
            absolute.push(LayerInstruction {
                fixture_uid: target.fixture_uid,
                element_index: target.element_index,
                attribute: "Intensity".to_string(),
                value: ParameterValue::Absolute(value),
                materialized_transition: None,
            });
        }

        Ok(FxModuleLayer {
            absolute,
            relative: vec![],
        })
    }

    /// Release the component instance's thread-local state.
    fn teardown() -> Result<(), FxModuleError> {
        STATE.with(|state| {
            *state.borrow_mut() = None;
        });
        Ok(())
    }
}

export!(BasicModule);
