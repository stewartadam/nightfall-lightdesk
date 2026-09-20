// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect, type Page } from "./playwright-fixtures";

export const PERFORMANCE_MODULE_UID = "94000000000000000000000000000003";
export const PERFORMANCE_TIMECODE_ID = 9400;
export const PERFORMANCE_TIMECODE_UID = "94000000000000000000000000000001";
export const PERFORMANCE_TIMELINE_UID = "94000000000000000000000000000002";
export const PERFORMANCE_CLIP_IDS = Array.from(
  { length: 12 },
  (_, index) => 400 + index,
);
export const PERFORMANCE_TRIGGER_CLIP_ID = 412;
let componentPath: string | undefined;

/** Builds a repository-owned WASM effect using the artifact path reported by Cargo. */
export async function installPerformanceModule(dataDir: string): Promise<void> {
  if (!componentPath) {
    const manifest = resolve(
      "crates/fx-module/examples/basic-module/Cargo.toml",
    );
    const output = execFileSync(
      "cargo",
      [
        "build",
        "--locked",
        "--manifest-path",
        manifest,
        "--target",
        "wasm32-unknown-unknown",
        "--lib",
        "--message-format=json",
      ],
      { encoding: "utf8", cwd: dirname(manifest) },
    );
    const artifact = output
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
      .find(
        (message) =>
          message.reason === "compiler-artifact" &&
          message.target.name === "fx_module_basic_module",
      );
    const wasm = artifact?.filenames.find((path: string) =>
      path.endsWith(".wasm"),
    );
    if (!wasm)
      throw new Error("Cargo did not report the performance module artifact");
    componentPath = execFileSync(
      "cargo",
      [
        "run",
        "--locked",
        "--manifest-path",
        manifest,
        "--bin",
        "package-component",
        "--",
        "debug",
        wasm,
      ],
      { encoding: "utf8", cwd: dirname(manifest) },
    )
      .trim()
      .split("\n")
      .at(-1);
    if (!componentPath)
      throw new Error("Component packaging did not report an output path");
  }
  await mkdir(join(dataDir, "fx-modules"), { recursive: true });
  await copyFile(componentPath, join(dataDir, "fx-modules/basic-module.wasm"));
}

/** Adds thirteen real effects and the historical trigger windows to fresh repository sample data. */
export async function seedPerformanceTimeline(page: Page): Promise<{
  fixtures: number;
  parameters: number;
  moduleTargets: number;
  clips: number;
  moduleSelection: Array<{ fixture_uid: string; index: number }>;
}> {
  await page.waitForFunction(
    () =>
      Object.keys((window as any).appStores?.fixtures?.get?.() ?? {}).length >
      0,
  );
  const load = await page.evaluate(
    async ({ timecodeId, timecodeUid, timelineUid, clipIds, moduleUid }) => {
      const stores = (window as any).appStores;
      /** Rejects failed seed commands before collecting any performance measurements. */
      const send = async (module: string, type: string, data: unknown) => {
        const result = await stores.sendAndAwait({
          module,
          command: { type, data },
        });
        if (result.outcome.type !== "Succeeded")
          throw new Error(JSON.stringify(result));
      };
      const sampleClips = Object.values(stores.clips.get()) as any[];
      const fixtures = Object.values(stores.fixtures.get()) as any[];
      const selection = fixtures.flatMap((fixture) =>
        fixture.elements.flatMap((element: any, index: number) =>
          element.parameters.some(
            (parameter: any) => parameter.attribute?.type === "Intensity",
          )
            ? [{ fixture_uid: fixture.identifiers.uid, index: index + 1 }]
            : [],
        ),
      );
      const clipUids: string[] = [];
      for (const [index, id] of clipIds.entries()) {
        const source = sampleClips.find(
          ([clip]) => clip.identifiers.id === [26, 27, 28][index % 3],
        )?.[0];
        if (!source?.source)
          throw new Error("Dense sample FX clips were not initialized");
        const uid = `9400000000000000000000000000${id.toString(16).padStart(4, "0")}`;
        const effect = stores.stepFx.get()[source.source.data];
        if (!effect)
          throw new Error("Sample Step FX definition was not initialized");
        const effectUid = `9500000000000000000000000000${id.toString(16).padStart(4, "0")}`;
        await send("StepFxCommand", "Store", {
          ...effect,
          identifiers: {
            id: 9500 + index,
            uid: effectUid,
            label: `Performance effect ${index + 1}`,
          },
        });
        await send("ClipCommand", "StoreClip", {
          ...source,
          source: { type: "StepFx", data: effectUid },
          identifiers: { id, uid, label: `Performance layer ${index + 1}` },
        });
        clipUids.push(uid);
      }
      const triggerUid = "94000000000000000000000000000004";
      await send("FxModuleCommand", "StoreFxModule", {
        identifiers: { id: 9412, uid: moduleUid, label: "Performance pulse" },
        module_name: "basic-module",
        selection: {
          source: { type: "Resolved", data: selection },
          clauses: [],
        },
        config: { rand: "5" },
        merge: false,
      });
      await send("ClipCommand", "StoreClip", {
        identifiers: { id: 412, uid: triggerUid, label: "Owned WASM pulse" },
        source: { type: "FxModule", data: moduleUid },
        priority: 0,
        options: { auto_release: false, deactivate_on_sequence_end: false },
      });
      await send("TimecodeCommand", "StoreTimecode", {
        identifiers: {
          id: timecodeId,
          uid: timecodeUid,
          label: "Performance clock",
        },
        rate: "Fps30",
        source: "Internal",
      });
      const allClips = [...clipUids, triggerUid];
      /** Converts exact historical positions into serialized engine durations. */
      const duration = (milliseconds: number) => ({
        secs: Math.floor(milliseconds / 1000),
        nanos: (milliseconds % 1000) * 1_000_000,
      });
      await send("TimelineCommand", "StoreTimeline", {
        identifiers: {
          id: 9400,
          uid: timelineUid,
          label: "Owned performance timeline",
        },
        timecode_uid: timecodeUid,
        timecode_start: duration(0),
        trigger_mode: "FollowTimecode",
        audio_path: "",
        audio_enabled: false,
        tracks: allClips.map((uid, index) => ({
          id: `load-${index}`,
          label: `Layer ${index + 1}`,
          muted: false,
          solo: false,
          expanded: true,
          automation_lanes: [],
          actions: [16_500, 29_500, 169_210].map((position, window) => ({
            id: `load-${index}-${window}`,
            label: `Effect ${index + 1}`,
            position: duration(position),
            duration: duration(10_000),
            action: { type: "StartClip", data: uid },
          })),
        })),
        markers: [],
        regions: [],
        bpm: 120,
        beats_per_bar: 4,
        use_beat_grid: false,
        lookahead: "enabled",
        scroll_mode: "follow",
      });
      return {
        fixtures: fixtures.length,
        parameters: fixtures.reduce(
          (count, fixture) =>
            count +
            fixture.elements.reduce(
              (sum: number, element: any) => sum + element.parameters.length,
              0,
            ),
          0,
        ),
        moduleTargets: selection.length,
        moduleSelection: selection,
        clips: allClips.length,
      };
    },
    {
      moduleUid: PERFORMANCE_MODULE_UID,
      timecodeId: PERFORMANCE_TIMECODE_ID,
      timecodeUid: PERFORMANCE_TIMECODE_UID,
      timelineUid: PERFORMANCE_TIMELINE_UID,
      clipIds: PERFORMANCE_CLIP_IDS,
    },
  );
  expect(load.fixtures).toBeGreaterThanOrEqual(100);
  expect(load.parameters).toBeGreaterThanOrEqual(10_000);
  expect(load.moduleTargets).toBeGreaterThanOrEqual(24);
  expect(load.clips).toBe(13);
  return load;
}
