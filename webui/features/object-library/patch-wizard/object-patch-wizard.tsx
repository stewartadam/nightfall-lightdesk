// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  type Component,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Show,
} from "solid-js";
import {
  DialogBackdrop,
  DialogBody,
  DialogCloseButton,
  DialogFooter,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/form-controls";
import Modal from "../../../components/ui/modal";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Button } from "../../../components/ui/visual-language/button";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import { findSceneObjectVersionConflictIds } from "../../../lib/asset-version";
import {
  commandFailureMessage,
  commandSucceeded,
} from "../../../lib/command-result";
import { engineRuntime } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import { createSceneObject } from "../../../lib/scene-object-service";
import { objectLibrary, sceneObjects } from "../../../state/appStores";
import type { ObjectLibraryCommand } from "../../../types";
import {
  buildWizardObjectOptions,
  filterWizardObjectOptions,
  groupWizardObjectOptions,
  nextAvailableSceneObjectId,
  sceneObjectIdRangeHasConflict,
  type WizardObjectOption,
} from "./object-patch-wizard-model";
import ObjectSelectionPreview from "./object-selection-preview";

const log = getLogger(import.meta.url);

interface ObjectPatchWizardProps {
  isOpen: boolean;
  onClose: () => void;
}

const ObjectPatchWizard: Component<ObjectPatchWizardProps> = (props) => {
  const quantityId = createUniqueId();
  const $objectLibrary = useStore(objectLibrary);
  const $sceneObjects = useStore(sceneObjects);

  const [selectedObject, setSelectedObject] =
    createSignal<WizardObjectOption | null>(null);
  const [quantity, setQuantity] = createSignal(1);
  const [filterText, setFilterText] = createSignal("");
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [isVersionConflictModalOpen, setIsVersionConflictModalOpen] =
    createSignal(false);
  const [versionConflictSceneObjectIds, setVersionConflictSceneObjectIds] =
    createSignal<number[]>([]);

  /** Projects built-in and library entries into the wizard option list. */
  const availableObjects = createMemo<WizardObjectOption[]>(() =>
    buildWizardObjectOptions($objectLibrary()),
  );

  /** Finds the first contiguous range available for the requested quantity. */
  const nextAvailableId = createMemo(() =>
    nextAvailableSceneObjectId($sceneObjects(), quantity()),
  );

  /** Guards against store changes after the next available range is projected. */
  const hasIdConflict = createMemo(() =>
    sceneObjectIdRangeHasConflict(
      $sceneObjects(),
      nextAvailableId(),
      quantity(),
    ),
  );

  /** Filters object options using the current search input. */
  const filteredObjects = createMemo(() =>
    filterWizardObjectOptions(availableObjects(), filterText()),
  );

  /** Groups filtered object options for category presentation. */
  const groupedObjects = createMemo(() =>
    groupWizardObjectOptions(filteredObjects()),
  );

  const resetForm = () => {
    setSelectedObject(null);
    setQuantity(1);
    setFilterText("");
    setError(null);
    setIsVersionConflictModalOpen(false);
    setVersionConflictSceneObjectIds([]);
  };

  const handleClose = () => {
    resetForm();
    props.onClose();
  };

  const submitWithOptions = async (forceUpdateExisting = false) => {
    const object = selectedObject();
    if (!object) {
      setError("Please select an object");
      return;
    }

    if (hasIdConflict()) {
      setError("One or more IDs are already in use");
      return;
    }

    const updateExistingIds =
      object.source.type === "library"
        ? findSceneObjectVersionConflictIds(
            $sceneObjects(),
            object.source.object.name,
            object.source.object.assetVersion,
          )
        : [];
    if (updateExistingIds.length > 0 && !forceUpdateExisting) {
      setVersionConflictSceneObjectIds(updateExistingIds);
      setIsVersionConflictModalOpen(true);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const baseId = nextAvailableId();
      const qty = quantity();
      const failures: string[] = [];
      let successCount = 0;

      for (let i = 0; i < qty; i++) {
        const id = baseId + i;
        const label = qty > 1 ? `${object.name} ${i + 1}` : object.name;

        if (object.source.type === "library") {
          const command: ObjectLibraryCommand = {
            type: "CreateSceneObjectFromLibrary",
            data: {
              id,
              object_name: object.source.object.name,
              label,
              update_existing_ids:
                forceUpdateExisting && i === 0 ? updateExistingIds : undefined,
            },
          };

          try {
            const result = await engineRuntime.sendCommandAndAwait({
              module: "ObjectLibraryCommand",
              command,
            });

            if (!commandSucceeded(result)) {
              failures.push(`ID ${id}: ${commandFailureMessage(result)}`);
              continue;
            }

            successCount += 1;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            failures.push(`ID ${id}: ${message}`);
          }
          continue;
        }

        createSceneObject(id, label, object.source.objectType);
        successCount += 1;
      }

      if (failures.length > 0) {
        log.warn(
          `Failed to add ${failures.length} object(s); ${successCount} created successfully`,
        );
        setError(
          failures.length === 1
            ? `Failed to add object: ${failures[0]}`
            : `Failed to add ${failures.length} objects:\n${failures.join("\n")}`,
        );
        return;
      }

      log.info(`Added ${qty} object(s): ${object.name}`);
      handleClose();
    } catch (err) {
      log.error("Failed to add object(s):", err);
      setError("Failed to add object(s). Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = () => {
    void submitWithOptions(false);
  };

  return (
    <Modal
      isOpen={props.isOpen}
      onEscape={() => {
        if (!isSubmitting()) {
          handleClose();
        }
      }}
    >
      <DialogBackdrop>
        <DialogSurface
          role="dialog"
          aria-modal="true"
          aria-label="Add Object"
          class="max-w-5xl"
        >
          <DialogHeader>
            <DialogTitle>Add Object</DialogTitle>
            <DialogCloseButton
              type="button"
              onClick={handleClose}
            ></DialogCloseButton>
          </DialogHeader>

          <DialogBody>
            <div class="flex flex-col lg:flex-row gap-4">
              <div class="min-w-0 flex-1 space-y-4">
                <div>
                  <Input
                    density="compact"
                    type="text"
                    value={filterText()}
                    onInput={(e) => setFilterText(e.currentTarget.value)}
                    aria-label="Search objects"
                    placeholder="Search objects, categories, or tags..."
                    class="w-full"
                  />
                </div>

                <div>
                  <label class="block text-sm text-gray-400 mb-2">
                    Select Object
                  </label>
                  <Show
                    when={filteredObjects().length > 0}
                    fallback={
                      <div class="p-4 text-center text-gray-500 border border-neutral-600 rounded">
                        No objects match your search.
                      </div>
                    }
                  >
                    <ScrollArea
                      class="max-h-[24rem] border border-neutral-600 rounded"
                      viewportProps={{
                        role: "region",
                        "aria-label": "Objects to patch",
                        tabIndex: 0,
                      }}
                    >
                      <For each={groupedObjects()}>
                        {([category, objects]) => (
                          <>
                            <div class="px-3 py-1 text-xs text-gray-500 bg-neutral-700 sticky top-0">
                              {category}
                            </div>
                            <For each={objects}>
                              {(object) => (
                                <Button
                                  size="compact"
                                  type="button"
                                  onClick={() => setSelectedObject(object)}
                                  class="w-full flex-col !items-start text-left"
                                  variant={
                                    selectedObject()?.key === object.key
                                      ? "primary"
                                      : "subtle"
                                  }
                                  aria-pressed={
                                    selectedObject()?.key === object.key
                                  }
                                >
                                  <div class="text-sm">{object.name}</div>
                                  <Show when={object.description}>
                                    <div class="text-xs opacity-70 truncate">
                                      {object.description}
                                    </div>
                                  </Show>
                                </Button>
                              )}
                            </For>
                          </>
                        )}
                      </For>
                    </ScrollArea>
                  </Show>
                </div>

                <div>
                  <label
                    for={quantityId}
                    class="block text-sm text-gray-400 mb-1"
                  >
                    Quantity
                  </label>
                  <Input
                    density="compact"
                    type="number"
                    id={quantityId}
                    value={quantity()}
                    onInput={(e) =>
                      setQuantity(
                        Math.max(
                          1,
                          Number.parseInt(e.currentTarget.value, 10) || 1,
                        ),
                      )
                    }
                    min="1"
                    max="100"
                    class="w-full"
                  />
                </div>

                <div class="text-xs text-gray-500">
                  Will assign ID{quantity() > 1 ? "s" : ""}: {nextAvailableId()}
                  {quantity() > 1
                    ? ` - ${nextAvailableId() + quantity() - 1}`
                    : ""}
                </div>

                <Show when={error()}>
                  <div class="text-red-400 text-sm whitespace-pre-line">
                    {error()}
                  </div>
                </Show>
              </div>

              <div class="w-full lg:w-80 xl:w-96 flex-shrink-0 space-y-3">
                <ObjectSelectionPreview selectedObject={selectedObject()} />
                <Show
                  when={selectedObject()}
                  fallback={
                    <div class="p-3 bg-neutral-700/40 rounded text-xs text-gray-400">
                      Select an object to see source and metadata.
                    </div>
                  }
                >
                  {(selected) => (
                    <div class="p-3 bg-neutral-700 rounded">
                      <div class="text-sm font-medium text-white">
                        {selected().name}
                      </div>
                      <div class="text-xs text-gray-400">
                        Source:{" "}
                        {selected().source.type === "library"
                          ? "Library Bundle"
                          : "Built-in Default"}{" "}
                        | Scale: {selected().scale.toFixed(2)}x
                      </div>
                      <Show when={selected().tags.length > 0}>
                        <div class="flex flex-wrap gap-1 mt-1">
                          <For each={selected().tags}>
                            {(tag) => (
                              <span class="text-xs bg-neutral-600 px-1.5 py-0.5 rounded">
                                {tag}
                              </span>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>
              </div>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button size="compact" type="button" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              size="compact"
              variant="primary"
              type="button"
              onClick={handleSubmit}
              disabled={!selectedObject() || isSubmitting()}
            >
              {isSubmitting() ? "Adding..." : "Add Object"}
            </Button>
          </DialogFooter>
        </DialogSurface>
      </DialogBackdrop>
      <DeleteConfirmModal
        isOpen={isVersionConflictModalOpen()}
        title="Version Mismatch Detected"
        message={`This showfile already contains scene object IDs ${versionConflictSceneObjectIds().join(", ")} using a different version of ${selectedObject()?.name ?? "this object"}. Proceeding will update those scene objects to the library version before adding the new object(s).`}
        confirmLabel="Proceed and Update"
        onCancel={() => setIsVersionConflictModalOpen(false)}
        onConfirm={() => {
          setIsVersionConflictModalOpen(false);
          void submitWithOptions(true);
        }}
      />
    </Modal>
  );
};

export default ObjectPatchWizard;
