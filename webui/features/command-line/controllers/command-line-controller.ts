// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { CommandClient } from "../../../lib/command-client";
import { CommandSequenceRunner } from "../../../lib/command-sequence";
import { engineRuntime } from "../../../lib/engine-runtime";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { getLogger } from "../../../lib/logger";
import {
  newShowfile,
  promptForNewShowfileName,
  showfileSaveCommandForInput,
} from "../../../lib/showfile-actions";
import { pushToast } from "../../../state/appStores";
import type * as types from "../../../types";
import {
  isEditableKeyboardTarget,
  isHistorySearchShortcut,
  isNewShowPromptCommand,
} from "../model/keyboard";
import { commandLineHistory, setCommandHistory } from "../state/history";
import { createCommandAnalysisController } from "./command-analysis-controller";
import { createCommandHistoryController } from "./command-history-controller";

const log = getLogger(import.meta.url);
const commandSequenceRunner = new CommandSequenceRunner(
  new CommandClient(engineRuntime),
);

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
      const showfileName = await promptForNewShowfileName();
      if (!showfileName) {
        queueMicrotask(() => inputElement?.focus());
        return;
      }
      newShowfile(showfileName);
    } else {
      const showfileSaveCommand = showfileSaveCommandForInput(trimmedInput);
      if (showfileSaveCommand) {
        engineRuntime.sendCommand(
          { module: "DeskCommand", command: showfileSaveCommand },
          true,
          trimmedInput,
        );
      } else {
        try {
          await commandSequenceRunner.run(trimmedInput);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Command submission failed";
          log.error("Command sequence transport failed", error);
          pushToast("error", message);
          queueMicrotask(() => inputElement?.focus());
          return;
        }
      }
    }

    const currentHistory = commandLineHistory.get();
    if (currentHistory[currentHistory.length - 1] !== trimmedInput) {
      setCommandHistory([...currentHistory, trimmedInput].slice(-100));
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
    analysis,
    history,
  };
}

export type CommandLineController = ReturnType<
  typeof createCommandLineController
>;
