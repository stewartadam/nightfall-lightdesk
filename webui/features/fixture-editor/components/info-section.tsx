// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, type JSX, Show } from "solid-js";
import { SegmentedControl } from "../../../components/ui/segmented-control";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import * as types from "../../../types";
import { renamedInfo } from "../model/draft-editing";
import { CommitField } from "./commit-field";
import { useDraftEditing } from "./draft-context";

/** Body shapes offered for a fixture's geometry, in the order shown. */
const BODY_OPTIONS = [
  { value: types.BodyShape.Par, label: "Par" },
  { value: types.BodyShape.Bar, label: "Bar" },
  { value: types.BodyShape.MovingHead, label: "Moving head" },
] as const;

/** Labels one field of the fixture's names. */
function Field(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1 text-sm">
      <label class="flex flex-col gap-1">
        <span class="text-neutral-300">{props.label}</span>
        {props.children}
      </label>
      <Show when={props.hint}>
        <span class="text-xs text-neutral-500">{props.hint}</span>
      </Show>
    </div>
  );
}

/**
 * Edits the fixture's names, description and body shape. A file opened from
 * the library keeps its own 3D model until a body shape is picked, which
 * replaces it, so that change asks first.
 */
export default function InfoSection() {
  const editing = useDraftEditing();
  const [pendingBody, setPendingBody] = createSignal<types.BodyShape | null>(
    null,
  );
  /** The draft's names, as the base every name edit changes one field of. */
  const info = () => editing.draft().info;

  /** Sends the names with one field changed. */
  const setInfo = (field: keyof types.DraftInfo, value: string) =>
    editing.edit((draft) => ({
      type: "SetInfo",
      data: { ...draft.info, [field]: value },
    }));

  /**
   * Renames the fixture. Short and long names that still match the old
   * name follow the rename, since the library lists fixtures by long name
   * and a stale one would hide the new name there.
   */
  const rename = (name: string) =>
    editing.edit((draft) => ({
      type: "SetInfo",
      data: renamedInfo(draft.info, name),
    }));

  /** Applies a body shape, asking first when it would replace a model from a file. */
  const chooseBody = (shape: types.BodyShape) => {
    if (editing.draft().body === undefined) setPendingBody(shape);
    else void editing.edit({ type: "SetBody", data: shape });
  };

  return (
    <section class="flex flex-col gap-4" data-testid="fixture-info-section">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Manufacturer">
          <CommitField
            value={info().manufacturer}
            onCommit={(value) => setInfo("manufacturer", value)}
          />
        </Field>
        <Field label="Name" hint="Unique for this manufacturer">
          <CommitField value={info().name} onCommit={rename} />
        </Field>
        <Field label="Short name" hint="Shown where space is tight">
          <CommitField
            value={info().short_name}
            onCommit={(value) => setInfo("short_name", value)}
          />
        </Field>
        <Field label="Long name" hint="Shown in the fixture library">
          <CommitField
            value={info().long_name}
            onCommit={(value) => setInfo("long_name", value)}
          />
        </Field>
      </div>
      <Field label="Description">
        <CommitField
          value={info().description}
          onCommit={(value) => setInfo("description", value)}
        />
      </Field>
      <div class="flex flex-col gap-1 text-sm">
        <span class="text-neutral-300" id="fixture-body-label">
          Body shape
        </span>
        <SegmentedControl
          aria-labelledby="fixture-body-label"
          options={BODY_OPTIONS}
          value={editing.draft().body}
          onChange={chooseBody}
        />
        <span class="text-xs text-neutral-500">
          <Show
            when={editing.draft().body !== undefined}
            fallback="Uses the 3D model from the fixture's file."
          >
            Sets the 3D model and which parts pan and tilt.
          </Show>
        </span>
      </div>
      <DeleteConfirmModal
        isOpen={pendingBody() !== null}
        title="Replace the 3D model?"
        message="This fixture uses the 3D model from its file. A body shape replaces it, and channels are moved onto the new body's parts."
        confirmLabel="Replace"
        onCancel={() => setPendingBody(null)}
        onConfirm={() => {
          const shape = pendingBody();
          setPendingBody(null);
          if (shape) void editing.edit({ type: "SetBody", data: shape });
        }}
      />
    </section>
  );
}
