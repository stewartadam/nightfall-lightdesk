// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi } from "dockview";
import { v4 as uuidv4 } from "uuid";
import { pushToast } from "../state/appStores";
import {
  acknowledgeLayoutResize,
  activeLayoutId,
  busyLayoutIds,
  forgetLayoutSession,
  getLayoutResizeRevision,
  getLayoutSession,
  layoutEditPending,
  reconcileLayoutSessions,
} from "../state/layout-switcher";
import type * as types from "../types";
import {
  createSerializedLayout,
  type SerializedLayout,
} from "./dockview-layout";
import { engineRuntime } from "./engine-runtime";
import { activateStoredLayout } from "./layout-activation";
import {
  createBlankStoredLayout,
  getShowfilePanelLayouts,
  getStoredLayout,
  replaceStoredLayoutsFromShowfile,
  type StoredPanelLayout,
} from "./layoutStorage";
import { getLogger } from "./logger";
import { currentShowfileRevision } from "./showfile-loading";

const log = getLogger(import.meta.url);

let editQueue: Promise<unknown> = Promise.resolve();
let pendingEdits = 0;
const pendingById = new Map<string, number>();

/** Restores the active saved snapshot or discards an inactive working copy without selecting it. */
export async function revertNamedLayout(
  api: DockviewApi,
  id: string,
): Promise<boolean> {
  if (!getStoredLayout(id) || busyLayoutIds.get().includes(id)) return false;
  if (activeLayoutId.get() !== id) {
    forgetLayoutSession(id);
    return true;
  }
  const restored = await activateStoredLayout(api, id, { reset: true });
  if (!restored) pushToast("error", "Could not revert layout.");
  return restored;
}

/**
 * One change to the showfile's shared layouts: the backend command that makes
 * it, and the same change applied to a local list so this device can check it
 * first and show it before the next settings snapshot arrives.
 */
interface LayoutEdit {
  command: types.SettingsCommand;
  apply: (layouts: StoredPanelLayout[]) => StoredPanelLayout[] | null;
}

/** Queues edits in order without locking unrelated controls. */
function editLayouts(edit: LayoutEdit, ids: string[] = []): Promise<boolean> {
  const revision = currentShowfileRevision.get();
  pendingEdits += 1;
  for (const id of ids) pendingById.set(id, (pendingById.get(id) ?? 0) + 1);
  busyLayoutIds.set([...pendingById.keys()]);
  layoutEditPending.set(true);
  const result = editQueue.then(() => persistLayoutEdit(edit, revision));
  editQueue = result.catch(() => false);
  return result.finally(() => {
    pendingEdits -= 1;
    for (const id of ids) {
      const count = pendingById.get(id)! - 1;
      if (count) pendingById.set(id, count);
      else pendingById.delete(id);
    }
    busyLayoutIds.set([...pendingById.keys()]);
    layoutEditPending.set(pendingEdits > 0);
  });
}

/**
 * Sends one queued edit after checking it against the latest list, and rejects
 * completions from another showfile. The check keeps this device's active
 * layout shown; other devices' active layouts are theirs to protect.
 */
async function persistLayoutEdit(
  edit: LayoutEdit,
  revision: number,
): Promise<boolean> {
  if (revision !== currentShowfileRevision.get()) return false;
  const layouts = edit.apply(getShowfilePanelLayouts());
  if (!layouts) return false;
  const active = activeLayoutId.get();
  if (
    active &&
    !layouts.some((layout) => layout.id === active && layout.shownInSwitcher)
  )
    return false;
  try {
    const result = await engineRuntime.sendCommandAndAwait({
      module: "SettingsCommand",
      command: edit.command,
    });
    if (result.outcome.type === "Failed") {
      log.warn("Layout edit refused", result.outcome.data);
      pushToast("error", result.outcome.data.message);
      return false;
    }
    if (currentShowfileRevision.get() !== revision) return false;
    const next = edit.apply(getShowfilePanelLayouts());
    if (next) {
      replaceStoredLayoutsFromShowfile(next);
      reconcileLayoutSessions(next.map((layout) => layout.id));
    }
    return true;
  } catch (error) {
    log.error("Could not save layouts", error);
    pushToast("error", "Could not save layouts. Check your connection.");
    return false;
  }
}

/** Applies a change to one layout in a local list, or refuses when another device removed it. */
function updateLayout(
  id: string,
  change: (layout: StoredPanelLayout) => StoredPanelLayout,
): (layouts: StoredPanelLayout[]) => StoredPanelLayout[] | null {
  return (layouts) =>
    layouts.some((layout) => layout.id === id)
      ? layouts.map((layout) => (layout.id === id ? change(layout) : layout))
      : null;
}

/** Creates a visible saved layout without changing the currently mounted arrangement. */
export async function createNamedLayout(
  api: DockviewApi,
  name: string,
  blank = false,
): Promise<StoredPanelLayout | null> {
  const normalized = name.trim();
  if (!normalized) return null;
  const layout = createBlankStoredLayout(api);
  if (!blank) Object.assign(layout, createSerializedLayout(api));
  layout.name = normalized;
  return (await addStoredLayout(layout)) ? layout : null;
}

/** Adds a fully built layout to the end of the showfile's shared list. */
export function addStoredLayout(
  layout: StoredPanelLayout,
  busyIds: string[] = [layout.id],
): Promise<boolean> {
  return editLayouts(
    {
      command: { type: "CreatePanelLayout", data: wireLayout(layout) },
      apply: (layouts) =>
        layouts.some((existing) => existing.id === layout.id)
          ? null
          : [...layouts, layout],
    },
    busyIds,
  );
}

/** Saves the selected layout's own working arrangement, including inactive retained workspaces. */
export async function saveNamedLayout(
  api: DockviewApi,
  id: string,
): Promise<boolean> {
  const snapshot =
    activeLayoutId.get() === id
      ? createSerializedLayout(api)
      : (getLayoutSession(id) ?? getStoredLayout(id));
  if (!snapshot) return false;
  const resizeRevision = getLayoutResizeRevision(id);
  const fields = snapshotFields(snapshot);
  const saved = await editLayouts(
    {
      command: {
        type: "SavePanelLayoutArrangement",
        data: { id, ...fields },
      },
      apply: updateLayout(id, (layout) => ({
        ...layout,
        ...fields,
        updatedAt: Date.now(),
      })),
    },
    [id],
  );
  if (saved) acknowledgeLayoutResize(id, resizeRevision, snapshot);
  return saved;
}

/** Copies only arrangement fields so saving cannot replace a layout's identity or visibility. */
function snapshotFields(
  layout: SerializedLayout,
): Omit<types.PanelLayoutArrangement, "id"> {
  return {
    version: layout.version,
    layout: layout.layout,
    panels: layout.panels.map((panel) => ({
      ...panel,
      params: panel.params ?? {},
    })),
  };
}

/** Converts a locally cached layout into the shape the backend stores. */
function wireLayout(layout: StoredPanelLayout): types.StoredPanelLayout {
  return { ...layout, ...snapshotFields(layout) };
}

/** Shows or hides a saved layout while protecting the active workspace. */
export function setLayoutShown(id: string, shown: boolean): Promise<boolean> {
  return editLayouts(
    {
      command: {
        type: "SetPanelLayoutVisibility",
        data: { id, shownInSwitcher: shown },
      },
      apply: updateLayout(id, (layout) => ({
        ...layout,
        shownInSwitcher: shown,
      })),
    },
    [id],
  );
}

/** Removes an inactive saved layout and its retained working arrangement. */
export function deleteNamedLayout(id: string): Promise<boolean> {
  return editLayouts(
    {
      command: { type: "DeletePanelLayout", data: id },
      apply: (layouts) =>
        layouts.some((layout) => layout.id === id)
          ? layouts.filter((layout) => layout.id !== id)
          : null,
    },
    [id],
  );
}

/** Renames a layout without altering its saved or working arrangement. */
export function renameNamedLayout(id: string, name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return Promise.resolve(false);
  return editLayouts(
    {
      command: { type: "RenamePanelLayout", data: { id, name: trimmed } },
      apply: updateLayout(id, (layout) => ({
        ...layout,
        name: trimmed,
        updatedAt: Date.now(),
      })),
    },
    [id],
  );
}

/** Makes a layout the one devices open when they have no arrangement for this showfile. */
export async function setDefaultLayout(id: string | null): Promise<boolean> {
  try {
    const result = await engineRuntime.sendCommandAndAwait({
      module: "SettingsCommand",
      command: { type: "SetDefaultPanelLayout", data: id ?? undefined },
    });
    if (result.outcome.type === "Failed")
      throw new Error(result.outcome.data.message);
    return true;
  } catch (error) {
    log.error("Could not set the default layout", error);
    pushToast("error", "Could not set the default layout.");
    return false;
  }
}

/** Duplicates a saved snapshot as a visible independent layout without activating it. */
export function duplicateNamedLayout(
  id: string,
  name: string,
): Promise<boolean> {
  const source = getStoredLayout(id);
  if (!source) return Promise.resolve(false);
  const copy: StoredPanelLayout = {
    ...source,
    id: uuidv4(),
    name,
    shownInSwitcher: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return addStoredLayout(copy, [id]);
}

/** Reorders visible layouts in place while preserving hidden layouts and working arrangements. */
export function reorderLayouts(ids: string[]): Promise<boolean> {
  return editLayouts({
    command: { type: "ReorderPanelLayouts", data: ids },
    apply: (layouts) => {
      const visible = layouts.filter((layout) => layout.shownInSwitcher);
      if (
        ids.length !== visible.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !visible.some((layout) => layout.id === id))
      )
        return null;
      const ordered = ids.map(
        (id) => visible.find((layout) => layout.id === id)!,
      );
      return layouts.map((layout) =>
        layout.shownInSwitcher ? ordered.shift()! : layout,
      );
    },
  });
}

/** Associates the restored workspace with a visible named layout, creating the initial layout if needed. */
export async function initializeNamedLayout(
  api: DockviewApi,
  preferredId?: string | null,
  hasRestoredArrangement = false,
): Promise<boolean> {
  const layouts = getShowfilePanelLayouts();
  const preferred = layouts.find((layout) => layout.id === preferredId);
  if (preferred) {
    if (
      !preferred.shownInSwitcher &&
      !(await setLayoutShown(preferred.id, true))
    )
      return false;
    return activateStoredLayout(api, preferred.id, {
      adoptCurrent: hasRestoredArrangement,
    });
  }
  if (layouts.length) {
    const next = layouts.find((layout) => layout.shownInSwitcher) ?? layouts[0];
    if (!next.shownInSwitcher && !(await setLayoutShown(next.id, true)))
      return false;
    return activateStoredLayout(api, next.id, {
      adoptCurrent: hasRestoredArrangement,
    });
  }
  const initial = await createNamedLayout(api, "Your Layout");
  return initial
    ? activateStoredLayout(api, initial.id, { adoptCurrent: true })
    : false;
}
