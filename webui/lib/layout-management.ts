// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi } from "dockview";
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

/** Queues edits in order without locking unrelated controls or losing concurrent list changes. */
export function editLayouts(
  edit: (layouts: StoredPanelLayout[]) => StoredPanelLayout[] | null,
  ids: string[] = [],
): Promise<boolean> {
  const revision = currentShowfileRevision.get();
  pendingEdits += 1;
  for (const id of ids) pendingById.set(id, (pendingById.get(id) ?? 0) + 1);
  busyLayoutIds.set([...pendingById.keys()]);
  layoutEditPending.set(true);
  const result = editQueue.then(() => persistLayouts(edit, revision));
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

/** Commits one queued edit against the latest list and rejects completions from another showfile. */
async function persistLayouts(
  edit: (layouts: StoredPanelLayout[]) => StoredPanelLayout[] | null,
  revision: number,
): Promise<boolean> {
  if (revision !== currentShowfileRevision.get()) return false;
  const layouts = edit(getShowfilePanelLayouts());
  if (!layouts) return false;
  const active = activeLayoutId.get();
  if (
    active &&
    !layouts.some((layout) => layout.id === active && layout.shownInSwitcher)
  )
    return false;
  if (new Set(layouts.map((layout) => layout.id)).size !== layouts.length)
    return false;
  try {
    const result = await engineRuntime.sendCommandAndAwait({
      module: "SettingsCommand",
      command: { type: "SetPanelLayouts", data: layouts },
    });
    if (result.outcome.type === "Failed")
      throw new Error(result.outcome.data.message);
    if (currentShowfileRevision.get() !== revision) return false;
    replaceStoredLayoutsFromShowfile(layouts);
    reconcileLayoutSessions(layouts.map((layout) => layout.id));
    return true;
  } catch (error) {
    log.error("Could not save layouts", error);
    pushToast("error", "Could not save layouts. Check your connection.");
    return false;
  }
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
  return (await editLayouts((layouts) => [...layouts, layout], [layout.id]))
    ? layout
    : null;
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
  const saved = await editLayouts(
    (layouts) =>
      layouts.map((layout) =>
        layout.id === id
          ? { ...layout, ...snapshotFields(snapshot), updatedAt: Date.now() }
          : layout,
      ),
    [id],
  );
  if (saved) acknowledgeLayoutResize(id, resizeRevision, snapshot);
  return saved;
}

/** Copies only arrangement fields so saving cannot replace a layout's identity or visibility. */
function snapshotFields(layout: SerializedLayout): SerializedLayout {
  return {
    version: layout.version,
    layout: layout.layout,
    panels: layout.panels,
  };
}

/** Shows or hides a saved layout while protecting the active workspace. */
export function setLayoutShown(id: string, shown: boolean): Promise<boolean> {
  return editLayouts(
    (layouts) =>
      layouts.map((layout) =>
        layout.id === id ? { ...layout, shownInSwitcher: shown } : layout,
      ),
    [id],
  );
}

/** Removes an inactive saved layout and its retained working arrangement. */
export function deleteNamedLayout(id: string): Promise<boolean> {
  return editLayouts(
    (layouts) => layouts.filter((layout) => layout.id !== id),
    [id],
  );
}

/** Renames a layout without altering its saved or working arrangement. */
export function renameNamedLayout(id: string, name: string): Promise<boolean> {
  if (!name.trim()) return Promise.resolve(false);
  return editLayouts(
    (layouts) =>
      layouts.map((layout) =>
        layout.id === id
          ? { ...layout, name: name.trim(), updatedAt: Date.now() }
          : layout,
      ),
    [id],
  );
}

/** Duplicates a saved snapshot as a visible independent layout without activating it. */
export function duplicateNamedLayout(
  id: string,
  name: string,
): Promise<boolean> {
  return editLayouts(
    (layouts) => {
      const source = layouts.find((layout) => layout.id === id);
      if (!source) return null;
      return [
        ...layouts,
        {
          ...source,
          id: crypto.randomUUID(),
          name,
          shownInSwitcher: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];
    },
    [id],
  );
}

/** Reorders visible layouts in place while preserving hidden layouts and working arrangements. */
export function reorderLayouts(ids: string[]): Promise<boolean> {
  return editLayouts((layouts) => {
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
    return activateStoredLayout(api, preferred.id, { adoptCurrent: true });
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
