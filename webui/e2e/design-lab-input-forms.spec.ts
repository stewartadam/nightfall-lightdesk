// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Exercises suffixed numeric controls through buttons, keys, limits, validation, and layout changes. */
test("input forms include percentage and BPM adjustment controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Input forms/ })
    .click();
  const panel = page.getByRole("region", { name: "Input form examples" });
  const intensity = panel.getByRole("spinbutton", {
    name: "Intensity *",
    exact: true,
  });
  const bpm = panel.getByRole("spinbutton", {
    name: "BPM rate *",
    exact: true,
  });
  const increaseIntensity = panel.getByRole("button", {
    name: "Increase intensity",
    exact: true,
  });
  const decreaseIntensity = panel.getByRole("button", {
    name: "Decrease intensity",
    exact: true,
  });
  const increaseBpm = panel.getByRole("button", {
    name: "Increase bpm rate",
    exact: true,
  });
  const decreaseBpm = panel.getByRole("button", {
    name: "Decrease bpm rate",
    exact: true,
  });
  await expect(intensity).toHaveValue("80");
  await expect(bpm).toHaveValue("120");
  await increaseIntensity.click();
  await expect(intensity).toHaveValue("81");
  await intensity.press("ArrowDown");
  await expect(intensity).toHaveValue("80");
  await intensity.fill("99.5");
  await increaseIntensity.click();
  await expect(intensity).toHaveValue("100");
  await expect(increaseIntensity).toBeDisabled();
  await intensity.fill("0");
  await expect(decreaseIntensity).toBeDisabled();
  await bpm.fill("119.5");
  await increaseBpm.click();
  await expect(bpm).toHaveValue("120.5");
  await bpm.press("ArrowUp");
  await expect(bpm).toHaveValue("121.5");
  await bpm.press("ArrowDown");
  await expect(bpm).toHaveValue("120.5");
  await bpm.fill("240");
  await expect(increaseBpm).toBeDisabled();
  await decreaseBpm.click();
  await expect(bpm).toHaveValue("239");
  await bpm.fill("60");
  await expect(decreaseBpm).toBeDisabled();
  await bpm.fill("");
  await panel.getByRole("button", { name: "Save sample", exact: true }).click();
  await expect(bpm).toBeFocused();
  await expect(bpm).toHaveAttribute("aria-invalid", "true");
  await expect(
    panel.getByText("Enter a rate between 60 and 240 BPM."),
  ).toBeVisible();
  await bpm.fill("120.25");
  await increaseBpm.click();
  await expect(bpm).toHaveValue("121.25");
  await intensity.fill("101");
  await panel.getByRole("button", { name: "Save sample", exact: true }).click();
  await expect(intensity).toBeFocused();
  await expect(
    panel.getByText("Enter an intensity between 0 and 100%."),
  ).toBeVisible();
  await intensity.fill("80");
  await panel.getByRole("button", { name: "Save sample", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved “Opening wash”");

  for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: 1200 });
    for (const layout of ["Standard", "Properties"]) {
      await panel.getByRole("tab", { name: layout, exact: true }).click();
      await expect(intensity).toHaveValue("80");
      await expect(bpm).toHaveValue("121.25");
      for (const [field, unit] of [
        [intensity, "%"],
        [bpm, "BPM"],
      ] as const) {
        const row = panel.locator(".input-form-field").filter({
          has: page.getByRole("spinbutton", {
            name: unit === "%" ? "Intensity *" : "BPM rate *",
            exact: true,
          }),
        });
        const suffix = row.locator(".nf-stepper-unit");
        await expect(suffix).toHaveText(unit);
        await field.scrollIntoViewIfNeeded();
        const inputBounds = (await field.boundingBox())!;
        const suffixBounds = (await suffix.boundingBox())!;
        expect(inputBounds.width).toBeGreaterThan(40);
        expect(inputBounds.x + inputBounds.width).toBeLessThanOrEqual(
          suffixBounds.x + 1,
        );
        expect(
          await row.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
        await row.screenshot({
          path: testInfo.outputPath(
            `units-${width}-${layout}-${unit === "%" ? "percent" : "bpm"}.png`,
          ),
        });
      }
    }
  }
  await panel.getByRole("button", { name: "Reset form", exact: true }).click();
  await expect(intensity).toHaveValue("80");
  await expect(bpm).toHaveValue("120");
  await expect(bpm).toHaveAttribute("aria-invalid", "false");
});

/** Checks compact inline geometry, keyboard layout switching, shared edits, and visible validation. */
test("properties form uses inline labels and preserves edits between layouts", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Input forms/ })
    .click();
  const panel = page.getByRole("region", { name: "Input form examples" });
  const standard = panel.getByRole("tab", { name: "Standard", exact: true });
  const properties = panel.getByRole("tab", {
    name: "Properties",
    exact: true,
  });
  const name = panel.getByRole("textbox", { name: "Cue name *", exact: true });
  const standardHeight = (await name.boundingBox())!.height;
  await name.fill("Properties cue");
  await standard.focus();
  await standard.press("ArrowRight");
  await expect(properties).toBeFocused();
  await expect(properties).toHaveAttribute("aria-selected", "true");
  await expect(standard).toHaveAttribute("tabindex", "-1");
  await expect(
    panel.getByRole("tabpanel", { name: "Properties" }),
  ).toBeVisible();
  await expect(name).toHaveValue("Properties cue");
  expect((await name.boundingBox())!.height).toBeLessThan(standardHeight);
  await properties.press("Tab");
  await expect(name).toBeFocused();

  for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: 1200 });
    for (const density of ["Comfort", "Compact"]) {
      await page.getByRole("button", { name: density, exact: true }).click();
      const rows = panel.locator(".input-form-field");
      for (const row of await rows.all()) {
        const label = (await row
          .locator(":scope > :first-child")
          .boundingBox())!;
        const control = (await row
          .locator(":scope > :nth-child(2)")
          .boundingBox())!;
        expect(label.x + label.width).toBeLessThan(control.x);
        expect(label.y).toBeCloseTo(control.y, 0);
      }
      await expect(name).toHaveCSS("height", "28px");
      await expect(
        panel.getByRole("button", { name: "Cue trigger", exact: true }),
      ).toHaveCSS("height", "28px");
      expect(
        await panel.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await panel.screenshot({
        path: testInfo.outputPath(`properties-${width}-${density}.png`),
      });
      await panel.getByRole("status").scrollIntoViewIfNeeded();
      await panel.screenshot({
        path: testInfo.outputPath(`properties-${width}-${density}-actions.png`),
      });
      await properties.scrollIntoViewIfNeeded();
    }
  }

  const fade = panel.getByRole("spinbutton", { name: "Fade (s) *" });
  await name.fill("");
  await fade.fill("61");
  await panel.getByRole("button", { name: "Save sample", exact: true }).click();
  await expect(name).toBeFocused();
  await expect(
    panel.getByText("Enter a cue name.", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Enter a fade time between 0 and 60 seconds."),
  ).toBeVisible();
  await panel.screenshot({
    path: testInfo.outputPath("properties-validation.png"),
  });
  await name.fill("Properties cue");
  await fade.fill("1.5");
  await panel.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await panel.getByRole("button", { name: "Cue trigger", exact: true }).click();
  await page
    .locator(".nf-select-menu:visible")
    .getByText("Timecode", { exact: true })
    .click();
  await panel.getByRole("radio", { name: "Cue only", exact: true }).check();
  await panel.getByRole("button", { name: "Save sample", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText(
    "Saved “Properties cue” · 1.5 s fade · Enabled.",
  );

  await properties.focus();
  await properties.press("Home");
  await expect(standard).toBeFocused();
  await expect(name).toHaveValue("Properties cue");
  await expect(
    panel.getByRole("spinbutton", { name: "Fade time (seconds) *" }),
  ).toHaveValue("1.5");
  await expect(
    panel.getByRole("button", { name: "Cue trigger", exact: true }),
  ).toContainText("Timecode");
  await expect(
    panel.getByRole("radio", { name: "Cue only", exact: true }),
  ).toBeChecked();
  await standard.press("End");
  await expect(properties).toBeFocused();
  await properties.press("ArrowLeft");
  await expect(standard).toBeFocused();
  await properties.click();
  await panel.getByRole("button", { name: "Reset form", exact: true }).click();
  await expect(name).toHaveValue("Opening wash");
  await expect(fade).toHaveValue("2.5");
  await expect(name).toHaveAttribute("aria-invalid", "false");
});

/** Exercises form validation, editing, save/reset, and state preservation across catalog tabs. */
test("input forms validate and retain local edits", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/design-lab.html");
  const index = page.getByRole("navigation", { name: "Component index" });
  await index.getByRole("button", { name: /Input forms/ }).click();
  const panel = page.getByRole("region", { name: "Input form examples" });
  const name = panel.getByRole("textbox", { name: "Cue name *", exact: true });
  const fade = panel.getByRole("spinbutton", { name: "Fade time (seconds) *" });
  await expect(name).toHaveValue("Opening wash");
  await expect(panel.getByRole("textbox", { name: /Cue ID/ })).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(
    panel.getByRole("textbox", { name: /Output destination/ }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("checkbox", { name: /Send to live output/ }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("input-forms-desktop.png"),
    fullPage: true,
  });

  await name.fill("   ");
  await fade.fill("61");
  await panel.getByRole("button", { name: "Save sample", exact: true }).click();
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(fade).toHaveAttribute("aria-invalid", "true");
  await expect(
    panel.getByText("Enter a cue name.", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Enter a fade time between 0 and 60 seconds."),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("input-forms-validation.png"),
    fullPage: true,
  });

  await name.fill("Evening wash");
  await panel.getByRole("button", { name: "Save sample", exact: true }).click();
  await expect(fade).toBeFocused();
  await fade.fill("1.25");
  await panel
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Hold for the performer.");
  await panel.getByRole("button", { name: "Cue trigger", exact: true }).click();
  await page
    .locator(".nf-select-menu:visible")
    .getByText("After previous", { exact: true })
    .click();
  await panel.getByRole("radio", { name: "Cue only", exact: true }).check();
  await panel
    .getByRole("checkbox", { name: "Enable cue", exact: true })
    .uncheck();
  await panel.getByRole("button", { name: "Save sample", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText(
    "Saved “Evening wash” · 1.25 s fade · Disabled.",
  );
  await page.screenshot({
    path: testInfo.outputPath("input-forms-saved.png"),
    fullPage: true,
  });

  await index.getByRole("button", { name: /Buttons/ }).click();
  await index.getByRole("button", { name: /Input forms/ }).click();
  await expect(
    page.locator(".dv-tab").filter({ hasText: /^Input forms$/ }),
  ).toHaveCount(1);
  await expect(name).toHaveValue("Evening wash");
  await expect(
    panel.getByRole("button", { name: "Cue trigger", exact: true }),
  ).toContainText("After previous");
  await expect(
    panel.getByRole("radio", { name: "Cue only", exact: true }),
  ).toBeChecked();
  await panel.getByRole("button", { name: "Reset form", exact: true }).click();
  await expect(name).toHaveValue("Opening wash");
  await expect(fade).toHaveValue("2.5");
  await expect(name).toHaveAttribute("aria-invalid", "false");
  await expect(
    panel.getByRole("button", { name: "Cue trigger", exact: true }),
  ).toContainText("Manual");
  await expect(
    panel.getByRole("radio", { name: "Track changes", exact: true }),
  ).toBeChecked();
  await expect(
    panel.getByRole("checkbox", { name: "Enable cue", exact: true }),
  ).toBeChecked();
  await expect(
    panel.getByRole("textbox", { name: "Notes", exact: true }),
  ).toHaveValue("Bring the front wash up before the first cue.");
  await expect(panel.getByRole("status")).toHaveText("Sample form reset.");
});

/** Verifies the form stacks within a narrow dock panel and remains keyboard-submittable. */
test("input forms fit narrow panels", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/design-lab.html");
  await page
    .getByRole("navigation", { name: "Component index" })
    .getByRole("button", { name: /Input forms/ })
    .click();
  const panel = page.getByRole("region", { name: "Input form examples" });
  const name = panel.getByRole("textbox", { name: "Cue name *", exact: true });
  await name.fill("Narrow panel cue");
  await name.press("Enter");
  await expect(panel.getByRole("status")).toHaveText(
    "Saved “Narrow panel cue” · 2.5 s fade · Enabled.",
  );
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await name.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("input-forms-narrow.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Compact", exact: true }).click();
  await panel.getByRole("button", { name: "Reset form", exact: true }).click();
  await expect(name).toHaveValue("Opening wash");
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("input-forms-compact.png"),
    fullPage: true,
  });
});
