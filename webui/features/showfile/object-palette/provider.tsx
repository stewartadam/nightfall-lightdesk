// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createContext,
  createSignal,
  onCleanup,
  type ParentComponent,
  useContext,
} from "solid-js";
import { useShellOverlayCoordinator } from "../../../components/providers/shell-overlay-coordinator";
import OpenShowfileObjectPalette from "./open-showfile-object-palette";
import { ShowfileObjectPaletteUI } from "./showfile-object-palette";

interface ShowfileObjectPaletteContextType {
  showPalette: () => void;
  hidePalette: () => void;
  isOpen: () => boolean;
}

const ShowfileObjectPaletteContext =
  createContext<ShowfileObjectPaletteContextType>();

export const ShowfileObjectPaletteProvider: ParentComponent = (props) => {
  const { closeOtherOverlays, registerOverlay } = useShellOverlayCoordinator();
  const [isOpen, setIsOpen] = createSignal(false);

  /** Opens the object palette after closing other transient shell overlays. */
  const showPalette = () => {
    closeOtherOverlays("showfileObjectPalette");
    setIsOpen(true);
  };

  /** Closes the object palette without affecting other shell overlays. */
  const hidePalette = () => setIsOpen(false);

  onCleanup(registerOverlay("showfileObjectPalette", hidePalette));

  return (
    <ShowfileObjectPaletteContext.Provider
      value={{ showPalette, hidePalette, isOpen }}
    >
      {props.children}
      <ShowfileObjectPaletteUI isOpen={isOpen()} onClose={hidePalette} />
      <OpenShowfileObjectPalette />
    </ShowfileObjectPaletteContext.Provider>
  );
};

/** Returns the showfile object palette context. */
export const useShowfileObjectPalette = () => {
  const context = useContext(ShowfileObjectPaletteContext);
  if (!context) {
    throw new Error(
      "useShowfileObjectPalette must be used within a ShowfileObjectPaletteProvider",
    );
  }
  return context;
};
