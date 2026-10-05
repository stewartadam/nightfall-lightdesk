// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { SquaresFourIcon } from "@squidlab/phosphor-solid/squares-four";
import { XIcon } from "@squidlab/phosphor-solid/x";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { isPanelOpenable } from "../../../lib/experimental-features";
import { panelDefinitionsForPalette } from "../../../lib/panel-definitions";
import { openOrFocusPanelDefinition } from "../../../lib/panel-open-command";
import { runtimeCapabilities } from "../../../state/appStores";
import { useAppShell } from "../../providers/app-shell";
import { Dialog, DialogBody } from "../../ui/dialog";
import type { CompactPanelEntry, CompactPanels } from "./compact-panels";
import "./compact-shell.css";

/** Renders a panel's registered icon, or nothing when it has none. */
function PanelIcon(props: { entry: Pick<CompactPanelEntry, "icon"> }) {
  return (
    <Show when={props.entry.icon}>
      {(icon) => <Dynamic component={icon()} class="size-5" aria-hidden />}
    </Show>
  );
}

/**
 * Lists every open panel to switch to or close, then every other panel the
 * command palette offers, so a phone can reach any panel without docking.
 */
function CompactPanelSheet(props: {
  isOpen: boolean;
  panels: CompactPanels;
  onDismiss: () => void;
}) {
  const shell = useAppShell();
  const capabilities = useStore(runtimeCapabilities);
  /** Palette panels that are not open yet and that this backend allows. */
  const closedPanels = createMemo(() => {
    const open = new Set(props.panels.panels().map((panel) => panel.id));
    return panelDefinitionsForPalette()
      .filter(
        (definition) =>
          !open.has(definition.panelId) &&
          isPanelOpenable(definition.componentName, capabilities()),
      )
      .sort((a, b) => a.title.localeCompare(b.title));
  });

  return (
    <Dialog
      kind="info"
      placement="sheet"
      isOpen={props.isOpen}
      title="Panels"
      onDismiss={props.onDismiss}
    >
      <DialogBody class="nf-compact-sheet-body">
        <h3 class="nf-compact-sheet-heading">Open</h3>
        <ul class="nf-compact-sheet-list">
          <For each={props.panels.panels()}>
            {(entry) => (
              <li class="nf-compact-sheet-row">
                <button
                  type="button"
                  class="nf-compact-sheet-item"
                  aria-current={
                    entry.id === props.panels.activeId() ? "page" : undefined
                  }
                  onClick={() => {
                    props.panels.show(entry.id);
                    props.onDismiss();
                  }}
                >
                  <PanelIcon entry={entry} />
                  <span class="truncate">{entry.title}</span>
                </button>
                <button
                  type="button"
                  class="nf-compact-sheet-close"
                  aria-label={`Close ${entry.title}`}
                  onClick={() => props.panels.close(entry.id)}
                >
                  <XIcon class="size-4" aria-hidden />
                </button>
              </li>
            )}
          </For>
        </ul>
        <Show when={closedPanels().length > 0}>
          <h3 class="nf-compact-sheet-heading">Open another panel</h3>
          <ul class="nf-compact-sheet-list">
            <For each={closedPanels()}>
              {(definition) => (
                <li class="nf-compact-sheet-row">
                  <button
                    type="button"
                    class="nf-compact-sheet-item"
                    onClick={() => {
                      openOrFocusPanelDefinition(
                        shell.dockviewApi(),
                        definition,
                      );
                      props.onDismiss();
                    }}
                  >
                    <PanelIcon entry={definition} />
                    <span class="truncate">{definition.title}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </DialogBody>
    </Dialog>
  );
}

/**
 * Bottom tab bar of the compact shell: one tab per open panel, scrolled so the
 * shown panel stays in view, plus a button for the full panel sheet.
 */
export default function CompactNavigation(props: { panels: CompactPanels }) {
  const [sheetOpen, setSheetOpen] = createSignal(false);
  let strip: HTMLDivElement | undefined;

  /** Brings the active tab into view after a swipe or a pick from the sheet. */
  createEffect(() => {
    const id = props.panels.activeId();
    if (!id || !strip) return;
    const tab = strip.querySelector<HTMLElement>(
      `[data-compact-panel-id="${CSS.escape(id)}"]`,
    );
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  return (
    <nav class="nf-compact-nav" aria-label="Panels">
      <div ref={strip} class="nf-compact-nav-strip" role="tablist">
        <For each={props.panels.panels()}>
          {(entry) => (
            <button
              type="button"
              role="tab"
              class="nf-compact-nav-tab"
              data-compact-panel-id={entry.id}
              aria-selected={entry.id === props.panels.activeId()}
              onClick={() => props.panels.show(entry.id)}
            >
              <PanelIcon entry={entry} />
              <span class="nf-compact-nav-label">{entry.title}</span>
            </button>
          )}
        </For>
      </div>
      <button
        type="button"
        class="nf-compact-nav-tab nf-compact-nav-more"
        aria-haspopup="dialog"
        aria-expanded={sheetOpen()}
        onClick={() => setSheetOpen(true)}
      >
        <SquaresFourIcon class="size-5" aria-hidden />
        <span class="nf-compact-nav-label">Panels</span>
      </button>
      <CompactPanelSheet
        isOpen={sheetOpen()}
        panels={props.panels}
        onDismiss={() => setSheetOpen(false)}
      />
    </nav>
  );
}
