// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * App internals that white-box specs drive directly. Loaded on an app page,
 * these are the same module instances the running app uses, in dev servers
 * and e2e builds alike. Prefer `window.__nightfallTest` where it covers a need.
 */

export * as solid from "solid-js";
export * as layoutEntrance from "../../components/shell/docking/dockview/layout-entrance";
export * as layoutReadiness from "../../components/shell/docking/layout-readiness";
export * as startupReadiness from "../../components/shell/startup/readiness";
export * as propertyInspectorContext from "../../features/property-inspector/context/context-core";
export * as timelineJump from "../../features/timeline/model/timeline-jump";
export * as visualizerContext from "../../features/visualizer/context/visualizer-context";
export * as visualizerSettings from "../../features/visualizer/state/settings";
export * as welcomeGuideLessons from "../../features/welcome-guide/lessons";
export * as api from "../../lib/api";
export * as dockviewActiveLayout from "../../lib/dockview-active-layout";
export * as dockviewLayout from "../../lib/dockview-layout";
export * as featureFlags from "../../lib/feature-flags";
export * as keyboardShortcuts from "../../lib/keyboardShortcuts";
export * as layoutActivation from "../../lib/layout-activation";
export * as layoutManagement from "../../lib/layout-management";
export * as layoutStorage from "../../lib/layoutStorage";
export * as logger from "../../lib/logger";
export * as performanceMeasures from "../../lib/performance-measure-collector";
export * as showfileActions from "../../lib/showfile-actions";
export * as showfileLoading from "../../lib/showfile-loading";
export * as wasmBridge from "../../lib/wasm-bridge";
export * as workspaceActivity from "../../lib/workspace-activity";
export * as appLifecycle from "../../state/app-lifecycle";
export * as appearance from "../../state/appearance";
export * as appStores from "../../state/appStores";
export * as ioSnapshots from "../../state/io-snapshots";
export * as layoutSwitcher from "../../state/layout-switcher";
export * as panelComponentLoads from "../../state/panel-component-loads";
export * as settings from "../../state/settings";
export * as types from "../../types";
