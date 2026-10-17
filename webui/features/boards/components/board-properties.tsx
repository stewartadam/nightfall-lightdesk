// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createEffect,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import {
  Checkbox,
  Input,
  NativeSelect,
} from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import type * as types from "../../../types";
import type { BoardPanelController } from "../controllers/board-panel-controller";
import {
  BOARD_TARGET_TYPE_LABELS,
  BOARD_TARGET_TYPES,
  type BoardTargetType,
  hasTitleSetting,
  isBoardTargetType,
  MAX_OBJECT_ID,
} from "../model/board-model";

interface BoardPropertiesProps {
  controller: BoardPanelController;
}

interface CommitFieldProps {
  label: string;
  value: string;
  type?: "text" | "number" | "color";
  min?: number;
  max?: number;
  placeholder?: string;
  /** Receives the edited text once the field loses focus or Enter is pressed. */
  onCommit: (value: string) => void;
}

/**
 * Labelled field that keeps a local draft while focused and commits it on blur or Enter, so
 * each edit sends one command instead of one per keystroke. Escape restores the stored value.
 * A draft still being typed when the field is removed (for example because another element
 * was selected) is committed to the field's own target first.
 */
function CommitField(props: CommitFieldProps) {
  let inputRef: HTMLInputElement | undefined;
  const [draft, setDraft] = createSignal(props.value);
  /** Last value sent, so Enter followed by blur does not send the same edit twice. */
  let lastCommitted: string | undefined;

  /** Follows the stored value unless the operator is typing in the field. */
  createEffect(() => {
    const value = props.value;
    lastCommitted = undefined;
    if (document.activeElement !== inputRef) setDraft(value);
  });

  /** Sends the draft when it differs from the stored value and was not just sent. */
  const commit = () => {
    const value = draft();
    if (value === props.value || value === lastCommitted) return;
    lastCommitted = value;
    props.onCommit(value);
  };

  /** Commits a pending draft when the field unmounts while focused. */
  onCleanup(() => {
    if (document.activeElement === inputRef) commit();
  });

  return (
    <label class="block text-xs font-medium text-neutral-300">
      {props.label}
      <Input
        ref={inputRef}
        density="compact"
        class="mt-1"
        type={props.type ?? "text"}
        min={props.min}
        max={props.max}
        placeholder={props.placeholder}
        aria-label={props.label}
        value={draft()}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onChange={() => {
          if (props.type === "color") commit();
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(props.value);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

/** Labelled native select bound to a stored value. */
function SelectField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: JSX.Element;
}) {
  return (
    <label class="block text-xs font-medium text-neutral-300">
      {props.label}
      <NativeSelect
        density="compact"
        class="mt-1 w-full"
        aria-label={props.label}
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        {props.children}
      </NativeSelect>
    </label>
  );
}

/** Checkbox row for an element's exclusive (solo) flag. */
function ExclusiveField(props: {
  checked: boolean;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label class="flex items-start gap-2 text-xs text-neutral-300">
      <Checkbox
        class="mt-0.5"
        aria-label="Solo"
        checked={props.checked}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span>
        <span class="font-medium">Solo</span>
        <span class="block text-neutral-500">{props.description}</span>
      </span>
    </label>
  );
}

/** Parses a positive whole number from a field, or returns `undefined` when blank or invalid. */
function parseCount(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Edits the shown board's label and deletes the board. */
export function BoardSettings(
  props: BoardPropertiesProps & { board: types.Board },
) {
  const controller = props.controller;
  return (
    <div class="space-y-4 p-4">
      <h3 class="border-b border-neutral-700 pb-3 font-medium text-neutral-100">
        Board {props.board.identifiers.id}
      </h3>
      <CommitField
        label="Label"
        value={props.board.identifiers.label}
        onCommit={(label) => controller.setBoardLabel(label)}
      />
      <p class="text-xs text-neutral-500">
        While editing, use an element's gear or right-click it to change it, and
        drag across empty cells to add one.
      </p>
      <Button variant="danger" onClick={() => controller.deleteBoard()}>
        Delete board
      </Button>
    </div>
  );
}

/** Edits the pinned object of a target element. */
function TargetFields(
  props: BoardPropertiesProps & {
    element: types.BoardElement;
    target: types.ObjectIdentity;
  },
) {
  const controller = props.controller;
  /** Objects of the pinned type, in ID order, for the object picker. */
  const options = () =>
    isBoardTargetType(props.target.object_type)
      ? [...controller.catalog()[props.target.object_type]].sort(
          (left, right) => left.id - right.id,
        )
      : [];

  /** Re-pins the element to another object. */
  const setTarget = (target: types.ObjectIdentity) =>
    controller.storeElement({
      ...props.element,
      kind: { type: "Target", data: { target } },
    });

  return (
    <>
      <SelectField
        label="Type"
        value={props.target.object_type}
        onChange={(value) => {
          const type = value as BoardTargetType;
          const [first] = [...controller.catalog()[type]].sort(
            (left, right) => left.id - right.id,
          );
          if (first) setTarget({ object_type: type, uid: first.uid });
        }}
      >
        <For each={BOARD_TARGET_TYPES}>
          {(type) => (
            <option value={type}>{BOARD_TARGET_TYPE_LABELS[type].one}</option>
          )}
        </For>
      </SelectField>
      <SelectField
        label="Object"
        value={props.target.uid}
        onChange={(uid) =>
          setTarget({ object_type: props.target.object_type, uid })
        }
      >
        <Show
          when={!options().some((object) => object.uid === props.target.uid)}
        >
          <option value={props.target.uid}>Deleted object</option>
        </Show>
        <For each={options()}>
          {(object) => (
            <option value={object.uid}>
              {object.id} {object.label}
            </option>
          )}
        </For>
      </SelectField>
    </>
  );
}

/** Edits the live query and solo flag of a collection element. */
function CollectionFields(
  props: BoardPropertiesProps & {
    element: types.BoardElement;
    query: types.ObjectQuery;
    exclusive: boolean;
  },
) {
  /** Stores the element with an updated query or solo flag. */
  const update = (query: types.ObjectQuery, exclusive = props.exclusive) =>
    props.controller.storeElement({
      ...props.element,
      kind: { type: "Collection", data: { query, exclusive } },
    });

  /** Stores a new ID range, dropping it when both bounds are blank. */
  const setRange = (first?: number, last?: number) => {
    if (first === undefined && last === undefined) {
      update({ ...props.query, id_range: undefined });
      return;
    }
    update({
      ...props.query,
      id_range: { first: first ?? 1, last: last ?? MAX_OBJECT_ID },
    });
  };

  return (
    <>
      <SelectField
        label="Show"
        value={props.query.object_type}
        onChange={(value) =>
          update({ ...props.query, object_type: value as types.ObjectType })
        }
      >
        <For each={BOARD_TARGET_TYPES}>
          {(type) => (
            <option value={type}>{BOARD_TARGET_TYPE_LABELS[type].many}</option>
          )}
        </For>
      </SelectField>
      <div class="grid grid-cols-2 gap-3">
        <CommitField
          label="From ID"
          type="number"
          min={1}
          placeholder="Any"
          value={props.query.id_range ? `${props.query.id_range.first}` : ""}
          onCommit={(value) =>
            setRange(parseCount(value), props.query.id_range?.last)
          }
        />
        <CommitField
          label="To ID"
          type="number"
          min={1}
          placeholder="Any"
          value={
            props.query.id_range && props.query.id_range.last !== MAX_OBJECT_ID
              ? `${props.query.id_range.last}`
              : ""
          }
          onCommit={(value) =>
            setRange(props.query.id_range?.first, parseCount(value))
          }
        />
      </div>
      <CommitField
        label="Label contains"
        placeholder="Any label"
        value={props.query.label_contains ?? ""}
        onCommit={(value) =>
          update({
            ...props.query,
            label_contains: value.trim() ? value : undefined,
          })
        }
      />
      <ExclusiveField
        checked={props.exclusive}
        description="Only one of these buttons can be on at a time."
        onChange={(checked) => update(props.query, checked)}
      />
    </>
  );
}

/** Edits one element: caption, color, size, kind-specific fields, and deletion. */
export function ElementSettings(
  props: BoardPropertiesProps & { element: types.BoardElement },
) {
  const controller = props.controller;
  /** Stores the element with a changed span, keeping its position. */
  const setSpan = (width?: number, height?: number) => {
    if (!width || !height) return;
    controller.placeElement(props.element, {
      ...props.element.cell,
      width,
      height,
    });
  };
  const kind = () => props.element.kind;

  return (
    <div class="space-y-4 p-4">
      <h3 class="border-b border-neutral-700 pb-3 font-medium text-neutral-100">
        {kindTitle(kind())}
      </h3>
      <Show
        when={(() => {
          const current = kind();
          return current.type === "Target" ? current.data.target : undefined;
        })()}
      >
        {(target) => (
          <TargetFields
            controller={controller}
            element={props.element}
            target={target()}
          />
        )}
      </Show>
      <Show
        when={(() => {
          const current = kind();
          return current.type === "Collection" ? current.data : undefined;
        })()}
      >
        {(data) => (
          <CollectionFields
            controller={controller}
            element={props.element}
            query={data().query}
            exclusive={data().exclusive ?? false}
          />
        )}
      </Show>
      <CommitField
        label={hasTitleSetting(kind()) ? "Title" : "Label"}
        placeholder={
          kind().type === "Target"
            ? "Object label"
            : kind().type === "Collection"
              ? "What it shows"
              : "None"
        }
        value={props.element.label ?? ""}
        onCommit={(label) =>
          controller.storeElement({
            ...props.element,
            label: label.trim() ? label : undefined,
          })
        }
      />
      <Show when={hasTitleSetting(kind())}>
        <label class="flex items-center gap-2 text-xs text-neutral-300">
          <Checkbox
            aria-label="Show title"
            checked={props.element.show_title}
            onChange={(event) =>
              controller.storeElement({
                ...props.element,
                show_title: event.currentTarget.checked,
              })
            }
          />
          <span class="font-medium">Show title</span>
        </label>
      </Show>
      <div class="flex items-end gap-2">
        <div class="flex-1">
          <CommitField
            label="Color"
            type="color"
            value={props.element.color ?? "#3b82f6"}
            onCommit={(color) =>
              controller.storeElement({ ...props.element, color })
            }
          />
        </div>
        <Show when={props.element.color}>
          <Button
            variant="subtle"
            onClick={() =>
              controller.storeElement({ ...props.element, color: undefined })
            }
          >
            Clear
          </Button>
        </Show>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <CommitField
          label="Width"
          type="number"
          min={1}
          value={`${props.element.cell.width}`}
          onCommit={(value) =>
            setSpan(parseCount(value), props.element.cell.height)
          }
        />
        <CommitField
          label="Height"
          type="number"
          min={1}
          value={`${props.element.cell.height}`}
          onCommit={(value) =>
            setSpan(props.element.cell.width, parseCount(value))
          }
        />
      </div>
      <Show
        when={(() => {
          const current = kind();
          return current.type === "Frame" ? current.data : undefined;
        })()}
      >
        {(data) => (
          <ExclusiveField
            checked={data().exclusive ?? false}
            description="Only one button of each type inside this frame can be on at a time."
            onChange={(exclusive) =>
              controller.storeElement({
                ...props.element,
                kind: { type: "Frame", data: { exclusive } },
              })
            }
          />
        )}
      </Show>
      <Button
        variant="danger"
        onClick={() => controller.deleteElement(props.element.uid)}
      >
        Remove from board
      </Button>
    </div>
  );
}

/** Returns the heading shown above an element's properties. */
function kindTitle(kind: types.BoardElementKind): string {
  switch (kind.type) {
    case "Target":
      return isBoardTargetType(kind.data.target.object_type)
        ? `${BOARD_TARGET_TYPE_LABELS[kind.data.target.object_type].one} button`
        : "Button";
    case "Collection":
      return "Collection";
    case "Frame":
      return "Frame";
    case "Label":
      return "Label";
  }
}

/** Properties panel content for a Board panel: the selected element, else the board itself. */
export function BoardProperties(props: BoardPropertiesProps) {
  return (
    <Show
      when={props.controller.board()}
      fallback={
        <div class="p-4 text-sm text-neutral-500">
          Create a board to edit its properties.
        </div>
      }
    >
      {(board) => (
        <Show
          when={props.controller.selectedElement()?.uid}
          keyed
          fallback={
            <BoardSettings controller={props.controller} board={board()} />
          }
        >
          {(uid) => (
            <Show when={props.controller.elementByUid(uid)}>
              {(element) => (
                <ElementSettings
                  controller={props.controller}
                  element={element()}
                />
              )}
            </Show>
          )}
        </Show>
      )}
    </Show>
  );
}
