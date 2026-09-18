// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Event data types for Visualizer worker communication.
 *
 * These types are used by ElementProxy to forward DOM events to the worker
 * via postMessage. The main Comlink API handles other worker communication.
 */

/** Size event for element proxy */
interface Vis2SizeEventData {
  type: "size";
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Mouse/pointer event data */
interface Vis2PointerEventData {
  type:
    | "mousedown"
    | "mousemove"
    | "mouseup"
    | "pointerdown"
    | "pointermove"
    | "pointerup";
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  button: number;
  pointerType?: string;
  clientX: number;
  clientY: number;
  pointerId?: number;
  pageX: number;
  pageY: number;
}

/** Wheel event data */
export interface Vis2WheelEventData {
  type: "wheel";
  deltaX: number;
  deltaY: number;
}

/** Touch event data */
export interface Vis2TouchEventData {
  type: "touchstart" | "touchmove" | "touchend";
  touches: Array<{
    pageX: number;
    pageY: number;
    clientX: number;
    clientY: number;
  }>;
}

/** Keyboard event data */
export interface Vis2KeydownEventData {
  type: "keydown";
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  keyCode: number;
  key: string;
}

/** Union of all event data types */
export type Vis2EventData =
  | Vis2SizeEventData
  | Vis2PointerEventData
  | Vis2WheelEventData
  | Vis2TouchEventData
  | Vis2KeydownEventData;
