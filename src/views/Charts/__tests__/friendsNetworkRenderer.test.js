import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lifetime = vi.hoisted(() => ({
    dispose: vi.fn(),
    cancel: vi.fn(),
    layout: vi.fn(),
    drag: vi.fn(),
    onProgress: null,
    sigmas: [],
    observers: []
}));
vi.mock('../friendsNetworkLayoutWorker.js?worker&inline', () => ({ default: class {} }));
vi.mock('../friendsNetworkLayout', async (original) => ({
    ...(await original()),
    createFriendsNetworkLayoutClient: (_worker, options) => {
        lifetime.onProgress = options.onProgress;
        return {
            layout: lifetime.layout,
            drag: lifetime.drag,
            cancel: lifetime.cancel,
            dispose: lifetime.dispose
        };
    }
}));

// Exercise the renderer's Sigma contract without requiring a WebGL context.
// Graph coordinates use a fixed offset and scale, so pointer movement and the
// overlay share a deterministic projection just as they do in the real viewer.
vi.mock('sigma', () => ({
    default: class {
        constructor(graph, host, settings) {
            this.graph = graph;
            this.settings = { ...settings };
            this.handlers = new Map();
            this.cameraState = { x: 0.5, y: 0.5, ratio: 1, angle: 0 };
            this.camera = {
                getState: vi.fn(() => ({ ...this.cameraState })),
                setState: vi.fn((state) => {
                    Object.assign(this.cameraState, state);
                }),
                disable: vi.fn(),
                enable: vi.fn()
            };
            this.refresh = vi.fn();
            this.scheduleRefresh = vi.fn();
            this.scheduleRender = vi.fn();
            this.resize = vi.fn();
            this.setCustomBBox = vi.fn();
            this.setSettings = vi.fn((next) => {
                Object.assign(this.settings, next);
            });
            this.kill = vi.fn(() => {
                this.handlers.clear();
            });
            const canvas = document.createElement('canvas');
            canvas.dataset.sigma = 'true';
            host.append(canvas);
            lifetime.sigmas.push(this);
        }
        on(name, callback) {
            if (!this.handlers.has(name)) {
                this.handlers.set(name, []);
            }
            this.handlers.get(name).push(callback);
        }
        emit(name, payload) {
            for (const callback of this.handlers.get(name) || []) {
                callback(payload);
            }
        }
        getCamera() {
            return this.camera;
        }
        getNodeDisplayData(id) {
            return this.graph.hasNode(id) ? this.graph.getNodeAttributes(id) : undefined;
        }
        getDimensions() {
            return { width: 1600, height: 1200 };
        }
        getGraphToViewportRatio() {
            return 2;
        }
        scaleSize(size) {
            return size * 2;
        }
        graphToViewport({ x, y }) {
            return { x: 500 + 2 * x, y: 400 - 2 * y };
        }
        viewportToGraph({ x, y }) {
            return { x: (x - 500) / 2, y: (400 - y) / 2 };
        }
    }
}));

import { FriendsNetworkRenderer } from '../friendsNetworkRenderer';
import { createDefaultFriendsNetworkSettings } from '../friendsNetworkSettings';

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const graph = {
    nodes: [
        {
            id: 'a',
            name: 'A',
            community: 0,
            memberships: [
                { community: 0, score: 0.7 },
                { community: 1, score: 0.3 }
            ]
        },
        { id: 'b', name: 'B', community: 0 },
        { id: 'c', name: 'C', community: 1 },
        { id: 'd', name: 'D', community: 2 }
    ],
    links: [
        { source: 'a', target: 'b', weight: 10, strength: 1 },
        { source: 'b', target: 'c', weight: 1, strength: 0 }
    ]
};
const positions = { a: { x: 0, y: 0 }, b: { x: 100, y: 100 }, c: { x: 200, y: 50 }, d: { x: 300, y: 100 } };
const renderers = [];
let context;

function createRenderer() {
    const container = document.createElement('div');
    const onSelect = vi.fn();
    const renderer = new FriendsNetworkRenderer(container, onSelect);
    renderers.push(renderer);
    return { renderer, container, onSelect, sigma: lifetime.sigmas.at(-1) };
}

function pointerPayload(x = 500, y = 400, original = {}) {
    return { event: { x, y, original: { button: 0, ...original } }, preventSigmaDefault: vi.fn() };
}

function movePointer(x, y) {
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }));
}

function nodeDisplay(sigma, id) {
    return sigma.settings.nodeReducer(id, sigma.graph.getNodeAttributes(id));
}

function edgeDisplay(sigma, source, target) {
    const id = sigma.graph.edge(source, target);
    return sigma.settings.edgeReducer(id, sigma.graph.getEdgeAttributes(id));
}

beforeEach(() => {
    vi.resetAllMocks();
    lifetime.sigmas.length = 0;
    lifetime.observers.length = 0;
    context = {
        setTransform: vi.fn(),
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        setLineDash: vi.fn(),
        measureText: vi.fn((text) => ({ width: text.length * 6 })),
        createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() }))
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    vi.stubGlobal(
        'ResizeObserver',
        class {
            constructor(callback) {
                this.callback = callback;
                this.observe = vi.fn();
                this.disconnect = vi.fn();
                lifetime.observers.push(this);
            }
        }
    );
    lifetime.layout.mockImplementation(async () => ({
        positions: structuredClone(positions),
        nodeIds: Object.keys(positions)
    }));
});

afterEach(() => {
    for (const renderer of renderers.splice(0)) {
        if (!renderer.disposed) {
            renderer.dispose();
        }
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('friends network Sigma renderer contract', () => {
    it('clears hover when a refresh removes the person under the pointer', async () => {
        const { renderer, sigma } = createRenderer();
        const settings = createDefaultFriendsNetworkSettings();
        await renderer.update(graph, settings, false);
        sigma.emit('enterNode', { node: 'a' });
        renderer.highlight('a');
        await renderer.update(
            {
                nodes: graph.nodes.filter((node) => node.id !== 'a'),
                links: graph.links.filter((link) => link.source !== 'a' && link.target !== 'a')
            },
            settings,
            false
        );
        expect(renderer.host.title).toBe('');
        expect(nodeDisplay(sigma, 'c').label).toBe('C');
        expect(edgeDisplay(sigma, 'b', 'c').hidden).toBe(false);
    });

    it('refreshes graph and label placement when its container changes size', () => {
        const { sigma } = createRenderer();
        lifetime.observers[0].callback();
        expect(sigma.scheduleRefresh).toHaveBeenCalledOnce();
    });

    it('keeps the camera on refresh, ignores stale results and preserves the latest appearance', async () => {
        const { renderer, sigma } = createRenderer();
        const settings = createDefaultFriendsNetworkSettings();
        await renderer.update(graph, settings, false);
        sigma.getCamera().setState({ x: 0.2, y: 0.7, ratio: 0.4 });
        const camera = sigma.getCamera().getState();
        const obsolete = deferred();
        lifetime.layout.mockReturnValueOnce(obsolete.promise);
        const stale = renderer.update({ nodes: [{ id: 'obsolete' }], links: [] }, settings, true);
        await renderer.update(graph, settings, true);
        obsolete.resolve({ positions: { obsolete: { x: 0, y: 0 } } });
        await stale;
        expect(sigma.graph.hasNode('obsolete')).toBe(false);
        expect(sigma.getCamera().getState()).toEqual(camera);
        expect(sigma.setCustomBBox).toHaveBeenCalledTimes(1);

        const pending = deferred();
        lifetime.layout.mockReturnValueOnce(pending.promise);
        const updating = renderer.update(graph, settings, false);
        renderer.setAppearance({ ...settings, labels: false, showMemberships: false, edgeOpacity: 0 }, true);
        pending.resolve({ positions: structuredClone(positions) });
        await updating;
        expect(sigma.settings.renderLabels).toBe(false);
        expect(sigma.settings.labelColor.color).toBe('#9fb3c4');
        expect(edgeDisplay(sigma, 'a', 'b').hidden).toBe(true);
        sigma.emit('afterRender');
        expect(context.arc).not.toHaveBeenCalled();
        expect(renderer.focus('filtered-out-person')).toBe(false);
    });

    it('cancels a pending layout without replacing the current graph', async () => {
        const { renderer, sigma } = createRenderer();
        await renderer.update(graph, createDefaultFriendsNetworkSettings(), false);
        const pending = deferred();
        lifetime.layout.mockReturnValueOnce(pending.promise);
        const updating = renderer.update(
            { nodes: [{ id: 'obsolete' }], links: [] },
            createDefaultFriendsNetworkSettings(),
            false
        );
        renderer.cancel();
        pending.resolve({ positions: { obsolete: { x: 0, y: 0 } } });
        await updating;
        expect(lifetime.cancel).toHaveBeenCalledOnce();
        expect(sigma.graph.nodes()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('delegates picking to Sigma and preserves selection, opacity and strength colors', async () => {
        const { renderer, sigma, onSelect } = createRenderer();
        const settings = createDefaultFriendsNetworkSettings();
        await renderer.update(graph, settings, false);
        sigma.emit('clickNode', { node: 'a' });
        expect(onSelect).toHaveBeenLastCalledWith('a');
        renderer.highlight('a');
        expect(nodeDisplay(sigma, 'a').forceLabel).toBe(true);
        expect(nodeDisplay(sigma, 'b').label).toBe('B');
        expect(nodeDisplay(sigma, 'c').label).toBeNull();
        expect(edgeDisplay(sigma, 'a', 'b').hidden).toBe(false);
        expect(edgeDisplay(sigma, 'b', 'c').hidden).toBe(true);
        expect(renderer.focus('a')).toBe(true);
        expect(sigma.getCamera().getState().ratio).toBeLessThanOrEqual(0.6);
        const nodeColor = nodeDisplay(sigma, 'a').color;
        renderer.highlight(null);
        renderer.setAppearance({ ...settings, colorByWeight: true, edgeOpacity: 100 }, false);
        const strong = edgeDisplay(sigma, 'a', 'b').color;
        const weak = edgeDisplay(sigma, 'b', 'c').color;
        expect(parseInt(strong.slice(1, 3), 16)).toBeGreaterThan(parseInt(strong.slice(5, 7), 16));
        expect(parseInt(weak.slice(5, 7), 16)).toBeGreaterThan(parseInt(weak.slice(1, 3), 16));
        expect(nodeDisplay(sigma, 'a').color).toBe(nodeColor);
        const strongOpacity = parseInt(edgeDisplay(sigma, 'a', 'b').color.slice(-2), 16);
        renderer.setAppearance({ ...settings, colorByWeight: true, edgeOpacity: 10 }, false);
        expect(parseInt(edgeDisplay(sigma, 'a', 'b').color.slice(-2), 16)).toBeLessThan(strongOpacity);
        sigma.emit('enterNode', { node: 'a' });
        expect(renderer.host.title).toContain('Circle 1: 70%');
        expect(nodeDisplay(sigma, 'c').label).toBeNull();
        sigma.emit('leaveNode');
        expect(renderer.host.title).toBe('');
        sigma.emit('clickStage', { event: { x: 0, y: 0 } });
        expect(onSelect).toHaveBeenLastCalledWith(null);
    });

    it('keeps a dragged person at the pointer while worker frames move unheld neighbors', async () => {
        const { renderer, sigma } = createRenderer();
        lifetime.layout.mockResolvedValueOnce({ positions: structuredClone(positions), nodeIds: ['c', 'a', 'b', 'd'] });
        await renderer.update(graph, createDefaultFriendsNetworkSettings(), false);
        const body = { preventSigmaDefault: vi.fn() };
        sigma.emit('moveBody', body);
        expect(body.preventSigmaDefault).not.toHaveBeenCalled();
        const down = { ...pointerPayload(), node: 'a' };
        sigma.emit('downNode', down);
        sigma.emit('moveBody', body);
        expect(body.preventSigmaDefault).toHaveBeenCalledOnce();
        expect(down.preventSigmaDefault).toHaveBeenCalledOnce();
        expect(sigma.getCamera().disable).toHaveBeenCalledOnce();
        movePointer(502, 402);
        expect(lifetime.drag).not.toHaveBeenCalled();
        movePointer(640, 470);
        expect(lifetime.drag).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'start', group: false, nodes: [{ id: 'a', x: 0, y: 0 }] })
        );
        expect(sigma.graph.getNodeAttributes('a')).toMatchObject({ x: 70, y: -35 });
        lifetime.onProgress({ live: true, positions: new Float64Array([120, 130, -50, -50, 80, 90, 20, 30]) });
        sigma.emit('beforeRender');
        expect(sigma.graph.getNodeAttributes('a')).toMatchObject({ x: 70, y: -35 });
        expect(sigma.graph.getNodeAttributes('c')).toMatchObject({ x: 120, y: -130 });
        expect(sigma.graph.getNodeAttributes('b')).toMatchObject({ x: 80, y: -90 });
        sigma.getCamera().enable.mockClear();
        document.dispatchEvent(new Event('pointerup'));
        expect(lifetime.drag).toHaveBeenLastCalledWith({ phase: 'end' });
        expect(sigma.getCamera().enable).toHaveBeenCalled();
        body.preventSigmaDefault.mockClear();
        sigma.emit('moveBody', body);
        expect(body.preventSigmaDefault).not.toHaveBeenCalled();
    });

    it('applies only the latest worker frame in one partial refresh with coordinate indexation enabled', async () => {
        const { renderer, sigma } = createRenderer();
        await renderer.update(graph, createDefaultFriendsNetworkSettings(), false);
        const nodeEvents = vi.fn();
        sigma.graph.on('nodeAttributesUpdated', nodeEvents);
        sigma.refresh.mockClear();
        sigma.scheduleRefresh.mockClear();
        lifetime.onProgress({ live: true, positions: new Float64Array([10, 20, 30, 40, 50, 60, 70, 80]) });
        lifetime.onProgress({ live: true, positions: new Float64Array([20, 30, 40, 50, 60, 70, 80, 90]) });
        expect(sigma.graph.getNodeAttributes('a')).toMatchObject({ x: 0, y: -0 });
        expect(sigma.refresh).not.toHaveBeenCalled();
        sigma.emit('beforeRender');
        expect(sigma.graph.getNodeAttributes('a')).toMatchObject({ x: 20, y: -30 });
        expect(sigma.graph.getNodeAttributes('c')).toMatchObject({ x: 60, y: -70 });
        expect(nodeEvents).not.toHaveBeenCalled();
        expect(sigma.refresh).toHaveBeenCalledExactlyOnceWith({
            partialGraph: { nodes: ['a', 'b', 'c', 'd'] },
            skipIndexation: false,
            schedule: true
        });
        expect(sigma.scheduleRefresh).not.toHaveBeenCalled();
        sigma.emit('beforeRender');
        expect(sigma.refresh).toHaveBeenCalledOnce();
    });

    it('keeps held coordinates immediate and sends only the latest drag move before rendering or release', async () => {
        const { renderer, sigma } = createRenderer();
        await renderer.update(graph, createDefaultFriendsNetworkSettings(), false);
        sigma.emit('downNode', { ...pointerPayload(), node: 'a' });
        movePointer(640, 470);
        movePointer(660, 490);
        expect(sigma.graph.getNodeAttributes('a')).toMatchObject({ x: 80, y: -45 });
        expect(lifetime.drag.mock.calls.filter(([message]) => message.phase === 'move')).toHaveLength(0);
        sigma.emit('beforeRender');
        expect(lifetime.drag.mock.calls.filter(([message]) => message.phase === 'move')).toEqual([
            [{ phase: 'move', nodes: [{ id: 'a', x: 80, y: 45 }] }]
        ]);
        movePointer(680, 510);
        lifetime.onProgress({ live: true, positions: new Float64Array([0, 0, 30, 40, 50, 60, 70, 80]) });
        document.dispatchEvent(new Event('pointerup'));
        expect(lifetime.drag.mock.calls.slice(-2)).toEqual([
            [{ phase: 'move', nodes: [{ id: 'a', x: 90, y: 55 }] }],
            [{ phase: 'end' }]
        ]);
        sigma.emit('beforeRender');
        expect(sigma.graph.getNodeAttributes('a')).toMatchObject({ x: 90, y: -55 });
        expect(sigma.graph.getNodeAttributes('b')).toMatchObject({ x: 30, y: -40 });
    });

    it('discards a queued worker frame on cancellation and batches hover appearance changes', async () => {
        const { renderer, sigma } = createRenderer();
        await renderer.update(graph, createDefaultFriendsNetworkSettings(), false);
        lifetime.onProgress({ live: true, positions: new Float64Array([10, 20, 30, 40, 50, 60, 70, 80]) });
        renderer.cancel();
        sigma.refresh.mockClear();
        sigma.emit('beforeRender');
        expect(sigma.graph.getNodeAttributes('a')).toMatchObject({ x: 0, y: -0 });
        expect(sigma.refresh).not.toHaveBeenCalled();
        sigma.emit('enterNode', { node: 'a' });
        sigma.emit('leaveNode');
        sigma.emit('enterNode', { node: 'b' });
        expect(sigma.refresh).not.toHaveBeenCalled();
        sigma.emit('beforeRender');
        expect(sigma.refresh).toHaveBeenCalledExactlyOnceWith({ schedule: true });
        expect(nodeDisplay(sigma, 'b').forceLabel).toBe(true);
    });

    it('keeps the final pointer position when a queued frame predates drag activation and release', async () => {
        const { renderer, sigma } = createRenderer();
        await renderer.update(graph, createDefaultFriendsNetworkSettings(), false);
        sigma.emit('downNode', { ...pointerPayload(), node: 'a' });
        lifetime.onProgress({ live: true, positions: new Float64Array([-10, -20, 30, 40, 50, 60, 70, 80]) });
        movePointer(640, 470);
        document.dispatchEvent(new Event('pointerup'));
        sigma.emit('beforeRender');
        expect(sigma.graph.getNodeAttributes('a')).toMatchObject({ x: 70, y: -35 });
        expect(sigma.graph.getNodeAttributes('b')).toMatchObject({ x: 30, y: -40 });
        lifetime.onProgress({ live: true, positions: new Float64Array([75, 40, 35, 45, 55, 65, 75, 85]) });
        sigma.emit('beforeRender');
        expect(sigma.graph.getNodeAttributes('a')).toMatchObject({ x: 75, y: -40 });
        expect(renderer.positions.a).toEqual({ x: 75, y: 40 });
    });

    it('suppresses selection clicks after a pull and accepts the next ordinary click', async () => {
        const { renderer, sigma, onSelect } = createRenderer();
        await renderer.update(graph, createDefaultFriendsNetworkSettings(), false);
        sigma.emit('downNode', { ...pointerPayload(), node: 'a' });
        movePointer(640, 470);
        document.dispatchEvent(new Event('pointerup'));
        sigma.emit('clickNode', { node: 'a' });
        sigma.emit('clickStage', { event: { x: 0, y: 0 } });
        expect(onSelect).not.toHaveBeenCalled();
        sigma.emit('downStage', pointerPayload(0, 0));
        sigma.emit('clickStage', { event: { x: 0, y: 0 } });
        expect(onSelect).toHaveBeenLastCalledWith(null);
        sigma.emit('downNode', { ...pointerPayload(700, 600), node: 'b' });
        movePointer(702, 602);
        document.dispatchEvent(new Event('pointerup'));
        sigma.emit('clickNode', { node: 'b' });
        expect(onSelect).toHaveBeenLastCalledWith('b');
    });

    it('uses Shift to pull the whole circle and holds all of its people against worker frames', async () => {
        const { renderer, sigma } = createRenderer();
        await renderer.update(graph, createDefaultFriendsNetworkSettings(), false);
        sigma.emit('downNode', { ...pointerPayload(500, 400, { shiftKey: true }), node: 'a' });
        movePointer(640, 470);
        const start = lifetime.drag.mock.calls.find(([message]) => message.phase === 'start')[0];
        expect(start.group).toBe(true);
        expect(start.nodes.map((node) => node.id)).toEqual(['a', 'b']);
        expect(sigma.graph.getNodeAttributes('a')).toMatchObject({ x: 70, y: -35 });
        expect(sigma.graph.getNodeAttributes('b')).toMatchObject({ x: 170, y: -135 });
        lifetime.onProgress({ live: true, positions: new Float64Array([-10, -10, -20, -20, 120, 130, 20, 30]) });
        sigma.emit('beforeRender');
        expect(sigma.graph.getNodeAttributes('a')).toMatchObject({ x: 70, y: -35 });
        expect(sigma.graph.getNodeAttributes('b')).toMatchObject({ x: 170, y: -135 });
        expect(sigma.graph.getNodeAttributes('c')).toMatchObject({ x: 120, y: -130 });
    });

    it.each(['downStage', 'downNode'])('grabs a circle label before a person for %s picking', async (eventName) => {
        const { renderer, sigma, onSelect } = createRenderer();
        const nodes = Array.from({ length: 6 }, (_, index) => ({ id: `person-${index}`, community: 0 }));
        const links = nodes.slice(1).map((node) => ({ source: nodes[0].id, target: node.id, weight: 10 }));
        lifetime.layout.mockResolvedValueOnce({
            positions: Object.fromEntries(nodes.map((node) => [node.id, { x: 50, y: 100 }]))
        });
        await renderer.update({ nodes, links }, createDefaultFriendsNetworkSettings(), false);
        sigma.emit('afterRender');
        const label = context.fillText.mock.calls.find(([text]) => text.startsWith('Circle 1'));
        expect(label).toBeDefined();
        const [, x, baseline] = label;
        sigma.emit('clickStage', { event: { x, y: baseline - 4 } });
        expect(onSelect).not.toHaveBeenCalled();
        const down = { ...pointerPayload(x, baseline - 4), node: nodes[0].id };
        sigma.emit(eventName, down);
        movePointer(x + 140, baseline - 4 + 70);
        const start = lifetime.drag.mock.calls.find(([message]) => message.phase === 'start')[0];
        expect(start.group).toBe(true);
        expect(start.nodes).toHaveLength(6);
        for (const node of nodes) {
            expect(sigma.graph.getNodeAttributes(node.id)).toMatchObject({ x: 120, y: -135 });
        }
        sigma.emit('clickStage', { event: { x, y: baseline - 4 } });
        expect(onSelect).not.toHaveBeenCalled();
    });

    it.each(['pointercancel', 'blur'])('releases a live drag on %s', async (eventName) => {
        const { renderer, sigma } = createRenderer();
        await renderer.update(graph, createDefaultFriendsNetworkSettings(), false);
        sigma.emit('downNode', { ...pointerPayload(), node: 'a' });
        movePointer(640, 470);
        sigma.getCamera().enable.mockClear();
        const target = eventName === 'blur' ? window : document;
        target.dispatchEvent(new Event(eventName));
        expect(lifetime.drag).toHaveBeenLastCalledWith({ phase: 'end' });
        expect(sigma.getCamera().enable).toHaveBeenCalled();
        lifetime.drag.mockClear();
        movePointer(700, 500);
        expect(lifetime.drag).not.toHaveBeenCalled();
    });

    it('releases the worker, Sigma, overlay and document listeners on disposal', async () => {
        const { renderer, sigma, container } = createRenderer();
        await renderer.update(graph, createDefaultFriendsNetworkSettings(), false);
        const pending = deferred();
        lifetime.layout.mockReturnValueOnce(pending.promise);
        const updating = renderer.update(
            { nodes: [{ id: 'obsolete' }], links: [] },
            createDefaultFriendsNetworkSettings(),
            false
        );
        sigma.emit('downNode', { ...pointerPayload(), node: 'a' });
        movePointer(640, 470);
        renderer.dispose();
        expect(lifetime.drag).toHaveBeenLastCalledWith({ phase: 'end' });
        expect(lifetime.dispose).toHaveBeenCalledOnce();
        expect(sigma.kill).toHaveBeenCalledOnce();
        expect(lifetime.observers[0].disconnect).toHaveBeenCalledOnce();
        expect(container.childElementCount).toBe(0);
        lifetime.drag.mockClear();
        sigma.getCamera().enable.mockClear();
        sigma.scheduleRefresh.mockClear();
        pending.resolve({ positions: { obsolete: { x: 0, y: 0 } } });
        await updating;
        expect(sigma.graph.hasNode('obsolete')).toBe(false);
        movePointer(700, 500);
        document.dispatchEvent(new Event('pointerup'));
        document.dispatchEvent(new Event('pointercancel'));
        window.dispatchEvent(new Event('blur'));
        lifetime.onProgress({ live: true, positions: new Float64Array(8) });
        expect(lifetime.drag).not.toHaveBeenCalled();
        expect(sigma.getCamera().enable).not.toHaveBeenCalled();
        expect(sigma.scheduleRefresh).not.toHaveBeenCalled();
    });
});
