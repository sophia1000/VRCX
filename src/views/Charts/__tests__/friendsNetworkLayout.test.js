import { describe, expect, test, vi } from 'vitest';

import {
    assignFriendsNetworkCommunities,
    buildFriendsNetworkGraph,
    collectFriendsNetworkPositions,
    createFriendsNetworkLayout,
    createFriendsNetworkLayoutClient,
    createFriendsNetworkLayoutController,
    finishFriendsNetworkLayout,
    normalizeFriendsNetworkLayoutSettings,
    stepFriendsNetworkLayout
} from '../friendsNetworkLayout';

function triangleGroups() {
    return {
        nodes: [...'abcdefg'].map((id) => ({ id, name: `Person ${id}`, community: id < 'd' ? 0 : id < 'g' ? 1 : 2 })),
        links: [
            { source: 'a', target: 'b', weight: 40 },
            { source: 'a', target: 'c', weight: 40 },
            { source: 'b', target: 'c', weight: 40 },
            { source: 'd', target: 'e', weight: 40 },
            { source: 'd', target: 'f', weight: 40 },
            { source: 'e', target: 'f', weight: 40 },
            { source: 'c', target: 'd', weight: 0.01 }
        ]
    };
}

function completeLayout(data, settings = {}) {
    const state = createFriendsNetworkLayout({ ...data, settings: { layoutIterations: 16, ...settings } });
    while (!stepFriendsNetworkLayout(state)) {
        // Small synthetic graphs complete synchronously in unit tests only.
    }
    return finishFriendsNetworkLayout(state);
}

describe('friends network Graphology adapter', () => {
    test('accepts analysis edges while preserving evidence attributes', () => {
        const data = {
            nodes: [
                { id: 'a', name: 'Alpha', join_count: 25 },
                { id: 'b', name: 'Beta' }
            ],
            links: [
                { source: 'b', target: 'a', weight: 3, encounters: 7, minutes: 90 },
                { source: 'a', target: 'b', weight: 2 },
                { source: 'a', target: 'a', weight: 100 },
                { source: 'a', target: 'missing', weight: 100 },
                { source: 'a', target: 'b', weight: NaN }
            ]
        };
        const graph = buildFriendsNetworkGraph(data);
        expect(graph.order).toBe(2);
        expect(graph.size).toBe(1);
        expect(graph.getNodeAttributes('a')).toMatchObject({ label: 'Alpha', join_count: 25, type: 'circle' });
        expect(graph.getNodeAttribute('b', 'label')).toBe('Beta');
        expect(graph.getEdgeAttributes(graph.edges()[0])).toMatchObject({
            weight: 3,
            encounters: 7,
            minutes: 90
        });
        expect(data.nodes[0]).not.toHaveProperty('x');
    });

    test('keeps warm positions exactly and introduces new neighbors near them', () => {
        const positions = { a: { x: 100, y: -40 }, b: { x: 120, y: -30 } };
        const graph = buildFriendsNetworkGraph(
            { nodes: [...'abc'].map((id) => ({ id })), links: [{ source: 'a', target: 'c', weight: 1 }] },
            {},
            positions
        );
        expect(collectFriendsNetworkPositions(graph).a).toEqual(positions.a);
        expect(collectFriendsNetworkPositions(graph).b).toEqual(positions.b);
        const introduced = graph.getNodeAttributes('c');
        expect(Math.hypot(introduced.x - 100, introduced.y + 40)).toBeLessThan(10);
        expect(positions).toEqual({ a: { x: 100, y: -40 }, b: { x: 120, y: -30 } });
        const reset = buildFriendsNetworkGraph({ nodes: [{ id: 'a' }] }, { reinitialize: true }, positions);
        expect(collectFriendsNetworkPositions(reset).a).not.toEqual(positions.a);
    });

    test('normalizes malformed controls to finite bounded values', () => {
        expect(
            normalizeFriendsNetworkLayoutSettings({
                groupSpacing: Infinity,
                groupTightness: -100,
                betweenGroupPull: 100,
                layoutIterations: -3
            })
        ).toMatchObject({
            groupSpacing: 60,
            groupTightness: 0,
            betweenGroupPull: 100,
            layoutIterations: 1
        });
    });
});

describe('analysis communities and force state', () => {
    test('retains analysis groups and gives isolates independent layout targets', () => {
        const supplied = assignFriendsNetworkCommunities(buildFriendsNetworkGraph(triangleGroups()));
        expect(supplied.communitySource).toBe('backend');
        expect(supplied.communities.a).toBe(0);
        expect(supplied.communities.d).toBe(1);
        expect(supplied.communities.g).toBe('singleton:g');
    });

    test('reports missing analysis labels rather than silently recalculating groups', () => {
        expect(() => assignFriendsNetworkCommunities(buildFriendsNetworkGraph({ nodes: [{ id: 'a' }] }))).toThrow(
            'Missing community'
        );
    });

    test('restores Circles force distances and reduces attraction between groups without rewriting evidence', () => {
        const state = createFriendsNetworkLayout({
            nodes: [
                { id: 'a', community: 0 },
                { id: 'b', community: 0 },
                { id: 'c', community: 1 }
            ],
            links: [
                { source: 'a', target: 'b', weight: 100, strength: 1 },
                { source: 'b', target: 'c', weight: 50, strength: 1 }
            ],
            settings: { groupTightness: 70, betweenGroupPull: 20 }
        });
        const linkForce = state.simulation.force('link');
        const [inside, outside] = linkForce.links();
        expect(linkForce.distance()(inside)).toBe(34);
        expect(linkForce.strength()(outside)).toBeCloseTo(linkForce.strength()(inside) * 0.2);
        expect(state.graph.getEdgeAttribute(state.graph.edge('a', 'b'), 'weight')).toBe(100);
        expect(state.graph.getEdgeAttribute(state.graph.edge('b', 'c'), 'weight')).toBe(50);
    });

    test('retains the same simulation across batches as uninterrupted D3 ticks', () => {
        const data = { ...triangleGroups(), settings: { layoutIterations: 16, batchIterations: 4 } };
        const batched = createFriendsNetworkLayout(data);
        const reference = createFriendsNetworkLayout(data);
        reference.simulation.tick(16);
        while (!stepFriendsNetworkLayout(batched)) {
            // The same node velocities survive every worker yield.
        }
        expect(finishFriendsNetworkLayout(batched)).toEqual(finishFriendsNetworkLayout(reference));
    });

    test('spaces circle targets independently and puts unconnected people on a separate shelf', () => {
        const data = triangleGroups();
        const compact = createFriendsNetworkLayout({ ...data, settings: { groupSpacing: 0 } });
        const spread = createFriendsNetworkLayout({ ...data, settings: { groupSpacing: 100 } });
        const distance = (state) => {
            const first = state.nodes.find((node) => node.id === 'a');
            const second = state.nodes.find((node) => node.id === 'd');
            return Math.hypot(first.targetX - second.targetX, first.targetY - second.targetY);
        };
        expect(distance(spread)).toBeGreaterThan(distance(compact) * 3);
        const isolated = spread.nodes.find((node) => node.id === 'g');
        expect(isolated.targetY).toBeGreaterThan(
            Math.max(...spread.nodes.filter((node) => node.id !== 'g').map((node) => node.targetY))
        );
    });

    test('complete layouts are repeatable, finite, and support empty inputs', () => {
        const first = completeLayout(triangleGroups());
        expect(first).toEqual(completeLayout(triangleGroups()));
        for (const position of Object.values(first.positions)) {
            expect(Number.isFinite(position.x) && Number.isFinite(position.y)).toBe(true);
        }
        expect(completeLayout({ nodes: [], links: [] }).positions).toEqual({});
    });
});

describe('latest-request-wins worker coordination', () => {
    test('a newer request cancels an old job before graph reconstruction', async () => {
        const posted = [];
        const waiting = [];
        const controller = createFriendsNetworkLayoutController((message) => posted.push(message), {
            yieldControl: () => new Promise((resolve) => waiting.push(resolve))
        });
        const old = controller.handle({ requestId: 1, ...triangleGroups(), settings: { layoutIterations: 1 } });
        const latest = controller.handle({ requestId: 2, ...triangleGroups(), settings: { layoutIterations: 1 } });
        for (const resolve of waiting) {
            resolve();
        }
        await Promise.all([old, latest]);
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({ requestId: 2, done: true });
        expect(posted[0].positions.a).toBeTruthy();
    });

    test('cancellation during yielded force batches suppresses obsolete results', async () => {
        const posted = [];
        const waiting = [];
        const controller = createFriendsNetworkLayoutController((message) => posted.push(message), {
            yieldControl: () => new Promise((resolve) => waiting.push(resolve))
        });
        const running = controller.handle({
            requestId: 1,
            ...triangleGroups(),
            settings: { layoutIterations: 32, batchIterations: 1 }
        });
        waiting.shift()();
        await Promise.resolve();
        expect(waiting).toHaveLength(1);
        controller.cancel();
        waiting.shift()();
        await running;
        expect(posted).toEqual([]);
    });

    test('client settles superseded promises and ignores stale replies', async () => {
        const listeners = new Map();
        const worker = {
            addEventListener: (name, handler) => listeners.set(name, handler),
            removeEventListener: vi.fn(),
            postMessage: vi.fn(),
            terminate: vi.fn()
        };
        const client = createFriendsNetworkLayoutClient(() => worker);
        const old = client.layout({ nodes: [], links: [] });
        const latest = client.layout({ nodes: [], links: [] });
        await expect(old).resolves.toBeNull();
        const handler = listeners.get('message');
        handler({ data: { requestId: 1, done: true, positions: { stale: true } } });
        handler({ data: { requestId: 2, done: true, positions: { current: true } } });
        await expect(latest).resolves.toMatchObject({ requestId: 2, positions: { current: true } });
        const cancelled = client.layout({ nodes: [], links: [] });
        client.cancel();
        await expect(cancelled).resolves.toBeNull();
        client.dispose();
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(worker.removeEventListener).toHaveBeenCalledTimes(3);
        await expect(client.layout({})).rejects.toThrow('disposed');
    });
    test('routes live frames only for the active settled graph and stops them on cancel', async () => {
        const listeners = new Map();
        const worker = {
            addEventListener: (name, callback) => listeners.set(name, callback),
            removeEventListener: vi.fn(),
            postMessage: vi.fn(),
            terminate: vi.fn()
        };
        const onProgress = vi.fn();
        const client = createFriendsNetworkLayoutClient(() => worker, { onProgress });
        const pending = client.layout({ nodes: [], links: [] });
        const onMessage = listeners.get('message');
        client.drag({ phase: 'start', nodes: [] });
        expect(worker.postMessage).toHaveBeenCalledTimes(1);
        onMessage({ data: { requestId: 1, done: true, positions: {} } });
        await pending;
        client.drag({ phase: 'start', nodes: [{ id: 'a', x: 10, y: 20 }] });
        expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'drag', requestId: 1 }));
        onMessage({ data: { requestId: 1, live: true, positions: new Float64Array() } });
        expect(onProgress).toHaveBeenCalledOnce();
        client.cancel();
        onMessage({ data: { requestId: 1, live: true, positions: new Float64Array() } });
        expect(onProgress).toHaveBeenCalledOnce();
        client.dispose();
    });
});

test.each(['error', 'messageerror'])('recreates a failed layout worker after %s', async (eventName) => {
    const workers = [];
    const createWorker = () => {
        const listeners = new Map();
        const worker = {
            listeners,
            addEventListener: (name, handler) => listeners.set(name, handler),
            removeEventListener: vi.fn(),
            postMessage: vi.fn(),
            terminate: vi.fn()
        };
        workers.push(worker);
        return worker;
    };
    const client = createFriendsNetworkLayoutClient(createWorker);
    const failed = client.layout({ nodes: [], links: [] });
    const rejection = expect(failed).rejects.toThrow('failed');
    const oldMessage = workers[0].listeners.get('message');
    workers[0].listeners.get(eventName)({ message: 'worker failed' });
    await rejection;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    client.cancel();
    const retry = client.layout({ nodes: [], links: [] });
    expect(workers).toHaveLength(2);
    const requestId = workers[1].postMessage.mock.calls[0][0].requestId;
    oldMessage({ data: { requestId, done: true, positions: { stale: true } } });
    workers[1].listeners.get('message')({ data: { requestId, done: true, positions: {} } });
    await expect(retry).resolves.toMatchObject({ positions: {} });
    client.dispose();
});

test('a worker construction failure leaves dragging disabled and allows a retry', async () => {
    const listeners = new Map();
    const worker = {
        addEventListener: (name, handler) => listeners.set(name, handler),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
        terminate: vi.fn()
    };
    const factory = vi
        .fn()
        .mockImplementationOnce(() => {
            throw new Error('Could not start worker');
        })
        .mockReturnValue(worker);
    const client = createFriendsNetworkLayoutClient(factory);
    await expect(client.layout({ nodes: [], links: [] })).rejects.toThrow('Could not start worker');
    expect(() => client.drag({ phase: 'start', nodes: [] })).not.toThrow();
    const retry = client.layout({ nodes: [], links: [] });
    const requestId = worker.postMessage.mock.calls[0][0].requestId;
    listeners.get('message')({ data: { requestId, done: true, positions: {} } });
    await expect(retry).resolves.toMatchObject({ positions: {} });
    client.dispose();
});
