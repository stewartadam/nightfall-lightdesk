// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { CaretLeftIcon } from "@squidlab/phosphor-solid/caret-left";
import { CloudArrowUpIcon } from "@squidlab/phosphor-solid/cloud-arrow-up";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { Alert } from "../../../components/ui/alert";
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
import { SegmentedTabs } from "../../../components/ui/segmented-tabs";
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
  GROUP_SOURCE_OPTIONS,
  importBlockedReason,
  importDoneMessage,
  libraryKey,
  type NumberingChoice,
  numberingOption,
  previewHasChanges,
  RIG_IMPORT_TAB_LABELS,
  type RigImportTab,
  rigImportDialogOpen,
  rigImportTabCount,
  rigImportTabs,
  sceneryKindLabel,
  sceneryStatusLabel,
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

/** Fills the tab panel with the active tab's table, which scrolls on its own. */
const TAB_TABLE_CLASS = "min-h-0 flex-1 rounded border border-gray-700";

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
  const [updateExisting, setUpdateExisting] = createSignal(true);
  const [groupSource, setGroupSource] = createSignal<types.RigGroupSource>(
    types.RigGroupSource.Auto,
  );
  const [scenery, setScenery] = createSignal(true);
  const [mappings, setMappings] = createSignal<types.FixtureTypeMapping[]>([]);
  const [dragging, setDragging] = createSignal(false);
  const [tab, setTab] = createSignal<RigImportTab>("fixtures");
  const tabsId = createUniqueId();
  const contentId = `${tabsId}-content`;
  let fileInput: HTMLInputElement | undefined;
  let previewRequest = 0;

  /** Collects the dialog's choices into the options the engine plans with. */
  const options = (): types.RigImportOptions => ({
    numbering: numberingOption(numbering(), numberingValue()),
    updateExisting: updateExisting(),
    groups: groupSource(),
    scenery: scenery(),
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
    setUpdateExisting(true);
    setGroupSource(types.RigGroupSource.Auto);
    setScenery(true);
    setMappings([]);
    setTab("fixtures");
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
      const needsChoice = preview()?.fixtureTypes.some((type) =>
        fixtureTypeNeedsChoice(type.status),
      );
      setTab(needsChoice ? "types" : "fixtures");
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
      [
        numbering,
        numberingValue,
        addToUserLibrary,
        updateExisting,
        groupSource,
        scenery,
        mappings,
      ],
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
    if (!id || !current || !previewHasChanges(current)) return;
    setStage("import");
    setError(undefined);
    try {
      await commitRig(id, options());
      const ids = current.fixtures
        .filter(
          (fixture) =>
            fixture.status === types.FixtureImportStatus.New ||
            fixture.status === types.FixtureImportStatus.Update,
        )
        .map((fixture) => fixture.fixtureId)
        .filter((fixtureId): fixtureId is number => fixtureId !== undefined);
      pushToast("success", importDoneMessage(current));
      if (ids.length > 0) revealPatchFixtures(ids);
      setStage("preview");
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setStage("preview");
    }
  };

  /** Opens the file picker. */
  const chooseFile = () => fileInput?.click();

  /** Whether the current preview would change the show, which enables the import button. */
  const canImport = () => {
    const current = preview();
    return current !== undefined && previewHasChanges(current);
  };
  /** Whether any fixture in the file is already in the show, which offers the update choice. */
  const hasExistingFixtures = () =>
    preview()?.fixtures.some(
      (fixture) =>
        fixture.status === types.FixtureImportStatus.Update ||
        fixture.status === types.FixtureImportStatus.Unchanged ||
        fixture.status === types.FixtureImportStatus.AlreadyInShow,
    ) ?? false;
  /** Whether the file has trusses or scenery, which offers the scenery choice. */
  const hasScenery = () => (preview()?.scenery.length ?? 0) > 0;
  /** Whether the file has fixture types of its own, which offers copying them to the library. */
  const hasEmbeddedTypes = () =>
    preview()?.fixtureTypes.some((type) => type.status.type === "Embedded") ??
    false;

  /**
   * The tabs the current preview has content for, each labelled with its row count. The
   * fixture types tab is flagged while a type still needs a library fixture, since the
   * fixtures of that type are left out until one is chosen.
   */
  const tabOptions = createMemo(() => {
    const current = preview();
    if (!current) return [];
    const typesNeedChoice = current.fixtureTypes.some((type) =>
      fixtureTypeNeedsChoice(type.status),
    );
    return rigImportTabs(current).map((key) => ({
      key,
      label: `${RIG_IMPORT_TAB_LABELS[key]} (${rigImportTabCount(current, key)})${
        key === "types" && typesNeedChoice ? " ⚠" : ""
      }`,
    }));
  });
  /** The chosen tab, or the fixtures tab when a new preview no longer has the chosen one. */
  const activeTab = createMemo(
    (): RigImportTab =>
      tabOptions().some((option) => option.key === tab()) ? tab() : "fixtures",
  );

  return (
    <Dialog
      kind="task"
      isOpen={open()}
      usePortal={false}
      title="Import Rig from MVR"
      closeLabel="Close rig import dialog"
      class={`max-w-5xl max-h-[90vh] ${
        stage() === "preview" || stage() === "import"
          ? "h-[min(90vh,52rem)]"
          : ""
      }`}
      busy={stage() === "upload" || stage() === "import"}
      onDismiss={close}
      onSubmit={() => {
        if (stage() === "preview") void runImport();
      }}
    >
      <DialogBody
        scrollable={false}
        class="flex flex-col gap-4 overflow-y-auto"
      >
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
                will be added
                <Show when={current().updatedFixtures > 0}>
                  , {current().updatedFixtures} updated
                </Show>
                <Show when={current().sceneryChanges > 0}>
                  , with {current().sceneryChanges} scenery{" "}
                  {current().sceneryChanges === 1 ? "object" : "objects"}
                </Show>
                .
              </p>
              <Show when={importBlockedReason(current())}>
                {(reason) => (
                  <Alert
                    variant="warning"
                    density="compact"
                    role="status"
                    class="shrink-0"
                    data-testid="rig-import-blocked"
                  >
                    {reason()}
                  </Alert>
                )}
              </Show>
              <Show when={current().warnings.length > 0}>
                <ul class="max-h-20 shrink-0 list-disc overflow-y-auto pl-5 text-xs text-amber-300">
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
                <label class="flex min-w-48 flex-col gap-1 text-xs font-medium uppercase text-gray-400">
                  Groups
                  <NativeSelect
                    aria-label="Make groups from"
                    value={groupSource()}
                    onChange={(event) =>
                      setGroupSource(
                        event.currentTarget.value as types.RigGroupSource,
                      )
                    }
                  >
                    <For each={GROUP_SOURCE_OPTIONS}>
                      {(option) => (
                        <option value={option.value}>{option.label}</option>
                      )}
                    </For>
                  </NativeSelect>
                </label>
                <Show when={hasExistingFixtures()}>
                  <label class="flex items-center gap-2 text-sm text-gray-300">
                    <Checkbox
                      checked={updateExisting()}
                      onChange={(event) =>
                        setUpdateExisting(event.currentTarget.checked)
                      }
                    />
                    Update fixtures already in the show to match the file
                  </label>
                </Show>
                <Show when={hasScenery()}>
                  <label class="flex items-center gap-2 text-sm text-gray-300">
                    <Checkbox
                      checked={scenery()}
                      onChange={(event) =>
                        setScenery(event.currentTarget.checked)
                      }
                    />
                    Import trusses and scenery
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

              <SegmentedTabs
                id={tabsId}
                density="compact"
                contentId={contentId}
                label="Rig contents"
                options={tabOptions()}
                value={activeTab()}
                onChange={setTab}
              />
              <div
                id={contentId}
                role="tabpanel"
                aria-labelledby={`${tabsId}-${activeTab()}`}
                class="flex min-h-48 flex-1 flex-col"
              >
                <Switch>
                  <Match when={activeTab() === "types"}>
                    <TableScroll
                      aria-label="Fixture types in the rig"
                      class={TAB_TABLE_CLASS}
                    >
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
                                              <option
                                                value={libraryKey(fixture)}
                                              >
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
                                    <Show when={type.missing3dModel}>
                                      <span
                                        class="block text-xs text-amber-300"
                                        title="This GDTF has no 3D model files, so its fixtures are drawn from simple shapes or as placeholder boxes."
                                      >
                                        No 3D model
                                      </span>
                                    </Show>
                                  </td>
                                  <td class="text-right">
                                    {type.fixtureCount}
                                  </td>
                                </tr>
                              );
                            }}
                          </For>
                        </tbody>
                      </Table>
                    </TableScroll>
                  </Match>
                  <Match when={activeTab() === "groups"}>
                    <TableScroll
                      aria-label="Groups the import makes"
                      class={TAB_TABLE_CLASS}
                    >
                      <Table aria-label="Groups the import makes">
                        <thead class="text-left">
                          <tr>
                            <th scope="col" class="w-16">
                              ID
                            </th>
                            <th scope="col">Name</th>
                            <th scope="col" class="w-28">
                              Action
                            </th>
                            <th scope="col" class="w-20 text-right">
                              Fixtures
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={current().groups}>
                            {(group) => (
                              <tr>
                                <td>{group.groupId}</td>
                                <td>{group.name}</td>
                                <td>{group.existing ? "Refresh" : "New"}</td>
                                <td class="text-right">{group.fixtureCount}</td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </Table>
                    </TableScroll>
                  </Match>
                  <Match when={activeTab() === "scenery"}>
                    <TableScroll
                      aria-label="Scenery in the rig"
                      class={TAB_TABLE_CLASS}
                    >
                      <Table aria-label="Scenery in the rig">
                        <thead class="text-left">
                          <tr>
                            <th scope="col" class="w-16">
                              ID
                            </th>
                            <th scope="col">Name</th>
                            <th scope="col">Kind</th>
                            <th scope="col">Layer</th>
                            <th scope="col" class="text-right">
                              Triangles
                            </th>
                            <th scope="col">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={current().scenery}>
                            {(object) => (
                              <tr
                                title={object.warnings.join("\n") || undefined}
                                data-status={object.status}
                              >
                                <td>{object.sceneObjectId ?? "–"}</td>
                                <td>{object.label}</td>
                                <td>{sceneryKindLabel(object.kind)}</td>
                                <td>{object.layer || "–"}</td>
                                <td class="text-right">
                                  {object.triangles.toLocaleString()}
                                </td>
                                <td>
                                  {sceneryStatusLabel(object.status)}
                                  <Show when={object.changes.length > 0}>
                                    <span class="text-gray-500">
                                      {" "}
                                      ({object.changes.join(", ")})
                                    </span>
                                  </Show>
                                  <Show when={object.warnings.length > 0}>
                                    <span class="text-amber-400"> ⚠</span>
                                  </Show>
                                </td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </Table>
                    </TableScroll>
                  </Match>
                  <Match when={activeTab() === "fixtures"}>
                    <TableScroll
                      aria-label="Fixtures in the rig"
                      class={TAB_TABLE_CLASS}
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
                                <td>
                                  {fixture.hangingPosition ?? fixture.layer}
                                </td>
                                <td>
                                  {fixtureStatusLabel(fixture.status)}
                                  <Show when={fixture.changes.length > 0}>
                                    <span class="text-gray-500">
                                      {" "}
                                      ({fixture.changes.join(", ")})
                                    </span>
                                  </Show>
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
                  </Match>
                </Switch>
              </div>
            </>
          )}
        </Show>
      </DialogBody>

      <DialogFooter>
        <Show when={stage() === "preview" || stage() === "import"}>
          <Button
            type="button"
            class="mr-auto"
            onClick={reset}
            disabled={stage() === "import"}
          >
            <CaretLeftIcon class="size-4" aria-hidden />
            Back
          </Button>
        </Show>
        <DialogCancelButton />
        <Button
          variant="primary"
          type="button"
          disabled={stage() !== "preview" || !canImport()}
          onClick={() => void runImport()}
        >
          {stage() === "import" ? "Importing…" : preview() ? "Import" : "Next"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
