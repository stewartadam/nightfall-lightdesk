// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::{HashMap, HashSet};

use uuid::Uuid;

use super::materialize::cue_with_sequence_default_timing;
use super::release::mark_materialized_cue_released_at_position;
use super::*;

/// Rebuilds persisted Blueprint dependencies after cue or sequence definitions change.
pub fn rebuild_blueprint_reference_index(
    cue_data_provider: Res<DataProvider<Cue>>,
    sequence_data_provider: Res<DataProvider<Sequence>>,
    mut reference_index: ResMut<BlueprintReferenceIndex>,
) {
    if !cue_data_provider.is_changed() && !sequence_data_provider.is_changed() {
        return;
    }

    let cue_references = cue_data_provider.iter().flat_map(|entry| {
        let cue = entry.value();
        let description = format!("cue {} ({})", cue.identifiers.id, cue.identifiers.label);
        cue.referenced_blueprints()
            .into_iter()
            .map(|uid| (uid, description.clone()))
            .collect::<Vec<_>>()
    });
    let sequence_references = sequence_data_provider.iter().flat_map(|entry| {
        let sequence = entry.value();
        let description = format!(
            "sequence {} ({})",
            sequence.identifiers.id, sequence.identifiers.label
        );
        sequence
            .setup_cue
            .referenced_blueprints()
            .into_iter()
            .chain(sequence.release_cue.referenced_blueprints())
            .map(|uid| (uid, description.clone()))
            .collect::<Vec<_>>()
    });
    reference_index.replace_source("cues", cue_references.chain(sequence_references));
}

/// Runtime fields preserved while a sequence step is rematerialized from a new definition.
struct PreservedStepRuntime {
    mcue: Option<MaterializedCue>,
    transition_source_layer: Option<Layer>,
    activation_position: Option<Duration>,
}

/// Result of reconciling a running instance against a changed sequence definition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SequenceDefinitionReconciliation {
    Active,
    Empty,
}

impl MaterializedSequence {
    /// Builds cue snapshots referenced by a sequence, skipping unresolved cue UIDs.
    fn refreshed_sequence_steps(
        sequence: &Sequence,
        cue_data_provider: &DataProvider<Cue>,
    ) -> Vec<Cue> {
        let mut steps = Vec::new();
        for cue_uid in &sequence.steps {
            let cue_id: uuid::Uuid = (*cue_uid).into();
            match cue_data_provider.get(cue_id) {
                Ok(cue_ref) => steps.push((*cue_ref).clone()),
                Err(err) => {
                    tracing::warn!(
                        uid = %sequence.identifiers.uid,
                        cue_uid = %cue_id,
                        "Skipping missing cue while rematerializing sequence '{}': {}",
                        sequence.identifiers.label,
                        err
                    );
                }
            }
        }
        steps
    }

    /// Selects the cue that should remain active after sequence membership changes.
    fn reconciled_active_cue_uid(
        old_steps: &[Cue],
        old_active_index: usize,
        new_steps: &[Cue],
    ) -> Option<Uuid> {
        let new_uids = new_steps
            .iter()
            .map(|cue| cue.identifiers.uid)
            .collect::<HashSet<_>>();
        let old_active_uid = old_steps
            .get(old_active_index)
            .map(|cue| cue.identifiers.uid);

        if old_active_uid.is_some_and(|uid| new_uids.contains(&uid)) {
            return old_active_uid;
        }

        old_steps
            .iter()
            .take(old_active_index)
            .rev()
            .map(|cue| cue.identifiers.uid)
            .find(|uid| new_uids.contains(uid))
            .or_else(|| new_steps.first().map(|cue| cue.identifiers.uid))
    }

    /// Applies preserved runtime anchors to a newly materialized cue step.
    fn restore_step_runtime(&mut self, index: usize, runtime: PreservedStepRuntime) {
        let Some(mcue) = self.mcues.get_mut(index) else {
            return;
        };
        let Some(old_mcue) = runtime.mcue else {
            if let Some(activation_position) = runtime.activation_position {
                mcue.set_start_position(activation_position);
            }
            if let Some(source_layer) = self.transition_source_layers.get_mut(index) {
                *source_layer = runtime.transition_source_layer;
            }
            if let Some(position) = self.cue_activation_positions.get_mut(index) {
                *position = runtime.activation_position;
            }
            return;
        };

        mcue.set_activation_time(old_mcue.activation_time);
        mcue.set_start_position(old_mcue.start_position);
        mcue.release_position = old_mcue.release_position;
        mark_materialized_cue_released_at_position(mcue, old_mcue.release_position);
        if let Some(source_layer) = self.transition_source_layers.get_mut(index) {
            *source_layer = runtime.transition_source_layer;
        }
        if let Some(position) = self.cue_activation_positions.get_mut(index) {
            *position = runtime.activation_position;
        }
    }

    /// Rematerializes this playback from an updated sequence while preserving live cue identity.
    fn reconcile_sequence_definition(
        &mut self,
        sequence: Sequence,
        cue_data_provider: &DataProvider<Cue>,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        fixture_data_provider: &Res<FixtureDataProviderExt>,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
        playback_position: Option<Duration>,
    ) -> SequenceDefinitionReconciliation {
        let old_active_index = self.position_index;
        let old_steps = std::mem::take(&mut self.steps);
        let old_mcues = std::mem::take(&mut self.mcues);
        let old_transition_source_layers = std::mem::take(&mut self.transition_source_layers);
        let old_cue_activation_positions = std::mem::take(&mut self.cue_activation_positions);
        let old_composition_order = std::mem::take(&mut self.composition_order);
        let mut old_mcues_by_index = old_mcues.into_iter().map(Some).collect::<Vec<_>>();
        let new_steps = Self::refreshed_sequence_steps(&sequence, cue_data_provider);
        let old_active_uid = old_steps
            .get(old_active_index)
            .map(|cue| cue.identifiers.uid);
        let target_cue_uid =
            Self::reconciled_active_cue_uid(&old_steps, old_active_index, &new_steps);

        let mut preserved_runtime_by_uid = HashMap::new();
        for (index, cue) in old_steps.iter().enumerate() {
            preserved_runtime_by_uid.insert(
                cue.identifiers.uid,
                PreservedStepRuntime {
                    mcue: old_mcues_by_index.get_mut(index).and_then(Option::take),
                    transition_source_layer: old_transition_source_layers
                        .get(index)
                        .cloned()
                        .flatten(),
                    activation_position: old_cue_activation_positions
                        .get(index)
                        .and_then(|position| *position),
                },
            );
        }

        self.sequence = sequence;
        self.wrap = self.sequence.wrap;
        self.steps = new_steps;
        self.mcues = Vec::new();
        self.transition_source_layers = Vec::new();
        self.cue_activation_positions = Vec::new();
        self.last_rendered_layer = None;
        self.release_layer = None;
        self.release_started_position = None;
        self.release_duration_floor = Duration::ZERO;
        self.invalidate_render_prefix_cache();

        let Some(target_cue_uid) = target_cue_uid else {
            self.position_index = 0;
            return SequenceDefinitionReconciliation::Empty;
        };

        let target_index = self
            .steps
            .iter()
            .position(|cue| cue.identifiers.uid == target_cue_uid)
            .unwrap_or_default();
        self.position_index = target_index;
        self.materialize_through_position_with_sources(
            target_index as u32 + 1,
            color_path_data_provider,
            blueprint_data_provider,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        );

        let new_indices_by_uid = self
            .steps
            .iter()
            .enumerate()
            .map(|(index, cue)| (cue.identifiers.uid, index))
            .collect::<HashMap<_, _>>();
        let retained_order = old_composition_order
            .into_iter()
            .filter_map(|old_index| old_steps.get(old_index))
            .filter_map(|cue| new_indices_by_uid.get(&cue.identifiers.uid).copied())
            .filter(|index| *index < self.mcues.len())
            .collect::<Vec<_>>();

        let old_active_survived = old_active_uid == Some(target_cue_uid);
        for index in 0..self.mcues.len() {
            let cue_uid = self.steps[index].identifiers.uid;
            if let Some(runtime) = preserved_runtime_by_uid.remove(&cue_uid) {
                self.restore_step_runtime(index, runtime);
            }
        }

        let activation_position = if old_active_survived {
            self.cue_activation_positions
                .get(target_index)
                .and_then(|position| *position)
                .unwrap_or(self.last_activation_position)
        } else {
            playback_position.unwrap_or(self.last_activation_position)
        };
        self.last_activation_position = activation_position;
        if let Some(mcue) = self.mcues.get_mut(target_index) {
            mcue.set_start_position(activation_position);
            mcue.release_position = None;
        }
        if let Some(position) = self.cue_activation_positions.get_mut(target_index) {
            *position = Some(activation_position);
        }
        if playback_position.is_none() && !old_active_survived {
            self.activation_time = Instant::now();
        }

        self.composition_order = retained_order;
        if !self.composition_order.contains(&target_index) {
            self.composition_order.push(target_index);
        }
        if self.composition_order.is_empty() {
            self.composition_order = vec![target_index];
        }
        self.invalidate_render_prefix_cache();
        SequenceDefinitionReconciliation::Active
    }

    /// Updates any cached cue definitions matching the provided cue UID.
    pub fn update_cue_definition(&mut self, cue: &Cue) -> bool {
        let mut updated = false;

        for step in self.steps.iter_mut() {
            if step.identifiers.uid != cue.identifiers.uid {
                continue;
            }

            *step = cue.clone();
            updated = true;
        }

        if updated {
            self.last_rendered_layer = None;
            self.transition_source_layers.clear();
            self.invalidate_render_prefix_cache();
        }

        updated
    }

    fn rematerialize_step(
        &mut self,
        index: usize,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        fixture_data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) {
        let Some(cue) = self.steps.get(index) else {
            return;
        };
        let Some(mcue) = self.mcues.get_mut(index) else {
            return;
        };

        let activation_time = mcue.activation_time;
        let start_position = mcue.start_position;
        let release_position = mcue.release_position;
        let priority = mcue.priority;
        let cue_with_defaults =
            cue_with_sequence_default_timing(cue, &self.sequence.default_timing);
        let mut updated_mcue = MaterializedCue::materialize_with_sources(
            &cue_with_defaults,
            color_path_data_provider,
            blueprint_data_provider,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        );
        updated_mcue.record_implicit_htp_assertion_timing_with_blueprints(
            cue,
            blueprint_data_provider,
            fixture_data_provider,
            parameter_query,
            selection_resolver,
        );
        updated_mcue.set_activation_time(activation_time);
        updated_mcue.set_start_position(start_position);
        updated_mcue.release_position = release_position;
        mark_materialized_cue_released_at_position(&mut updated_mcue, release_position);
        updated_mcue.priority = priority;
        *mcue = updated_mcue;
        if let Some(source_layer) = self.transition_source_layers.get_mut(index) {
            *source_layer = None;
        }
        self.invalidate_render_prefix_cache();
    }

    fn refresh_cue_definitions(
        &mut self,
        cue_data_provider: &DataProvider<Cue>,
        color_path_data_provider: Option<&DataProvider<ColorPath>>,
        blueprint_data_provider: Option<&DataProvider<Blueprint>>,
        fixture_data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
        selection_resolver: &SpatialSelectionResolver,
    ) -> bool {
        let mut updated = false;

        for index in 0..self.steps.len() {
            let cue_uid = self.steps[index].identifiers.uid;
            let Ok(cue_ref) = cue_data_provider.get(cue_uid) else {
                continue;
            };
            let cue = (*cue_ref).clone();
            if !self.update_cue_definition(&cue) {
                continue;
            }

            self.rematerialize_step(
                index,
                color_path_data_provider,
                blueprint_data_provider,
                fixture_data_provider,
                parameter_query,
                selection_resolver,
            );
            updated = true;
        }

        updated
    }
}

/// Rematerializes running sequences after stored cue definitions change.
pub fn rematerialize_sequences_after_cue_definition_change(
    cue_data_provider: Res<DataProvider<Cue>>,
    color_path_data_provider: Option<Res<DataProvider<ColorPath>>>,
    blueprint_data_provider: Option<Res<DataProvider<Blueprint>>>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    parameter_query: Query<InstanceRef<Parameter>>,
    selection_resolver: SpatialSelectionResolver,
    mut msequence_query: Query<&mut MaterializedSequence>,
) {
    if !cue_data_provider.is_changed() {
        return;
    }

    for mut msequence in msequence_query.iter_mut() {
        msequence.refresh_cue_definitions(
            &cue_data_provider,
            color_path_data_provider.as_deref(),
            blueprint_data_provider.as_deref(),
            &fixture_data_provider,
            &parameter_query.as_readonly(),
            &selection_resolver,
        );
    }
}

/// Rematerializes embedded setup and release cues after stored sequence definitions change.
pub fn rematerialize_sequences_after_sequence_definition_change(
    mut commands: Commands,
    sequence_data_provider: Res<DataProvider<Sequence>>,
    cue_data_provider: Res<DataProvider<Cue>>,
    color_path_data_provider: Option<Res<DataProvider<ColorPath>>>,
    blueprint_data_provider: Option<Res<DataProvider<Blueprint>>>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    parameter_query: Query<InstanceRef<Parameter>>,
    selection_resolver: SpatialSelectionResolver,
    mut msequence_query: Query<(Entity, &mut MaterializedSequence, Option<&InstanceClock>)>,
) {
    if !sequence_data_provider.is_changed() {
        return;
    }

    for (entity, mut msequence, clock) in msequence_query.iter_mut() {
        let uid = msequence.sequence.identifiers.uid;
        let Ok(sequence_ref) = sequence_data_provider.get(uid) else {
            continue;
        };
        let sequence = (*sequence_ref).clone();
        let setup_start_time = msequence.setup_cue.activation_time;
        let setup_start_position = msequence.setup_cue.start_position;
        msequence.setup_cue = MaterializedCue::materialize_with_sources(
            &sequence.setup_cue,
            color_path_data_provider.as_deref(),
            blueprint_data_provider.as_deref(),
            &fixture_data_provider,
            &parameter_query.as_readonly(),
            &selection_resolver,
        );
        msequence.setup_cue.set_activation_time(setup_start_time);
        msequence.setup_cue.set_start_position(setup_start_position);
        msequence.release_cue = MaterializedCue::materialize_with_sources(
            &sequence.release_cue,
            color_path_data_provider.as_deref(),
            blueprint_data_provider.as_deref(),
            &fixture_data_provider,
            &parameter_query.as_readonly(),
            &selection_resolver,
        );
        let reconciliation = msequence.reconcile_sequence_definition(
            sequence,
            &cue_data_provider,
            color_path_data_provider.as_deref(),
            blueprint_data_provider.as_deref(),
            &fixture_data_provider,
            &parameter_query.as_readonly(),
            &selection_resolver,
            clock.map(|clock| clock.position),
        );
        if reconciliation == SequenceDefinitionReconciliation::Empty {
            let mut entity_commands = commands.entity(entity);
            entity_commands.insert(ReleaseMarker::default());
            if let Some(clock) = clock {
                entity_commands.insert(PlaybackReleaseTiming {
                    released_at: clock.position,
                });
            }
        }
    }
}

/// Re-materializes active cue state affected by committed Blueprint edits.
pub fn rematerialize_after_blueprint_definition_change(
    mut changes: MessageReader<BlueprintDefinitionChange>,
    color_path_data_provider: Option<Res<DataProvider<ColorPath>>>,
    blueprint_data_provider: Res<DataProvider<Blueprint>>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    parameter_query: Query<InstanceRef<Parameter>>,
    selection_resolver: SpatialSelectionResolver,
    mut msequence_query: Query<&mut MaterializedSequence>,
    mut standalone_cue_query: Query<&mut MaterializedCue, Without<MaterializedSequence>>,
) {
    let changed_uids = changes
        .read()
        .map(|change| change.uid)
        .collect::<HashSet<_>>();
    if changed_uids.is_empty() {
        return;
    }

    for mut msequence in msequence_query.iter_mut() {
        for index in 0..msequence.steps.len() {
            if changed_uids
                .iter()
                .any(|uid| msequence.steps[index].references_blueprint(*uid))
            {
                msequence.rematerialize_step(
                    index,
                    color_path_data_provider.as_deref(),
                    Some(&blueprint_data_provider),
                    &fixture_data_provider,
                    &parameter_query.as_readonly(),
                    &selection_resolver,
                );
            }
        }

        if changed_uids
            .iter()
            .any(|uid| msequence.sequence.setup_cue.references_blueprint(*uid))
        {
            rematerialize_cue_preserving_runtime(
                &mut msequence.setup_cue,
                color_path_data_provider.as_deref(),
                Some(&blueprint_data_provider),
                &fixture_data_provider,
                &parameter_query.as_readonly(),
                &selection_resolver,
            );
            msequence.invalidate_render_prefix_cache();
        }
        if changed_uids
            .iter()
            .any(|uid| msequence.sequence.release_cue.references_blueprint(*uid))
        {
            rematerialize_cue_preserving_runtime(
                &mut msequence.release_cue,
                color_path_data_provider.as_deref(),
                Some(&blueprint_data_provider),
                &fixture_data_provider,
                &parameter_query.as_readonly(),
                &selection_resolver,
            );
        }
    }

    for mut mcue in standalone_cue_query.iter_mut() {
        if changed_uids
            .iter()
            .any(|uid| mcue.cue.references_blueprint(*uid))
        {
            rematerialize_cue_preserving_runtime(
                &mut mcue,
                color_path_data_provider.as_deref(),
                Some(&blueprint_data_provider),
                &fixture_data_provider,
                &parameter_query.as_readonly(),
                &selection_resolver,
            );
        }
    }
}

/// Rebuilds one materialized cue while retaining playback-local runtime anchors.
fn rematerialize_cue_preserving_runtime(
    mcue: &mut MaterializedCue,
    color_path_data_provider: Option<&DataProvider<ColorPath>>,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
    fixture_data_provider: &FixtureDataProviderExt,
    parameter_query: &Query<InstanceRef<Parameter>>,
    selection_resolver: &SpatialSelectionResolver,
) {
    let activation_time = mcue.activation_time;
    let start_position = mcue.start_position;
    let release_position = mcue.release_position;
    let priority = mcue.priority;
    let cue = mcue.cue.clone();
    let mut updated = MaterializedCue::materialize_with_sources(
        &cue,
        color_path_data_provider,
        blueprint_data_provider,
        fixture_data_provider,
        parameter_query,
        selection_resolver,
    );
    updated.record_implicit_htp_assertion_timing_with_blueprints(
        &cue,
        blueprint_data_provider,
        fixture_data_provider,
        parameter_query,
        selection_resolver,
    );
    updated.set_activation_time(activation_time);
    updated.set_start_position(start_position);
    updated.release_position = release_position;
    mark_materialized_cue_released_at_position(&mut updated, release_position);
    updated.priority = priority;
    *mcue = updated;
}
