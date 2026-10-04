// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, onCleanup } from "solid-js";
import {
  Dialog,
  DialogBody,
  DialogCancelButton,
  DialogFooter,
  type DialogKind,
} from "../components/ui/dialog";
import { Input } from "../components/ui/form-controls";
import { Button } from "../components/ui/visual-language/button";
import "./widget-demos.css";

/** Launches one shared `Dialog` of each kind so their inherited close affordances can be compared. */
export function DialogsDemo() {
  const [open, setOpen] = createSignal<DialogKind | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [name, setName] = createSignal("Front wash");
  const [draft, setDraft] = createSignal("");
  const [notice, setNotice] = createSignal(
    "Sample dialogs only change this panel.",
  );
  let trigger: HTMLButtonElement | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(saveTimer));

  /** Opens one example and remembers its launcher for focus restoration. */
  const launch = (kind: DialogKind, event: MouseEvent) => {
    trigger = event.currentTarget as HTMLButtonElement;
    setDraft(name());
    setOpen(kind);
  };
  /** Closes the open example, reports how it ended, and refocuses its launcher. */
  const close = (outcome: string) => {
    setOpen(null);
    setNotice(outcome);
    trigger?.focus();
  };
  /** Simulates a save that cannot be interrupted, locking dismissal until it finishes. */
  const save = () => {
    if (busy()) return;
    setBusy(true);
    saveTimer = setTimeout(() => {
      setBusy(false);
      setName(draft().trim() || name());
      close(`Saved sample: ${draft().trim() || name()}`);
    }, 1200);
  };

  return (
    <section class="properties lab-panel" aria-label="Dialog examples">
      <div class="eyebrow">DIALOGS</div>
      <h2>One way out.</h2>
      <div class="property-section">
        <div class="section-label">Close pattern</div>
        <div class="button-samples">
          <Button onClick={(event) => launch("task", event)}>
            Task dialog
          </Button>
          <Button onClick={(event) => launch("info", event)}>
            Info dialog
          </Button>
          <Button onClick={(event) => launch("required", event)}>
            Required choice
          </Button>
        </div>
        <ul class="field-help dialog-rules">
          <li>
            <strong>Task</strong>: the shared close button and a footer Cancel
            both discard; the primary action sits last. Clicking outside does
            nothing, so drafts survive a stray click.
          </li>
          <li>
            <strong>Info</strong>: the shared close button only, no footer.
            Escape or clicking outside also closes.
          </li>
          <li>
            <strong>Required</strong>: no close button and Escape is ignored;
            the footer holds the choices.
          </li>
          <li>
            While work cannot be cancelled, every way out is disabled together.
          </li>
        </ul>
      </div>
      <p class="field-help" role="status">
        {notice()}
      </p>

      <Dialog
        kind="task"
        isOpen={open() === "task"}
        title="Rename sample group"
        busy={busy()}
        onDismiss={() => close("Rename cancelled")}
        onSubmit={save}
      >
        <DialogBody class="space-y-4">
          <label class="flex flex-col gap-1">
            <span class="text-sm text-neutral-300">Label</span>
            <Input
              value={draft()}
              onInput={(event) => setDraft(event.currentTarget.value)}
            />
          </label>
        </DialogBody>
        <DialogFooter>
          <DialogCancelButton />
          <Button
            type="button"
            variant="primary"
            disabled={busy()}
            onClick={save}
          >
            {busy() ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog
        kind="info"
        isOpen={open() === "info"}
        title="About this sample"
        onDismiss={() => close("Info closed")}
      >
        <DialogBody>
          <p class="m-0 text-sm text-neutral-300">
            “{name()}” is local sample data. Nothing here needs saving, so the
            dialog has no footer.
          </p>
        </DialogBody>
      </Dialog>

      <Dialog
        kind="required"
        isOpen={open() === "required"}
        title="Resume your work?"
        onSubmit={() => close("Loaded draft")}
      >
        <DialogBody>
          <p class="m-0 text-sm text-neutral-300">
            An unsaved draft of “{name()}” was found. Choose which version to
            open.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={() => close("Kept saved version")}>
            Keep saved
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => close("Loaded draft")}
          >
            Load draft
          </Button>
        </DialogFooter>
      </Dialog>
    </section>
  );
}
