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
  Show,
} from "solid-js";
import {
  Dialog,
  DialogBody,
  DialogCancelButton,
  DialogFooter,
} from "../../../components/ui/dialog";
import { Checkbox, Input } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import { getBackendUrl } from "../../../lib/api";
import {
  cancelNewShowfileNamePrompt,
  newShowfileNamePrompt,
  submitNewShowfileNamePrompt,
} from "../../../lib/new-showfile-name-prompt";

/** Collects a new show name and optional sample data before creation. */
export default function NewShowfileNameModal() {
  const prompt = useStore(newShowfileNamePrompt);
  const fieldId = createUniqueId();
  const [name, setName] = createSignal("");
  const [includeSampleData, setIncludeSampleData] = createSignal(false);
  const [error, setError] = createSignal("");
  const [checking, setChecking] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;
  let enterAnimationFrame: number | null = null;

  /** Resets and focuses the name field when a new prompt opens. */
  createEffect(() => {
    setError("");
    setChecking(false);
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

  /** Checks availability while keeping conflicts visible in the active dialog. */
  const submitPrompt = async () => {
    const request = prompt();
    const proposedName = name().trim();
    if (!request || checking() || !proposedName) return;
    setChecking(true);
    setError("");
    try {
      const response = await fetch(
        `${getBackendUrl()}/api/showfiles/validate-new-name?name=${encodeURIComponent(proposedName)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(await response.text());
      if (
        prompt()?.requestId === request.requestId &&
        name().trim() === proposedName
      ) {
        submitNewShowfileNamePrompt(
          request.requestId,
          proposedName,
          includeSampleData(),
        );
      }
    } catch (cause) {
      if (
        prompt()?.requestId === request.requestId &&
        name().trim() === proposedName
      ) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not check show name. Try again.",
        );
      }
    } finally {
      if (prompt()?.requestId === request.requestId) setChecking(false);
    }
  };

  return (
    <Dialog
      kind="task"
      isOpen={prompt() !== null}
      title={
        <>
          <FilePlusIcon class="size-4" aria-hidden />
          <span>New Showfile</span>
        </>
      }
      onDismiss={cancelPrompt}
      closeLabel="Close new showfile dialog"
      class="max-w-md"
      backdropProps={{ tabIndex: -1 }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitPrompt();
        }}
      >
        <DialogBody class="space-y-2">
          <label
            for={`${fieldId}-name`}
            class="block text-sm font-medium text-neutral-200"
          >
            Show name
          </label>
          <Input
            ref={inputRef}
            id={`${fieldId}-name`}
            value={name()}
            aria-invalid={Boolean(error())}
            aria-describedby={error() ? `${fieldId}-error` : undefined}
            onInput={(event) => {
              setName(event.currentTarget.value);
              setError("");
            }}
          />
          <Show when={error()}>
            <p
              id={`${fieldId}-error`}
              role="alert"
              class="text-sm text-red-400"
            >
              {error()}
            </p>
          </Show>
          <label class="flex items-start gap-3 pt-3" for={`${fieldId}-samples`}>
            <Checkbox
              id={`${fieldId}-samples`}
              checked={includeSampleData()}
              onChange={(event) =>
                setIncludeSampleData(event.currentTarget.checked)
              }
              aria-describedby={`${fieldId}-samples-description`}
            />
            <span>
              <span class="block text-sm font-medium text-neutral-200">
                Include sample data
              </span>
              <span
                id={`${fieldId}-samples-description`}
                class="block text-xs text-neutral-400"
              >
                Start with example fixtures, groups, cues, effects, and
                timelines.
              </span>
            </span>
          </label>
        </DialogBody>
        <DialogFooter>
          <DialogCancelButton />
          <Button
            variant="primary"
            type="submit"
            disabled={name().trim().length === 0 || checking()}
          >
            Create Show
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
