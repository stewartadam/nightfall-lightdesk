// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import {
  createEffect,
  createSignal,
  createUniqueId,
  type JSX,
  Match,
  Show,
  Switch,
} from "solid-js";
import { useAppShell } from "../../../components/providers/app-shell";
import PanelToolbar, {
  ToolbarSeparator,
} from "../../../components/ui/panel-toolbar";
import { SegmentedTabs } from "../../../components/ui/segmented-tabs";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import { bestEffortPersistentAtom } from "../../../lib/best-effort-persistent-atom";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import {
  bindingValidationSettings,
  clearPatchBindingNavigationRequest,
  patchBindingNavigationRequest,
  requestPatchBindingNavigation,
} from "../../../state/appStores";
import PatchBindingsTab from "../components/bindings-tab";
import PatchFixtureListTab from "../components/fixture-list-tab";
import PatchFixturesTab from "../components/fixtures-tab";
import PatchUniversesTab from "../components/universes-tab";
import { usePatchWizard } from "../wizard";

export interface PatchPanelProps extends BasePanelComponentProps {}

type PatchTab = "fixtures" | "bindings";
type BindingsGroupBy = "none" | "fixture" | "universe";

const TABS: { key: PatchTab; label: string }[] = [
  { key: "fixtures", label: "Fixtures" },
  { key: "bindings", label: "DMX I/O" },
];

const BINDINGS_GROUP_OPTIONS: { key: BindingsGroupBy; label: string }[] = [
  { key: "none", label: "None" },
  { key: "fixture", label: "Fixture" },
  { key: "universe", label: "Universe" },
];

const PATCH_PANEL_ACTIVE_TAB_STORAGE_KEY = "nightfall-patch-panel:active-tab";
const PATCH_PANEL_BINDINGS_GROUP_STORAGE_KEY =
  "nightfall-patch-panel:bindings-group-by";

/**
 * Returns whether a stored value is a supported patch panel tab.
 */
function isPatchTab(value: string): value is PatchTab {
  return value === "fixtures" || value === "bindings";
}

/**
 * Returns whether a stored value is a supported bindings grouping mode.
 */
function isBindingsGroupBy(value: string): value is BindingsGroupBy {
  return value === "none" || value === "fixture" || value === "universe";
}

const patchPanelActiveTab = bestEffortPersistentAtom<PatchTab>(
  PATCH_PANEL_ACTIVE_TAB_STORAGE_KEY,
  "fixtures",
  {
    decode: (value) => (isPatchTab(value) ? value : "fixtures"),
    encode: (value) => value,
  },
);

const patchPanelBindingsGroupBy = bestEffortPersistentAtom<BindingsGroupBy>(
  PATCH_PANEL_BINDINGS_GROUP_STORAGE_KEY,
  "none",
  {
    decode: (value) => (isBindingsGroupBy(value) ? value : "none"),
    encode: (value) => value,
  },
);

/** Presents fixture patching and saved DMX grouping views with contextual toolbar actions. */
export default function PatchPanel(props: PatchPanelProps) {
  const $bindingValidationSettings = useStore(bindingValidationSettings);
  const $patchBindingNavigationRequest = useStore(
    patchBindingNavigationRequest,
  );
  const activeTab = useStore(patchPanelActiveTab);
  const tabId = createUniqueId();
  const groupingId = createUniqueId();
  const bindingsGroupBy = useStore(patchPanelBindingsGroupBy);
  const [bindingsSelectedCount, setBindingsSelectedCount] = createSignal(0);
  const [deleteBindingsAction, setDeleteBindingsAction] = createSignal<
    (() => void) | null
  >(null);
  const [fixturesSelectedCount, setFixturesSelectedCount] = createSignal(0);
  const [selectedFixtureIds, setSelectedFixtureIds] = createSignal<number[]>(
    [],
  );
  const [deleteFixturesAction, setDeleteFixturesAction] = createSignal<
    (() => void) | null
  >(null);
  const [columnVisibilityControl, setColumnVisibilityControl] =
    createSignal<JSX.Element | null>(null);
  const { openSettings } = useAppShell();
  const { openWizard } = usePatchWizard();

  const canDeleteBindings = () =>
    activeTab() === "bindings" &&
    bindingsGroupBy() === "none" &&
    bindingsSelectedCount() > 0 &&
    deleteBindingsAction() !== null;

  const canDeleteFixtures = () =>
    activeTab() === "fixtures" &&
    fixturesSelectedCount() > 0 &&
    deleteFixturesAction() !== null;

  /** Whether selected fixture rows can be updated through the patch wizard. */
  const canMorphFixtures = () =>
    activeTab() === "fixtures" && selectedFixtureIds().length > 0;

  /** Open the patch wizard in its normal new-fixture flow. */
  const handleOpenPatchWizard = () => {
    openWizard();
  };

  /** Open the patch wizard with the current fixture selection as morph targets. */
  const handleMorphFixtures = () => {
    if (!canMorphFixtures()) {
      return;
    }
    openWizard({ morphFixtureIds: selectedFixtureIds() });
  };

  /** Stores the active patch panel tab. */
  const setActiveTab = (tab: PatchTab) => {
    patchPanelActiveTab.set(tab);
  };

  /** Stores the current bindings grouping mode. */
  const setBindingsGroupBy = (groupBy: BindingsGroupBy) => {
    patchPanelBindingsGroupBy.set(groupBy);
  };

  const handleDeleteBindings = () => {
    if (!canDeleteBindings()) {
      return;
    }
    deleteBindingsAction()?.();
  };

  const handleDeleteFixtures = () => {
    if (!canDeleteFixtures()) {
      return;
    }
    deleteFixturesAction()?.();
  };

  const handleDeleteActionChange = (action: (() => void) | null) => {
    setDeleteBindingsAction(() => action);
  };

  const handleDeleteFixturesActionChange = (action: (() => void) | null) => {
    setDeleteFixturesAction(() => action);
  };

  const handleColumnVisibilityControlChange = (control: JSX.Element | null) => {
    setColumnVisibilityControl(() => control);
  };

  const handleNavigateToBinding = (bindingId: string) => {
    requestPatchBindingNavigation(bindingId);
    setBindingsGroupBy("none");
    setActiveTab("bindings");
  };

  const handleBindingNavigationHandled = (requestId: number) => {
    clearPatchBindingNavigationRequest(requestId);
  };

  createEffect(() => {
    if ($patchBindingNavigationRequest()) {
      setBindingsGroupBy("none");
      setActiveTab("bindings");
    }
  });

  const isStrictOverlapValidation = () =>
    $bindingValidationSettings().mode === "Strict";

  const validationModeLabel = () =>
    isStrictOverlapValidation() ? "Strict Mode" : "Permissive Mode";

  const validationModeTooltip = () =>
    isStrictOverlapValidation()
      ? "Overlapping bindings will be rejected"
      : "Overlapping bindings are permitted and applied in priority order";

  return (
    <div
      class="flex flex-col h-full"
      data-panel-kind="patch"
      data-panel-id={props.id}
    >
      <PanelToolbar
        left={
          <>
            <Show when={activeTab() === "fixtures"}>
              <ToolbarButton
                tooltip={"Add Fixture"}
                type="button"
                label="Add fixture"
                onClick={handleOpenPatchWizard}
              >
                <PlusIcon class="size-4" aria-hidden />
              </ToolbarButton>

              <ToolbarButton
                size="labeled"
                tooltip={
                  canMorphFixtures()
                    ? `Morph selected fixtures (${selectedFixtureIds().length})`
                    : "Morph selected fixtures"
                }
                type="button"
                label="Morph selected fixtures"
                disabled={!canMorphFixtures()}
                onClick={handleMorphFixtures}
              >
                <ArrowsClockwiseIcon class="size-4" aria-hidden />
                <Show when={selectedFixtureIds().length > 0}>
                  <span class="rounded bg-blue-800 px-1 text-[10px] leading-4 text-blue-100">
                    {selectedFixtureIds().length}
                  </span>
                </Show>
              </ToolbarButton>

              <ToolbarButton
                variant="danger"
                size="labeled"
                tooltip={
                  canDeleteFixtures()
                    ? `Delete selected fixtures (${fixturesSelectedCount()})`
                    : "Delete selected fixtures"
                }
                type="button"
                label="Delete selected fixtures"
                disabled={!canDeleteFixtures()}
                onClick={handleDeleteFixtures}
              >
                <TrashIcon class="size-4" aria-hidden />
                <Show when={fixturesSelectedCount() > 0}>
                  <span class="rounded bg-red-800 px-1 text-[10px] leading-4 text-red-100">
                    {fixturesSelectedCount()}
                  </span>
                </Show>
              </ToolbarButton>
            </Show>

            <Show when={activeTab() === "bindings"}>
              <ToolbarButton
                variant="danger"
                size="labeled"
                tooltip={
                  canDeleteBindings()
                    ? `Delete selected bindings (${bindingsSelectedCount()})`
                    : "Delete selected bindings"
                }
                type="button"
                label="Delete selected bindings"
                disabled={!canDeleteBindings()}
                onClick={handleDeleteBindings}
              >
                <TrashIcon class="size-4" aria-hidden />
                <Show when={bindingsSelectedCount() > 0}>
                  <span class="rounded bg-red-800 px-1 text-[10px] leading-4 text-red-100">
                    {bindingsSelectedCount()}
                  </span>
                </Show>
              </ToolbarButton>
            </Show>

            <Show when={activeTab() === "bindings"}>
              <ToolbarSeparator />
              <div class="flex min-w-0 max-w-full items-center gap-2">
                <span class="text-xs text-neutral-400 whitespace-nowrap">
                  Group by
                </span>
                <SegmentedTabs
                  id={groupingId}
                  density="compact"
                  label="Group by"
                  contentId={`${groupingId}-content`}
                  options={BINDINGS_GROUP_OPTIONS}
                  value={bindingsGroupBy()}
                  onChange={setBindingsGroupBy}
                />
              </div>
              <ToolbarSeparator />
              <ToolbarButton
                size="labeled"
                label={validationModeLabel()}
                tooltip={validationModeTooltip()}
                onClick={openSettings}
              >
                {validationModeLabel()}
              </ToolbarButton>
            </Show>
          </>
        }
        right={
          <>
            <SegmentedTabs
              id={tabId}
              density="compact"
              label="Patch views"
              contentId={`${tabId}-content`}
              options={TABS}
              value={activeTab()}
              onChange={setActiveTab}
            />
            <Show when={columnVisibilityControl()}>
              {(control) => (
                <>
                  <ToolbarSeparator />
                  {control()}
                </>
              )}
            </Show>
          </>
        }
      />
      <div
        class="flex-1 min-h-0"
        id={`${tabId}-content`}
        role="tabpanel"
        aria-labelledby={`${tabId}-${activeTab()}`}
      >
        <Switch>
          <Match when={activeTab() === "fixtures"}>
            <PatchFixtureListTab
              panelId={props.id}
              onSelectionCountChange={setFixturesSelectedCount}
              onSelectedFixtureIdsChange={setSelectedFixtureIds}
              onDeleteActionChange={handleDeleteFixturesActionChange}
              onColumnVisibilityControlChange={
                handleColumnVisibilityControlChange
              }
            />
          </Match>
          <Match when={activeTab() === "bindings"}>
            <div
              class="h-full min-h-0"
              id={`${groupingId}-content`}
              role="tabpanel"
              aria-labelledby={`${groupingId}-${bindingsGroupBy()}`}
            >
              <Switch>
                <Match when={bindingsGroupBy() === "none"}>
                  <PatchBindingsTab
                    panelId={props.id}
                    onSelectionCountChange={setBindingsSelectedCount}
                    onDeleteActionChange={handleDeleteActionChange}
                    navigateToBinding={$patchBindingNavigationRequest()}
                    onNavigateHandled={handleBindingNavigationHandled}
                    onColumnVisibilityControlChange={
                      handleColumnVisibilityControlChange
                    }
                  />
                </Match>
                <Match when={bindingsGroupBy() === "fixture"}>
                  <PatchFixturesTab
                    panelId={props.id}
                    onNavigateToBinding={handleNavigateToBinding}
                    onColumnVisibilityControlChange={
                      handleColumnVisibilityControlChange
                    }
                  />
                </Match>
                <Match when={bindingsGroupBy() === "universe"}>
                  <PatchUniversesTab
                    panelId={props.id}
                    onNavigateToBinding={handleNavigateToBinding}
                    onColumnVisibilityControlChange={
                      handleColumnVisibilityControlChange
                    }
                  />
                </Match>
              </Switch>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
