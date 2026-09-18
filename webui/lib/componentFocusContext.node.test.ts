// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  focusTrackedComponent,
  getFocusedComponentId,
  registerComponentFocus,
  setDockApiGetter,
  updateFocusedComponent,
} from "./componentFocusContext";

type FakeElement = {
  addEventListener: () => void;
  contains: (node: unknown) => boolean;
  removeEventListener: () => void;
};

/** Creates a minimal HTMLElement-like object for focus-context tests. */
function createFakeElement(children: Set<unknown> = new Set()): FakeElement {
  return {
    addEventListener: () => {},
    contains: (node: unknown) => children.has(node),
    removeEventListener: () => {},
  };
}

/** Installs the minimal document shape used by focus resolution. */
function installDocumentStub(
  body: unknown,
  documentElement: unknown,
): () => void {
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      activeElement: body,
      body,
      documentElement,
    },
  });

  return () => {
    if (previousDocument) {
      Object.defineProperty(globalThis, "document", previousDocument);
      return;
    }
    delete (globalThis as { document?: unknown }).document;
  };
}

/** Verifies keyboard focus updates do not restore stale visualizer focus through DockView fallback. */
test("keyboard focus from unregistered inputs clears stale component focus", () => {
  const body = createFakeElement();
  const documentElement = createFakeElement();
  const visualizerChild = createFakeElement();
  const commandInput = createFakeElement();
  const visualizerRoot = createFakeElement(new Set([visualizerChild]));
  const restoreDocument = installDocumentStub(body, documentElement);

  setDockApiGetter(
    () =>
      ({
        activePanel: { id: "panel-Visualizer" },
      }) as never,
  );

  const unregister = registerComponentFocus(
    "panel-Visualizer",
    visualizerRoot as never,
  );

  try {
    updateFocusedComponent(visualizerChild as never);
    assert.equal(getFocusedComponentId(), "panel-Visualizer");

    updateFocusedComponent(commandInput as never, {
      allowDockFallback: false,
    });
    assert.equal(getFocusedComponentId(), null);

    updateFocusedComponent(body as never, { allowDockFallback: false });
    assert.equal(getFocusedComponentId(), null);
  } finally {
    unregister();
    setDockApiGetter(() => null);
    restoreDocument();
  }
});

/** Dockview focus can recover panel shortcuts from stale non-editable DOM focus. */
test("dock active panel overrides stale non-editable component focus", () => {
  const body = createFakeElement();
  const documentElement = createFakeElement();
  const visualizerRoot = createFakeElement();
  const gridFocusTarget = createFakeElement();
  const gridRoot = createFakeElement(new Set([gridFocusTarget]));
  const restoreDocument = installDocumentStub(body, documentElement);

  setDockApiGetter(
    () =>
      ({
        activePanel: { id: "panel-Visualizer" },
      }) as never,
  );

  const unregisterVisualizer = registerComponentFocus(
    "panel-Visualizer",
    visualizerRoot as never,
  );
  const unregisterGrid = registerComponentFocus(
    "panel-Patch",
    gridRoot as never,
  );

  try {
    focusTrackedComponent("panel-Patch");
    updateFocusedComponent(gridFocusTarget as never, {
      allowDockFallback: false,
    });
    assert.equal(getFocusedComponentId(), "panel-Visualizer");
  } finally {
    unregisterGrid();
    unregisterVisualizer();
    setDockApiGetter(() => null);
    restoreDocument();
  }
});

/** Editable DOM focus keeps bare text shortcuts out of panel-local handlers. */
test("editable component focus is not overridden by dock active panel", () => {
  const body = createFakeElement();
  const documentElement = createFakeElement();
  const visualizerRoot = createFakeElement();
  const commandInput = {
    ...createFakeElement(),
    tagName: "INPUT",
  };
  const commandRoot = createFakeElement(new Set([commandInput]));
  const restoreDocument = installDocumentStub(body, documentElement);

  setDockApiGetter(
    () =>
      ({
        activePanel: { id: "panel-Visualizer" },
      }) as never,
  );

  const unregisterVisualizer = registerComponentFocus(
    "panel-Visualizer",
    visualizerRoot as never,
  );
  const unregisterCommand = registerComponentFocus(
    "panel-CommandLine",
    commandRoot as never,
  );

  try {
    focusTrackedComponent("panel-Visualizer");
    updateFocusedComponent(commandInput as never, { allowDockFallback: false });
    assert.equal(getFocusedComponentId(), "panel-CommandLine");
  } finally {
    unregisterCommand();
    unregisterVisualizer();
    setDockApiGetter(() => null);
    restoreDocument();
  }
});

/** Disposing a retained copy cannot unregister another workspace's copy of the same panel. */
test("duplicate panel IDs retain independent focus registrations", () => {
  const first = registerComponentFocus(
    "retained-panel",
    createFakeElement() as unknown as HTMLElement,
  );
  const second = registerComponentFocus(
    "retained-panel",
    createFakeElement() as unknown as HTMLElement,
  );
  first();
  focusTrackedComponent("retained-panel");
  assert.equal(getFocusedComponentId(), "retained-panel");
  second();
  assert.equal(getFocusedComponentId(), null);
});
