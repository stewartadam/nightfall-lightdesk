// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import type { DockviewPanelApi } from "dockview";
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import PanelToolbar from "../../../components/ui/panel-toolbar";
import Tooltip from "../../../components/ui/tooltip";
import { Button } from "../../../components/ui/visual-language/button";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import { createDefaultFlowWaveform } from "../../../lib/fx-service";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import {
  fixtures as fixturesStore,
  fx as fxStore,
} from "../../../state/appStores";
import type * as types from "../../../types";
import { SpatialSelectionField } from "../../selection";
import { FxAttributePicker } from "../components/fx-attribute-picker";
import { WaveformEditor } from "../components/waveform-editor";
import { FxEditorProvider, useFxEditor } from "../context/fx-editor-context";
import { getFixtureAttributes as deriveAttributesFromFixtures } from "../model/fixture-attributes";

export interface FxEditorPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
  initialFxUid: string;
  panelApi?: DockviewPanelApi;
}

/**
 * Inner content component that uses the FxEditorContext.
 */
function FxEditorPanelContent(props: FxEditorPanelProps) {
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = createSignal(false);
  let bypassCloseGuard = false;
  const {
    uid,
    getWaveform,
    getAttributeKeys,
    getIsRelative,
    updateWaveform,
    setIsRelative,
    addAttribute,
    removeAttribute,
    selection,
    setSelection,
    isDirty,
    save,
    previewActive,
    setPreviewActive,
  } = useFxEditor();

  // Get FX label from store (context only stores local waveform state)
  const $fx = useStore(fxStore);
  const fxLabel = createMemo(() => {
    const currentUid = uid();
    const stored = $fx()[currentUid];
    return stored?.identifiers?.label ?? "Untitled FX";
  });

  const fixturesMap = useStore(fixturesStore);
  const availableAttributes = createMemo(() => {
    const sel = selection();
    if (!sel) return [] as string[];

    let matchedFixtures: types.Fixture[] = [];
    const allFixtures = Object.values(fixturesMap());
    if (sel.source.type === "Resolved") {
      const resolved = sel.source.data as types.FixtureRef[];
      matchedFixtures = allFixtures.filter((f) =>
        resolved.some((r) => r.fixture_uid === f.identifiers.uid),
      );
    } else {
      matchedFixtures = allFixtures;
    }

    return deriveAttributesFromFixtures(matchedFixtures);
  });

  onMount(() => {
    const panelApi = props.panelApi;
    if (!panelApi) return;

    const originalClose = panelApi.close.bind(panelApi);
    panelApi.close = () => {
      if (bypassCloseGuard || !isDirty()) {
        originalClose();
        return;
      }
      setIsCloseConfirmOpen(true);
    };

    onCleanup(() => {
      panelApi.close = originalClose;
    });
  });

  const confirmClose = () => {
    const panelApi = props.panelApi;
    setIsCloseConfirmOpen(false);
    if (!panelApi) return;

    bypassCloseGuard = true;
    try {
      panelApi.close();
    } finally {
      bypassCloseGuard = false;
    }
  };

  return (
    <div class="flex h-full min-h-0 flex-col">
      <Show
        when={uid()}
        fallback={
          <div class="flex h-full items-center justify-center text-neutral-500">
            No FX selected
          </div>
        }
      >
        <div class="flex h-full min-h-0 flex-col">
          <PanelToolbar
            left={
              <div class="truncate px-1 text-sm font-medium text-neutral-200">
                {fxLabel()}
              </div>
            }
            right={
              <div class="ml-auto flex items-center gap-0.5">
                <Tooltip
                  content={() =>
                    previewActive() ? "Stop preview" : "Start preview"
                  }
                >
                  <Button
                    type="button"
                    size="icon"
                    variant={previewActive() ? "primary" : "subtle"}
                    aria-label="Toggle FX preview"
                    aria-pressed={previewActive()}
                    onClick={() => setPreviewActive(!previewActive())}
                  >
                    <Dynamic
                      component={previewActive() ? StopIcon : PlayIcon}
                      class="size-4"
                      aria-hidden
                    />
                  </Button>
                </Tooltip>

                <Tooltip content={() => "Save FX changes"}>
                  <Button
                    type="button"
                    onClick={save}
                    size="compact"
                    variant="primary"
                    disabled={!isDirty()}
                  >
                    Save
                  </Button>
                </Tooltip>
              </div>
            }
          />

          <div class="min-h-0 flex-1 overflow-auto p-4">
            <div class="flex flex-col gap-4">
              {/* Fixture selection */}
              <Show when={selection()}>
                {(sel) => (
                  <SpatialSelectionField
                    selection={sel()}
                    onChange={(s) => setSelection(s)}
                  />
                )}
              </Show>

              {/* Attribute selection */}
              <FxAttributePicker
                selectedAttributes={getAttributeKeys()}
                onChange={(attrs) => {
                  const existing = new Set(getAttributeKeys());
                  // Add any new attributes
                  for (const a of attrs) {
                    if (!existing.has(a)) {
                      // Create a default FlowWaveform when adding
                      addAttribute(a, createDefaultFlowWaveform(), false);
                    }
                  }

                  // Remove attributes that were unselected
                  for (const a of getAttributeKeys()) {
                    if (!attrs.includes(a)) {
                      removeAttribute(a);
                    }
                  }
                }}
                availableAttributes={availableAttributes()}
              />

              {/* Attribute waveforms */}
              <For each={getAttributeKeys()}>
                {(attr) => {
                  const waveform = () => getWaveform(attr);
                  return (
                    <Show when={waveform()}>
                      {(wf) => (
                        <WaveformEditor
                          title={attr}
                          waveform={wf()}
                          onWaveformChange={(updates) =>
                            updateWaveform(attr, updates)
                          }
                          showRelative={true}
                          isRelative={getIsRelative(attr)}
                          onRelativeChange={(rel) => setIsRelative(attr, rel)}
                        />
                      )}
                    </Show>
                  );
                }}
              </For>

              {/* Empty state for no attributes */}
              <Show when={getAttributeKeys().length === 0}>
                <div class="flex flex-col items-center justify-center py-8 text-neutral-500">
                  <p>No attributes configured</p>
                  <p class="text-sm">Add attributes to get started</p>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <DeleteConfirmModal
        isOpen={isCloseConfirmOpen()}
        title="Discard unsaved FX changes?"
        message="You have unsaved changes. Close without saving?"
        confirmLabel="Discard"
        onCancel={() => setIsCloseConfirmOpen(false)}
        onConfirm={confirmClose}
      />
    </div>
  );
}

/**
 * Main FX Editor panel component.
 * Wraps content in FxEditorProvider for local state management.
 */
export default function FxEditorPanel(props: FxEditorPanelProps) {
  return (
    <FxEditorProvider initialFxUid={props.initialFxUid ?? ""}>
      <FxEditorPanelContent {...props} />
    </FxEditorProvider>
  );
}
