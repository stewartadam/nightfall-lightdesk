// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, For, Show } from "solid-js";
import {
  DialogBackdrop,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../../../components/ui/dialog";
import {
  Input,
  NativeSelect,
  Textarea,
} from "../../../components/ui/form-controls";
import Modal from "../../../components/ui/modal";
import { Button } from "../../../components/ui/visual-language/button";
import CrudLabelProperties from "../../../components/widgets/crud/crud-label-properties";
import { pushToast } from "../../../state/appStores";
import type * as types from "../../../types";
import { SpatialSelectionField } from "../../selection";
import {
  defaultModuleLabel,
  defaultSpatialSelection,
  type FxListEntry,
  formatConfigText,
  parseConfigText,
} from "../model/fx-list-model";

interface ModuleFxDialogProps {
  isOpen: boolean;
  modules: readonly types.AvailableFxModuleInfo[];
  nextId: number;
  onCancel: () => void;
  onCreate: (request: types.StoredFxModuleRequest) => void;
}

interface FxPropertiesPanelProps {
  entry: FxListEntry | null;
  moduleFx: types.StoredFxModule | null;
  onLabelCommit: (fxEntry: FxListEntry, label: string) => void;
  onModuleConfigCommit: (
    fxModule: types.StoredFxModule,
    config: Record<string, string>,
  ) => void;
  onModuleSelectionCommit: (
    fxModule: types.StoredFxModule,
    selection: types.SpatialSelection,
  ) => void;
}

/** Dialog for creating a stored module FX from discovered WebAssembly modules. */
export function ModuleFxDialog(props: ModuleFxDialogProps) {
  const [selectedModule, setSelectedModule] = createSignal("");
  const [idText, setIdText] = createSignal(String(props.nextId));
  const [label, setLabel] = createSignal("");
  const [configText, setConfigText] = createSignal("");
  const [initializedOpenDialog, setInitializedOpenDialog] = createSignal(false);

  /** Initializes dialog defaults on open and fills late-arriving catalogs without overwriting edits. */
  createEffect(() => {
    if (!props.isOpen) {
      setInitializedOpenDialog(false);
      return;
    }

    const firstModule = props.modules[0]?.name ?? "";
    if (!initializedOpenDialog()) {
      setInitializedOpenDialog(true);
      setSelectedModule(firstModule);
      setIdText(String(props.nextId));
      setLabel(defaultModuleLabel(firstModule));
      setConfigText("");
      return;
    }

    if (!selectedModule() && firstModule) {
      setSelectedModule(firstModule);
      if (!label()) {
        setLabel(defaultModuleLabel(firstModule));
      }
    }
  });

  /** Handles module selection changes and updates the default label when untouched. */
  const selectModule = (moduleName: string) => {
    const previousDefault = defaultModuleLabel(selectedModule());
    setSelectedModule(moduleName);
    if (!label() || label() === previousDefault) {
      setLabel(defaultModuleLabel(moduleName));
    }
  };

  /** Validates dialog fields and emits a store request for the new module FX. */
  const submit = () => {
    const id = Number.parseInt(idText(), 10);
    if (!Number.isInteger(id) || id <= 0) {
      pushToast("error", "FX id must be a positive integer.");
      return;
    }
    const moduleName = selectedModule();
    if (!moduleName) {
      pushToast("error", "Select a module before creating module FX.");
      return;
    }
    const config = parseConfigText(configText());
    if (typeof config === "string") {
      pushToast("error", config);
      return;
    }

    props.onCreate({
      identifiers: {
        id,
        uid: crypto.randomUUID().replace(/-/g, ""),
        label: label().trim() || defaultModuleLabel(moduleName),
      },
      module_name: moduleName,
      selection: defaultSpatialSelection(),
      config,
      merge: false,
    });
  };

  return (
    <Modal isOpen={props.isOpen} onEscape={props.onCancel}>
      <DialogBackdrop
        role="dialog"
        aria-modal="true"
        aria-label="Add Module FX"
      >
        <DialogSurface class="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Module FX</DialogTitle>
          </DialogHeader>
          <DialogBody class="space-y-4">
            <label class="block space-y-1 text-sm">
              <span class="text-neutral-300">Module</span>
              <NativeSelect
                value={selectedModule()}
                onInput={(event) => selectModule(event.currentTarget.value)}
              >
                <For each={props.modules}>
                  {(moduleInfo) => (
                    <option value={moduleInfo.name}>{moduleInfo.name}</option>
                  )}
                </For>
              </NativeSelect>
            </label>
            <div class="grid grid-cols-[110px_1fr] gap-3">
              <label class="block space-y-1 text-sm">
                <span class="text-neutral-300">ID</span>
                <Input
                  inputMode="numeric"
                  value={idText()}
                  onInput={(event) => setIdText(event.currentTarget.value)}
                />
              </label>
              <label class="block space-y-1 text-sm">
                <span class="text-neutral-300">Label</span>
                <Input
                  value={label()}
                  onInput={(event) => setLabel(event.currentTarget.value)}
                />
              </label>
            </div>
            <label class="block space-y-1 text-sm">
              <span class="text-neutral-300">Config</span>
              <Textarea
                class="min-h-32"
                spellcheck={false}
                value={configText()}
                onInput={(event) => setConfigText(event.currentTarget.value)}
              />
            </label>
            <Show when={props.modules.length === 0}>
              <div class="rounded border border-yellow-800 bg-yellow-950/40 px-3 py-2 text-sm text-yellow-100">
                No WebAssembly modules found in this showfile or the app data
                fx-modules directory.
              </div>
            </Show>
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={props.onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="button"
              disabled={props.modules.length === 0}
              onClick={submit}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogSurface>
      </DialogBackdrop>
    </Modal>
  );
}

/** Properties surface for regular labels and module FX configuration. */
export function FxPropertiesPanel(props: FxPropertiesPanelProps) {
  const [configText, setConfigText] = createSignal("");

  /** Keeps the configuration textarea aligned with the selected module FX. */
  createEffect(() => {
    setConfigText(formatConfigText(props.moduleFx?.config ?? {}));
  });

  /** Parses and stores edited configuration for the selected module FX. */
  const commitConfig = () => {
    const moduleFx = props.moduleFx;
    if (!moduleFx) return;
    const config = parseConfigText(configText());
    if (typeof config === "string") {
      pushToast("error", config);
      return;
    }
    props.onModuleConfigCommit(moduleFx, config);
  };

  return (
    <div class="space-y-4">
      <CrudLabelProperties
        entry={props.entry}
        entityName="Effect"
        getId={(fxEntry) => fxEntry.identifiers.id}
        getLabel={(fxEntry) => fxEntry.identifiers.label}
        onLabelCommit={props.onLabelCommit}
      />
      <Show when={props.moduleFx}>
        {(moduleFx) => (
          <div class="space-y-2">
            <div class="text-neutral-400 text-xs uppercase tracking-wide">
              Module
            </div>
            <div class="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-neutral-200 text-sm">
              {moduleFx().module_name}
            </div>
            <SpatialSelectionField
              selection={moduleFx().selection}
              label="Selection"
              class="flex min-w-0 flex-col gap-1"
              onChange={(selection) =>
                props.onModuleSelectionCommit(moduleFx(), selection)
              }
            />
            <label class="block space-y-1 text-sm">
              <span class="text-neutral-300">Config</span>
              <Textarea
                class="min-h-28"
                spellcheck={false}
                value={configText()}
                onInput={(event) => setConfigText(event.currentTarget.value)}
              />
            </label>
            <Button type="button" onClick={commitConfig}>
              Save Config
            </Button>
          </div>
        )}
      </Show>
    </div>
  );
}
