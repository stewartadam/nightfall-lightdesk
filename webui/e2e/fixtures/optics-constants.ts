// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Dependency-free constants shared by the browser and Node optics harnesses; kept apart
 * so the Node side never loads Three.
 */

/** Error message prefix the Node harness converts into a skipped test. */
export const WEBGPU_UNAVAILABLE = "optics-harness: WebGPU is unavailable";
