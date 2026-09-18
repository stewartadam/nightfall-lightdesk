// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type EditableShortcutHandler,
  isInputField,
  shortcutHandlersForTarget,
} from "./keyboard-shortcut-targets";

class FakeHTMLElement {
  isContentEditable = false;
  tagName: string;

  /** Creates an HTMLElement-compatible test double with the requested tag name. */
  constructor(tagName = "DIV") {
    this.tagName = tagName;
  }

  /** Reports no selector matches unless a test subclass overrides it. */
  closest(_selector: string): FakeHTMLElement | null {
    return null;
  }
}

class FakeDataGridInputElement extends FakeHTMLElement {
  /** Reports TanStack data-grid membership for data-grid shortcut exceptions. */
  override closest(selector: string): FakeHTMLElement | null {
    return selector === '[data-grid-kind="tanstack"]' ? this : null;
  }
}

/**
 * Installs a minimal HTMLElement constructor so helper code can use DOM types
 * under Node's test runner.
 */
function installHTMLElementStub() {
  const previousHTMLElement = Object.getOwnPropertyDescriptor(
    globalThis,
    "HTMLElement",
  );
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: FakeHTMLElement,
  });

  return {
    /** Restores the previous HTMLElement global after the test finishes. */
    restore() {
      if (previousHTMLElement) {
        Object.defineProperty(globalThis, "HTMLElement", previousHTMLElement);
        return;
      }
      delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
    },
  };
}

/** Builds a shortcut handler record for editable-target filtering tests. */
function handler(allowInEditable = false): EditableShortcutHandler {
  return { allowInEditable };
}

/** Standard form controls are treated as editable shortcut targets. */
test("isInputField detects native editable elements", () => {
  const dom = installHTMLElementStub();

  try {
    assert.equal(isInputField(new FakeHTMLElement("INPUT") as never), true);
    assert.equal(isInputField(new FakeHTMLElement("TEXTAREA") as never), true);
    assert.equal(isInputField(new FakeHTMLElement("SELECT") as never), true);
    assert.equal(isInputField(new FakeHTMLElement("DIV") as never), false);
  } finally {
    dom.restore();
  }
});

/** Modified shortcuts from inputs keep native editing unless they opt in. */
test("editable targets keep only shortcuts that allow editable handling", () => {
  const dom = installHTMLElementStub();
  const blocked = handler();
  const allowed = handler(true);

  try {
    assert.deepEqual(
      shortcutHandlersForTarget(
        [blocked, allowed],
        new FakeHTMLElement("INPUT") as never,
        { key: "z" },
      ),
      [allowed],
    );
  } finally {
    dom.restore();
  }
});

/** Non-editable targets keep all matching shortcut handlers available. */
test("non-editable targets keep all shortcut handlers", () => {
  const dom = installHTMLElementStub();
  const blocked = handler();
  const allowed = handler(true);

  try {
    assert.deepEqual(
      shortcutHandlersForTarget(
        [blocked, allowed],
        new FakeHTMLElement("DIV") as never,
        { key: "z" },
      ),
      [blocked, allowed],
    );
  } finally {
    dom.restore();
  }
});

/** Data-grid Enter keeps the existing grid commit/open shortcut exception. */
test("data-grid Enter keeps handlers even from editable inputs", () => {
  const dom = installHTMLElementStub();
  const blocked = handler();

  try {
    assert.deepEqual(
      shortcutHandlersForTarget(
        [blocked],
        new FakeDataGridInputElement("INPUT") as never,
        { key: "Enter" },
      ),
      [blocked],
    );
  } finally {
    dom.restore();
  }
});
