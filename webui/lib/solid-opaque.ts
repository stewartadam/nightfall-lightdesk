// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Prototype shared by snapshot values that Solid stores must treat as opaque.
 * It inherits from `Object.prototype`, so the values behave like plain objects
 * everywhere else (spread, JSON, `in`, `Object.keys`).
 */
const OPAQUE_PROTOTYPE: object = Object.create(Object.prototype);

/**
 * Marks a large, immutable snapshot value so Solid stores hold it by reference
 * instead of wrapping it in proxies.
 *
 * Solid only proxies plain objects and arrays, recognized by their prototype.
 * `reconcile` and `createStore` walk every wrappable value in full, and every
 * read through a store proxy registers tracking, so a deep definition tree such
 * as a fixture's elements costs a full traversal on each snapshot and on first
 * read. An opaque value is compared by identity: readers re-run when the value
 * is replaced, and read it as a plain object without per-property tracking.
 *
 * Only use this for values that are replaced wholesale, never mutated in place.
 */
export function opaqueToSolidStores<T extends object>(value: T): T {
  if (Object.getPrototypeOf(value) === Object.prototype) {
    Object.setPrototypeOf(value, OPAQUE_PROTOTYPE);
  }
  return value;
}
