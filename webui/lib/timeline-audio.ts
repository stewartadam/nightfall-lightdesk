// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getBackendUrl } from "./api";
import { isEmbeddedDemoRuntime } from "./runtime-config";
import { resolveShowfileResourceUrl } from "./showfile-resources";

const SUPPORTED_TIMELINE_AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".mp4"];

/** Resolve a timeline audio reference relative to its owning showfile. */
export function resolveTimelineAudioUrl(
  audioPath: string,
  revision?: string | number,
): string {
  return resolveShowfileResourceUrl(audioPath, revision);
}

/** Return whether a browser file uses a supported timeline media extension. */
export function isSupportedTimelineAudioFile(file: File): boolean {
  const lowercaseName = file.name.toLowerCase();
  return SUPPORTED_TIMELINE_AUDIO_EXTENSIONS.some((extension) =>
    lowercaseName.endsWith(extension),
  );
}

type UploadTimelineAudioResponse = {
  audio_path: string;
};

/** Upload timeline audio to native showfile storage and return its stored path. */
export async function uploadTimelineAudio(
  timelineUid: string,
  file: File,
): Promise<{ audioPath: string }> {
  if (isEmbeddedDemoRuntime()) {
    throw new Error("Audio upload is unavailable in the browser demo.");
  }
  const formData = new FormData();
  formData.append("file", file, file.name);

  const response = await fetch(
    `${getBackendUrl()}/api/showfiles/current/timeline-audio/${encodeURIComponent(timelineUid)}`,
    {
      method: "POST",
      body: formData,
    },
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Upload failed with status ${response.status}`);
  }

  const payload = (await response.json()) as UploadTimelineAudioResponse;
  return { audioPath: payload.audio_path };
}
