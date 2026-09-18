// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { IconProps } from "@squidlab/phosphor-solid";
import { type Component, createComponent } from "solid-js";
import { render } from "solid-js/web";

export type AppIcon = Component<IconProps>;

const mountedIconDisposers = new WeakMap<HTMLElement, () => void>();

/** Renders an icon component into an imperative DOM host and disposes any prior mount. */
export function renderIconComponent(
  host: HTMLElement,
  Icon: AppIcon | undefined,
  className: string,
): void {
  mountedIconDisposers.get(host)?.();
  mountedIconDisposers.delete(host);
  host.replaceChildren();

  if (!Icon) {
    return;
  }

  const dispose = render(
    () => createComponent(Icon, { class: className, "aria-hidden": "true" }),
    host,
  );
  mountedIconDisposers.set(host, dispose);
}
