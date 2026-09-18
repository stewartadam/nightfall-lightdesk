// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { parseKeybinding } from "tinykeys";
import { Input, InputGroup } from "../../../components/ui/form-controls";
import { clearConsoleScrollback } from "../../../state/appStores";
import type { CommandLineController } from "../controllers/command-line-controller";
import { CommandClearButton } from "./command-clear-button";
import { CommandHistory } from "./command-history";
import { CommandSuggestions } from "./command-suggestions";
import { CommandValidationStatus } from "./command-validation-status";

const CURSOR_NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);
const COMMAND_MODIFIER_LABEL = parseKeybinding("$mod+l")[0][0].includes("Meta")
  ? "⌘"
  : "Ctrl";

interface CommandLineViewProps {
  controller: CommandLineController;
}

/** Renders panel and navigation command-line variants from controller props. */
export function CommandLineView(props: CommandLineViewProps) {
  const controller = props.controller;
  const analysis = controller.analysis;
  const history = controller.history;
  const input = (
    <div class="relative min-w-0 flex-1">
      <Input
        density="compact"
        ref={controller.setInputElement}
        class={controller.inputClasses()}
        style={{
          "padding-right": "32px",
          "font-family": "var(--font-mono)",
          "min-height": controller.variant === "nav" ? "32px" : undefined,
        }}
        id={controller.variant === "nav" ? "header-cmdline" : "cmdline"}
        aria-label={
          controller.variant === "panel"
            ? "Panel command input"
            : "Command input"
        }
        placeholder={
          controller.variant === "nav"
            ? `${COMMAND_MODIFIER_LABEL}+L to enter command`
            : "Enter command..."
        }
        value={controller.input()}
        onInput={(event) => controller.onInputChange(event.currentTarget)}
        onClick={(event) => analysis.onCursorChange(event.currentTarget)}
        onKeyUp={(event) => {
          if (CURSOR_NAV_KEYS.has(event.key))
            analysis.onCursorChange(event.currentTarget);
        }}
        onBlur={analysis.onInputBlur}
        onFocus={(event) => analysis.onCursorChange(event.currentTarget)}
        type="text"
        autocomplete="off"
        aria-invalid={
          analysis.validationState() === "invalid" ? "true" : "false"
        }
        data-validation-severity={
          analysis.validationState() === "invalid"
            ? analysis.validationSeverity()
            : undefined
        }
      />
      <CommandSuggestions
        variant={controller.variant}
        suggestions={() =>
          analysis.suggestionsOpen() ? analysis.visibleSuggestions() : []
        }
        selectedIndex={analysis.suggestionIndex}
        intentSublistLabel={() => analysis.intentSublist()?.label}
        breadcrumbLabel={analysis.currentBreadcrumbLabel}
        onOpenIntent={analysis.openIntentSublist}
        onApplyToken={analysis.applySuggestion}
        onHover={analysis.setSuggestionIndex}
      />
      <CommandValidationStatus
        variant={controller.variant}
        input={controller.input}
        state={analysis.validationState}
        severity={analysis.validationSeverity}
        error={analysis.validationError}
        forceTooltipOpen={analysis.validationTooltipForcedOpen}
      />
    </div>
  );

  if (controller.variant === "panel") {
    return (
      <div
        class="h-full w-full flex flex-col bg-neutral-950 text-neutral-100"
        onKeyDown={controller.handlePanelKeyDown}
      >
        <CommandHistory
          entries={history.visibleConsoleEntries}
          totalEntries={() => history.consoleEntries().length}
          normalizedSearch={history.normalizedHistorySearch}
          searchOpen={history.historySearchOpen}
          search={history.historySearch}
          onSearchInput={history.setHistorySearch}
          onSearchKeyDown={history.handleSearchKeyDown}
          onOpenSearch={history.openSearch}
          onCloseSearch={history.closeSearch}
          onClear={clearConsoleScrollback}
          searchRef={history.setHistorySearchElement}
          scrollbackRef={history.setScrollbackElement}
        />
        <form
          onSubmit={controller.handleSubmit}
          class="border-t border-neutral-800 p-2"
        >
          <div
            class="flex items-stretch gap-1"
            onKeyDown={controller.handleKeyDown}
          >
            {input}
            <CommandClearButton
              variant={controller.variant}
              onClear={controller.clearProgrammer}
            />
          </div>
        </form>
      </div>
    );
  }

  return (
    <form
      onSubmit={controller.handleSubmit}
      class="hidden md:block"
      style={{ width: "320px" }}
    >
      <InputGroup
        class="nf-header-command-group"
        onKeyDown={controller.handleKeyDown}
      >
        {input}
        <CommandClearButton
          variant={controller.variant}
          onClear={controller.clearProgrammer}
        />
      </InputGroup>
    </form>
  );
}
