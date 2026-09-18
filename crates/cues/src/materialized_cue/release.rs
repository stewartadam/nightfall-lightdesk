// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use uuid::Uuid;

use super::*;

impl MaterializedCue {
    /// Returns whether this cue has the release anchor required by its clock domain.
    pub(super) fn has_release_anchor_for_clock(&self, _clock: Option<&InstanceClock>) -> bool {
        self.release_position.is_some()
    }

    /// Releases the materialized cue and starts the release transitions.
    pub fn release(&mut self) {
        self.release_at_playback_position(None);
    }

    /// Releases the materialized cue at an optional source-local playback position.
    pub fn release_at_playback_position(&mut self, release_position: Option<Duration>) {
        let release_position = release_position.unwrap_or_default();
        self.release_position = Some(release_position);
        [&mut self.values.absolute, &mut self.values.relative]
            .iter_mut()
            .for_each(|layer| {
                layer.iter_mut().for_each(|(_, (_, maybe_transition))| {
                    if let Some(transition) = maybe_transition.as_mut() {
                        transition.mark_released_at_position_if_unset(release_position);
                    }
                });
            });
    }

    /// Returns release timing entries materialized by parameter.
    pub(crate) fn release_timings_by_parameter(&self) -> ParameterMap<MaterializedTransition> {
        let mut release_timings = ParameterMap::new();
        for (parameter, (_, transition)) in self
            .values
            .absolute
            .iter()
            .chain(self.values.relative.iter())
        {
            if let Some(transition) = transition {
                release_timings.insert(parameter, transition.clone());
            }
        }
        for (parameter, transition) in self.release_timing_overrides.iter() {
            release_timings.insert(parameter, transition.clone());
        }
        release_timings
    }

    /// Releases this cue at an optional source-local playback position after applying look holds.
    pub fn release_with_ltp_hold_at_playback_position(
        &mut self,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
        release_position: Option<Duration>,
    ) {
        self.delay_ltp_release_until_htp_release_complete(data_provider, parameter_query);

        let release_position = release_position.unwrap_or_default();
        self.release_position = Some(release_position);
        [&mut self.values.absolute, &mut self.values.relative]
            .iter_mut()
            .for_each(|layer| {
                layer.iter_mut().for_each(|(_, (_, maybe_transition))| {
                    if let Some(transition) = maybe_transition.as_mut() {
                        transition.mark_released_at_position_if_unset(release_position);
                    }
                });
            });
    }

    /// Extends LTP release delay while same-fixture intensity is fading out.
    pub(crate) fn delay_ltp_release_until_htp_release_complete(
        &mut self,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
    ) {
        let htp_release_by_fixture_uid =
            self.htp_intensity_release_duration_by_fixture_uid(data_provider, parameter_query);
        if htp_release_by_fixture_uid.is_empty() {
            return;
        }

        [&mut self.values.absolute, &mut self.values.relative]
            .iter_mut()
            .for_each(|layer| {
                layer.iter_mut().for_each(|(parameter, (_, transition))| {
                    let Ok(parameter_ref) = parameter_query.get(parameter.entity()) else {
                        return;
                    };
                    if !matches!(parameter_ref.metadata.merge_type, MergeStrategy::LTP) {
                        return;
                    }
                    let Some(fixture_ref) =
                        data_provider.try_fixture_ref_for_parameter(&parameter_ref.instance())
                    else {
                        return;
                    };
                    let Some(hold_duration) =
                        htp_release_by_fixture_uid.get(&fixture_ref.fixture_uid)
                    else {
                        return;
                    };
                    if hold_duration.is_zero() {
                        return;
                    }

                    let transition = transition.get_or_insert_with(|| MaterializedTransition {
                        delay_in: Duration::ZERO,
                        fade_in: Duration::ZERO,
                        curve_in: FadeCurve::Linear,
                        delay_out: Duration::ZERO,
                        fade_out: Duration::ZERO,
                        curve_out: FadeCurve::Linear,
                        start_position: self.start_position,
                        release_position: None,
                    });
                    transition.delay_out = hold_duration.saturating_add(transition.delay_out);
                });
            });
    }

    /// Returns intensity release duration by fixture for this cue's output.
    fn htp_intensity_release_duration_by_fixture_uid(
        &self,
        data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceRef<Parameter>>,
    ) -> HashMap<Uuid, Duration> {
        let mut release_by_fixture_uid: HashMap<Uuid, Duration> = HashMap::new();
        for (parameter, (_, transition)) in self
            .values
            .absolute
            .iter()
            .chain(self.values.relative.iter())
        {
            let Ok(parameter_ref) = parameter_query.get(parameter.entity()) else {
                continue;
            };
            if !matches!(parameter_ref.metadata.merge_type, MergeStrategy::HTP)
                || !matches!(
                    parameter_ref.metadata.attribute,
                    Attribute::Intensity | Attribute::VirtualIntensity
                )
            {
                continue;
            }
            let Some(fixture_ref) =
                data_provider.try_fixture_ref_for_parameter(&parameter_ref.instance())
            else {
                continue;
            };
            let release_duration = transition
                .as_ref()
                .map(MaterializedTransition::release_duration)
                .unwrap_or_default();
            let entry = release_by_fixture_uid
                .entry(fixture_ref.fixture_uid)
                .or_default();
            *entry = (*entry).max(release_duration);
        }
        release_by_fixture_uid
    }

    /// Returns the longest release duration across this cue's materialized parameters.
    pub(crate) fn max_release_duration(&self) -> Duration {
        self.values
            .absolute
            .iter()
            .chain(self.values.relative.iter())
            .filter_map(|(_, (_, transition))| {
                transition
                    .as_ref()
                    .map(MaterializedTransition::release_duration)
            })
            .max()
            .unwrap_or_default()
    }
}
