// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CloudArrowUpIcon } from "@squidlab/phosphor-solid/cloud-arrow-up";
import { createSignal, For, Show } from "solid-js";
import {
  DialogBackdrop,
  DialogBody,
  DialogCloseButton,
  DialogFooter,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../../../components/ui/dialog";
import { NativeSelect } from "../../../components/ui/form-controls";
import { Table } from "../../../components/ui/table";
import { Button } from "../../../components/ui/visual-language/button";
import {
  type ShowfileImportOptions,
  ShowfileImportPolicy,
} from "../../../types";

type ImportPolicyKey = Exclude<keyof ShowfileImportOptions, "path">;
type NativePathFile = File & { path?: string; webkitRelativePath?: string };

interface ShowfileImportModalProps {
  open: boolean;
  onClose: () => void;
  onImport: (options: ShowfileImportOptions) => void;
}

const FULL_POLICY_OPTIONS: ShowfileImportPolicy[] = [
  ShowfileImportPolicy.Skip,
  ShowfileImportPolicy.Merge,
  ShowfileImportPolicy.Replace,
  ShowfileImportPolicy.Overwrite,
];

const LIST_POLICY_OPTIONS: ShowfileImportPolicy[] = [
  ShowfileImportPolicy.Skip,
  ShowfileImportPolicy.Merge,
  ShowfileImportPolicy.Overwrite,
];

const REPLACE_ONLY_POLICY_OPTIONS: ShowfileImportPolicy[] = [
  ShowfileImportPolicy.Skip,
  ShowfileImportPolicy.Overwrite,
];
const SHOWFILE_SNAPSHOT_FILENAME = "showfile.json";

const IMPORT_ROWS: Array<{
  key: ImportPolicyKey;
  label: string;
  policies: ShowfileImportPolicy[];
}> = [
  { key: "fixtures", label: "Fixtures / Patch", policies: FULL_POLICY_OPTIONS },
  { key: "variables", label: "Variables", policies: FULL_POLICY_OPTIONS },
  { key: "settings", label: "Settings", policies: REPLACE_ONLY_POLICY_OPTIONS },
  { key: "bindings", label: "Bindings", policies: LIST_POLICY_OPTIONS },
  {
    key: "midi_mappings",
    label: "MIDI Mappings",
    policies: LIST_POLICY_OPTIONS,
  },
  { key: "osc_mappings", label: "OSC Mappings", policies: LIST_POLICY_OPTIONS },
  {
    key: "scene_objects",
    label: "Scene Objects",
    policies: FULL_POLICY_OPTIONS,
  },
  { key: "cues", label: "Cues", policies: FULL_POLICY_OPTIONS },
  { key: "sequences", label: "Sequences", policies: FULL_POLICY_OPTIONS },
  { key: "groups", label: "Groups", policies: FULL_POLICY_OPTIONS },
  { key: "masters", label: "Masters", policies: FULL_POLICY_OPTIONS },
  { key: "blueprints", label: "Blueprints", policies: FULL_POLICY_OPTIONS },
  { key: "color_paths", label: "Color Paths", policies: FULL_POLICY_OPTIONS },
  { key: "fx", label: "FX", policies: FULL_POLICY_OPTIONS },
  {
    key: "fx_module",
    label: "FX Modules",
    policies: REPLACE_ONLY_POLICY_OPTIONS,
  },
  { key: "step_fx", label: "Step FX", policies: FULL_POLICY_OPTIONS },
  { key: "flows", label: "Flows", policies: FULL_POLICY_OPTIONS },
  { key: "timecodes", label: "Timecodes", policies: FULL_POLICY_OPTIONS },
  { key: "timelines", label: "Timelines", policies: FULL_POLICY_OPTIONS },
  { key: "clips", label: "Clips", policies: FULL_POLICY_OPTIONS },
];

/** Build the default showfile import options used by the modal. */
function defaultImportOptions(): ShowfileImportOptions {
  return {
    path: undefined,
    fixtures: ShowfileImportPolicy.Merge,
    variables: ShowfileImportPolicy.Merge,
    settings: ShowfileImportPolicy.Skip,
    bindings: ShowfileImportPolicy.Merge,
    midi_mappings: ShowfileImportPolicy.Merge,
    osc_mappings: ShowfileImportPolicy.Merge,
    scene_objects: ShowfileImportPolicy.Merge,
    cues: ShowfileImportPolicy.Merge,
    sequences: ShowfileImportPolicy.Merge,
    groups: ShowfileImportPolicy.Merge,
    masters: ShowfileImportPolicy.Merge,
    blueprints: ShowfileImportPolicy.Merge,
    color_paths: ShowfileImportPolicy.Merge,
    fx: ShowfileImportPolicy.Merge,
    fx_module: ShowfileImportPolicy.Overwrite,
    step_fx: ShowfileImportPolicy.Merge,
    flows: ShowfileImportPolicy.Merge,
    timecodes: ShowfileImportPolicy.Skip,
    timelines: ShowfileImportPolicy.Skip,
    clips: ShowfileImportPolicy.Merge,
  };
}

/** Render the selective showfile import dialog. */
export function ShowfileImportModal(props: ShowfileImportModalProps) {
  const [options, setOptions] = createSignal(defaultImportOptions());
  const [bulkPolicy, setBulkPolicy] = createSignal(ShowfileImportPolicy.Merge);
  const [isDraggingPath, setIsDraggingPath] = createSignal(false);
  let fileInputRef: HTMLInputElement | undefined;

  /** Update the source showfile path. */
  const setPath = (path: string) => {
    setOptions((current) => ({
      ...current,
      path: path.trim() === "" ? undefined : path,
    }));
  };

  /** Update one object-type import policy. */
  const setPolicy = (key: ImportPolicyKey, policy: ShowfileImportPolicy) => {
    setOptions((current) => ({ ...current, [key]: policy }));
  };

  /** Apply the selected bulk policy to every import row that supports it. */
  const applyBulkPolicy = () => {
    setOptions((current) => {
      const next = { ...current };
      const policy = bulkPolicy();
      for (const row of IMPORT_ROWS) {
        if (row.policies.includes(policy)) {
          next[row.key] = policy;
        }
      }
      return next;
    });
  };

  /** Extract a usable path from selected files when the runtime exposes one. */
  const pathFromFiles = (files: File[]): string | undefined => {
    const nativeFiles = files as NativePathFile[];
    const snapshotFile =
      nativeFiles.find((file) => file.name === SHOWFILE_SNAPSHOT_FILENAME) ??
      nativeFiles[0];
    if (!snapshotFile) return undefined;

    if (snapshotFile.path) return snapshotFile.path;
    if (snapshotFile.webkitRelativePath) return snapshotFile.webkitRelativePath;
    return snapshotFile.name;
  };

  /** Apply the first dropped path-like payload to the import source. */
  const setPathFromDrop = (dataTransfer: DataTransfer) => {
    const droppedTextPath = dataTransfer.getData("text/plain").trim();
    if (droppedTextPath !== "") {
      setPath(droppedTextPath);
      return;
    }

    const path = pathFromFiles(Array.from(dataTransfer.files));
    if (path) setPath(path);
  };

  /** Open the native file picker exposed by Tauri's webview file input integration. */
  const chooseShowfile = () => {
    fileInputRef?.click();
  };

  /** Submit the current import options and close the modal. */
  const submitImport = () => {
    props.onImport(options());
    props.onClose();
  };

  return (
    <Show when={props.open}>
      <DialogBackdrop
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
      >
        <DialogSurface
          role="dialog"
          aria-modal="true"
          aria-label="Import Showfile"
          class="max-w-3xl max-h-[86vh]"
        >
          <DialogHeader>
            <DialogTitle>Import Showfile</DialogTitle>
            <DialogCloseButton
              type="button"
              aria-label="Close import showfile dialog"
              onClick={props.onClose}
            />
          </DialogHeader>

          <DialogBody class="max-h-[calc(86vh-8rem)] overflow-y-auto">
            <input
              ref={(element) => {
                fileInputRef = element;
                element.setAttribute("webkitdirectory", "");
                element.setAttribute("directory", "");
              }}
              class="hidden"
              type="file"
              onChange={(event) => {
                const path = pathFromFiles(
                  Array.from(event.currentTarget.files ?? []),
                );
                if (path) setPath(path);
                event.currentTarget.value = "";
              }}
            />
            <div
              id="showfile-import-path"
              role="button"
              tabIndex={0}
              aria-label="Showfile Path"
              class={`flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-6 text-center outline-none transition-colors ${
                isDraggingPath()
                  ? "border-blue-400 bg-blue-500/10"
                  : "border-neutral-600 hover:border-neutral-500"
              }`}
              onClick={chooseShowfile}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  chooseShowfile();
                }
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDraggingPath(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDraggingPath(true);
              }}
              onDragLeave={(event) => {
                if (event.currentTarget === event.target) {
                  setIsDraggingPath(false);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                setIsDraggingPath(false);
                if (event.dataTransfer) setPathFromDrop(event.dataTransfer);
              }}
            >
              <CloudArrowUpIcon
                class="mb-3 size-12 text-gray-500"
                aria-hidden
              />
              <Show
                when={options().path}
                fallback={
                  <p class="text-sm font-medium text-gray-400">
                    Drop a .nightfall-show folder here or click to browse
                  </p>
                }
              >
                {(path) => (
                  <p class="max-w-full truncate font-mono text-sm text-gray-200">
                    {path()}
                  </p>
                )}
              </Show>
            </div>

            <div class="mt-4 flex flex-wrap items-end gap-3 rounded border border-gray-700 bg-gray-950 px-3 py-3">
              <label class="flex min-w-48 flex-1 flex-col gap-1 text-xs font-medium uppercase text-gray-400">
                Bulk Policy
                <NativeSelect
                  aria-label="Bulk import policy"
                  value={bulkPolicy()}
                  onChange={(event) =>
                    setBulkPolicy(
                      event.currentTarget.value as ShowfileImportPolicy,
                    )
                  }
                >
                  <For each={FULL_POLICY_OPTIONS}>
                    {(policy) => <option value={policy}>{policy}</option>}
                  </For>
                </NativeSelect>
              </label>
              <Button type="button" onClick={applyBulkPolicy}>
                Apply to all applicable rows
              </Button>
            </div>

            <div class="mt-4 overflow-hidden rounded border border-gray-700">
              <Table aria-label="Showfile import policies">
                <thead class="text-left">
                  <tr>
                    <th scope="col">Object Type</th>
                    <th scope="col" class="w-44">
                      Policy
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={IMPORT_ROWS}>
                    {(row) => (
                      <tr>
                        <td>{row.label}</td>
                        <td>
                          <NativeSelect
                            value={options()[row.key]}
                            aria-label={`${row.label} import policy`}
                            onChange={(event) =>
                              setPolicy(
                                row.key,
                                event.currentTarget
                                  .value as ShowfileImportPolicy,
                              )
                            }
                          >
                            <For each={row.policies}>
                              {(policy) => (
                                <option value={policy}>{policy}</option>
                              )}
                            </For>
                          </NativeSelect>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </Table>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button type="button" onClick={props.onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="button" onClick={submitImport}>
              Import
            </Button>
          </DialogFooter>
        </DialogSurface>
      </DialogBackdrop>
    </Show>
  );
}
