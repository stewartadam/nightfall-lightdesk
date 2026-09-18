// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Color-path assignment and reference maintenance.

use super::*;

/// Returns whether an instruction has any remaining asserted attributes.
pub(super) fn instruction_has_attributes(instruction: &CueInstruction) -> bool {
    !instruction.values.is_empty()
        || !instruction.transitions_by_attribute.is_empty()
        || !instruction.transitions_by_fixture_attribute.is_empty()
}

/// Returns whether an instruction has a supported color destination for path assignment.
pub(super) fn instruction_has_color_vector_destination(instruction: &CueInstruction) -> bool {
    [
        [Attribute::Red, Attribute::Green, Attribute::Blue],
        [Attribute::Cyan, Attribute::Magenta, Attribute::Yellow],
    ]
    .into_iter()
    .any(|attributes| {
        attributes
            .into_iter()
            .all(|attribute| instruction.values.contains_key(&attribute))
    }) || [
        Attribute::White,
        Attribute::Amber,
        Attribute::WarmWhite,
        Attribute::CoolWhite,
        Attribute::UV,
    ]
    .into_iter()
    .any(|attribute| instruction.values.contains_key(&attribute))
}

/// Set or clear a color path on all supported color instructions in a cue.
pub(super) fn set_color_vector_instruction_color_path(
    cue: &mut Cue,
    color_path_id: Option<ColorPathId>,
) -> usize {
    let mut updated = 0;
    for instruction in &mut cue.instructions {
        if instruction_has_color_vector_destination(&instruction.cue_instruction) {
            instruction.cue_instruction.color_path_id = color_path_id;
            updated += 1;
        }
    }
    for part in &mut cue.parts {
        for instruction in &mut part.instructions {
            if instruction_has_color_vector_destination(&instruction.cue_instruction) {
                instruction.cue_instruction.color_path_id = color_path_id;
                updated += 1;
            }
        }
    }
    updated
}

/// Rewrites one cue instruction if it explicitly references the moved color path.
pub(super) fn rewrite_instruction_color_path_id(
    instruction: &mut CueInstruction,
    id: u32,
    new_id: u32,
) -> bool {
    if instruction.color_path_id == Some(ColorPathId(id)) {
        instruction.color_path_id = Some(ColorPathId(new_id));
        return true;
    }
    false
}

/// Rewrites explicit color path assignments in a cue and its parts.
pub(super) fn rewrite_cue_color_path_references(cue: &mut Cue, id: u32, new_id: u32) -> usize {
    let mut updated = 0;
    for instruction in &mut cue.instructions {
        if rewrite_instruction_color_path_id(&mut instruction.cue_instruction, id, new_id) {
            updated += 1;
        }
    }
    for part in &mut cue.parts {
        for instruction in &mut part.instructions {
            if rewrite_instruction_color_path_id(&mut instruction.cue_instruction, id, new_id) {
                updated += 1;
            }
        }
    }
    updated
}

/// Rewrites stored cues that explicitly reference a moved color path ID.
pub(super) fn rewrite_stored_cue_color_path_references(
    cue_data_provider: &mut DataProvider<Cue>,
    id: u32,
    new_id: u32,
) -> Result<Vec<Cue>, String> {
    let cues_to_update = cue_data_provider
        .iter()
        .filter_map(|entry| {
            let mut cue = entry.value().clone();
            (rewrite_cue_color_path_references(&mut cue, id, new_id) > 0).then_some(cue)
        })
        .collect::<Vec<_>>();
    for cue in &cues_to_update {
        cue_data_provider
            .add(cue.clone())
            .map_err(|err| err.to_string())?;
    }
    Ok(cues_to_update)
}

/// Clears color path references from an instruction when it points at a removed path.
pub(super) fn clear_instruction_color_path_id(instruction: &mut CueInstruction, id: u32) -> bool {
    if instruction.color_path_id == Some(ColorPathId(id)) {
        instruction.color_path_id = None;
        return true;
    }
    false
}

/// Clears authored cue color path references that point at a removed path.
pub(super) fn clear_cue_color_path_references(cue: &mut Cue, id: u32) -> usize {
    let mut updated = 0;
    for instruction in &mut cue.instructions {
        if clear_instruction_color_path_id(&mut instruction.cue_instruction, id) {
            updated += 1;
        }
    }
    for part in &mut cue.parts {
        for instruction in &mut part.instructions {
            if clear_instruction_color_path_id(&mut instruction.cue_instruction, id) {
                updated += 1;
            }
        }
    }
    updated
}

/// Clears stored cue color path references that point at a removed path.
pub(super) fn clear_stored_cue_color_path_references(
    cue_data_provider: &mut DataProvider<Cue>,
    id: u32,
) -> Result<Vec<Cue>, String> {
    let cues_to_update = cue_data_provider
        .iter()
        .filter_map(|entry| {
            let mut cue = entry.value().clone();
            (clear_cue_color_path_references(&mut cue, id) > 0).then_some(cue)
        })
        .collect::<Vec<_>>();
    for cue in &cues_to_update {
        cue_data_provider
            .add(cue.clone())
            .map_err(|err| err.to_string())?;
    }
    Ok(cues_to_update)
}

/// Rewrites fixture defaults that point at a moved color path ID.
pub(super) fn rewrite_fixture_color_path_defaults(
    fixture_data_provider: &mut FixtureDataProviderExt,
    id: u32,
    new_id: u32,
) -> usize {
    let defaults_to_update = fixture_data_provider
        .color_path_default_entries()
        .into_iter()
        .filter(|default| default.color_path_id == ColorPathId(id))
        .collect::<Vec<_>>();
    let updated = defaults_to_update.len();
    for default in defaults_to_update {
        fixture_data_provider.set_color_path_default(default.fixture, Some(ColorPathId(new_id)));
    }
    updated
}

/// Clears fixture defaults that point at a removed color path ID.
pub(super) fn clear_fixture_color_path_defaults(
    fixture_data_provider: &mut FixtureDataProviderExt,
    id: u32,
) -> usize {
    let defaults_to_clear = fixture_data_provider
        .color_path_default_entries()
        .into_iter()
        .filter(|default| default.color_path_id == ColorPathId(id))
        .collect::<Vec<_>>();
    let updated = defaults_to_clear.len();
    for default in defaults_to_clear {
        fixture_data_provider.set_color_path_default(default.fixture, None);
    }
    updated
}

/// Returns whether a color path ID exists in showfile or built-in definitions.
pub(super) fn color_path_exists(
    color_path_id: ColorPathId,
    color_path_data_provider: Option<&DataProvider<ColorPath>>,
) -> bool {
    color_path_data_provider
        .and_then(|provider| provider.from_id(color_path_id.0).ok())
        .is_some()
        || builtin_color_paths()
            .iter()
            .any(|path| path.identifiers.id == color_path_id.0)
}

/// Formats known color path definitions for console list output.
pub(super) fn format_color_path_list(color_path_data_provider: &DataProvider<ColorPath>) -> String {
    let mut paths = color_path_data_provider
        .iter()
        .map(|entry| entry.value().clone())
        .collect::<Vec<_>>();
    paths.sort_by_key(|path| path.identifiers.id);

    if paths.is_empty() {
        return "Color Paths: none".to_string();
    }

    let mut lines = vec!["Color Paths:".to_string()];
    lines.extend(paths.into_iter().map(|path| {
        format!(
            "{} {} [{:?}]",
            path.identifiers.id, path.identifiers.label, path.interpolation_space
        )
    }));
    lines.join("\n")
}

/// Returns whether the stable color path ID belongs to a built-in profile.
pub(super) fn is_builtin_color_path_id(id: u32) -> bool {
    builtin_color_paths()
        .iter()
        .any(|path| path.identifiers.id == id)
}
