import { compareIds } from './scoring';

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
const minimum = (values) => [...values].sort(compareIds)[0];

// Deterministic multilevel weighted Louvain. Isolates retain separate labels.
export async function detectCommunities(ids, links, resolution, checkpoint = async () => {}) {
    let adjacency = await adjacencyFor(ids, links, checkpoint);
    let members = new Map([...adjacency.keys()].map((id) => [id, new Set([id])]));
    for (let level = 0; level < 20; level++) {
        await checkpoint();
        const nodes = [...adjacency.keys()].sort(compareIds);
        const degrees = new Map(nodes.map((id) => [id, sum(adjacency.get(id).values())]));
        const total = sum(degrees.values());
        const partition = new Map(nodes.map((id) => [id, id]));
        const totals = new Map(degrees);
        let changed = false;
        for (let pass = 0; pass < 50 && total > 0; pass++) {
            let moved = false;
            for (const node of nodes) {
                await checkpoint();
                const degree = degrees.get(node);
                if (!degree) {
                    continue;
                }
                const previous = partition.get(node);
                const weights = new Map();
                for (const [neighbor, weight] of adjacency.get(node)) {
                    if (neighbor === node) {
                        continue;
                    }
                    const group = partition.get(neighbor);
                    weights.set(group, (weights.get(group) || 0) + weight);
                }
                totals.set(previous, totals.get(previous) - degree);
                let best = previous;
                let gain = (weights.get(previous) || 0) - (resolution * degree * totals.get(previous)) / total;
                for (const candidate of [...weights.keys()].sort(compareIds)) {
                    const candidateGain =
                        weights.get(candidate) - (resolution * degree * totals.get(candidate)) / total;
                    if (candidateGain > gain + 1e-12) {
                        best = candidate;
                        gain = candidateGain;
                    }
                }
                partition.set(node, best);
                totals.set(best, totals.get(best) + degree);
                if (best !== previous) {
                    moved = true;
                    changed = true;
                }
            }
            if (!moved) {
                break;
            }
        }
        const groups = new Map();
        for (const node of nodes) {
            const group = partition.get(node);
            if (!groups.has(group)) {
                groups.set(group, new Set());
            }
            for (const id of members.get(node)) {
                groups.get(group).add(id);
            }
        }
        if (!changed || groups.size === adjacency.size) {
            break;
        }
        const canonical = new Map([...groups].map(([id, group]) => [id, minimum(group)]));
        const next = new Map([...groups.keys()].map((id) => [canonical.get(id), new Map()]));
        for (const [node, neighbors] of adjacency) {
            await checkpoint();
            const row = next.get(canonical.get(partition.get(node)));
            for (const [neighbor, weight] of neighbors) {
                const target = canonical.get(partition.get(neighbor));
                row.set(target, (row.get(target) || 0) + weight);
            }
        }
        adjacency = next;
        members = new Map([...groups].map(([id, group]) => [canonical.get(id), group]));
    }
    const ordered = [...members.values()].sort((a, b) => b.size - a.size || compareIds(minimum(a), minimum(b)));
    return new Map(ordered.flatMap((group, index) => [...group].map((id) => [id, index])));
}

export async function adjustScores(users, links, settings, checkpoint) {
    for (const edge of links) {
        await checkpoint();
        const consistency = 1 + settings.consistency * Math.log2(Math.max(1, edge.distinct_weeks));
        edge.weight = edge.base_weight * consistency;
        edge.score_factors = {
            consistency,
            hub_damping: 1,
            relative_closeness: 1,
            neighbor_similarity: 1,
            group_hint: 1
        };
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
    const squared = new Map(
        [...adjacency].map(([id, row]) => [id, sum([...row.values()].map((weight) => weight * weight))])
    );
    for (const edge of links) {
        await checkpoint();
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
        const hint = settings.group_hints[edge.source];
        if (hint && hint === settings.group_hints[edge.target]) {
            factors.group_hint = 1.1;
        }
        edge.weight *=
            factors.hub_damping * factors.relative_closeness * factors.neighbor_similarity * factors.group_hint;
    }
}

export async function pruneGraph(users, links, settings, checkpoint) {
    const degrees = new Map([...users.keys()].map((id) => [id, 0]));
    for (const edge of links) {
        await checkpoint();
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
    if (settings.top_k) {
        const chosen = new Map();
        const votes = new Map();
        const ranked = [...links].sort(
            (a, b) => b.weight - a.weight || compareIds(a.source, b.source) || compareIds(a.target, b.target)
        );
        for (const edge of ranked) {
            await checkpoint();
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
        user.group_hint = settings.group_hints[user.id] || '';
    }
    const communities = [];
    const subcommunities = [];
    const internal = new Map();
    for (const edge of links) {
        const group = labels.get(edge.source);
        if (group !== labels.get(edge.target)) {
            continue;
        }
        if (!internal.has(group)) {
            internal.set(group, []);
        }
        internal.get(group).push(edge);
    }
    for (const [id, members] of [...groups].sort((a, b) => a[0] - b[0])) {
        await checkpoint();
        communities.push({ id, size: members.length, label: label(members) });
        const children =
            members.length > 2
                ? await detectCommunities(
                      members.map((user) => user.id),
                      internal.get(id) || [],
                      settings.resolution * 1.5,
                      checkpoint
                  )
                : new Map(members.map((user) => [user.id, 0]));
        const childGroups = new Map();
        for (const user of members) {
            const child = children.get(user.id);
            user.subcommunity = `${id}:${child}`;
            if (!childGroups.has(child)) {
                childGroups.set(child, []);
            }
            childGroups.get(child).push(user);
        }
        for (const [child, group] of [...childGroups].sort((a, b) => a[0] - b[0])) {
            subcommunities.push({ id: `${id}:${child}`, parent: id, size: group.length, label: label(group) });
        }
    }
    return { communities, subcommunities };
}
