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
