// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDropdownPaste,
  chooseAutoDurationDisplayUnit,
  clampRangeFill,
  clearDropdownValue,
  durationToMilliseconds,
  formatDurationInputValue,
  formatRangeValue,
  getActionAtPosition,
  getDropdownLabel,
  getRangeTone,
  getVisibleBadgeCount,
  isColorSwatchCellData,
  parseDurationInput,
} from "./datagrid-rich-cell-helpers";
import { makeTimeCell } from "./datagrid-rich-cells";

test("dropdown resolves selected labels and placeholders", () => {
  assert.equal(
    getDropdownLabel({
      kind: "rich-dropdown-cell",
      value: "FollowPrevious",
      allowedValues: [{ value: "FollowPrevious", label: "Follow Previous" }],
      placeholder: "Choose",
    }),
    "Follow Previous",
  );

  assert.equal(
    getDropdownLabel({
      kind: "rich-dropdown-cell",
      value: undefined,
      allowedValues: [],
      placeholder: "Choose",
    }),
    "Choose",
  );
});

test("dropdown paste matches values and labels but ignores invalid text", () => {
  const data = {
    kind: "rich-dropdown-cell" as const,
    value: "Manual",
    allowedValues: [
      { value: "Manual", label: "Manual" },
      { value: "AfterDelay", label: "After Delay" },
    ],
  };

  assert.equal(applyDropdownPaste(data, "AfterDelay").value, "AfterDelay");
  assert.equal(applyDropdownPaste(data, "After Delay").value, "AfterDelay");
  assert.equal(applyDropdownPaste(data, "unknown").value, "Manual");
});

test("dropdown clearing respects clearable flag", () => {
  const base = {
    kind: "rich-dropdown-cell" as const,
    value: "Manual",
    allowedValues: [{ value: "Manual", label: "Manual" }],
  };

  assert.equal(clearDropdownValue(base).value, "Manual");
  assert.equal(
    clearDropdownValue({ ...base, clearable: true }).value,
    undefined,
  );
});

test("plain copy data can be derived from rich cell data", () => {
  const dropdown = {
    kind: "rich-dropdown-cell" as const,
    value: "Manual",
    allowedValues: [{ value: "Manual", label: "Manual" }],
  };
  const tags = [
    { label: "Active", tone: "success" as const },
    { label: "Live", tone: "accent" as const },
  ];
  const range = {
    kind: "rich-range-cell" as const,
    value: 0.75,
    min: 0,
    max: 1,
    mode: "percentage" as const,
  };

  assert.equal(getDropdownLabel(dropdown), "Manual");
  assert.equal(tags.map((tag) => tag.label).join(", "), "Active, Live");
  assert.equal(formatRangeValue(range), "75%");
});

test("time cells include badges in copy data", () => {
  const cell = makeTimeCell({
    value: { secs: 10, nanos: 0 },
    badges: [{ label: "V", tone: "warning", title: "Varied" }],
  });

  assert.equal(cell.copyData, "[V] 10s");
});

test("badge overflow keeps complete badges and reserves overflow room", () => {
  const tags = [{ label: "One" }, { label: "Two" }, { label: "Three" }];

  /** Provide deterministic text measurement for rich-cell layout tests. */
  const measure = (text: string) => text.length * 8;

  assert.equal(getVisibleBadgeCount(tags, 200, measure), 3);
  assert.equal(getVisibleBadgeCount(tags, 75, measure), 1);
});

test("action hit testing returns the clicked action", () => {
  const data = {
    kind: "rich-action-button-cell" as const,
    actions: [
      { actionId: "edit", label: "Edit" },
      { actionId: "delete", label: "Delete", disabled: true },
    ],
  };

  /** Provide deterministic text measurement for rich-cell layout tests. */
  const measure = (text: string) => text.length * 7;

  assert.equal(
    getActionAtPosition(data, 200, 30, 16, 15, measure)?.actionId,
    "edit",
  );
  assert.equal(
    getActionAtPosition(data, 200, 30, 62, 15, measure)?.actionId,
    "delete",
  );
  assert.equal(getActionAtPosition(data, 200, 30, 190, 15, measure), undefined);
});

test("range cells format, clamp fill, and choose threshold tone", () => {
  const data = {
    kind: "rich-range-cell" as const,
    value: 1.25,
    min: 0,
    max: 1,
    mode: "percentage" as const,
    precision: 1,
    warningAt: 0.8,
    criticalAt: 1,
  };

  assert.equal(formatRangeValue(data), "125.0%");
  assert.equal(clampRangeFill(data), 1);
  assert.equal(getRangeTone(data), "danger");
  assert.equal(getRangeTone({ ...data, value: 0.9 }), "warning");
  assert.equal(getRangeTone({ ...data, value: 0.5 }), "accent");
});

test("color swatch type guard accepts new and legacy data kinds", () => {
  assert.equal(
    isColorSwatchCellData({ kind: "rich-color-swatch-cell", color: "#fff" }),
    true,
  );
  assert.equal(
    isColorSwatchCellData({ kind: "color-cell", color: "#fff" }),
    true,
  );
  assert.equal(isColorSwatchCellData({ kind: "other-cell" }), false);
});

test("duration input parses seconds, milliseconds, bpm, and hertz", () => {
  assert.equal(durationToMilliseconds(parseDurationInput("1")!), 1000);
  assert.equal(durationToMilliseconds(parseDurationInput("1s")!), 1000);
  assert.equal(durationToMilliseconds(parseDurationInput("100ms")!), 100);
  assert.equal(durationToMilliseconds(parseDurationInput("50bpm")!), 1200);
  assert.equal(durationToMilliseconds(parseDurationInput("0bpm")!), 0);
  assert.equal(durationToMilliseconds(parseDurationInput(".5 sec")!), 500);
  assert.equal(durationToMilliseconds(parseDurationInput("2hz")!), 500);
  assert.equal(durationToMilliseconds(parseDurationInput("0hz")!), 0);
  assert.equal(durationToMilliseconds(parseDurationInput("1 second")!), 1000);
  assert.equal(
    durationToMilliseconds(parseDurationInput("250 milliseconds")!),
    250,
  );
});

test("duration input rejects invalid or negative values", () => {
  assert.equal(parseDurationInput(""), null);
  assert.equal(parseDurationInput("-1s"), null);
  assert.equal(parseDurationInput("abc"), null);
  assert.equal(parseDurationInput("50bpm", { minMs: 1500 }), null);
  assert.equal(parseDurationInput("0bpm", { minMs: 1 }), null);
});

test("duration formatting supports user display units", () => {
  const duration = parseDurationInput("1250ms")!;

  assert.equal(formatDurationInputValue(duration, "seconds"), "1.25s");
  assert.equal(formatDurationInputValue(duration, "milliseconds"), "1250ms");
  assert.equal(formatDurationInputValue(duration, "bpm"), "48bpm");
  assert.equal(formatDurationInputValue(duration, "hertz"), "0.8hz");
});

/** Verifies zero-length durations keep the explicit unit selected by the operator. */
test("duration formatting honors zero bpm and hertz unit selections", () => {
  const duration = parseDurationInput("0s")!;

  assert.equal(formatDurationInputValue(duration, "bpm"), "0bpm");
  assert.equal(formatDurationInputValue(duration, "hertz"), "0hz");
});

test("duration auto display chooses compact operator-friendly units", () => {
  assert.equal(
    chooseAutoDurationDisplayUnit(parseDurationInput("0s")!),
    "seconds",
  );
  assert.equal(
    formatDurationInputValue(parseDurationInput("1s")!, "auto"),
    "1s",
  );
  assert.equal(
    formatDurationInputValue(parseDurationInput("100ms")!, "auto"),
    "100ms",
  );
  assert.equal(
    formatDurationInputValue(parseDurationInput("50bpm")!, "auto"),
    "50bpm",
  );
  assert.equal(
    formatDurationInputValue(parseDurationInput("1250ms")!, "auto"),
    "48bpm",
  );
  assert.equal(
    formatDurationInputValue(parseDurationInput("1333ms")!, "auto"),
    "1.33s",
  );
});
