// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ClipboardTextIcon } from "@squidlab/phosphor-solid/clipboard-text";
import { CopyIcon } from "@squidlab/phosphor-solid/copy";
import { FrameCornersIcon } from "@squidlab/phosphor-solid/frame-corners";
import { GearSixIcon } from "@squidlab/phosphor-solid/gear-six";
import { PencilSimpleIcon } from "@squidlab/phosphor-solid/pencil-simple";
import { ScissorsIcon } from "@squidlab/phosphor-solid/scissors";
import { SquaresFourIcon } from "@squidlab/phosphor-solid/squares-four";
import { StackIcon } from "@squidlab/phosphor-solid/stack";
import { TextTIcon } from "@squidlab/phosphor-solid/text-t";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import {
  type ContextMenuEntry,
  openContextMenu,
} from "../../../components/providers/context-menu";
import type * as types from "../../../types";
import {
  BOARD_TARGET_TYPE_LABELS,
  BOARD_TARGET_TYPES,
  type BoardElementKindName,
  canPlaceElement,
  defaultElementSize,
  hasSoloSetting,
  hasTitleSetting,
  isSolo,
  withSolo,
} from "../model/board-model";
import type { BoardPanelController } from "./board-panel-controller";

/** Modifier shown before clipboard shortcut letters: the Command key on Apple devices. */
const MOD_KEY =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform)
    ? "⌘"
    : "Ctrl+";

/** Builds the Cut, Copy and Paste entries shared by the element and empty-cell menus. */
function clipboardEntries(
  controller: BoardPanelController,
  pasteAt: { x: number; y: number },
  hasElement: boolean,
): ContextMenuEntry[] {
  return [
    ...(hasElement
      ? [
          {
            id: "cut",
            label: "Cut",
            icon: ScissorsIcon,
            shortcut: `${MOD_KEY}X`,
            onSelect: controller.cutSelected,
          },
          {
            id: "copy",
            label: "Copy",
            icon: CopyIcon,
            shortcut: `${MOD_KEY}C`,
            onSelect: () => {
              controller.copySelected();
            },
          },
        ]
      : []),
    {
      id: "paste",
      label: "Paste",
      icon: ClipboardTextIcon,
      shortcut: `${MOD_KEY}V`,
      disabled: !controller.clipboard(),
      onSelect: () => controller.paste(pasteAt),
    },
  ];
}

/**
 * Opens the right-click menu of a board element. While editing it offers the element's
 * settings, its solo and title toggles, the clipboard and removal; while operating it offers
 * a way into edit mode with the element selected.
 */
export function openElementMenu(
  controller: BoardPanelController,
  element: types.BoardElement,
  x: number,
  y: number,
): void {
  if (!controller.editing()) {
    openContextMenu({
      x,
      y,
      items: [
        {
          id: "edit-board",
          label: "Edit board",
          icon: PencilSimpleIcon,
          onSelect: () => {
            controller.setEditing(true);
            controller.selectElement(element.uid);
          },
        },
      ],
    });
    return;
  }
  controller.selectElement(element.uid);
  const toggles: ContextMenuEntry[] = [
    ...(hasSoloSetting(element.kind)
      ? [
          {
            id: "solo",
            label: "Solo",
            checked: isSolo(element),
            onSelect: () =>
              controller.storeElement(withSolo(element, !isSolo(element))),
          },
        ]
      : []),
    ...(hasTitleSetting(element.kind)
      ? [
          {
            id: "show-title",
            label: "Show title",
            checked: element.show_title,
            onSelect: () =>
              controller.storeElement({
                ...element,
                show_title: !element.show_title,
              }),
          },
        ]
      : []),
  ];
  openContextMenu({
    x,
    y,
    items: [
      {
        id: "settings",
        label: "Settings…",
        icon: GearSixIcon,
        onSelect: () => controller.openElementSettings(element.uid),
      },
      ...toggles,
      { id: "clipboard-separator", type: "separator" },
      ...clipboardEntries(controller, element.cell, true),
      { id: "remove-separator", type: "separator" },
      {
        id: "remove",
        label: "Remove from board",
        icon: TrashIcon,
        shortcut: "Delete",
        danger: true,
        onSelect: () => controller.deleteElement(element.uid),
      },
    ],
  });
}

/**
 * Opens the menu for adding an element on an empty part of the board. A dragged-out `area`
 * sets the new element's size; a single clicked cell gives each kind its default size there.
 * Kinds that cannot sit there (anything but a frame over existing elements) are disabled.
 */
export function openAddMenu(
  controller: BoardPanelController,
  at: Pick<types.BoardCell, "x" | "y"> &
    Partial<Pick<types.BoardCell, "width" | "height">>,
  x: number,
  y: number,
): void {
  const board = controller.board();
  if (!board) return;
  controller.setPasteAnchor({ x: at.x, y: at.y });
  /** Returns the cell a new element of `kind` takes: the dragged area or its default size. */
  const areaFor = (kind: BoardElementKindName): types.BoardCell => ({
    x: at.x,
    y: at.y,
    ...(at.width && at.height
      ? { width: at.width, height: at.height }
      : defaultElementSize(kind)),
  });
  /** Returns whether an element of `kind` fits where it would be added. */
  const fits = (kind: BoardElementKindName) =>
    canPlaceElement(board, areaFor(kind), kind);
  openContextMenu({
    x,
    y,
    items: [
      {
        id: "add-button",
        type: "submenu",
        label: "Button",
        icon: SquaresFourIcon,
        disabled: !fits("Target"),
        items: BOARD_TARGET_TYPES.map((targetType) => ({
          id: `add-button-${targetType}`,
          label: BOARD_TARGET_TYPE_LABELS[targetType].one,
          disabled: controller.catalog()[targetType].length === 0,
          onSelect: () =>
            controller.addElement(
              { type: "Target", targetType },
              areaFor("Target"),
            ),
        })),
      },
      {
        id: "add-collection",
        type: "submenu",
        label: "Collection",
        icon: StackIcon,
        disabled: !fits("Collection"),
        items: BOARD_TARGET_TYPES.map((targetType) => ({
          id: `add-collection-${targetType}`,
          label: `All ${BOARD_TARGET_TYPE_LABELS[targetType].many.toLowerCase()}`,
          onSelect: () =>
            controller.addElement(
              { type: "Collection", targetType },
              areaFor("Collection"),
            ),
        })),
      },
      {
        id: "add-frame",
        label: "Frame",
        icon: FrameCornersIcon,
        disabled: !fits("Frame"),
        onSelect: () =>
          controller.addElement({ type: "Frame" }, areaFor("Frame")),
      },
      {
        id: "add-label",
        label: "Label",
        icon: TextTIcon,
        disabled: !fits("Label"),
        onSelect: () =>
          controller.addElement({ type: "Label" }, areaFor("Label")),
      },
      { id: "clipboard-separator", type: "separator" },
      ...clipboardEntries(controller, at, false),
    ],
  });
}
