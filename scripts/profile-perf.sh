#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -eu

# profile compile times
# cargo +nightly rustc -p nightfall-app --bin nightfall-app --   -Zself-profile
# cargo +nightly rustc -p nightfall-cmd-parse --   -Ztime-passes

# note: mixing llvm and cranelift causes samply to fail to record
cargo build --profile samply --bin nightfall-app --no-default-features
samply record cargo run --profile samply --bin nightfall-app --no-default-features "$@"
