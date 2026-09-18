// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { CheckIcon } from "@squidlab/phosphor-solid/check";
import { CopySimpleIcon } from "@squidlab/phosphor-solid/copy-simple";
import { FileArrowDownIcon } from "@squidlab/phosphor-solid/file-arrow-down";
import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { XIcon } from "@squidlab/phosphor-solid/x";
import { createMemo, createSignal, For, Show } from "solid-js";
import {
  createNamedLayout,
  deleteNamedLayout,
  duplicateNamedLayout,
  renameNamedLayout,
  saveNamedLayout,
  setLayoutShown,
} from "../../../lib/layout-management";
import {
  layoutStorageStore,
  type StoredPanelLayout,
} from "../../../lib/layoutStorage";
import { pushToast } from "../../../state/appStores";
import {
  activeLayoutId as activeLayoutStore,
  busyLayoutIds,
} from "../../../state/layout-switcher";
import { useAppShell } from "../../providers/app-shell";
import {
  DialogBackdrop,
  DialogBody,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../../ui/dialog";
import { Checkbox, Input } from "../../ui/form-controls";
import Modal from "../../ui/modal";
import { ScrollArea } from "../../ui/scroll-area";
import Tooltip from "../../ui/tooltip";
import { Button } from "../../ui/visual-language/button";
import DeleteConfirmModal from "../../widgets/delete-confirm-dialog";

interface LayoutManagerProps {
  isOpen: boolean;
  onClose: () => void;
}

type ConfirmAction = { type: "delete"; layout: StoredPanelLayout };

/** Formats the saved layout timestamp for its summary row. */
function formatUpdatedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/** Chooses an unused display name when duplicating a stored layout. */
function nextCopyName(
  sourceName: string,
  layouts: StoredPanelLayout[],
): string {
  const names = new Set(layouts.map((layout) => layout.name));
  const base = `${sourceName} Copy`;
  if (!names.has(base)) {
    return base;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }

  return `${base} ${Date.now()}`;
}

/** Manages saved layouts, switcher visibility, and names without changing the active workspace. */
export default function LayoutManager(props: LayoutManagerProps) {
  const { dockviewApi } = useAppShell();
  const layoutStorage = useStore(layoutStorageStore);
  /** Returns the stored layouts in the display order used by the manager. */
  const layouts = createMemo(() =>
    layoutStorage()
      .layouts.slice()
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  /** Returns the currently loaded named layout id from persistent storage. */
  const activeLayoutId = useStore(activeLayoutStore);
  const busy = useStore(busyLayoutIds);
  const [creating, setCreating] = createSignal(false);
  const [newLayoutName, setNewLayoutName] = createSignal("");
  const [editingLayoutId, setEditingLayoutId] = createSignal<string | null>(
    null,
  );
  const [editingLayoutName, setEditingLayoutName] = createSignal("");
  const [confirmAction, setConfirmAction] = createSignal<ConfirmAction | null>(
    null,
  );

  /** Creates a named snapshot or blank layout and leaves activation to the switcher. */
  const handleStoreCurrentLayout = async (blank = false) => {
    const api = dockviewApi();
    if (!api || creating()) return;
    const name = newLayoutName().trim();
    if (!name) {
      pushToast("warning", "Enter a layout name.");
      return;
    }
    setCreating(true);
    try {
      if (await createNamedLayout(api, name, blank)) setNewLayoutName("");
    } finally {
      setCreating(false);
    }
  };

  /** Duplicates the saved snapshot with an unused name. */
  const handleDuplicateLayout = (layout: StoredPanelLayout) =>
    duplicateNamedLayout(layout.id, nextCopyName(layout.name, layouts()));

  /** Begins inline editing of a layout name. */
  const startRenameLayout = (layout: StoredPanelLayout) => {
    setEditingLayoutId(layout.id);
    setEditingLayoutName(layout.name);
  };

  /** Discards the pending name edit. */
  const cancelRenameLayout = () => {
    setEditingLayoutId(null);
    setEditingLayoutName("");
  };

  /** Persists the edited name before closing its editor. */
  const commitRenameLayout = async (layout: StoredPanelLayout) => {
    if (await renameNamedLayout(layout.id, editingLayoutName()))
      cancelRenameLayout();
  };

  /** Applies a confirmed deletion without allowing the active layout to be removed. */
  const handleConfirmAction = async () => {
    const action = confirmAction();
    if (action && (await deleteNamedLayout(action.layout.id)))
      setConfirmAction(null);
  };

  return (
    <>
      <Modal isOpen={props.isOpen} onEscape={props.onClose}>
        <DialogBackdrop
          class="nightfall-top-layer"
          role="dialog"
          aria-modal="true"
          aria-label="Manage layouts"
        >
          <DialogSurface style={{ "max-width": "768px" }}>
            <DialogHeader>
              <DialogTitle>Layouts</DialogTitle>
              <Tooltip content={() => "Close layouts"}>
                <Button
                  size="icon"
                  type="button"
                  class="items-center justify-center"
                  aria-label="Close layouts"
                  onClick={props.onClose}
                >
                  <XIcon class="size-5" aria-hidden />
                </Button>
              </Tooltip>
            </DialogHeader>
            <DialogBody scrollable={false} class="flex flex-col">
              <div class="shrink-0 pb-4">
                <form
                  class="flex flex-col gap-2 sm:flex-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleStoreCurrentLayout();
                  }}
                >
                  <Input
                    density="compact"
                    class="flex-1"
                    placeholder="Layout name"
                    value={newLayoutName()}
                    onInput={(event) =>
                      setNewLayoutName(event.currentTarget.value)
                    }
                  />
                  <Button
                    size="compact"
                    variant="primary"
                    type="submit"
                    disabled={creating() || !dockviewApi()}
                  >
                    <FileArrowDownIcon class="size-4" aria-hidden />
                    Save current as new
                  </Button>
                  <Button
                    size="compact"
                    type="button"
                    disabled={creating() || !dockviewApi()}
                    onClick={() => handleStoreCurrentLayout(true)}
                  >
                    New blank layout
                  </Button>
                </form>
                <p class="mt-2 text-xs text-neutral-400">
                  Select layouts in the switcher to activate them. Switch to
                  another layout before hiding or deleting the active one.
                </p>
              </div>

              <ScrollArea class="min-h-0">
                <Show
                  when={layouts().length > 0}
                  fallback={
                    <div class="py-12 text-center text-sm text-neutral-400">
                      No stored layouts
                    </div>
                  }
                >
                  <div class="divide-y divide-neutral-800 overflow-hidden rounded-md border border-neutral-800">
                    <For each={layouts().map((layout) => layout.id)}>
                      {(id) => {
                        /** Reads current metadata without replacing this row or its focused controls. */
                        const layout = () =>
                          layouts().find((layout) => layout.id === id)!;
                        /** Identifies the row whose name is currently being edited. */
                        const isEditing = () =>
                          editingLayoutId() === layout().id;

                        /** Identifies the layout currently applied to the workspace. */
                        const isActive = () => activeLayoutId() === layout().id;

                        return (
                          <div
                            data-layout-id={layout().id}
                            class="flex flex-wrap items-center justify-between gap-3 bg-neutral-950 px-3 py-3"
                          >
                            <div class="min-w-0">
                              <Show
                                when={isEditing()}
                                fallback={
                                  <>
                                    <div class="flex min-w-0 items-center gap-2">
                                      <span class="truncate text-sm font-medium text-neutral-100">
                                        {layout().name}
                                      </span>
                                      <Tooltip
                                        content={() =>
                                          `Rename ${layout().name}`
                                        }
                                      >
                                        <Button
                                          size="icon"
                                          type="button"
                                          class="shrink-0 items-center justify-center"
                                          disabled={busy().includes(
                                            layout().id,
                                          )}
                                          aria-label={`Rename ${layout().name}`}
                                          onClick={() =>
                                            startRenameLayout(layout())
                                          }
                                        >
                                          <PencilSimpleLineIcon
                                            class="size-4"
                                            aria-hidden
                                          />
                                        </Button>
                                      </Tooltip>
                                      <Show when={isActive()}>
                                        <span class="rounded bg-blue-500/20 px-1.5 py-0.5 text-xs text-blue-100">
                                          Active
                                        </span>
                                      </Show>
                                    </div>
                                    <div class="mt-1 text-xs text-neutral-500">
                                      Updated{" "}
                                      {formatUpdatedAt(layout().updatedAt)}
                                    </div>
                                  </>
                                }
                              >
                                <form
                                  class="flex gap-2"
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    commitRenameLayout(layout());
                                  }}
                                >
                                  <Input
                                    density="compact"
                                    class="min-w-0 flex-1"
                                    value={editingLayoutName()}
                                    onInput={(event) =>
                                      setEditingLayoutName(
                                        event.currentTarget.value,
                                      )
                                    }
                                  />
                                  <Tooltip content={() => "Save layout name"}>
                                    <Button
                                      size="icon"
                                      type="submit"
                                      class="items-center justify-center"
                                      aria-label="Save layout name"
                                    >
                                      <CheckIcon class="size-4" aria-hidden />
                                    </Button>
                                  </Tooltip>
                                  <Tooltip content={() => "Cancel rename"}>
                                    <Button
                                      size="icon"
                                      type="button"
                                      class="items-center justify-center"
                                      aria-label="Cancel rename"
                                      onClick={cancelRenameLayout}
                                    >
                                      <XIcon class="size-4" aria-hidden />
                                    </Button>
                                  </Tooltip>
                                </form>
                              </Show>
                            </div>

                            <div class="flex items-center gap-1">
                              <label class="mr-2 flex items-center gap-2 text-xs">
                                <Checkbox
                                  aria-label={`Show ${layout().name} in switcher`}
                                  checked={layout().shownInSwitcher}
                                  disabled={
                                    busy().includes(layout().id) || isActive()
                                  }
                                  onChange={(event) =>
                                    setLayoutShown(
                                      layout().id,
                                      event.currentTarget.checked,
                                    )
                                  }
                                />
                                Show in switcher
                              </label>
                              <Tooltip content={() => `Save ${layout().name}`}>
                                <Button
                                  size="icon"
                                  disabled={
                                    busy().includes(layout().id) ||
                                    !dockviewApi()
                                  }
                                  aria-label={`Save ${layout().name}`}
                                  onClick={() =>
                                    saveNamedLayout(dockviewApi()!, layout().id)
                                  }
                                >
                                  <FileArrowDownIcon
                                    class="size-4"
                                    aria-hidden
                                  />
                                </Button>
                              </Tooltip>
                              <Tooltip
                                content={() => `Duplicate ${layout().name}`}
                              >
                                <Button
                                  size="icon"
                                  type="button"
                                  class="items-center justify-center"
                                  disabled={busy().includes(layout().id)}
                                  aria-label={`Duplicate ${layout().name}`}
                                  onClick={() =>
                                    handleDuplicateLayout(layout())
                                  }
                                >
                                  <CopySimpleIcon class="size-4" aria-hidden />
                                </Button>
                              </Tooltip>
                              <Tooltip
                                content={() => `Delete ${layout().name}`}
                              >
                                <Button
                                  size="icon"
                                  type="button"
                                  class="items-center justify-center"
                                  variant="danger"
                                  disabled={
                                    busy().includes(layout().id) || isActive()
                                  }
                                  aria-label={`Delete ${layout().name}`}
                                  onClick={() =>
                                    setConfirmAction({
                                      type: "delete",
                                      layout: layout(),
                                    })
                                  }
                                >
                                  <TrashIcon class="size-4" aria-hidden />
                                </Button>
                              </Tooltip>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </ScrollArea>
            </DialogBody>
          </DialogSurface>
        </DialogBackdrop>
      </Modal>

      <DeleteConfirmModal
        isOpen={confirmAction() !== null}
        title="Delete Layout"
        message={`Delete "${confirmAction()?.layout.name}"?`}
        confirmLabel="Delete"
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleConfirmAction}
      />
    </>
  );
}
