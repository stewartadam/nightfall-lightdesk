// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { attributeMetadata } from "../state/appStores";
import type * as types from "../types";
import { setStoreAction } from "./nanostore-action";
import { normalizeAttributeName } from "./utils";

const metadataByKey = new Map<string, types.AttributeMetadata>();

function keyForAttribute(attribute: types.Attribute | string): string {
  if (typeof attribute === "string") return attribute;
  if (attribute.type === "Custom") return attribute.data.label;
  return attribute.type;
}

function rebuildCache(metadata: readonly types.AttributeMetadata[]) {
  metadataByKey.clear();

  for (const item of metadata) {
    metadataByKey.set(item.key, item);
    metadataByKey.set(keyForAttribute(item.attribute), item);

    const normalizedKey = normalizeAttributeName(item.key);
    if (normalizedKey !== item.key && !metadataByKey.has(normalizedKey)) {
      metadataByKey.set(normalizedKey, item);
    }
  }
}

export function setAttributeMetadata(
  metadata: readonly types.AttributeMetadata[],
): void {
  const next = [...metadata];
  rebuildCache(next);
  setStoreAction(attributeMetadata, "Set Attribute Metadata", next);
}

export function getAttributeMetadata(
  attribute: types.Attribute | string,
): types.AttributeMetadata | undefined {
  const key = keyForAttribute(attribute);
  return (
    metadataByKey.get(key) ?? metadataByKey.get(normalizeAttributeName(key))
  );
}

export function compareAttributes(a: string, b: string): number {
  const left = getAttributeMetadata(a);
  const right = getAttributeMetadata(b);
  const leftOrder = left?.sort_order ?? 255;
  const rightOrder = right?.sort_order ?? 255;

  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return a.localeCompare(b);
}
