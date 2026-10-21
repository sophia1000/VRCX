import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../database/friendsNetwork', () => ({ loadFriendsNetworkHistory: vi.fn() }));

import { createFriendsNetworkService } from '../service';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

/** A worker transport stub. Analysis outcomes are covered in separate tests. */
class TestWorker extends EventTarget {
    messages = [];
    heldGraphs = [];
    holdGraphs = false;
    terminate = vi.fn();

    postMessage(message) {
        this.messages.push(message);
        if (message.type === 'cancel') return;
        if (message.type === 'graph' && this.holdGraphs) {
            this.heldGraphs.push(message);
            return;
        }
        queueMicrotask(() => this.reply(message.id, this.result(message.type)));
    }

    result(type) {
        if (type === 'finishHistory') return { accounts: [{ id: 'account-one' }] };
        if (type === 'graph') return { nodes: [{ id: 'person-one' }], links: [] };
        if (type === 'people') return { users: [{ id: 'person-one', name: 'Person one' }] };
        return {};
    }

    reply(id, result) {
        this.dispatchEvent(new MessageEvent('message', { data: { id, type: 'result', result } }));
    }

    progress(id, status) {
        this.dispatchEvent(new MessageEvent('message', { data: { id, type: 'progress', status } }));
    }
}

describe('friends network session cache', () => {
    let worker;
    let loadHistory;
    let createWorker;
    let service;

    beforeEach(() => {
        worker = new TestWorker();
        createWorker = vi.fn(() => worker);
        loadHistory = vi.fn(async ({ onBatch, onProgress }) => {
            onProgress({ progress: 0.5 });
            await onBatch({ table: 'gamelog_location', rows: [] });
        });
        service = createFriendsNetworkService({ createWorker, loadHistory });
    });

    it('does no work before the first graph visit', async () => {
        expect(createWorker).not.toHaveBeenCalled();
        expect(loadHistory).not.toHaveBeenCalled();
        expect(await service.people()).toEqual({ users: [] });
        service.cancel();
        expect(createWorker).not.toHaveBeenCalled();
        expect(service.status().busy).toBe(false);
    });

    it('reuses one in-memory import across settings and later page visits', async () => {
        const first = await service.graph({ top_k: 12 });
        service.cancel();
        const second = await service.graph({ top_k: 8 });
        expect(first.nodes).toEqual(second.nodes);
        expect(createWorker).toHaveBeenCalledTimes(1);
        expect(loadHistory).toHaveBeenCalledTimes(1);
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(await service.people()).toEqual({ users: [{ id: 'person-one', name: 'Person one' }] });
        expect(service.status()).toMatchObject({ busy: false, stage: 'ready', progress: 1 });
    });

    it('starts a fresh import in a new application session', async () => {
        await service.graph({});
        service.dispose();
        const nextSession = createFriendsNetworkService({ createWorker: () => new TestWorker(), loadHistory });
        await nextSession.graph({});
        expect(loadHistory).toHaveBeenCalledTimes(2);
        nextSession.dispose();
    });

    it('shares an unfinished first import when settings change or the page closes', async () => {
        const reading = deferred();
        let reportReading;
        loadHistory.mockImplementationOnce(({ onProgress }) => {
            reportReading = onProgress;
            return reading.promise;
        });
        const first = service.graph({ top_k: 12 });
        for (let turn = 0; turn < 4; turn++) await Promise.resolve();
        reportReading({ progress: 0.5 });
        service.cancel();
        const next = service.graph({ top_k: 8 });
        expect(service.status()).toMatchObject({ stage: 'reading', progress: 0.2 });
        reading.resolve();
        expect(await first).toEqual({ cancelled: true });
        expect((await next).nodes).toHaveLength(1);
        expect(loadHistory).toHaveBeenCalledTimes(1);
        expect(worker.terminate).not.toHaveBeenCalled();
    });

    it('finishes the shared import quietly after the page closes', async () => {
        const reading = deferred();
        loadHistory.mockImplementationOnce(() => reading.promise);
        const first = service.graph({});
        for (let turn = 0; turn < 4; turn++) await Promise.resolve();
        service.cancel();
        expect(service.status().busy).toBe(true);
        reading.resolve();
        expect(await first).toEqual({ cancelled: true });
        expect(service.status().busy).toBe(false);
        expect(loadHistory).toHaveBeenCalledTimes(1);
        expect((await service.graph({})).nodes).toHaveLength(1);
        expect(loadHistory).toHaveBeenCalledTimes(1);
    });

    it('aborts only its own import on disposal and ignores late reader callbacks', async () => {
        const reading = deferred();
        let callbacks;
        loadHistory.mockImplementationOnce((options) => {
            callbacks = options;
            return reading.promise;
        });
        const first = service.graph({});
        for (let turn = 0; turn < 4; turn++) await Promise.resolve();
        service.cancel();
        expect(callbacks.signal.aborted).toBe(false);
        service.dispose();
        expect(callbacks.signal.aborted).toBe(true);
        callbacks.onProgress({ progress: 0.9 });
        reading.resolve();
        expect(await first).toEqual({ cancelled: true });
        expect(service.status().busy).toBe(false);
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(worker.messages.some((message) => message.type === 'finishHistory')).toBe(false);
        await expect(service.graph({})).resolves.toEqual({ cancelled: true });
        expect(service.status().busy).toBe(false);
    });

    it('ignores errors from a retired worker after a replacement is running', async () => {
        await service.graph({});
        const retired = worker;
        retired.dispatchEvent(new ErrorEvent('error', { message: 'First worker failed.' }));
        worker = new TestWorker();
        await service.graph({});
        retired.dispatchEvent(new ErrorEvent('error', { message: 'Late error.' }));
        retired.dispatchEvent(new MessageEvent('messageerror'));
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(service.status()).toMatchObject({ busy: false, stage: 'ready' });
        expect((await service.graph({})).nodes).toHaveLength(1);
        expect(createWorker).toHaveBeenCalledTimes(2);
    });

    it('reports reading and analysis progress and ignores stale graph updates', async () => {
        let reportReading;
        const reading = deferred();
        loadHistory.mockImplementationOnce(({ onProgress }) => {
            reportReading = onProgress;
            return reading.promise;
        });
        const first = service.graph({});
        // Allow the acknowledged beginHistory message to reach the reader.
        for (let turn = 0; turn < 4; turn++) await Promise.resolve();
        reportReading({ progress: 0.5 });
        expect(service.status()).toMatchObject({ busy: true, stage: 'reading', progress: 0.2 });
        reading.resolve();
        await first;

        worker.holdGraphs = true;
        const old = service.graph({ top_k: 1 });
        for (let turn = 0; turn < 4; turn++) await Promise.resolve();
        const oldRequest = worker.heldGraphs[0];
        service.cancel();
        const latest = service.graph({ top_k: 2 });
        for (let turn = 0; turn < 4; turn++) await Promise.resolve();
        const latestRequest = worker.heldGraphs[1];
        worker.progress(latestRequest.id, { stage: 'communities', progress: 0.8 });
        worker.progress(oldRequest.id, { stage: 'scoring', progress: 0.1 });
        expect(service.status()).toMatchObject({ stage: 'communities', progress: 0.8 });
        worker.reply(oldRequest.id, { nodes: [{ id: 'stale' }] });
        worker.reply(latestRequest.id, { nodes: [{ id: 'current' }] });
        expect(await old).toEqual({ cancelled: true });
        expect((await latest).nodes[0].id).toBe('current');
    });

    it('only rereads history after an explicit rebuild', async () => {
        await service.graph({});
        await service.graph({ account_ids: ['account-one'] });
        expect(loadHistory).toHaveBeenCalledTimes(1);
        await service.graph({}, true);
        expect(loadHistory).toHaveBeenCalledTimes(2);
    });

    it('releases a failed import and retries on the next visit', async () => {
        loadHistory.mockRejectedValueOnce(new Error('History read failed.'));
        await expect(service.graph({})).rejects.toThrow('History read failed.');
        expect(service.status().busy).toBe(false);
        expect(worker.messages.some((message) => message.type === 'discardHistory')).toBe(true);
        expect((await service.graph({})).nodes).toHaveLength(1);
        expect(loadHistory).toHaveBeenCalledTimes(2);
    });

    it('recovers a worker failure and releases its session cache on disposal', async () => {
        worker.holdGraphs = true;
        const failed = service.graph({});
        for (let turn = 0; turn < 12; turn++) await Promise.resolve();
        worker.dispatchEvent(new ErrorEvent('error', { message: 'Worker failed.' }));
        await expect(failed).rejects.toThrow('Worker failed.');
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        worker = new TestWorker();
        expect((await service.graph({})).nodes).toHaveLength(1);
        expect(loadHistory).toHaveBeenCalledTimes(2);
        service.dispose();
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        await expect(service.graph({})).resolves.toEqual({ cancelled: true });
    });
});
