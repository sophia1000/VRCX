import {
    compareIds,
    daysBetween,
    weekOfDay,
    normalizeAnalysisSettings,
    normalizeFriendsNetworkScope,
    mergeIntervals,
    crowdTimeline,
    createVisitEvidence,
    scoreOverlap,
    createPairEvidence,
    accumulateVisit,
    edgeFromEvidence
} from './scoring';
import { adjustScores, pruneGraph, annotateGroups } from './grouping';

const pairKey = (a, b) => JSON.stringify(compareIds(a, b) < 0 ? [a, b] : [b, a]);
const selectKey = (object, keys) => JSON.stringify(keys.map((key) => object[key]));

function crowdEvidenceMode(settings) {
    return settings.crowd_correction ? settings.crowd_mode : 'none';
}

/**
 * @typedef {Object} AnalysisGraphOptions
 * @property {(status: { stage: string; progress: number; message: string }) => void} [onProgress]
 * @property {() => boolean} [isCancelled]
 */

/** @param {(() => boolean) | undefined} isCancelled */
function createCheckpoint(isCancelled) {
    let lastYield = performance.now();
    const check = () => {
        if (isCancelled?.()) {
            const error = new Error('Friends network analysis cancelled');
            error.name = 'AbortError';
            throw error;
        }
    };
    return async (force = false) => {
        check();
        if (force || performance.now() - lastYield >= 12) {
            // Yield to the worker message queue so cancellation does not discard history.
            await new Promise((resolve) => setTimeout(resolve, 0));
            lastYield = performance.now();
            check();
        }
    };
}

function publicAccounts(accounts) {
    return accounts.map(({ friendIds: _friends, mutualPairs: _pairs, ...metadata }) => ({ ...metadata }));
}

function accountScope(dataset, settings) {
    const account = (dataset.accounts || []).find((entry) => entry.id === settings.current_user_id);
    const mutuals = new Set();
    for (const [a, b] of account?.mutualPairs || []) {
        if (a !== b) {
            mutuals.add(pairKey(a, b));
        }
    }
    return { mutuals };
}

async function prepareWindow(dataset, settings, window, excludedVisits, checkpoint, report) {
    const scope = accountScope(dataset, settings);
    const crowdMode = crowdEvidenceMode(settings);
    const observers = new Set(dataset.observerIds || []);
    const users = new Map();
    const knownUsers = new Map((dataset.users || []).map((user) => [user.id, user]));
    for (const id of settings.friend_ids) {
        const user = knownUsers.get(id);
        users.set(id, {
            id,
            name: user?.name || id,
            is_friend: true,
            join_count: user?.join_count || 0,
            last_seen: user?.last_seen ?? null,
            encounters: 0,
            minutes: 0,
            distinct_days: 0,
            distinct_weeks: 0
        });
    }
    if (!users.size) {
        return { users, visits: [], window, mutuals: scope.mutuals };
    }
    const filter = settings.world_filter.toLowerCase();
    const excludedWorlds = settings.excluded_worlds
        .split(/[,\r\n]+/)
        .map((text) => text.trim().toLowerCase())
        .filter(Boolean);
    const visits = new Map();
    let processed = 0;
    for (const visit of [...(dataset.visits || [])].sort(
        (a, b) => Number(a.id) - Number(b.id) || compareIds(String(a.id), String(b.id))
    )) {
        if (++processed % 512 === 0) {
            await checkpoint();
        }
        if (visit.end <= window.start || visit.start >= window.end || excludedVisits.has(Number(visit.id))) {
            continue;
        }
        const world = `${visit.location || ''} ${visit.world_name || ''}`.toLowerCase();
        if ((filter && !world.includes(filter)) || excludedWorlds.some((text) => world.includes(text))) {
            continue;
        }
        visits.set(visit.id, {
            id: visit.id,
            presence: new Map(),
            crowdIds: crowdMode === 'visit' ? new Set() : null,
            crowdPresence: crowdMode === 'concurrent' ? new Map() : null
        });
    }
    processed = 0;
    for (const row of dataset.presence || []) {
        if (++processed % 1024 === 0) {
            await checkpoint();
            report(
                'overlaps',
                0.1 + (0.15 * processed) / Math.max(1, dataset.presence.length),
                'Clipping observed presence'
            );
        }
        const id = row.user_id;
        const isFriend = users.has(id);
        // Friend pairs never need other people's presence when correction is off.
        if ((!isFriend && crowdMode === 'none') || observers.has(id)) {
            continue;
        }
        const visit = visits.get(row.visit_id);
        if (!visit) {
            continue;
        }
        const start = Math.max(window.start, row.start);
        const end = Math.min(window.end, row.end);
        if (!(end > start)) {
            continue;
        }
        if (visit.crowdIds) {
            // Visit correction needs distinct IDs, not non-friend interval copies.
            visit.crowdIds.add(id);
        }
        const presence = isFriend ? visit.presence : visit.crowdPresence;
        if (!presence) {
            continue;
        }
        if (!presence.has(id)) {
            presence.set(id, []);
        }
        presence.get(id).push({ start, end });
    }
    const days = new Map([...users.keys()].map((id) => [id, new Set()]));
    const prepared = [];
    for (const visit of visits.values()) {
        await checkpoint();
        const presence = new Map();
        for (const id of [...visit.presence.keys()].sort(compareIds)) {
            presence.set(id, mergeIntervals(visit.presence.get(id)));
        }
        visit.presence.clear();
        const spans = [];
        for (const [id, intervals] of presence) {
            const person = users.get(id);
            person.encounters++;
            for (const span of intervals) {
                person.minutes += (span.end - span.start) / 60;
                for (const day of daysBetween(span.start, span.end)) {
                    days.get(id).add(day);
                }
                spans.push({ ...span, id });
            }
        }
        if (!spans.length) {
            visit.crowdIds?.clear();
            visit.crowdPresence?.clear();
            continue;
        }
        spans.sort((a, b) => a.start - b.start || compareIds(a.id, b.id) || a.end - b.end);
        let crowd = 2;
        let timeline = null;
        if (visit.crowdIds) {
            crowd = Math.max(2, visit.crowdIds.size);
            visit.crowdIds.clear();
        } else if (visit.crowdPresence) {
            // Only concurrent correction requires non-friend timing. Discard the
            // per-person spans after producing counts, and skip visits with no friends.
            for (const [id, intervals] of visit.crowdPresence) {
                presence.set(id, mergeIntervals(intervals));
                if (presence.size % 256 === 0) {
                    await checkpoint();
                }
            }
            visit.crowdPresence.clear();
            crowd = Math.max(2, presence.size);
            timeline = crowdTimeline(presence);
        }
        prepared.push({ id: visit.id, spans, crowd, timeline });
    }
    for (const [id, daySet] of days) {
        users.get(id).distinct_days = daySet.size;
        users.get(id).distinct_weeks = new Set([...daySet].map(weekOfDay)).size;
    }
    return { users, visits: prepared, window, mutuals: scope.mutuals };
}

async function aggregateEvidence(prepared, settings, checkpoint, report) {
    const pairs = new Map();
    let index = 0;
    let operations = 0;
    for (const visit of prepared.visits) {
        await checkpoint();
        const active = new Map();
        const visitPairs = new Map();
        // Sweep only overlapping spans. Pair intervals are discarded after each visit.
        for (const span of visit.spans) {
            for (const [id, other] of active) {
                if (++operations % 256 === 0) {
                    await checkpoint();
                }
                if (other.end <= span.start) {
                    active.delete(id);
                    continue;
                }
                if (id === span.id) {
                    continue;
                }
                const source = compareIds(id, span.id) < 0 ? id : span.id;
                const target = source === id ? span.id : id;
                const key = pairKey(source, target);
                if (!visitPairs.has(key)) {
                    visitPairs.set(key, { source, target, evidence: createVisitEvidence() });
                }
                scoreOverlap(
                    visitPairs.get(key).evidence,
                    span.start,
                    Math.min(span.end, other.end),
                    visit.crowd,
                    settings.crowd_correction && settings.crowd_mode === 'concurrent' ? visit.timeline : null,
                    settings,
                    prepared.window
                );
            }
            active.set(span.id, span);
        }
        for (const [key, value] of visitPairs) {
            if (++operations % 256 === 0) {
                await checkpoint();
            }
            if (!pairs.has(key)) {
                pairs.set(key, createPairEvidence(value.source, value.target));
            }
            accumulateVisit(pairs.get(key), value.evidence, settings);
        }
        report(
            'scoring',
            0.3 + (0.4 * ++index) / Math.max(1, prepared.visits.length),
            'Scoring actual overlap by visit'
        );
    }
    // Stable edge and day iteration prevents fixture row order from changing ties.
    const result = [...pairs].sort(
        (a, b) => compareIds(a[1].source, b[1].source) || compareIds(a[1].target, b[1].target)
    );
    for (const [, pair] of result) {
        await checkpoint();
        pair.days = new Map([...pair.days].sort((a, b) => a[0] - b[0]));
    }
    return result;
}

/**
 * Worker-owned, read-only analysis of one imported history generation.
 * One clipped presence window, one aggregate and one completed graph are retained.
 * Full-history pair intervals are never materialized. The snapshot clock stays
 * fixed for this imported generation. Serialize graph calls in the host worker.
 */
export function createFriendsNetworkAnalysis(dataset) {
    let windowCache = null;
    let windowKey = '';
    let evidenceCache = null;
    let evidenceKey = '';
    let graphCache = null;
    let graphKey = '';
    const snapshotAsOf = dataset.builtAt ?? Date.now() / 1000;
    const accounts = publicAccounts(dataset.accounts || []);
    return {
        people(scope = {}) {
            const { friend_ids: friendIds } = normalizeFriendsNetworkScope(scope);
            const knownUsers = new Map((dataset.users || []).map((user) => [user.id, user]));
            return {
                users: friendIds
                    .map((id) => {
                        const user = knownUsers.get(id);
                        return {
                            id,
                            name: user?.name || id,
                            is_friend: true,
                            join_count: user?.join_count || 0
                        };
                    })
                    .sort((a, b) => compareIds(a.name, b.name) || compareIds(a.id, b.id))
            };
        },
        /**
         * @param {Record<string, any>} [input]
         * @param {AnalysisGraphOptions} [options]
         */
        async graph(input = {}, { onProgress, isCancelled } = {}) {
            const checkpoint = createCheckpoint(isCancelled);
            let lastProgress = 0;
            const report = (stage, progress, message) => {
                // The high-volume per-visit loop only posts meaningful progress steps.
                if (stage === 'scoring' && progress < lastProgress + 0.01) {
                    return;
                }
                lastProgress = progress;
                onProgress?.({ stage, progress, message });
            };
            await checkpoint(true);
            const { settings, window, excludedVisits } = normalizeAnalysisSettings({
                ...input,
                as_of: input.as_of ?? snapshotAsOf
            });
            const nextGraphKey = JSON.stringify(settings);
            await checkpoint();
            if (graphCache && graphKey === nextGraphKey) {
                const result = structuredClone(graphCache);
                report('ready', 1, 'Graph ready');
                await checkpoint();
                return result;
            }
            const windowSettings = { ...settings, crowd_evidence_mode: crowdEvidenceMode(settings) };
            const nextWindowKey = selectKey(windowSettings, [
                'days',
                'date_from',
                'date_to',
                'as_of',
                'world_filter',
                'excluded_worlds',
                'excluded_visits',
                'current_user_id',
                'friend_ids',
                'crowd_evidence_mode'
            ]);
            if (!windowCache || nextWindowKey !== windowKey) {
                report('overlaps', 0.1, 'Finding actual overlapping presence');
                const prepared = await prepareWindow(dataset, settings, window, excludedVisits, checkpoint, report);
                await checkpoint();
                windowCache = prepared;
                windowKey = nextWindowKey;
                evidenceCache = null;
            }
            const nextEvidenceKey = selectKey(settings, [
                'half_life_days',
                'crowd_correction',
                'crowd_exponent',
                'crowd_mode',
                'session_cap_minutes',
                'min_overlap_minutes'
            ]);
            if (!evidenceCache || evidenceKey !== nextEvidenceKey) {
                report('scoring', 0.3, 'Scoring independent connections');
                const aggregated = await aggregateEvidence(windowCache, settings, checkpoint, report);
                await checkpoint();
                evidenceCache = aggregated;
                evidenceKey = nextEvidenceKey;
            }
            const users = new Map([...windowCache.users].map(([id, user]) => [id, { ...user }]));
            const links = [];
            let scanned = 0;
            let operations = 0;
            for (const [key, pair] of evidenceCache) {
                if (++operations % 256 === 0) {
                    await checkpoint();
                }
                const mutual = windowCache.mutuals.has(key);
                if (settings.mutual_only && !mutual) {
                    continue;
                }
                scanned += pair.scanned;
                const edge = edgeFromEvidence(pair, settings, mutual);
                if (edge) {
                    links.push(edge);
                }
            }
            const eligibleEdges = links.length;
            report('scoring', 0.75, 'Adjusting network connection scores');
            await adjustScores(users, links, settings, checkpoint);
            const pruned = await pruneGraph(users, links, settings, checkpoint);
            report('communities', 0.85, 'Separating weighted friend groups');
            await checkpoint(true);
            const groups = await annotateGroups(pruned.users, pruned.links, settings, checkpoint);
            let maximum = 0;
            for (const edge of pruned.links) {
                maximum = Math.max(maximum, edge.weight);
            }
            for (const edge of pruned.links) {
                edge.strength = maximum ? Math.sqrt(edge.weight / maximum) : 0;
            }
            const result = {
                nodes: [...pruned.users.values()],
                links: pruned.links,
                ...groups,
                accounts: accounts.map((account) => ({ ...account })),
                stats: {
                    window_start: window.start,
                    window_end: window.end,
                    as_of: window.now,
                    intervals_scanned: scanned,
                    eligible_nodes: users.size,
                    eligible_edges: eligibleEdges,
                    hidden_isolates: pruned.hidden,
                    cache_built_at: dataset.builtAt ?? null
                },
                settings,
                quality: { ...(dataset.quality || {}) }
            };
            const cachedResult = structuredClone(result);
            report('ready', 1, 'Graph ready');
            await checkpoint();
            graphCache = cachedResult;
            graphKey = nextGraphKey;
            return result;
        }
    };
}
