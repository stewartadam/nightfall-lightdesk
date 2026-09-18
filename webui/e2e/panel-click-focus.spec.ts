// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { gridCellByRowIndex } from "./data-grid-selectors";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const PANEL_IDS = {
  cue: "panel-CueEditor-click-focus-e2e",
  properties: "panel-Properties-click-focus-e2e",
  sequence: "panel-SequenceEditor-click-focus-e2e",
  timeline: "panel-Timeline-click-focus-e2e",
} as const;

/**
 * Opens the app with a clean persisted DockView layout for panel focus tests.
 */
async function openApp(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
}

/**
 * Seeds deterministic editor content and opens the panels used by the focus test.
 */
async function seedAndOpenPanels(page: Page): Promise<void> {
  await page.evaluate((panelIds) => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    const fixtureUid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
    const cueUid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
    const sequenceUid = "ccccccccccccccccccccccccccccccc3";
    const timelineUid = "ddddddddddddddddddddddddddddddd4";
    const timecodeUid = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeee5";
    const attributes = ["Intensity", "Red", "Green", "Blue"];

    /** Builds coarse parameter metadata for a focus-test fixture attribute. */
    const parameter = (attribute: string) => ({
      resolution: "Coarse",
      attribute: { type: attribute },
      value_polarity: "Unsigned",
      min: 0,
      max: 255,
      offset: { type: "Absolute", data: { value: 0 } },
      is_inverted: false,
      is_snap: false,
      merge_type: attribute === "Intensity" ? "HTP" : "LTP",
      use_grandmaster: attribute === "Intensity",
    });

    /** Builds an embedded sequence setup or release cue. */
    const metaCue = (uid: string, label: string) => ({
      identifiers: { id: 0, uid, label },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      tracking_flags: "HTP",
    });

    const values = Object.fromEntries(
      attributes.map((attribute, index) => [
        attribute,
        {
          type: "Inline",
          data: {
            type: "AbsolutePercent",
            data: { value: (index + 1) / 4 },
          },
        },
      ]),
    );

    stores.attributeMetadata.set(
      attributes.map((attribute, index) => ({
        key: attribute,
        attribute: { type: attribute },
        label: attribute,
        category: attribute === "Intensity" ? "Dimmer" : "Color",
        sort_order: index,
      })),
    );
    stores.fixtures.set({
      [fixtureUid]: {
        identifiers: { id: 301, uid: fixtureUid, label: "Focus Fixture" },
        make: "E2E",
        model: "Panel Focus Fixture",
        mode: "Default",
        elements: [
          {
            label: "Main",
            parameters: attributes.map(parameter),
          },
        ],
      },
    });
    stores.parameters.set(
      new Map([
        [
          fixtureUid,
          {
            uid: fixtureUid,
            color: "rgb(0, 0, 0)",
            raw: {
              Intensity: 64,
              Red: 128,
              Green: 192,
              Blue: 255,
            },
            relative: {},
            conflicts: new Set(),
            elements: [],
          },
        ],
      ]),
    );
    stores.cues.set({
      [cueUid]: {
        identifiers: {
          id: 101,
          uid: cueUid,
          label: "Panel Click Focus E2E Cue",
        },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [
          {
            selection: {
              source: {
                type: "Resolved",
                data: [{ fixture_uid: fixtureUid, index: null }],
              },
              clauses: [],
            },
            cue_instruction: {
              values,
              transitions: {},
              transitions_by_attribute: {},
              transitions_by_fixture_attribute: [],
            },
          },
        ],
        parts: [],
        tracking_flags: "HTP",
      },
    });
    stores.sequences.set({
      [sequenceUid]: {
        identifiers: {
          id: 201,
          uid: sequenceUid,
          label: "Panel Click Focus E2E Sequence",
        },
        steps: [cueUid],
        wrap: false,
        release_on_start: false,
        setup_cue: metaCue("fffffffffffffffffffffffffffffff6", "Setup"),
        release_cue: metaCue("99999999999999999999999999999997", "Release"),
        default_timing: {
          delay_in: { type: "Fixed", data: { secs: 0, nanos: 0 } },
          fade_in: { type: "Fixed", data: { secs: 1, nanos: 0 } },
          curve_in: "Linear",
          delay_out: { type: "Fixed", data: { secs: 0, nanos: 0 } },
          fade_out: { type: "Fixed", data: { secs: 1, nanos: 0 } },
          curve_out: "Linear",
        },
        tracking_mode: { type: "Flags", data: { __Composed__: 7 } },
      },
    });
    stores.timecodes.set({
      [timecodeUid]: [
        {
          identifiers: {
            id: 401,
            uid: timecodeUid,
            label: "Panel Focus Timecode",
          },
          rate: "Fps30",
          source: "Internal",
        },
        {
          timecode_id: 401,
          is_active: false,
          current_time: { secs: 0, nanos: 0 },
          start_time: null,
          end_time: null,
        },
      ],
    });
    stores.timelines.set({
      [timelineUid]: {
        identifiers: {
          id: 301,
          uid: timelineUid,
          label: "Panel Focus Timeline",
        },
        timecode_uid: timecodeUid,
        timecode_start: { secs: 0, nanos: 0 },
        audio_path: "",
        audio_enabled: false,
        end_time: null,
        trigger_mode: "FollowTimecode",
        seek_behavior: "ReconstructState",
        nondeterministic_seek_behavior: "Ignore",
        stop_behavior: "ResetAndReleaseOwnedActions",
        lookahead: "disabled",
        tracks: [],
        markers: [],
        regions: [],
        loop_range: null,
        bpm: 120,
        beats_per_bar: 4,
        use_beat_grid: false,
        beatgrid: null,
        scroll_mode: "free",
      },
    });
    stores.cueDefinitionsLoaded.set(true);
    stores.sequenceDefinitionsLoaded.set(true);
    stores.timelineDefinitionsLoaded.set(true);

    /** Adds a main-group panel after closing a stale prior instance. */
    const addMainPanel = (
      id: string,
      component: string,
      title: string,
      params: Record<string, unknown>,
    ) => {
      api.getPanel(id)?.api.close();
      api.addPanel({
        id,
        component,
        title,
        params: { initialPanelId: id, ...params },
        position: api.getPanel("panel-FixtureGrid")
          ? { referencePanel: "panel-FixtureGrid", direction: "within" }
          : undefined,
      });
    };

    addMainPanel(panelIds.timeline, "Timeline", "Focus Timeline E2E", {
      initialTimelineUid: timelineUid,
    });
    addMainPanel(panelIds.sequence, "SequenceEditor", "Focus Sequence E2E", {
      initialSequenceUid: sequenceUid,
    });
    addMainPanel(panelIds.cue, "CueEditor", "Focus Cue E2E", {
      initialCueUid: cueUid,
    });

    api.getPanel(panelIds.properties)?.api.close();
    api.addPanel({
      id: panelIds.properties,
      component: "PropertiesInspector",
      title: "Properties",
      params: { initialPanelId: panelIds.properties },
      position: {
        referencePanel: panelIds.timeline,
        direction: "right",
      },
    });
  }, PANEL_IDS);
}

/**
 * Focuses a DockView panel by id through the app store bridge.
 */
async function focusDockPanel(page: Page, panelId: string): Promise<void> {
  await page.evaluate((targetPanelId) => {
    const panel = (window as any).appStores.dockApi
      .get()
      .getPanel(targetPanelId);
    if (!panel) throw new Error(`Expected panel ${targetPanelId}`);
    panel.focus();
  }, panelId);
}

/**
 * Asserts that DockView reports the expected active panel id.
 */
async function expectActivePanel(page: Page, panelId: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe(panelId);
}

/**
 * Clicks a visible target after moving DockView focus to the Properties panel.
 */
async function clickAfterFocusingProperties(
  page: Page,
  targetPanelId: string,
  target: Locator,
): Promise<void> {
  await focusDockPanel(page, targetPanelId);
  await expect(target).toBeVisible();
  await focusDockPanel(page, PANEL_IDS.properties);
  await expectActivePanel(page, PANEL_IDS.properties);
  await target.click();
}

/**
 * Verifies a grid cell is selected and its panel is active after one click.
 */
async function expectFirstClickSelectsCell(
  page: Page,
  panelId: string,
  cell: Locator,
): Promise<void> {
  await clickAfterFocusingProperties(page, panelId, cell);
  await expectActivePanel(page, panelId);
  await expect(cell).toHaveAttribute("aria-selected", "true");
}

/**
 * Panel body clicks activate the target panel and grid clicks select in one click.
 */
test("panel body clicks activate panels and select grid cells on the first click", async ({
  page,
}) => {
  await openApp(page);
  await seedAndOpenPanels(page);

  const timelinePanel = page.locator(
    `[data-panel-id="${PANEL_IDS.timeline}"][data-panel-kind="Timeline"]`,
  );
  await clickAfterFocusingProperties(page, PANEL_IDS.timeline, timelinePanel);
  await expectActivePanel(page, PANEL_IDS.timeline);

  const sequenceGrid = page.locator(
    `[data-panel-id="${PANEL_IDS.sequence}"] [data-grid-owner="sequence-editor"] [data-grid-kind="tanstack"]`,
  );
  const sequenceCell = gridCellByRowIndex(sequenceGrid, {
    columnKey: "label",
    rowIndex: 0,
  });
  await expectFirstClickSelectsCell(page, PANEL_IDS.sequence, sequenceCell);

  const cueGrid = page.locator(
    `[data-panel-id="${PANEL_IDS.cue}"] [data-grid-owner="cue-editor"] [data-grid-kind="tanstack"]`,
  );
  const cueCell = gridCellByRowIndex(cueGrid, {
    columnKey: "label",
    rowIndex: 0,
  });
  await expectFirstClickSelectsCell(page, PANEL_IDS.cue, cueCell);
});
