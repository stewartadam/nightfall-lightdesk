// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, For, type JSX, onCleanup } from "solid-js";
import {
  MenuHeading,
  MenuItem,
  MenuSeparator,
  MenuSurface,
} from "../../ui/menu";
import {
  type ContextMenuEntry,
  type ContextMenuItem,
  type ContextMenuSubmenu,
  isContextSubmenu,
  isSelectableMenuItem,
} from "./contract";

export interface ContextMenuSubmenuPathEntry {
  submenu: ContextMenuSubmenu;
  entryIndex: number;
}

export interface ContextMenuListProps {
  items: readonly ContextMenuEntry[];
  style?: JSX.CSSProperties;
  onSelect: (item: ContextMenuItem) => void;
  submenuStyle: (
    path: readonly ContextMenuSubmenuPathEntry[],
  ) => JSX.CSSProperties;
}

interface ContextMenuEntriesProps {
  items: readonly ContextMenuEntry[];
  path: readonly ContextMenuSubmenuPathEntry[];
  onSelect: (item: ContextMenuItem) => void;
  submenuStyle: ContextMenuListProps["submenuStyle"];
}

/** Renders externally controlled context-menu entries and nested flyouts. */
export function ContextMenuList(props: ContextMenuListProps) {
  return (
    <MenuSurface
      role="menu"
      data-menu-kind="context"
      class="fixed"
      style={props.style}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <ContextMenuEntries
        items={props.items}
        path={[]}
        onSelect={props.onSelect}
        submenuStyle={props.submenuStyle}
      />
    </MenuSurface>
  );
}

/** Recursively renders one level of menu entries while retaining its flyout path. */
function ContextMenuEntries(props: ContextMenuEntriesProps) {
  return (
    <For each={props.items}>
      {(entry, entryIndex) =>
        isSelectableMenuItem(entry) ? (
          <ContextMenuButton item={entry} onSelect={props.onSelect} />
        ) : isContextSubmenu(entry) ? (
          <ContextMenuSubmenuRow
            item={entry}
            path={[...props.path, { submenu: entry, entryIndex: entryIndex() }]}
            onSelect={props.onSelect}
            submenuStyle={props.submenuStyle}
          />
        ) : entry.type === "heading" ? (
          <MenuHeading>{entry.label}</MenuHeading>
        ) : (
          <MenuSeparator />
        )
      }
    </For>
  );
}

/** Renders one recursively nested submenu with independent hover and focus state. */
function ContextMenuSubmenuRow(props: {
  item: ContextMenuSubmenu;
  path: readonly ContextMenuSubmenuPathEntry[];
  onSelect: (item: ContextMenuItem) => void;
  submenuStyle: ContextMenuListProps["submenuStyle"];
}) {
  const [isOpen, setIsOpen] = createSignal(false);
  let closeTimer: number | undefined;

  /** Cancels a pending close while the pointer crosses into the flyout. */
  const cancelScheduledClose = () => {
    if (closeTimer === undefined) return;
    window.clearTimeout(closeTimer);
    closeTimer = undefined;
  };

  /** Opens an enabled submenu and retains it while focus moves within the row. */
  const openSubmenu = () => {
    cancelScheduledClose();
    if (!props.item.disabled) setIsOpen(true);
  };

  /** Allows brief diagonal pointer movement before closing a flyout. */
  const scheduleSubmenuClose = () => {
    cancelScheduledClose();
    closeTimer = window.setTimeout(() => {
      setIsOpen(false);
      closeTimer = undefined;
    }, 120);
  };

  onCleanup(cancelScheduledClose);

  return (
    <div
      class="relative"
      onPointerEnter={openSubmenu}
      onPointerLeave={scheduleSubmenuClose}
      onFocusIn={openSubmenu}
      onFocusOut={(event) => {
        const nextTarget = event.relatedTarget;
        if (
          nextTarget instanceof Node &&
          event.currentTarget.contains(nextTarget)
        ) {
          return;
        }
        scheduleSubmenuClose();
      }}
    >
      <MenuItem
        icon={props.item.icon}
        trailing="›"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={isOpen()}
        disabled={props.item.disabled}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            openSubmenu();
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            setIsOpen(false);
          }
        }}
      >
        {props.item.label}
      </MenuItem>
      <MenuSurface
        role="menu"
        data-menu-kind="context-submenu"
        aria-hidden={!isOpen()}
        class="absolute"
        classList={{ invisible: !isOpen(), visible: isOpen() }}
        style={props.submenuStyle(props.path)}
      >
        <ContextMenuEntries
          items={props.item.items}
          path={props.path}
          onSelect={props.onSelect}
          submenuStyle={props.submenuStyle}
        />
      </MenuSurface>
    </div>
  );
}

/** Renders one command entry using only its supplied item contract. */
function ContextMenuButton(props: {
  item: ContextMenuItem;
  onSelect: (item: ContextMenuItem) => void;
}) {
  return (
    <MenuItem
      role="menuitem"
      icon={props.item.icon}
      checked={props.item.checked}
      shortcut={props.item.shortcut}
      danger={props.item.danger}
      disabled={props.item.disabled}
      onClick={() => {
        if (props.item.disabled) return;
        props.onSelect(props.item);
      }}
    >
      {props.item.label}
    </MenuItem>
  );
}
