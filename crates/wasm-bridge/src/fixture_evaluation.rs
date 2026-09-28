// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Fixture channel evaluation for the web visualizer.
//!
//! The visualizer evaluates every fixture each frame, so an evaluator is
//! built once per fixture and exchanges plain `Float64Array`s rather than
//! serialized objects.

use nightfall_fixture_model::prelude::*;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

/// Number of values [`FixtureChannelEvaluator::evaluate`] writes per parameter:
/// DMX value (`NaN` without output), function index, set index (`-1` for
/// none), fraction, physical value, level and whether the parameter masters
/// its own element's emitters (`1` or `0`).
pub const READING_STRIDE: usize = 7;

/// The parameters of one fixture element, as the web UI holds them.
#[derive(Deserialize)]
struct ElementParameters {
    /// Parameter metadata in element order.
    parameters: Vec<ParameterMetadata>,
}

/// Returns the number of values written per parameter by
/// [`FixtureChannelEvaluator::evaluate`].
#[wasm_bindgen]
pub fn fixture_reading_stride() -> usize {
    READING_STRIDE
}

/// Evaluates one fixture's channels as the fixture interprets them.
#[wasm_bindgen]
pub struct FixtureChannelEvaluator {
    /// Shared evaluator of the fixture's model.
    evaluator: FixtureEvaluator,
    /// Evaluator inputs, reused between evaluations.
    inputs: Vec<Option<f32>>,
}

#[wasm_bindgen]
impl FixtureChannelEvaluator {
    /// Builds an evaluator from a fixture's elements (`FixtureElement[]` as JSON).
    ///
    /// JSON omits the optional fields a JavaScript object may hold as
    /// `undefined`, which deserializing the object directly would reject.
    /// With `linked` false, mode masters and relations naming other elements
    /// are ignored, for evaluating a lone element.
    #[wasm_bindgen(constructor)]
    pub fn new(elements_json: &str, linked: bool) -> Result<FixtureChannelEvaluator, JsValue> {
        let elements: Vec<ElementParameters> = serde_json::from_str(elements_json)
            .map_err(|error| JsValue::from_str(&format!("Invalid fixture elements: {error}")))?;
        let model = FixtureModel::new(
            elements.into_iter().map(|element| element.parameters),
            linked,
        );
        Ok(Self {
            inputs: vec![None; model.len()],
            evaluator: FixtureEvaluator::new(model),
        })
    }

    /// Returns the number of parameters across the fixture's elements.
    #[wasm_bindgen(getter)]
    pub fn parameter_count(&self) -> usize {
        self.evaluator.model().len()
    }

    /// Evaluates `outputs`, one per parameter in element order, into
    /// `readings` ([`READING_STRIDE`] values per parameter), returning the
    /// fixture-level dimmer (see [`FixtureEvaluator::fixture_dimmer_level`])
    /// or `NaN` when the fixture has none.
    ///
    /// Outputs are the logical values the console reports (clamped and
    /// inverted, without calibration offset), `NaN` without output; relations
    /// involving virtual channels are already applied to them.
    pub fn evaluate(&mut self, outputs: &[f64], readings: &mut [f64]) -> f64 {
        let parameters = self.evaluator.model().parameters();
        for ((input, output), metadata) in self.inputs.iter_mut().zip(outputs).zip(parameters) {
            // Inversion mirrors the logical range, so it also recovers the
            // console's value from its reported output.
            *input = (!output.is_nan()).then(|| metadata.logical_output(*output as f32));
        }
        let evaluated = self.evaluator.read(&self.inputs);
        let (chunks, _) = readings.as_chunks_mut::<READING_STRIDE>();
        for (reading, slots) in evaluated.iter().zip(chunks) {
            let Some(reading) = reading else {
                *slots = [f64::NAN; READING_STRIDE];
                continue;
            };
            let index = |index: Option<usize>| index.map_or(-1.0, |index| index as f64);
            *slots = [
                f64::from(reading.dmx),
                index(reading.function),
                index(reading.set),
                f64::from(reading.fraction),
                f64::from(reading.physical),
                f64::from(reading.level),
                if reading.masters_own_emitters {
                    1.0
                } else {
                    0.0
                },
            ];
        }
        self.evaluator
            .fixture_dimmer_level()
            .map_or(f64::NAN, f64::from)
    }
}
