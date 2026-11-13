// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getBackendUrl } from "../../../lib/api";
import {
  commandFailureMessage,
  commandOutputValue,
  commandSucceeded,
} from "../../../lib/command-result";
import { commandClient } from "../../../lib/engine-commands";
import type * as types from "../../../types";

/** Command module the engine registers rig import commands under. */
const RIG_IMPORT_MODULE = "RigImportCommand";

/** Upload route that reads an MVR file and returns its session. */
const UPLOAD_PATH = "/api/mvr-import";

/**
 * Uploads an MVR file for the engine to read, reporting upload progress from 0 to 1, and
 * resolves with the session to preview and import from.
 *
 * Uses XMLHttpRequest rather than fetch because only it reports upload progress, which matters
 * for rigs with venue models that run to hundreds of megabytes.
 */
export function uploadRigFile(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const url = `${getBackendUrl()}${UPLOAD_PATH}?name=${encodeURIComponent(file.name)}`;
    request.open("POST", url);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          const response = JSON.parse(
            request.responseText,
          ) as types.RigUploadResponse;
          resolve(response.session);
        } catch {
          reject(new Error("The engine sent an unreadable reply"));
        }
        return;
      }
      reject(
        new Error(request.responseText || `Upload failed (${request.status})`),
      );
    };
    request.onerror = () => reject(new Error("The upload failed"));
    request.send(file);
  });
}

/** Asks the engine what importing a read rig with `options` would do. */
export async function previewRig(
  session: string,
  options: types.RigImportOptions,
): Promise<types.RigImportPreview> {
  const result = await commandClient.invoke(RIG_IMPORT_MODULE, {
    type: "Preview",
    data: { session, options },
  } satisfies types.RigImportCommand);
  if (!commandSucceeded(result)) {
    throw new Error(commandFailureMessage(result, "Could not read the rig"));
  }
  return commandOutputValue(result) as types.RigImportPreview;
}

/** Imports a read rig's new fixtures as one undoable change. */
export async function commitRig(
  session: string,
  options: types.RigImportOptions,
): Promise<void> {
  const result = await commandClient.invoke(RIG_IMPORT_MODULE, {
    type: "Commit",
    data: { session, options },
  } satisfies types.RigImportCommand);
  if (!commandSucceeded(result)) {
    throw new Error(commandFailureMessage(result, "The import failed"));
  }
}

/** Tells the engine to forget a read rig and delete its extracted files. */
export function discardRig(session: string): void {
  commandClient.emit(RIG_IMPORT_MODULE, {
    type: "Discard",
    data: { session },
  } satisfies types.RigImportCommand);
}
