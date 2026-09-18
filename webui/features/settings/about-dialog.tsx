// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { CopyIcon } from "@squidlab/phosphor-solid/copy";
import { FileTextIcon } from "@squidlab/phosphor-solid/file-text";
import { FolderOpenIcon } from "@squidlab/phosphor-solid/folder-open";
import { XIcon } from "@squidlab/phosphor-solid/x";
import { createSignal } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useAppShell } from "../../components/providers/app-shell";
import {
  DialogBackdrop,
  DialogBody,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../../components/ui/dialog";
import Modal from "../../components/ui/modal";
import Tooltip from "../../components/ui/tooltip";
import { Button } from "../../components/ui/visual-language/button";
import {
  APP_BUILD_ID,
  APP_BUILD_NAME,
  APP_COPYRIGHT,
  APP_LICENSE,
  APP_NAME,
  APP_VERSION,
} from "../../lib/app-metadata";
import { getLogger } from "../../lib/logger";
import {
  getNightfallDataDirectoryPath,
  isTauriRuntime,
  openDataDirectory,
} from "../../lib/tauri";
import { pushToast, serverVersion } from "../../state/appStores";
import ThirdPartyNotices from "./third-party-notices";

const log = getLogger(import.meta.url);
/** Presents application metadata, data-directory actions and bundled licenses. */
export function AboutDialog() {
  const { isAboutOpen, closeAbout } = useAppShell();
  const connectedVersion = useStore(serverVersion);
  const [isOpeningDataDirectory, setIsOpeningDataDirectory] =
    createSignal(false);
  const [isThirdPartyLicensesOpen, setIsThirdPartyLicensesOpen] =
    createSignal(false);

  /** Prefers the connected engine version and falls back to the bundled UI version. */
  const displayedVersion = () => connectedVersion() || APP_VERSION;
  const showOpenDataDirectory = isTauriRuntime();

  /** Describes the available directory action and its pending state. */
  const dataDirectoryActionLabel = () =>
    showOpenDataDirectory
      ? isOpeningDataDirectory()
        ? "Opening Data Directory..."
        : "Open Data Directory"
      : "Copy Data Directory Path";

  /** Resolves the directory tooltip, including environments without a local path. */
  const dataDirectoryPath = () => {
    try {
      return getNightfallDataDirectoryPath();
    } catch {
      return "Unable to determine nightfall data directory path";
    }
  };

  /** Closes the About dialog and any nested license view. */
  const handleCloseAbout = () => {
    setIsThirdPartyLicensesOpen(false);
    closeAbout();
  };

  /** Shows the bundled notices above the About dialog. */
  const openThirdPartyLicenses = () => {
    setIsThirdPartyLicensesOpen(true);
  };

  /** Returns from the bundled notices to the About dialog. */
  const closeThirdPartyLicenses = () => {
    setIsThirdPartyLicensesOpen(false);
  };

  /** Opens the native data directory and reports the outcome without duplicate requests. */
  const handleOpenDataDirectory = async () => {
    if (isOpeningDataDirectory()) {
      return;
    }

    setIsOpeningDataDirectory(true);
    try {
      await openDataDirectory();
      pushToast("success", "Opened nightfall data directory");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast("error", `Failed to open data directory: ${message}`);
      log.error("Failed to open data directory:", { error });
    } finally {
      setIsOpeningDataDirectory(false);
    }
  };

  /** Copies the data directory path and reports clipboard failures. */
  const handleCopyDataDirectoryPath = async () => {
    if (!navigator?.clipboard?.writeText) {
      pushToast("error", "Clipboard access unavailable");
      return;
    }

    try {
      await navigator.clipboard.writeText(getNightfallDataDirectoryPath());
      pushToast("success", "Copied nightfall data directory path");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast("error", `Failed to copy data directory path: ${message}`);
      log.error("Failed to copy data directory path:", { error });
    }
  };

  return (
    <>
      <Modal isOpen={isAboutOpen()} onEscape={handleCloseAbout}>
        <DialogBackdrop
          role="dialog"
          aria-modal="true"
          aria-label={`About ${APP_NAME}`}
          onClick={handleCloseAbout}
          onKeyDown={(e) => e.key === "Enter" && handleCloseAbout()}
        >
          <DialogSurface
            role="document"
            style={{ "max-width": "550px" }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <DialogHeader>
              <DialogTitle>About</DialogTitle>
              <Button
                size="icon"
                variant="subtle"
                type="button"
                onClick={handleCloseAbout}
                aria-label="Close about dialog"
              >
                <XIcon class="size-5" aria-hidden />
              </Button>
            </DialogHeader>

            <DialogBody class="space-y-5">
              <div class="flex items-center gap-4">
                <img
                  src={`${import.meta.env.BASE_URL}logo.svg`}
                  alt={`${APP_NAME} logo`}
                  class="size-16 rounded-xl border border-gray-700 bg-[#0B1020] p-2 shadow-inner"
                />
                <div class="min-w-0">
                  <h3 class="text-xl font-semibold text-gray-50">{APP_NAME}</h3>
                  <p class="text-sm text-gray-400">
                    Lighting control and visualization
                  </p>
                </div>
              </div>

              <div class="grid gap-3 rounded-lg border border-gray-700 bg-gray-900/60 p-4 text-sm">
                <div class="flex items-center justify-between gap-3">
                  <span class="text-gray-400">Version</span>
                  <span class="font-mono text-gray-100">
                    {displayedVersion()}
                  </span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-gray-400">Build ID</span>
                  <span class="font-mono text-gray-100">{APP_BUILD_ID}</span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-gray-400">Build Name</span>
                  <span
                    data-testid="build-name"
                    class="min-w-0 truncate font-mono text-gray-100"
                  >
                    {APP_BUILD_NAME}
                  </span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-gray-400">License</span>
                  <span class="text-gray-100">{APP_LICENSE}</span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-gray-400">Copyright</span>
                  <span class="text-gray-100" innerHTML={APP_COPYRIGHT} />
                </div>
              </div>

              <div class="flex justify-end">
                <Tooltip
                  position="top"
                  content={() => (
                    <span class="block max-w-[min(28rem,calc(100vw-2rem))] whitespace-normal break-all text-left font-mono">
                      {dataDirectoryPath()}
                    </span>
                  )}
                >
                  <Button
                    size="compact"
                    type="button"
                    class="items-center gap-2"
                    disabled={showOpenDataDirectory && isOpeningDataDirectory()}
                    onClick={() =>
                      void (showOpenDataDirectory
                        ? handleOpenDataDirectory()
                        : handleCopyDataDirectoryPath())
                    }
                  >
                    <Dynamic
                      component={
                        showOpenDataDirectory ? FolderOpenIcon : CopyIcon
                      }
                      class="size-4"
                      aria-hidden
                    />
                    <span>{dataDirectoryActionLabel()}</span>
                  </Button>
                </Tooltip>
              </div>

              <div class="space-y-3 rounded-lg border border-gray-700 bg-gray-900/40 p-4">
                <h4 class="text-sm font-semibold text-gray-100">
                  Third-Party Notices
                </h4>
                <p class="text-sm leading-6 text-gray-400">
                  Licenses and attributions for software and assets included in
                  this distribution.
                </p>
                <Button
                  size="compact"
                  type="button"
                  class="items-center gap-2"
                  onClick={openThirdPartyLicenses}
                >
                  <FileTextIcon class="size-4" aria-hidden />
                  <span>View Third-Party Licenses</span>
                </Button>
              </div>
            </DialogBody>
          </DialogSurface>
        </DialogBackdrop>
      </Modal>

      <Modal
        isOpen={isAboutOpen() && isThirdPartyLicensesOpen()}
        onEscape={closeThirdPartyLicenses}
      >
        <DialogBackdrop
          role="dialog"
          aria-modal="true"
          aria-label="Third-Party Licenses"
          onClick={closeThirdPartyLicenses}
          onKeyDown={(e) => e.key === "Enter" && closeThirdPartyLicenses()}
        >
          <DialogSurface
            role="document"
            style={{ "max-width": "680px" }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <DialogHeader>
              <div>
                <DialogTitle>Third-Party Licenses</DialogTitle>
                <p class="text-sm text-gray-400">
                  Bundled notices for nightfall
                </p>
              </div>
              <Button
                size="icon"
                variant="subtle"
                type="button"
                onClick={closeThirdPartyLicenses}
                aria-label="Close third-party licenses dialog"
              >
                <XIcon class="size-5" aria-hidden />
              </Button>
            </DialogHeader>

            <DialogBody class="space-y-4">
              <ThirdPartyNotices active={isThirdPartyLicensesOpen()} />
            </DialogBody>
          </DialogSurface>
        </DialogBackdrop>
      </Modal>
    </>
  );
}
