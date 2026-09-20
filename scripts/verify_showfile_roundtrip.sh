#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required to compare normalized showfile JSON" >&2
  exit 1
fi

if [[ $# -gt 2 ]]; then
  echo "usage: $0 [showfile_json] [showfile_backup_json]" >&2
  exit 1
fi

showfile_json="${1:-}"
showfile_backup_json="${2:-}"

if [[ -z "$showfile_json" ]]; then
  if [[ -n "${NIGHTFALL_DATA_DIR:-}" ]]; then
    data_dir="${NIGHTFALL_DATA_DIR}"
  else
    case "$(uname -s)" in
      Darwin)
        data_dir="${HOME}/Library/Application Support/com.nightfall.nightfall"
        ;;
      Linux)
        data_dir="${XDG_DATA_HOME:-${HOME}/.local/share}/nightfall"
        ;;
      *)
        echo "error: unsupported platform for default data-dir lookup; provide paths explicitly" >&2
        exit 1
        ;;
    esac
  fi
  showfile_json="${data_dir}/default.nightfall-show/showfile.json"
fi

if [[ -z "$showfile_backup_json" ]]; then
  latest_backup_dir="$(find "${data_dir}/backups" -maxdepth 1 -type d -name 'default-*.nightfall-show' 2>/dev/null | sort | tail -n 1)"
  if [[ -z "$latest_backup_dir" ]]; then
    echo "error: no default showfile backups found under ${data_dir}/backups" >&2
    exit 1
  fi
  showfile_backup_json="${latest_backup_dir}/showfile.json"
fi

if [[ -f "${showfile_json}.gz" ]]; then
  showfile_json="${showfile_json}.gz"
fi
if [[ -f "${showfile_backup_json}.gz" ]]; then
  showfile_backup_json="${showfile_backup_json}.gz"
fi

if [[ ! -f "$showfile_json" ]]; then
  echo "error: missing showfile JSON: $showfile_json" >&2
  exit 1
fi

if [[ ! -f "$showfile_backup_json" ]]; then
  echo "error: missing showfile backup JSON: $showfile_backup_json" >&2
  exit 1
fi

tmp_a="$(mktemp)"
tmp_b="$(mktemp)"
trap 'rm -f "$tmp_a" "$tmp_b"' EXIT

# Decode gzip snapshots while preserving plain JSON interchange support.
read_snapshot_json() {
  case "$1" in
    *.gz) gzip -dc "$1" ;;
    *) cat "$1" ;;
  esac
}

read_snapshot_json "$showfile_json" | jq -S . > "$tmp_a"
read_snapshot_json "$showfile_backup_json" | jq -S . > "$tmp_b"

if diff -u "$tmp_b" "$tmp_a"; then
  echo "ok: normalized showfile JSON matches backup snapshot"
else
  echo "error: normalized showfile JSON differs from backup snapshot" >&2
  exit 1
fi
