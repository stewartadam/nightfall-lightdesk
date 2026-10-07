// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import { QrCodeIcon } from "@squidlab/phosphor-solid/qr-code";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Show,
} from "solid-js";
import { encode } from "uqr";
import Tooltip from "../../../components/ui/tooltip";
import { Button } from "../../../components/ui/visual-language/button";
import { getShareablePort } from "../../../lib/api";
import { writeClipboardText } from "../../../lib/clipboard";
import { getLogger } from "../../../lib/logger";
import {
  fetchPairingPin,
  formatPairingPin,
  regeneratePairingPin,
} from "../../../lib/pairing";
import {
  $availableNetworkInterfaces,
  $externalControlState,
} from "../../../state/settings";
import { shareableHosts, shareableUrl } from "../network/model";

const log = getLogger(import.meta.url);

/** Blank modules kept around the code so scanners can find its edges. */
const QR_QUIET_ZONE = 2;

/** Draws a QR code for `text` as crisp SVG modules on a white quiet zone. */
function QrCode(props: { text: string; label: string }): JSX.Element {
  /** Encodes the text, re-running only when it changes. */
  const code = createMemo(() => encode(props.text, { border: 0, ecc: "M" }));
  /** Joins the dark modules into one path so the SVG stays small. */
  const path = createMemo(() => {
    const segments: string[] = [];
    code().data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark)
          segments.push(`M${x + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h1v1h-1z`);
      });
    });
    return segments.join("");
  });
  /** Width of the drawing in modules, including the quiet zone. */
  const extent = () => code().size + QR_QUIET_ZONE * 2;

  return (
    <svg
      role="img"
      aria-label={props.label}
      viewBox={`0 0 ${extent()} ${extent()}`}
      shape-rendering="crispEdges"
      class="size-44 rounded bg-white"
    >
      <path d={path()} fill="#000" />
    </svg>
  );
}

/**
 * Shows how other devices reach this computer: a link per network address
 * with a QR code that also pairs, and the pairing PIN with an action that
 * replaces it. Renders nothing on a paired device, since only the computer
 * running Nightfall may read the PIN.
 */
export function RemoteAccess() {
  const state = useStore($externalControlState);
  const interfaces = useStore($availableNetworkInterfaces);
  /** Loads the PIN, resolving to null where the backend refuses to show it. */
  const [pin, { mutate }] = createResource(async () => {
    try {
      return await fetchPairingPin();
    } catch (error) {
      log.debug("Pairing PIN is not readable from this device", error);
      return null;
    }
  });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal<string | null>(null);
  const [pinnedQr, setPinnedQr] = createSignal<string | null>(null);
  /** Lists one link per address other devices can reach, without the PIN. */
  const links = createMemo(() =>
    shareableHosts(state().listening_addresses, interfaces()).map((host) =>
      shareableUrl(host, getShareablePort()),
    ),
  );

  /** Replaces the PIN; devices paired with the old one must pair again. */
  const regenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      mutate(await regeneratePairingPin());
    } catch (failure) {
      log.warn("Failed to regenerate the pairing PIN", failure);
      setError("Could not create a new PIN.");
    } finally {
      setBusy(false);
    }
  };

  /** Copies a link without the PIN, so a pasted link still asks for it. */
  const copy = async (link: string) => {
    try {
      await writeClipboardText(link);
      setCopied(link);
      window.setTimeout(() => setCopied(null), 1500);
    } catch (failure) {
      log.warn("Failed to copy the link", failure);
    }
  };

  return (
    <Show when={pin()}>
      {(current) => (
        <div class="mt-2 space-y-2 text-xs text-gray-400">
          <Show when={links().length > 0}>
            <div class="flex flex-wrap items-center gap-2">
              <span>Open on another device</span>
              <For each={links()}>
                {(link) => (
                  <span class="inline-flex items-center gap-1">
                    <button
                      type="button"
                      class="font-mono text-gray-100 underline decoration-gray-600 underline-offset-2 hover:decoration-gray-300"
                      title="Copy link"
                      onClick={() => void copy(link)}
                    >
                      {copied() === link ? "Copied" : link}
                    </button>
                    <Tooltip
                      interactive
                      delay={150}
                      position="bottom"
                      forceVisible={() => pinnedQr() === link}
                      content={() => (
                        <div class="flex flex-col items-center gap-2 p-1">
                          <QrCode
                            text={shareableUrl(
                              new URL(link).hostname,
                              getShareablePort(),
                              current(),
                            )}
                            label={`QR code to open ${link} and pair`}
                          />
                          <span class="text-xs text-gray-300">
                            Scan to open and pair
                          </span>
                          <Show when={import.meta.env.DEV}>
                            <span class="max-w-44 text-center text-[11px] text-amber-300">
                              Development builds need Vite started with --host
                              for this link to work.
                            </span>
                          </Show>
                        </div>
                      )}
                    >
                      <Button
                        size="icon"
                        type="button"
                        aria-label={`Show QR code for ${link}`}
                        aria-expanded={pinnedQr() === link}
                        onClick={() =>
                          setPinnedQr(pinnedQr() === link ? null : link)
                        }
                      >
                        <QrCodeIcon class="size-4" aria-hidden />
                      </Button>
                    </Tooltip>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <div class="flex flex-wrap items-center gap-2">
            <span>Pairing PIN</span>
            <span
              class="font-mono text-sm tracking-widest text-gray-100"
              data-testid="remote-pairing-pin"
            >
              {formatPairingPin(current())}
            </span>
            <Button
              size="compact"
              type="button"
              class="items-center gap-1.5"
              title="Create a new PIN and sign out every paired device"
              disabled={busy()}
              onClick={() => void regenerate()}
            >
              <ArrowsClockwiseIcon class="size-4" aria-hidden />
              <span>New PIN</span>
            </Button>
            <Show when={error()}>
              {(message) => (
                <span class="text-red-300" role="alert">
                  {message()}
                </span>
              )}
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}
