// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Auto-layout utilities for flow graph.
 * Provides dagre-based layout algorithms with crossing minimization.
 */

import dagre, { type GraphLabel } from "@dagrejs/dagre";

/**
 * Point representation for node positions.
 */
export type Point = {
  x: number;
  y: number;
};

/**
 * Node dimensions.
 */
export type NodeDimensions = {
  width: number;
  height: number;
};

/**
 * Edge definition for layout calculation.
 */
export type LayoutEdge = {
  source: string;
  target: string;
};

/**
 * Node definition for layout calculation.
 */
export type LayoutNode = {
  id: string;
  measured?: { width?: number; height?: number };
};

/**
 * Layout candidate configuration.
 */
type LayoutCandidate = {
  name: string;
  graph: GraphLabel;
};

/**
 * Default node size when measurements are unavailable.
 */
const DEFAULT_NODE_SIZE: NodeDimensions = { width: 280, height: 200 };

/**
 * Layout algorithm candidates with different dagre configurations.
 */
const LAYOUT_CANDIDATES: LayoutCandidate[] = [
  {
    name: "network-simplex",
    graph: {
      rankdir: "LR",
      nodesep: 100,
      ranksep: 200,
      edgesep: 60,
      ranker: "network-simplex",
      acyclicer: "greedy",
    },
  },
  {
    name: "tight-tree",
    graph: {
      rankdir: "LR",
      nodesep: 120,
      ranksep: 220,
      edgesep: 80,
      ranker: "tight-tree",
      acyclicer: "greedy",
    },
  },
  {
    name: "longest-path",
    graph: {
      rankdir: "LR",
      nodesep: 120,
      ranksep: 220,
      edgesep: 80,
      ranker: "longest-path",
      acyclicer: "greedy",
    },
  },
];

/**
 * Build a map of node dimensions from measured node data.
 */
export function buildNodeDimensions(
  nodes: LayoutNode[],
): Map<string, NodeDimensions> {
  const dimensions = new Map<string, NodeDimensions>();

  nodes.forEach((node) => {
    const width =
      typeof node.measured?.width === "number"
        ? node.measured.width
        : DEFAULT_NODE_SIZE.width;
    const height =
      typeof node.measured?.height === "number"
        ? node.measured.height
        : DEFAULT_NODE_SIZE.height;
    dimensions.set(node.id, { width, height });
  });

  return dimensions;
}

/**
 * Get the maximum node dimensions from a dimensions map.
 */
function getMaxNodeDimensions(
  dimensions: Map<string, NodeDimensions>,
): NodeDimensions {
  let maxWidth = DEFAULT_NODE_SIZE.width;
  let maxHeight = DEFAULT_NODE_SIZE.height;

  dimensions.forEach(({ width, height }) => {
    maxWidth = Math.max(maxWidth, width);
    maxHeight = Math.max(maxHeight, height);
  });

  return { width: maxWidth, height: maxHeight };
}

/**
 * Build a layout using dagre with the specified configuration.
 */
function buildDagreLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  graphConfig: GraphLabel,
  nodeDimensions: Map<string, NodeDimensions>,
): Map<string, Point> {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph(graphConfig);

  nodes.forEach((node) => {
    const size = nodeDimensions.get(node.id) ?? DEFAULT_NODE_SIZE;
    dagreGraph.setNode(node.id, size);
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target, { weight: 2 });
  });

  dagre.layout(dagreGraph);

  const positions = new Map<string, Point>();
  nodes.forEach((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    if (!nodeWithPosition) return;
    positions.set(node.id, {
      x: nodeWithPosition.x,
      y: nodeWithPosition.y,
    });
  });

  return positions;
}

/**
 * Build a grid layout for nodes (used when there are no edges).
 */
function buildGridLayout(
  nodes: LayoutNode[],
  nodeDimensions: Map<string, NodeDimensions>,
  maxDimensions: NodeDimensions,
): Map<string, Point> {
  const positions = new Map<string, Point>();
  const count = nodes.length;
  if (count === 0) return positions;

  const columns = Math.ceil(Math.sqrt(count));
  const xStep = maxDimensions.width + 120;
  const yStep = maxDimensions.height + 120;

  nodes.forEach((node, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const size = nodeDimensions.get(node.id) ?? DEFAULT_NODE_SIZE;
    positions.set(node.id, {
      x: col * xStep + size.width / 2,
      y: row * yStep + size.height / 2,
    });
  });

  return positions;
}

/**
 * Check if a layout has collapsed (all nodes in approximately the same position).
 */
function isLayoutCollapsed(
  positions: Map<string, Point>,
  nodeCount: number,
  maxDimensions: NodeDimensions,
): boolean {
  if (positions.size === 0 || positions.size < nodeCount) return true;

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let invalid = false;

  positions.forEach((pos) => {
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      invalid = true;
      return;
    }
    minX = Math.min(minX, pos.x);
    maxX = Math.max(maxX, pos.x);
    minY = Math.min(minY, pos.y);
    maxY = Math.max(maxY, pos.y);
  });

  if (invalid) return true;

  const width = maxX - minX;
  const height = maxY - minY;
  return width < maxDimensions.width || height < maxDimensions.height;
}

/**
 * Count edge crossings in a layout.
 * Lower is better.
 */
function countEdgeCrossings(
  positions: Map<string, Point>,
  edges: LayoutEdge[],
): number {
  const epsilon = 1e-6;

  const sign = (value: number) =>
    value > epsilon ? 1 : value < -epsilon ? -1 : 0;

  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);

  const segmentsIntersect = (a: Point, b: Point, c: Point, d: Point) => {
    const d1 = sign(cross(a, b, c));
    const d2 = sign(cross(a, b, d));
    const d3 = sign(cross(c, d, a));
    const d4 = sign(cross(c, d, b));
    if (d1 === 0 || d2 === 0 || d3 === 0 || d4 === 0) return false;
    return d1 !== d2 && d3 !== d4;
  };

  let crossings = 0;
  for (let i = 0; i < edges.length; i += 1) {
    const edgeA = edges[i];
    const aStart = positions.get(edgeA.source);
    const aEnd = positions.get(edgeA.target);
    if (!aStart || !aEnd) continue;

    for (let j = i + 1; j < edges.length; j += 1) {
      const edgeB = edges[j];
      if (
        edgeA.source === edgeB.source ||
        edgeA.source === edgeB.target ||
        edgeA.target === edgeB.source ||
        edgeA.target === edgeB.target
      ) {
        continue;
      }

      const bStart = positions.get(edgeB.source);
      const bEnd = positions.get(edgeB.target);
      if (!bStart || !bEnd) continue;

      if (segmentsIntersect(aStart, aEnd, bStart, bEnd)) {
        crossings += 1;
      }
    }
  }

  return crossings;
}

/**
 * Calculate total edge length in a layout.
 * Lower is generally better for readability.
 */
function calculateTotalEdgeLength(
  positions: Map<string, Point>,
  edges: LayoutEdge[],
): number {
  let length = 0;
  edges.forEach((edge) => {
    const start = positions.get(edge.source);
    const end = positions.get(edge.target);
    if (!start || !end) return;
    const dx = start.x - end.x;
    const dy = start.y - end.y;
    length += Math.hypot(dx, dy);
  });
  return length;
}

/**
 * Result of the auto-layout algorithm.
 */
export type AutoLayoutResult = {
  positions: Map<string, Point>;
  algorithmName: string;
  crossings: number;
};

/**
 * Calculate the best layout for nodes and edges.
 * Tries multiple dagre configurations and selects the one with
 * the fewest edge crossings (and shortest total edge length as tiebreaker).
 */
export function calculateBestLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): AutoLayoutResult {
  if (nodes.length === 0) {
    return {
      positions: new Map(),
      algorithmName: "empty",
      crossings: 0,
    };
  }

  const nodeDimensions = buildNodeDimensions(nodes);
  const maxDimensions = getMaxNodeDimensions(nodeDimensions);

  // If no edges, use grid layout
  if (edges.length === 0) {
    return {
      positions: buildGridLayout(nodes, nodeDimensions, maxDimensions),
      algorithmName: "grid-no-edges",
      crossings: 0,
    };
  }

  // Try all layout candidates and select the best
  let bestPositions: Map<string, Point> | null = null;
  let bestCrossings = Number.POSITIVE_INFINITY;
  let bestLength = Number.POSITIVE_INFINITY;
  let bestName = "unknown";

  LAYOUT_CANDIDATES.forEach((candidate) => {
    const positions = buildDagreLayout(
      nodes,
      edges,
      candidate.graph,
      nodeDimensions,
    );
    const crossings = countEdgeCrossings(positions, edges);
    const length = calculateTotalEdgeLength(positions, edges);

    if (
      crossings < bestCrossings ||
      (crossings === bestCrossings && length < bestLength)
    ) {
      bestPositions = positions;
      bestCrossings = crossings;
      bestLength = length;
      bestName = candidate.name;
    }
  });

  // Check if the best layout is collapsed and try fallback
  if (
    !bestPositions ||
    isLayoutCollapsed(bestPositions, nodes.length, maxDimensions)
  ) {
    const fallbackPositions = buildDagreLayout(
      nodes,
      edges,
      LAYOUT_CANDIDATES[0].graph,
      nodeDimensions,
    );

    if (!isLayoutCollapsed(fallbackPositions, nodes.length, maxDimensions)) {
      bestPositions = fallbackPositions;
      bestName = "fallback-network-simplex";
      bestCrossings = countEdgeCrossings(fallbackPositions, edges);
    } else {
      bestPositions = buildGridLayout(nodes, nodeDimensions, maxDimensions);
      bestName = "grid-fallback";
      bestCrossings = 0;
    }
  }

  return {
    positions: bestPositions,
    algorithmName: bestName,
    crossings: bestCrossings,
  };
}

/**
 * Convert center positions to top-left positions.
 * Dagre returns center positions, but we need top-left for rendering.
 */
export function centerToTopLeft(
  positions: Map<string, Point>,
  nodeDimensions: Map<string, NodeDimensions>,
): Map<string, Point> {
  const topLeftPositions = new Map<string, Point>();

  positions.forEach((pos, nodeId) => {
    const size = nodeDimensions.get(nodeId) ?? DEFAULT_NODE_SIZE;
    topLeftPositions.set(nodeId, {
      x: pos.x - size.width / 2,
      y: pos.y - size.height / 2,
    });
  });

  return topLeftPositions;
}
