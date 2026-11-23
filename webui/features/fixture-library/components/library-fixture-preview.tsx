// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Library Fixture Preview Component (Visualizer)
 * Displays a 3D preview of a fixture in isolation using visualizer.
 *
 * This component fetches fixture profile data and passes the fixture definition
 * to the FixturePreview component for rendering.
 */

import { type Component, createMemo, createSignal } from "solid-js";
import { profileMatchesRevision } from "../../../lib/fixture-profile-match";
import { fetchFixtureProfile } from "../../../lib/fixture-service";
import { createEffect } from "../../../lib/solid-compat";
import { useStore } from "../../../lib/use-nanostore";
import { fixtureProfile } from "../../../state/appStores";
import type { Fixture, FixtureGeometry } from "../../../types";
import { FixturePreview, profileToPreviewFixture } from "../../visualizer";

type LibraryFixturePreviewProps = {
  make: string;
  model: string;
  mode?: string;
  /** Library revision to preview; the default revision when omitted. */
  assetEtag?: string;
  /**
   * Fills a sized container instead of using the fixed 300px height, so the
   * canvas never extends past a shorter container (where it would still catch
   * clicks meant for controls drawn over it).
   */
  fill?: boolean;
};

const LibraryFixturePreview: Component<LibraryFixturePreviewProps> = (
  props,
) => {
  // Fixture preview state.
  const [fixture, setFixture] = createSignal<Fixture | null>(null);
  const [geometry, setGeometry] = createSignal<FixtureGeometry | null>(null);

  // Subscribe to global fixture profile store
  const $fixtureProfile = useStore(fixtureProfile);

  // Clear preview data when fixture (make/model/revision) changes so stale renders disappear.
  createEffect(
    () => [props.make, props.model, props.assetEtag] as const,
    () => {
      setFixture(null);
      // (mode changes within same fixture should preserve geometry until new data arrives)
      setGeometry(null);
    },
    { defer: true },
  );

  // Fetch fixture profile when any prop changes.
  createEffect(
    () => [props.make, props.model, props.mode, props.assetEtag] as const,
    ([make, model, mode, assetEtag]) => {
      // Request profile from backend
      fetchFixtureProfile(make, model, mode, assetEtag);
    },
  );

  /** Shows the profile store's fixture and geometry once it holds the requested make, model and mode. */
  createEffect(
    () => {
      const profile = $fixtureProfile();
      if (!profile) return undefined;

      // Verify the response matches our current props (including empty mode responses).
      const modeMatches =
        !props.mode ||
        profile.requested_mode === props.mode ||
        profile.fixture?.mode === props.mode;

      const revisionMatches = profileMatchesRevision(profile, {
        make: props.make,
        model: props.model,
        asset_etag: props.assetEtag,
      });

      return revisionMatches && modeMatches ? profile : undefined;
    },
    (profile) => {
      if (!profile) return;
      setFixture(profile.fixture ?? null);
      setGeometry(profile.geometry ?? null);
    },
  );

  const fixtureName = createMemo(() => `${props.make} ${props.model}`);
  /** The fixture as the 3D preview draws it, from the latest profile. */
  const previewFixture = createMemo(() =>
    profileToPreviewFixture({
      fixture: fixture() ?? undefined,
      geometry: geometry() ?? undefined,
    }),
  );

  return (
    <div
      class="w-full bg-neutral-900 relative overflow-hidden"
      style={{ height: props.fill ? "100%" : "300px" }}
    >
      <FixturePreview
        class="w-full h-full"
        fixture={previewFixture()}
        label={fixtureName()}
      />
    </div>
  );
};

export default LibraryFixturePreview;
