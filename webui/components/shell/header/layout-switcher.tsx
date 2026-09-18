// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { DotsThreeIcon } from "@squidlab/phosphor-solid/dots-three";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { createMemo, createSignal, For, onCleanup } from "solid-js";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { activateStoredLayout } from "../../../lib/layout-activation";
import {
  deleteNamedLayout,
  reorderLayouts,
  revertNamedLayout,
  saveNamedLayout,
  setLayoutShown,
} from "../../../lib/layout-management";
import {
  layoutStorageStore,
  type StoredPanelLayout,
} from "../../../lib/layoutStorage";
import { currentShowfileRevision } from "../../../lib/showfile-loading";
import { isTauriRuntime } from "../../../lib/tauri";
import { pushToast } from "../../../state/appStores";
import {
  activeLayoutId,
  busyLayoutIds,
  modifiedLayoutIds,
} from "../../../state/layout-switcher";
import { useAppShell } from "../../providers/app-shell";
import { DropdownMenu, DropdownMenuItem } from "../../ui/dropdown-menu";
import { ToggleToolbarButton } from "../../ui/toolbar-button";
import { Button } from "../../ui/visual-language/button";
import DeleteConfirmModal from "../../widgets/delete-confirm-dialog";
import "./layout-switcher.css";

/** Provides persistent layout shortcuts with independent working arrangements for this session. */
export default function LayoutSwitcher() {
  const { dockviewApi, showLayoutManager } = useAppShell();
  const storage = useStore(layoutStorageStore);
  /** Selects visible layouts in saved switcher order. */
  const slots = createMemo(() =>
    storage().layouts.filter((layout) => layout.shownInSwitcher),
  );
  const activeSlot = useStore(activeLayoutId);
  const busy = useStore(busyLayoutIds);
  const modified = useStore(modifiedLayoutIds);
  const [deleting, setDeleting] = createSignal<StoredPanelLayout | null>(null);
  const [draggedSlot, setDraggedSlot] = createSignal<{
    id: string;
    revision: number;
  }>();
  const [dropTarget, setDropTarget] = createSignal<{
    id: string;
    side: "before" | "after";
  }>();
  const [previewSlots, setPreviewSlots] = createSignal<StoredPanelLayout[]>();
  const slotElements = new Map<string, HTMLDivElement>();
  /** Uses a temporary drag order until the backend accepts or rejects the drop. */
  const displayedSlots = createMemo(() => previewSlots() ?? slots());

  /** Animates existing slot elements from their current visual positions into a new order. */
  const animateOrder = (next: StoredPanelLayout[] | undefined) => {
    const previous = new Map(
      [...slotElements].map(([id, element]) => [
        id,
        element.getBoundingClientRect().left,
      ]),
    );
    for (const element of slotElements.values()) {
      for (const animation of element.getAnimations()) animation.cancel();
    }
    setPreviewSlots(next);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const [id, element] of slotElements) {
      const before = previous.get(id);
      if (before === undefined) continue;
      const distance = before - element.getBoundingClientRect().left;
      if (Math.abs(distance) < 1) continue;
      element.animate(
        [
          { transform: `translateX(${distance}px)` },
          { transform: "translateX(0)" },
        ],
        {
          duration: 180,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        },
      );
    }
  };
  /** Clears the insertion marker after a completed or canceled drag. */
  const clearDrag = () => {
    setDraggedSlot(undefined);
    setDropTarget(undefined);
    animateOrder(undefined);
  };
  /** Allows only drags originating in this switcher and the current showfile. */
  const canDrop = () => {
    const source = draggedSlot();
    return !!source && source.revision === currentShowfileRevision.get();
  };
  /** Resolves the insertion edge from the pointer's position within the destination slot. */
  const resolveDropTarget = (
    id: string,
    event: DragEvent & { currentTarget: HTMLDivElement },
  ) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      id,
      side: event.clientX < bounds.left + bounds.width / 2 ? "before" : "after",
    } as const;
  };
  /** Slides neighboring slots aside to preview the destination before anything is saved. */
  const previewDrop = (
    id: string,
    event: DragEvent & { currentTarget: HTMLDivElement },
  ) => {
    const sourceId = draggedSlot()?.id;
    if (!sourceId || sourceId === id) return;
    const target = resolveDropTarget(id, event);
    if (dropTarget()?.id === id && dropTarget()?.side === target.side) return;
    setDropTarget(target);
    const current = displayedSlots();
    const source = current.find((slot) => slot.id === sourceId);
    if (!source) return;
    const next = current.filter((slot) => slot.id !== sourceId);
    const targetIndex = next.findIndex((slot) => slot.id === id);
    if (targetIndex < 0) return;
    next.splice(targetIndex + (target.side === "after" ? 1 : 0), 0, source);
    if (next.every((slot, index) => slot.id === current[index].id)) return;
    animateOrder(next);
  };
  /** Persists the preview order while keeping the active workspace and panel instances intact. */
  const dropSlot = (event: DragEvent) => {
    if (!canDrop()) {
      clearDrag();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const next = displayedSlots().slice();
    setDraggedSlot(undefined);
    setDropTarget(undefined);
    if (next.every((slot, index) => slot.id === slots()[index]?.id)) {
      animateOrder(undefined);
      return;
    }
    void reorderLayouts(next.map((layout) => layout.id)).finally(() =>
      animateOrder(undefined),
    );
  };
  /** Activates the layout's retained working arrangement. */
  const recall = async (layout: { id: string }) => {
    const api = dockviewApi();
    if (!api || busy().includes(layout.id)) return;
    if (!(await activateStoredLayout(api, layout.id)))
      pushToast("error", "Could not load layout.");
  };

  for (let index = 0; index < 10; index += 1) {
    useKeyboardShortcut(
      {
        key: isTauriRuntime() ? `$mod+${(index + 1) % 10}` : `F${index + 1}`,
        description: `Switch to layout ${index + 1}`,
        group: "Layouts",
        /** Recalls the current assignment at this position without resetting its working copy. */
        handler: () => {
          const slot = slots()[index];
          if (!slot || busy().includes(slot.id)) return;
          void recall(slot);
        },
      },
      { global: true, capture: true },
    );
  }

  return (
    <>
      <div
        class="flex min-w-0 items-center gap-1"
        role="group"
        aria-label="Layout switcher"
      >
        <div class="flex min-w-0 items-center gap-1 overflow-x-auto py-1">
          <For each={displayedSlots().map((layout) => layout.id)}>
            {(id, index) => {
              const slot = { id };
              let slotElement: HTMLDivElement | undefined;
              /** Releases element references and in-flight motion when a slot disappears. */
              onCleanup(() => {
                if (slotElements.get(slot.id) === slotElement)
                  slotElements.delete(slot.id);
                for (const animation of slotElement?.getAnimations() ?? [])
                  animation.cancel();
              });
              /** Resolves current saved-layout labels, without remounting the switcher entry. */
              const layout = () =>
                storage().layouts.find((entry) => entry.id === slot.id);
              return (
                <div
                  ref={(element) => {
                    slotElement = element;
                    slotElements.set(slot.id, element);
                  }}
                  class="nf-layout-slot"
                  data-active={activeSlot() === slot.id}
                  data-modified={modified().includes(slot.id)}
                  data-dragging={draggedSlot()?.id === slot.id}
                  data-drop-side={
                    dropTarget()?.id === slot.id
                      ? dropTarget()?.side
                      : undefined
                  }
                  onDragOver={(event) => {
                    if (!canDrop()) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.dataTransfer)
                      event.dataTransfer.dropEffect = "move";
                    previewDrop(slot.id, event);
                  }}
                  onDragLeave={(event) => {
                    if (
                      !(event.relatedTarget instanceof Node) ||
                      !event.currentTarget.contains(event.relatedTarget)
                    )
                      setDropTarget(undefined);
                  }}
                  onDrop={dropSlot}
                >
                  <ToggleToolbarButton
                    size="labeled"
                    class="nf-layout-slot-trigger"
                    pressed={activeSlot() === slot.id}
                    label={`Layout ${index() + 1}: ${layout()?.name ?? "Layout"}`}
                    tooltip={`${layout()?.name ?? "Layout"}${modified().includes(slot.id) ? " (modified)" : ""} — drag to reorder`}
                    draggable={!busy().includes(slot.id)}
                    onDragStart={(event) => {
                      if (busy().includes(slot.id)) {
                        event.preventDefault();
                        return;
                      }
                      setDraggedSlot({
                        id: slot.id,
                        revision: currentShowfileRevision.get(),
                      });
                      event.dataTransfer?.setData(
                        "application/x-nightfall-layout-slot",
                        slot.id,
                      );
                      if (event.dataTransfer)
                        event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={clearDrag}
                    disabled={!dockviewApi() || busy().includes(slot.id)}
                    onClick={() => recall(slot)}
                  >
                    <span class="text-xs opacity-60">{index() + 1}</span>
                    <span class="truncate">{layout()?.name ?? "Layout"}</span>
                    <span
                      class="nf-layout-modified"
                      role="img"
                      aria-label={
                        modified().includes(slot.id) ? "Modified" : undefined
                      }
                    >
                      •
                    </span>
                  </ToggleToolbarButton>
                  <DropdownMenu
                    trigger={<DotsThreeIcon class="size-5" aria-hidden />}
                    triggerLabel={`Options for layout ${index() + 1}`}
                    triggerClass="nf-layout-slot-menu"
                    triggerDisabled={busy().includes(slot.id)}
                    placement="below"
                    align="end"
                  >
                    <DropdownMenuItem
                      disabled={!dockviewApi() || busy().includes(slot.id)}
                      onClick={() => saveNamedLayout(dockviewApi()!, slot.id)}
                    >
                      Save
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!dockviewApi() || busy().includes(slot.id)}
                      onClick={() => revertNamedLayout(dockviewApi()!, slot.id)}
                    >
                      Revert
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={activeSlot() === slot.id}
                      onClick={() => setLayoutShown(slot.id, false)}
                    >
                      Hide from switcher
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={activeSlot() === slot.id}
                      onClick={() => setDeleting(layout() ?? null)}
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenu>
                </div>
              );
            }}
          </For>
        </div>
        <Button
          size="icon"
          variant="subtle"
          class="nf-layout-slot-add shrink-0"
          aria-label="Manage layouts"
          title="Manage layouts"
          onClick={showLayoutManager}
        >
          <PlusIcon class="size-4" aria-hidden />
        </Button>
      </div>
      <DeleteConfirmModal
        isOpen={deleting() !== null}
        title="Delete Layout"
        message={`Delete "${deleting()?.name}"?`}
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const layout = deleting();
          if (layout && (await deleteNamedLayout(layout.id))) setDeleting(null);
        }}
      />
    </>
  );
}
