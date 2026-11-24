// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Composition, staticFile } from "remotion";
import { REELS } from "../reels";
import {
  REEL_FPS,
  REEL_HEIGHT,
  REEL_WIDTH,
  type RecordingManifest,
} from "../shared/edit";
import { Reel, type ReelProps } from "./Reel";

/**
 * Registers one composition per reel. Each reads its latest take from the
 * public dir (`promo/out/<reel>/recording.json`) and sizes itself to the
 * edit, so a new take re-times the reel without code changes.
 */
export function RemotionRoot() {
  return (
    <>
      {REELS.map((reel) => (
        <Composition
          key={reel.id}
          id={reel.id}
          component={Reel}
          width={REEL_WIDTH}
          height={REEL_HEIGHT}
          fps={REEL_FPS}
          durationInFrames={REEL_FPS * 20}
          defaultProps={{ manifest: null, edit: null } as ReelProps}
          calculateMetadata={async ({ props }) => {
            const response = await fetch(
              staticFile(`${reel.id}/recording.json`),
            );
            if (!response.ok) {
              throw new Error(
                `No take of "${reel.id}" yet. Run \`pnpm --dir promo run record ${reel.id}\` first.`,
              );
            }
            const manifest = (await response.json()) as RecordingManifest;
            const edit = reel.buildEdit(manifest);
            return {
              durationInFrames: Math.round(edit.totalSeconds * REEL_FPS),
              props: { ...props, manifest, edit },
            };
          }}
        />
      ))}
    </>
  );
}
