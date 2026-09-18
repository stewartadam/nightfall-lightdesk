// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Input } from "../../../../components/ui/form-controls";
import { Button } from "../../../../components/ui/visual-language/button";
/**
 * Selection editor component for flow nodes.
 * Provides inline editing of selection expressions.
 */

import { createEffect, createSignal, Show } from "solid-js";
import {
  formatSpatialSelection,
  parseSpatialSelection,
} from "../../../../lib/wasm-bridge";
import { pushToast } from "../../../../state/appStores";
import type { SpatialSelection } from "../../../../types";

export interface SelectionEditorProps {
  value: SpatialSelection | null;
  disabled?: boolean;
  onCommit: (value: SpatialSelection) => void;
}

export function SelectionEditor(props: SelectionEditorProps) {
  const [isEditing, setIsEditing] = createSignal(false);
  const [inputValue, setInputValue] = createSignal("");
  const [displayText, setDisplayText] = createSignal("Selection");
  let inputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (!props.value) {
      setDisplayText("Selection");
      return;
    }
    formatSpatialSelection(props.value)
      .then((formatted) => {
        setDisplayText(formatted);
      })
      .catch(() => setDisplayText("Selection"));
  });

  createEffect(() => {
    if (isEditing() && inputRef) {
      inputRef.focus();
      inputRef.select();
    }
  });

  const startEditing = () => {
    if (props.disabled) return;
    setInputValue(displayText());
    setIsEditing(true);
  };

  const commit = async () => {
    const trimmed = inputValue().trim();
    if (!trimmed) {
      setIsEditing(false);
      return;
    }
    const parsed = await parseSpatialSelection(trimmed);
    if (!parsed) {
      pushToast("error", "Invalid selection");
      return;
    }
    props.onCommit(parsed);
    setIsEditing(false);
  };

  return (
    <div class="mt-1">
      <Show
        when={isEditing()}
        fallback={
          <Button
            size="compact"
            type="button"
            class="text-left"
            onClick={startEditing}
          >
            {displayText()}
          </Button>
        }
      >
        <Input
          density="compact"
          ref={inputRef}
          type="text"
          value={inputValue()}
          onInput={(e) => setInputValue(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setIsEditing(false);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          class="w-full nodrag"
          placeholder="Selection"
        />
      </Show>
    </div>
  );
}
