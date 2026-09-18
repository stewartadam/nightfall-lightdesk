// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  expect,
  type Locator,
  type Page,
  frontendOnlyTest as test,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Reads the shared field surface independently of its editor-specific width. */
async function appearance(control: Locator) {
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      border: style.border,
      radius: style.borderRadius,
      padding: style.padding,
      height: style.height,
      font: style.font,
    };
  });
}

/** Opens a demo entity editor and keeps its properties visible in the right drawer. */
async function openProperties(
  page: Page,
  component: "SequenceEditor" | "CueEditor" | "Timeline",
  fieldLabel: string,
) {
  const panelId = `shared-properties-${component}`;
  await page.evaluate(
    ({ component, panelId }) => {
      const stores = (window as any).appStores;
      const api = stores.dockApi.get();
      const source =
        component === "SequenceEditor"
          ? stores.sequences
          : component === "CueEditor"
            ? stores.cues
            : stores.timelines;
      const entity = Object.values(source.get())[0] as any;
      const uidKey =
        component === "SequenceEditor"
          ? "initialSequenceUid"
          : component === "CueEditor"
            ? "initialCueUid"
            : "initialTimelineUid";
      api.addPanel({
        id: panelId,
        component,
        title: `${component} controls`,
        params: { initialPanelId: panelId, [uidKey]: entity.identifiers.uid },
        position: { referencePanel: "panel-FixtureGrid", direction: "within" },
      });
      if (!api.getPanel("panel-PropertiesInspector")) {
        api.addPanel({
          id: "panel-PropertiesInspector",
          component: "PropertiesInspector",
          title: "Properties",
          params: {},
        });
      }
      api.getPanel(panelId)?.api.setActive();
      api.getPanel(panelId)?.focus();
    },
    { component, panelId },
  );
  await page
    .getByLabel(fieldLabel, { exact: true })
    .waitFor({ state: "attached" });
  await page.evaluate(async (panelId) => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-PropertiesInspector")?.api.setActive();
    api.setEdgeGroupVisible("right", true);
    api.getEdgeGroup("right")?.expand();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    api.getPanel(panelId)?.api.setActive();
    api.getPanel(panelId)?.focus();
  }, panelId);
  await expect(page.getByLabel(fieldLabel, { exact: true })).toBeVisible();
  return page.locator('[data-panel-id="panel-PropertiesInspector"]');
}

/** Exercises drafts, timing inheritance and compact property fields against the lab appearance. */
test("property editors share compact controls and preserve timing inheritance", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Input forms/ })
    .click();
  const lab = page.getByRole("region", { name: "Input form examples" });
  await lab.getByRole("tab", { name: "Properties", exact: true }).click();
  const inputStyle = await appearance(
    lab.getByLabel("Cue name *", { exact: true }),
  );
  const selectStyle = await appearance(lab.getByLabel("On completion"));

  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  const properties = await openProperties(
    page,
    "SequenceEditor",
    "Sequence label",
  );
  const label = properties.getByLabel("Sequence label");
  expect(await appearance(label)).toEqual(inputStyle);
  const originalLabel = await label.inputValue();
  await label.fill("Discarded draft");
  await label.press("Escape");
  await expect(label).toHaveValue(originalLabel);
  await label.fill("Shared property controls");
  await label.press("Enter");
  await expect(label).not.toBeFocused();
  await expect(label).toHaveValue("Shared property controls");

  const fades = properties.getByRole("spinbutton", {
    name: "Fade In",
    exact: true,
  });
  await expect(fades).toHaveCount(2);
  await fades.first().fill("2.5");
  await fades.first().blur();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sequence = Object.values(
          (window as any).appStores.sequences.get(),
        )[0] as any;
        return sequence.default_timing.fade_in;
      }),
    )
    .toEqual({ type: "Fixed", data: { secs: 2, nanos: 500_000_000 } });
  await fades.last().fill("");
  await fades.last().blur();
  await expect(fades.last()).toHaveValue("2.5");
  await expect(fades.last()).toHaveAttribute("data-inherited", "true");
  const inheritedColor = await fades
    .last()
    .evaluate((element) => getComputedStyle(element).color);
  expect(inheritedColor).not.toEqual(inputStyle.color);
  await fades.last().fill("1.25");
  await fades.last().blur();
  await expect(fades.last()).toHaveValue("1.25");
  await expect(fades.last()).not.toHaveAttribute("data-inherited", "true");
  expect(await appearance(fades.last())).toEqual(inputStyle);
  await fades.last().fill("");
  await fades.last().blur();
  await expect(fades.last()).toHaveValue("2.5");
  await expect(fades.last()).toHaveCSS("color", inheritedColor);
  await properties.screenshot({
    path: testInfo.outputPath("sequence-properties.png"),
  });

  await openProperties(page, "CueEditor", "Fade In Duration (seconds)");
  const cueFade = properties.getByLabel("Fade In Duration (seconds)");
  expect(await appearance(cueFade)).toEqual(inputStyle);
  await cueFade.fill("3.5");
  await cueFade.blur();
  await expect(cueFade).toHaveValue("3.5");
  /** Reads persisted demo cue fields so consecutive edits wait for their acknowledgements. */
  const readCue = () =>
    page.evaluate(
      () => Object.values((window as any).appStores.cues.get())[0] as any,
    );
  await expect
    .poll(async () => (await readCue()).transitions.fade_in)
    .toEqual({
      type: "Fixed",
      data: { secs: 3, nanos: 500_000_000 },
    });
  const trigger = properties.getByRole("combobox", {
    name: "Trigger Type",
    exact: true,
  });
  expect(await appearance(trigger)).toEqual(selectStyle);
  await trigger.selectOption("AfterDelay");
  await expect
    .poll(async () => (await readCue()).trigger.type)
    .toBe("AfterDelay");
  const triggerTime = properties.getByLabel("Trigger Time (seconds)");
  await triggerTime.fill("1.5");
  await triggerTime.blur();
  await expect
    .poll(async () => (await readCue()).trigger)
    .toEqual({
      type: "AfterDelay",
      data: { secs: 1, nanos: 500_000_000 },
    });
  await expect(triggerTime).toHaveValue("1.5");
  await properties.screenshot({
    path: testInfo.outputPath("cue-properties.png"),
  });

  await openProperties(page, "Timeline", "Linked timecode");
  expect(await appearance(properties.getByLabel("Linked timecode"))).toEqual(
    selectStyle,
  );
  expect(
    await appearance(properties.getByLabel("Timecode start (ms)")),
  ).toEqual(inputStyle);
  await properties.getByLabel("Use end time").check();
  const end = properties.getByLabel("End time (ms)", { exact: true });
  await end.fill("12500");
  await end.blur();
  await expect(end).toHaveValue("12500");
  await page.setViewportSize({ width: 900, height: 700 });
  expect(
    await properties.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await properties.screenshot({
    path: testInfo.outputPath("timeline-properties-narrow.png"),
  });
});
