import { describe, expect, it } from 'vitest';
import { createFriendsNetworkDragController } from '../friendsNetworkInteraction';
import {
    createFriendsNetworkLayout,
    finishFriendsNetworkLayout,
    stepFriendsNetworkLayout
} from '../friendsNetworkLayout';

function fixture() {
    const state = createFriendsNetworkLayout({
        nodes: [
            { id: 'a', community: 0 },
            { id: 'b', community: 1 }
        ],
        links: [{ source: 'a', target: 'b', weight: 100, strength: 1 }],
        settings: { layoutIterations: 400 }
    });
    while (!stepFriendsNetworkLayout(state)) {
        // Start from a settled graph, as the desktop renderer does.
    }
    finishFriendsNetworkLayout(state);
    const scheduled = new Map();
    const frames = [];
    let nextId = 0;
    const controller = createFriendsNetworkDragController((frame) => frames.push(frame), {
        scheduleFrame: (callback) => {
            scheduled.set(++nextId, callback);
            return nextId;
        },
        clearFrame: (id) => scheduled.delete(id)
    });
    controller.attach(state, 7);
    const tick = () => {
        const [id, callback] = scheduled.entries().next().value;
        scheduled.delete(id);
        callback();
    };
    return { state, controller, scheduled, frames, tick };
}

describe('live friends network pulling', () => {
    it('moves connected people during a held drag, then releases pins and stops after settling', () => {
        const { state, controller, scheduled, frames, tick } = fixture();
        const first = state.nodes.find((node) => node.id === 'a');
        const neighbor = state.nodes.find((node) => node.id === 'b');
        const before = { x: neighbor.x, y: neighbor.y };
        const held = { id: 'a', x: first.x + 180, y: first.y + 100 };
        controller.handle({ requestId: 7, phase: 'start', nodes: [held] });
        for (let frame = 0; frame < 12; frame++) tick();
        expect(Math.hypot(neighbor.x - before.x, neighbor.y - before.y)).toBeGreaterThan(1);
        expect(first.x).toBe(held.x);
        expect(first.y).toBe(held.y);
        expect(frames[0].positions).toBeInstanceOf(Float64Array);
        expect(frames[0].positions).toHaveLength(4);
        controller.handle({ requestId: 7, phase: 'end' });
        expect(first.fx).toBeNull();
        expect(first.fy).toBeNull();
        for (let frame = 0; scheduled.size && frame < 500; frame++) tick();
        expect(scheduled.size).toBe(0);
    });

    it('moves a circle anchor with its group and ignores stale drags after cancellation', () => {
        const { state, controller, scheduled } = fixture();
        const first = state.nodes.find((node) => node.id === 'a');
        const initial = { x: first.x, y: first.y, targetX: first.targetX, targetY: first.targetY };
        controller.handle({ requestId: 7, phase: 'start', group: true, nodes: [{ id: 'a', x: first.x, y: first.y }] });
        controller.handle({ requestId: 7, phase: 'move', nodes: [{ id: 'a', x: initial.x + 120, y: initial.y - 40 }] });
        expect(first.targetX).toBeCloseTo(initial.targetX + 120);
        expect(first.targetY).toBeCloseTo(initial.targetY - 40);
        controller.cancel();
        expect(scheduled.size).toBe(0);
        expect(first.fx).toBeNull();
        controller.handle({ requestId: 7, phase: 'start', nodes: [{ id: 'a', x: 999, y: 999 }] });
        expect(first.x).not.toBe(999);
        expect(scheduled.size).toBe(0);
    });
});
