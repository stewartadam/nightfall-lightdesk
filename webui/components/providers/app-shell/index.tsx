// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import type { DockviewApi } from "dockview";
import {
  createContext,
  createSignal,
  type ParentComponent,
  useContext,
} from "solid-js";
import {
  activeShellDialog,
  closeDiagnostics,
  openDiagnostics,
} from "../../../state/shell-dialog";

interface AppShellContextValue {
  isSettingsOpen: () => boolean;
  openSettings: () => void;
  closeSettings: () => void;
  isAboutOpen: () => boolean;
  openAbout: () => void;
  closeAbout: () => void;
  isDiagnosticsOpen: () => boolean;
  openDiagnostics: () => void;
  closeDiagnostics: () => void;
  isShortcutsPopupVisible: () => boolean;
  showShortcutsPopup: () => void;
  hideShortcutsPopup: () => void;
  isOpenShowfileModalVisible: () => boolean;
  showOpenShowfileModal: () => void;
  hideOpenShowfileModal: () => void;
  isShowfileImportModalVisible: () => boolean;
  showShowfileImportModal: () => void;
  hideShowfileImportModal: () => void;
  isShowfileExportModalVisible: () => boolean;
  showShowfileExportModal: () => void;
  hideShowfileExportModal: () => void;
  isLayoutManagerVisible: () => boolean;
  showLayoutManager: () => void;
  hideLayoutManager: () => void;
  dockviewApi: () => DockviewApi | undefined;
  setDockviewApi: (api: DockviewApi | undefined) => void;
}

const AppShellContext = createContext<AppShellContextValue>();

/**
 * Provides shared app-shell UI state and commands for shell-level overlays.
 */
export const AppShellProvider: ParentComponent = (props) => {
  const activeDialog = useStore(activeShellDialog);
  const setActiveDialog = activeShellDialog.set;
  const [isLayoutManagerVisible, setIsLayoutManagerVisible] =
    createSignal(false);
  const [dockviewApi, setDockviewApiSignal] = createSignal<
    DockviewApi | undefined
  >(undefined);

  /** Returns whether the settings dialog is the active shell dialog. */
  const isSettingsOpen = () => activeDialog() === "settings";

  /** Opens settings as the active shell dialog. */
  const openSettings = () => {
    setActiveDialog("settings");
  };

  /** Closes settings if it is the active shell dialog. */
  const closeSettings = () => {
    if (isSettingsOpen()) {
      setActiveDialog(null);
    }
  };

  /** Returns whether the about dialog is the active shell dialog. */
  const isAboutOpen = () => activeDialog() === "about";

  /** Returns whether the diagnostic preview is the active shell dialog. */
  const isDiagnosticsOpen = () => activeDialog() === "diagnostics";

  /** Opens the about dialog as the active shell dialog. */
  const openAbout = () => {
    setActiveDialog("about");
  };

  /** Closes about if it is the active shell dialog. */
  const closeAbout = () => {
    if (isAboutOpen()) {
      setActiveDialog(null);
    }
  };

  /** Returns whether the keyboard shortcuts dialog is active. */
  const isShortcutsPopupVisible = () => activeDialog() === "shortcuts";

  /** Opens the keyboard shortcuts dialog as the active shell dialog. */
  const showShortcutsPopup = () => {
    setActiveDialog("shortcuts");
  };

  /** Closes keyboard shortcuts if it is the active shell dialog. */
  const hideShortcutsPopup = () => {
    if (isShortcutsPopupVisible()) {
      setActiveDialog(null);
    }
  };

  /** Returns whether the showfile picker dialog is visible. */
  const [isOpenShowfileModalVisible, setOpenShowfileModalVisible] =
    createSignal(false);

  /** Opens the showfile picker dialog. */
  const showOpenShowfileModal = () => {
    setOpenShowfileModalVisible(true);
  };

  /** Closes the showfile picker dialog. */
  const hideOpenShowfileModal = () => {
    setOpenShowfileModalVisible(false);
  };

  /** Returns whether the showfile import dialog is visible. */
  const [isShowfileImportModalVisible, setShowfileImportModalVisible] =
    createSignal(false);

  /** Opens the showfile import dialog. */
  const showShowfileImportModal = () => {
    setShowfileImportModalVisible(true);
  };

  /** Closes the showfile import dialog. */
  const hideShowfileImportModal = () => {
    setShowfileImportModalVisible(false);
  };

  const [isShowfileExportModalVisible, setShowfileExportModalVisible] =
    createSignal(false);

  /** Opens the dialog for exporting an independent showfile copy. */
  const showShowfileExportModal = () => setShowfileExportModalVisible(true);

  /** Closes the standalone showfile export dialog. */
  const hideShowfileExportModal = () => setShowfileExportModalVisible(false);

  /** Opens the layout manager overlay. */
  const showLayoutManager = () => {
    setIsLayoutManagerVisible(true);
  };

  /** Closes the layout manager overlay. */
  const hideLayoutManager = () => {
    setIsLayoutManagerVisible(false);
  };

  /** Records the active Dockview API for shell-level layout actions. */
  const setDockviewApi = (api: DockviewApi | undefined) => {
    setDockviewApiSignal(api);
  };

  return (
    <AppShellContext.Provider
      value={{
        isSettingsOpen,
        openSettings,
        closeSettings,
        isAboutOpen,
        openAbout,
        closeAbout,
        isDiagnosticsOpen,
        openDiagnostics,
        closeDiagnostics,
        isShortcutsPopupVisible,
        showShortcutsPopup,
        hideShortcutsPopup,
        isOpenShowfileModalVisible,
        showOpenShowfileModal,
        hideOpenShowfileModal,
        isShowfileImportModalVisible,
        showShowfileImportModal,
        hideShowfileImportModal,
        isShowfileExportModalVisible,
        showShowfileExportModal,
        hideShowfileExportModal,
        isLayoutManagerVisible,
        showLayoutManager,
        hideLayoutManager,
        dockviewApi,
        setDockviewApi,
      }}
    >
      {props.children}
    </AppShellContext.Provider>
  );
};

/**
 * Returns shared app-shell UI controls for shell-level overlays.
 */
export const useAppShell = () => {
  const context = useContext(AppShellContext);
  if (!context) {
    throw new Error("useAppShell must be used within an AppShellProvider");
  }
  return context;
};
