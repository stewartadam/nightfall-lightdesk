// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::borrow::Cow;

use bevy_ecs::prelude::Commands;

use super::{ShowfileLoadDomain, ShowfileLoadPhase, ShowfileSnapshot};

mod clips;
mod color_paths;
mod cue_structure;
mod desk_state;
mod fixtures_patch;
mod flows;
mod fx;
mod scene_objects;
mod snapshot_values;
mod timecodes_timelines;

pub(super) use clips::{ClipsLoadContributor, ClipsSaveContributor};
pub(super) use color_paths::{ColorPathsLoadContributor, ColorPathsSaveContributor};
pub(super) use cue_structure::{CueStructureLoadContributor, CueStructureSaveContributor};
pub(super) use desk_state::{DeskStateLoadContributor, DeskStateSaveContributor};
pub(super) use fixtures_patch::{FixturesPatchLoadContributor, FixturesPatchSaveContributor};
pub(super) use flows::{FlowsLoadContributor, FlowsSaveContributor};
pub(super) use fx::{FxLoadContributor, FxSaveContributor};
pub(super) use scene_objects::{SceneObjectsLoadContributor, SceneObjectsSaveContributor};
pub(super) use timecodes_timelines::{
    TimecodesTimelinesLoadContributor, TimecodesTimelinesSaveContributor,
};

/// Domain-owned showfile slice used as owned save output or borrowed load input.
pub(super) enum ShowfileContribution<'a> {
    DeskState(desk_state::DeskStateSnapshot<'a>),
    FixturesPatch(fixtures_patch::FixturesPatchSnapshot<'a>),
    SceneObjects(scene_objects::SceneObjectsSnapshot<'a>),
    CueStructure(cue_structure::CueStructureSnapshot<'a>),
    ColorPaths(color_paths::ColorPathsSnapshot<'a>),
    Fx(fx::FxSnapshot<'a>),
    Flows(flows::FlowsSnapshot<'a>),
    Clips(clips::ClipsSnapshot<'a>),
    TimecodesTimelines(timecodes_timelines::TimecodesTimelinesSnapshot<'a>),
}

/// Adds one domain-owned slice to a showfile save operation.
pub(super) trait ShowfileSaveContributor {
    /// Copy the contributor's current runtime state into its domain snapshot.
    fn save_contribution(&self) -> ShowfileContribution<'static>;
}

/// Applies one domain-owned slice from a showfile snapshot during load.
pub(super) trait ShowfileLoadContributor {
    /// Return the deterministic load domain this contributor participates in.
    fn domain(&self) -> ShowfileLoadDomain;

    /// Apply this contributor's work for the requested load phase.
    fn contribute_load(
        &mut self,
        _phase: ShowfileLoadPhase,
        _contribution: &ShowfileContribution<'_>,
        _commands: &mut Commands,
    ) -> Result<(), String> {
        Ok(())
    }
}

/// Invoke save contributors and merge their domain snapshots into the serialized root shape.
pub(super) fn collect_save_contributions(
    contributors: &[&dyn ShowfileSaveContributor],
) -> ShowfileSnapshot {
    let mut snapshot = ShowfileSnapshot {
        metadata: crate::ShowfileMetadata {
            showfile_version: crate::CURRENT_SHOWFILE_VERSION,
            ..Default::default()
        },
        ..Default::default()
    };

    for contributor in contributors {
        apply_save_contribution(&mut snapshot, contributor.save_contribution());
    }

    snapshot
}

/// Invoke load contributors for the active phase and ordered domain.
pub(super) fn apply_load_contributors(
    phase: ShowfileLoadPhase,
    domain: ShowfileLoadDomain,
    contributors: &mut [&mut dyn ShowfileLoadContributor],
    snapshot: &ShowfileSnapshot,
    commands: &mut Commands,
) -> Result<(), String> {
    let contribution = load_contribution_for_domain(domain, snapshot);

    for contributor in contributors
        .iter_mut()
        .filter(|contributor| contributor.domain() == domain)
    {
        contributor.contribute_load(phase, &contribution, commands)?;
    }

    Ok(())
}

/// Merge a domain-owned contribution into the flat, backwards-compatible serialized root.
fn apply_save_contribution(
    snapshot: &mut ShowfileSnapshot,
    contribution: ShowfileContribution<'static>,
) {
    match contribution {
        ShowfileContribution::DeskState(contribution) => {
            snapshot.variables = contribution.variables.into_owned();
            snapshot.settings = contribution.settings.into_owned();
            snapshot.io_settings = contribution.io_settings.into_owned();
        }
        ShowfileContribution::FixturesPatch(contribution) => {
            snapshot.fixtures = contribution.fixtures.into_owned();
            snapshot.bindings = contribution.bindings.into_owned();
            #[cfg(feature = "midi")]
            {
                snapshot.midi_mappings = contribution.midi_mappings.into_owned();
            }
            #[cfg(feature = "osc")]
            {
                snapshot.osc_mappings = contribution.osc_mappings.into_owned();
            }
        }
        ShowfileContribution::SceneObjects(contribution) => {
            snapshot.scene_objects = contribution.scene_objects.into_owned();
        }
        ShowfileContribution::CueStructure(contribution) => {
            snapshot.cues = contribution.cues.into_owned();
            snapshot.sequences = contribution.sequences.into_owned();
            snapshot.groups = contribution.groups.into_owned();
            snapshot.masters = contribution.masters.into_owned();
            snapshot.blueprints = contribution.blueprints.into_owned();
        }
        ShowfileContribution::ColorPaths(contribution) => {
            snapshot.color_paths = contribution.color_paths.into_owned();
            snapshot.color_path_defaults = contribution.color_path_defaults.into_owned();
        }
        ShowfileContribution::Fx(contribution) => {
            snapshot.fx = contribution.fx.into_owned();
            snapshot.fx_module = contribution.fx_module.into_owned();
            snapshot.step_fx = contribution.step_fx.into_owned();
        }
        ShowfileContribution::Flows(contribution) => {
            snapshot.flows = contribution.flows.into_owned();
        }
        ShowfileContribution::Clips(contribution) => {
            snapshot.clips = contribution.clips.into_owned();
        }
        ShowfileContribution::TimecodesTimelines(contribution) => {
            snapshot.timecodes = contribution.timecodes.into_owned();
            snapshot.timelines = contribution.timelines.into_owned();
        }
    }
}

/// Borrow the serialized root as the load contribution for the requested domain.
fn load_contribution_for_domain(
    domain: ShowfileLoadDomain,
    snapshot: &ShowfileSnapshot,
) -> ShowfileContribution<'_> {
    match domain {
        ShowfileLoadDomain::DeskState => {
            ShowfileContribution::DeskState(desk_state::DeskStateSnapshot {
                variables: Cow::Borrowed(&snapshot.variables),
                settings: Cow::Borrowed(&snapshot.settings),
                io_settings: Cow::Borrowed(&snapshot.io_settings),
            })
        }
        ShowfileLoadDomain::FixturesPatch => {
            ShowfileContribution::FixturesPatch(fixtures_patch::FixturesPatchSnapshot {
                fixtures: Cow::Borrowed(&snapshot.fixtures),
                color_path_defaults: Cow::Borrowed(&snapshot.color_path_defaults),
                bindings: Cow::Borrowed(&snapshot.bindings),
                #[cfg(feature = "midi")]
                midi_mappings: Cow::Borrowed(&snapshot.midi_mappings),
                #[cfg(feature = "osc")]
                osc_mappings: Cow::Borrowed(&snapshot.osc_mappings),
            })
        }
        ShowfileLoadDomain::SceneObjects => {
            ShowfileContribution::SceneObjects(scene_objects::SceneObjectsSnapshot {
                scene_objects: Cow::Borrowed(&snapshot.scene_objects),
            })
        }
        ShowfileLoadDomain::CueStructure => {
            ShowfileContribution::CueStructure(cue_structure::CueStructureSnapshot {
                cues: Cow::Borrowed(&snapshot.cues),
                sequences: Cow::Borrowed(&snapshot.sequences),
                groups: Cow::Borrowed(&snapshot.groups),
                masters: Cow::Borrowed(&snapshot.masters),
                blueprints: Cow::Borrowed(&snapshot.blueprints),
            })
        }
        ShowfileLoadDomain::ColorPaths => {
            ShowfileContribution::ColorPaths(color_paths::ColorPathsSnapshot {
                color_paths: Cow::Borrowed(&snapshot.color_paths),
                color_path_defaults: Cow::Borrowed(&snapshot.color_path_defaults),
            })
        }
        ShowfileLoadDomain::Fx => ShowfileContribution::Fx(fx::FxSnapshot {
            fx: Cow::Borrowed(&snapshot.fx),
            fx_module: Cow::Borrowed(&snapshot.fx_module),
            step_fx: Cow::Borrowed(&snapshot.step_fx),
        }),
        ShowfileLoadDomain::Flows => ShowfileContribution::Flows(flows::FlowsSnapshot {
            flows: Cow::Borrowed(&snapshot.flows),
        }),
        ShowfileLoadDomain::Clips => ShowfileContribution::Clips(clips::ClipsSnapshot {
            clips: Cow::Borrowed(&snapshot.clips),
        }),
        ShowfileLoadDomain::TimecodesTimelines => ShowfileContribution::TimecodesTimelines(
            timecodes_timelines::TimecodesTimelinesSnapshot {
                timecodes: Cow::Borrowed(&snapshot.timecodes),
                timelines: Cow::Borrowed(&snapshot.timelines),
            },
        ),
    }
}
