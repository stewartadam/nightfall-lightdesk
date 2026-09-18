// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { normalizeFixtureUid } from "../../../lib/binding-utils";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { measurePerformanceScope } from "../../../lib/performance-marks";
import { usePanelVisibility } from "../../../lib/use-panel-visibility";
import {
  useConditionalShallowStore,
  useShallowStore,
} from "../../../lib/use-shallow-store";
import {
  activeInstances,
  attributeMetadata,
  clearLayerNavigationRequest,
  clearLayerObjectNavigationRequest,
  cues,
  dockApi,
  fixtures,
  flows,
  fx,
  inputContributionTrace,
  layerNavigationRequest,
  layerObjectNavigationRequest,
  layerStack,
  requestSequenceNavigation,
  sequences,
} from "../../../state/appStores";
import * as types from "../../../types";
import { formatCueEditorTitle } from "../../cues";
import { InputContributionTrace } from "../components/input-contribution-trace";
import { LayerEntryList } from "../components/layer-entry-list";
import { LayerPanelToolbar } from "../components/layer-panel-toolbar";
import {
  collectLayerAttributeNames,
  layerAttributeSignature,
  layerHasDisplayContent,
  memoizeLayerColumns,
} from "../model/layer-display-data";
import {
  createLayerPanelEntry,
  getLayerExpansionKey,
  getLayerIdentityKey,
  type LayerPanelEntry,
  layerKeyListsEqual,
  layerSummariesEqual,
  summarizeLayer,
} from "./layer-panel-entries";

/** Coordinates layer stores, navigation commands, and stable row state. */
export function LayerPanelController(props: BasePanelComponentProps) {
  const panelId = props.id;
  const isPanelVisible = usePanelVisibility(props.panelApi);
  const $dockApi = useStore(dockApi);
  const $cues = useShallowStore(cues);
  const $fx = useStore(fx);
  const $flows = useStore(flows);
  const $activeInstances = useStore(activeInstances);
  const $attributeMetadata = useStore(attributeMetadata);
  const $sequences = useShallowStore(sequences);
  const $layersRaw = useConditionalShallowStore(layerStack, isPanelVisible);
  const $layerNavigationRequest = useStore(layerNavigationRequest);
  const $layerObjectNavigationRequest = useStore(layerObjectNavigationRequest);
  const $fixtures = useStore(fixtures);
  const $inputTrace = useStore(inputContributionTrace);
  const [openLayerKeys, setOpenLayerKeys] = createSignal<Set<string>>(
    new Set(),
  );
  /** Tracks whether the panel should render without exposing raw snapshot identity. */
  const layerCount = createMemo(() => $layersRaw().length);
  /** Keeps rendered layer rows keyed by logical layer identity instead of snapshot object identity. */
  const layerEntries = createMemo<LayerPanelEntry[]>((previous = []) => {
    return measurePerformanceScope("layer-panel.layer-entries", () => {
      const openKeys = openLayerKeys();
      const navigationLayerIndex = $layerNavigationRequest()?.layerIndex;
      const previousByKey = new Map(
        previous.map((entry) => [entry.key, entry]),
      );
      const layers = $layersRaw();
      const occurrenceByIdentity = new Map<string, number>();
      let changed = previous.length !== layers.length;
      const entries = layers.map((layer, index) => {
        const identity = getLayerIdentityKey(layer);
        const occurrence = occurrenceByIdentity.get(identity) ?? 0;
        occurrenceByIdentity.set(identity, occurrence + 1);
        const key = getLayerExpansionKey(identity, occurrence);
        const existing = previousByKey.get(key);
        if (previous[index]?.key !== key) {
          changed = true;
        }
        if (existing) {
          const nextSummary = summarizeLayer(layer);
          existing.setSummary((previousSummary) =>
            layerSummariesEqual(previousSummary, nextSummary)
              ? previousSummary
              : nextSummary,
          );
          if (openKeys.has(key) || navigationLayerIndex === index) {
            existing.setLayer(() => layer);
          }
          existing.setIndex(index);
          return existing;
        }

        changed = true;
        return createLayerPanelEntry(key, layer, index);
      });
      return changed ? entries : previous;
    });
  }, []);
  const layerVisibilityAttributes = () => {
    return measurePerformanceScope("layer-panel.visibility-attributes", () => {
      const attributes = new Set<string>();
      for (const layer of $layersRaw()) {
        for (const attribute of collectLayerAttributeNames(layer)) {
          attributes.add(attribute);
        }
      }

      const sortedAttributes = Array.from(attributes).sort();
      return {
        attributes: sortedAttributes,
        attributeSignature: layerAttributeSignature(sortedAttributes),
      };
    });
  };
  /** Returns global Layer Panel visibility columns when the column menu is open. */
  const layerVisibilityColumns = () => {
    const visibilityAttributes = layerVisibilityAttributes();
    return memoizeLayerColumns(
      visibilityAttributes.attributes,
      visibilityAttributes.attributeSignature,
      $attributeMetadata(),
    );
  };
  const contentLayerKeys = createMemo<string[]>((previous = []) => {
    return measurePerformanceScope("layer-panel.content-layer-keys", () => {
      const keys: string[] = [];
      const occurrenceByIdentity = new Map<string, number>();
      $layersRaw().forEach((layer) => {
        const identity = getLayerIdentityKey(layer);
        const occurrence = occurrenceByIdentity.get(identity) ?? 0;
        occurrenceByIdentity.set(identity, occurrence + 1);
        if (layerHasDisplayContent(layer)) {
          keys.push(getLayerExpansionKey(identity, occurrence));
        }
      });
      return layerKeyListsEqual(previous, keys) ? previous : keys;
    });
  });

  const normalizeUid = (uid: unknown): string =>
    normalizeFixtureUid(uid).toLowerCase();
  const openCueEditor = (cue: types.Cue) => {
    const sequence = Object.values($sequences()).find((entry) =>
      entry.steps.includes(cue.identifiers.uid),
    );
    openOrFocusPanel(
      `cue-list-panel-${cue.identifiers.uid}`,
      "CueEditor",
      formatCueEditorTitle({
        cueId: cue.identifiers.id,
        sequenceId: sequence?.identifiers.id,
        partId: 0,
        hasAdditionalParts: (cue.parts?.length ?? 0) > 0,
      }),
      {
        initialCueUid: cue.identifiers.uid,
        initialSequenceId: sequence?.identifiers.id,
        initialSequenceUid: sequence?.identifiers.uid,
      },
    );
  };

  const openProgrammerPanel = () => {
    openOrFocusPanel(
      "panel-ProgrammerGrid",
      "ProgrammerGrid",
      "Programmer",
      {},
    );
  };

  const isProgrammerLayer = (layer: types.OutboundLayerState): boolean => {
    if (
      layer.creator === "Programmer" ||
      layer.creator.startsWith("Programmer Instruction ")
    ) {
      return true;
    }

    return Object.values($activeInstances()).some(
      (playback) =>
        playback.kind === types.InstanceKind.Programmer &&
        playback.name === layer.creator,
    );
  };

  const resolveActiveCueForSequence = (
    sequenceUid: string,
  ): types.Cue | null => {
    const normalizedSequenceUid = normalizeUid(sequenceUid);
    const sequencePlayback = Object.values($activeInstances()).find(
      (playback) => {
        if (playback.kind !== types.InstanceKind.Sequence) {
          return false;
        }
        const objectRef = playback.object_ref;
        return (
          objectRef?.type === "ByUid" &&
          objectRef.data.object_type === types.ObjectType.Sequence &&
          normalizeUid(objectRef.data.uid) === normalizedSequenceUid
        );
      },
    );
    if (!sequencePlayback) {
      return null;
    }

    const position = sequencePlayback.status.position;
    const activeCueUid =
      position.type === "Sequence" ? position.data.current_cue_uid : undefined;
    if (!activeCueUid) {
      return null;
    }

    return (
      Object.values($cues()).find(
        (cue) =>
          normalizeUid(cue.identifiers.uid) === normalizeUid(activeCueUid),
      ) ?? null
    );
  };

  const openOrFocusPanel = (
    id: string,
    component: string,
    title: string,
    params: Record<string, unknown>,
    renderer?: "always" | "onlyWhenVisible",
  ) => {
    const api = $dockApi();
    if (!api) return;

    const panel = api.getPanel(id);
    if (panel) {
      panel.focus();
      return;
    }

    api.addPanel({
      id,
      component,
      title,
      params,
      renderer,
    });
  };

  const handleNavigateToLayerObject = (layer: types.OutboundLayerState) => {
    if (isProgrammerLayer(layer)) {
      openProgrammerPanel();
      return;
    }

    const objectRef = layer.object_ref;
    if (!objectRef) return;

    if (objectRef.type === "ByUid") {
      const uid = normalizeUid(objectRef.data.uid);

      if (objectRef.data.object_type === types.ObjectType.Cue) {
        const cue = Object.values($cues()).find(
          (item) => normalizeUid(item.identifiers.uid) === uid,
        );
        if (cue) {
          openCueEditor(cue);
        }
        return;
      }

      if (objectRef.data.object_type === types.ObjectType.Fx) {
        const fxEntry = Object.values($fx()).find(
          (item) => normalizeUid(item.identifiers.uid) === uid,
        );
        if (!fxEntry) return;
        openOrFocusPanel(
          `fx-editor-${fxEntry.identifiers.uid}`,
          "FxEditor",
          `FX ${fxEntry.identifiers.id}: ${fxEntry.identifiers.label}`,
          { initialFxUid: fxEntry.identifiers.uid },
        );
        return;
      }

      if (objectRef.data.object_type === types.ObjectType.Flow) {
        const flowEntry = Object.values($flows()).find(
          (item) => normalizeUid(item.identifiers.uid) === uid,
        );
        if (!flowEntry) return;
        openOrFocusPanel(
          `flow-editor-${flowEntry.identifiers.uid}`,
          "FlowEditor",
          `Flow ${flowEntry.identifiers.id}: ${flowEntry.identifiers.label}`,
          { initialFlowUid: flowEntry.identifiers.uid },
          "onlyWhenVisible",
        );
        return;
      }

      if (objectRef.data.object_type === types.ObjectType.Sequence) {
        const activeCue = resolveActiveCueForSequence(uid);
        if (activeCue) {
          openCueEditor(activeCue);
          return;
        }

        const sequence = Object.values($sequences()).find(
          (item) => normalizeUid(item.identifiers.uid) === uid,
        );
        if (!sequence) return;
        requestSequenceNavigation(sequence.identifiers.uid);
        openOrFocusPanel("panel-SequenceList", "SequenceList", "Sequences", {});
        return;
      }
    }
  };

  const handleLayerNavigationHandled = (requestId: number) => {
    clearLayerNavigationRequest(requestId);
  };

  const handleExpandAllLayers = () => {
    setOpenLayerKeys(new Set(contentLayerKeys()));
  };

  const handleCollapseAllLayers = () => {
    setOpenLayerKeys(new Set<string>());
  };

  const handleLayerOpenChange = (layerKey: string, isOpen: boolean) => {
    setOpenLayerKeys((prev) => {
      const next = new Set(prev);
      if (isOpen) {
        next.add(layerKey);
      } else {
        next.delete(layerKey);
      }
      return next;
    });
  };

  createEffect(() => {
    const request = $layerObjectNavigationRequest();
    if (!request) {
      return;
    }

    const layers = $layersRaw();
    if (layers.length === 0) {
      return;
    }

    if (request.layerIndex < 0 || request.layerIndex >= layers.length) {
      clearLayerObjectNavigationRequest(request.requestId);
      return;
    }

    const layer = layers[request.layerIndex];
    handleNavigateToLayerObject(layer);
    clearLayerObjectNavigationRequest(request.requestId);
  });

  createEffect(() => {
    const currentKeys = new Set(layerEntries().map((entry) => entry.key));
    setOpenLayerKeys((prev) => {
      const next = new Set(
        Array.from(prev).filter((key) => currentKeys.has(key)),
      );
      // This effect only prunes stale keys, so equal size means membership is unchanged.
      return next.size !== prev.size ? next : prev;
    });
  });

  return (
    <Show
      when={layerCount() > 0 || $inputTrace().length > 0}
      fallback={
        <div class="h-full w-full flex items-center justify-center text-gray-500">
          <div>
            <p class="text-center">Empty layer stack.</p>
            <p class="text-center text-sm mt-2">
              Start a clip/playback to continue.
            </p>
          </div>
        </div>
      }
    >
      <div
        class="flex h-full min-h-0 flex-col bg-neutral-900 text-white"
        data-panel-kind="layer"
        data-panel-id={panelId}
      >
        <LayerPanelToolbar
          canCollapse={openLayerKeys().size > 0}
          canExpand={contentLayerKeys().length > 0}
          columns={() => layerVisibilityColumns().columns}
          onCollapseAll={handleCollapseAllLayers}
          onExpandAll={handleExpandAllLayers}
          panelId={panelId}
        />

        <div class="min-h-0 flex-1 space-y-2 overflow-auto p-2">
          <InputContributionTrace
            fixtures={$fixtures()}
            trace={$inputTrace()}
          />
          <LayerEntryList
            entries={layerEntries()}
            navigationRequest={$layerNavigationRequest()}
            onNavigateToLayerObject={handleNavigateToLayerObject}
            onNavigationHandled={handleLayerNavigationHandled}
            onOpenChange={handleLayerOpenChange}
            openLayerKeys={openLayerKeys()}
            panelId={panelId}
          />
        </div>
      </div>
    </Show>
  );
}
