// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createSignal,
  createUniqueId,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import {
  DialogBackdrop,
  DialogBody,
  DialogCloseButton,
  DialogFooter,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/form-controls";
import Modal from "../components/ui/modal";
import { Button } from "../components/ui/visual-language/button";
import "./widget-demos.css";

/**
 * Dismissal contract for a dialog.
 * - `task`: commits work. Header close, footer Cancel plus actions; outside clicks are ignored so drafts survive.
 * - `info`: nothing to commit. Header close only, no footer; Escape and outside clicks dismiss.
 * - `required`: the user must pick an action. No header close, Escape or outside dismissal.
 */
export type DialogKind = "task" | "info" | "required";

interface StandardDialogProps {
  kind: DialogKind;
  isOpen: boolean;
  title: string;
  /** Single dismissal handler shared by the header close, Cancel, Escape and outside clicks. */
  onDismiss?: () => void;
  /** Locks every dismissal path while work that cannot be cancelled is running. */
  busy?: boolean;
  /** Renames Cancel when nothing remains to undo, such as after a completed export. */
  cancelLabel?: string;
  /** Footer actions placed after Cancel; the only footer content for required dialogs. */
  actions?: JSX.Element;
  /** Width constraint applied to the surface. */
  class?: string;
  children: JSX.Element;
}

/**
 * Lab dialog shell that derives every close affordance from `kind`, demonstrating
 * the rules in `components/ui/dialog/README.md` that app dialogs follow.
 */
export function StandardDialog(props: StandardDialogProps) {
  const titleId = createUniqueId();
  /** Dismisses through the caller's handler unless the dialog is required or busy. */
  const dismiss = () => {
    if (props.kind === "required" || props.busy) return;
    props.onDismiss?.();
  };
  return (
    <Modal
      isOpen={props.isOpen}
      onEscape={dismiss}
      closeOnEscape={props.kind !== "required" && !props.busy}
    >
      <DialogBackdrop
        role={props.kind === "required" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={props.busy}
        data-dialog-kind={props.kind}
        onMouseDown={(event) => {
          if (props.kind === "info" && event.target === event.currentTarget) {
            dismiss();
          }
        }}
      >
        <DialogSurface class={props.class ?? "max-w-lg"}>
          <DialogHeader>
            <DialogTitle id={titleId}>{props.title}</DialogTitle>
            <Show when={props.kind !== "required"}>
              <DialogCloseButton
                type="button"
                disabled={props.busy}
                onClick={dismiss}
              />
            </Show>
          </DialogHeader>
          <DialogBody class="space-y-4">{props.children}</DialogBody>
          <Show when={props.kind !== "info"}>
            <DialogFooter>
              <Show when={props.kind === "task"}>
                <Button type="button" disabled={props.busy} onClick={dismiss}>
                  {props.cancelLabel ?? "Cancel"}
                </Button>
              </Show>
              {props.actions}
            </DialogFooter>
          </Show>
        </DialogSurface>
      </DialogBackdrop>
    </Modal>
  );
}

/** Launches one example of each dialog kind so their close affordances can be compared. */
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

      <StandardDialog
        kind="task"
        isOpen={open() === "task"}
        title="Rename sample group"
        busy={busy()}
        onDismiss={() => close("Rename cancelled")}
        actions={
          <Button
            type="button"
            variant="primary"
            disabled={busy()}
            onClick={save}
          >
            {busy() ? "Saving…" : "Save"}
          </Button>
        }
      >
        <label class="flex flex-col gap-1">
          <span class="text-sm text-neutral-300">Label</span>
          <Input
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
        </label>
      </StandardDialog>

      <StandardDialog
        kind="info"
        isOpen={open() === "info"}
        title="About this sample"
        onDismiss={() => close("Info closed")}
      >
        <p class="text-sm text-neutral-300">
          “{name()}” is local sample data. Nothing here needs saving, so the
          dialog has no footer.
        </p>
      </StandardDialog>

      <StandardDialog
        kind="required"
        isOpen={open() === "required"}
        title="Resume your work?"
        actions={
          <>
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
          </>
        }
      >
        <p class="text-sm text-neutral-300">
          An unsaved draft of “{name()}” was found. Choose which version to
          open.
        </p>
      </StandardDialog>
    </section>
  );
}
