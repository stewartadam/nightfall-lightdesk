// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Clipboard access that also works when the UI is loaded over plain HTTP from
 * another device, where browsers withhold `navigator.clipboard`.
 */

import { overlayHost } from "../components/ui/modal/dialog-stack";

/** Raised when the browser offers no way to perform the clipboard operation. */
export class ClipboardUnavailableError extends Error {
  /** Creates the error with a message suitable for showing to the operator. */
  constructor(message: string) {
    super(message);
    this.name = "ClipboardUnavailableError";
  }
}

/**
 * Returns the async Clipboard API, which browsers only expose in secure
 * contexts (HTTPS or localhost) despite the DOM typings declaring it always.
 */
function asyncClipboard(): Clipboard | undefined {
  return (
    (globalThis.navigator as Navigator | undefined)?.clipboard ?? undefined
  );
}

/**
 * Copies text through a temporary selection, the only copy path browsers allow
 * outside secure contexts. The textarea mounts in the topmost open dialog so a
 * modal's inert backdrop cannot block the selection.
 */
function copyWithSelection(text: string): boolean {
  const previousFocus = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  overlayHost().append(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } finally {
    textarea.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
}

/**
 * Writes text to the system clipboard, falling back to a selection-based copy
 * when the async Clipboard API is missing. Rejects when neither path works.
 */
export async function writeClipboardText(text: string): Promise<void> {
  const clipboard = asyncClipboard();
  if (clipboard) {
    await clipboard.writeText(text);
    return;
  }
  if (typeof document === "undefined" || !copyWithSelection(text)) {
    throw new ClipboardUnavailableError("Clipboard access unavailable");
  }
}

/**
 * Reads text from the system clipboard. Browsers expose no fallback for reads
 * outside secure contexts, so this rejects with an explanation there.
 */
export async function readClipboardText(): Promise<string> {
  const clipboard = asyncClipboard();
  if (!clipboard) {
    throw new ClipboardUnavailableError(
      "Paste is unavailable on this connection; open the app over HTTPS or on this computer",
    );
  }
  return clipboard.readText();
}
