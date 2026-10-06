// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { DotsSixVerticalIcon } from "@squidlab/phosphor-solid/dots-six-vertical";
import { PushPinIcon } from "@squidlab/phosphor-solid/push-pin";
import { PushPinSlashIcon } from "@squidlab/phosphor-solid/push-pin-slash";
import { SquaresFourIcon } from "@squidlab/phosphor-solid/squares-four";
import { XIcon } from "@squidlab/phosphor-solid/x";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { isPanelOpenable } from "../../../lib/experimental-features";
import { panelDefinitionsForPalette } from "../../../lib/panel-definitions";
import { openOrFocusPanelDefinition } from "../../../lib/panel-open-command";
import { runtimeCapabilities } from "../../../state/appStores";
import { useAppShell } from "../../providers/app-shell";
import { Dialog, DialogBody } from "../../ui/dialog";
import { COMPACT_PINNED_TAB_COUNT } from "./compact-panel-order";
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

/** A panel row being dragged by its handle, with the position it would drop at. */
interface RowDrag {
  readonly id: string;
  readonly pointerId: number;
  readonly toIndex: number;
}

/**
 * Open panels in the operator's order, split into the pinned tabs and the
 * rest. Rows reorder by dragging their handle (or with the arrow keys on it);
 * dragging a row into or out of the first four pins or unpins it.
 */
function CompactOpenPanelList(props: {
  panels: CompactPanels;
  onShow: (id: string) => void;
}) {
  const [drag, setDrag] = createSignal<RowDrag>();
  let list: HTMLUListElement | undefined;

  /** The order to render: the saved order, or a live preview while a row is dragged. */
  const rows = createMemo(() => {
    const entries = props.panels.panels();
    const current = drag();
    if (!current) return entries;
    const dragged = entries.find((entry) => entry.id === current.id);
    if (!dragged) return entries;
    const rest = entries.filter((entry) => entry.id !== current.id);
    rest.splice(current.toIndex, 0, dragged);
    return rest;
  });

  /** Finds the drop position from the pointer's height against the other rows' centers. */
  const dropIndexAt = (clientY: number, draggedId: string): number => {
    const others = Array.from(
      list?.querySelectorAll<HTMLElement>("[data-compact-row-id]") ?? [],
    ).filter((row) => row.dataset.compactRowId !== draggedId);
    return others.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top + rect.height / 2 < clientY;
    }).length;
  };

  /** Moves the dragged row's preview to where the pointer would drop it. */
  const continueDrag = (event: PointerEvent) => {
    const current = drag();
    if (!current || current.pointerId !== event.pointerId) return;
    const toIndex = dropIndexAt(event.clientY, current.id);
    if (toIndex !== current.toIndex) setDrag({ ...current, toIndex });
  };

  /** Saves the previewed position when the dragging pointer lifts anywhere. */
  const finishDrag = (event: PointerEvent) => {
    const current = drag();
    if (!current || current.pointerId !== event.pointerId) return;
    endDrag();
    props.panels.move(current.id, current.toIndex);
  };

  /** Drops the preview when the browser takes the dragging pointer away. */
  const cancelDrag = (event: PointerEvent) => {
    if (drag()?.pointerId === event.pointerId) endDrag();
  };

  /**
   * Stops following the pointer. The drag listens on the window rather than
   * capturing the pointer on the handle, because the live preview moves the
   * handle's row in the DOM and WebKit drops capture from moved nodes.
   */
  const endDrag = () => {
    setDrag(undefined);
    window.removeEventListener("pointermove", continueDrag);
    window.removeEventListener("pointerup", finishDrag);
    window.removeEventListener("pointercancel", cancelDrag);
  };
  onCleanup(endDrag);

  /** Starts dragging a row from its handle and follows that pointer until it lifts. */
  const startDrag = (event: PointerEvent, id: string) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (drag()) return;
    event.preventDefault();
    const index = props.panels.panels().findIndex((entry) => entry.id === id);
    setDrag({ id, pointerId: event.pointerId, toIndex: Math.max(0, index) });
    window.addEventListener("pointermove", continueDrag);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", cancelDrag);
  };

  /** Puts focus back on a row's handle after a reorder re-inserted its row. */
  const focusHandle = (id: string) => {
    const handle = list?.querySelector<HTMLElement>(
      `[data-compact-row-id="${CSS.escape(id)}"] .nf-compact-sheet-handle`,
    );
    if (handle && document.activeElement !== handle) handle.focus();
  };

  /** Moves a row one place with the arrow keys for keyboard users. */
  const moveWithKeys = (event: KeyboardEvent, id: string, index: number) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    props.panels.move(id, index + (event.key === "ArrowUp" ? -1 : 1));
    focusHandle(id);
  };

  /** Whether more panels are open than fit in the tab bar, so pinning means something. */
  const canPin = () => props.panels.panels().length > COMPACT_PINNED_TAB_COUNT;

  /** Pins a panel to the end of the tab bar, or moves it just past the pinned tabs. */
  const togglePin = (id: string, index: number) => {
    props.panels.move(
      id,
      index < COMPACT_PINNED_TAB_COUNT
        ? COMPACT_PINNED_TAB_COUNT
        : COMPACT_PINNED_TAB_COUNT - 1,
    );
  };

  return (
    <ul
      ref={list}
      class="nf-compact-sheet-list"
      aria-label="Open panels"
      data-dragging={drag() ? "" : undefined}
    >
      <For each={rows()}>
        {(entry, index) => {
          const pinned = () => index() < COMPACT_PINNED_TAB_COUNT;
          return (
            <>
              <Show when={index() === 0}>
                <li class="nf-compact-sheet-heading" aria-hidden="true">
                  Pinned tabs
                </li>
              </Show>
              <Show when={index() === COMPACT_PINNED_TAB_COUNT}>
                <li class="nf-compact-sheet-heading" aria-hidden="true">
                  Other open panels
                </li>
              </Show>
              <li
                class="nf-compact-sheet-row"
                data-compact-row-id={entry.id}
                data-pinned={pinned() ? "" : undefined}
                data-dragged={drag()?.id === entry.id ? "" : undefined}
              >
                <button
                  type="button"
                  class="nf-compact-sheet-handle"
                  aria-label={`Reorder ${entry.title}`}
                  aria-describedby="nf-compact-reorder-hint"
                  onPointerDown={(event) => startDrag(event, entry.id)}
                  onKeyDown={(event) => moveWithKeys(event, entry.id, index())}
                >
                  <DotsSixVerticalIcon class="size-5" aria-hidden />
                </button>
                <button
                  type="button"
                  class="nf-compact-sheet-item"
                  aria-current={
                    entry.id === props.panels.activeId() ? "page" : undefined
                  }
                  onClick={() => props.onShow(entry.id)}
                >
                  <PanelIcon entry={entry} />
                  <span class="truncate">{entry.title}</span>
                </button>
                <Show when={canPin()}>
                  <button
                    type="button"
                    class="nf-compact-sheet-action"
                    aria-label={`Pin ${entry.title}`}
                    aria-pressed={pinned()}
                    onClick={() => togglePin(entry.id, index())}
                  >
                    <Show
                      when={pinned()}
                      fallback={<PushPinIcon class="size-4" aria-hidden />}
                    >
                      <PushPinSlashIcon class="size-4" aria-hidden />
                    </Show>
                  </button>
                </Show>
                <button
                  type="button"
                  class="nf-compact-sheet-action"
                  aria-label={`Close ${entry.title}`}
                  onClick={() => props.panels.close(entry.id)}
                >
                  <XIcon class="size-4" aria-hidden />
                </button>
              </li>
            </>
          );
        }}
      </For>
    </ul>
  );
}

/**
 * Lists the open panels to switch to, reorder, pin or close, then every other
 * panel the command palette offers, so a phone can reach any panel.
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
        <p id="nf-compact-reorder-hint" class="nf-compact-sheet-hint">
          Drag a handle, or press the arrow keys on it, to reorder. The first{" "}
          {COMPACT_PINNED_TAB_COUNT} are pinned to the tab bar.
        </p>
        <CompactOpenPanelList
          panels={props.panels}
          onShow={(id) => {
            props.panels.show(id);
            props.onDismiss();
          }}
        />
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
 * Bottom tab bar of the compact shell: the pinned panels as fixed tabs, plus a
 * Panels button for everything else. When the shown panel is not pinned, the
 * Panels button carries its name so the operator still sees where they are.
 */
export default function CompactNavigation(props: { panels: CompactPanels }) {
  const [sheetOpen, setSheetOpen] = createSignal(false);
  /** The shown panel when it is not one of the pinned tabs. */
  const activeUnpinned = createMemo(() => {
    const id = props.panels.activeId();
    if (props.panels.pinned().some((entry) => entry.id === id)) return;
    return props.panels.panels().find((entry) => entry.id === id);
  });

  return (
    <nav class="nf-compact-nav" aria-label="Panels">
      <div class="nf-compact-nav-tabs" role="tablist">
        <For each={props.panels.pinned()}>
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
        aria-label={
          activeUnpinned()
            ? `Panels, showing ${activeUnpinned()?.title}`
            : "Panels"
        }
        aria-haspopup="dialog"
        aria-expanded={sheetOpen()}
        data-active={activeUnpinned() ? "" : undefined}
        onClick={() => setSheetOpen(true)}
      >
        <Show
          when={activeUnpinned()}
          fallback={<SquaresFourIcon class="size-5" aria-hidden />}
        >
          {(entry) => <PanelIcon entry={entry()} />}
        </Show>
        <span class="nf-compact-nav-label">
          {activeUnpinned()?.title ?? "Panels"}
        </span>
      </button>
      <CompactPanelSheet
        isOpen={sheetOpen()}
        panels={props.panels}
        onDismiss={() => setSheetOpen(false)}
      />
    </nav>
  );
}
