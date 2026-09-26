// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { onCleanup, onMount, type ParentProps } from "solid-js";
import { Portal } from "solid-js/web";
import Toastify from "toastify-js";

/** Keeps live activity visible until its owner unmounts, without retaining stale history actions. */
export function PersistentToast(props: ParentProps<{ label: string }>) {
  const node = document.createElement("div");
  const toast = Toastify({
    node,
    duration: -1,
    gravity: "top",
    position: "right",
    className: "!bg-transparent !shadow-none !p-0",
    offset: { x: 16, y: 0 },
  });
  // Toastify's default click callback stops bubbling, which blocks Solid's delegated events.
  toast.options.onClick = undefined;
  /** Aligns the shared toast stack when reactive activity content changes size. */
  onMount(() => {
    toast.showToast();
    const observer = new ResizeObserver(() => Toastify.reposition());
    observer.observe(node);
    onCleanup(() => {
      observer.disconnect();
      toast.hideToast();
    });
  });
  return (
    <Portal mount={node}>
      <section
        aria-label={props.label}
        class="max-w-sm rounded-xl border border-gray-200 bg-white p-4 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
      >
        {props.children}
      </section>
    </Portal>
  );
}
