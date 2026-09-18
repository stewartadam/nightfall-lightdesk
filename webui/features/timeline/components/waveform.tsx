// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createEffect,
  createRenderEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import WaveSurfer from "wavesurfer.js";
import { getLogger } from "../../../lib/logger";
import { msToPixels } from "../../../lib/utils";
import { useTimelineContext } from "../context/timeline-context";
import { seekPositionFromTimelineX } from "../model/grid-utils";

const log = getLogger(import.meta.url);

export const ConnectedWaveform = () => {
  const ctx = useTimelineContext();
  return (
    <Waveform
      audioUrl={ctx.audioPath()}
      zoom={ctx.zoom()}
      onAudioLoaded={ctx.setEnd}
    />
  );
};

interface WaveformProps {
  audioUrl: string;
  zoom: number;
  onAudioLoaded?: (duration: number) => void;
}

const Waveform = (props: WaveformProps) => {
  const ctx = useTimelineContext();
  let waveformRef!: HTMLDivElement;
  const [waveSurferObj, setWaveSurferObj] = createSignal<WaveSurfer>();
  const [decodedDurationMs, setDecodedDurationMs] = createSignal(0);
  const [loadState, setLoadState] = createSignal<
    "idle" | "loading" | "decoded" | "error"
  >("idle");

  const handleSeekPointer = (clientX: number) => {
    const rect = waveformRef.getBoundingClientRect();
    const x = clientX - rect.left;
    const seekPosition = seekPositionFromTimelineX({
      x,
      start: ctx.start(),
      zoom: ctx.zoom(),
      useBeatgrid: ctx.useBeatgrid(),
      snapEnabled: ctx.snapEnabled(),
      bpm: ctx.bpm(),
      markers: ctx.beatgrid()?.markers,
    });
    ctx.playback.seek(seekPosition);
  };

  onMount(() => {
    log.trace("mounting");
    // Initialize WaveSurfer with proper settings for timeline integration
    setWaveSurferObj(
      WaveSurfer.create({
        container: waveformRef,
        waveColor: "rgba(100, 100, 100, 0.3)",
        progressColor: "rgba(100, 100, 100, 0.5)",
        cursorColor: "transparent", // Hide default cursor since we use Playhead
        cursorWidth: 0,
        height: 60,
        normalize: true,
        interact: false, // Disable interaction since we're handling it separately
        minPxPerSec: props.zoom,
        fillParent: false,
        backend: "WebAudio",
      }),
    );
  });

  // Effect to handle audio file changing
  createEffect(() => {
    if (waveSurferObj() === undefined || !props.audioUrl) return;
    const waveSurfer = waveSurferObj()!;
    setDecodedDurationMs(0);
    setLoadState("loading");

    waveSurfer.once("decode", (duration: number) => {
      // Update initial width after audio is loaded to match the audio duration
      waveSurfer.zoom(props.zoom);
      const durationMs = duration * 1000;
      setDecodedDurationMs(durationMs);
      setLoadState("decoded");
      const newWidthPx = msToPixels(durationMs, props.zoom);
      waveformRef.style.width = `${newWidthPx}px`;
      waveSurfer.setOptions({ width: newWidthPx });

      if (props.onAudioLoaded) {
        props.onAudioLoaded(durationMs);
      }
    });
    void waveSurfer.load(props.audioUrl).catch((error: unknown) => {
      setLoadState("error");
      log.error("Error loading timeline waveform:", error);
    });
  });

  // Effect to handle zoom changes after our <Wavesurfer> component is mounted
  createRenderEffect(() => {
    try {
      if (waveSurferObj() === undefined) return;
      const waveSurfer = waveSurferObj()!;

      const durationMs = decodedDurationMs();
      if (durationMs === 0) return;

      waveSurfer.zoom(props.zoom);
      const newWidthPx = msToPixels(durationMs, props.zoom);
      waveformRef.style.width = `${newWidthPx}px`;
      waveSurfer.setOptions({ width: newWidthPx });
    } catch (e) {
      log.error("Error updating waveform zoom:", e);
    }
  });

  onCleanup(() => {
    log.trace("unmounting");
    waveSurferObj()?.destroy();
  });

  return (
    <div class="relative w-full">
      <div
        ref={waveformRef}
        class="waveform-container cursor-pointer"
        data-waveform-state={loadState()}
        on:mousedown={(e) => handleSeekPointer(e.clientX)}
      />
    </div>
  );
};
