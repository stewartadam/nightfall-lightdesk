// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { CommandAutocompleteBreadcrumb } from "../../../lib/wasm-bridge";

/** Returns an operator-facing label for a command grammar clause. */
export function clauseDisplayLabel(clause: string): string {
  const labels: Readonly<Record<string, string>> = {
    programmer: "Programmer",
    programmer_selection: "Selection",
    programmer_selection_identifier: "Identifier",
    programmer_attribute_actions: "Attributes",
    programmer_set_attribute_item: "Set Attribute",
    programmer_timings: "Timing",
    programmer_timing_override: "Override",
    programmer_placement3d: "3D placement",
    fx: "FX",
    fx_identifier: "Identifier",
    fx_action: "Action",
    step_fx: "Step",
    step_fx_selection: "Selection",
    step_fx_duration: "Duration",
    step_fx_step_definition: "Attribute Step",
    patch: "Patch",
    patch_source: "Source",
    patch_target: "Target",
    clip: "Clip",
    clip_identifier: "Identifier",
    clip_action: "Action",
    channel_override: "Channel Override",
    release: "Release",
    release_channel: "Channel",
    release_attributes: "Attributes",
    clear: "Clear",
    clear_attributes: "Attributes",
    flow: "Flow",
    flow_identifier: "Identifier",
    flow_action: "Action",
    timecode: "Timecode",
    timecode_identifier: "Identifier",
    timecode_action: "Action",
    timeline: "Timeline",
    timeline_identifier: "Identifier",
    timeline_action: "Action",
    rm: "Remove",
    rename: "Rename",
    store: "Store",
    store_blueprint: "Blueprint",
    store_blueprint_filter: "Filter",
    log: "Log",
    log_level: "Level",
    log_filter: "Filter",
    log_fixture: "Fixture",
    recall: "Recall",
    debug: "Debug",
    sleep: "Sleep",
    fps: "FPS",
    rename_objects: "Objects",
    rename_compact_paths: "Color paths",
    programmer_selection_source: "Selection",
    object_property: "Object property",
    store_fixture: "Fixture",
    store_fixture_payload: "Fixture payload",
    store_fixture_offset: "Fixture offset",
    recall_cue: "Cue",
    recall_blueprint: "Blueprint",
    store_fx_module: "FX Module",
    fx_module: "Module",
    utility: "Command",
    showfile: "Showfile",
    new_showfile: "New showfile",
    cue_block: "Cue tracking",
    release_stale_inputs: "Stale inputs",
    store_color_path: "Color path",
    color_path_label: "Label",
    programmer_color_path: "Color path",
    cue_color_path: "Cue color path",
    copy_color_path: "Copy color path",
  };
  return labels[clause] ?? clause;
}

/** Displays only the ancestry shared by every viable parser continuation. */
export function frontierBreadcrumbLabel(
  breadcrumb: CommandAutocompleteBreadcrumb,
): string | null {
  if (breadcrumb.state === "none") return null;
  if (breadcrumb.state === "current_clause_path")
    return committedBreadcrumbLabel(breadcrumb.path);
  const first = breadcrumb.paths[0] ?? [];
  const shared = [];
  for (const [index, entry] of first.entries()) {
    if (
      !breadcrumb.paths.every(
        (path) =>
          path[index]?.clause === entry.clause &&
          path[index]?.instance === entry.instance,
      )
    )
      break;
    shared.push(entry);
  }
  return committedBreadcrumbLabel(shared);
}

/** Formats the committed grammar path shown above autocomplete suggestions. */
export function committedBreadcrumbLabel(
  committedPath: ReadonlyArray<{ clause: string; instance: number }>,
): string | null {
  if (committedPath.length === 0) return null;
  return committedPath
    .map((entry) => clauseDisplayLabel(entry.clause))
    .join(" > ");
}
