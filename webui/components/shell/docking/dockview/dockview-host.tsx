// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createDockview,
  type DockviewApi,
  type DockviewOptions,
  type DockviewTheme,
} from "dockview";
import {
  type Component,
  createEffect,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
} from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import { bindPanelAppearance } from "./panel-appearance";

export const visualLanguageDockTheme: DockviewTheme = {
  name: "nightfall-graphite",
  className: "dockview-theme-nightfall-graphite",
  colorScheme: "dark",
  gap: 16,
  tabAnimation: "smooth",
};

interface DockviewHostProps {
  components: Record<string, Component>;
  options?: Omit<DockviewOptions, "createComponent" | "defaultHeaderPosition">;
  tabPosition?: "top" | "bottom";
  onReady: (api: DockviewApi, element: HTMLDivElement) => void;
  class?: string;
  style?: JSX.CSSProperties;
  ariaLabel: string;
}

/** Hosts real Dockview panels as Solid portals so panel content retains its provider context. */
export function DockviewHost(props: DockviewHostProps) {
  let element!: HTMLDivElement;
  let api: DockviewApi | undefined;
  let disposing = false;
  const [panels, setPanels] = createSignal<
    { id: string; element: HTMLElement; component: Component }[]
  >([]);

  /** Initializes docking after its container has measurable dimensions. */
  onMount(() => {
    api = createDockview(element, {
      defaultRenderer: "always",
      ...props.options,
      defaultHeaderPosition: props.tabPosition ?? "top",
      /** Adapts registered panel components to Dockview's renderer lifecycle. */
      createComponent(options) {
        const component = props.components[options.name];
        if (!component)
          throw new Error(`Unknown dock component: ${options.name}`);
        const panelElement = document.createElement("div");
        panelElement.className = "nf-dock-panel-root";
        let panelAppearance: ReturnType<typeof bindPanelAppearance> | undefined;
        return {
          element: panelElement,
          /** Adds panel content to the host's Solid owner tree. */
          init(parameters) {
            panelAppearance = bindPanelAppearance(panelElement, parameters.api);
            setPanels((current) => [
              ...current,
              { id: options.id, element: panelElement, component },
            ]);
          },
          /** Removes panel content when Dockview closes its tab. */
          dispose() {
            panelAppearance?.dispose();
            if (!disposing)
              setPanels((current) =>
                current.filter((panel) => panel.id !== options.id),
              );
          },
        };
      },
    });
    api.layout(element.clientWidth, element.clientHeight);
    props.onReady(api, element);
    /** Moves existing and future tab strips without rebuilding panels or their state. */
    createEffect(() => {
      const position = props.tabPosition ?? "top";
      api?.updateOptions({ defaultHeaderPosition: position });
      for (const group of api?.groups ?? [])
        group.api.setHeaderPosition(position);
    });
  });

  /** Disposes docking listeners while Solid tears down the owned panel portals. */
  onCleanup(() => {
    disposing = true;
    api?.dispose();
  });

  return (
    <>
      <div
        ref={element}
        class={props.class}
        style={props.style}
        role="region"
        aria-label={props.ariaLabel}
        data-tab-position={props.tabPosition ?? "top"}
      />
      <For each={panels()}>
        {(panel) => (
          <Portal mount={panel.element}>
            <Dynamic component={panel.component} />
          </Portal>
        )}
      </For>
    </>
  );
}
