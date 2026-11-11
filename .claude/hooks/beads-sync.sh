#!/bin/bash
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Pulls issues other machines pushed since this checkout last synced, and
# pushes any local writes that never went out, so a session starts from the
# shared beads state. bd's dolt.auto-push setting covers pushes during the
# session; bd has no automatic pull, hence this hook.
#
# Cloud sessions are skipped: cloud-session-start.sh clones or syncs the
# database itself, and running both hooks at once would race that clone.
# Checkouts without bd or a beads database exit quietly (bd resolves worktrees
# to the main checkout's database), and a failed sync only leaves issues stale,
# so it never fails the session.

if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" || exit 0

if ! command -v bd >/dev/null || ! bd where >/dev/null 2>&1; then
  exit 0
fi

# SessionStart stdout is injected into the model context; keep sync logs out.
bd sync >&2 || echo "bd sync failed; beads issues may be stale" >&2
exit 0
