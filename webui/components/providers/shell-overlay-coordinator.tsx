// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createContext, type ParentComponent, useContext } from "solid-js";

type ShellOverlayId = "commandPalette" | "showfileObjectPalette";

interface ShellOverlayCoordinatorContextValue {
  registerOverlay: (id: ShellOverlayId, close: () => void) => () => void;
  closeOtherOverlays: (activeId: ShellOverlayId) => void;
}

const ShellOverlayCoordinatorContext =
  createContext<ShellOverlayCoordinatorContextValue>();

/**
 * Coordinates shell-level transient overlays that should never stack.
 */
export const ShellOverlayCoordinatorProvider: ParentComponent = (props) => {
  const closeHandlers = new Map<ShellOverlayId, () => void>();

  /** Registers an overlay close callback and returns its cleanup function. */
  const registerOverlay = (id: ShellOverlayId, close: () => void) => {
    closeHandlers.set(id, close);

    return () => {
      if (closeHandlers.get(id) === close) {
        closeHandlers.delete(id);
      }
    };
  };

  /** Closes every registered shell overlay except the one about to open. */
  const closeOtherOverlays = (activeId: ShellOverlayId) => {
    for (const [id, close] of closeHandlers) {
      if (id !== activeId) {
        close();
      }
    }
  };

  return (
    <ShellOverlayCoordinatorContext.Provider
      value={{ registerOverlay, closeOtherOverlays }}
    >
      {props.children}
    </ShellOverlayCoordinatorContext.Provider>
  );
};

/**
 * Returns controls for coordinating mutually exclusive shell overlays.
 */
export const useShellOverlayCoordinator = () => {
  const context = useContext(ShellOverlayCoordinatorContext);
  if (!context) {
    throw new Error(
      "useShellOverlayCoordinator must be used within a ShellOverlayCoordinatorProvider",
    );
  }
  return context;
};
