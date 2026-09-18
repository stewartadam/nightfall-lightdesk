// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  DialogBackdrop,
  DialogBody,
  DialogCloseButton,
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
import { Button } from "../../../components/ui/visual-language/button";
/**
 * Create Object Modal
 *
 * A modal dialog for creating new objects in the object library.
 * Allows users to:
 * - Drag and drop or select a GLB file
 * - Enter metadata (name, category, description, scale, tags)
 * - Create an object bundle that gets added to the library
 */

import { type Component, createSignal, Show } from "solid-js";
import Modal from "../../../components/ui/modal";
import { engineRuntime } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import type { ObjectLibraryCommand } from "../../../types";

const log = getLogger(import.meta.url);

interface CreateObjectModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const CreateObjectModal: Component<CreateObjectModalProps> = (props) => {
  const [name, setName] = createSignal("");
  const [category, setCategory] = createSignal("Custom");
  const [description, setDescription] = createSignal("");
  const [scale, setScale] = createSignal(1);
  const [tags, setTags] = createSignal("");
  const [glbFile, setGlbFile] = createSignal<File | null>(null);
  const [isDragging, setIsDragging] = createSignal(false);
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  let fileInputRef: HTMLInputElement | undefined;

  const resetForm = () => {
    setName("");
    setCategory("Custom");
    setDescription("");
    setScale(1);
    setTags("");
    setGlbFile(null);
    setError(null);
  };

  const handleClose = () => {
    resetForm();
    props.onClose();
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.name.toLowerCase().endsWith(".glb")) {
        setGlbFile(file);
        // Auto-fill name from filename if empty
        if (!name()) {
          const baseName = file.name.replace(/\.glb$/i, "");
          setName(baseName);
        }
        setError(null);
      } else {
        setError("Please select a .glb file");
      }
    }
  };

  const handleFileSelect = (e: Event) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      if (!file.name.toLowerCase().endsWith(".glb")) {
        setError("Please select a .glb file");
        setGlbFile(null);
        return;
      }
      setGlbFile(file);
      // Auto-fill name from filename if empty
      if (!name()) {
        const baseName = file.name.replace(/\.glb$/i, "");
        setName(baseName);
      }
      setError(null);
    }
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();

    const file = glbFile();
    const objectName = name().trim();

    if (!file) {
      setError("Please select a GLB file");
      return;
    }

    if (!objectName) {
      setError("Please enter an object name");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const glbContent = Array.from(new Uint8Array(arrayBuffer));

      const metadata = {
        name: objectName,
        category: category() || "Custom",
        description: description(),
        scale: scale(),
        author: "",
        license: "",
        tags: tags()
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
      };

      const command: ObjectLibraryCommand = {
        type: "CreateObject",
        data: {
          metadata,
          glb_content: glbContent,
        },
      };

      engineRuntime.sendCommand({
        module: "ObjectLibraryCommand",
        command,
      });

      log.info(`Created object: ${objectName}`);
      handleClose();
    } catch (err) {
      log.error("Failed to create object:", err);
      setError("Failed to create object. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={props.isOpen} onEscape={handleClose}>
      <DialogBackdrop>
        <DialogSurface
          class="max-w-md"
          role="dialog"
          aria-modal="true"
          aria-label="Create Object"
        >
          {/* Header */}
          <DialogHeader>
            <DialogTitle>Create Object</DialogTitle>
            <DialogCloseButton onClick={handleClose} />
          </DialogHeader>

          {/* Body */}
          <form onSubmit={handleSubmit}>
            <DialogBody class="space-y-4">
              {/* Drop zone */}
              <div
                class={`border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
                  isDragging()
                    ? "border-blue-500 bg-blue-500/10"
                    : glbFile()
                      ? "border-green-500 bg-green-500/10"
                      : "border-neutral-600 hover:border-neutral-500"
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef?.click()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    fileInputRef?.click();
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".glb"
                  class="hidden"
                  onChange={handleFileSelect}
                />
                <Show
                  when={glbFile()}
                  fallback={
                    <>
                      <svg
                        class="w-12 h-12 mx-auto text-gray-500 mb-2"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                        />
                      </svg>
                      <p class="text-gray-400">
                        Drop a GLB file here or click to browse
                      </p>
                    </>
                  }
                >
                  {(file) => (
                    <>
                      <svg
                        class="w-12 h-12 mx-auto text-green-500 mb-2"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                      <p class="text-green-400">{file().name}</p>
                      <p class="text-xs text-gray-500 mt-1">
                        {(file().size / 1024).toFixed(1)} KB
                      </p>
                    </>
                  )}
                </Show>
              </div>

              {/* Name */}
              <label class="block space-y-1">
                <span class="block text-sm text-gray-400">Name *</span>
                <Input
                  type="text"
                  value={name()}
                  onInput={(e) => setName(e.currentTarget.value)}
                  placeholder="e.g., Road Case"
                />
              </label>

              {/* Category */}
              <label class="block space-y-1">
                <span class="block text-sm text-gray-400">Category</span>
                <NativeSelect
                  value={category()}
                  onChange={(e) => setCategory(e.currentTarget.value)}
                >
                  <option value="Custom">Custom</option>
                  <option value="Stage">Stage</option>
                  <option value="Rigging">Rigging</option>
                  <option value="Props">Props</option>
                  <option value="Furniture">Furniture</option>
                  <option value="Architecture">Architecture</option>
                  <option value="Other">Other</option>
                </NativeSelect>
              </label>

              {/* Description */}
              <label class="block space-y-1">
                <span class="block text-sm text-gray-400">Description</span>
                <Textarea
                  value={description()}
                  onInput={(e) => setDescription(e.currentTarget.value)}
                  placeholder="Optional description..."
                  rows={2}
                />
              </label>

              {/* Scale */}
              <label class="block space-y-1">
                <span class="block text-sm text-gray-400">
                  Scale (1.0 = model units are meters)
                </span>
                <Input
                  type="number"
                  value={scale()}
                  onInput={(e) =>
                    setScale(Number.parseFloat(e.currentTarget.value) || 1)
                  }
                  step="0.01"
                  min="0"
                />
              </label>

              {/* Tags */}
              <label class="block space-y-1">
                <span class="block text-sm text-gray-400">
                  Tags (comma-separated)
                </span>
                <Input
                  type="text"
                  value={tags()}
                  onInput={(e) => setTags(e.currentTarget.value)}
                  placeholder="e.g., case, storage, equipment"
                />
              </label>

              {/* Error */}
              <Show when={error()}>
                <div class="text-red-400 text-sm">{error()}</div>
              </Show>
            </DialogBody>
            <DialogFooter>
              <Button type="button" onClick={handleClose}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={isSubmitting()}>
                {isSubmitting() ? "Creating..." : "Create Object"}
              </Button>
            </DialogFooter>
          </form>
        </DialogSurface>
      </DialogBackdrop>
    </Modal>
  );
};

export default CreateObjectModal;
