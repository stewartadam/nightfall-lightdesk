// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Element proxy for forwarding DOM events to a Web Worker.
 * Based on Three.js OffscreenCanvas example pattern.
 *
 * This module provides two components:
 * 1. ElementProxy (main thread) - Captures events and forwards them to worker
 * 2. ElementProxyReceiver (worker) - Receives events and mimics DOM element for OrbitControls
 */

import { EventDispatcher } from "three/webgpu";
import type {
  Vis2EventData,
  Vis2KeydownEventData,
  Vis2TouchEventData,
  Vis2WheelEventData,
} from "./worker-types";

// Main-thread proxies copy DOM event data into worker-safe payloads.

/** Event properties to copy for mouse/pointer events */
const POINTER_EVENT_PROPS = [
  "ctrlKey",
  "metaKey",
  "shiftKey",
  "altKey",
  "button",
  "pointerType",
  "clientX",
  "clientY",
  "pointerId",
  "pageX",
  "pageY",
] as const;

/** Arrow keys for OrbitControls */
const ORBIT_KEYS: Record<string, boolean> = {
  "37": true, // left
  "38": true, // up
  "39": true, // right
  "40": true, // down
};

/**
 * Copy specified properties from source object to destination.
 */
function copyProperties<T extends Record<string, unknown>>(
  src: unknown,
  properties: readonly string[],
  dst: T,
): void {
  for (const name of properties) {
    (dst as Record<string, unknown>)[name] = (src as Record<string, unknown>)[
      name
    ];
  }
}

/**
 * Create an event handler that copies specified properties and sends to worker.
 */
function makeSendPropertiesHandler(properties: readonly string[]) {
  return (event: Event, sendFn: (data: Vis2EventData) => void) => {
    const data = { type: event.type } as Record<string, unknown>;
    copyProperties(event, properties, data);
    sendFn(data as unknown as Vis2EventData);
  };
}

/** Handler for mouse/pointer events */
const mouseEventHandler = makeSendPropertiesHandler(POINTER_EVENT_PROPS);

/** Handler for wheel events (with preventDefault) */
function wheelEventHandler(
  event: WheelEvent,
  sendFn: (data: Vis2EventData) => void,
): void {
  event.preventDefault();
  const data: Vis2WheelEventData = {
    type: "wheel",
    deltaX: event.deltaX,
    deltaY: event.deltaY,
  };
  sendFn(data);
}

/** Handler for touch events */
function touchEventHandler(
  event: TouchEvent,
  sendFn: (data: Vis2EventData) => void,
): void {
  event.preventDefault();
  const touches: Vis2TouchEventData["touches"] = [];
  for (let i = 0; i < event.touches.length; i++) {
    const touch = event.touches[i];
    touches.push({
      pageX: touch.pageX,
      pageY: touch.pageY,
      clientX: touch.clientX,
      clientY: touch.clientY,
    });
  }
  const data: Vis2TouchEventData = {
    type: event.type as Vis2TouchEventData["type"],
    touches,
  };
  sendFn(data);
}

/** Handler for keyboard events (filtered to orbit keys) */
function filteredKeydownEventHandler(
  event: KeyboardEvent,
  sendFn: (data: Vis2EventData) => void,
): void {
  const keyCode = event.keyCode.toString();
  if (ORBIT_KEYS[keyCode]) {
    event.preventDefault();
    const data: Vis2KeydownEventData = {
      type: "keydown",
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      keyCode: event.keyCode,
      key: event.key,
    };
    sendFn(data);
  }
}

/** Prevent default handler for contextmenu */
function preventDefaultHandler(event: Event): void {
  event.preventDefault();
}

/** Event handlers map for ElementProxy */
type EventHandlerMap = {
  [K in keyof HTMLElementEventMap]?: (
    event: HTMLElementEventMap[K],
    sendFn: (data: Vis2EventData) => void,
  ) => void;
};

const EVENT_HANDLERS: EventHandlerMap = {
  contextmenu: preventDefaultHandler as EventHandlerMap["contextmenu"],
  mousedown: mouseEventHandler as EventHandlerMap["mousedown"],
  mousemove: mouseEventHandler as EventHandlerMap["mousemove"],
  mouseup: mouseEventHandler as EventHandlerMap["mouseup"],
  pointerdown: mouseEventHandler as EventHandlerMap["pointerdown"],
  pointermove: mouseEventHandler as EventHandlerMap["pointermove"],
  pointerup: mouseEventHandler as EventHandlerMap["pointerup"],
  touchstart: touchEventHandler as EventHandlerMap["touchstart"],
  touchmove: touchEventHandler as EventHandlerMap["touchmove"],
  touchend: touchEventHandler as EventHandlerMap["touchend"],
  wheel: wheelEventHandler as EventHandlerMap["wheel"],
  keydown: filteredKeydownEventHandler as EventHandlerMap["keydown"],
};

let nextProxyId = 0;

/**
 * Main thread element proxy that forwards DOM events to worker.
 */
export class ElementProxy {
  readonly id: number;
  private worker: Worker;
  private element: HTMLElement;
  private resizeObserver: ResizeObserver;
  /** Bound event listeners for cleanup */
  private boundListeners: Map<string, EventListener> = new Map();

  constructor(element: HTMLElement, worker: Worker) {
    this.id = nextProxyId++;
    this.worker = worker;
    this.element = element;

    const sendEvent = (data: Vis2EventData) => {
      this.worker.postMessage({
        type: "event",
        id: this.id,
        data,
      });
    };

    // Register the proxy with the worker
    worker.postMessage({
      type: "makeProxy",
      id: this.id,
    });

    // Send initial size
    this.sendSize();

    // Register event listeners and store references for cleanup
    for (const [eventName, handler] of Object.entries(EVENT_HANDLERS)) {
      if (handler) {
        const boundListener = (event: Event) =>
          handler(event as never, sendEvent);
        this.boundListeners.set(eventName, boundListener);
        element.addEventListener(eventName, boundListener, { passive: false });
      }
    }

    // Use ResizeObserver for size changes
    this.resizeObserver = new ResizeObserver(() => this.sendSize());
    this.resizeObserver.observe(element);
  }

  /**
   * Send the current element size to worker.
   */
  sendSize(): void {
    const rect = this.element.getBoundingClientRect();
    this.worker.postMessage({
      type: "event",
      id: this.id,
      data: {
        type: "size",
        left: rect.left,
        top: rect.top,
        width: this.element.clientWidth,
        height: this.element.clientHeight,
      },
    });
  }

  /**
   * Dispose the proxy and clean up event listeners.
   */
  dispose(): void {
    this.resizeObserver.disconnect();

    // Remove all event listeners to prevent memory leaks
    for (const [eventName, listener] of this.boundListeners) {
      this.element.removeEventListener(eventName, listener);
    }
    this.boundListeners.clear();
  }
}

/**
 * Provides inert DOM methods required by OrbitControls on the worker-side proxy.
 */
function noop() {}

/**
 * Worker-side element proxy receiver that mimics a DOM element for OrbitControls.
 * Extends EventDispatcher so OrbitControls can use addEventListener/removeEventListener.
 */
export class ElementProxyReceiver extends EventDispatcher<{
  [K in Vis2EventData["type"]]: { type: K };
}> {
  // OrbitControls tries to set style.touchAction
  style: Record<string, string> = {};

  // Dimensions set from size events
  left = 0;
  top = 0;
  width = 0;
  height = 0;

  // Mock ownerDocument for OrbitControls
  ownerDocument: ElementProxyReceiver | null = null;

  get clientWidth(): number {
    return this.width;
  }

  get clientHeight(): number {
    return this.height;
  }

  /**
   * Accepts OrbitControls pointer-capture calls without requiring DOM state in the worker.
   */
  setPointerCapture(): void {}
  releasePointerCapture(): void {}

  /**
   * Returns this proxy as its own root so OrbitControls can resolve document-like APIs.
   */
  getRootNode(): ElementProxyReceiver {
    return this;
  }

  /**
   * Reports the worker-side canvas bounds used by OrbitControls coordinate calculations.
   */
  getBoundingClientRect(): DOMRect {
    return {
      left: this.left,
      top: this.top,
      width: this.width,
      height: this.height,
      right: this.left + this.width,
      bottom: this.top + this.height,
      x: this.left,
      y: this.top,
      toJSON: () => ({}),
    };
  }

  /**
   * Handle an event from the main thread.
   */
  handleEvent(data: Vis2EventData): void {
    if (data.type === "size") {
      this.left = data.left;
      this.top = data.top;
      this.width = data.width;
      this.height = data.height;
      return;
    }

    // Add preventDefault/stopPropagation to match DOM event interface
    const eventWithMethods = {
      ...data,
      preventDefault: noop,
      stopPropagation: noop,
    };
    this.dispatchEvent(eventWithMethods);
  }

  /**
   * Accepts OrbitControls focus calls without moving browser focus from the main thread.
   */
  focus(): void {}
}

/**
 * Manager for multiple element proxy receivers in the worker.
 */
export class ProxyManager {
  private targets: Map<number, ElementProxyReceiver> = new Map();

  /**
   * Create a new proxy receiver for the given ID.
   */
  makeProxy(id: number): void {
    const proxy = new ElementProxyReceiver();
    this.targets.set(id, proxy);
  }

  /**
   * Get a proxy receiver by ID.
   */
  getProxy(id: number): ElementProxyReceiver | undefined {
    return this.targets.get(id);
  }

  /**
   * Handle an event message from the main thread.
   */
  handleEvent(id: number, data: Vis2EventData): void {
    this.targets.get(id)?.handleEvent(data);
  }
}
