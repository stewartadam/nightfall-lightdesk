// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { EmptyState } from "../../components/ui/empty-state";
import { Input, NativeSelect } from "../../components/ui/form-controls";
import { commandSucceeded } from "../../lib/command-result";
import { commandClient } from "../../lib/engine-commands";
import { durationToMs, msToDuration } from "../../lib/utils";
import { timecodes } from "../../state/appStores";
import * as types from "../../types";
import { TimecodeAudioInputFields } from "./audio-input-fields";
import { timecodeRateLabel, timecodeSourceName } from "./status";

type TimecodePropertiesProps = {
  /** UID of the timecode to edit, as keyed in the timecode store. */
  timecodeUid: string | undefined;
};

/**
 * Properties for one timecode: where it gets its time (source, rate, audio
 * input) and how long it rides out a lost external signal.
 *
 * Edits apply to every timeline linked to the timecode. Edits the engine
 * hasn't reported back yet stay shown and are merged into later edits, since
 * periodic timecode broadcasts sent before the engine applied an edit still
 * carry the old values.
 */
export default function TimecodeProperties(props: TimecodePropertiesProps) {
  const $timecodes = useStore(timecodes);
  const [pendingEdit, setPendingEdit] = createSignal<
    { uid: string; patch: Partial<types.Timecode> } | undefined
  >();

  /**
   * The timecode as the engine last reported it. Compared by content so the
   * live state broadcast every frame doesn't re-render unchanged settings.
   */
  const reported = createMemo(
    () =>
      props.timecodeUid ? $timecodes()[props.timecodeUid]?.[0] : undefined,
    undefined,
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );

  /** The timecode with edits the engine hasn't reported yet applied. */
  const shown = createMemo(() => {
    const timecode = reported();
    const pending = pendingEdit();
    return timecode && pending?.uid === timecode.identifiers.uid
      ? { ...timecode, ...pending.patch }
      : timecode;
  });

  /**
   * Drops pending edits once the engine reports all of them. The timecode
   * store is only written by the engine, so a match confirms the edits.
   */
  createEffect(() => {
    const pending = pendingEdit();
    if (!pending) return;
    const timecode = $timecodes()[pending.uid]?.[0];
    const settled =
      !timecode ||
      Object.entries(pending.patch).every(
        ([key, value]) =>
          JSON.stringify(timecode[key as keyof types.Timecode]) ===
          JSON.stringify(value),
      );
    if (settled) setPendingEdit(undefined);
  });

  /**
   * Stores `patch` merged with any pending edits onto the reported timecode,
   * and stops showing the edit if the engine rejects it.
   */
  const update = (patch: Partial<types.Timecode>) => {
    const timecode = reported();
    if (!timecode) return;
    const uid = timecode.identifiers.uid;
    const pending = pendingEdit();
    const edit = {
      uid,
      patch: { ...(pending?.uid === uid ? pending.patch : {}), ...patch },
    };
    setPendingEdit(edit);
    const command: types.TimecodeCommand = {
      type: "StoreTimecode",
      data: { ...timecode, ...edit.patch },
    };
    /** Stops showing the edit when the engine rejects it, unless a newer edit replaced it. */
    const dropRejectedEdit = () => {
      if (pendingEdit() === edit) setPendingEdit(undefined);
    };
    commandClient
      .invoke("TimecodeCommand", command)
      .then((result) => {
        if (!commandSucceeded(result)) dropRejectedEdit();
      })
      .catch(dropRejectedEdit);
  };

  /** The freewheel field's text: the saved time in milliseconds, or empty for the default. */
  const freewheelText = () => {
    const freewheel = shown()?.freewheel;
    return freewheel ? String(durationToMs(freewheel)) : "";
  };

  /**
   * Stores a freewheel time typed in milliseconds; a cleared field restores
   * the default. Unparseable or negative input puts the saved value back
   * instead of being sent.
   */
  const updateFreewheel = (input: HTMLInputElement) => {
    if (input.validity.badInput) {
      input.value = freewheelText();
      return;
    }
    if (input.value.trim() === "") {
      update({ freewheel: undefined });
      return;
    }
    const ms = Number.parseFloat(input.value);
    if (!Number.isFinite(ms) || ms < 0) {
      input.value = freewheelText();
      return;
    }
    update({ freewheel: msToDuration(ms) });
  };

  return (
    <Show
      when={shown()}
      fallback={
        <EmptyState
          variant="inline"
          class="p-4"
          title="Select a timecode to edit its source."
        />
      }
    >
      {(timecode) => (
        <div class="space-y-3 p-4 text-sm">
          <div>
            <div class="font-semibold text-neutral-100">
              Timecode {timecode().identifiers.id}
            </div>
            <div class="text-xs text-neutral-400">
              {timecode().identifiers.label || "Untitled"}
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <label class="block space-y-1">
              <span class="text-xs text-neutral-400">Source</span>
              <NativeSelect
                density="compact"
                aria-label="Timecode source"
                value={timecode().source}
                onChange={(event) =>
                  update({
                    source: event.currentTarget.value as types.TimecodeSource,
                  })
                }
              >
                <For each={Object.values(types.TimecodeSource)}>
                  {(source) => (
                    <option value={source}>{timecodeSourceName(source)}</option>
                  )}
                </For>
              </NativeSelect>
            </label>
            <label class="block space-y-1">
              <span class="text-xs text-neutral-400">Rate</span>
              <NativeSelect
                density="compact"
                aria-label="Timecode rate"
                value={timecode().rate}
                onChange={(event) =>
                  update({
                    rate: event.currentTarget.value as types.TimecodeRate,
                  })
                }
              >
                <For each={Object.values(types.TimecodeRate)}>
                  {(rate) => (
                    <option value={rate}>{timecodeRateLabel(rate)}</option>
                  )}
                </For>
              </NativeSelect>
            </label>
          </div>
          <Show when={timecode().source === types.TimecodeSource.SmpteLtc}>
            <TimecodeAudioInputFields
              input={timecode().audio_input}
              onChange={(audio_input) => update({ audio_input })}
            />
          </Show>
          <Show when={timecode().source !== types.TimecodeSource.Internal}>
            <label class="block space-y-1">
              <span class="text-xs text-neutral-400">Freewheel (ms)</span>
              <Input
                density="compact"
                aria-label="Timecode freewheel (ms)"
                type="number"
                min="0"
                step="50"
                placeholder="Default"
                value={freewheelText()}
                onChange={(event) => updateFreewheel(event.currentTarget)}
              />
              <span class="block text-xs text-neutral-500">
                How long the timecode keeps running after the signal stops,
                before it returns to the last frame received and holds.
              </span>
            </label>
          </Show>
        </div>
      )}
    </Show>
  );
}
