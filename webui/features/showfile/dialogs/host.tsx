// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useAppShell } from "../../../components/providers/app-shell";
import {
  importShowfile,
  openShowfileSelection,
} from "../../../lib/showfile-actions";
import { ExportShowfileModal } from "./export-showfile";
import { ShowfileImportModal } from "./import-showfile";
import { OpenShowfileModal } from "./open-showfile";

/** Hosts showfile dialogs and delegates backend work to the showfile action service. */
export default function ShowfileDialogs() {
  const {
    hideShowfileExportModal,
    isShowfileExportModalVisible,
    hideShowfileImportModal,
    hideOpenShowfileModal,
    isOpenShowfileModalVisible,
    isShowfileImportModalVisible,
  } = useAppShell();

  return (
    <>
      <ExportShowfileModal
        open={isShowfileExportModalVisible()}
        onClose={hideShowfileExportModal}
      />
      <OpenShowfileModal
        open={isOpenShowfileModalVisible()}
        onClose={hideOpenShowfileModal}
        onOpen={openShowfileSelection}
      />
      <ShowfileImportModal
        open={isShowfileImportModalVisible()}
        onClose={hideShowfileImportModal}
        onImport={importShowfile}
      />
    </>
  );
}
