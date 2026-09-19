// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::borrow::Cow;

use bevy_ecs::prelude::Commands;
use nightfall_engine::prelude::*;
use nightfall_timecode::prelude::*;
use nightfall_timeline::prelude::*;

use super::snapshot_values::sorted_provider_values;
use super::{ShowfileContribution, ShowfileLoadContributor, ShowfileSaveContributor};
use crate::{ShowfileLoadDomain, ShowfileLoadPhase};

/// Timing state used as owned save output or borrowed load input.
pub(crate) struct TimecodesTimelinesSnapshot<'a> {
    pub(super) timecodes: Cow<'a, [Timecode]>,
    pub(super) timelines: Cow<'a, [Timeline]>,
}

/// Save contributor for timecode and timeline definitions.
pub(crate) struct TimecodesTimelinesSaveContributor<'a> {
    timecode_data_provider: &'a DataProvider<Timecode>,
    timeline_data_provider: &'a DataProvider<Timeline>,
}

impl<'a> TimecodesTimelinesSaveContributor<'a> {
    /// Build a contributor that snapshots timecode and timeline definitions.
    pub(crate) fn new(
        timecode_data_provider: &'a DataProvider<Timecode>,
        timeline_data_provider: &'a DataProvider<Timeline>,
    ) -> Self {
        Self {
            timecode_data_provider,
            timeline_data_provider,
        }
    }
}

impl ShowfileSaveContributor for TimecodesTimelinesSaveContributor<'_> {
    /// Copy timecode and timeline definitions into their stable showfile fields.
    fn save_contribution(&self) -> ShowfileContribution<'static> {
        ShowfileContribution::TimecodesTimelines(TimecodesTimelinesSnapshot {
            timecodes: Cow::Owned(sorted_provider_values(self.timecode_data_provider)),
            timelines: Cow::Owned(sorted_provider_values(self.timeline_data_provider)),
        })
    }
}

/// Load contributor for timecode and timeline definitions.
pub(crate) struct TimecodesTimelinesLoadContributor<'a> {
    timecode_data_provider: &'a mut DataProvider<Timecode>,
    timeline_data_provider: &'a mut DataProvider<Timeline>,
}

impl<'a> TimecodesTimelinesLoadContributor<'a> {
    /// Build a contributor that restores timecode and timeline definitions.
    pub(crate) fn new(
        timecode_data_provider: &'a mut DataProvider<Timecode>,
        timeline_data_provider: &'a mut DataProvider<Timeline>,
    ) -> Self {
        Self {
            timecode_data_provider,
            timeline_data_provider,
        }
    }
}

impl ShowfileLoadContributor for TimecodesTimelinesLoadContributor<'_> {
    /// Register timecodes and timelines as the final load domain.
    fn domain(&self) -> ShowfileLoadDomain {
        ShowfileLoadDomain::TimecodesTimelines
    }

    /// Apply timeline work during import and materialization phases.
    fn contribute_load(
        &mut self,
        phase: ShowfileLoadPhase,
        contribution: &ShowfileContribution<'_>,
        commands: &mut Commands,
    ) -> Result<(), String> {
        let ShowfileContribution::TimecodesTimelines(contribution) = contribution else {
            return Err(
                "timecodes/timelines contributor received an incompatible showfile domain"
                    .to_string(),
            );
        };

        match phase {
            ShowfileLoadPhase::ImportDefs => {
                self.timecode_data_provider
                    .extend(contribution.timecodes.to_vec());
                self.timeline_data_provider
                    .extend(contribution.timelines.to_vec());
            }
            ShowfileLoadPhase::ResolveLinks => {}
            ShowfileLoadPhase::MaterializeRuntime => {
                for timecode in contribution.timecodes.iter() {
                    commands.spawn(TimecodeGenerator::new(timecode.clone()));
                }
                for timeline in contribution.timelines.iter() {
                    commands.spawn(MaterializedTimeline::new(timeline.clone()));
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use bevy_ecs::world::{CommandQueue, World};

    use super::*;

    /// Saves and materializes an accepted grid in a fresh world without detection resources.
    #[test]
    fn accepted_beatgrid_survives_showfile_save_and_load_without_model() {
        let mut timelines = DataProvider::<Timeline>::default();
        let timecodes = DataProvider::<Timecode>::default();
        let mut timeline = Timeline::default();
        timeline.bpm = 128.5;
        timeline.beats_per_bar = 3;
        timeline.use_beat_grid = true;
        timeline.beatgrid = Some(BeatgridData {
            source: BeatgridSource::Manual,
            audio_fingerprint: "saved-audio".into(),
            bpm: 128.5,
            beats_per_bar: 3,
            markers: vec![BeatMarker {
                time: Duration::from_millis(1375),
                beat_index: 2,
                is_downbeat: false,
                confidence: Some(0.95),
            }],
            confidence: 0.9,
        });
        timelines.add(timeline.clone()).unwrap();
        let saver = TimecodesTimelinesSaveContributor::new(&timecodes, &timelines);
        let snapshot = super::super::collect_save_contributions(&[&saver]);
        let json = crate::serialize_showfile_snapshot_json(&snapshot).unwrap();
        let loaded = crate::parse_showfile_snapshot_json(&json, "beatgrid").unwrap();
        let contribution = ShowfileContribution::TimecodesTimelines(TimecodesTimelinesSnapshot {
            timecodes: Cow::Borrowed(&loaded.timecodes),
            timelines: Cow::Borrowed(&loaded.timelines),
        });
        let mut restored_timelines = DataProvider::<Timeline>::default();
        let mut restored_timecodes = DataProvider::<Timecode>::default();
        let mut loader = TimecodesTimelinesLoadContributor::new(
            &mut restored_timecodes,
            &mut restored_timelines,
        );
        let mut world = World::new();
        let mut queue = CommandQueue::default();
        let mut commands = Commands::new(&mut queue, &world);
        for phase in [
            ShowfileLoadPhase::ImportDefs,
            ShowfileLoadPhase::ResolveLinks,
            ShowfileLoadPhase::MaterializeRuntime,
        ] {
            loader
                .contribute_load(phase, &contribution, &mut commands)
                .unwrap();
        }
        queue.apply(&mut world);
        let restored = world
            .query::<&MaterializedTimeline>()
            .single(&world)
            .unwrap();
        assert_eq!(
            serde_json::to_value(&restored.timeline).unwrap(),
            serde_json::to_value(&timeline).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&*restored_timelines.from_id(timeline.identifiers.id).unwrap())
                .unwrap(),
            serde_json::to_value(&timeline).unwrap()
        );
    }
}
