// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { RepeatIcon } from "@squidlab/phosphor-solid/repeat";
import type {
  Blueprint,
  Clip,
  ColorPath,
  Cue,
  Fixture,
  Fx,
  Master,
  SceneObject,
  Sequence,
  StoredFxModule,
  Timecode,
  Timeline,
} from "../types";
import {
  buildShowfileObjectSearchEntries,
  filterShowfileObjectSearchEntries,
  parseShowfileObjectTypeToken,
  showfileObjectResultLabel,
} from "./showfile-object-search";

/** Builds the smallest store snapshot needed by object-palette search tests. */
function createSnapshot(
  overrides: Partial<
    Parameters<typeof buildShowfileObjectSearchEntries>[0]
  > = {},
) {
  return {
    fixtures: {},
    groups: {},
    cues: {},
    sequences: {},
    fx: {},
    stepFx: {},
    fxModules: {},
    clips: {},
    flows: {},
    blueprints: {},
    colorPaths: {},
    masters: {},
    sceneObjects: {},
    timecodes: {},
    timelines: {},
    ...overrides,
  };
}

/** Creates a minimal generated-type object with shared identifiers. */
function withIdentifiers<T extends object>(
  id: number,
  label: string,
  extra: T,
): T & { identifiers: { id: number; uid: string; label: string } } {
  return {
    identifiers: { id, uid: `${label}-${id}`, label },
    ...extra,
  };
}

test("parses known type tokens only after whitespace", () => {
  assert.equal(parseShowfileObjectTypeToken("fx"), null);
  const parsed = parseShowfileObjectTypeToken("fx ");
  assert.equal(parsed?.definition.type, "fx");
  assert.equal(parsed?.rest, "");
  assert.equal(parseShowfileObjectTypeToken("unknown 1"), null);
  assert.equal(parseShowfileObjectTypeToken("fixturehouse 1"), null);
});

test("filters scoped fx queries by id prefix", () => {
  const entries = buildShowfileObjectSearchEntries(
    createSnapshot({
      fx: {
        fx10: withIdentifiers(10, "Pulse", {
          selection: {},
          attributes: {},
        }) as unknown as Fx,
        fx21: withIdentifiers(21, "Sweep", {
          selection: {},
          attributes: {},
        }) as unknown as Fx,
      },
      cues: {
        cue12: withIdentifiers(
          12,
          "Cue shares id prefix",
          {},
        ) as unknown as Cue,
      },
    }),
  );

  const result = filterShowfileObjectSearchEntries(entries, "1", "fx");
  assert.deepEqual(
    result.map((entry) => `${entry.type}:${entry.id}`),
    ["fx:10"],
  );
});

test("matches cue labels and descriptions as phrases", () => {
  const entries = buildShowfileObjectSearchEntries(
    createSnapshot({
      cues: {
        cue1: withIdentifiers(1, "Opening look", {
          description: "stage wash low intensity",
        }) as unknown as Cue,
        cue2: withIdentifiers(2, "Stage chase", {
          description: "fast sweep",
        }) as unknown as Cue,
      },
    }),
  );

  assert.deepEqual(
    filterShowfileObjectSearchEntries(entries, "stage wash", "cue").map(
      (entry) => entry.id,
    ),
    [1],
  );
});

test("uses sequence-qualified cue display IDs", () => {
  const entries = buildShowfileObjectSearchEntries(
    createSnapshot({
      cues: {
        "Blackout-2": withIdentifiers(2, "Blackout", {}) as unknown as Cue,
      },
      sequences: {
        seq7: withIdentifiers(7, "Main Sequence", {
          steps: ["Blackout-2"],
        }) as unknown as Sequence,
      },
    }),
  );

  const cue = filterShowfileObjectSearchEntries(entries, "7.2", "cue")[0];
  assert.equal(cue?.displayId, "7.2");
});

test("adds a wrap tag to wrapping sequence entries", () => {
  const entries = buildShowfileObjectSearchEntries(
    createSnapshot({
      sequences: {
        seq7: withIdentifiers(7, "Main Sequence", {
          steps: [],
          wrap: true,
        }) as unknown as Sequence,
      },
    }),
  );

  const sequence = filterShowfileObjectSearchEntries(
    entries,
    "7",
    "sequence",
  )[0];
  assert.deepEqual(sequence?.tags, [
    {
      id: "wrap",
      label: "Wrap sequence",
      icon: RepeatIcon,
    },
  ]);
});

test("adds profile and mode tags to fixture entries", () => {
  const entries = buildShowfileObjectSearchEntries(
    createSnapshot({
      fixtures: {
        fixture11: withIdentifiers(11, "Downstage Spot", {
          make: "Acme",
          model: "Spot 350",
          mode: "16ch",
          elements: [],
        }) as unknown as Fixture,
      },
    }),
  );

  const fixture = filterShowfileObjectSearchEntries(
    entries,
    "16ch",
    "fixture",
  )[0];
  assert.deepEqual(fixture?.tags, [
    {
      id: "fixture-profile",
      label: "Acme Spot 350",
      text: "Spot 350",
    },
    {
      id: "fixture-mode",
      label: "Mode 16ch",
      text: "16ch",
    },
  ]);
});

test("adds option tags to clip entries", () => {
  const entries = buildShowfileObjectSearchEntries(
    createSnapshot({
      clips: {
        exec3: [
          withIdentifiers(3, "Main go", {
            priority: 0,
            options: {
              auto_release: true,
              deactivate_on_sequence_end: true,
            },
          }) as unknown as Clip,
          false,
        ],
      },
    }),
  );

  const clip = filterShowfileObjectSearchEntries(entries, "ar", "clip")[0];
  assert.deepEqual(clip?.tags, [
    {
      id: "auto-release",
      label: "Auto release",
      text: "AR",
    },
    {
      id: "deactivate-on-sequence-end",
      label: "Deactivate on sequence end",
      text: "END",
    },
  ]);
});

test("formats unnamed entries with a visible fallback label", () => {
  const entries = buildShowfileObjectSearchEntries(
    createSnapshot({
      fx: {
        fx16: withIdentifiers(16, "   ", {
          selection: {},
          attributes: {},
        }) as unknown as Fx,
      },
    }),
  );

  const fx = filterShowfileObjectSearchEntries(entries, "16", "fx")[0];
  assert.equal(fx?.label, "   ");
  assert.equal(fx ? showfileObjectResultLabel(fx) : "", "Unnamed");
});

test("parses bp as a blueprint type token", () => {
  const parsed = parseShowfileObjectTypeToken("bp 4");
  assert.equal(parsed?.definition.type, "blueprint");
  assert.equal(parsed?.rest, "4");
});

test("parses timeline timecode color master and module fx type tokens", () => {
  assert.equal(
    parseShowfileObjectTypeToken("timeline 4")?.definition.type,
    "timeline",
  );
  assert.equal(
    parseShowfileObjectTypeToken("tc 8")?.definition.type,
    "timecode",
  );
  assert.equal(
    parseShowfileObjectTypeToken("color-path rainbow")?.definition.type,
    "colorPath",
  );
  assert.equal(
    parseShowfileObjectTypeToken("master 1")?.definition.type,
    "master",
  );
  assert.equal(
    parseShowfileObjectTypeToken("fx-module swipes")?.definition.type,
    "fxModule",
  );
});

test("filters blueprint entries when scoped by bp alias", () => {
  const entries = buildShowfileObjectSearchEntries(
    createSnapshot({
      blueprints: {
        bp4: withIdentifiers(4, "Position Fan", {
          values: { Pan: { type: "Unset" } },
        }) as unknown as Blueprint,
      },
      fx: {
        fx4: withIdentifiers(4, "Other id", {
          selection: {},
          attributes: {},
        }) as unknown as Fx,
      },
    }),
  );

  const parsed = parseShowfileObjectTypeToken("bp 4");
  assert.deepEqual(
    filterShowfileObjectSearchEntries(
      entries,
      parsed?.rest ?? "",
      parsed?.definition.type,
    ).map((entry) => `${entry.type}:${entry.id}`),
    ["blueprint:4"],
  );
});

test("searches all object families without an active type", () => {
  const entries = buildShowfileObjectSearchEntries(
    createSnapshot({
      sceneObjects: {
        object1: withIdentifiers(31, "Stage Left Truss", {
          objectType: "truss",
          placement: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
          },
          properties: {
            type: "Truss",
            data: { length: 2, trussType: "Box", diameter: 0.3 },
          },
        }) as unknown as SceneObject,
      },
      colorPaths: {
        color4: withIdentifiers(4, "Rainbow Path", {
          interpolation_space: "Hsv",
        }) as unknown as ColorPath,
      },
      masters: {
        master5: withIdentifiers(5, "House Master", {
          kind: "InhibitiveIntensity",
          target: { type: "Fixtures", data: { type: "All" } },
        }) as unknown as Master,
        master6: withIdentifiers(6, "Speed Master", {
          kind: "PlaybackRate",
          target: { type: "Instances", data: { type: "Clips", data: [1] } },
        }) as unknown as Master,
      },
      timecodes: {
        tc6: [
          withIdentifiers(6, "Backing Track", {
            rate: "Fps30",
            source: "Internal",
          }) as unknown as Timecode,
          {},
        ],
      },
      timelines: {
        tl7: withIdentifiers(7, "Opening Timeline", {
          audio_path: "song.wav",
          tracks: [],
        }) as unknown as Timeline,
      },
      fxModules: {
        module8: withIdentifiers(8, "Stored Module", {
          module_name: "example-pattern",
          selection: {},
          config: {},
        }) as unknown as StoredFxModule,
      },
    }),
  );

  assert.deepEqual(
    filterShowfileObjectSearchEntries(entries, "stage left").map(
      (entry) => `${entry.type}:${entry.id}`,
    ),
    ["sceneObject:31"],
  );
  assert.deepEqual(
    filterShowfileObjectSearchEntries(entries, "rainbow").map(
      (entry) => `${entry.type}:${entry.id}`,
    ),
    ["colorPath:4"],
  );
  assert.deepEqual(
    filterShowfileObjectSearchEntries(entries, "house").map(
      (entry) => `${entry.type}:${entry.id}`,
    ),
    ["master:5"],
  );
  assert.deepEqual(
    filterShowfileObjectSearchEntries(entries, "clips").map(
      (entry) => `${entry.type}:${entry.id}`,
    ),
    ["master:6"],
  );
  assert.deepEqual(
    filterShowfileObjectSearchEntries(entries, "backing").map(
      (entry) => `${entry.type}:${entry.id}`,
    ),
    ["timecode:6"],
  );
  assert.deepEqual(
    filterShowfileObjectSearchEntries(entries, "opening").map(
      (entry) => `${entry.type}:${entry.id}`,
    ),
    ["timeline:7"],
  );
  assert.deepEqual(
    filterShowfileObjectSearchEntries(entries, "pattern").map(
      (entry) => `${entry.type}:${entry.id}`,
    ),
    ["fxModule:8"],
  );
});
