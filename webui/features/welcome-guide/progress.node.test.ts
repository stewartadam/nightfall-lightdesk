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
  const strips = {
    type: "selection",
    fixtureIds: [310, 311, 312, 313],
  } as const;
  state.selection = ids.slice(1);
  assert.equal(guideCompletionToken(strips, state), "");
  state.selection = ids.slice(0, 4);
  assert.equal(guideCompletionToken(strips, state), "selected:310,311,312,313");
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

/** Only stored instructions for the requested sequence and cue matter, regardless of label. */
test("guide observes cue identity and instructions independently of labels", () => {
  const state = sampleState();
  const sequence = Object.values(state.sequences)[0];
  const cue = state.cues[sequence.steps[0]];
  const observation = { type: "cue", sequenceId: 1, id: 1 } as const;
  const initial = guideCompletionToken(observation, state);
  assert.notEqual(initial, "");
  state.cues.unrelated = {
    ...cue,
    identifiers: { ...cue.identifiers, uid: "unrelated", label: "Guide Red" },
  };
  assert.equal(guideCompletionToken(observation, state), initial);
  cue.identifiers.label = "Guide Red";
  assert.equal(guideCompletionToken(observation, state), initial);
  assert.equal(
    guideCompletionToken({ ...observation, sequenceId: 2 }, state),
    "",
  );
  assert.equal(guideCompletionToken({ ...observation, id: 2 }, state), "");
  cue.instructions = [...cue.instructions, ...cue.instructions];
  assert.notEqual(guideCompletionToken(observation, state), initial);
  cue.instructions = [];
  assert.equal(guideCompletionToken(observation, state), "");
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

/** A repeated action ID on another track must not complete the FX timing step; nearby drags count. */
test("guide observes only the FX Track action near three seconds", () => {
  const state = sampleState();
  const timeline = Object.values(state.timelines)[0];
  const observation = {
    type: "timeline-action-position",
    trackId: "1",
    actionId: "1",
    positionMs: 3000,
    toleranceMs: 50,
  } as const;
  assert.equal(guideCompletionToken(observation, state), "");
  timeline.tracks.push({
    ...timeline.tracks[0],
    id: "2",
    actions: [
      { ...timeline.tracks[0].actions[0], position: { secs: 3, nanos: 0 } },
    ],
  });
  assert.equal(guideCompletionToken(observation, state), "");
  timeline.tracks[0].actions[0].position = { secs: 3, nanos: 40_000_000 };
  assert.equal(guideCompletionToken(observation, state), "moved:3040");
  timeline.tracks[0].actions[0].position = { secs: 3, nanos: 100_000_000 };
  assert.equal(guideCompletionToken(observation, state), "");
});

/** Selecting the FX action completes only when it is the sole selection in the sample timeline. */
test("guide observes a single selected sample timeline action", () => {
  const state = sampleState();
  const timeline = Object.values(state.timelines)[0];
  timeline.identifiers.uid = "sample-timeline";
  const observation = {
    type: "timeline-action-selected",
    trackId: "1",
    actionId: "1",
  } as const;
  const fx = { timelineUid: "sampletimeline", trackId: "1", actionId: "1" };
  state.selectedTimelineActions = [{ ...fx, timelineUid: "other" }];
  assert.equal(guideCompletionToken(observation, state), "");
  state.selectedTimelineActions = [fx, { ...fx, trackId: "2" }];
  assert.equal(guideCompletionToken(observation, state), "");
  state.selectedTimelineActions = [fx];
  assert.equal(guideCompletionToken(observation, state), "selected");
});

/** Command steps complete only for the lesson command, tolerating spacing and case differences. */
test("guide matches submitted lesson commands after normalization", () => {
  const state = sampleState();
  const observation = {
    type: "command-submitted",
    command: "fix 601>606 green @ 100; sleep 2; clear",
  } as const;
  assert.equal(guideCompletionToken(observation, state), "");
  state.submittedCommand = "fix 310";
  assert.equal(guideCompletionToken(observation, state), "");
  state.submittedCommand = "  FIX 601>606  green @ 100; sleep 2; clear ";
  assert.equal(guideCompletionToken(observation, state), "submitted");
});

/** Playback counts as idle while only editor previews and the Programmer remain active. */
test("guide treats previews and the Programmer as idle playback", () => {
  const state = sampleState();
  const idle = { type: "playback-idle" } as const;
  assert.equal(guideCompletionToken(idle, state), "idle");
  state.instances = {
    preview: { is_preview: true, display_kind: "StepFx" },
    programmer: { is_preview: false, display_kind: "Programmer" },
  } as unknown as GuideSnapshot["instances"];
  assert.equal(guideCompletionToken(idle, state), "idle");
  state.instances.clip = {
    is_preview: false,
    display_kind: "Fx",
  } as unknown as GuideSnapshot["instances"][string];
  assert.equal(guideCompletionToken(idle, state), "");
  assert.equal(
    guideCompletionToken({ type: "step-fx-preview-stopped" }, state),
    "",
  );
  delete state.instances.preview;
  assert.equal(
    guideCompletionToken({ type: "step-fx-preview-stopped" }, state),
    "stopped",
  );
});

/** Patch steps follow the edit selection and active view rather than programmer selection. */
test("guide observes Patch edit selection and view", () => {
  const state = sampleState();
  const picked = { type: "fixture-edit-selected", fixtureId: 310 } as const;
  assert.equal(guideCompletionToken(picked, state), "");
  state.selection = ["310"];
  assert.equal(guideCompletionToken(picked, state), "");
  state.editSelection = ["310"];
  assert.equal(guideCompletionToken(picked, state), "selected");
  const view = { type: "patch-view", view: "bindings" } as const;
  state.patchView = "fixtures";
  assert.equal(guideCompletionToken(view, state), "");
  state.patchView = "bindings";
  assert.equal(guideCompletionToken(view, state), "bindings");
  const none = { type: "selection", fixtureIds: [] } as const;
  assert.equal(guideCompletionToken(none, state), "");
  state.selection = [];
  assert.equal(guideCompletionToken(none, state), "selected:");
});

/** Step FX steps read the open editor's stored effect for selection, phase, and speed. */
test("guide observes the open Step FX editor's stored effect", () => {
  const state = sampleState();
  const selection = { type: "step-fx", selection: [310, 313] } as const;
  const together = { type: "step-fx", phase: "together" } as const;
  const slow = { type: "step-fx", beatSeconds: 1 } as const;
  const effect = {
    identifiers: { uid: "8fa12a9a059f4d9ca4502d6a417eba4f" },
    selection: {
      source: {
        type: "FixtureRange",
        data: { start: { fixture_id: 1 }, end: { fixture_id: 1 } },
      },
      clauses: [],
    },
    phase: { waypoints: [0, 1] },
    timing: { beat_duration: { secs: 0, nanos: 500_000_000 } },
  };
  state.stepFx = {
    chase: effect,
  } as unknown as GuideSnapshot["stepFx"];
  assert.equal(guideCompletionToken(selection, state), "");
  state.openPanels = [
    {
      component: "StepFxEditor",
      stepFxUid: "8fa12a9a-059f-4d9c-a450-2d6a417eba4f",
    },
  ];
  assert.equal(guideCompletionToken(selection, state), "");
  effect.selection.source.data = {
    start: { fixture_id: 310, element_index: null },
    end: { fixture_id: 313, element_index: null },
  } as never;
  assert.equal(guideCompletionToken(selection, state), "matched");
  assert.equal(guideCompletionToken(together, state), "");
  effect.phase.waypoints = [0];
  assert.equal(guideCompletionToken(together, state), "matched");
  assert.equal(guideCompletionToken(slow, state), "");
  effect.timing.beat_duration = { secs: 1, nanos: 0 };
  assert.equal(guideCompletionToken(slow, state), "matched");
});

/** Closing every editor of a component completes the close step. */
test("guide observes a closed panel component", () => {
  const state = sampleState();
  const closed = { type: "panel-closed", component: "FxEditor" } as const;
  state.openPanels = [{ component: "FxEditor" }];
  assert.equal(guideCompletionToken(closed, state), "");
  state.openPanels = [{ component: "FxList" }];
  assert.equal(guideCompletionToken(closed, state), "closed");
});
