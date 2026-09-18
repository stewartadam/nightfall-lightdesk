// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { onCleanup, onMount, type ParentComponent } from "solid-js";
import { dockApi } from "../state/appStores";
import {
  focusTrackedComponent,
  registerComponentFocus,
} from "./keyboardShortcuts";
import { getLogger } from "./logger";
import { PANEL_FOCUS_CAPABILITY } from "./panel-capabilities";
import {
  findPanelDefinitionByName,
  panelDefinitionHasCapability,
} from "./panel-definitions";
import {
  PanelPerformanceContextProvider,
  withPanelPerformanceContext,
} from "./panel-performance-context";
import type { BasePanelComponentProps } from "./panel-registry";

const log = getLogger(import.meta.url);

interface PanelFocusWrapperOptions {
  containerClass?: string;
  componentName?: string;
}

/** Warns when a focus-tracked static panel omits the focus capability contract. */
function warnIfPanelFocusCapabilityMissing(componentName?: string): void {
  if (!componentName) return;

  const definition = findPanelDefinitionByName(componentName);
  if (!definition) return;

  if (panelDefinitionHasCapability(definition, PANEL_FOCUS_CAPABILITY.id)) {
    return;
  }

  log.warn(
    `Panel ${definition.panelId} uses focus tracking without declaring ${PANEL_FOCUS_CAPABILITY.id}`,
    {
      componentName,
      declaredCapabilities: definition.capabilities ?? [],
    },
  );
}

/**
 * Wrapper that automatically registers a panel component for focus tracking.
 *
 * Panels register using their initialPanelId when in a DockView context,
 * or props.id as fallback. Non-panel components generate a focus ID.
 *
 * Usage:
 *   const WrappedPanel = withPanelFocus(MyPanelComponent, { componentName: "MyPanel" });
 */
export function withPanelFocus<P extends BasePanelComponentProps>(
  Component: ParentComponent<P>,
  options?: PanelFocusWrapperOptions,
): ParentComponent<P> {
  return (props: P) => {
    let containerRef: HTMLDivElement | undefined;
    const panelId = () =>
      (props.initialPanelId as string | undefined) ?? props.id;

    /** Activates the owning DockView panel before child click handlers run. */
    const focusOwningPanel = () => {
      focusTrackedComponent(panelId());
      dockApi.get()?.getPanel(panelId())?.focus();
    };

    onMount(() => {
      warnIfPanelFocusCapabilityMissing(options?.componentName);

      if (containerRef) {
        // Register with the panel's ID if available (DockView context)
        // Otherwise use the component ID for non-panel contexts
        onCleanup(registerComponentFocus(panelId(), containerRef));
      }
    });

    const containerClass = options?.containerClass ?? "h-full w-full";
    /** Returns the attribution payload used by performance probes in this panel. */
    const panelPerformanceContext = () => ({
      panelId: panelId(),
      componentName: options?.componentName,
    });

    /** Renders the wrapped panel while reactive subscriptions can capture panel identity. */
    const renderPanelComponent = () => {
      const context = panelPerformanceContext();
      return withPanelPerformanceContext(context, () => (
        <PanelPerformanceContextProvider value={context}>
          <Component {...props} />
        </PanelPerformanceContextProvider>
      ));
    };

    return (
      <div
        ref={containerRef}
        class={containerClass}
        data-component={options?.componentName}
        data-panel-kind={options?.componentName}
        data-panel-id={panelId()}
        on:pointerdown={{ handleEvent: focusOwningPanel, capture: true }}
      >
        {renderPanelComponent()}
      </div>
    );
  };
}
