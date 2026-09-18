// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { COMMAND_LINE_PANEL_SHORTCUT } from "../features/command-line/panels/command-line.definition";
import {
  PANEL_FOCUS_CAPABILITY,
  RENDER_PROPERTIES_CAPABILITY,
  REVEAL_OBJECT_CAPABILITY,
} from "./panel-capabilities";
import {
  PANEL_DEFINITIONS,
  panelDefinitionByName,
  panelDefinitionHasCapability,
  panelDefinitionsForCapability,
  panelDefinitionsForPalette,
} from "./panel-definitions";
import { PANEL_MODULES } from "./panel-manifest";
import { SHOWFILE_OBJECT_TYPE_DEFINITIONS } from "./showfile-object-search";

/** Verifies every registered panel identity can be addressed unambiguously. */
test("panel definitions use unique component names and panel IDs", () => {
  const componentNames = PANEL_DEFINITIONS.map(
    (definition) => definition.componentName,
  );
  const panelIds = PANEL_DEFINITIONS.map((definition) => definition.panelId);

  assert.equal(new Set(componentNames).size, componentNames.length);
  assert.equal(new Set(panelIds).size, panelIds.length);
});

/** Verifies each manifest entry carries an explicit implementation loader. */
test("panel manifest declares component loaders", () => {
  const componentLoaders = PANEL_MODULES.map((module) => module.loadComponent);

  assert.equal(PANEL_MODULES.length, PANEL_DEFINITIONS.length);
  assert.ok(componentLoaders.every((loader) => typeof loader === "function"));
});

/** Verifies palette-visible definitions exclude internal editor panels. */
test("panel palette definitions include only palette-visible panels", () => {
  const paletteComponentNames = panelDefinitionsForPalette().map(
    (definition) => definition.componentName,
  );

  assert.ok(paletteComponentNames.includes("CueList"));
  assert.ok(!paletteComponentNames.includes("CueEditor"));
  assert.ok(!paletteComponentNames.includes("FxEditor"));
  assert.ok(!paletteComponentNames.includes("SequenceEditor"));
});

/** Verifies hand-authored singleton IDs survive component-name indirection. */
test("panel definitions preserve non-derived singleton panel IDs", () => {
  assert.equal(panelDefinitionByName("GroupsPanel").panelId, "panel-Groups");
  assert.equal(panelDefinitionByName("GroupsPanel").title, "Groups");
});

/** Verifies direct shortcuts are owned by panel definitions. */
test("panel definitions own panel shortcut metadata", () => {
  assert.equal(
    panelDefinitionByName("CommandLine").shortcut,
    COMMAND_LINE_PANEL_SHORTCUT,
  );
  assert.equal(panelDefinitionByName("FixtureGrid").shortcut, undefined);
});

/** Verifies reveal-object support is declared by panels that can reveal objects. */
test("panel definitions declare reveal-object capability targets", () => {
  const revealPanelIds = panelDefinitionsForCapability(
    REVEAL_OBJECT_CAPABILITY.id,
  ).map((definition) => definition.panelId);

  assert.deepEqual(revealPanelIds, [
    "panel-CueList",
    "panel-FixtureGrid",
    "panel-FxList",
    "panel-FlowList",
    "panel-Groups",
    "panel-Masters",
    "panel-BlueprintsPanel",
    "panel-ColorPathPanel",
    "panel-SceneObjects",
    "panel-SequenceList",
    "panel-ClipList",
    "panel-TimecodesPanel",
    "panel-TimelinesPanel",
  ]);
});

/** Verifies panel definitions expose focus and properties capability metadata. */
test("panel definitions declare focus and properties capability targets", () => {
  const focusPanelIds = panelDefinitionsForCapability(
    PANEL_FOCUS_CAPABILITY.id,
  ).map((definition) => definition.panelId);
  const propertiesPanelIds = panelDefinitionsForCapability(
    RENDER_PROPERTIES_CAPABILITY.id,
  ).map((definition) => definition.panelId);

  assert.deepEqual(
    focusPanelIds,
    PANEL_DEFINITIONS.map((definition) => definition.panelId),
  );
  assert.ok(propertiesPanelIds.includes("panel-FixtureGrid"));
  assert.ok(propertiesPanelIds.includes("panel-CueList"));
  assert.ok(!propertiesPanelIds.includes("panel-CommandLine"));
});

/** Verifies object-palette routing targets only panels declaring reveal-object. */
test("showfile object panel routes target reveal-capable definitions", () => {
  for (const route of SHOWFILE_OBJECT_TYPE_DEFINITIONS) {
    const definition = panelDefinitionByName(route.componentName);
    assert.equal(route.panelId, definition.panelId);
    assert.equal(
      panelDefinitionHasCapability(definition, REVEAL_OBJECT_CAPABILITY.id),
      true,
      `${route.type} route targets ${definition.componentName}`,
    );
  }
});
