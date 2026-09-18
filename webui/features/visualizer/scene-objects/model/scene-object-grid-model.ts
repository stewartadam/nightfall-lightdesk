// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { GridCell } from "../../../../lib/data-grid-types";
import { GridCellKind } from "../../../../lib/data-grid-types";
import {
  alwaysVisibleColumnMeta,
  columnVisibilityMeta,
  type VisibilityGridColumn,
} from "../../../../lib/datagrid-column-visibility";
import type { FilterableGridColumn } from "../../../../lib/datagrid-filtering";
import type {
  SceneObject,
  SceneObjectPlacementPositionUpdate,
  SceneObjectPlacementRotationUpdate,
  SceneObjectType,
} from "../../../../types";
export const columns: FilterableGridColumn<
  SceneObject,
  VisibilityGridColumn
>[] = [
  {
    title: "ID",
    id: "id",
    width: 80,
    filter: {
      kind: "number",
      value: (sceneObject) => sceneObject.identifiers.id,
    },
    ...alwaysVisibleColumnMeta(),
  },
  {
    title: "Label",
    id: "label",
    width: 180,
    filter: { value: (sceneObject) => sceneObject.identifiers.label },
    ...columnVisibilityMeta("Metadata", "Label"),
  },
  {
    title: "Type",
    id: "type",
    width: 120,
    filter: {
      kind: "enum",
      value: (sceneObject) => formatSceneObjectType(sceneObject.objectType),
      options: [
        { value: "Truss", label: "Truss" },
        { value: "Audience", label: "Audience" },
        { value: "Stage Element", label: "Stage Element" },
        { value: "Custom", label: "Custom" },
      ],
    },
    ...columnVisibilityMeta("Metadata", "Type"),
  },
  {
    title: "Scale",
    id: "scale",
    width: 65,
    filter: { kind: "number", value: getScaleValue },
    ...columnVisibilityMeta("Placement", "Scale"),
  },
  {
    title: "Pos X",
    id: "pos_x",
    width: 65,
    filter: {
      kind: "number",
      value: (sceneObject) => sceneObject.placement.position.x,
    },
    ...columnVisibilityMeta("Placement", "Pos X"),
  },
  {
    title: "Pos Y",
    id: "pos_y",
    width: 65,
    filter: {
      kind: "number",
      value: (sceneObject) => sceneObject.placement.position.y,
    },
    ...columnVisibilityMeta("Placement", "Pos Y"),
  },
  {
    title: "Pos Z",
    id: "pos_z",
    width: 65,
    filter: {
      kind: "number",
      value: (sceneObject) => sceneObject.placement.position.z,
    },
    ...columnVisibilityMeta("Placement", "Pos Z"),
  },
  {
    title: "Rot X",
    id: "rot_x",
    width: 65,
    ...columnVisibilityMeta("Rotation", "Rot X"),
  },
  {
    title: "Rot Y",
    id: "rot_y",
    width: 65,
    ...columnVisibilityMeta("Rotation", "Rot Y"),
  },
  {
    title: "Rot Z",
    id: "rot_z",
    width: 65,
    ...columnVisibilityMeta("Rotation", "Rot Z"),
  },
];

export function formatSceneObjectType(type: SceneObjectType): string {
  switch (type) {
    case "truss":
      return "Truss";
    case "audience":
      return "Audience";
    case "stageElement":
      return "Stage Element";
    case "custom":
      return "Custom";
    default:
      return String(type);
  }
}

export function formatTransformValue(value: number): string {
  if (!Number.isFinite(value)) return "";
  const normalized = Math.abs(value) < 1e-9 ? 0 : value;
  if (Number.isInteger(normalized)) {
    return String(normalized);
  }
  return normalized.toFixed(3).replace(/\.?0+$/u, "");
}

export function toNumericCell(value: number): GridCell {
  return {
    kind: GridCellKind.Number,
    data: value,
    displayData: formatTransformValue(value),
    allowOverlay: true,
  };
}

export function getScaleValue(sceneObject: SceneObject): number | null {
  switch (sceneObject.properties.type) {
    case "StageElement":
      return sceneObject.properties.data.scale;
    case "Custom":
      return sceneObject.properties.data.scale;
    default:
      return null;
  }
}

export function withUpdatedScale(
  sceneObject: SceneObject,
  scale: number,
): SceneObject | null {
  switch (sceneObject.properties.type) {
    case "StageElement":
      return {
        ...sceneObject,
        properties: {
          type: "StageElement",
          data: {
            ...sceneObject.properties.data,
            scale,
          },
        },
      };
    case "Custom":
      return {
        ...sceneObject,
        properties: {
          type: "Custom",
          data: {
            ...sceneObject.properties.data,
            scale,
          },
        },
      };
    default:
      return null;
  }
}

export function parseNumericLike(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function parseEditedNumber(cell: GridCell): number | null {
  if (cell.kind === GridCellKind.Number) {
    // Prefer the editor's numeric data payload. displayData may lag or be formatted.
    const fromData = parseNumericLike(cell.data);
    if (fromData !== null) {
      return fromData;
    }

    const fromDisplay = parseNumericLike(cell.displayData);
    if (fromDisplay !== null) {
      return fromDisplay;
    }

    return null;
  }

  if (cell.kind === GridCellKind.Text) {
    return parseNumericLike(cell.data);
  }

  return null;
}

export function buildPlacementUpdate(
  columnId: string,
  value: number,
): {
  position?: SceneObjectPlacementPositionUpdate;
  rotation?: SceneObjectPlacementRotationUpdate;
} {
  switch (columnId) {
    case "pos_x":
      return { position: { type: "X", data: value } };
    case "pos_y":
      return { position: { type: "Y", data: value } };
    case "pos_z":
      return { position: { type: "Z", data: value } };
    case "rot_x":
      return { rotation: { type: "X", data: value } };
    case "rot_y":
      return { rotation: { type: "Y", data: value } };
    case "rot_z":
      return { rotation: { type: "Z", data: value } };
    default:
      return {};
  }
}

/** Returns the linked object-library name when a scene-object variant has one. */
export function sceneObjectLibraryName(
  sceneObject: SceneObject,
): string | undefined {
  const data = sceneObject.properties.data;
  if (!("libraryObjectName" in data)) {
    return undefined;
  }
  return typeof data.libraryObjectName === "string"
    ? data.libraryObjectName
    : undefined;
}
