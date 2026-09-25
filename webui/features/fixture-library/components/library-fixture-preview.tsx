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

import { useStore } from "@nanostores/solid";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  on,
} from "solid-js";
import { profileMatchesRevision } from "../../../lib/fixture-profile-match";
import { fetchFixtureProfile } from "../../../lib/fixture-service";
import { fixtureProfile } from "../../../state/appStores";
import type { Fixture, FixtureGeometry } from "../../../types";
import { FixturePreview } from "../../visualizer";

type LibraryFixturePreviewProps = {
  make: string;
  model: string;
  mode?: string;
  /** Library revision to preview; the default revision when omitted. */
  assetEtag?: string;
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
    on(
      () => [props.make, props.model, props.assetEtag] as const,
      () => {
        setFixture(null);
        // (mode changes within same fixture should preserve geometry until new data arrives)
        setGeometry(null);
      },
      { defer: true }, // Don't run on initial mount
    ),
  );

  // Fetch fixture profile when any prop changes.
  createEffect(
    on(
      () => [props.make, props.model, props.mode, props.assetEtag] as const,
      ([make, model, mode, assetEtag]) => {
        // Request profile from backend
        fetchFixtureProfile(make, model, mode, assetEtag);
      },
    ),
  );

  // Update preview data when the global profile store receives our requested fixture.
  createEffect(() => {
    const profile = $fixtureProfile();
    if (!profile) return;

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

    if (revisionMatches && modeMatches) {
      setFixture(profile.fixture ?? null);
      setGeometry(profile.geometry ?? null);
    }
  });

  const fixtureName = createMemo(() => `${props.make} ${props.model}`);
  const previewFixture = createMemo(() => {
    const currentFixture = fixture();
    if (!currentFixture) return null;

    return {
      make: currentFixture.make,
      model: currentFixture.model,
      geometry: geometry(),
      elements: currentFixture.elements,
      beamType: currentFixture.physical?.beamType,
      layout: currentFixture.layout,
    };
  });

  return (
    <div
      class="w-full bg-neutral-900 relative overflow-hidden"
      style="height: 300px;"
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
