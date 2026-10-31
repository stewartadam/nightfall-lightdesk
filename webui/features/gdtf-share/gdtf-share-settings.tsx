// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, onMount, Show } from "solid-js";
import { Alert } from "../../components/ui/alert";
import { Input } from "../../components/ui/form-controls";
import { PasswordField } from "../../components/ui/password-field";
import { SettingsRow, SettingsSection } from "../../components/ui/settings-row";
import { Button } from "../../components/ui/visual-language/button";
import { getLogger } from "../../lib/logger";
import {
  type GdtfShareAccountStatus,
  GdtfShareCredentialSource,
} from "../../types";
import { requestGdtfShareAccount } from "./account";

const log = getLogger(import.meta.url);

/** Where people create the free account GDTF Share requires. */
const GDTF_SHARE_URL = "https://gdtf-share.com";

/** Width shared by the username and password fields, so the form lines up. */
const FIELD_WIDTH = { width: "15rem" };

/**
 * Explains where the account is or will be kept, so people know whether it survives a
 * restart. Without a status yet, it assumes the keychain, which is the usual case.
 */
function storageNote(status: GdtfShareAccountStatus | undefined): string {
  if (status?.source === GdtfShareCredentialSource.Environment) {
    return "Set by GDTF_SHARE_USER and GDTF_SHARE_PASSWORD on the computer running Nightfall.";
  }
  if (
    status?.source === GdtfShareCredentialSource.Session ||
    status?.keychain_available === false
  ) {
    return "The system keychain isn't available, so you'll need to sign in again after Nightfall restarts.";
  }
  return "Your account is saved in this computer's keychain.";
}

/**
 * Signs the engine in to GDTF Share or out of it. The account belongs to the engine, so every
 * connected device sees the same one; the password is only accepted from the computer
 * running Nightfall, and the engine answers other devices with a message saying so.
 */
export function GdtfShareSettings() {
  const [status, setStatus] = createSignal<GdtfShareAccountStatus>();
  const [user, setUser] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();

  /** Runs one account request, keeping its result or showing its failure. */
  const run = async (request: () => Promise<GdtfShareAccountStatus>) => {
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await request());
      setPassword("");
    } catch (failure) {
      const message =
        failure instanceof Error ? failure.message : String(failure);
      log.warn(`GDTF Share account request failed: ${message}`);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  /** Loads the engine's account when Settings shows this section; a failure leaves the form usable. */
  onMount(() => void run(() => requestGdtfShareAccount("status")));

  /** Signs in with the typed credentials, once both are filled in. */
  const signIn = () => {
    if (busy() || !user().trim() || !password()) return;
    void run(() =>
      requestGdtfShareAccount("sign-in", {
        user: user(),
        password: password(),
      }),
    );
  };

  /** Submits the form from either field with Enter. */
  const submitOnEnter = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    signIn();
  };

  /** The last request's failure, shown beside the button that sent it. */
  const errorAlert = () => (
    <Show when={error()}>
      {(message) => (
        <Alert variant="caution" density="compact">
          {message()}
        </Alert>
      )}
    </Show>
  );

  return (
    <SettingsSection title="GDTF Share" footer={storageNote(status())}>
      <Show
        when={status()?.user}
        fallback={
          // One entry, so the section draws no dividers between the form's fields and button.
          <div data-testid="gdtf-share-sign-in-form">
            <p class="pt-2 text-xs leading-[1.45] text-gray-400">
              Sign in with your free{" "}
              <a
                class="text-blue-300 underline"
                href={GDTF_SHARE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                GDTF Share
              </a>{" "}
              account to find and download fixture profiles from its library.
            </p>
            <SettingsRow
              label="Username"
              setting="gdtf-share-user"
              keywords="GDTF Share account email login sign in"
            >
              {(field) => (
                <Input
                  id={field.id}
                  aria-describedby={field.describedBy}
                  autocomplete="username"
                  value={user()}
                  readOnly={busy()}
                  style={FIELD_WIDTH}
                  onInput={(event) => setUser(event.currentTarget.value)}
                  onKeyDown={submitOnEnter}
                  data-testid="gdtf-share-user"
                />
              )}
            </SettingsRow>
            <SettingsRow label="Password" keywords="GDTF Share account login">
              {(field) => (
                <PasswordField
                  id={field.id}
                  aria-describedby={field.describedBy}
                  autocomplete="current-password"
                  value={password()}
                  readOnly={busy()}
                  style={FIELD_WIDTH}
                  onInput={(event) => setPassword(event.currentTarget.value)}
                  onKeyDown={submitOnEnter}
                  data-testid="gdtf-share-password"
                />
              )}
            </SettingsRow>
            <div class="flex flex-col items-end gap-2 pt-1 pb-2">
              {errorAlert()}
              <Button
                variant="primary"
                disabled={busy() || !user().trim() || !password()}
                onClick={signIn}
                data-testid="gdtf-share-sign-in"
              >
                {busy() && status() ? "Signing in…" : "Sign in"}
              </Button>
            </div>
          </div>
        }
      >
        {(signedInUser) => (
          <SettingsRow
            label={`Signed in as ${signedInUser()}`}
            labelControl={false}
            keywords="GDTF Share account sign out logout"
            details={errorAlert()}
            data-testid="gdtf-share-account"
          >
            {() => (
              <Show
                when={
                  status()?.source !== GdtfShareCredentialSource.Environment
                }
              >
                <Button
                  disabled={busy()}
                  onClick={() =>
                    void run(() => requestGdtfShareAccount("sign-out"))
                  }
                  data-testid="gdtf-share-sign-out"
                >
                  Sign out
                </Button>
              </Show>
            )}
          </SettingsRow>
        )}
      </Show>
    </SettingsSection>
  );
}
