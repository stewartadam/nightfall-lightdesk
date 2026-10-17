// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { GroupPanelPartInitParameters, IContentRenderer } from "dockview";
import type { ParentComponent, Setter } from "solid-js";
import type { BasePanelComponentProps } from "../../../../lib/panel-registry";
import { backgroundPanelMounts } from "./background-panel-mounts";
import { bindPanelAppearance } from "./panel-appearance";

export type SolidComponentType = ParentComponent<BasePanelComponentProps>;

/** A panel component queued for rendering through a portal in the workspace's Solid root. */
export interface PortalEntry {
  portalEntryId: number;
  id: string;
  component: SolidComponentType;
  props: object;
  /** The panel's scroll viewport, which the component renders into. */
  mount: HTMLElement;
  /** Wraps `mount` so scroll edge indicators can overlay it without scrolling with it. */
  scrollFrame: HTMLElement;
}

let nextPortalEntryId = 0;

/**
 * Direct renderer for SolidJS components
 */
export class SolidRenderer implements IContentRenderer {
  private id?: string;
  private portalEntryId?: number;
  private readonly _container: HTMLElement;
  private readonly _renderRoot: HTMLElement;
  private component: SolidComponentType;
  private panelAppearance?: ReturnType<typeof bindPanelAppearance>;
  /** Visibility subscription held until the panel content mounts. */
  private pendingMount?: { dispose: () => void };
  /** Removes this panel from the background mount queue. */
  private cancelBackgroundMount?: () => void;

  /** Binds renderer ownership to one workspace rather than the app-wide panel ID. */
  constructor(
    component: SolidComponentType,
    private setPortals: Setter<PortalEntry[]>,
    private panelComponentById: Map<string, string>,
  ) {
    this.component = component;

    this._container = document.createElement("div");
    this._container.className = "nf-scroll-area h-full grid-cols-1 grid-rows-1";

    this._renderRoot = document.createElement("div");
    this._renderRoot.className = "nf-scroll-viewport h-full";

    this._container.appendChild(this._renderRoot);
  }

  /** The element Dockview attaches as the panel's content. */
  get element(): HTMLElement {
    return this._container;
  }

  /**
   * Keeps panel appearance tied to Dockview's active panel and mounts the panel
   * content. Visible panels mount right away; background tabs and collapsed
   * edge panels mount later in the background, one per idle period, so
   * restoring a large layout shows the visible panels first. A hidden panel
   * that is opened before its turn mounts immediately.
   */
  init(parameters: GroupPanelPartInitParameters): void {
    this.panelAppearance = bindPanelAppearance(this._container, parameters.api);
    // Track panel identity
    this.id = parameters.api.id;
    const visibility = parameters.api.onDidVisibilityChange((event) => {
      if (event.isVisible) this.mountOnce(parameters);
    });
    this.pendingMount = visibility;
    // Dockview reports every panel visible while it builds a group and hides
    // background tabs once the whole layout is restored, so decide afterwards.
    queueMicrotask(() => {
      if (!this.pendingMount) return;
      if (parameters.api.isVisible) {
        this.mountOnce(parameters);
        return;
      }
      this.cancelBackgroundMount = backgroundPanelMounts.schedule(() => {
        this.cancelBackgroundMount = undefined;
        this.mountOnce(parameters);
      });
    });
  }

  /** Mounts the panel content unless it is already mounted or disposed. */
  private mountOnce(parameters: GroupPanelPartInitParameters): void {
    if (!this.pendingMount) return;
    this.pendingMount.dispose();
    this.pendingMount = undefined;
    this.cancelBackgroundMount?.();
    this.cancelBackgroundMount = undefined;
    this.mount(parameters);
  }

  /** Queues a portal that renders the panel component into this renderer's root. */
  private mount(parameters: GroupPanelPartInitParameters): void {
    const portalEntryId = nextPortalEntryId++;
    this.portalEntryId = portalEntryId;
    // Queue up a portal into the main root, converting the parameters passed to the panel component into props
    this.setPortals((prev) => [
      ...prev,
      {
        portalEntryId,
        id: parameters.api.id,
        component: this.component,
        props: {
          id: parameters.api.id,
          initialPanelId: parameters.api.id,
          panelApi: parameters.api,
          ...parameters.params,
        },
        mount: this._renderRoot,
        scrollFrame: this._container,
      },
    ]);
  }

  /** Releases the appearance subscription and removes the panel's Solid portal. */
  dispose(): void {
    this.panelAppearance?.dispose();
    this.pendingMount?.dispose();
    this.pendingMount = undefined;
    this.cancelBackgroundMount?.();
    this.cancelBackgroundMount = undefined;
    // Remove this panel's portal entry
    if (this.id && this.portalEntryId !== undefined) {
      const portalEntryId = this.portalEntryId;
      this.panelComponentById.delete(this.id);
      this.setPortals((prev) =>
        prev.filter((p) => p.portalEntryId !== portalEntryId),
      );
    }
  }
}
