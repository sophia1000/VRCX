import { describe, expect, it, vi } from 'vitest';
import { createFriendsNetworkAnalysis } from '../analysis';
import { detectCommunities } from '../grouping';

const epoch = Date.parse('2026-10-01T00:00:00Z') / 1000;
const baseline = {
    as_of: epoch + 30 * 86400,
    days: null,
    min_encounters: 1,
    min_minutes: 0,
    half_life_days: 0,
    crowd_correction: false,
    top_k: 0,
    max_nodes: 0,
    weighting: 'time'
};

function history(ids = ['a', 'b', 'c']) {
    return {
        users: ids.map((id) => ({
            id,
            name: id.toUpperCase(),
            is_friend: id !== 'stranger',
            join_count: 3,
            last_seen: epoch
        })),
        visits: [],
        presence: [],
        accounts: [
            {
                id: 'owner',
                prefix: 'owner',
                label: 'Owner',
                friend_count: ids.filter((id) => id !== 'stranger').length,
                mutual_count: 1,
                friendIds: ids.filter((id) => id !== 'stranger'),
                mutualPairs: [['a', 'b']]
            }
        ],
        observerIds: ['observer'],
        quality: { inferred: 0 },
        builtAt: epoch + 123
    };
}

function visit(data, id, start, spans, location = 'world-one') {
    data.visits.push({
        id,
        start: epoch + start * 60,
        end: epoch + (start + 1440) * 60,
        location,
        world_name: location
    });
    for (const [user_id, from, to] of spans)
        data.presence.push({
            visit_id: id,
            user_id,
            start: epoch + (start + from) * 60,
            end: epoch + (start + to) * 60,
            inferred: false
        });
}

const linkFor = (graph, a, b) => graph.links.find((edge) => edge.source === a && edge.target === b);
const graphOf = (data, settings = {}) => createFriendsNetworkAnalysis(data).graph({ ...baseline, ...settings });

describe('worker friends network analysis', () => {
    it('counts rejoins once per visit and unions duplicate presence without bridging gaps', async () => {
        const data = history();
        visit(data, 1, 0, [
            ['a', 0, 10],
            ['a', 0, 10],
            ['a', 20, 30],
            ['b', 0, 30],
            ['c', 10, 20]
        ]);
        const graph = await graphOf(data);
        expect(graph.links).toHaveLength(2);
        expect(linkFor(graph, 'a', 'c')).toBeUndefined();
        expect(graph.links[0]).toMatchObject({
            source: 'a',
            target: 'b',
            encounters: 1,
            minutes: 20,
            observed_minutes: 20,
            weight: 20
        });
        expect(graph.nodes.find((node) => node.id === 'a')).toMatchObject({ encounters: 1, minutes: 20 });
    });

    it('includes non-friends in crowd correction and concurrent mode excludes later arrivals', async () => {
        const data = history(['a', 'b', 'stranger']);
        visit(data, 1, 0, [
            ['a', 0, 15],
            ['b', 0, 15],
            ['stranger', 20, 30]
        ]);
        const analysis = createFriendsNetworkAnalysis(data);
        const whole = await analysis.graph({ ...baseline, crowd_correction: true });
        const concurrent = await analysis.graph({ ...baseline, crowd_correction: true, crowd_mode: 'concurrent' });
        expect(whole.links[0].weight).toBeCloseTo(15 / Math.sqrt(2));
        expect(concurrent.links[0].weight).toBe(15);
        expect(concurrent.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    });

    it('splits concurrent crowd changes and keeps the strongest encounter and day factors', async () => {
        const data = history(['a', 'b', 'stranger']);
        visit(data, 1, 0, [
            ['a', 0, 20],
            ['b', 0, 20],
            ['stranger', 10, 20],
            ['stranger', 10, 20]
        ]);
        const graph = await graphOf(data, { crowd_correction: true, crowd_mode: 'concurrent', crowd_exponent: 1 });
        expect(graph.links[0]).toMatchObject({
            effective_minutes: 15,
            effective_encounters: 1,
            effective_days: 1,
            minutes: 20
        });
    });

    it('ignores the crowd mode when correction is disabled, including recency factors', async () => {
        const data = history(['a', 'b', 'stranger']);
        visit(data, 1, 0, [
            ['a', 0, 20],
            ['b', 0, 20],
            ['stranger', 10, 20]
        ]);
        const analysis = createFriendsNetworkAnalysis(data);
        const settings = { ...baseline, half_life_days: 1 };
        const whole = await analysis.graph(settings);
        const concurrent = await analysis.graph({ ...settings, crowd_mode: 'concurrent' });
        expect(concurrent.links).toEqual(whole.links);
    });

    it('clips before evaluating per-visit minimums and caps only effective time', async () => {
        const data = history();
        visit(data, 1, 0, [
            ['a', 0, 10],
            ['a', 20, 30],
            ['b', 0, 30]
        ]);
        visit(data, 2, 1440, [
            ['a', 0, 5],
            ['b', 0, 5]
        ]);
        const graph = await graphOf(data, { min_overlap_minutes: 10, session_cap_minutes: 12 });
        expect(graph.links[0]).toMatchObject({
            encounters: 1,
            minutes: 20,
            effective_minutes: 12,
            observed_encounters: 2,
            observed_minutes: 25
        });
        const clipped = await graphOf(data, { date_from: epoch + 25 * 60, date_to: epoch + 30 * 60 });
        expect(clipped.links[0].minutes).toBe(5);
        expect(
            (await graphOf(data, { date_from: epoch + 25 * 60, date_to: epoch + 30 * 60, min_overlap_minutes: 6 }))
                .links
        ).toEqual([]);
    });

    it('uses distinct UTC days and Monday weeks without counting an exact midnight end', async () => {
        const data = history();
        visit(data, 1, 23 * 60 + 50, [
            ['a', 0, 10],
            ['b', 0, 10]
        ]);
        visit(data, 2, 23 * 60 + 55, [
            ['a', 0, 10],
            ['b', 0, 10]
        ]);
        visit(data, 3, 7 * 1440, [
            ['a', 0, 10],
            ['b', 0, 10]
        ]);
        const graph = await graphOf(data, { weighting: 'days', consistency: 0.5 });
        expect(graph.links[0]).toMatchObject({
            encounters: 3,
            distinct_days: 3,
            distinct_weeks: 2,
            effective_days: 3,
            base_weight: 3,
            weight: 4.5
        });
        expect(graph.nodes[0]).toMatchObject({ distinct_days: 3, distinct_weeks: 2 });
        const oneDay = await graphOf(data, { date_from: '2026-10-01', date_to: '2026-10-01' });
        expect(oneDay.links[0].minutes).toBe(15);
        expect(oneDay.links[0].distinct_days).toBe(1);
    });

    it('applies recency at segment midpoint and as_of clips future presence', async () => {
        const data = history();
        visit(data, 1, 0, [
            ['a', 0, 20],
            ['b', 0, 20]
        ]);
        const graph = await graphOf(data, { as_of: epoch + 10 * 60, half_life_days: 1, weighting: 'count' });
        expect(graph.links[0].minutes).toBe(10);
        expect(graph.links[0].weight).toBeCloseTo(Math.pow(2, -300 / 86400));
    });

    it('switches account snapshots without altering history or including observers', async () => {
        const data = history(['a', 'b', 'c', 'observer']);
        data.accounts[0].friendIds = ['a', 'c'];
        data.accounts.push({ id: 'alt', label: 'Alt', friendIds: ['a', 'b'], mutualPairs: [['b', 'a']] });
        visit(data, 1, 0, [
            ['a', 0, 10],
            ['b', 0, 10],
            ['observer', 0, 10]
        ]);
        const before = structuredClone(data),
            analysis = createFriendsNetworkAnalysis(data);
        expect((await analysis.graph({ ...baseline, account_ids: ['owner'] })).links).toHaveLength(0);
        const all = await analysis.graph({ ...baseline, mutual_only: true });
        expect(all.links[0].mutual).toBe(true);
        expect(all.accounts).toHaveLength(2);
        expect(all.accounts[0]).not.toHaveProperty('friendIds');
        expect(all.nodes.map((node) => node.id)).toEqual(['a', 'b']);
        expect(analysis.people().users.map((user) => user.id)).toEqual(['a', 'b', 'c']);
        expect(data).toEqual(before);
    });

    it('supports world and visit exclusions independently of independent minimum evidence', async () => {
        const data = history();
        visit(
            data,
            1,
            0,
            [
                ['a', 0, 30],
                ['b', 0, 30]
            ],
            'world-one'
        );
        visit(
            data,
            2,
            1440,
            [
                ['a', 0, 5],
                ['b', 0, 5]
            ],
            'world-two'
        );
        expect((await graphOf(data, { world_filter: 'WORLD-TWO' })).links[0].minutes).toBe(5);
        expect((await graphOf(data, { excluded_worlds: 'ONE' })).links[0].minutes).toBe(5);
        expect((await graphOf(data, { excluded_visits: '1, 2' })).links).toHaveLength(0);
        expect(
            (
                await graphOf(data, {
                    min_encounters: 3,
                    consistency: 1,
                    neighbor_similarity: 1,
                    group_hints: { a: 'group', b: 'group' }
                })
            ).links
        ).toHaveLength(0);
        expect((await graphOf(data, { min_minutes: 36 })).links).toHaveLength(0);
    });

    it('implements top-K union and bilateral selection, max nodes, and isolates', async () => {
        const data = history(['a', 'b', 'c', 'd']);
        visit(data, 1, 0, [
            ['a', 0, 30],
            ['b', 0, 30]
        ]);
        visit(data, 2, 1440, [
            ['a', 0, 20],
            ['c', 0, 20]
        ]);
        visit(data, 3, 2880, [
            ['b', 0, 10],
            ['c', 0, 10]
        ]);
        const union = await graphOf(data, { top_k: 1 });
        expect(union.links.map((edge) => edge.source + edge.target)).toEqual(['ab', 'ac']);
        const bilateral = await graphOf(data, { top_k: 1, edge_selection: 'mutual', include_isolates: true });
        expect(bilateral.links.map((edge) => edge.source + edge.target)).toEqual(['ab']);
        expect(bilateral.nodes).toHaveLength(4);
        const isolate = bilateral.nodes.find((node) => node.id === 'd');
        expect(isolate).toMatchObject({
            bridge_score: 0,
            connection_score: 0,
            memberships: [{ community: isolate.community, score: 1 }]
        });
        const limited = await graphOf(data, { max_nodes: 2 });
        expect(limited.nodes.map((node) => node.id)).toEqual(['a', 'b']);
        expect(limited.links).toHaveLength(1);
        expect(union.stats).toMatchObject({
            eligible_nodes: 4,
            eligible_edges: 3,
            hidden_isolates: 1,
            cache_built_at: epoch + 123
        });
    });

    it('computes hub damping, relative closeness, cosine neighbors and hint factors from independent edges', async () => {
        const data = history();
        visit(data, 1, 0, [
            ['a', 0, 20],
            ['b', 0, 20],
            ['c', 0, 20]
        ]);
        const graph = await graphOf(data, {
            hub_damping: 1,
            relative_closeness: 1,
            neighbor_similarity: 1,
            group_hints: { a: 'team', b: 'team' }
        });
        expect(linkFor(graph, 'a', 'b').score_factors).toEqual({
            consistency: 1,
            hub_damping: 1,
            relative_closeness: 1,
            neighbor_similarity: 2,
            group_hint: 1.1
        });
        expect(linkFor(graph, 'a', 'b').weight).toBe(44);
        const star = history(['a', 'b', 'c', 'd', 'e']);
        for (const [index, id] of ['b', 'c', 'd', 'e'].entries())
            visit(star, index, index * 1440, [
                ['a', 0, 10],
                [id, 0, 10]
            ]);
        const damped = await graphOf(star, { hub_damping: 1, relative_closeness: 1 });
        expect(damped.links[0].score_factors.hub_damping).toBeCloseTo(0.5);
        expect(damped.links[0].score_factors.relative_closeness).toBeCloseTo(0.5);
    });

    it('filters a disparity backbone before top-K and counts newly hidden isolates', async () => {
        const data = history();
        visit(data, 1, 0, [
            ['a', 0, 90],
            ['b', 0, 90]
        ]);
        visit(data, 2, 1440, [
            ['a', 0, 5],
            ['c', 0, 5]
        ]);
        visit(data, 3, 2880, [
            ['b', 0, 5],
            ['c', 0, 5]
        ]);
        const analysis = createFriendsNetworkAnalysis(data);
        const unfiltered = await analysis.graph(baseline);
        expect(unfiltered.links).toHaveLength(3);
        expect(unfiltered.stats.hidden_isolates).toBe(0);
        const filtered = await analysis.graph({ ...baseline, backbone_threshold: 0.1 });
        expect(filtered.links.map(({ source, target }) => source + target)).toEqual(['ab']);
        expect(filtered.nodes.map((node) => node.id)).toEqual(['a', 'b']);
        expect(filtered.stats).toMatchObject({ hidden_isolates: 1, eligible_edges: 3 });
        expect(filtered.links[0].base_weight).toBe(unfiltered.links[0].base_weight);
        const withIsolates = await analysis.graph({ ...baseline, backbone_threshold: 0.1, include_isolates: true });
        const isolated = withIsolates.nodes.find((node) => node.id === 'c');
        expect(withIsolates.stats.hidden_isolates).toBe(0);
        expect(isolated).toMatchObject({ connection_score: 0, bridge_score: 0 });
        expect(isolated.memberships).toEqual([{ community: isolated.community, score: 1 }]);
        const strict = await analysis.graph({ ...baseline, backbone_threshold: 0 });
        expect(strict.nodes).toEqual([]);
        expect(strict.stats.hidden_isolates).toBe(3);
        const progress = [];
        await analysis.graph({ ...baseline, backbone_threshold: 0.2 }, { onProgress: (state) => progress.push(state) });
        expect(progress.some((state) => state.stage === 'overlaps' || state.progress < 0.75)).toBe(false);
    });

    it('separates dense weighted groups and annotates memberships and subgroup rings deterministically', async () => {
        const data = history(['a', 'b', 'c', 'd', 'e', 'f']);
        visit(data, 1, 0, [
            ['a', 0, 30],
            ['b', 0, 30],
            ['c', 0, 30]
        ]);
        visit(data, 2, 1440, [
            ['d', 0, 30],
            ['e', 0, 30],
            ['f', 0, 30]
        ]);
        visit(data, 3, 2880, [
            ['c', 0, 1],
            ['d', 0, 1]
        ]);
        const first = await graphOf(data);
        expect(first.communities.map((group) => group.size)).toEqual([3, 3]);
        const bridge = first.nodes.find((node) => node.id === 'c');
        expect(bridge.memberships).toHaveLength(2);
        expect(bridge.bridge_score).toBeCloseTo(1 / 61);
        expect(first.nodes.every((node) => first.subcommunities.some((group) => group.id === node.subcommunity))).toBe(
            true
        );
        const reverse = structuredClone(data);
        reverse.users.reverse();
        reverse.presence.reverse();
        reverse.visits.reverse();
        expect(await graphOf(reverse)).toEqual(first);
    });

    it('reuses aggregates for display, weighting and pair minimum changes and protects cached objects', async () => {
        const data = history();
        visit(data, 1, 0, [
            ['a', 0, 10],
            ['b', 0, 10]
        ]);
        const analysis = createFriendsNetworkAnalysis(data),
            progress = [];
        const first = await analysis.graph(baseline);
        first.nodes[0].name = 'modified';
        first.links[0].weight = 999;
        const next = await analysis.graph(
            { ...baseline, weighting: 'count', top_k: 1, min_encounters: 1 },
            { onProgress: (state) => progress.push(state) }
        );
        expect(next.links[0].weight).toBe(1);
        expect(next.nodes[0].name).toBe('A');
        expect(progress.some((state) => state.stage === 'overlaps' || state.progress < 0.75)).toBe(false);
        expect(progress.at(-1)).toMatchObject({ stage: 'ready', progress: 1 });
    });

    it('cancels cooperatively and leaves the imported dataset reusable', async () => {
        const data = history();
        visit(data, 1, 0, [
            ['a', 0, 10],
            ['b', 0, 10]
        ]);
        const analysis = createFriendsNetworkAnalysis(data);
        let cancelled = false;
        await expect(
            analysis.graph(baseline, {
                isCancelled: () => cancelled,
                onProgress: (state) => {
                    if (state.stage === 'scoring') cancelled = true;
                }
            })
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect((await analysis.graph(baseline)).links[0].minutes).toBe(10);
    });

    it('reuses the last completed graph without scoring or grouping and returns independent copies', async () => {
        const data = history();
        visit(data, 1, 0, [
            ['a', 0, 10],
            ['b', 0, 10]
        ]);
        const analysis = createFriendsNetworkAnalysis(data);
        const first = await analysis.graph(baseline);
        const expected = structuredClone(first);
        first.nodes[0].memberships[0].score = 0;
        first.links[0].score_factors.consistency = 99;
        const progress = [];
        const second = await analysis.graph(
            { ...baseline, _revision: 2 },
            {
                onProgress: (status) => progress.push(status)
            }
        );
        expect(second).toEqual(expected);
        expect(progress).toEqual([{ stage: 'ready', progress: 1, message: 'Graph ready' }]);
        second.nodes[0].name = 'changed';
        expect(await analysis.graph(baseline)).toEqual(expected);
        await expect(analysis.graph({ ...baseline, crowd_exponent: Infinity })).rejects.toThrow();
        await expect(analysis.graph(baseline, { isCancelled: () => true })).rejects.toMatchObject({
            name: 'AbortError'
        });
    });

    it('freezes the default clock to the imported snapshot while permitting an explicit as_of', async () => {
        const data = history();
        data.builtAt = epoch + 86400;
        visit(data, 1, 0, [
            ['a', 0, 10],
            ['b', 0, 10]
        ]);
        const analysis = createFriendsNetworkAnalysis(data);
        const { as_of: _asOf, ...settings } = baseline;
        const clock = vi.spyOn(Date, 'now');
        try {
            clock.mockReturnValue((epoch + 2 * 86400) * 1000);
            const first = await analysis.graph(settings);
            clock.mockReturnValue((epoch + 3 * 86400) * 1000);
            const progress = [];
            const second = await analysis.graph(settings, { onProgress: (status) => progress.push(status) });
            expect(second).toEqual(first);
            expect(second.stats.as_of).toBe(data.builtAt);
            expect(progress.map((status) => status.stage)).toEqual(['ready']);
            expect((await analysis.graph({ ...settings, as_of: epoch + 2 * 86400 })).stats.as_of).toBe(
                epoch + 2 * 86400
            );
        } finally {
            clock.mockRestore();
        }
    });

    it('validates malformed settings even when history is empty', async () => {
        const analysis = createFriendsNetworkAnalysis(history());
        for (const settings of [
            { excluded_visits: 'abc' },
            { crowd_exponent: Infinity },
            { date_from: 10, date_to: 5 },
            { group_hints: [] },
            { account_ids: ['owner', 'alt'] }
        ]) {
            await expect(analysis.graph({ ...baseline, ...settings })).rejects.toThrow();
        }
    });
});

describe('deterministic weighted Louvain', () => {
    it('preserves isolates and strict tie handling across node and edge row order', async () => {
        const links = [
            { source: 'a', target: 'b', weight: 10 },
            { source: 'b', target: 'c', weight: 1 },
            { source: 'c', target: 'd', weight: 10 }
        ];
        const first = await detectCommunities(['a', 'b', 'c', 'd', 'z'], links, 1);
        const second = await detectCommunities(['z', 'd', 'c', 'b', 'a'], [...links].reverse(), 1);
        expect(Object.fromEntries(first)).toEqual({ a: 0, b: 0, c: 1, d: 1, z: 2 });
        expect(Object.fromEntries(second)).toEqual(Object.fromEntries(first));
    });
});
