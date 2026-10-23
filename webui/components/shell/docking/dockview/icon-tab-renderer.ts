// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import { ArrowsInIcon } from "@squidlab/phosphor-solid/arrows-in";
import { ArrowsOutIcon } from "@squidlab/phosphor-solid/arrows-out";
import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { GearSixIcon } from "@squidlab/phosphor-solid/gear-six";
import { XIcon } from "@squidlab/phosphor-solid/x";
import type { GroupPanelPartInitParameters, ITabRenderer } from "dockview";
import { OPEN_PANEL_SETTINGS_CAPABILITY } from "../../../../lib/panel-capabilities";
import type { PanelCapabilityRegistry } from "../../../../lib/panel-capability-registry";
import { getComponentRegistration } from "../../../../lib/panel-registry";
import {
  type PanelTabStatus,
  subscribePanelTabStatus,
} from "../../../../lib/panel-tab-status";
import {
  type ContextMenuEntry,
  openContextMenu,
} from "../../../providers/context-menu";
import { type AppIcon, renderIconComponent } from "../../../ui/icon";

/** Devices without hover always show the caret on the active tab. */
const hoverlessQuery = "(hover: none)";

/**
 * Dockview tab showing the panel's registered icon, title, close action, and
 * tab menu. Hovering the active tab turns its icon into a caret that opens the
 * same menu as right-clicking the tab, led by the panel's settings when it has any.
 */
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
  private _removeTabMenu?: () => void;
  private _hovered = false;
  private _visible = false;
  private _hoverless: MediaQueryList | undefined;
  private _showCaret = false;

  /**
   * Creates a tab using the component registrations of its own workspace. The
   * capability registry, when given, lets panels put Settings… in the tab menu.
   */
  constructor(
    private panelComponentById: Map<string, string>,
    private capabilities?: Pick<
      PanelCapabilityRegistry,
      "getPanelCapabilityRegistrations" | "invokePanelCapability"
    >,
  ) {
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

    /** Builds the tab menu: the panel's settings when it offers them, then close and maximize. */
    const tabMenuItems = (): ContextMenuEntry[] => {
      /** Lists the panels sharing this tab's group when an action runs. */
      const panelsInGroup = () => [...parameters.api.group.panels];
      const capabilities = this.capabilities;
      const hasSettings =
        capabilities
          ?.getPanelCapabilityRegistrations(OPEN_PANEL_SETTINGS_CAPABILITY)
          .has(parameters.api.id) ?? false;
      return [
        ...(capabilities && hasSettings
          ? ([
              {
                id: "settings",
                label: "Settings…",
                icon: GearSixIcon,
                // The menu closes after onSelect, which would also close a
                // settings popover opened in the same tick.
                onSelect: () =>
                  requestAnimationFrame(() =>
                    capabilities.invokePanelCapability(
                      parameters.api.id,
                      OPEN_PANEL_SETTINGS_CAPABILITY,
                      {},
                    ),
                  ),
              },
              { id: "settings-separator", type: "separator" },
            ] satisfies ContextMenuEntry[])
          : []),
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
      ];
    };

    /** Activates the panel and opens its tab menu at the pointer. */
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      parameters.api.setActive();
      openContextMenu({
        x: event.clientX,
        y: event.clientY,
        items: tabMenuItems(),
      });
    };
    this._element.addEventListener("contextmenu", onContextMenu);
    this._removeContextMenu = () => {
      this._element.removeEventListener("contextmenu", onContextMenu);
    };

    const hoverless = window.matchMedia(hoverlessQuery);
    this._hoverless = hoverless;
    this._visible = parameters.api.isVisible;
    /** Re-renders when the group's visible panel or the hover capability changes. */
    const syncCaret = () => {
      this._visible = parameters.api.isVisible;
      this.updateCaret();
    };
    /** Tracks the pointer entering the tab. */
    const onPointerEnter = () => {
      this._hovered = true;
      this.updateCaret();
    };
    /** Restores the panel icon once the pointer leaves the tab. */
    const onPointerLeave = () => {
      this._hovered = false;
      this.updateCaret();
    };
    // Only a press that started on the caret opens the menu, so clicking an
    // inactive tab's icon just activates it even though the caret appears mid-click.
    let pressedCaret = false;
    /** Keeps a press on the caret from starting a tab drag. */
    const onIconPointerDown = (event: PointerEvent) => {
      pressedCaret = this._showCaret;
      if (pressedCaret) event.preventDefault();
    };
    /** Opens the tab menu below the caret; a plain icon click falls through to tab activation. */
    const onIconClick = (event: MouseEvent) => {
      const opensMenu = pressedCaret && this._showCaret;
      pressedCaret = false;
      if (!opensMenu) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = this._icon.getBoundingClientRect();
      openContextMenu({
        x: rect.left,
        y: rect.bottom + 4,
        items: tabMenuItems(),
      });
    };
    const visibility = parameters.api.onDidVisibilityChange(syncCaret);
    this._element.addEventListener("pointerenter", onPointerEnter);
    this._element.addEventListener("pointerleave", onPointerLeave);
    this._icon.addEventListener("pointerdown", onIconPointerDown);
    this._icon.addEventListener("click", onIconClick);
    hoverless.addEventListener("change", syncCaret);
    this._removeTabMenu = () => {
      visibility.dispose();
      this._element.removeEventListener("pointerenter", onPointerEnter);
      this._element.removeEventListener("pointerleave", onPointerLeave);
      this._icon.removeEventListener("pointerdown", onIconPointerDown);
      this._icon.removeEventListener("click", onIconClick);
      hoverless.removeEventListener("change", syncCaret);
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
    this._removeTabMenu?.();
    this._removeTabMenu = undefined;
    renderIconComponent(this._icon, undefined, "size-3.5");
  }

  /**
   * Whether the icon should currently be the tab menu caret: on the group's
   * visible tab while hovered, or always without hover unless it is saving.
   */
  private caretWanted(): boolean {
    return (
      this._visible &&
      (this._hovered ||
        (this._hoverless?.matches === true && this._status !== "saving"))
    );
  }

  /** Re-renders only when hover or visibility changes whether the caret shows. */
  private updateCaret(): void {
    if (this.caretWanted() !== this._showCaret) this.render();
  }

  /** Renders the tab menu caret, the transient activity icon, or the registered panel icon. */
  private render(): void {
    this._showCaret = this.caretWanted();
    if (this._label.textContent !== this._title) {
      this._label.textContent = this._title;
    }
    this._element.setAttribute(
      "aria-label",
      this._status === "saving" ? `${this._title}, saving` : this._title,
    );
    if (this._status) this._icon.dataset.panelTabStatus = this._status;
    else delete this._icon.dataset.panelTabStatus;
    this._icon.classList.toggle("nf-tab-menu-caret", this._showCaret);
    if (this._showCaret) {
      this._icon.setAttribute("role", "button");
      this._icon.setAttribute("aria-label", `${this._title} tab menu`);
      this._icon.removeAttribute("aria-hidden");
    } else {
      this._icon.removeAttribute("role");
      this._icon.removeAttribute("aria-label");
      this._icon.setAttribute("aria-hidden", "true");
    }

    const spinning = this._status === "saving" && !this._showCaret;
    const iconComponent = this._showCaret
      ? CaretDownIcon
      : spinning
        ? ArrowsClockwiseIcon
        : this._iconComponent;
    if (iconComponent) {
      renderIconComponent(
        this._icon,
        iconComponent,
        spinning ? "size-3.5 animate-spin" : "size-3.5",
      );
      this._icon.style.display = "inline-block";
    } else {
      renderIconComponent(this._icon, undefined, "size-3.5");
      this._icon.style.display = "none";
    }
  }
}
