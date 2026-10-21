import { afterEach, describe, expect, it, vi } from 'vitest';

const lifetime = vi.hoisted(() => ({ dispose: vi.fn(), cancel: vi.fn(), layout: vi.fn(), drag: vi.fn() }));
vi.mock('../friendsNetworkLayoutWorker.js?worker&inline', () => ({ default: class {} }));
vi.mock('../friendsNetworkLayout', async (original) => ({
    ...(await original()),
    createFriendsNetworkLayoutClient: () => ({
        layout: lifetime.layout,
        drag: lifetime.drag,
        cancel: lifetime.cancel,
        dispose: lifetime.dispose
    })
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
        { id: 'a', community: 0 },
        { id: 'b', community: 1 }
    ],
    links: [{ source: 'a', target: 'b', weight: 2 }]
};
const positions = { a: { x: 0, y: 0 }, b: { x: 100, y: 100 } };

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('friends network canvas lifetime', () => {
    it('keeps the camera on refresh, ignores stale layouts, and releases the worker and canvas', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({});
        vi.stubGlobal(
            'requestAnimationFrame',
            vi.fn(() => 1)
        );
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const container = document.createElement('div');
        const renderer = new FriendsNetworkRenderer(container, vi.fn());
        const settings = createDefaultFriendsNetworkSettings();
        lifetime.layout.mockResolvedValue({ positions });
        await renderer.update(graph, settings, false);
        renderer.transform = { x: 40, y: 60, k: 2 };
        const obsolete = deferred();
        lifetime.layout.mockReturnValueOnce(obsolete.promise).mockResolvedValueOnce({ positions });
        const stale = renderer.update({ nodes: [{ id: 'obsolete' }], links: [] }, settings, true);
        await renderer.update(graph, settings, true);
        obsolete.resolve({ positions: { obsolete: { x: 0, y: 0 } } });
        await stale;
        expect(renderer.nodesById.has('obsolete')).toBe(false);
        expect(renderer.transform).toEqual({ x: 40, y: 60, k: 2 });
        expect(renderer.nodesById.get('b').community).toBe(1);
        const pendingAppearance = deferred();
        lifetime.layout.mockReturnValueOnce(pendingAppearance.promise);
        const updating = renderer.update(graph, settings, false);
        renderer.setAppearance({ ...settings, showMemberships: false }, true);
        pendingAppearance.resolve({ positions });
        await updating;
        expect(renderer.settings.showMemberships).toBe(false);
        expect(renderer.dark).toBe(true);
        expect(lifetime.layout).toHaveBeenCalledTimes(4);
        expect(renderer.focus('filtered-out-person')).toBe(false);
        renderer.dispose();
        expect(lifetime.dispose).toHaveBeenCalledOnce();
        expect(container.querySelector('canvas')).toBeNull();
    });
    it('forwards circle drags, keeps held nodes at the pointer and releases on capture loss', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: () => ({ width: 40 }) });
        vi.stubGlobal(
            'requestAnimationFrame',
            vi.fn(() => 1)
        );
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const renderer = new FriendsNetworkRenderer(document.createElement('div'), vi.fn());
        renderer.canvas.setPointerCapture = vi.fn();
        renderer.canvas.hasPointerCapture = vi.fn(() => false);
        lifetime.layout.mockResolvedValue({ positions });
        await renderer.update(graph, createDefaultFriendsNetworkSettings(), false);
        renderer.transform = { x: 20, y: 20, k: 1 };
        renderer.canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 20, clientY: 20, shiftKey: true }));
        renderer.canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 90, clientY: 55 }));
        expect(lifetime.drag).toHaveBeenCalledWith(expect.objectContaining({ phase: 'start', group: true }));
        expect(renderer.nodesById.get('a')).toMatchObject({ x: 70, y: 35 });
        renderer.receiveLayoutFrame({ live: true, positions: new Float64Array([-50, -50, 120, 130]) });
        expect(renderer.nodesById.get('a')).toMatchObject({ x: 70, y: 35 });
        expect(renderer.nodesById.get('b')).toMatchObject({ x: 120, y: 130 });
        renderer.canvas.dispatchEvent(new Event('lostpointercapture'));
        expect(lifetime.drag).toHaveBeenLastCalledWith({ phase: 'end' });
        expect(renderer.drag).toBeNull();
        renderer.dispose();
    });
    it('grabs the whole circle when its label overlaps a person', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: () => ({ width: 40 }) });
        vi.stubGlobal(
            'requestAnimationFrame',
            vi.fn(() => 1)
        );
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const renderer = new FriendsNetworkRenderer(document.createElement('div'), vi.fn());
        renderer.canvas.setPointerCapture = vi.fn();
        renderer.canvas.hasPointerCapture = vi.fn(() => false);
        const nodes = Array.from({ length: 6 }, (_, index) => ({ id: `person-${index}`, community: 0 }));
        const links = nodes.slice(1).map((node) => ({ source: nodes[0].id, target: node.id, weight: 10 }));
        lifetime.layout.mockResolvedValue({
            positions: Object.fromEntries(nodes.map((node) => [node.id, { x: 0, y: 0 }]))
        });
        await renderer.update({ nodes, links }, createDefaultFriendsNetworkSettings(), false);
        renderer.transform = { x: 20, y: 20, k: 1 };
        Object.assign(renderer.groups[0], { x: 0, y: 56, radius: 48 });
        renderer.canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 20, clientY: 20 }));
        renderer.canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 90, clientY: 55 }));
        const start = lifetime.drag.mock.calls.find(([message]) => message.phase === 'start')[0];
        expect(start.group).toBe(true);
        expect(start.nodes).toHaveLength(6);
        renderer.dispose();
        expect(lifetime.drag).toHaveBeenLastCalledWith({ phase: 'end' });
    });
});
