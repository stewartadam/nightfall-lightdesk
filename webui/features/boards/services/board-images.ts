// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getBackendUrl } from "../../../lib/api";
import { getLogger } from "../../../lib/logger";
import { resolveShowfileResourceUrl } from "../../../lib/showfile-resources";

const log = getLogger(import.meta.url);

/** File types the image picker offers; the backend checks the contents again. */
export const BOARD_IMAGE_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.png,.jpg,.jpeg,.webp,.gif,.svg";

/** Folder of the open show that holds button images. */
const BOARD_IMAGE_DIR = "board-images";

/**
 * Returns the URL of a stored button image, or `undefined` when no show is mounted yet.
 *
 * Image IDs are content hashes, so the URL needs no revision to stay fresh.
 */
export function boardImageUrl(image: string): string | undefined {
  try {
    return resolveShowfileResourceUrl(`${BOARD_IMAGE_DIR}/${image}`);
  } catch (error) {
    log.debug("Board image URL unavailable", { image, error });
    return undefined;
  }
}

/**
 * Uploads an image file into the open show's button images and returns the ID to store on
 * the element. The backend shrinks raster images and rejects unsupported files; its message is
 * thrown as the error.
 */
export async function uploadBoardImage(file: File): Promise<string> {
  const body = new FormData();
  body.append("file", file, file.name);
  const response = await fetch(
    `${getBackendUrl()}/api/showfiles/current/${BOARD_IMAGE_DIR}`,
    { method: "POST", body },
  );
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Upload failed with status ${response.status}`);
  }
  const payload = (await response.json()) as { image: string };
  return payload.image;
}
