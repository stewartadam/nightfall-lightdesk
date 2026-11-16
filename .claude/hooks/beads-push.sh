#!/bin/bash
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Pushes beads issue writes at the end of each turn, so other sessions see
# them without the agent remembering to push. Cloud containers can be
# reclaimed without a session-end event, so the turn end is the last
# dependable moment.
#
# Most turns write no issues. Comparing the database's main branch with its
# remote-tracking branch is local and quick, so only turns with unpushed
# commits pay for a network push. bd cannot report that, hence the dolt CLI.
# Checkouts without bd, dolt or a beads database exit quietly, and a failed
# push is retried at the next turn end, so it never blocks the session.

cd "$CLAUDE_PROJECT_DIR" || exit 0

for tool in bd dolt jq; do
  command -v "$tool" >/dev/null || exit 0
done

beads_dir=$(bd where --json 2>/dev/null | jq -r '.path // empty') || exit 0
[ -n "$beads_dir" ] || exit 0
database=$(jq -r '.dolt_database // empty' "$beads_dir/metadata.json" 2>/dev/null)
[ -n "$database" ] || exit 0

unpushed=$(cd "$beads_dir/embeddeddolt/$database" 2>/dev/null &&
  dolt log --oneline -n 1 remotes/origin/main..main 2>/dev/null)
[ -n "$unpushed" ] || exit 0

bd dolt push --no-adopt >&2 || echo "bd dolt push failed; retrying at the next turn end" >&2
exit 0
