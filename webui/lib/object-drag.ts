// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ObjectIdentity, ObjectType } from "../types";

/** Drag MIME type carrying the identity of one showfile object, shared by every panel. */
export const OBJECT_DRAG_MIME = "application/x-nightfall-object";

/**
 * Adds a showfile object's identity to a drag so any drop target that accepts objects (such as
 * a Board) can read it, whichever panel the drag started in.
 */
export function setObjectDragData(
  dataTransfer: DataTransfer,
  objectType: ObjectType,
  uid: string,
): void {
  const identity: ObjectIdentity = { object_type: objectType, uid };
  dataTransfer.setData(OBJECT_DRAG_MIME, JSON.stringify(identity));
}

/** Returns whether a drag carries a showfile object; its payload is only readable on drop. */
export function dragCarriesObject(
  dataTransfer: Pick<DataTransfer, "types"> | null | undefined,
): boolean {
  return dataTransfer?.types.includes(OBJECT_DRAG_MIME) ?? false;
}

/** Reads the object identity a drag carries, or `undefined` when it has none or is malformed. */
export function readObjectDragData(
  dataTransfer: Pick<DataTransfer, "getData" | "types">,
): ObjectIdentity | undefined {
  if (!dragCarriesObject(dataTransfer)) return undefined;
  try {
    const payload = JSON.parse(dataTransfer.getData(OBJECT_DRAG_MIME)) as {
      object_type?: unknown;
      uid?: unknown;
    };
    if (
      typeof payload.object_type === "string" &&
      typeof payload.uid === "string"
    ) {
      return {
        object_type: payload.object_type as ObjectType,
        uid: payload.uid,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
