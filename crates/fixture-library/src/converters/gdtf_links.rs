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
use nightfall_dmx::prelude::{Attribute, DmxValueResolution};
use nightfall_fixtures::prelude::*;

use super::gdtf_functions::{ordered_functions, scaled};
use super::gdtf_resolve::{GdtfDiagnostic, ResolvedMode};

/// Where a resolved channel's parameter lives: `(element index, parameter index)`.
pub(super) type Placement = Option<(usize, usize)>;

/// What each resolved channel became while building elements.
#[derive(Clone, Copy)]
pub(super) struct LinkTargets<'a> {
    /// Per resolved channel, the parameter it produced.
    pub placements: &'a [Placement],
    /// Per resolved channel demoted for sharing slots, the channel that owns them.
    pub slot_owners: &'a [Option<usize>],
}

/// Fills mode master conditions and relations on every converted parameter's
/// functions, then decides which virtual dimmers respond to masters.
///
/// Links to channels that produced no parameter are dropped with a
/// diagnostic, and links to a channel demoted for sharing another channel's
/// slots resolve to that owner, which is what the fixture receives. A mode
/// master naming a channel function is treated as naming its channel:
/// `ModeFrom`/`ModeTo` are compared with the master channel's DMX value.
pub(super) fn link_functions(
    resolved: &ResolvedMode<'_>,
    dmx_mode: &DmxMode,
    elements: &mut [FixtureElement],
    targets: LinkTargets<'_>,
    diagnostics: &mut Vec<GdtfDiagnostic>,
) {
    for (index, placement) in targets.placements.iter().enumerate() {
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
                let master = link(resolved, elements, targets, index, target);
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
                targets,
                (index, channel, function),
                diagnostics,
            );
            let target = &mut elements[element].parameters[parameter].functions[position];
            target.mode_master = mode_master;
            target.relations = relations;
        }
    }
    set_virtual_dimmer_master_response(elements);
}

/// Returns the relations whose follower is `function` of resolved channel `index`.
fn function_relations(
    resolved: &ResolvedMode<'_>,
    dmx_mode: &DmxMode,
    elements: &[FixtureElement],
    targets: LinkTargets<'_>,
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
                .and_then(|target| link(resolved, elements, targets, index, target));
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
    targets: LinkTargets<'_>,
    from: usize,
    target: &DmxChannel,
) -> Option<(ElementParameterRef, DmxValueResolution)> {
    let linked = resolved.linked_channel(from, target)?;
    let owner = targets.slot_owners[linked].unwrap_or(linked);
    let (element, parameter) = targets.placements[owner]?;
    let parameter = &elements[element].parameters[parameter];
    Some((
        ElementParameterRef {
            element: element as u32,
            attribute: parameter.attribute.clone(),
        },
        parameter.resolution,
    ))
}

/// Stops virtual dimmers from responding to intensity masters where another
/// dimmer on the same light path already does, so masters scale each path
/// once.
///
/// A virtual dimmer that follows another dimmer receives the master through
/// it, and in a fixture with a physical dimmer the master already scales the
/// fixture's own output. Virtual dimmers at the root of a chain in fixtures
/// without a physical dimmer keep responding.
fn set_virtual_dimmer_master_response(elements: &mut [FixtureElement]) {
    let has_physical_dimmer = elements.iter().any(|element| {
        element.parameters.iter().any(|parameter| {
            parameter.attribute == Attribute::Intensity && parameter.dmx_slots != DmxSlots::Virtual
        })
    });
    for parameter in elements
        .iter_mut()
        .flat_map(|element| element.parameters.iter_mut())
        .filter(|parameter| {
            parameter.attribute == Attribute::Intensity && parameter.dmx_slots == DmxSlots::Virtual
        })
    {
        let follows = parameter
            .functions
            .iter()
            .any(|function| !function.relations.is_empty());
        if follows || has_physical_dimmer {
            parameter.use_grandmaster = false;
        }
    }
}

/// Records an unresolved link once.
fn push_unresolved(diagnostics: &mut Vec<GdtfDiagnostic>, link: String) {
    let diagnostic = GdtfDiagnostic::UnresolvedLink { link };
    if !diagnostics.contains(&diagnostic) {
        diagnostics.push(diagnostic);
    }
}
