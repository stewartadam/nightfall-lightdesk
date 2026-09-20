// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import {
  DialogBackdrop,
  DialogBody,
  DialogCloseButton,
  DialogFooter,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input, NativeSelect } from "../../../components/ui/form-controls";
import Modal from "../../../components/ui/modal";
import { Button } from "../../../components/ui/visual-language/button";
import { clips } from "../../../state/appStores";
import type { ParameterType } from "../../../types";

/** Collects a lane name and a valid target before creating an empty curve. */
export function AddParameterLaneDialog(props: {
  onCancel: () => void;
  onSubmit: (name: string, target: ParameterType) => void;
}) {
  const titleId = createUniqueId();
  const $clips = useStore(clips);
  const [kind, setKind] = createSignal<ParameterType["type"]>("GlobalVariable");
  const [name, setName] = createSignal("");
  const [variable, setVariable] = createSignal("");
  const [clipUid, setClipUid] = createSignal("");

  /** Keeps clip targets ordered by their operator-facing IDs. */
  const clipOptions = createMemo(() =>
    Object.values($clips())
      .map(([clip]) => clip)
      .sort((a, b) => a.identifiers.id - b.identifiers.id),
  );

  /** Rejects empty variable names and clip targets that no longer exist. */
  const target = createMemo<ParameterType | undefined>(() => {
    if (kind() === "GlobalVariable") {
      const value = variable().trim();
      return value ? { type: "GlobalVariable", data: value } : undefined;
    }
    const clip = clipOptions().find(
      (entry) => entry.identifiers.uid === clipUid(),
    );
    return clip
      ? { type: "RateMaster", data: clip.identifiers.uid }
      : undefined;
  });

  /** Uses the target label when the optional display name is blank. */
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const selected = target();
    if (!selected) return;
    const clip = clipOptions().find(
      (entry) => entry.identifiers.uid === selected.data,
    );
    const fallback =
      selected.type === "GlobalVariable"
        ? selected.data
        : `Clip ${clip?.identifiers.id}: ${clip?.identifiers.label} rate`;
    props.onSubmit(name().trim() || fallback, selected);
  };

  /** Focuses the target field once the dialog has mounted. */
  const focusTarget = (element: HTMLInputElement) => {
    queueMicrotask(() => element.focus());
  };

  return (
    <Modal isOpen onEscape={props.onCancel}>
      <DialogBackdrop role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div class="w-full max-w-lg">
          <DialogSurface>
            <DialogHeader>
              <DialogTitle id={titleId}>Add parameter lane</DialogTitle>
              <DialogCloseButton
                type="button"
                aria-label="Close"
                onClick={props.onCancel}
              />
            </DialogHeader>
            <form onSubmit={submit}>
              <DialogBody class="space-y-4">
                <label class="flex flex-col gap-1 text-sm">
                  <span>Parameter type</span>
                  <NativeSelect
                    value={kind()}
                    onChange={(event) =>
                      setKind(
                        event.currentTarget.value as ParameterType["type"],
                      )
                    }
                  >
                    <option value="GlobalVariable">Global variable</option>
                    <option value="RateMaster">Clip rate</option>
                  </NativeSelect>
                </label>
                <Show
                  when={kind() === "GlobalVariable"}
                  fallback={
                    <label class="flex flex-col gap-1 text-sm">
                      <span>Clip</span>
                      <NativeSelect
                        value={clipUid()}
                        onChange={(event) =>
                          setClipUid(event.currentTarget.value)
                        }
                      >
                        <option value="">Select a clip</option>
                        <For each={clipOptions()}>
                          {(clip) => (
                            <option value={clip.identifiers.uid}>
                              {clip.identifiers.id}: {clip.identifiers.label}
                            </option>
                          )}
                        </For>
                      </NativeSelect>
                      <Show when={clipOptions().length === 0}>
                        <span class="text-xs text-neutral-400">
                          Create a clip to add a clip rate lane.
                        </span>
                      </Show>
                    </label>
                  }
                >
                  <label class="flex flex-col gap-1 text-sm">
                    <span>Variable name</span>
                    <Input
                      ref={focusTarget}
                      value={variable()}
                      onInput={(event) =>
                        setVariable(event.currentTarget.value)
                      }
                    />
                  </label>
                </Show>
                <label class="flex flex-col gap-1 text-sm">
                  <span>Lane name (optional)</span>
                  <Input
                    value={name()}
                    placeholder="Use target name"
                    onInput={(event) => setName(event.currentTarget.value)}
                  />
                </label>
              </DialogBody>
              <DialogFooter>
                <Button type="button" onClick={props.onCancel}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={!target()}>
                  Add lane
                </Button>
              </DialogFooter>
            </form>
          </DialogSurface>
        </div>
      </DialogBackdrop>
    </Modal>
  );
}
