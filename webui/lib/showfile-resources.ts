// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getBackendUrl } from "./api";

let activeShowfileUrl: string | null = null;

/** Configure the URL of the showfile that owns runtime-relative resources. */
export function configureActiveShowfileUrl(showfileUrl: string | null): void {
  activeShowfileUrl = showfileUrl;
}

/** Return the native backend URL representing the currently mounted showfile. */
export function resolveCurrentNativeShowfileUrl(
  backendUrl: string = getBackendUrl(),
): string {
  return new URL("/api/showfiles/current/showfile.json", backendUrl).href;
}

/** Resolve a safe relative resource path against its owning showfile URL. */
export function resolveShowfileResourceUrl(
  resourcePath: string,
  revision?: string | number,
  showfileUrl: string | null = activeShowfileUrl,
): string {
  const normalizedPath = resourcePath.trim().replace(/\\/g, "/");
  if (!normalizedPath) return "";
  if (!showfileUrl) {
    throw new Error("Active showfile URL is not configured");
  }

  const pathSegments = normalizedPath.split("/");
  if (
    normalizedPath.startsWith("/") ||
    pathSegments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ) ||
    /^[a-z][a-z\d+.-]*:/i.test(normalizedPath)
  ) {
    throw new Error(`Invalid showfile resource path: ${resourcePath}`);
  }

  const showfile = new URL(showfileUrl);
  const resourceRoot = new URL(".", showfile);
  const resourceUrl = new URL(normalizedPath, showfile);
  if (
    resourceUrl.origin !== resourceRoot.origin ||
    !resourceUrl.pathname.startsWith(resourceRoot.pathname)
  ) {
    throw new Error(`Invalid showfile resource path: ${resourcePath}`);
  }
  if (revision !== undefined) {
    resourceUrl.searchParams.set("rev", `${revision}`);
  }
  return resourceUrl.href;
}
