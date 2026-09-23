// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Cue, Fixture, Sequence, Timeline } from "../../types";
import { type GuideSnapshot, guideCompletionToken } from "./progress";

/** Loads the release sample so lessons fail validation when their assumed content drifts. */
function sampleState(): GuideSnapshot {
  const sample = JSON.parse(
    readFileSync(
      join(
        process.env.NIGHTFALL_REPO_ROOT ?? process.cwd(),
        "webui/public/nightfall-demo.nightfall-show/showfile.json",
      ),
      "utf8",
    ),
  );
  /** Indexes release-owned objects exactly as the runtime stores do. */
  const keyed = <T extends { identifiers: { uid: string } }>(
    objects: T[],
  ): Record<string, T> =>
    Object.fromEntries(objects.map((entry) => [entry.identifiers.uid, entry]));
  return {
    fixtures: keyed<Fixture>(sample.fixtures),
    sequences: keyed<Sequence>(sample.sequences),
    cues: keyed<Cue>(sample.cues),
    timelines: keyed<Timeline>(sample.timelines),
    clips: {},
    selection: [],
    programmer: [],
    controls: [],
    instances: {},
    timecodes: {},
  };
}

/** Selection progress requires the exact five demonstrated fixtures, not any nonempty selection. */
test("guide ignores unrelated fixture selection and partial intensity edits", () => {
  const state = sampleState();
  const ids = Object.values(state.fixtures)
    .sort((a, b) => a.identifiers.id - b.identifiers.id)
    .map((fixture) => fixture.identifiers.uid);
  state.selection = ids.slice(1);
  assert.equal(guideCompletionToken({ type: "selection" }, state), "");
  state.selection = ids.slice(0, 5);
  assert.equal(guideCompletionToken({ type: "selection" }, state), "selected");
  state.programmer = state.selection.map((fixtureUid) => ({
    fixtureUid,
    attributes: {
      Intensity: { value: 1, isPercentage: true, isRelative: false },
    },
  }));
  assert.equal(guideCompletionToken({ type: "intensity" }, state), "intensity");
  state.programmer[4].attributes.Intensity.value = 0.5;
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
  const sample = JSON.parse(
    readFileSync(
      join(
        process.env.NIGHTFALL_REPO_ROOT ?? process.cwd(),
        "webui/public/nightfall-demo.nightfall-show/showfile.json",
      ),
      "utf8",
    ),
  );
  state.timecodes[timeline.timecode_uid] = [
    sample.timecodes[0],
    { timecode_id: 1, is_active: true, current_time: { secs: 1, nanos: 0 } },
  ];
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

/** Keeps the named sample targets and authored timing used by the walkthrough explicit. */
test("guide targets remain present in the bundled sample", () => {
  const state = sampleState();
  assert.deepEqual(
    Object.values(state.fixtures)
      .map((entry) => entry.identifiers.id)
      .sort(),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(
    Object.values(state.sequences)[0].identifiers.label,
    "Nightfall Looks",
  );
  const timeline = Object.values(state.timelines)[0];
  assert.equal(timeline.identifiers.label, "Nightfall Demo");
  const action = timeline.tracks
    .flatMap((track) => track.actions)
    .find((entry) => entry.id === "start-wave");
  assert.equal(action?.label, "Intensity Wave");
  assert.deepEqual(action?.position, { secs: 2, nanos: 500000000 });
});
