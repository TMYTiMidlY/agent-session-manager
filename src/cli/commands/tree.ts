import { Command } from "commander";
import { parseSession } from "../../core/index.js";
import { mapConcurrent } from "../../core/concurrency.js";
import {
  documentObservedRange, probeGraphNodes, peakConcurrency, buildSessionGraph, sessionKey,
  type ConcurrencyInterval, type SessionGraph, type SessionNode,
} from "../../core/relations.js";
import { nonNegativeInteger, withReadSource } from "../options/common.js";
import { resolveOne, resolveRefs } from "../options/resolve.js";
import type { AgentKind, SessionRef } from "../../core/types.js";

function intervalOf(node: SessionNode): ConcurrencyInterval {
  return node.ambiguous ? {} : { startedAt: node.startedAt, lastObservedAt: node.lastObservedAt };
}

interface TreeNodeJson {
  key: string;
  agent: AgentKind;
  id: string;
  role: string;
  /** True when the same agent+id appeared more than once in the scan. */
  ambiguous?: boolean;
  startedAt?: string;
  /** Last observed activity; NOT liveness. */
  lastObservedAt?: string;
  parent?: string;
  children: TreeNodeJson[];
  childrenTruncated?: boolean;
  forks: string[];
}

/** JSON projection with a visited guard: parent-chain cycles cannot recurse forever. */
function toJsonNode(node: SessionNode, graph: SessionGraph, visited = new Set<string>(), depth = 0, maxDepth = 128): TreeNodeJson {
  visited.add(node.key);
  const candidates = graph.childrenOf(node.key).filter(child => !visited.has(child.key));
  const children = depth < maxDepth ? candidates.map(child => toJsonNode(child, graph, visited, depth + 1, maxDepth)) : [];
  return {
    key: node.key,
    agent: node.agent,
    id: node.id,
    role: node.role,
    ...(node.ambiguous ? { ambiguous: true } : {}),
    ...(node.startedAt !== undefined ? { startedAt: node.startedAt } : {}),
    ...(node.lastObservedAt !== undefined ? { lastObservedAt: node.lastObservedAt } : {}),
    ...(node.parentKey !== undefined ? { parent: node.parentKey } : {}),
    children,
    ...(depth >= maxDepth && candidates.length ? { childrenTruncated: true } : {}),
    forks: graph.forksOf(node.key).map((fork) => fork.key),
  };
}

/** Text rendering with the same visited guard against cycles. */
function renderNode(node: SessionNode, graph: SessionGraph, visited = new Set<string>(), depth = 0, prefix = "", maxDepth = 128): string[] {
  visited.add(node.key);
  const indent = "  ".repeat(depth);
  const times = [node.startedAt, node.lastObservedAt].every((value) => value === undefined)
    ? "(times unknown)"
    : `${node.startedAt ?? "?"} → ${node.lastObservedAt ?? "?"} (last observed, not proof of ongoing activity)`;
  const ambiguity = node.ambiguous ? " [AMBIGUOUS id: appears more than once in the scan; shown fields are the first occurrence]" : "";
  const lines = [`${prefix}${indent}${node.key} [${node.role}]${ambiguity} ${times}`];
  if (depth === 0) {
    for (const fork of graph.forksOf(node.key)) {
      lines.push(`${indent}  fork of this: ${fork.key} [${fork.role}]`);
    }
  }
  const children = graph.childrenOf(node.key).filter((child) => !visited.has(child.key));
  if (depth >= maxDepth && children.length) lines.push(`${indent}  … children truncated at --max-depth ${maxDepth}`);
  else for (const child of children) {
    lines.push(...renderNode(child, graph, visited, depth + 1, prefix, maxDepth));
  }
  return lines;
}

/**
 * Fill observed ranges by actually parsing the family's transcripts: event
 * instants from the unified documents, never file mtimes. Bounded to 4
 * concurrent parses.
 */
async function observeFamily(graph: SessionGraph, family: SessionNode[], refs: readonly SessionRef[]): Promise<void> {
  const byKey = new Map(refs.map((ref) => [sessionKey(ref.agent, ref.id), ref]));
  const parsed = await mapConcurrent(family, 4, async (node) => {
    const ref = byKey.get(node.key);
    if (!ref || node.ambiguous) return undefined;
    try {
      return { node, range: documentObservedRange(await parseSession(ref)) };
    } catch {
      return undefined; // unreadable transcript: range stays unknown, never mtime
    }
  });
  for (const entry of parsed) {
    if (!entry) continue;
    if (entry.range.startedAt !== undefined) entry.node.startedAt = entry.range.startedAt;
    if (entry.range.lastObservedAt !== undefined) entry.node.lastObservedAt = entry.range.lastObservedAt;
  }
}

export function buildTreeCommand(): Command {
  const cmd = withReadSource(
    new Command("tree")
      .argument("[session-id]", "session id (or unambiguous prefix; --file with one session may omit it)")
      .description("Show a session's relation graph: parent, children vs forks, roles, and observed time ranges"),
    "read an explicit session file/directory instead of the live agent homes (agent auto-detected)",
  );
  cmd.option("--json", "print the relation graph as JSON")
    .option("--max-depth <n>", "maximum displayed descendant depth (0-256; truncation is marked)", (value: string) => {
      const depth = nonNegativeInteger(value);
      if (depth > 256) throw new Error("--max-depth must be at most 256");
      return depth;
    }, 128);
  cmd.action(async (id, opts) => {
    const target = await resolveOne(id, opts);
    // Relations are per-agent: only siblings under the same agent can be
    // parents/children; ids are never joined across agents.
    const siblings = (await resolveRefs(opts)).filter((ref) => ref.agent === target.agent);
    const graph = buildSessionGraph(await probeGraphNodes(siblings));
    const key = sessionKey(target.agent, target.id);
    const node = graph.nodes.get(key);
    if (!node) throw new Error(`session not found in relation graph: ${key}`);

    // Parse the actual family (target, children, parent, forks) to observe
    // real event-time ranges — mtime is not transcript activity.
    const familyByKey = new Map<string, SessionNode>();
    const pending = [{ node, depth: 0 }];
    while (pending.length) {
      const current = pending.pop()!;
      if (familyByKey.has(current.node.key)) continue;
      familyByKey.set(current.node.key, current.node);
      if (current.depth < opts.maxDepth) {
        for (const child of graph.childrenOf(current.node.key)) pending.push({ node: child, depth: current.depth + 1 });
      }
    }
    for (const related of [...graph.childrenOf(key), ...graph.forksOf(key), ...(node.parentKey ? [graph.nodes.get(node.parentKey)] : [])]) {
      if (related) familyByKey.set(related.key, related);
    }
    const family = [...familyByKey.values()];
    await observeFamily(graph, family, siblings);

    const directChildren = graph.childrenOf(key);
    const concurrency = peakConcurrency(directChildren.map(intervalOf));
    const diagnostics = graph.diagnostics;

    if (opts.json) {
      console.log(JSON.stringify({
        node: toJsonNode(node, graph, new Set(), 0, opts.maxDepth),
        childrenPeakConcurrency: directChildren.length ? concurrency : undefined,
        diagnostics,
      }, null, 2));
      return;
    }

    const lines: string[] = [];
    const ambiguity = node.ambiguous ? " [AMBIGUOUS id: appears more than once in the scan; shown fields are the first occurrence]" : "";
    lines.push(`session: ${node.key} [${node.role}]${ambiguity}`);
    if (node.startedAt !== undefined || node.lastObservedAt !== undefined) {
      lines.push(`  observed: ${node.startedAt ?? "?"} → ${node.lastObservedAt ?? "?"} (last observed, not proof of ongoing activity)`);
    }
    const parent = node.parentKey !== undefined ? graph.nodes.get(node.parentKey) : undefined;
    if (parent) lines.push(`  parent: ${parent.key} [${parent.role}]`);
    else if (node.parentKey !== undefined) {
      lines.push(`  parent: ${node.parentKey} (not found among the scanned sessions — may exist outside this scan)`);
    } else {
      lines.push("  parent: (none recorded)");
    }
    lines.push(`  children (${directChildren.length}, by parentSession):`);
    if (directChildren.length) {
      lines.push(`    peak concurrency: ${concurrency.peak}${concurrency.at ? ` at ${concurrency.at}` : ""} (half-open intervals; ends are last-observed instants)`
        + (concurrency.unplaced ? `; ${concurrency.unplaced} child(ren) lack a start instant and were not placed` : ""));
    }
    lines.push(...renderNode(node, graph, new Set(), 0, "", opts.maxDepth).slice(1));
    const forks = graph.forksOf(key);
    lines.push(`  forks (${forks.length}, by forkOf):`);
    for (const fork of forks) lines.push(`    ${fork.key} [${fork.role}]`);

    const notes: string[] = [];
    for (const cycle of diagnostics.cycles) notes.push(`cycle detected: ${cycle.join(" → ")} → ${cycle[0]} (rendering stops at the repeated node)`);
    for (const missing of diagnostics.missingParents) {
      notes.push(`missing parent: ${missing.key} references ${missing.agent}:${missing.parentSession}, not found in the scanned set`);
    }
    for (const missing of diagnostics.missingForks) {
      notes.push(`missing fork source: ${missing.key} references ${missing.agent}:${missing.forkOf}, not found in the scanned set`);
    }
    for (const duplicate of diagnostics.duplicates) {
      notes.push(`ambiguous id: ${duplicate.key} appears ${duplicate.count} times in the scanned set; fields shown are the first occurrence, not a silent pick`);
    }
    if (notes.length) {
      lines.push("diagnostics:");
      for (const note of notes) lines.push(`  - ${note}`);
    }
    console.log(lines.join("\n"));
  });
  return cmd;
}
