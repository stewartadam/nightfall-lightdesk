// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MultiProvider } from "@solid-primitives/context";
import { IconProvider } from "@squidlab/phosphor-solid";
import type { ParentComponent } from "solid-js";
import { ObjectPatchWizardProvider } from "../../../features/object-library";
import { PatchWizardProvider } from "../../../features/patch";
import { PropertiesContextProvider } from "../../../features/property-inspector";
import { ShowfileObjectPaletteProvider } from "../../../features/showfile";
import { AppShellProvider } from "../../providers/app-shell";
import KeyboardShortcutsProvider from "../../providers/keyboard-shortcuts";
import { PanelCapabilityRegistryProvider } from "../../providers/panel-capabilities/context";
import { ShellOverlayCoordinatorProvider } from "../../providers/shell-overlay-coordinator";
import { CommandPaletteProvider } from "../command-palette";

/** Provides the stable app-wide context stack in its required dependency order. */
const AppProviders: ParentComponent = (props) => (
  <IconProvider weight="regular">
    <MultiProvider
      values={[
        KeyboardShortcutsProvider,
        ShellOverlayCoordinatorProvider,
        CommandPaletteProvider,
        PanelCapabilityRegistryProvider,
        ShowfileObjectPaletteProvider,
        PropertiesContextProvider,
        AppShellProvider,
        PatchWizardProvider,
        ObjectPatchWizardProvider,
      ]}
    >
      {props.children}
    </MultiProvider>
  </IconProvider>
);

export default AppProviders;
