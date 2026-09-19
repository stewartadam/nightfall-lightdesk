// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { FilePlusIcon } from "@squidlab/phosphor-solid/file-plus";
import {
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
} from "solid-js";
import {
  DialogBackdrop,
  DialogBody,
  DialogCloseButton,
  DialogFooter,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Checkbox, Input } from "../../../components/ui/form-controls";
import Modal from "../../../components/ui/modal";
import { Button } from "../../../components/ui/visual-language/button";
import {
  cancelNewShowfileNamePrompt,
  newShowfileNamePrompt,
  submitNewShowfileNamePrompt,
} from "../../../lib/new-showfile-name-prompt";

/** Collects a new show name and optional sample data before creation. */
export default function NewShowfileNameModal() {
  const prompt = useStore(newShowfileNamePrompt);
  const titleId = createUniqueId();
  const [name, setName] = createSignal("");
  const [includeSampleData, setIncludeSampleData] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;
  let enterAnimationFrame: number | null = null;

  /** Resets and focuses the name field when a new prompt opens. */
  createEffect(() => {
    if (!prompt()) {
      setName("");
      setIncludeSampleData(false);
      if (enterAnimationFrame !== null) {
        cancelAnimationFrame(enterAnimationFrame);
        enterAnimationFrame = null;
      }
      return;
    }

    setName("");
    setIncludeSampleData(false);
    enterAnimationFrame = requestAnimationFrame(() => {
      inputRef?.focus();
      enterAnimationFrame = null;
    });
  });

  onCleanup(() => {
    if (enterAnimationFrame !== null) {
      cancelAnimationFrame(enterAnimationFrame);
    }
  });

  /** Cancels the active prompt request. */
  const cancelPrompt = () => {
    const request = prompt();
    if (!request) return;
    cancelNewShowfileNamePrompt(request.requestId);
  };

  /** Submits the new show name and initial content selection. */
  const submitPrompt = () => {
    const request = prompt();
    if (!request) return;
    submitNewShowfileNamePrompt(request.requestId, name(), includeSampleData());
  };

  return (
    <Modal isOpen={prompt() !== null} onEscape={cancelPrompt}>
      <DialogBackdrop
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div
          class="w-full max-w-md"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <DialogSurface>
            <DialogHeader>
              <DialogTitle id={titleId}>
                <FilePlusIcon class="size-4" aria-hidden />
                <span>New Showfile</span>
              </DialogTitle>
              <DialogCloseButton
                type="button"
                aria-label="Close new showfile dialog"
                onClick={cancelPrompt}
              />
            </DialogHeader>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                submitPrompt();
              }}
            >
              <DialogBody class="space-y-2">
                <label
                  for={`${titleId}-name`}
                  class="block text-sm font-medium text-neutral-200"
                >
                  Show name
                </label>
                <Input
                  ref={inputRef}
                  id={`${titleId}-name`}
                  value={name()}
                  onInput={(event) => setName(event.currentTarget.value)}
                />
                <label
                  class="flex items-start gap-3 pt-3"
                  for={`${titleId}-samples`}
                >
                  <Checkbox
                    id={`${titleId}-samples`}
                    checked={includeSampleData()}
                    onChange={(event) =>
                      setIncludeSampleData(event.currentTarget.checked)
                    }
                    aria-describedby={`${titleId}-samples-description`}
                  />
                  <span>
                    <span class="block text-sm font-medium text-neutral-200">
                      Include sample data
                    </span>
                    <span
                      id={`${titleId}-samples-description`}
                      class="block text-xs text-neutral-400"
                    >
                      Start with example fixtures, groups, cues, effects, and
                      timelines.
                    </span>
                  </span>
                </label>
              </DialogBody>
              <DialogFooter>
                <Button type="button" onClick={cancelPrompt}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={name().trim().length === 0}
                >
                  Create Show
                </Button>
              </DialogFooter>
            </form>
          </DialogSurface>
        </div>
      </DialogBackdrop>
    </Modal>
  );
}
