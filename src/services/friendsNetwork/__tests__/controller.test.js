import { describe, expect, it, vi } from 'vitest';
import { createFriendsNetworkWorkerController } from '../controller';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

async function load(controller, id = 1) {
    await controller.handle({ id, type: 'beginHistory' });
    await controller.handle({ id: id + 1, type: 'finishHistory' });
}

describe('friends network worker controller lifetime', () => {
    it.each(['reconstruction', 'analysis'])('retains the last good data when rebuild %s fails', async (failure) => {
        const send = vi.fn();
        const oldData = { accounts: [], version: 'old' };
        const newData = { accounts: [], version: 'new' };
        const createHistoryBuilder = vi
            .fn()
            .mockReturnValueOnce({ finish: () => oldData })
            .mockReturnValueOnce({
                finish: () => {
                    if (failure === 'reconstruction') throw new Error('Rebuild failed');
                    return newData;
                }
            });
        const createAnalysis = vi.fn((dataset) => {
            if (dataset.version === 'new') throw new Error('Rebuild failed');
            return {
                graph: async () => ({ nodes: [{ id: dataset.version }] }),
                people: () => ({ users: [{ id: dataset.version }] })
            };
        });
        const controller = createFriendsNetworkWorkerController(send, { createHistoryBuilder, createAnalysis });
        await load(controller);
        await load(controller, 3);
        expect(send).toHaveBeenCalledWith({ id: 4, type: 'result', error: 'Rebuild failed' });
        await controller.handle({ id: 5, type: 'discardHistory' });
        await controller.handle({ id: 6, type: 'graph' });
        await controller.handle({ id: 7, type: 'people' });
        expect(send).toHaveBeenCalledWith({ id: 6, type: 'result', result: { nodes: [{ id: 'old' }] } });
        expect(send).toHaveBeenCalledWith({ id: 7, type: 'result', result: { users: [{ id: 'old' }] } });
    });

    it('serializes graph computations, cancels stale work, and suppresses its progress', async () => {
        const first = deferred();
        const send = vi.fn();
        let firstCallbacks;
        const graph = vi
            .fn()
            .mockImplementationOnce((_settings, callbacks) => {
                firstCallbacks = callbacks;
                return first.promise;
            })
            .mockImplementationOnce(async (_settings, callbacks) => {
                callbacks.onProgress({ stage: 'communities', progress: 0.9 });
                return { nodes: [{ id: 'new' }] };
            });
        const controller = createFriendsNetworkWorkerController(send, {
            createHistoryBuilder: () => ({ finish: () => ({ accounts: [] }) }),
            createAnalysis: () => ({ graph })
        });
        await load(controller);
        const old = controller.handle({ id: 3, type: 'graph', payload: { top_k: 1 } });
        await Promise.resolve();
        const latest = controller.handle({ id: 4, type: 'graph', payload: { top_k: 2 } });
        await Promise.resolve();
        expect(graph).toHaveBeenCalledTimes(1);
        expect(firstCallbacks.isCancelled()).toBe(true);
        firstCallbacks.onProgress({ stage: 'scoring', progress: 0.2 });
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ id: 3, type: 'progress' }));
        first.resolve({ nodes: [{ id: 'old' }] });
        await Promise.all([old, latest]);
        expect(graph).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenCalledWith({ id: 3, type: 'result', result: { cancelled: true } });
        expect(send).toHaveBeenCalledWith({ id: 4, type: 'result', result: { nodes: [{ id: 'new' }] } });
        expect(send).toHaveBeenCalledWith({ id: 4, type: 'progress', status: { stage: 'communities', progress: 0.9 } });
    });

    it('releases the graph queue after a failed computation', async () => {
        const send = vi.fn();
        const graph = vi.fn().mockRejectedValueOnce(new Error('Analysis failed')).mockResolvedValueOnce({ nodes: [] });
        const controller = createFriendsNetworkWorkerController(send, {
            createHistoryBuilder: () => ({ finish: () => ({ accounts: [] }) }),
            createAnalysis: () => ({ graph })
        });
        await load(controller);
        await controller.handle({ id: 3, type: 'graph' });
        await controller.handle({ id: 4, type: 'graph' });
        expect(send).toHaveBeenCalledWith({ id: 3, type: 'result', error: 'Analysis failed' });
        expect(send).toHaveBeenCalledWith({ id: 4, type: 'result', result: { nodes: [] } });
    });
});
