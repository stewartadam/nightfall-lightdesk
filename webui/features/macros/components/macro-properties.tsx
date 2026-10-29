// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { debounce } from "@solid-primitives/scheduled";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { EmptyState } from "../../../components/ui/empty-state";
import { Input, Textarea } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { macroRuns, macros } from "../../../state/appStores";
import type { Macro } from "../../../types";
import {
  applyMacroTextPatch,
  buildStartMacroCommand,
  buildStopMacroCommand,
  buildStoreMacroCommand,
  type MacroTextField,
  type MacroTextPatch,
  macroRunLabel,
  macroRunStatus,
  readMacroTextField,
} from "../model/macro-model";
import {
  findMacroBodyProblems,
  sendMacroCommand,
} from "../services/macro-commands";

/** How long typing must pause before a body is checked against the command grammar. */
const BODY_CHECK_DELAY_MS = 150;

interface MacroPropertiesProps {
  /** UID of the macro to edit, as keyed in the macro store. */
  macroUid: string | null;
}

interface MacroTextDraft {
  /** Current text in the field. */
  value: () => string;
  /** Replaces the field's text while the operator types. */
  setValue: (value: string) => void;
  /** Stores the field's text on the macro when it changed. */
  commit: () => void;
  /** Puts back the stored text without sending anything. */
  reset: () => void;
  /** Binds the field element, so engine updates don't overwrite text being typed. */
  ref: (element: HTMLInputElement | HTMLTextAreaElement) => void;
}

/** Edits sent for one macro that the engine hasn't reported back yet. */
interface PendingMacroEdits {
  /** UID of the edited macro. */
  uid: string;
  /** Field values sent and not yet confirmed. */
  patch: MacroTextPatch;
}

/**
 * Stores field edits on one macro. Edits the engine hasn't reported back yet are merged into
 * later edits and count as the field's value, so storing two fields in quick succession never
 * puts back the first field's old text, and storing the same text twice sends it once.
 */
function createMacroEdits(macro: () => Macro | undefined) {
  const [pending, setPending] = createSignal<PendingMacroEdits>();

  /** Edits still waiting on the engine for the macro shown now. */
  const pendingPatch = (current: Macro): MacroTextPatch => {
    const edits = pending();
    return edits?.uid === current.identifiers.uid ? edits.patch : {};
  };

  /** Drops edits once the engine reports them, and every edit when another macro shows. */
  createEffect(() => {
    const edits = pending();
    if (!edits) return;
    const current = macro();
    if (current?.identifiers.uid !== edits.uid) {
      setPending(undefined);
      return;
    }
    const waiting = Object.fromEntries(
      Object.entries(edits.patch).filter(
        ([field, value]) =>
          readMacroTextField(current, field as MacroTextField) !== value,
      ),
    ) as MacroTextPatch;
    if (Object.keys(waiting).length === Object.keys(edits.patch).length) return;
    setPending(
      Object.keys(waiting).length > 0
        ? { uid: edits.uid, patch: waiting }
        : undefined,
    );
  });

  return {
    /** Returns a field's value, counting edits the engine hasn't reported back yet. */
    valueOf: (current: Macro, field: MacroTextField): string =>
      pendingPatch(current)[field] ?? readMacroTextField(current, field),
    /** Stores `value` in `field`, together with every edit still waiting on the engine. */
    store(field: MacroTextField, value: string) {
      const current = macro();
      if (!current || value === this.valueOf(current, field)) return;
      const patch = { ...pendingPatch(current), [field]: value };
      setPending({ uid: current.identifiers.uid, patch });
      sendMacroCommand(
        buildStoreMacroCommand(applyMacroTextPatch(current, patch)),
      );
    },
  };
}

/**
 * Keeps an editable copy of one macro field. The copy follows the macro's value unless the
 * operator is typing in the field, and switching macros always replaces it.
 */
function createMacroTextDraft(
  macro: () => Macro | undefined,
  edits: ReturnType<typeof createMacroEdits>,
  field: MacroTextField,
): MacroTextDraft {
  let element: HTMLInputElement | HTMLTextAreaElement | undefined;
  let previousUid: string | undefined;
  const [value, setValue] = createSignal("");

  /** Follows the macro's value unless the operator is typing in this field. */
  createEffect(() => {
    const current = macro();
    if (!current) {
      previousUid = undefined;
      setValue("");
      return;
    }
    const shown = edits.valueOf(current, field);
    const switched = previousUid !== current.identifiers.uid;
    previousUid = current.identifiers.uid;
    if (document.activeElement === element && !switched) return;
    setValue(shown);
  });

  return {
    value,
    setValue,
    /** Stores the typed text on the macro. */
    commit: () => edits.store(field, value()),
    /** Puts back the macro's value. */
    reset: () => {
      const current = macro();
      setValue(current ? edits.valueOf(current, field) : "");
    },
    /** Remembers the field element so focus can be checked. */
    ref: (next) => {
      element = next;
    },
  };
}

interface CommandBodyFieldProps {
  /** Field label shown above the editor. */
  label: string;
  /** One sentence on when this body runs. */
  hint: string;
  /** Accessible name of the editor. */
  ariaLabel: string;
  /** Editable copy of the body. */
  draft: MacroTextDraft;
}

/**
 * Edits one macro body, one command per line, and lists the lines the command grammar
 * rejects as the operator types. The body is stored when the field loses focus or on
 * Ctrl+Enter, and Escape puts back the stored text.
 */
function CommandBodyField(props: CommandBodyFieldProps) {
  const [checkedBody, setCheckedBody] = createSignal(props.draft.value());
  const scheduleCheck = debounce(setCheckedBody, BODY_CHECK_DELAY_MS);
  onCleanup(() => scheduleCheck.clear());
  /** Re-checks the body once typing pauses, so the grammar isn't run on every keystroke. */
  createEffect(() => scheduleCheck(props.draft.value()));
  const [problems] = createResource(checkedBody, findMacroBodyProblems, {
    initialValue: [],
  });
  return (
    <div class="space-y-1">
      <label class="block text-xs font-medium text-neutral-300">
        {props.label}
        <Textarea
          density="compact"
          ref={props.draft.ref}
          aria-label={props.ariaLabel}
          aria-invalid={problems.latest.length > 0}
          class="mt-1 min-h-24 w-full font-mono text-xs"
          spellcheck={false}
          autocapitalize="off"
          autocomplete="off"
          value={props.draft.value()}
          onInput={(event) => props.draft.setValue(event.currentTarget.value)}
          onBlur={props.draft.commit}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              props.draft.commit();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              props.draft.reset();
              event.currentTarget.blur();
            }
          }}
        />
      </label>
      <p class="text-xs text-neutral-500">{props.hint}</p>
      <Show when={problems.latest.length > 0}>
        <ul
          class="space-y-0.5 text-xs text-amber-300"
          data-macro-body-problems={props.ariaLabel}
        >
          <For each={problems.latest}>
            {(problem) => (
              <li>
                Line {problem.line} ({problem.statement}): {problem.message}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/**
 * Properties for one macro: its label, the commands it runs when started and when a held
 * button is let go, and a button to run or stop it for testing.
 */
export default function MacroProperties(props: MacroPropertiesProps) {
  const $macros = useShallowStore(macros);
  const $macroRuns = useShallowStore(macroRuns);

  /** The macro as the engine last reported it. */
  const macro = createMemo(() =>
    props.macroUid ? $macros()[props.macroUid] : undefined,
  );
  /** Live run of this macro, if one of its bodies is running. */
  const run = createMemo(() => {
    const current = macro();
    return current ? macroRunStatus($macroRuns(), current) : undefined;
  });

  const edits = createMacroEdits(macro);
  const label = createMacroTextDraft(macro, edits, "label");
  const commands = createMacroTextDraft(macro, edits, "commands");
  const releaseCommands = createMacroTextDraft(
    macro,
    edits,
    "release_commands",
  );

  /** Stores any typed text, then runs the macro, or stops it while it runs. */
  const toggleRun = () => {
    const current = macro();
    if (!current) return;
    if (run()) {
      sendMacroCommand(buildStopMacroCommand(current.identifiers.id));
      return;
    }
    commands.commit();
    releaseCommands.commit();
    sendMacroCommand(buildStartMacroCommand(current.identifiers.id));
  };

  return (
    <Show
      when={macro()}
      fallback={
        <EmptyState
          variant="inline"
          class="p-4"
          title="Select one macro to edit its commands."
        />
      }
    >
      {(current) => (
        <div class="space-y-4 p-4" data-macro-properties="">
          <div class="flex items-start justify-between gap-2 border-b border-neutral-700 pb-3">
            <div class="min-w-0">
              <h3 class="font-medium text-neutral-100">
                Macro {current().identifiers.id}
              </h3>
              <p
                class="truncate text-xs"
                classList={{
                  "text-emerald-300": run() !== undefined,
                  "text-neutral-400": run() === undefined,
                }}
                data-macro-properties-state=""
              >
                {(() => {
                  const live = run();
                  return live ? macroRunLabel(live) : "Idle";
                })()}
              </p>
            </div>
            <Button
              variant={run() ? "danger" : "primary"}
              size="compact"
              onClick={toggleRun}
            >
              <Show
                when={run()}
                fallback={<PlayIcon class="size-3.5" aria-hidden />}
              >
                <StopIcon class="size-3.5" aria-hidden />
              </Show>
              {run() ? "Stop" : "Run"}
            </Button>
          </div>

          <label class="block text-xs font-medium text-neutral-300">
            Label
            <Input
              density="compact"
              ref={label.ref}
              type="text"
              aria-label="Macro label"
              class="mt-1"
              value={label.value()}
              onInput={(event) => label.setValue(event.currentTarget.value)}
              onBlur={label.commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  label.commit();
                  event.currentTarget.blur();
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  label.reset();
                  event.currentTarget.blur();
                }
              }}
            />
          </label>

          <CommandBodyField
            label="Commands"
            hint="Runs line by line when the macro starts, and stops at the first line that fails."
            ariaLabel="Macro commands"
            draft={commands}
          />
          <CommandBodyField
            label="On release"
            hint="Runs when a held button that started the macro is let go. Leave empty to ignore the release."
            ariaLabel="Macro release commands"
            draft={releaseCommands}
          />
        </div>
      )}
    </Show>
  );
}
