// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { CloudArrowUpIcon } from "@squidlab/phosphor-solid/cloud-arrow-up";
import { createEffect, createSignal, For, on, Show } from "solid-js";
import {
  Dialog,
  DialogBody,
  DialogCancelButton,
  DialogFooter,
} from "../../../components/ui/dialog";
import {
  Checkbox,
  Input,
  NativeSelect,
} from "../../../components/ui/form-controls";
import { ProgressBar } from "../../../components/ui/progress-bar";
import { Table, TableScroll } from "../../../components/ui/table";
import { Button } from "../../../components/ui/visual-language/button";
import { getLogger } from "../../../lib/logger";
import { fixtureLibrary } from "../../../state/appStores";
import { pushToast } from "../../../state/notifications";
import * as types from "../../../types";
import { revealPatchFixtures } from "../../patch";
import {
  fixtureStatusLabel,
  fixtureTypeNeedsChoice,
  fixtureTypeStatusLabel,
  formatPatch,
  formatPosition,
  libraryKey,
  type NumberingChoice,
  numberingOption,
  rigImportDialogOpen,
  withMappingMode,
  withTypeMapping,
} from "../model/rig-import-model";
import {
  commitRig,
  discardRig,
  previewRig,
  uploadRigFile,
} from "../services/rig-import-service";

const log = getLogger(import.meta.url);

/** Where the dialog is in the import. */
type Stage = "pick" | "upload" | "preview" | "import";

/**
 * Imports a rig from an MVR file: pick the file, review what the engine plans to do with it,
 * then import.
 *
 * Everything shown in the review (fixture type sources, IDs, statuses) comes from the engine's
 * preview; changing an option asks for a new preview rather than recomputing anything here.
 */
export function RigImportDialog() {
  const open = useStore(rigImportDialogOpen);
  const library = useStore(fixtureLibrary);
  const [stage, setStage] = createSignal<Stage>("pick");
  const [progress, setProgress] = createSignal(0);
  const [error, setError] = createSignal<string>();
  const [session, setSession] = createSignal<string>();
  const [preview, setPreview] = createSignal<types.RigImportPreview>();
  const [numbering, setNumbering] = createSignal<NumberingChoice>("FromFile");
  const [numberingValue, setNumberingValue] = createSignal(1);
  const [addToUserLibrary, setAddToUserLibrary] = createSignal(false);
  const [mappings, setMappings] = createSignal<types.FixtureTypeMapping[]>([]);
  const [dragging, setDragging] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;
  let previewRequest = 0;

  /** Collects the dialog's choices into the options the engine plans with. */
  const options = (): types.RigImportOptions => ({
    numbering: numberingOption(numbering(), numberingValue()),
    addToUserLibrary: addToUserLibrary(),
    typeMappings: mappings(),
  });

  /** Puts the dialog back to its first step, forgetting any read rig. */
  const reset = () => {
    const current = session();
    if (current) discardRig(current);
    previewRequest += 1;
    setSession(undefined);
    setPreview(undefined);
    setError(undefined);
    setProgress(0);
    setNumbering("FromFile");
    setNumberingValue(1);
    setAddToUserLibrary(false);
    setMappings([]);
    setStage("pick");
  };

  /** Closes the dialog unless an upload or import is running. */
  const close = () => {
    if (stage() === "upload" || stage() === "import") return;
    reset();
    rigImportDialogOpen.set(false);
  };

  /** Uploads the chosen file and shows the engine's first preview of it. */
  const readFile = async (file: File) => {
    setError(undefined);
    setStage("upload");
    setProgress(0);
    try {
      const id = await uploadRigFile(file, setProgress);
      setSession(id);
      await refreshPreview();
      setStage("preview");
    } catch (failure) {
      log.warn(`Reading ${file.name} failed: ${String(failure)}`);
      setError(failure instanceof Error ? failure.message : String(failure));
      setStage("pick");
    }
  };

  /** Asks the engine for a preview with the current options, ignoring replies that a later request replaced. */
  const refreshPreview = async () => {
    const id = session();
    if (!id) return;
    const request = ++previewRequest;
    try {
      const next = await previewRig(id, options());
      if (request === previewRequest) setPreview(next);
    } catch (failure) {
      if (request === previewRequest) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    }
  };

  /** Re-plans the import whenever an option changes after the first preview. */
  createEffect(
    on(
      [numbering, numberingValue, addToUserLibrary, mappings],
      () => {
        if (stage() === "preview") void refreshPreview();
      },
      { defer: true },
    ),
  );

  /** Imports the rig, then reveals the new fixtures in the patch and closes. */
  const runImport = async () => {
    const id = session();
    const current = preview();
    if (!id || !current || current.newFixtures === 0) return;
    setStage("import");
    setError(undefined);
    try {
      await commitRig(id, options());
      const ids = current.fixtures
        .filter((fixture) => fixture.status === types.FixtureImportStatus.New)
        .map((fixture) => fixture.fixtureId)
        .filter((fixtureId): fixtureId is number => fixtureId !== undefined);
      pushToast(
        "success",
        `Imported ${ids.length} fixtures from ${current.fileName}`,
      );
      revealPatchFixtures(ids);
      setStage("preview");
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setStage("preview");
    }
  };

  /** Opens the file picker. */
  const chooseFile = () => fileInput?.click();

  const importCount = () => preview()?.newFixtures ?? 0;
  const hasEmbeddedTypes = () =>
    preview()?.fixtureTypes.some((type) => type.status.type === "Embedded") ??
    false;

  return (
    <Dialog
      kind="task"
      isOpen={open()}
      usePortal={false}
      title="Import Rig from MVR"
      closeLabel="Close rig import dialog"
      class="max-w-5xl max-h-[90vh]"
      busy={stage() === "upload" || stage() === "import"}
      onDismiss={close}
      onSubmit={() => {
        if (stage() === "preview") void runImport();
      }}
    >
      <DialogBody class="flex max-h-[calc(90vh-8rem)] flex-col gap-4 overflow-y-auto">
        <input
          ref={(element) => {
            fileInput = element;
          }}
          class="hidden"
          type="file"
          accept=".mvr"
          data-testid="rig-import-file"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void readFile(file);
          }}
        />
        <Show when={error()}>
          {(message) => (
            <p
              role="alert"
              class="rounded border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-200"
            >
              {message()}
            </p>
          )}
        </Show>

        <Show when={stage() === "pick"}>
          <div
            role="button"
            tabIndex={0}
            aria-label="Choose an MVR file"
            class={`flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-6 text-center outline-none transition-colors ${
              dragging()
                ? "border-blue-400 bg-blue-500/10"
                : "border-neutral-600 hover:border-neutral-500"
            }`}
            onClick={chooseFile}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                chooseFile();
              }
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer?.files[0];
              if (file) void readFile(file);
            }}
          >
            <CloudArrowUpIcon class="mb-3 size-12 text-gray-500" aria-hidden />
            <p class="text-sm font-medium text-gray-300">
              Drop an .mvr file here or click to browse
            </p>
            <p class="mt-1 text-xs text-gray-500">
              Exported from Vectorworks, Capture, grandMA3 or another MVR tool.
              The fixtures are added to the current show.
            </p>
          </div>
        </Show>

        <Show when={stage() === "upload"}>
          <div class="flex flex-col gap-2 py-6">
            <p class="text-sm text-gray-300">
              {progress() < 1 ? "Uploading…" : "Reading the rig…"}
            </p>
            <ProgressBar
              label="Rig upload progress"
              value={progress() < 1 ? progress() : undefined}
              max={progress() < 1 ? 1 : null}
            />
          </div>
        </Show>

        <Show
          when={(stage() === "preview" || stage() === "import") && preview()}
        >
          {(current) => (
            <>
              <p class="text-sm text-gray-300" data-testid="rig-import-summary">
                {current().fileName}
                <Show when={current().provider}>
                  {(provider) => (
                    <span class="text-gray-500"> from {provider()}</span>
                  )}
                </Show>
                {": "}
                {current().newFixtures} of {current().fixtures.length} fixtures
                will be added.
              </p>
              <Show when={current().warnings.length > 0}>
                <ul class="list-disc pl-5 text-xs text-amber-300">
                  <For each={current().warnings}>
                    {(warning) => <li>{warning}</li>}
                  </For>
                </ul>
              </Show>

              <div class="flex flex-wrap items-end gap-3 rounded border border-gray-700 bg-gray-950 px-3 py-3">
                <label class="flex min-w-48 flex-col gap-1 text-xs font-medium uppercase text-gray-400">
                  Fixture IDs
                  <NativeSelect
                    aria-label="Fixture numbering"
                    value={numbering()}
                    onChange={(event) =>
                      setNumbering(event.currentTarget.value as NumberingChoice)
                    }
                  >
                    <option value="FromFile">Keep IDs from the file</option>
                    <option value="Offset">Offset IDs from the file</option>
                    <option value="Sequential">Number in order</option>
                  </NativeSelect>
                </label>
                <Show when={numbering() !== "FromFile"}>
                  <label class="flex w-32 flex-col gap-1 text-xs font-medium uppercase text-gray-400">
                    {numbering() === "Offset" ? "Add" : "Start at"}
                    <Input
                      type="number"
                      min={numbering() === "Offset" ? 0 : 1}
                      aria-label={
                        numbering() === "Offset" ? "ID offset" : "First ID"
                      }
                      value={numberingValue()}
                      onChange={(event) =>
                        setNumberingValue(Number(event.currentTarget.value))
                      }
                    />
                  </label>
                </Show>
                <Show when={hasEmbeddedTypes()}>
                  <label class="flex items-center gap-2 text-sm text-gray-300">
                    <Checkbox
                      checked={addToUserLibrary()}
                      onChange={(event) =>
                        setAddToUserLibrary(event.currentTarget.checked)
                      }
                    />
                    Also add the file's fixture types to my library
                  </label>
                </Show>
              </div>

              <section class="flex flex-col gap-2">
                <h3 class="text-xs font-semibold uppercase text-gray-400">
                  Fixture types
                </h3>
                <div class="overflow-hidden rounded border border-gray-700">
                  <Table aria-label="Fixture types in the rig">
                    <thead class="text-left">
                      <tr>
                        <th scope="col">Type in file</th>
                        <th scope="col">Fixture</th>
                        <th scope="col" class="w-28">
                          Source
                        </th>
                        <th scope="col" class="w-20 text-right">
                          Count
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={current().fixtureTypes}>
                        {(type) => {
                          const mapping = () =>
                            mappings().find(
                              (candidate) => candidate.spec === type.spec,
                            );
                          const mappedModes = () =>
                            library().find(
                              (fixture) =>
                                fixture.make === mapping()?.make &&
                                fixture.model === mapping()?.model &&
                                fixture.asset_etag === mapping()?.revision,
                            )?.modes ?? [];
                          return (
                            <tr>
                              <td class="font-mono text-xs">{type.spec}</td>
                              <td>
                                <Show
                                  when={
                                    fixtureTypeNeedsChoice(type.status) ||
                                    mapping()
                                  }
                                  fallback={`${type.make ?? ""} ${type.model ?? ""}`}
                                >
                                  <div class="flex flex-wrap gap-2">
                                    <NativeSelect
                                      aria-label={`Library fixture for ${type.spec}`}
                                      value={(() => {
                                        const current = mapping();
                                        if (!current) return "";
                                        return JSON.stringify([
                                          current.make,
                                          current.model,
                                          current.revision,
                                        ]);
                                      })()}
                                      onChange={(event) =>
                                        setMappings(
                                          withTypeMapping(
                                            mappings(),
                                            type.spec,
                                            event.currentTarget.value,
                                            library(),
                                          ),
                                        )
                                      }
                                    >
                                      <option value="">
                                        Choose a library fixture…
                                      </option>
                                      <For each={library()}>
                                        {(fixture) => (
                                          <option value={libraryKey(fixture)}>
                                            {fixture.make} {fixture.model}
                                          </option>
                                        )}
                                      </For>
                                    </NativeSelect>
                                    <Show when={mapping()}>
                                      {(current) => (
                                        <NativeSelect
                                          aria-label={`Mode for ${type.spec}`}
                                          value={current().mode}
                                          onChange={(event) =>
                                            setMappings(
                                              withMappingMode(
                                                mappings(),
                                                type.spec,
                                                event.currentTarget.value,
                                              ),
                                            )
                                          }
                                        >
                                          <For each={mappedModes()}>
                                            {(mode) => (
                                              <option value={mode}>
                                                {mode}
                                              </option>
                                            )}
                                          </For>
                                        </NativeSelect>
                                      )}
                                    </Show>
                                  </div>
                                </Show>
                              </td>
                              <td
                                title={
                                  type.status.type === "Unreadable"
                                    ? type.status.data.reason
                                    : undefined
                                }
                              >
                                {fixtureTypeStatusLabel(type.status)}
                              </td>
                              <td class="text-right">{type.fixtureCount}</td>
                            </tr>
                          );
                        }}
                      </For>
                    </tbody>
                  </Table>
                </div>
              </section>

              <section class="flex min-h-0 flex-col gap-2">
                <h3 class="text-xs font-semibold uppercase text-gray-400">
                  Fixtures
                </h3>
                <TableScroll
                  aria-label="Fixtures in the rig"
                  class="max-h-80 rounded border border-gray-700"
                >
                  <Table aria-label="Fixtures in the rig">
                    <thead class="text-left">
                      <tr>
                        <th scope="col" class="w-16">
                          ID
                        </th>
                        <th scope="col">Name</th>
                        <th scope="col">Mode</th>
                        <th scope="col">Patch</th>
                        <th scope="col">Position (m)</th>
                        <th scope="col">Layer</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={current().fixtures}>
                        {(fixture) => (
                          <tr
                            title={fixture.warnings.join("\n") || undefined}
                            data-status={fixture.status}
                          >
                            <td>{fixture.fixtureId ?? "–"}</td>
                            <td>{fixture.label || fixture.name}</td>
                            <td>{fixture.mode ?? "–"}</td>
                            <td>{formatPatch(fixture.patch)}</td>
                            <td class="font-mono text-xs">
                              {formatPosition(fixture.placement)}
                            </td>
                            <td>{fixture.hangingPosition ?? fixture.layer}</td>
                            <td>
                              {fixtureStatusLabel(fixture.status)}
                              <Show when={fixture.warnings.length > 0}>
                                <span class="text-amber-400"> ⚠</span>
                              </Show>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </Table>
                </TableScroll>
              </section>
            </>
          )}
        </Show>
      </DialogBody>

      <DialogFooter>
        <Show when={stage() === "preview" || stage() === "import"}>
          <Button type="button" onClick={reset} disabled={stage() === "import"}>
            Choose another file
          </Button>
        </Show>
        <DialogCancelButton />
        <Button
          variant="primary"
          type="button"
          disabled={stage() !== "preview" || importCount() === 0}
          onClick={() => void runImport()}
        >
          {stage() === "import"
            ? "Importing…"
            : importCount() > 0
              ? `Import ${importCount()} fixtures`
              : "Import"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
