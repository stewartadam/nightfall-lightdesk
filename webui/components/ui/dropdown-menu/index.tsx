// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createContext, createSignal, type JSX, useContext } from "solid-js";
import type { AppIcon } from "../icon";
import { MenuItem, MenuSeparator, MenuSurface } from "../menu";
import { Popover } from "../popover";

const DropdownContext = createContext<{ close: () => void }>();

interface DropdownMenuProps {
  trigger: JSX.Element;
  children: JSX.Element;
  triggerLabel?: string;
  triggerTitle?: string;
  placement?: "above" | "below";
  align?: "start" | "end";
  triggerClass?: string;
  triggerDisabled?: boolean;
  open?: boolean;
  contentLabel?: string;
  contentClass?: string;
  onOpenChange?: (isOpen: boolean) => void;
}

/**
 * Renders a button-triggered menu in a `Popover`, which mounts it above (or
 * inside) any open modal dialog and dismisses it on outside presses and Escape.
 */
export function DropdownMenu(props: DropdownMenuProps) {
  const [internalOpen, setInternalOpen] = createSignal(false);
  let triggerRef: HTMLButtonElement | undefined;

  /** Resolves controlled and self-owned menu visibility through one accessor. */
  const isOpen = (): boolean => props.open ?? internalOpen();

  /** Updates the menu state and notifies its owner. */
  const setOpen = (nextOpen: boolean) => {
    if (props.open === undefined) setInternalOpen(nextOpen);
    props.onOpenChange?.(nextOpen);
  };

  /** Closes the menu. */
  const close = () => setOpen(false);

  return (
    <DropdownContext.Provider value={{ close }}>
      <div class="relative" data-component="DropdownMenu">
        <button
          ref={triggerRef}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setOpen(!isOpen());
          }}
          class={`appearance-none cursor-pointer border-none bg-transparent p-0 m-0 ${props.triggerClass ?? ""}`.trim()}
          aria-label={props.triggerLabel}
          aria-expanded={isOpen()}
          aria-haspopup="menu"
          disabled={props.triggerDisabled}
          title={props.triggerTitle}
        >
          {props.trigger}
        </button>
        <Popover
          anchor={() => triggerRef}
          open={isOpen()}
          onClose={close}
          placement={props.placement ?? "above"}
          align={props.align}
          surface={MenuSurface}
          data-component="DropdownMenuContent"
          data-menu-kind="dropdown"
          class={`min-w-[220px] ${props.contentClass ?? ""}`}
          role="menu"
          aria-label={props.contentLabel}
        >
          {props.children}
        </Popover>
      </div>
    </DropdownContext.Provider>
  );
}

interface DropdownMenuItemProps {
  onClick: () => void;
  children: JSX.Element;
  icon?: AppIcon;
  shortcut?: string;
  description?: JSX.Element;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
}

interface DropdownMenuSubmenuProps {
  label: string;
  icon?: AppIcon;
  children: JSX.Element;
}

/** Groups dropdown actions in a viewport-constrained flyout sharing the parent close action. */
export function DropdownMenuSubmenu(props: DropdownMenuSubmenuProps) {
  const [isOpen, setIsOpen] = createSignal(false);
  const [position, setPosition] = createSignal<JSX.CSSProperties>({});
  let triggerRef: HTMLButtonElement | undefined;
  let menuRef: HTMLDivElement | undefined;

  /** Places the flyout beside its trigger while keeping its contents inside the viewport. */
  const open = () => {
    if (!triggerRef || !menuRef) return;
    const bounds = triggerRef.getBoundingClientRect();
    const width = menuRef.offsetWidth;
    const height = menuRef.offsetHeight;
    const left =
      bounds.right + width <= window.innerWidth - 4
        ? bounds.right
        : Math.max(4, bounds.left - width);
    setPosition({
      left: `${left}px`,
      top: `${Math.max(4, Math.min(bounds.top, window.innerHeight - height - 4))}px`,
    });
    setIsOpen(true);
  };

  return (
    <div
      onPointerEnter={open}
      onPointerLeave={() => setIsOpen(false)}
      onFocusOut={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "ArrowLeft") {
          event.preventDefault();
          event.stopPropagation();
          setIsOpen(false);
          triggerRef?.focus();
        }
      }}
    >
      <MenuItem
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen()}
        icon={props.icon}
        trailing="›"
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            open();
            menuRef?.querySelector("button")?.focus();
          }
        }}
      >
        {props.label}
      </MenuItem>
      <MenuSurface
        ref={menuRef}
        role="menu"
        aria-label={props.label}
        inert={!isOpen()}
        data-menu-kind="dropdown-submenu"
        class="fixed min-w-[220px]"
        classList={{ invisible: !isOpen(), visible: isOpen() }}
        style={position()}
      >
        {props.children}
      </MenuSurface>
    </div>
  );
}

/** Renders an action that closes its containing dropdown after activation. */
export function DropdownMenuItem(props: DropdownMenuItemProps) {
  const ctx = useContext(DropdownContext);

  /** Runs the item action and closes the containing menu. */
  const handleClick = () => {
    if (props.disabled) return;
    props.onClick();
    ctx?.close();
  };

  return (
    <MenuItem
      data-component="DropdownMenuItem"
      icon={props.icon}
      shortcut={props.shortcut}
      description={props.description}
      checked={props.checked}
      disabled={props.disabled}
      danger={props.danger}
      onClick={handleClick}
    >
      {props.children}
    </MenuItem>
  );
}

/** Renders a visual separator between dropdown menu groups. */
export function DropdownMenuSeparator() {
  return <MenuSeparator data-component="DropdownMenuSeparator" />;
}
