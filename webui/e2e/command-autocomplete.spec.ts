// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { gridCellByKey } from "./data-grid-selectors";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const inputSelector = "#header-cmdline";
const clearButtonSelector = "[data-command-programmer-clear]";
const suggestionsSelector = '[data-command-autocomplete="suggestions"]';
const suggestionRowsSelector = '[data-command-autocomplete="suggestion-row"]';
const commandHistoryStorageKey = "commandLineHistory";
const FIXTURE_ID = 311;
const CUE_ONE_UID = "c1000001000100010002000000000001";
const CUE_TWO_UID = "c1000001000100010002000000000002";
const SEQUENCE_ONE_UID = "c1000001000100010003000000000001";
const SEQUENCE_TWO_UID = "c1000001000100010003000000000002";

type CapturedCommandWindow = Window & {
  __commandLineClearCommands?: unknown[];
};

/** Builds a fixed zero-duration timing value for complete sequence metadata. */
function fixedZero(): object {
  return { type: "Fixed", data: { secs: 0, nanos: 0 } };
}

/** Builds the complete zero-duration transition used by owned sequences. */
function zeroTransition(): object {
  return {
    delay_in: fixedZero(),
    fade_in: fixedZero(),
    curve_in: "Linear",
    delay_out: fixedZero(),
    fade_out: fixedZero(),
    curve_out: "Linear",
  };
}

/** Builds one complete empty setup or release cue for an owned sequence. */
function metaCue(uid: string, label: string): object {
  return {
    identifiers: { id: 0, uid, label },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds one complete cue used to anchor a command-focus sequence. */
function ownedCue(id: number, uid: string, label: string): object {
  return {
    identifiers: { id, uid, label },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    lookahead: false,
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds one complete sequence containing its owned anchor cue. */
function ownedSequence(id: number, uid: string, cueUid: string): object {
  const metaPrefix = id === 1 ? "11" : "22";
  return {
    identifiers: { id, uid, label: `Command Focus Sequence ${id}` },
    steps: [cueUid],
    wrap: false,
    release_on_start: false,
    setup_cue: metaCue(`c1000001000100010005${metaPrefix}0000000001`, "Setup"),
    release_cue: metaCue(
      `c1000001000100010005${metaPrefix}0000000002`,
      "Release",
    ),
    default_timing: zeroTransition(),
    tracking_mode: { type: "Inherit" },
  };
}

/** Captures engine worker submission envelopes issued by the command-line UI. */
async function installCommandCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as CapturedCommandWindow).__commandLineClearCommands = [];
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      transfer?: Transferable[],
    ) {
      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "submit"
      ) {
        (window as CapturedCommandWindow).__commandLineClearCommands?.push(
          (message as { data?: unknown }).data,
        );
      }
      return originalPostMessage.call(this, message, transfer as never);
    } as Worker["postMessage"];
  });
}

/** Counts captured clear programmer commands sent through the websocket worker. */
async function countSentClearProgrammerCommands(page: Page): Promise<number> {
  return page.evaluate(() => {
    const commands =
      (window as CapturedCommandWindow).__commandLineClearCommands ?? [];
    return commands.filter((envelope) => {
      const candidate = envelope as {
        command?: { type?: unknown };
        module?: unknown;
      };
      return (
        candidate.module === "ProgrammerCommand" &&
        candidate.command?.type === "ClearProgrammer"
      );
    }).length;
  });
}

/** Counts captured desk commands sent through the websocket worker. */
async function countSentDeskCommands(page: Page): Promise<number> {
  return page.evaluate(() => {
    const commands =
      (window as CapturedCommandWindow).__commandLineClearCommands ?? [];
    return commands.filter((envelope) => {
      const candidate = envelope as {
        command?: { type?: unknown };
        module?: unknown;
      };
      return candidate.module === "DeskCommand";
    }).length;
  });
}

/** Clears commands captured during startup so tests count only their own sends. */
async function resetCapturedCommands(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as CapturedCommandWindow).__commandLineClearCommands = [];
  });
}

/** Waits until the fixture command preceding a cue store is fully reflected. */
async function waitForOwnedProgrammerValue(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((fixtureId) => {
        const stores = (window as any).appStores;
        const fixture = (Object.values(stores.fixtures.get()) as any[]).find(
          (candidate) => candidate.identifiers.id === fixtureId,
        );
        if (!fixture) return false;
        return (stores.programmerState.get() as any[]).some(
          (row) =>
            row.fixtureUid === fixture.identifiers.uid &&
            Boolean(row.attributes?.Red),
        );
      }, FIXTURE_ID),
    )
    .toBe(true);
}

/**
 * Adds a focused data-grid cell surrogate that records unhandled keydown events.
 */
async function installFocusedGridCellSurrogate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const grid = document.createElement("div");
    grid.dataset.gridKind = "tanstack";

    const cell = document.createElement("div");
    cell.dataset.commandShortcutGridCell = "ready";
    cell.tabIndex = 0;
    cell.textContent = "Editable grid cell";
    cell.addEventListener("keydown", (event) => {
      cell.dataset.commandShortcutGridCell = "received-keydown";
      event.preventDefault();
      event.stopImmediatePropagation();
    });

    grid.appendChild(cell);
    document.body.appendChild(grid);
    cell.focus();
  });
}

/**
 * Focuses the command input with text that should show autocomplete suggestions.
 */
async function openAutocomplete(page: Page, value: string) {
  const input = page.locator(inputSelector);
  await input.fill(value);
  await expect(page.locator(suggestionsSelector)).toBeVisible();
}

interface SequenceEditorPanelContext {
  panelId: string;
  sequenceId: number;
  targetCueLabel: string;
  targetCueRowKey: string;
}

interface ShellDetachSummary {
  appRootRemoved: number;
  shellHostRemoved: number;
  shellNodeAdded: number;
  shellNodeConnected: boolean;
  shellNodeRemoved: number;
  shellNodeStillOwnsInput: boolean;
}

/** Opens a Sequence Editor panel against the first loaded sequence with cues. */
async function openSequenceEditorPanel(
  page: Page,
  requestedSequenceId?: number,
): Promise<SequenceEditorPanelContext> {
  return await page.evaluate(async (requestedSequenceId) => {
    type Stores = {
      dockApi?: { get: () => any };
      cues?: { get: () => Record<string, any> };
      sequences?: { get: () => Record<string, any> };
    };

    /** Resolves once the dock, cue, and sequence stores are ready. */
    const waitForStores = () =>
      new Promise<Stores>((resolve, reject) => {
        const started = Date.now();

        /** Polls app stores until a sequence editor can be opened. */
        const tick = () => {
          const stores = (window as any).appStores as Stores | undefined;
          const api = stores?.dockApi?.get?.();
          const cues = stores?.cues?.get?.() ?? {};
          const sequences = stores?.sequences?.get?.() ?? {};
          const sequence =
            Object.values(sequences).find(
              (candidate: any) =>
                candidate.identifiers?.id === requestedSequenceId &&
                candidate.steps?.some((cueUid: string) => cues[cueUid]),
            ) ??
            Object.values(sequences).find((candidate: any) =>
              candidate.steps?.some(
                (cueUid: string) => cues[cueUid]?.identifiers?.id === 2,
              ),
            ) ??
            Object.values(sequences).find((candidate: any) =>
              candidate.steps?.some((cueUid: string) => cues[cueUid]),
            );
          if (api && stores?.cues && stores.sequences && sequence) {
            resolve(stores);
            return;
          }
          if (Date.now() - started > 15_000) {
            reject(new Error("sequence editor stores did not initialize"));
            return;
          }
          window.setTimeout(tick, 100);
        };

        tick();
      });

    const stores = await waitForStores();
    const api = stores.dockApi?.get();
    const cues = stores.cues?.get?.() ?? {};
    const sequences = stores.sequences?.get?.() ?? {};
    const sequence = (Object.values(sequences).find(
      (candidate: any) =>
        candidate.identifiers?.id === requestedSequenceId &&
        candidate.steps?.some((cueUid: string) => cues[cueUid]),
    ) ??
      Object.values(sequences).find((candidate: any) =>
        candidate.steps?.some(
          (cueUid: string) => cues[cueUid]?.identifiers?.id === 2,
        ),
      ) ??
      Object.values(sequences).find((candidate: any) =>
        candidate.steps?.some((cueUid: string) => cues[cueUid]),
      )) as any | undefined;
    if (!api || !sequence) {
      throw new Error("sequence editor stores did not initialize");
    }
    const targetCue = (sequence.steps ?? [])
      .map((cueUid: string) => cues[cueUid])
      .find((cue: any) => cue?.identifiers?.id === 2);
    const fallbackCue = (sequence.steps ?? [])
      .map((cueUid: string) => cues[cueUid])
      .find((cue: any) => cue);
    const cue = targetCue ?? fallbackCue;
    if (!cue) {
      throw new Error("sequence editor sequence did not contain a cue");
    }

    const panelId = "panel-SequenceEditor-command-focus-e2e";
    api.getPanel(panelId)?.api.close();
    api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: "Command Focus Sequence E2E",
      params: {
        initialPanelId: panelId,
        initialSequenceUid: sequence.identifiers.uid,
      },
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const panel = api.getPanel(panelId);
    panel?.api.setActive();
    panel?.focus();
    return {
      panelId,
      sequenceId: sequence.identifiers.id,
      targetCueLabel: cue.identifiers.label,
      targetCueRowKey: `${cue.identifiers.uid}:cue`,
    };
  }, requestedSequenceId);
}

/** Clicks the target cue label cell inside the mounted sequence editor grid. */
async function clickSequenceEditorCueLabel(
  page: Page,
  sequenceEditor: SequenceEditorPanelContext,
): Promise<void> {
  const panel = page.locator(
    `[data-panel-id="${sequenceEditor.panelId}"]:visible`,
  );
  const grid = panel
    .locator('[data-grid-owner="sequence-editor"]')
    .locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();
  const labelCell = gridCellByKey(grid, {
    columnKey: "label",
    rowKey: sequenceEditor.targetCueRowKey,
  });
  await expect(labelCell).toContainText(sequenceEditor.targetCueLabel, {
    timeout: 15_000,
  });
  await labelCell.click();
}

/** Tracks whether the mounted interactive shell subtree is detached from its stable host. */
async function installShellDetachObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const main = document.querySelector("main#app");
    const input = document.querySelector("#header-cmdline");
    const appRoot =
      document.querySelector("[data-app-root='true']") ??
      main?.firstElementChild;
    const shellHost =
      document.querySelector("[data-interactive-shell-root='true']") ??
      appRoot?.firstElementChild;
    const ancestors: Element[] = [];
    for (
      let element = input;
      element && element !== shellHost;
      element = element.parentElement
    ) {
      ancestors.push(element);
    }
    const shellNode =
      ancestors.find((element) => element.parentElement === shellHost) ??
      shellHost;
    if (!main || !appRoot || !shellHost || !shellNode) {
      throw new Error("Expected mounted command input shell roots");
    }

    (window as any).__commandFocusShellDetach = {
      appRoot,
      appRootRemoved: 0,
      shellHost,
      shellHostRemoved: 0,
      shellNode,
      shellNodeAdded: 0,
      shellNodeRemoved: 0,
    };

    new MutationObserver((mutations) => {
      const state = (window as any).__commandFocusShellDetach;
      for (const mutation of mutations) {
        state.appRootRemoved += [...mutation.removedNodes].filter(
          (node) => node === appRoot,
        ).length;
      }
    }).observe(main, { childList: true });

    new MutationObserver((mutations) => {
      const state = (window as any).__commandFocusShellDetach;
      for (const mutation of mutations) {
        state.shellHostRemoved += [...mutation.removedNodes].filter(
          (node) => node === shellHost,
        ).length;
      }
    }).observe(appRoot, { childList: true });

    new MutationObserver((mutations) => {
      const state = (window as any).__commandFocusShellDetach;
      for (const mutation of mutations) {
        state.shellNodeAdded += [...mutation.addedNodes].filter(
          (node) => node === shellNode,
        ).length;
        state.shellNodeRemoved += [...mutation.removedNodes].filter(
          (node) => node === shellNode,
        ).length;
      }
    }).observe(shellHost, { childList: true });
  });
}

/** Reads the current interactive shell detachment counters from the page. */
async function readShellDetachSummary(page: Page): Promise<ShellDetachSummary> {
  return await page.evaluate(() => {
    const state = (window as any).__commandFocusShellDetach;
    if (!state) {
      throw new Error("Shell detach observer was not installed");
    }
    return {
      appRootRemoved: state.appRootRemoved,
      shellHostRemoved: state.shellHostRemoved,
      shellNodeAdded: state.shellNodeAdded,
      shellNodeConnected: state.shellNode.isConnected,
      shellNodeRemoved: state.shellNodeRemoved,
      shellNodeStillOwnsInput: state.shellNode.contains(
        document.querySelector("#header-cmdline"),
      ),
    };
  });
}

/** Stores fixture 311 plus the two complete sequence contexts used by the suite. */
async function storeOwnedCommandData(page: Page): Promise<void> {
  const cueOne = ownedCue(1, CUE_ONE_UID, "Command Focus Cue 1");
  const cueTwo = ownedCue(2, CUE_TWO_UID, "Command Focus Cue 2");
  const sequenceOne = ownedSequence(1, SEQUENCE_ONE_UID, CUE_ONE_UID);
  const sequenceTwo = ownedSequence(2, SEQUENCE_TWO_UID, CUE_TWO_UID);
  const results = await page.evaluate(
    async ({ cueOne, cueTwo, fixtureId, sequenceOne, sequenceTwo }) => {
      const stores = (window as any).appStores;

      /** Sends one setup command and returns its correlated backend outcome. */
      const store = async (message: object): Promise<any> =>
        stores.sendAndAwait(message);

      return [
        await store({
          module: "FixtureLibraryCommand",
          command: {
            type: "CreateFixtureFromLibrary",
            data: {
              id: fixtureId,
              make: "Generic",
              model: "Moving Head RGBW",
              mode: "Spot",
              label: "Owned Command Fixture 311",
              update_existing_ids: [],
              update_existing_only: false,
            },
          },
        }),
        await store({
          module: "CueCommand",
          command: { type: "StoreCue", data: cueOne },
        }),
        await store({
          module: "CueCommand",
          command: { type: "StoreCue", data: cueTwo },
        }),
        await store({
          module: "CueCommand",
          command: { type: "StoreSequence", data: sequenceOne },
        }),
        await store({
          module: "CueCommand",
          command: { type: "StoreSequence", data: sequenceTwo },
        }),
      ];
    },
    { cueOne, cueTwo, fixtureId: FIXTURE_ID, sequenceOne, sequenceTwo },
  );
  for (const result of results) {
    expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
  }
  await expectOwnedCommandData(page);
}

/** Verifies the exact fixture, cues, and sequences owned by this suite are loaded. */
async function expectOwnedCommandData(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({
          cueOneUid,
          cueTwoUid,
          fixtureId,
          sequenceOneUid,
          sequenceTwoUid,
        }) => {
          const stores = (window as any).appStores;
          const fixture = (Object.values(stores.fixtures.get()) as any[]).find(
            (candidate) => candidate.identifiers.id === fixtureId,
          );
          const fixtureAttributes = (fixture?.elements ?? []).flatMap(
            (element: any) =>
              (element.parameters ?? []).map(
                (parameter: any) => parameter.attribute?.type,
              ),
          );
          return {
            cueOne: stores.cues.get()[cueOneUid]?.identifiers.id,
            cueTwo: stores.cues.get()[cueTwoUid]?.identifiers.id,
            fixtureAttributes,
            fixtureCount: Object.keys(stores.fixtures.get()).length,
            sequenceOne: stores.sequences.get()[sequenceOneUid]?.steps,
            sequenceTwo: stores.sequences.get()[sequenceTwoUid]?.steps,
          };
        },
        {
          cueOneUid: CUE_ONE_UID,
          cueTwoUid: CUE_TWO_UID,
          fixtureId: FIXTURE_ID,
          sequenceOneUid: SEQUENCE_ONE_UID,
          sequenceTwoUid: SEQUENCE_TWO_UID,
        },
      ),
    )
    .toMatchObject({
      cueOne: 1,
      cueTwo: 2,
      fixtureAttributes: expect.arrayContaining(["Red"]),
      fixtureCount: 1,
      sequenceOne: [CUE_ONE_UID],
      sequenceTwo: [CUE_TWO_UID],
    });
}

/** Opens the command UI on a blank backend with only suite-owned definitions. */
async function openOwnedCommandApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await installCommandCapture(page);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.sequences?.get),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          cues: Object.keys(stores.cues.get()).length,
          fixtures: Object.keys(stores.fixtures.get()).length,
          sequences: Object.keys(stores.sequences.get()).length,
        };
      }),
    )
    .toEqual({ cues: 0, fixtures: 0, sequences: 0 });
  await storeOwnedCommandData(page);
  await page.reload();
  await waitForDockviewApp(page);
  await expectOwnedCommandData(page);
  await resetCapturedCommands(page);
  await expect(page.locator(inputSelector)).toBeVisible({ timeout: 20_000 });
}

/** Starts every scenario from exact owned command data on a blank backend. */
test.beforeEach(async ({ backendSlot, page }) => {
  await openOwnedCommandApp(page, backendSlot.backendPort);
});

/** Resets dynamic cue and FX records created by command submissions. */
test.afterEach(async ({ backendSlot }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
});

/** Verifies the joined suffix preserves field focus and sends the global programmer clear command. */
test("sends clear programmer from the command input clear button", async ({
  page,
}, testInfo) => {
  const input = page.locator(inputSelector);
  const clearButton = input
    .locator("xpath=ancestor::form[1]")
    .locator(clearButtonSelector);

  const inputBox = await input.boundingBox();
  const clearButtonBox = await clearButton.boundingBox();
  if (!inputBox || !clearButtonBox) {
    throw new Error("Expected command input and clear programmer button boxes");
  }
  expect(clearButtonBox.x).toBeCloseTo(inputBox.x + inputBox.width, 1);
  expect(Math.abs(clearButtonBox.height - inputBox.height)).toBeLessThanOrEqual(
    1,
  );

  await input.fill("fixture 1");
  await expect(input).toHaveCSS("border-right-width", "0px");
  await expect(clearButton).toHaveCSS("border-left-width", "1px");
  await expect(clearButton).toHaveCSS("border-top-width", "0px");
  await page.screenshot({
    path: testInfo.outputPath("grouped-command-input.png"),
  });
  await clearButton.click();

  await expect.poll(() => countSentClearProgrammerCommands(page)).toBe(1);
  await expect(input).toHaveValue("fixture 1");
  await expect(input).toBeFocused();
});

/** Verifies that modifier clear shortcuts send the global programmer clear command. */
test("sends clear programmer with modifier delete shortcuts", async ({
  page,
}) => {
  const input = page.locator(inputSelector);

  for (const [index, shortcut] of [
    "Control+Backspace",
    "Control+Delete",
  ].entries()) {
    await input.fill("fixture 1");
    await input.evaluate((element) => element.blur());
    await page.keyboard.press(shortcut);

    await expect
      .poll(() => countSentClearProgrammerCommands(page))
      .toBe(index + 1);
    await expect(input).toHaveValue("fixture 1");
  }
});

/** Verifies data-grid focus cannot consume modified clear shortcuts first. */
test("captures modifier clear shortcuts from focused data-grid cells", async ({
  page,
}) => {
  await installFocusedGridCellSurrogate(page);

  for (const [index, shortcut] of [
    "Control+Backspace",
    "Control+Delete",
  ].entries()) {
    await page.keyboard.press(shortcut);
    await expect
      .poll(() => countSentClearProgrammerCommands(page))
      .toBe(index + 1);
  }
});

/** Verifies text inputs keep native modified deletion behavior. */
test("leaves modifier delete shortcuts alone while editing text", async ({
  page,
}) => {
  const input = page.locator(inputSelector);
  await input.fill("fixture 123");
  await input.press("Control+Backspace");
  await input.press("Control+Delete");

  await expect.poll(() => countSentClearProgrammerCommands(page)).toBe(0);
});

/** Verifies Shift+Escape clears while a text input is focused. */
test("clears programmer from Shift+Escape inside command input", async ({
  page,
}) => {
  const input = page.locator(inputSelector);
  await input.fill("fixture 1");

  await input.press("Escape");

  await expect(input).toBeFocused();
  await expect(input).toHaveValue("fixture 1");
  await expect.poll(() => countSentClearProgrammerCommands(page)).toBe(0);

  await input.press("Shift+Escape");

  await expect(input).toBeFocused();
  await expect(input).toHaveValue("fixture 1");
  await expect.poll(() => countSentClearProgrammerCommands(page)).toBe(1);
});

/** Verifies shared suggestion rows retain intent grouping and keyboard context. */
test("shows intent-grouped suggestions for fixture selection", async ({
  page,
}, testInfo) => {
  await openAutocomplete(page, "fix 311");

  const intentRows = page.locator(
    `${suggestionRowsSelector}[data-suggestion-kind="intent"]`,
  );
  await expect.poll(async () => intentRows.count()).toBeGreaterThan(0);

  await expect(
    page.locator('[data-command-autocomplete="breadcrumb"]'),
  ).toHaveText("Programmer");
  await page.screenshot({
    path: testInfo.outputPath("ambiguous-selection-frontier.png"),
  });
});

/** Parser ancestry stays visible during automatic expansion, value entry, and manual group expansion. */
test("preserves breadcrumbs in expanded attribute suggestions", async ({
  page,
}, testInfo) => {
  const input = page.locator(inputSelector);
  const breadcrumb = page.locator('[data-command-autocomplete="breadcrumb"]');
  const expectedPath = "Programmer > Attributes > Set Attribute";
  await openAutocomplete(page, "fix 311 red");
  await expect(
    page.locator(`${suggestionRowsSelector}[data-insert-text="@"]`),
  ).toBeVisible();
  await expect(breadcrumb).toHaveText(expectedPath);
  await expect(
    page.locator('[data-command-autocomplete="intent-sublist-label"]'),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("attribute-operator-breadcrumb.png"),
  });

  await input.press("Tab");
  await expect(input).toHaveValue("fix 311 red @ ");
  await expect(
    page.locator(
      `${suggestionRowsSelector}[data-intent-id="programmer/set_attribute"]`,
    ),
  ).toContainText("0..9");
  await expect(breadcrumb).toHaveText(expectedPath);
  await page.screenshot({
    path: testInfo.outputPath("attribute-value-breadcrumb.png"),
  });

  await input.press("Tab");
  await expect(
    page.locator(`${suggestionRowsSelector}[data-insert-text="0..9"]`),
  ).toBeVisible();
  await expect(breadcrumb).toHaveText(expectedPath);
});

/** WASM accepts signed and source-local Blueprint baseline forms before command submission. */
test("accepts signed and absolute Blueprint Step FX baselines", async ({
  page,
}) => {
  const input = page.locator(inputSelector);
  for (const command of [
    "store fx 1 step fix 311 5s pan @ -50 steps ~25",
    "store fx 8 step fix 311 5s pan @ bp 10 /absolute steps ~25",
  ]) {
    await input.fill(command);
    const validation = await page.evaluate(async (command) => {
      const { validateCommand } = await import("/lib/wasm-bridge.ts");
      return await validateCommand(command);
    }, command);
    expect(validation?.status).toBe("ok");
    await expect(input).not.toHaveAttribute("aria-invalid", "true");
  }
});

/** Tab opens a placeholder-bearing duration group before applying a parser-owned unit edit. */
test("duration Tab preserves the value before inserting a unit", async ({
  page,
}, testInfo) => {
  const input = page.locator(inputSelector);
  await openAutocomplete(page, "sleep 5");
  await expect(
    page.locator(`${suggestionRowsSelector}[data-intent-id="sleep/duration"]`),
  ).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue("sleep 5");
  const unit = page.locator(`${suggestionRowsSelector}[data-insert-text="ms"]`);
  await expect(unit).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("duration-frontier.png") });
  await unit.click();
  await expect(input).toHaveValue("sleep 5ms ");
});

/** Runtime labels use parser-issued ranges across Unicode and the complete existing quoted token. */
test("Blueprint completion replaces a quoted Unicode label at the cursor", async ({
  page,
}, testInfo) => {
  const label = 'Warm "Amber" 😀';
  await page.evaluate((label) => {
    (window as any).appStores.blueprints.set({
      "bp-44": { identifiers: { id: 44, uid: "bp-44", label }, values: {} },
    });
  }, label);
  const input = page.locator(inputSelector);
  const before = "sleep 1; recall blueprint ";
  const value = `${before}${JSON.stringify(label)} /absolute`;
  await input.fill(value);
  await input.evaluate((element, cursor) => {
    (element as HTMLInputElement).setSelectionRange(cursor, cursor);
    element.dispatchEvent(new Event("select", { bubbles: true }));
    element.dispatchEvent(
      new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }),
    );
  }, before.length + 3);
  await expect(
    page.locator(suggestionsSelector).getByText(label, { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-command-autocomplete="breadcrumb"]'),
  ).toHaveText("Recall > Blueprint");
  await page.screenshot({
    path: testInfo.outputPath("blueprint-quoted-frontier.png"),
  });
  await input.press("Tab");
  await expect(input).toHaveValue(
    `${before}${JSON.stringify(label)}  /absolute`,
  );
});

/** Named attributes exclude the intensity shortcut even after an earlier intensity assignment. */
test("scopes intensity suggestions to implicit attribute values", async ({
  page,
}, testInfo) => {
  for (const command of [
    "fix 311 red @",
    "fix 311 int @ 100 red @",
    "fix 311 int @",
  ]) {
    await openAutocomplete(page, command);
    await expect(
      page.locator(
        `${suggestionRowsSelector}[data-intent-id="programmer/set_attribute"]`,
      ),
    ).toBeVisible();
    await expect(
      page.locator(
        `${suggestionRowsSelector}[data-intent-id="programmer/intensity"]`,
      ),
    ).toHaveCount(0);
  }
  await openAutocomplete(page, "fix 311 int @ 100 red @");
  await page.screenshot({
    path: testInfo.outputPath("attribute-value-frontier.png"),
  });
  await openAutocomplete(page, "fix 311 @");
  await expect(
    page.locator(
      `${suggestionRowsSelector}[data-intent-id="programmer/intensity"]`,
    ),
  ).toBeVisible();
});

/** Value placeholders keep their owning intent visible until the user expands it. */
test("keeps signed value tokens inside their owning intent after @", async ({
  page,
}) => {
  await openAutocomplete(page, "fix 311 red @");
  await expect(
    page.locator(
      `${suggestionRowsSelector}[data-intent-id="programmer/set_attribute"]`,
    ),
  ).toBeVisible();
  await page.locator(inputSelector).press("Tab");

  const tokenRows = page.locator(
    `${suggestionRowsSelector}[data-suggestion-kind="token"]`,
  );
  await expect.poll(async () => tokenRows.count()).toBeGreaterThan(0);
  await expect(page.getByRole("option", { name: /^\+/ })).toBeVisible();
});

test("accepts spatial selection clauses on attribute commands", async ({
  page,
}) => {
  const input = page.locator(inputSelector);
  await input.fill("group 1>4|wings 2 @ 50");

  await expect(input).not.toHaveAttribute("aria-invalid", "true");
});

/**
 * Verifies named showfile save commands are accepted by the UI parser.
 */
test("accepts named showfile save commands", async ({ page }) => {
  const input = page.locator(inputSelector);
  await input.fill("save sample");

  await expect(input).not.toHaveAttribute("aria-invalid", "true");
});

/**
 * Verifies named showfile load commands are accepted by the UI parser.
 */
test("accepts named showfile load commands", async ({ page }) => {
  const input = page.locator(inputSelector);
  await input.fill("load sample");

  await expect(input).not.toHaveAttribute("aria-invalid", "true");

  await input.fill("load draft/default");
  await expect(input).not.toHaveAttribute("aria-invalid", "true");

  await input.fill("load backups/default-20260707-151450");
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
});

/**
 * Verifies semantic validation flags patch commands with unknown output transport targets.
 */
test("flags unknown output transport patch targets", async ({ page }) => {
  const input = page.locator(inputSelector);
  await input.fill("patch fix 4 @missingnode:0.50");

  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByRole("status", {
      name: /Unknown output transport target "missingnode"/,
    }),
  ).toBeVisible();
});

/** Verifies the sole attribute intent opens automatically and Tab inserts its selected token. */
test("tab inserts the selected @ token from the sole attribute intent", async ({
  page,
}) => {
  const input = page.locator(inputSelector);
  await openAutocomplete(page, "fix 311 red ");

  await expect(
    page.locator('[data-command-autocomplete="intent-sublist-label"]'),
  ).toHaveText("Set Attribute");
  await expect(
    page.locator(`${suggestionRowsSelector}[data-insert-text="@"]`),
  ).toHaveAttribute("aria-selected", "true");
  await input.press("Tab");

  await expect(input).toHaveValue(/fix 311 red\s*@/);

  await expect(
    page.locator(
      `${suggestionRowsSelector}[data-intent-id="programmer/set_attribute"]`,
    ),
  ).toBeVisible();
});

test("keeps command-type sublist expanded while typing command head", async ({
  page,
}) => {
  const input = page.locator(inputSelector);
  await openAutocomplete(page, "f");

  const sublistLabel = page.locator(
    '[data-command-autocomplete="intent-sublist-label"]',
  );
  await expect(sublistLabel).toHaveText(/Command Type/);

  await input.press("i");

  await expect(sublistLabel).toHaveText(/Command Type/);
});

/** Verifies a valid multi-statement command is stored as one history item. */
test("submits semicolon-separated command statements", async ({ page }) => {
  const input = page.locator(inputSelector);
  const command =
    "store fx 1 step fix 311 5s int @ 50 steps ~25 ~-25 red steps @100 0; sleep 1; fx 1 start";
  await input.fill(command);

  await input.press("Enter");

  await expect(input).toHaveValue("");
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await expect
    .poll(() =>
      page.evaluate((storageKey) => {
        const stored = window.localStorage.getItem(storageKey);
        return stored ? JSON.parse(stored) : [];
      }, commandHistoryStorageKey),
    )
    .toEqual([command]);
});

/** Verifies DockView panel activation after submit does not steal editing focus. */
test("keeps header command input focused when command line panel activates after submit", async ({
  page,
}) => {
  const command = "store cue 1.2";
  const input = page.locator(inputSelector);

  await input.fill(command);
  await input.press("Enter");

  await expect.poll(() => countSentDeskCommands(page)).toBe(1);
  await expect(input).toHaveValue("");

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-CommandLine")?.api.setActive();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe("panel-CommandLine");
  await page.waitForTimeout(30);
  await expect(input).toBeFocused();
});

/** Verifies storing a cue does not leave keyboard focus outside the command input. */
test("keeps header command input focused after storing a cue", async ({
  page,
}) => {
  const input = page.locator(inputSelector);

  await input.fill("fix 311 red @ 100");
  await input.press("Enter");
  await expect.poll(() => countSentDeskCommands(page)).toBe(1);
  await expect(input).toBeFocused();
  await waitForOwnedProgrammerValue(page);

  await page.keyboard.type("store cue 2.", { delay: 40 });
  await input.press("Enter");

  await expect.poll(() => countSentDeskCommands(page)).toBe(2);
  await expect(input).toHaveValue("");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.values((window as any).appStores.cues.get()).some(
          (cue: any) => cue.identifiers?.id === 2,
        ),
      ),
    )
    .toBe(true);
  await page.waitForTimeout(2500);
  await expect(input).toBeFocused();
});

/** Verifies the header command input remains the editing target while Sequence Editor is open. */
test("keeps header command input active after storing a cue with sequence editor open", async ({
  page,
}) => {
  const input = page.locator(inputSelector);
  const sequenceEditor = await openSequenceEditorPanel(page, 2);
  expect(sequenceEditor.sequenceId).toBe(2);
  const storeCommand = "store cue 2.";

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe(sequenceEditor.panelId);

  await clickSequenceEditorCueLabel(page, sequenceEditor);
  await input.click();
  await input.fill("fix 311 red @ 100");
  await input.press("Enter");
  await expect.poll(() => countSentDeskCommands(page)).toBe(1);
  await expect(input).toBeFocused();
  await waitForOwnedProgrammerValue(page);

  await installShellDetachObserver(page);
  await page.keyboard.type(storeCommand, { delay: 40 });
  await input.press("Enter");

  await expect.poll(() => countSentDeskCommands(page)).toBe(2);
  await expect(input).toHaveValue("");
  await page.waitForTimeout(5000);
  await expect
    .poll(() => readShellDetachSummary(page))
    .toEqual({
      appRootRemoved: 0,
      shellHostRemoved: 0,
      shellNodeAdded: 0,
      shellNodeConnected: true,
      shellNodeRemoved: 0,
      shellNodeStillOwnsInput: true,
    });
  await expect(input).toBeFocused();

  await page.keyboard.type("x");
  await expect(input).toHaveValue("x");
});

/** Verifies cue storage does not move focus away from the docked command-line panel. */
/** Verifies cue storage retains input focus and the shared history search filters without discarding entries. */
test("keeps panel command input focused after storing a cue", async ({
  page,
}) => {
  const input = page.locator("#cmdline");

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-CommandLine")?.focus();
  });
  await expect(input).toBeVisible();
  await input.fill("fix 311 red @ 100");
  await input.press("Enter");
  await expect.poll(() => countSentDeskCommands(page)).toBe(1);
  await expect(input).toBeFocused();
  await waitForOwnedProgrammerValue(page);

  await page.keyboard.type("store cue 2.", { delay: 40 });
  await input.press("Enter");

  await expect.poll(() => countSentDeskCommands(page)).toBe(2);
  await expect(input).toHaveValue("");
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-CueList")?.focus();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe("panel-CueList");
  await expect(input).toBeFocused();
  await page.getByRole("tab", { name: "Console", exact: true }).click();
  await page.getByRole("button", { name: "Search command history" }).click();
  const historySearch = page.getByRole("searchbox", {
    name: "Command history search",
  });
  await expect(historySearch).toBeFocused();
  await historySearch.fill("no matching command in this history");
  await expect(
    page.getByText("No commands match the current search."),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("shared-command-history-search.png"),
  });
  await page.getByRole("button", { name: "Close history search" }).click();
  await expect(historySearch).toHaveCount(0);
  await expect(page.getByText("store cue 2.", { exact: true })).toBeVisible();
});

/** Verifies cue storage keeps the docked command line active while Sequence Editor is open. */
test("keeps panel command input active after storing a cue with sequence editor open", async ({
  page,
}) => {
  const input = page.locator("#cmdline");
  const sequenceEditor = await openSequenceEditorPanel(page, 2);
  expect(sequenceEditor.sequenceId).toBe(2);
  const storeCommand = "store cue 2.";

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe(sequenceEditor.panelId);

  await clickSequenceEditorCueLabel(page, sequenceEditor);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-CommandLine")?.focus();
  });
  await expect(input).toBeVisible();
  await input.fill("fix 311 red @ 100");
  await input.press("Enter");
  await expect.poll(() => countSentDeskCommands(page)).toBe(1);
  await expect(input).toBeFocused();
  await waitForOwnedProgrammerValue(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe("panel-CommandLine");

  await page.keyboard.type(storeCommand, { delay: 40 });
  await input.press("Enter");

  await expect.poll(() => countSentDeskCommands(page)).toBe(2);
  await expect(input).toHaveValue("");
  await page.waitForTimeout(5000);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe("panel-CommandLine");
  await expect(input).toBeFocused();

  await page.keyboard.type("x");
  await expect(input).toHaveValue("x");
});

test("submits commands when command history persistence fails", async ({
  page,
}) => {
  await page.evaluate((storageKey) => {
    Object.defineProperty(window.localStorage, storageKey, {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }, commandHistoryStorageKey);

  const input = page.locator(inputSelector);
  await input.fill("save sample");
  await input.press("Enter");

  await expect.poll(() => countSentDeskCommands(page)).toBe(1);
  await expect(input).toHaveValue("");
  await expect(input).not.toHaveAttribute("aria-invalid", "true");

  await input.press("ArrowUp");
  await expect(input).toHaveValue("save sample");
});
