// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import { ArrowsInIcon } from "@squidlab/phosphor-solid/arrows-in";
import { ArrowsOutIcon } from "@squidlab/phosphor-solid/arrows-out";
import { XIcon } from "@squidlab/phosphor-solid/x";
import type { GroupPanelPartInitParameters, ITabRenderer } from "dockview";
import { getComponentRegistration } from "../../../../lib/panel-registry";
import {
  type PanelTabStatus,
  subscribePanelTabStatus,
} from "../../../../lib/panel-tab-status";
import { openContextMenu } from "../../../providers/context-menu";
import { type AppIcon, renderIconComponent } from "../../../ui/icon";

/** Dockview tab showing the panel's registered icon, title, close action, and context menu. */
export class IconTabRenderer implements ITabRenderer {
  private readonly _element: HTMLElement;
  private readonly _content: HTMLDivElement;
  private readonly _icon: HTMLSpanElement;
  private readonly _label: HTMLSpanElement;
  private readonly _action: HTMLDivElement;
  private readonly _closeIcon: HTMLSpanElement;
  private _title = "";
  private _iconComponent: AppIcon | undefined;
  private _status: PanelTabStatus | undefined;
  private _onDidTitleChange?: { dispose: () => void };
  private _removeStatusSubscription?: () => void;
  private _removePointerDown?: () => void;
  private _removeClick?: () => void;
  private _removeContextMenu?: () => void;

  /** Creates a tab using the component registrations of its own workspace. */
  constructor(private panelComponentById: Map<string, string>) {
    this._element = document.createElement("div");
    this._element.className = "dv-default-tab";

    this._content = document.createElement("div");
    this._content.className = "dv-default-tab-content";
    this._content.style.display = "inline-flex";
    this._content.style.alignItems = "center";
    this._content.style.gap = "6px";

    this._icon = document.createElement("span");
    this._icon.setAttribute("aria-hidden", "true");
    this._icon.style.width = "14px";
    this._icon.style.height = "14px";
    this._icon.style.display = "inline-block";
    this._icon.style.flexShrink = "0";

    this._label = document.createElement("span");
    this._label.style.overflow = "hidden";
    this._label.style.textOverflow = "ellipsis";

    this._action = document.createElement("div");
    this._action.className = "dv-default-tab-action";
    this._closeIcon = document.createElement("span");
    this._closeIcon.setAttribute("aria-hidden", "true");
    this._closeIcon.style.width = "14px";
    this._closeIcon.style.height = "14px";
    this._closeIcon.style.display = "inline-block";
    this._action.appendChild(this._closeIcon);
    renderIconComponent(this._closeIcon, XIcon, "size-3.5");

    this._content.appendChild(this._icon);
    this._content.appendChild(this._label);
    this._element.appendChild(this._content);
    this._element.appendChild(this._action);
    this.render();
  }

  /** The element Dockview places in the group's tab strip. */
  get element(): HTMLElement {
    return this._element;
  }

  /**
   * Resolves the panel's icon from its component registration and subscribes
   * to title and tab-status changes, the close action, and the tab context menu.
   */
  init(parameters: GroupPanelPartInitParameters): void {
    this._title = parameters.title ?? "";
    this._element.dataset.dockviewPanelId = parameters.api.id;
    const componentName =
      this.panelComponentById.get(parameters.api.id) ??
      parameters.containerApi.getPanel(parameters.api.id)?.view
        .contentComponent;
    this._iconComponent = componentName
      ? getComponentRegistration(componentName)?.icon
      : undefined;

    this._onDidTitleChange = parameters.api.onDidTitleChange((event) => {
      this._title = event.title ?? "";
      this.render();
    });
    this._removeStatusSubscription = subscribePanelTabStatus(
      parameters.api.id,
      (status) => {
        this._status = status;
        this.render();
      },
    );
    /** Keeps the close action from starting a tab drag or focus change. */
    const onPointerDown = (event: PointerEvent) => {
      event.preventDefault();
    };
    this._action.addEventListener("pointerdown", onPointerDown);
    this._removePointerDown = () => {
      this._action.removeEventListener("pointerdown", onPointerDown);
    };

    /** Closes the panel unless another handler already consumed the click. */
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      parameters.api.close();
    };
    this._action.addEventListener("click", onClick);
    this._removeClick = () => {
      this._action.removeEventListener("click", onClick);
    };

    /** Activates the panel and opens its close and maximize menu at the pointer. */
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      parameters.api.setActive();

      const panelsInGroup = () => [...parameters.api.group.panels];
      openContextMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          {
            id: "close",
            label: "Close",
            icon: XIcon,
            onSelect: () => parameters.api.close(),
          },
          {
            id: "close-others",
            label: "Close Others in Group",
            disabled: panelsInGroup().length <= 1,
            onSelect: () => {
              for (const panel of panelsInGroup()) {
                if (panel.api.id !== parameters.api.id) {
                  panel.api.close();
                }
              }
            },
          },
          {
            id: "close-group",
            label: "Close All in Group",
            onSelect: () => {
              for (const panel of panelsInGroup()) {
                panel.api.close();
              }
            },
          },
          { id: "dock-tab-separator", type: "separator" },
          {
            id: "maximize",
            label: parameters.api.isMaximized()
              ? "Restore Group"
              : "Maximize Group",
            icon: parameters.api.isMaximized() ? ArrowsInIcon : ArrowsOutIcon,
            onSelect: () => {
              if (parameters.api.isMaximized()) {
                parameters.api.exitMaximized();
              } else {
                parameters.api.maximize();
              }
            },
          },
        ],
      });
    };
    this._element.addEventListener("contextmenu", onContextMenu);
    this._removeContextMenu = () => {
      this._element.removeEventListener("contextmenu", onContextMenu);
    };

    this.render();
  }

  /** Releases the title, status, and DOM listeners and clears the rendered icon. */
  dispose(): void {
    this._onDidTitleChange?.dispose();
    this._onDidTitleChange = undefined;
    this._removeStatusSubscription?.();
    this._removeStatusSubscription = undefined;
    this._removePointerDown?.();
    this._removePointerDown = undefined;
    this._removeClick?.();
    this._removeClick = undefined;
    this._removeContextMenu?.();
    this._removeContextMenu = undefined;
    renderIconComponent(this._icon, undefined, "size-3.5");
  }

  /** Renders the registered panel icon or its transient activity replacement. */
  private render(): void {
    if (this._label.textContent !== this._title) {
      this._label.textContent = this._title;
    }
    this._element.setAttribute(
      "aria-label",
      this._status === "saving" ? `${this._title}, saving` : this._title,
    );
    if (this._status) this._icon.dataset.panelTabStatus = this._status;
    else delete this._icon.dataset.panelTabStatus;

    const iconComponent =
      this._status === "saving" ? ArrowsClockwiseIcon : this._iconComponent;
    if (iconComponent) {
      renderIconComponent(
        this._icon,
        iconComponent,
        this._status === "saving" ? "size-3.5 animate-spin" : "size-3.5",
      );
      this._icon.style.display = "inline-block";
    } else {
      renderIconComponent(this._icon, undefined, "size-3.5");
      this._icon.style.display = "none";
    }
  }
}
