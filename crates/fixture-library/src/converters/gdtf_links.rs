// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Links GDTF mode masters and relations to the parameters they name.
//!
//! Both name DMX channels of the mode. A channel declared on a referenced
//! template exists once per reference, so each link resolves to the instance
//! nearest the linking channel (see [`ResolvedMode::linked_channel`]).

use gdtf::dmx_mode::{ChannelFunction, DmxChannel, DmxMode, ModeMaster};
use nightfall_fixtures::prelude::*;

use super::gdtf_functions::{ordered_functions, scaled};
use super::gdtf_resolve::{GdtfDiagnostic, ResolvedMode};

/// Where a resolved channel's parameter lives: `(element index, parameter index)`.
pub(super) type Placement = Option<(usize, usize)>;

/// Fills mode master conditions and relations on every converted parameter's functions.
///
/// `placements` has one entry per resolved channel. Links to channels that
/// produced no parameter are dropped with a diagnostic. A mode master naming
/// a channel function is treated as naming its channel: `ModeFrom`/`ModeTo`
/// are compared with the master channel's DMX value.
pub(super) fn link_functions(
    resolved: &ResolvedMode<'_>,
    dmx_mode: &DmxMode,
    elements: &mut [FixtureElement],
    placements: &[Placement],
    diagnostics: &mut Vec<GdtfDiagnostic>,
) {
    for (index, placement) in placements.iter().enumerate() {
        let Some((element, parameter)) = *placement else {
            continue;
        };
        let channel = resolved.channels[index].channel;
        let Some(logical) = channel.logical_channels.first() else {
            continue;
        };
        let resolution = elements[element].parameters[parameter].resolution;
        for (position, function) in ordered_functions(logical, resolution)
            .into_iter()
            .enumerate()
        {
            let mode_master = function.mode_master.as_ref().and_then(|node| {
                let target = match node.mode_master(dmx_mode)? {
                    ModeMaster::DmxChannel(target) | ModeMaster::ChannelFunction(target, ..) => {
                        target
                    }
                };
                let master = link(resolved, elements, placements, index, target);
                if master.is_none() {
                    push_unresolved(diagnostics, node.node.to_string());
                }
                let (master, resolution) = master?;
                Some(ModeMasterCondition {
                    master,
                    dmx_from: scaled(node.from, resolution),
                    dmx_to: scaled(node.to, resolution),
                })
            });
            let relations = function_relations(
                resolved,
                dmx_mode,
                elements,
                placements,
                (index, channel, function),
                diagnostics,
            );
            let target = &mut elements[element].parameters[parameter].functions[position];
            target.mode_master = mode_master;
            target.relations = relations;
        }
    }
}

/// Returns the relations whose follower is `function` of resolved channel `index`.
fn function_relations(
    resolved: &ResolvedMode<'_>,
    dmx_mode: &DmxMode,
    elements: &[FixtureElement],
    placements: &[Placement],
    (index, channel, function): (usize, &DmxChannel, &ChannelFunction),
    diagnostics: &mut Vec<GdtfDiagnostic>,
) -> Vec<FunctionRelation> {
    dmx_mode
        .relations
        .iter()
        .filter(|relation| {
            relation
                .follower(dmx_mode)
                .is_some_and(|(follower_channel, _, follower)| {
                    std::ptr::eq(follower_channel, channel) && std::ptr::eq(follower, function)
                })
        })
        .filter_map(|relation| {
            let master = relation
                .master(dmx_mode)
                .and_then(|target| link(resolved, elements, placements, index, target));
            if master.is_none() {
                push_unresolved(diagnostics, relation.master.to_string());
            }
            Some(FunctionRelation {
                master: master?.0,
                kind: match relation.type_ {
                    gdtf::dmx_mode::RelationType::Multiply => RelationKind::Multiply,
                    gdtf::dmx_mode::RelationType::Override => RelationKind::Override,
                },
            })
        })
        .collect()
}

/// Resolves a link from channel `from` to `target`'s parameter and its resolution.
fn link(
    resolved: &ResolvedMode<'_>,
    elements: &[FixtureElement],
    placements: &[Placement],
    from: usize,
    target: &DmxChannel,
) -> Option<(
    ElementParameterRef,
    nightfall_dmx::prelude::DmxValueResolution,
)> {
    let (element, parameter) = placements[resolved.linked_channel(from, target)?]?;
    let parameter = &elements[element].parameters[parameter];
    Some((
        ElementParameterRef {
            element: element as u32,
            attribute: parameter.attribute.clone(),
        },
        parameter.resolution,
    ))
}

/// Records an unresolved link once.
fn push_unresolved(diagnostics: &mut Vec<GdtfDiagnostic>, link: String) {
    let diagnostic = GdtfDiagnostic::UnresolvedLink { link };
    if !diagnostics.contains(&diagnostic) {
        diagnostics.push(diagnostic);
    }
}
