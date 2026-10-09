// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { CommandClient } from "../../../lib/command-client";
import {
  type CommandSequenceProgress,
  CommandSequenceRunner,
  splitCommandSequence,
} from "../../../lib/command-sequence";
import {
  EngineRuntimeCommandDisconnectedError,
  engineRuntime,
} from "../../../lib/engine-runtime";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { getLogger } from "../../../lib/logger";
import { openOrFocusPanelDefinition } from "../../../lib/panel-open-command";
import {
  newShowfile,
  promptForNewShowfile,
} from "../../../lib/showfile-actions";
import { dockApi, pushToast } from "../../../state/appStores";
import type * as types from "../../../types";
import {
  type PendingCommandSubmission,
  remainingStatementCount,
} from "../model/command-queue";
import {
  isEditableKeyboardTarget,
  isHistorySearchShortcut,
  isNewShowPromptCommand,
} from "../model/keyboard";
import commandLinePanelDefinition from "../panels/command-line.definition";
import { commandLineHistory, setCommandHistory } from "../state/history";
import { createCommandAnalysisController } from "./command-analysis-controller";
import { createCommandHistoryController } from "./command-history-controller";

const log = getLogger(import.meta.url);
const commandSequenceRunner = new CommandSequenceRunner(
  new CommandClient(engineRuntime),
);

/** Tail of the serial chain that keeps command-line submissions in submission order. */
let commandSubmissionTail: Promise<void> = Promise.resolve();
let nextSubmissionId = 0;
const [pendingSubmissions, setPendingSubmissions] = createSignal<
  readonly PendingCommandSubmission[]
>([]);

/** Applies an update to one pending submission, ignoring submissions that already settled. */
function updatePendingSubmission(
  id: number,
  update: (submission: PendingCommandSubmission) => PendingCommandSubmission,
) {
  setPendingSubmissions((pending) =>
    pending.map((submission) =>
      submission.id === id ? update(submission) : submission,
    ),
  );
}

/**
 * Runs one accepted submission after every earlier submission has settled,
 * without blocking the input. Failed command results are toasted by the engine
 * runtime, so only transport failures are reported here. A submission that
 * returns a promise settles with it; one that only sends settles once sent.
 * The submission is listed in `pendingSubmissions` until it settles, with
 * per-statement progress, so the input can show how many statements are still
 * running or waiting their turn.
 */
function queueCommandSubmission(
  input: string,
  statements: Promise<readonly string[]>,
  submit: (
    statements: readonly string[],
    progress: CommandSequenceProgress,
  ) => unknown,
) {
  const id = nextSubmissionId++;
  setPendingSubmissions((pending) => [
    ...pending,
    { id, command: input, started: 0, settled: 0 },
  ]);
  statements.then(
    (split) =>
      updatePendingSubmission(id, (submission) => ({
        ...submission,
        statements: split,
      })),
    // Split failures are reported when the queued submission awaits them.
    () => undefined,
  );
  const progress: CommandSequenceProgress = {
    onStatementStarted: (index) =>
      updatePendingSubmission(id, (submission) => ({
        ...submission,
        started: index + 1,
      })),
    onStatementSettled: (index) =>
      updatePendingSubmission(id, (submission) => ({
        ...submission,
        settled: index + 1,
      })),
  };
  commandSubmissionTail = commandSubmissionTail.then(async () => {
    try {
      await submit(await statements, progress);
    } catch (error) {
      // Loads and new shows replace the backend world, which ends the session
      // before a result can arrive; the command was delivered, so keep going.
      if (error instanceof EngineRuntimeCommandDisconnectedError) {
        log.info("Command session ended before its result", input);
        return;
      }
      const message =
        error instanceof Error ? error.message : "Command submission failed";
      log.error("Command submission transport failed", error);
      pushToast("error", message);
    } finally {
      setPendingSubmissions((pending) =>
        pending.filter((submission) => submission.id !== id),
      );
    }
  });
}

interface CommandLineControllerOptions {
  variant: "panel" | "nav";
  componentId: string;
}

/** Coordinates command submission, global shortcuts, history, and analysis. */
export function createCommandLineController(
  options: CommandLineControllerOptions,
) {
  log.trace("mounting");
  const [input, setInput] = createSignal("");
  let inputElement: HTMLInputElement | undefined;
  const getInputElement = () => inputElement;
  const analysis = createCommandAnalysisController({
    input,
    setInput,
    getInputElement,
  });
  const history = createCommandHistoryController({
    variant: options.variant,
    setInput,
    getInputElement,
    pendingCount: () => remainingStatementCount(pendingSubmissions()),
    onHistoryValue: (value) => {
      analysis.setAutocompleteArmed(false);
      analysis.clearValidation("idle");
      queueMicrotask(() => analysis.scheduleValidation(value));
    },
    onHistoryCleared: () => {
      analysis.setAutocompleteArmed(false);
      analysis.clearSuggestions();
      analysis.clearValidation();
      analysis.clearValidationTooltipAutoOpen();
    },
  });

  /** Captures the command input used for cursor and focus management. */
  const setInputElement = (element: HTMLInputElement) => {
    inputElement = element;
  };

  /** Sends the global programmer-clear command. */
  const clearProgrammer = () => {
    const command: types.ProgrammerCommand = { type: "ClearProgrammer" };
    engineRuntime.sendCommand({ module: "ProgrammerCommand", command });
  };

  /** Opens or focuses the Console panel, whose scrollback lists running and queued commands. */
  const openConsole = () => {
    openOrFocusPanelDefinition(dockApi.get(), commandLinePanelDefinition);
  };

  /** Restores command input and transient controller state after submission. */
  const resetSubmittedCommandInput = () => {
    history.setHistoryIndex(-1);
    setInput("");
    analysis.reset();
  };

  /** Validates, dispatches, and records a command-line form submission. */
  const handleSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    const trimmedInput = input().trim();
    if (!trimmedInput || !(await analysis.validateSubmission(trimmedInput)))
      return;

    if (isNewShowPromptCommand(trimmedInput)) {
      const options = await promptForNewShowfile();
      if (!options) {
        queueMicrotask(() => inputElement?.focus());
        return;
      }
      queueCommandSubmission(
        trimmedInput,
        Promise.resolve([trimmedInput]),
        (_statements, progress) => {
          progress.onStatementStarted?.(0);
          newShowfile(options);
        },
      );
    } else {
      queueCommandSubmission(
        trimmedInput,
        splitCommandSequence(trimmedInput),
        (statements, progress) =>
          commandSequenceRunner.runStatements(statements, progress),
      );
    }

    recordSubmittedCommand(trimmedInput);
  };

  /** Appends a submitted command to history and clears the input for the next one. */
  const recordSubmittedCommand = (submitted: string) => {
    const currentHistory = commandLineHistory.get();
    if (currentHistory[currentHistory.length - 1] !== submitted) {
      setCommandHistory([...currentHistory, submitted].slice(-100));
    }
    resetSubmittedCommandInput();
  };

  const groupName =
    options.componentId === "header-command-line"
      ? "Command Line"
      : "Command Line Panel";

  if (options.variant === "nav") {
    useKeyboardShortcut(
      {
        key: "$mod+l",
        /** Focuses the preferred command input, falling back to any command field. */
        handler: () => {
          const preferred =
            (document.getElementById(
              "header-cmdline",
            ) as HTMLInputElement | null) ??
            (document.getElementById("cmdline") as HTMLInputElement | null) ??
            (document.querySelector(
              "input[aria-label='Command input'], input[aria-label='Panel command input']",
            ) as HTMLInputElement | null);
          preferred?.focus();
          preferred?.select();
        },
        description: "Focus command line",
        componentId: undefined,
        group: groupName,
      },
      { global: true },
    );

    for (const key of ["Control+Backspace", "Control+Delete"]) {
      useKeyboardShortcut(
        {
          key,
          /** Clears the programmer unless the originating target is editable. */
          handler: (event) => {
            if (isEditableKeyboardTarget(event?.target ?? null)) return false;
            clearProgrammer();
          },
          description: "Clear programmer",
          componentId: undefined,
          group: groupName,
        },
        { capture: true, global: true },
      );
    }

    useKeyboardShortcut(
      {
        key: "Shift+Escape",
        /** Clears the programmer even while an editable element has focus. */
        handler: () => clearProgrammer(),
        description: "Clear programmer",
        componentId: undefined,
        group: groupName,
      },
      { allowInEditable: true, capture: true, global: true },
    );
  }

  /** Handles command input shortcuts in precedence order. */
  const handleKeyDown = (event: KeyboardEvent) => {
    if (options.variant === "panel" && isHistorySearchShortcut(event)) {
      history.openSearch();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !isEditableKeyboardTarget(event.target)
    ) {
      clearProgrammer();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      event.key === "Escape" &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      clearProgrammer();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (analysis.handleKeyDown(event)) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      history.navigate(event.key === "ArrowUp" ? "prev" : "next");
      event.preventDefault();
    }
  };

  /** Handles command input edits and resets history navigation. */
  const onInputChange = (element: HTMLInputElement) => {
    history.setHistoryIndex(-1);
    analysis.onInputChange(element);
  };

  /** Opens history search when its panel-level shortcut is pressed. */
  const handlePanelKeyDown = (event: KeyboardEvent) => {
    if (!isHistorySearchShortcut(event)) return;
    history.openSearch();
    event.preventDefault();
    event.stopPropagation();
  };

  /** Adds transient feedback after a rejected command submission. */
  const inputClasses = () =>
    analysis.submitShakeActive() ? "cmdline-submit-shake" : "";

  return {
    variant: options.variant,
    input,
    inputClasses,
    setInputElement,
    handleSubmit,
    handleKeyDown,
    handlePanelKeyDown,
    onInputChange,
    clearProgrammer,
    pendingSubmissions,
    openConsole,
    analysis,
    history,
  };
}

export type CommandLineController = ReturnType<
  typeof createCommandLineController
>;
