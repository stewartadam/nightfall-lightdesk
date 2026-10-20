// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseAutoDurationDisplayUnit,
  durationToMilliseconds,
  formatDurationInputValue,
  getActionAtPosition,
  parseDurationInput,
} from "./datagrid-rich-cell-helpers";
import { makeTimeCell } from "./datagrid-rich-cells";

test("time cells include badges in copy data", () => {
  const cell = makeTimeCell({
    value: { secs: 10, nanos: 0 },
    badges: [{ label: "V", tone: "warning", title: "Varied" }],
  });

  assert.equal(cell.copyData, "[V] 10s");
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

/** Verifies beat fields read bare numbers, beat suffixes and fractions as beats and refuse clock units. */
test("duration input parses beats for beat-timed fields", () => {
  const beats = (input: string) =>
    parseDurationInput(input, { beats: true }) &&
    durationToMilliseconds(parseDurationInput(input, { beats: true })!);
  assert.equal(beats("2"), 2000);
  assert.equal(beats("2b"), 2000);
  assert.equal(beats("1.5 beats"), 1500);
  assert.equal(beats("3/4"), 750);
  assert.equal(beats("2s"), null);
  assert.equal(beats("120bpm"), null);
  assert.equal(beats("1/0"), null);
  assert.equal(
    formatDurationInputValue({ secs: 0, nanos: 750_000_000 }, "beats"),
    "0.75b",
  );
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
