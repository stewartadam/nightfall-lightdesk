// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowsOutCardinalIcon } from "@squidlab/phosphor-solid/arrows-out-cardinal";
import { CubeIcon } from "@squidlab/phosphor-solid/cube";
import { DeviceRotateIcon } from "@squidlab/phosphor-solid/device-rotate";
import { EraserIcon } from "@squidlab/phosphor-solid/eraser";
import { HashIcon } from "@squidlab/phosphor-solid/hash";
import { InfoIcon } from "@squidlab/phosphor-solid/info";
import { LightbulbIcon } from "@squidlab/phosphor-solid/lightbulb";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { RulerIcon } from "@squidlab/phosphor-solid/ruler";
import { SelectionIcon } from "@squidlab/phosphor-solid/selection";
import { SunIcon } from "@squidlab/phosphor-solid/sun";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { VideoCameraIcon } from "@squidlab/phosphor-solid/video-camera";
import { Dynamic } from "solid-js/web";
import { createActionMappingTarget } from "../../action-mapping";
/**
 * Toolbar for Visualizer interaction modes and view/debug toggles.
 *
 * Tooltips include the panel-local shortcut for each action.
 */

import { useStore } from "@nanostores/solid";
import { type Component, createSignal } from "solid-js";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "../../../components/ui/dropdown-menu";
import type { AppIcon } from "../../../components/ui/icon";
import PanelToolbar, {
  ToolbarSeparator,
} from "../../../components/ui/panel-toolbar";
import {
  TOOLBAR_BUTTON_CLASS,
  ToggleToolbarButton,
  ToolbarButton,
} from "../../../components/ui/toolbar-button";
import Tooltip from "../../../components/ui/tooltip";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import {
  removePatchBindingsForFixtureIds,
  sendDeleteFixture,
} from "../../../lib/fixture-service";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { setStoreAction } from "../../../lib/nanostore-action";
import { deleteSceneObject } from "../../../lib/scene-object-service";
import {
  bindings,
  fixtures,
  programmerSelection,
  sceneObjects,
  visualizerSceneObjectSelection,
} from "../../../state/appStores";
import { useObjectPatchWizard } from "../../object-library";
import { usePatchWizard } from "../../patch";
import { useVisualizerContext } from "../context/visualizer-context";
import type { VisualizerInteractionMode } from "../rendering/renderers/renderer-api";

/**
 * Primary interaction tools in toolbar display order.
 */
const TOOL_OPTIONS: ReadonlyArray<{
  mode: VisualizerInteractionMode;
  label: string;
  icon: AppIcon;
  shortcut: string;
}> = [
  { mode: "camera", label: "Camera", icon: VideoCameraIcon, shortcut: "C" },
  {
    mode: "measure",
    label: "Measure",
    icon: RulerIcon,
    shortcut: "Shift+M",
  },
  { mode: "move", label: "Move", icon: ArrowsOutCardinalIcon, shortcut: "M" },
  { mode: "rotate", label: "Rotate", icon: DeviceRotateIcon, shortcut: "T" },
  {
    mode: "select",
    label: "Select",
    icon: SelectionIcon,
    shortcut: "S",
  },
];

/**
 * Renders tool mode buttons plus emitter/label/grid toggles.
 */
export const VisualizerToolToolbar: Component = () => {
  const clearMapping = createActionMappingTarget(() => ({
    action: { id: "programmer.clear", arguments: {} },
    label: "Clear programmer",
  }));
  const context = useVisualizerContext();
  const { openWizard: openFixtureWizard } = usePatchWizard();
  const { openWizard: openObjectWizard } = useObjectPatchWizard();
  const $programmerSelection = useStore(programmerSelection);
  const $visualizerSceneObjectSelection = useStore(
    visualizerSceneObjectSelection,
  );
  const $fixtures = useStore(fixtures);
  const $sceneObjects = useStore(sceneObjects);
  const $bindings = useStore(bindings);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = createSignal(false);

  /** Selected fixture IDs. */
  const selectedFixtureIds = () => {
    const fixtureMap = $fixtures();
    const ids = $programmerSelection()
      .map((uid) => fixtureMap[uid]?.identifiers.id)
      .filter((id): id is number => id !== undefined);
    return Array.from(new Set(ids));
  };

  /** Selected scene object IDs. */
  const selectedSceneObjectIds = () => {
    const objectMap = $sceneObjects();
    const ids = $visualizerSceneObjectSelection()
      .map((uid) => objectMap[uid]?.identifiers.id)
      .filter((id): id is number => id !== undefined);
    return Array.from(new Set(ids));
  };

  const selectedDeleteCount = () =>
    selectedFixtureIds().length + selectedSceneObjectIds().length;

  const selectedFixtureCount = () => selectedFixtureIds().length;

  const selectedSceneObjectCount = () => selectedSceneObjectIds().length;

  const canDeleteSelection = () => selectedDeleteCount() > 0;

  const deleteConfirmMessage = () => {
    const fixtureCount = selectedFixtureCount();
    const sceneObjectCount = selectedSceneObjectCount();
    const parts: string[] = [];

    if (fixtureCount > 0) {
      parts.push(`${fixtureCount} fixtures`);
    }
    if (sceneObjectCount > 0) {
      parts.push(`${sceneObjectCount} scene objects`);
    }

    return `Delete ${parts.join(" and ")}? This can be undone in one step.`;
  };

  const openDeleteSelectionModal = () => {
    if (!canDeleteSelection()) {
      return;
    }
    setIsDeleteModalOpen(true);
  };

  const clearProgrammer = () => {
    setStoreAction(
      visualizerSceneObjectSelection,
      "Clear Visualizer Toolbar Selection",
      [],
    );
    context.sendProgrammerCommand({ type: "ClearProgrammer" });
  };

  useKeyboardShortcut({
    key: "Delete",
    handler: openDeleteSelectionModal,
    description: "Delete selected visualizer objects",
    componentId: context.panelId,
  });

  useKeyboardShortcut({
    key: "Backspace",
    handler: openDeleteSelectionModal,
    description: "Delete selected visualizer objects",
    componentId: context.panelId,
  });

  const confirmDeleteSelection = () => {
    if (!canDeleteSelection()) {
      setIsDeleteModalOpen(false);
      return;
    }

    const fixtureIds = selectedFixtureIds();
    const sceneObjectIds = selectedSceneObjectIds();
    const batchId = crypto.randomUUID();

    context.sendProgrammerCommand(
      { type: "ClearProgrammerSelection" },
      batchId,
    );
    setStoreAction(
      visualizerSceneObjectSelection,
      "Clear Deleted Visualizer Selection",
      [],
    );

    if (fixtureIds.length > 0) {
      removePatchBindingsForFixtureIds(
        fixtureIds,
        $bindings(),
        $fixtures(),
        batchId,
      );
      for (const fixtureId of fixtureIds) {
        sendDeleteFixture(fixtureId, batchId);
      }
    }

    for (const sceneObjectId of sceneObjectIds) {
      deleteSceneObject(sceneObjectId, batchId);
    }
    setIsDeleteModalOpen(false);
  };

  return (
    <>
      <PanelToolbar
        aria-label="Visualizer toolbar"
        rightClass="ml-auto"
        left={
          <>
            <DropdownMenu
              placement="below"
              triggerLabel="Add fixture or object"
              triggerClass={TOOLBAR_BUTTON_CLASS}
              trigger={
                <Tooltip content={() => "Add fixture or object"}>
                  <span class="inline-flex size-4 items-center justify-center">
                    <PlusIcon class="size-4" aria-hidden />
                  </span>
                </Tooltip>
              }
            >
              <DropdownMenuItem onClick={() => openFixtureWizard()}>
                <LightbulbIcon class="size-4" aria-hidden />
                <span>New Fixture</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={openObjectWizard}>
                <CubeIcon class="size-4" aria-hidden />
                <span>New Object</span>
              </DropdownMenuItem>
            </DropdownMenu>

            <ToolbarButton
              label={
                canDeleteSelection()
                  ? `Delete selected (${selectedDeleteCount()}) (Del/Backspace)`
                  : "Delete selected fixtures/scene objects"
              }
              classList={{
                "bg-red-500/20 text-red-100 hover:bg-red-500/30":
                  canDeleteSelection(),
                "cursor-not-allowed opacity-40": !canDeleteSelection(),
              }}
              disabled={!canDeleteSelection()}
              onClick={openDeleteSelectionModal}
            >
              <TrashIcon class="size-4" aria-hidden />
            </ToolbarButton>

            <ToolbarSeparator />

            <ToolbarButton
              ref={clearMapping}
              label="Clear programmer (selection first, then values)"
              onClick={clearProgrammer}
            >
              <EraserIcon class="size-4" aria-hidden />
            </ToolbarButton>
          </>
        }
        right={
          <>
            {TOOL_OPTIONS.map((option) => {
              const isActive = () => context.toolMode() === option.mode;
              return (
                <ToggleToolbarButton
                  label={`${option.label} (${option.shortcut})`}
                  pressed={isActive()}
                  onClick={() => context.setToolMode(option.mode)}
                >
                  <Dynamic component={option.icon} class="size-4" aria-hidden />
                </ToggleToolbarButton>
              );
            })}

            <ToolbarSeparator />

            <ToggleToolbarButton
              label={`${context.showEmitters() ? "Hide Emitters" : "Show Emitters"} (E)`}
              pressed={context.showEmitters()}
              onClick={() => context.setShowEmitters(!context.showEmitters())}
            >
              <SunIcon class="size-4" aria-hidden />
            </ToggleToolbarButton>

            <ToggleToolbarButton
              label={`${context.showLabels() ? "Hide Labels" : "Show Labels"} (L)`}
              pressed={context.showLabels()}
              onClick={() => context.setShowLabels(!context.showLabels())}
            >
              <InfoIcon class="size-4" aria-hidden />
            </ToggleToolbarButton>

            <ToggleToolbarButton
              label={`${context.showGrid() ? "Hide Grid" : "Show Grid"} (G)`}
              pressed={context.showGrid()}
              onClick={() => context.setShowGrid(!context.showGrid())}
            >
              <HashIcon class="size-4" aria-hidden />
            </ToggleToolbarButton>
          </>
        }
      />

      <DeleteConfirmModal
        isOpen={isDeleteModalOpen()}
        title="Delete selected visualizer objects"
        message={deleteConfirmMessage()}
        confirmLabel="Delete"
        onCancel={() => setIsDeleteModalOpen(false)}
        onConfirm={confirmDeleteSelection}
      />
    </>
  );
};
