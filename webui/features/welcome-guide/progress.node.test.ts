// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type GuideSnapshot, guideCompletionToken } from "./progress";

/** Builds the minimal domain state needed to exercise guide completion independently. */
function sampleState(): GuideSnapshot {
  return {
    fixtures: Object.fromEntries(
      [310, 311, 312, 313, 320].map((id) => [
        String(id),
        { identifiers: { id, uid: String(id) } },
      ]),
    ),
    sequences: { sequence: { identifiers: { id: 1 }, steps: ["cue"] } },
    cues: {
      cue: {
        identifiers: { id: 1, uid: "cue", label: "cue 1" },
        instructions: [{}],
      },
    },
    timelines: {
      timeline: {
        identifiers: { id: 1 },
        timecode_uid: "clock",
        timecode_start: { secs: 0, nanos: 0 },
        tracks: [
          {
            id: "1",
            actions: [{ id: "1", position: { secs: 3, nanos: 600000000 } }],
          },
        ],
      },
    },
    clips: {},
    selection: [],
    programmer: [],
    controls: [],
    instances: {},
    timecodes: {},
  } as unknown as GuideSnapshot;
}

/** Opening the palette and activating the Programmer satisfy distinct guide observations. */
test("guide distinguishes the command palette from the Programmer panel", () => {
  const state = sampleState();
  const palette = { type: "command-palette" } as const;
  const programmer = { type: "panel", component: "ProgrammerGrid" } as const;
  assert.equal(guideCompletionToken(palette, state), "");
  state.commandPaletteOpen = true;
  assert.equal(guideCompletionToken(palette, state), "open");
  assert.equal(guideCompletionToken(programmer, state), "");
  state.commandPaletteOpen = false;
  state.panel = "ProgrammerGrid";
  assert.equal(guideCompletionToken(palette, state), "");
  assert.equal(guideCompletionToken(programmer, state), "ProgrammerGrid");
});

/** Selection progress requires the exact four demonstrated fixtures, not any nonempty selection. */
test("guide ignores unrelated fixture selection and partial intensity edits", () => {
  const state = sampleState();
  const ids = Object.values(state.fixtures)
    .sort((a, b) => a.identifiers.id - b.identifiers.id)
    .map((fixture) => fixture.identifiers.uid);
  state.selection = ids.slice(1);
  assert.equal(guideCompletionToken({ type: "selection" }, state), "");
  state.selection = ids.slice(0, 4);
  assert.equal(guideCompletionToken({ type: "selection" }, state), "selected");
  state.programmer = state.selection.map((fixtureUid) => ({
    fixtureUid,
    attributes: {
      Intensity: { value: 1, isPercentage: true, isRelative: false },
    },
  }));
  assert.equal(guideCompletionToken({ type: "intensity" }, state), "intensity");
  state.programmer[3].attributes.Intensity.value = 0.5;
  assert.equal(guideCompletionToken({ type: "intensity" }, state), "");
});

/** Only storage into the sample sequence with the requested label completes its cue step. */
test("guide ignores unrelated cue edits", () => {
  const state = sampleState();
  const sequence = Object.values(state.sequences)[0];
  const cue = state.cues[sequence.steps[0]];
  const observation = { type: "cue", id: 1, label: "Guide Red" } as const;
  state.cues.unrelated = {
    ...cue,
    identifiers: { ...cue.identifiers, uid: "unrelated", label: "Guide Red" },
  };
  assert.equal(guideCompletionToken(observation, state), "");
  cue.identifiers.label = "Guide Red";
  assert.notEqual(guideCompletionToken(observation, state), "");
});

/** A paused clock away from the start does not count as the requested timeline stop. */
test("guide distinguishes paused playback from a stopped sample timeline", () => {
  const state = sampleState();
  const timeline = Object.values(state.timelines)[0];
  state.timecodes[timeline.timecode_uid] = [
    {
      identifiers: { id: 1, uid: "clock", label: "Timecode 1" },
      rate: "Fps30",
      source: "Internal",
    },
    { timecode_id: 1, is_active: true, current_time: { secs: 1, nanos: 0 } },
  ] as GuideSnapshot["timecodes"][string];
  assert.equal(
    guideCompletionToken({ type: "timeline-playing" }, state),
    "playing",
  );
  const clock = state.timecodes[timeline.timecode_uid][1];
  clock.is_active = false;
  assert.equal(guideCompletionToken({ type: "timeline-stopped" }, state), "");
  clock.current_time = { ...timeline.timecode_start };
  assert.equal(
    guideCompletionToken({ type: "timeline-stopped" }, state),
    "stopped",
  );
});

/** A repeated action ID on another track must not complete the FX timing step. */
test("guide observes only the FX Track action at three seconds", () => {
  const state = sampleState();
  const timeline = Object.values(state.timelines)[0];
  const observation = { type: "timeline-action-moved" } as const;
  assert.equal(guideCompletionToken(observation, state), "");
  timeline.tracks.push({
    ...timeline.tracks[0],
    id: "2",
    actions: [
      { ...timeline.tracks[0].actions[0], position: { secs: 3, nanos: 0 } },
    ],
  });
  assert.equal(guideCompletionToken(observation, state), "");
  timeline.tracks[0].actions[0].position = { secs: 3, nanos: 0 };
  assert.equal(guideCompletionToken(observation, state), "moved");
});
