// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bounded reuse of immutable compiled definitions, independent of runtime fixture ownership.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Write};
use std::sync::Arc;

use crate::gdtf_archive::{CompiledDefinition, DefinitionKey, ParsedArchive};
use crate::gdtf_compiler::CompileLimits;
use crate::gdtf_resolver::ResolveError;

/// Admission limits for the cache, not for active fixtures retaining their own definition handles.
#[derive(Debug, Clone, Copy)]
pub struct CacheLimits {
    /// Maximum number of compiled modes retained by the cache.
    pub definitions: usize,
    /// Maximum archive bytes plus serialized contract bytes, charged separately for every cached mode.
    /// This is a reproducible weight, not a measurement of allocator overhead or renderer/GPU memory.
    pub weight_bytes: usize,
}

impl Default for CacheLimits {
    /// Retain a modest working set; calibrated application memory budgets remain a separate acceptance gate.
    fn default() -> Self {
        Self {
            definitions: 64,
            weight_bytes: 128 * 1024 * 1024,
        }
    }
}

/// Observable cache admission, reuse and eviction without exposing mutable definitions.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheStats {
    /// Current cached definition count.
    pub definitions: usize,
    /// Current total admission weight.
    pub weight_bytes: usize,
    /// Successful lookups since construction, including get_or_compile reuse.
    pub hits: u64,
    /// Absent lookups since construction, including failed compilation attempts.
    pub misses: u64,
    /// Entries evicted to admit other definitions; explicit clearing is not counted.
    pub evictions: u64,
}

/// Cached immutable handle and its admission weight.
struct Entry {
    definition: Arc<CompiledDefinition>,
    weight: usize,
}

/// Synchronous LRU cache with fixed compilation limits and explicit caller-owned synchronization.
/// Compilation should run away from real-time updates; no application locks are acquired here.
pub struct DefinitionCache {
    limits: CacheLimits,
    compile_limits: CompileLimits,
    entries: HashMap<DefinitionKey, Entry>,
    oldest_first: VecDeque<DefinitionKey>,
    stats: CacheStats,
}

/// Count serialized output without allocating a second copy of a large definition.
#[derive(Default)]
struct ByteCounter(usize);

impl Write for ByteCounter {
    /// Add a complete serialization chunk or reject unrepresentable accounting.
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_add(buffer.len())
            .ok_or_else(|| io::Error::other("Definition weight overflow"))?;
        Ok(buffer.len())
    }

    /// Counting has no buffered output to flush.
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Charge the complete snapshot and serialized definition, deliberately overcounting shared snapshots across modes.
fn definition_weight(definition: &CompiledDefinition) -> Result<usize, ResolveError> {
    let mut counter = ByteCounter::default();
    serde_json::to_writer(&mut counter, definition).map_err(|error| ResolveError {
        code: "definition_weight",
        path: definition.key().mode().into(),
        message: error.to_string(),
    })?;
    counter
        .0
        .checked_add(definition.archive().bytes().len())
        .ok_or_else(|| ResolveError {
            code: "definition_weight",
            path: definition.key().mode().into(),
            message: "Definition weight overflow".into(),
        })
}

impl DefinitionCache {
    /// Create an empty cache whose compilation budgets cannot change beneath already admitted entries.
    pub fn new(limits: CacheLimits, compile_limits: CompileLimits) -> Self {
        Self {
            limits,
            compile_limits,
            entries: HashMap::new(),
            oldest_first: VecDeque::new(),
            stats: CacheStats::default(),
        }
    }

    /// Reuse an exact key and refresh its recency; returned handles survive subsequent eviction.
    pub fn get(&mut self, key: &DefinitionKey) -> Option<Arc<CompiledDefinition>> {
        let Some(entry) = self.entries.get(key) else {
            self.stats.misses = self.stats.misses.saturating_add(1);
            return None;
        };
        let definition = Arc::clone(&entry.definition);
        self.stats.hits = self.stats.hits.saturating_add(1);
        self.oldest_first.retain(|existing| existing != key);
        self.oldest_first.push_back(key.clone());
        Some(definition)
    }

    /// Compile a miss once and admit it if it fits, leaving failed or oversized requests out of the cache.
    /// Oversized definitions are returned uncached without evicting the current working set.
    pub fn get_or_compile(
        &mut self,
        source: &ParsedArchive,
        mode: &str,
    ) -> Result<Arc<CompiledDefinition>, ResolveError> {
        let key = source.definition_key(mode);
        if let Some(definition) = self.get(&key) {
            return Ok(definition);
        }
        let definition = Arc::new(source.compile(mode, self.compile_limits)?);
        if self.limits.definitions == 0 || self.limits.weight_bytes == 0 {
            return Ok(definition);
        }
        let weight = definition_weight(&definition)?;
        if weight > self.limits.weight_bytes {
            return Ok(definition);
        }
        while self.entries.len() >= self.limits.definitions
            || self.stats.weight_bytes > self.limits.weight_bytes - weight
        {
            let oldest = self
                .oldest_first
                .pop_front()
                .expect("nonempty cache exceeds admission limit");
            let entry = self
                .entries
                .remove(&oldest)
                .expect("recency key belongs to cache");
            self.stats.weight_bytes -= entry.weight;
            self.stats.evictions = self.stats.evictions.saturating_add(1);
        }
        self.entries.insert(
            key.clone(),
            Entry {
                definition: Arc::clone(&definition),
                weight,
            },
        );
        self.oldest_first.push_back(key);
        self.stats.weight_bytes += weight;
        self.stats.definitions = self.entries.len();
        Ok(definition)
    }

    /// Read current accounting and cumulative lookup statistics.
    pub fn stats(&self) -> CacheStats {
        self.stats
    }

    /// Release only cache-owned handles, preserving active fixtures and cumulative counters.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.oldest_first.clear();
        self.stats.definitions = 0;
        self.stats.weight_bytes = 0;
    }
}
