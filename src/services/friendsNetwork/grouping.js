import { UndirectedGraph } from 'graphology';
import louvain from 'graphology-communities-louvain';
import disparity from 'graphology-metrics/edge/disparity';

import { compareIds } from './scoring';

/** Build weighted neighborhoods for score factors and membership annotations. */
async function adjacencyFor(ids, links, checkpoint) {
    const adjacency = new Map([...ids].sort(compareIds).map((id) => [id, new Map()]));
    let processed = 0;
    for (const edge of links) {
        if (++processed % 256 === 0) {
            await checkpoint();
        }
        const source = adjacency.get(edge.source);
        const target = adjacency.get(edge.target);
        source.set(edge.target, (source.get(edge.target) || 0) + edge.weight);
        target.set(edge.source, (target.get(edge.source) || 0) + edge.weight);
    }
    return adjacency;
}

function sum(values) {
    let total = 0;
    for (const value of values) {
        total += value;
    }
    return total;
}

function validLink(edge) {
    return edge.source !== edge.target && Number.isFinite(edge.weight) && edge.weight > 0;
}

function canonicalEndpoints(edge) {
    return compareIds(edge.source, edge.target) < 0 ? [edge.source, edge.target] : [edge.target, edge.source];
}

/** Insert valid undirected edges in a stable order before invoking Graphology. */
async function weightedGraph(ids, links, checkpoint) {
    const graph = new UndirectedGraph({ allowSelfLoops: false });
    for (const id of [...ids].sort(compareIds)) {
        graph.addNode(id);
    }
    const ordered = links
        .filter(validLink)
        .map((edge) => {
            const [source, target] = canonicalEndpoints(edge);
            return { source, target, weight: edge.weight };
        })
        .sort((a, b) => compareIds(a.source, b.source) || compareIds(a.target, b.target) || a.weight - b.weight);
    let processed = 0;
    for (const edge of ordered) {
        if (++processed % 256 === 0) {
            await checkpoint();
        }
        if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
            continue;
        }
        const key = JSON.stringify([edge.source, edge.target]);
        if (graph.hasEdge(key)) {
            const weight = graph.getEdgeAttribute(key, 'weight') + edge.weight;
            if (Number.isFinite(weight)) {
                graph.setEdgeAttribute(key, 'weight', weight);
            }
        } else {
            graph.addUndirectedEdgeWithKey(key, edge.source, edge.target, { weight: edge.weight });
        }
    }
    return graph;
}

/**
 * Sorted insertion and disabled random traversal keep the library partition
 * reproducible. Public labels are ordered by group size, then lowest member ID.
 *
 * @param {Iterable<string>} ids
 * @param {{ source: string; target: string; weight: number }[]} links
 * @param {number} resolution
 * @param {(force?: boolean) => Promise<void>} [checkpoint]
 */
export async function detectCommunities(ids, links, resolution, checkpoint = async () => {}) {
    const graph = await weightedGraph(ids, links, checkpoint);
    // Library calls are synchronous, so yield before and check cancellation after.
    await checkpoint(true);
    const partition = louvain(graph, { getEdgeWeight: 'weight', resolution, randomWalk: false });
    await checkpoint(true);
    const groups = new Map();
    for (const id of graph.nodes()) {
        const group = graph.degree(id) ? `community:${partition[id]}` : `isolate:${id}`;
        if (!groups.has(group)) {
            groups.set(group, []);
        }
        groups.get(group).push(id);
    }
    const ordered = [...groups.values()].sort((a, b) => b.length - a.length || compareIds(a[0], b[0]));
    return new Map(ordered.flatMap((group, index) => group.map((id) => [id, index])));
}

/**
 * Lower disparity scores identify edges that are significant to either endpoint.
 * A threshold of one disables filtering and avoids building a second graph.
 *
 * @param {Iterable<string>} ids
 * @param {{ source: string; target: string; weight: number }[]} links
 * @param {number} [threshold]
 * @param {(force?: boolean) => Promise<void>} [checkpoint]
 */
export async function filterBackbone(ids, links, threshold = 1, checkpoint = async () => {}) {
    const valid = links.filter(validLink);
    if (threshold >= 1 || !valid.length) {
        return valid;
    }
    const graph = await weightedGraph(ids, valid, checkpoint);
    await checkpoint(true);
    const scores = disparity(graph, { getEdgeWeight: 'weight' });
    await checkpoint(true);
    return valid.filter((edge) => {
        const key = JSON.stringify(canonicalEndpoints(edge));
        return Number.isFinite(scores[key]) && scores[key] <= threshold;
    });
}

/** Adjust qualifying evidence using consistency, activity and neighborhood factors. */
export async function adjustScores(users, links, settings, checkpoint) {
    let processed = 0;
    for (const edge of links) {
        if (++processed % 256 === 0) {
            await checkpoint();
        }
        const consistency = 1 + settings.consistency * Math.log2(Math.max(1, edge.distinct_weeks));
        edge.weight = edge.base_weight * consistency;
        edge.score_factors = {
            consistency,
            hub_damping: 1,
            relative_closeness: 1,
            neighbor_similarity: 1
        };
    }
    // The default weighting needs no neighborhood graph or second edge pass.
    if (!settings.hub_damping && !settings.relative_closeness && !settings.neighbor_similarity) {
        return;
    }
    const adjacency = await adjacencyFor(users.keys(), links, checkpoint);
    const positive = [...adjacency.values()]
        .map((row) => row.size)
        .filter(Boolean)
        .sort((a, b) => a - b);
    const middle = Math.floor(positive.length / 2);
    let typical = 1;
    if (positive.length) {
        typical = positive.length % 2 ? positive[middle] : (positive[middle - 1] + positive[middle]) / 2;
    }
    // Only cosine similarity needs squared neighborhood weights.
    const squared = settings.neighbor_similarity
        ? new Map([...adjacency].map(([id, row]) => [id, sum([...row.values()].map((weight) => weight * weight))]))
        : null;
    for (const edge of links) {
        if (++processed % 256 === 0) {
            await checkpoint();
        }
        const source = adjacency.get(edge.source);
        const target = adjacency.get(edge.target);
        const factors = edge.score_factors;
        if (settings.hub_damping) {
            const ratio = Math.max(1, source.size / typical) * Math.max(1, target.size / typical);
            factors.hub_damping = Math.pow(ratio, -settings.hub_damping / 2);
        }
        if (settings.relative_closeness) {
            const total = Math.sqrt(users.get(edge.source).minutes * users.get(edge.target).minutes);
            factors.relative_closeness = Math.pow(
                total ? Math.min(1, edge.minutes / total) : 0,
                settings.relative_closeness
            );
        }
        if (settings.neighbor_similarity) {
            const common = [...source.keys()].filter((id) => target.has(id)).sort(compareIds);
            const numerator = sum(common.map((id) => source.get(id) * target.get(id)));
            const denominator = Math.sqrt(
                Math.max(0, squared.get(edge.source) - edge.weight * edge.weight) *
                    Math.max(0, squared.get(edge.target) - edge.weight * edge.weight)
            );
            factors.neighbor_similarity =
                1 + settings.neighbor_similarity * (denominator ? Math.min(1, numerator / denominator) : 0);
        }
        edge.weight *= factors.hub_damping * factors.relative_closeness * factors.neighbor_similarity;
    }
}

/** Select nodes, apply the backbone and top-K filters, then handle isolated people. */
export async function pruneGraph(users, links, settings, checkpoint) {
    let processed = 0;
    links = links.filter((edge) => validLink(edge) && users.has(edge.source) && users.has(edge.target));
    const degrees = new Map([...users.keys()].map((id) => [id, 0]));
    for (const edge of links) {
        if (++processed % 256 === 0) {
            await checkpoint();
        }
        degrees.set(edge.source, degrees.get(edge.source) + edge.weight);
        degrees.set(edge.target, degrees.get(edge.target) + edge.weight);
    }
    let order = [...users.keys()].sort(
        (a, b) =>
            degrees.get(b) - degrees.get(a) ||
            users.get(b).encounters - users.get(a).encounters ||
            compareIds(users.get(a).name.toLowerCase(), users.get(b).name.toLowerCase()) ||
            compareIds(a, b)
    );
    if (settings.max_nodes) {
        order = order.slice(0, settings.max_nodes);
    }
    const kept = new Set(order);
    links = links.filter((edge) => kept.has(edge.source) && kept.has(edge.target));
    links = await filterBackbone(order, links, settings.backbone_threshold ?? 1, checkpoint);
    if (settings.top_k) {
        const chosen = new Map();
        const votes = new Map();
        const ranked = [...links].sort(
            (a, b) => b.weight - a.weight || compareIds(a.source, b.source) || compareIds(a.target, b.target)
        );
        for (const edge of ranked) {
            if (++processed % 256 === 0) {
                await checkpoint();
            }
            let count = 0;
            for (const id of [edge.source, edge.target]) {
                if ((chosen.get(id) || 0) < settings.top_k) {
                    chosen.set(id, (chosen.get(id) || 0) + 1);
                    count++;
                }
            }
            votes.set(edge, count);
        }
        links = links.filter((edge) => votes.get(edge) >= (settings.edge_selection === 'mutual' ? 2 : 1));
    }
    let hidden = 0;
    if (!settings.include_isolates) {
        const connected = new Set(links.flatMap((edge) => [edge.source, edge.target]));
        hidden = order.filter((id) => !connected.has(id)).length;
        order = order.filter((id) => connected.has(id));
    }
    return { users: new Map(order.map((id) => [id, users.get(id)])), links, hidden };
}

function label(users) {
    return [...users]
        .sort((a, b) => b.encounters - a.encounters || compareIds(a.id, b.id))
        .slice(0, 3)
        .map((user) => user.name)
        .join(', ');
}

/** Add primary groups, weighted memberships, bridge scores and group labels. */
export async function annotateGroups(users, links, settings, checkpoint) {
    const labels = await detectCommunities(users.keys(), links, settings.resolution, checkpoint);
    const adjacency = await adjacencyFor(users.keys(), links, checkpoint);
    const strengths = new Map([...adjacency].map(([id, row]) => [id, sum(row.values())]));
    let strongest = 0;
    for (const strength of strengths.values()) {
        strongest = Math.max(strongest, strength);
    }
    const groups = new Map();
    for (const user of users.values()) {
        await checkpoint();
        user.community = labels.get(user.id);
        if (!groups.has(user.community)) {
            groups.set(user.community, []);
        }
        groups.get(user.community).push(user);
        const weights = new Map();
        for (const [neighbor, weight] of adjacency.get(user.id)) {
            const community = labels.get(neighbor);
            weights.set(community, (weights.get(community) || 0) + weight);
        }
        const total = strengths.get(user.id);
        user.memberships = total
            ? [...weights]
                  .sort((a, b) => b[1] - a[1] || a[0] - b[0])
                  .map(([community, value]) => ({ community, score: value / total }))
            : [{ community: user.community, score: 1 }];
        user.bridge_score = total ? Math.min(1, Math.max(0, 1 - (weights.get(user.community) || 0) / total)) : 0;
        user.connection_score = strongest ? total / strongest : 0;
    }
    const communities = [];
    for (const [id, members] of [...groups].sort((a, b) => a[0] - b[0])) {
        await checkpoint();
        communities.push({ id, size: members.length, label: label(members) });
    }
    return { communities };
}
