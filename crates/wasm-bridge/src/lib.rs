// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WASM bridge utilities for parsing selection strings into SelectionExpr/SpatialSelection
#![allow(clippy::missing_errors_doc)]

use std::{collections::HashMap, time::Duration};

use nightfall::prelude::{
    project_resolved_spatial_selection as project_resolved_spatial_selection_impl,
    project_spanned_selection as project_spanned_selection_impl, FixtureRef, Group,
    ResolvedSelection, SelectionExpr, SpannedSelection, SpatialClause, SpatialProjectionError,
    SpatialSelection, TransitionMode,
};
use nightfall_cmd_parse::{
    autocomplete::complete_command as complete_command_impl,
    autocomplete::validate_command as validate_command_impl,
    autocomplete::CommandCompletionResponse, format_phase_expression_degrees,
    parse_phase_expression_text, parse_selection_expr, parse_spatial_selection_text,
    split_command_statements as split_command_statements_impl,
};
use nightfall_io::{RESERVED_NETWORK_DMX_TARGET_KEYWORDS, RESERVED_USB_DMX_TARGET_KEYWORDS};
use nightfall_lookahead_projection::{
    project_sequence_lookahead as project_sequence_lookahead_impl,
    sequence_duration_summary as sequence_duration_summary_impl, SequenceDurationSummaryRequest,
    SequenceLookaheadProjectionRequest,
};
use nightfall_selection::{
    SelectionDataSource, SelectionFixture, SelectionGroup,
    SpatialSelectionResolver as PureSpatialSelectionResolver,
};
use nightfall_waveform::prelude::*;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// JSON-serializable result for spatial projection through the WASM bridge.
#[derive(Debug, Serialize)]
struct SpatialProjectionResponse {
    resolved: ResolvedSelection,
    issues: Vec<String>,
}

/// JSON request for projecting explicitly resolved source spans.
#[derive(Debug, Deserialize)]
struct SpannedSpatialProjectionRequest {
    spans: Vec<Vec<FixtureRef>>,
    clauses: Vec<SpatialClause>,
}

/// Browser fixture metadata required by the pure Rust selection resolver.
#[derive(Debug, Deserialize)]
struct BrowserSelectionFixture {
    id: u32,
    fixture_uid: uuid::Uuid,
    element_count: u32,
}

/// Browser selection and lookup data resolved with authoritative engine semantics.
#[derive(Debug, Deserialize)]
struct SpatialSelectionResolutionRequest {
    selection: SpatialSelection,
    fixtures: Vec<BrowserSelectionFixture>,
    groups: Vec<Group>,
}

/// Read-only browser snapshot implementing the pure selection lookup contract.
struct BrowserSelectionDataSource {
    fixtures_by_id: HashMap<u32, SelectionFixture>,
    fixtures_by_uid: HashMap<uuid::Uuid, SelectionFixture>,
    groups_by_id: HashMap<u32, SelectionGroup>,
    groups_by_uid: HashMap<uuid::Uuid, SelectionGroup>,
    groups_by_label: HashMap<String, SelectionGroup>,
}

impl BrowserSelectionDataSource {
    /// Builds indexed resolver lookup tables from one browser snapshot.
    fn new(fixtures: Vec<BrowserSelectionFixture>, groups: Vec<Group>) -> Self {
        let mut fixtures_by_id = HashMap::with_capacity(fixtures.len());
        let mut fixtures_by_uid = HashMap::with_capacity(fixtures.len());
        for fixture in fixtures {
            let resolved = SelectionFixture {
                fixture_ref: FixtureRef {
                    fixture_uid: fixture.fixture_uid,
                    index: None,
                },
                element_count: fixture.element_count,
            };
            fixtures_by_id.insert(fixture.id, resolved.clone());
            fixtures_by_uid.insert(fixture.fixture_uid, resolved);
        }

        let mut groups_by_id = HashMap::with_capacity(groups.len());
        let mut groups_by_uid = HashMap::with_capacity(groups.len());
        let mut groups_by_label = HashMap::with_capacity(groups.len());
        for group in groups {
            let resolved = SelectionGroup {
                uid: group.identifiers.uid,
                id: group.identifiers.id,
                label: group.identifiers.label,
                selection: group.selection,
            };
            groups_by_id.insert(resolved.id, resolved.clone());
            groups_by_uid.insert(resolved.uid, resolved.clone());
            groups_by_label
                .entry(resolved.label.clone())
                .or_insert(resolved);
        }

        Self {
            fixtures_by_id,
            fixtures_by_uid,
            groups_by_id,
            groups_by_uid,
            groups_by_label,
        }
    }
}

impl SelectionDataSource for BrowserSelectionDataSource {
    /// Finds a fixture by its operator-facing numeric ID.
    fn fixture_by_id(&self, fixture_id: u32) -> Option<SelectionFixture> {
        self.fixtures_by_id.get(&fixture_id).cloned()
    }

    /// Finds a fixture by stable identity.
    fn fixture_by_ref(&self, fixture_ref: &FixtureRef) -> Option<SelectionFixture> {
        self.fixtures_by_uid.get(&fixture_ref.fixture_uid).cloned()
    }

    /// Reports that the browser snapshot includes group lookup data.
    fn groups_available(&self) -> bool {
        true
    }

    /// Finds a group by stable identity.
    fn group_by_uid(&self, uid: uuid::Uuid) -> Option<SelectionGroup> {
        self.groups_by_uid.get(&uid).cloned()
    }

    /// Finds a group by its operator-facing numeric ID.
    fn group_by_id(&self, group_id: u32) -> Option<SelectionGroup> {
        self.groups_by_id.get(&group_id).cloned()
    }

    /// Finds a group by its exact operator-facing label.
    fn group_by_label(&self, label: &str) -> Option<SelectionGroup> {
        self.groups_by_label.get(label).cloned()
    }
}

/// Request for resolving a transition mode at one target offset.
#[derive(Debug, Deserialize)]
struct TransitionModeResolutionRequest {
    mode: TransitionMode,
    offset: usize,
    total: usize,
}

/// TypeScript-facing shape for Rust `Duration` values.
#[derive(Debug, Serialize)]
struct WasmDuration {
    secs: u64,
    nanos: u32,
}

/// TypeScript-facing authored Step FX phase waypoint shape.
#[derive(Debug, Deserialize, Serialize)]
struct StepFxPhaseWaypoints {
    waypoints: Vec<f32>,
}

impl From<Duration> for WasmDuration {
    /// Convert a Rust duration into the generated TypeScript duration shape.
    fn from(duration: Duration) -> Self {
        Self {
            secs: duration.as_secs(),
            nanos: duration.subsec_nanos(),
        }
    }
}

// ============================================================================
// Selection expression parsing and formatting
// ============================================================================

/// Parse a selection expression string and return a JSON-serialized SelectionExpr.
///
/// The function uses the existing CLI parser to parse selection expressions
/// and returns them as JSON-serialized SelectionExpr objects.
#[wasm_bindgen]
pub fn parse_selection(input: &str) -> Result<JsValue, JsValue> {
    let input_str = input.trim();

    let selection_expr = parse_selection_expr(input_str)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse selection: {}", e)))?;

    serde_wasm_bindgen::to_value(&selection_expr)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize: {:?}", e)))
}

/// Parse a spatial selection string and return a JSON-serialized SpatialSelection.
#[wasm_bindgen]
pub fn parse_spatial_selection(input: &str) -> Result<JsValue, JsValue> {
    let input_str = input.trim();
    let spatial_selection = parse_spatial_selection_text(input_str)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse spatial selection: {}", e)))?;

    serde_wasm_bindgen::to_value(&spatial_selection)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize: {:?}", e)))
}

/// Format a SelectionExpr as a CLI-style string using its Display implementation.
///
/// Takes a JSON-serialized SelectionExpr and returns its string representation.
#[wasm_bindgen]
pub fn format_selection(selection_json: &str) -> Result<String, JsValue> {
    let selection: SelectionExpr = serde_json::from_str(selection_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse SelectionExpr: {}", e)))?;
    Ok(selection.to_string())
}

/// Format a SpatialSelection as a CLI-style string using its Display implementation.
#[wasm_bindgen]
pub fn format_spatial_selection(selection_json: &str) -> Result<String, JsValue> {
    let selection: SpatialSelection = serde_json::from_str(selection_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse SpatialSelection: {}", e)))?;
    Ok(selection.to_string())
}

/// Parses authored phase syntax into unwrapped normalized cycle waypoints.
#[wasm_bindgen]
pub fn parse_step_fx_phase(input: &str) -> Result<JsValue, JsValue> {
    let waypoints = parse_phase_expression_text(input)
        .map_err(|error| JsValue::from_str(&error.to_string()))?
        .into_iter()
        .map(|degrees| degrees / 360.0)
        .collect();
    serde_wasm_bindgen::to_value(&StepFxPhaseWaypoints { waypoints })
        .map_err(|error| JsValue::from_str(&format!("Failed to serialize phase: {error}")))
}

/// Formats normalized authored phase waypoints without expanding selection offsets.
#[wasm_bindgen]
pub fn format_step_fx_phase(phase_json: &str) -> Result<String, JsValue> {
    let phase: StepFxPhaseWaypoints = serde_json::from_str(phase_json)
        .map_err(|error| JsValue::from_str(&format!("Failed to parse StepFxPhase: {error}")))?;
    let degrees = phase
        .waypoints
        .into_iter()
        .map(|waypoint| waypoint * 360.0)
        .collect::<Vec<_>>();
    format_phase_expression_degrees(&degrees).map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Project a resolved-source spatial selection through its spatial clauses.
#[wasm_bindgen]
pub fn project_resolved_spatial_selection(selection_json: &str) -> Result<JsValue, JsValue> {
    let selection: SpatialSelection = serde_json::from_str(selection_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse SpatialSelection: {}", e)))?;
    let projected =
        project_resolved_spatial_selection_impl(&selection).map_err(|error| match error {
            SpatialProjectionError::UnresolvedSource => {
                JsValue::from_str("SpatialSelection source must be SelectionExpr::Resolved")
            }
        })?;
    let response = SpatialProjectionResponse {
        resolved: projected.value,
        issues: projected.issues,
    };

    serde_wasm_bindgen::to_value(&response)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize projection: {:?}", e)))
}

/// Project explicitly resolved source spans through Rust spatial replay semantics.
#[wasm_bindgen]
pub fn project_spanned_spatial_selection(request_json: &str) -> Result<JsValue, JsValue> {
    let request: SpannedSpatialProjectionRequest =
        serde_json::from_str(request_json).map_err(|error| {
            JsValue::from_str(&format!("Failed to parse spanned selection: {error}"))
        })?;
    let source = SpannedSelection::from_spans(request.spans);
    let projected = project_spanned_selection_impl(&source, source.flatten(), &request.clauses);
    let response = SpatialProjectionResponse {
        resolved: projected.value,
        issues: projected.issues,
    };

    serde_wasm_bindgen::to_value(&response)
        .map_err(|error| JsValue::from_str(&format!("Failed to serialize projection: {error:?}")))
}

/// Resolves a browser-authored selection against browser fixture and group snapshots.
#[wasm_bindgen]
pub fn resolve_spatial_selection(request_json: &str) -> Result<JsValue, JsValue> {
    let request: SpatialSelectionResolutionRequest = serde_json::from_str(request_json)
        .map_err(|error| JsValue::from_str(&format!("Failed to parse selection data: {error}")))?;
    let data_source = BrowserSelectionDataSource::new(request.fixtures, request.groups);
    let resolved = PureSpatialSelectionResolver::new(&data_source).resolve(&request.selection);
    let response = SpatialProjectionResponse {
        resolved: resolved.value,
        issues: resolved.issues,
    };

    serde_wasm_bindgen::to_value(&response)
        .map_err(|error| JsValue::from_str(&format!("Failed to serialize resolution: {error:?}")))
}

/// Resolve transition modes for target offsets using the Rust timing semantics.
#[wasm_bindgen]
pub fn resolve_transition_modes(requests: JsValue) -> Result<JsValue, JsValue> {
    let requests: Vec<TransitionModeResolutionRequest> =
        serde_wasm_bindgen::from_value(requests)
            .map_err(|e| JsValue::from_str(&format!("Invalid transition requests: {}", e)))?;
    let durations = requests
        .into_iter()
        .map(|request| request.mode.resolve(request.offset, request.total).into())
        .collect::<Vec<WasmDuration>>();

    serde_wasm_bindgen::to_value(&durations)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize durations: {:?}", e)))
}

/// Project authored sequence lookahead values using the shared Rust evaluator.
#[wasm_bindgen]
pub fn project_sequence_lookahead(request: JsValue) -> Result<JsValue, JsValue> {
    let request: SequenceLookaheadProjectionRequest = serde_wasm_bindgen::from_value(request)
        .map_err(|e| JsValue::from_str(&format!("Invalid lookahead request: {}", e)))?;
    let projection = project_sequence_lookahead_impl(&request);
    serde_wasm_bindgen::to_value(&projection)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize projection: {:?}", e)))
}

/// Computes sequence-view start, duration, and total values with backend cue timing logic.
#[wasm_bindgen]
pub fn sequence_duration_summary(request: JsValue) -> Result<JsValue, JsValue> {
    let request: SequenceDurationSummaryRequest = serde_wasm_bindgen::from_value(request)
        .map_err(|e| JsValue::from_str(&format!("Invalid sequence duration request: {}", e)))?;
    let summary = sequence_duration_summary_impl(&request);
    serde_wasm_bindgen::to_value(&summary)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize sequence duration: {:?}", e)))
}

/// Complete a command string at the given cursor offset.
///
/// Returns grammar-derived completion metadata for UI autocomplete.
#[wasm_bindgen]
pub fn complete_command(input: &str, cursor: usize) -> Result<JsValue, JsValue> {
    let response: CommandCompletionResponse = complete_command_impl(input, cursor);
    serde_wasm_bindgen::to_value(&response)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize completion: {:?}", e)))
}

/// Validate a full command string against the command grammar.
#[wasm_bindgen]
pub fn validate_command(input: &str) -> Result<JsValue, JsValue> {
    let response = validate_command_impl(input);
    serde_wasm_bindgen::to_value(&response)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize validation: {:?}", e)))
}

/// Split one command-line input into grammar-aware top-level statements.
#[wasm_bindgen]
pub fn split_command_statements(input: &str) -> Result<JsValue, JsValue> {
    let statements = split_command_statements_impl(input);
    serde_wasm_bindgen::to_value(&statements)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize statements: {:?}", e)))
}

/// Return reserved target keywords for network DMX output IDs.
#[wasm_bindgen]
pub fn reserved_network_dmx_target_keywords() -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&RESERVED_NETWORK_DMX_TARGET_KEYWORDS).map_err(|e| {
        JsValue::from_str(&format!(
            "Failed to serialize network DMX reserved keywords: {:?}",
            e
        ))
    })
}

/// Return reserved target keywords for USB DMX output IDs.
#[wasm_bindgen]
pub fn reserved_usb_dmx_target_keywords() -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&RESERVED_USB_DMX_TARGET_KEYWORDS).map_err(|e| {
        JsValue::from_str(&format!(
            "Failed to serialize USB DMX reserved keywords: {:?}",
            e
        ))
    })
}

// ============================================================================
// Waveform sampling functions
// ============================================================================

/// Sample a waveform at a normalized phase [0, 1].
///
/// # Arguments
/// * `kind` - Waveform kind as string ("sin", "triangle", "sawtooth", "square", "pulse")
/// * `phase_normalized` - Phase as normalized value [0, 1]
/// * `duty_cycle` - Duty cycle [0, 1]
///
/// # Returns
/// Normalized waveform value [0, 1]
#[wasm_bindgen]
pub fn wasm_sample_waveform_normalized(
    kind: JsValue,
    phase_normalized: f32,
    duty_cycle: f32,
) -> Result<f32, JsValue> {
    let waveform_kind: WaveformKind = serde_wasm_bindgen::from_value(kind)
        .map_err(|e| JsValue::from_str(&format!("Invalid waveform kind: {}", e)))?;
    Ok(sample_waveform_normalized(
        waveform_kind,
        phase_normalized,
        duty_cycle,
    ))
}

/// Sample a waveform at a phase in radians.
///
/// # Arguments
/// * `kind` - Waveform kind as string ("sin", "triangle", "sawtooth", "square", "pulse")
/// * `phase_radians` - Phase in radians
/// * `duty_cycle` - Duty cycle [0, 1]
///
/// # Returns
/// Normalized waveform value [0, 1]
#[wasm_bindgen]
pub fn wasm_sample_waveform_radians(
    kind: JsValue,
    phase_radians: f32,
    duty_cycle: f32,
) -> Result<f32, JsValue> {
    let waveform_kind: WaveformKind = serde_wasm_bindgen::from_value(kind)
        .map_err(|e| JsValue::from_str(&format!("Invalid waveform kind: {}", e)))?;
    Ok(sample_waveform_radians(
        waveform_kind,
        phase_radians,
        duty_cycle,
    ))
}

/// Generate multiple waveform samples for visualization.
///
/// # Arguments
/// * `kind` - Waveform kind as string ("sin", "triangle", "sawtooth", "square", "pulse")
/// * `phase_offset_radians` - Initial phase offset in radians
/// * `duty_cycle` - Duty cycle [0, 1]
/// * `sample_count` - Number of samples to generate
///
/// # Returns
/// Array of waveform samples with values in [0, 1]
#[wasm_bindgen]
pub fn wasm_generate_waveform_samples(
    kind: JsValue,
    phase_offset_radians: f32,
    duty_cycle: f32,
    sample_count: usize,
) -> Result<JsValue, JsValue> {
    let waveform_kind: WaveformKind = serde_wasm_bindgen::from_value(kind)
        .map_err(|e| JsValue::from_str(&format!("Invalid waveform kind: {}", e)))?;
    let samples = generate_waveform_samples(
        waveform_kind,
        phase_offset_radians,
        duty_cycle,
        sample_count,
    );
    serde_wasm_bindgen::to_value(&samples)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
}
