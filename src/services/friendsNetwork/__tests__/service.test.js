import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../database/friendsNetwork', () => ({ loadFriendsNetworkHistory: vi.fn() }));

import { createFriendsNetworkService } from '../service';

const scope = { current_user_id: 'account-one', friend_ids: ['person-one'] };

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
    heldBatches = [];
    holdBatches = false;
    outstandingBatches = new Set();
    maximumPendingBatches = 0;
    terminate = vi.fn();

    postMessage(message) {
        this.messages.push(message);
        if (message.type === 'cancel') return;
        if (message.type === 'historyBatch') {
            this.outstandingBatches.add(message.id);
            this.maximumPendingBatches = Math.max(this.maximumPendingBatches, this.outstandingBatches.size);
            if (this.holdBatches) {
                this.heldBatches.push(message);
                return;
            }
        }
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
        this.outstandingBatches.delete(id);
        this.dispatchEvent(new MessageEvent('message', { data: { id, type: 'result', result } }));
    }

    fail(id, error) {
        this.outstandingBatches.delete(id);
        this.dispatchEvent(new MessageEvent('message', { data: { id, type: 'result', error } }));
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

    it('overlaps sequential reads with at most two batches and waits for the final acknowledgement', async () => {
        worker.holdBatches = true;
        const batches = Array.from({ length: 4 }, (_, index) => ({
            table: 'gamelog_location',
            columns: index === 0 ? ['id'] : undefined,
            rows: [[index]]
        }));
        let reads = 0;
        loadHistory.mockImplementationOnce(async ({ onBatch }) => {
            for (const batch of batches) {
                reads++;
                await onBatch(batch);
            }
        });
        const graph = service.graph({});
        await vi.waitFor(() => expect(worker.heldBatches).toHaveLength(2));
        expect(reads).toBe(2);
        expect(worker.messages.some((message) => message.type === 'finishHistory')).toBe(false);
        worker.reply(worker.heldBatches[0].id, {});
        await vi.waitFor(() => expect(worker.heldBatches).toHaveLength(3));
        expect(reads).toBe(3);
        worker.reply(worker.heldBatches[1].id, {});
        await vi.waitFor(() => expect(worker.heldBatches).toHaveLength(4));
        worker.reply(worker.heldBatches[2].id, {});
        await Promise.resolve();
        expect(worker.messages.some((message) => message.type === 'finishHistory')).toBe(false);
        expect(worker.maximumPendingBatches).toBe(2);
        expect(worker.heldBatches.map((message) => message.payload)).toEqual(batches);
        worker.reply(worker.heldBatches[3].id, {});
        expect((await graph).nodes).toHaveLength(1);
        expect(worker.messages.filter((message) => message.type === 'finishHistory')).toHaveLength(1);
    });

    it('discards a failed batch before reconstruction and can retry the import', async () => {
        worker.holdBatches = true;
        const graph = service.graph({});
        const failure = expect(graph).rejects.toThrow('Batch failed');
        await vi.waitFor(() => expect(worker.heldBatches).toHaveLength(1));
        worker.fail(worker.heldBatches[0].id, 'Batch failed');
        await failure;
        expect(worker.messages.some((message) => message.type === 'finishHistory')).toBe(false);
        expect(worker.messages.some((message) => message.type === 'discardHistory')).toBe(true);
        worker.holdBatches = false;
        expect((await service.graph({})).nodes).toHaveLength(1);
    });

    it('keeps the completed cache after a rebuild batch fails', async () => {
        await service.graph({});
        worker.holdBatches = true;
        const rebuild = service.graph({}, true);
        const failure = expect(rebuild).rejects.toThrow('Rebuild batch failed');
        await vi.waitFor(() => expect(worker.heldBatches).toHaveLength(1));
        worker.fail(worker.heldBatches[0].id, 'Rebuild batch failed');
        await failure;
        expect((await service.graph({})).nodes).toHaveLength(1);
        expect(loadHistory).toHaveBeenCalledTimes(2);
        expect(worker.messages.filter((message) => message.type === 'finishHistory')).toHaveLength(1);
        expect((await service.people(scope)).users).toHaveLength(1);
    });

    it('observes pending acknowledgements when a native read fails', async () => {
        worker.holdBatches = true;
        loadHistory.mockImplementationOnce(async ({ onBatch }) => {
            await onBatch({ table: 'gamelog_location', rows: [] });
            throw new Error('Native read failed');
        });
        await expect(service.graph({})).rejects.toThrow('Native read failed');
        expect(worker.messages.some((message) => message.type === 'finishHistory')).toBe(false);
        // This late rejection must already have an observer, even though the
        // failed reader never reached its final acknowledgement barrier.
        worker.fail(worker.heldBatches[0].id, 'Late batch failure');
        await Promise.resolve();
        expect(service.status().busy).toBe(false);
    });

    it('rejects every queued acknowledgement on disposal without publishing partial data', async () => {
        worker.holdBatches = true;
        loadHistory.mockImplementationOnce(async ({ onBatch }) => {
            await onBatch({ table: 'gamelog_location', rows: [[1]] });
            await onBatch({ table: 'gamelog_location', rows: [[2]] });
        });
        const graph = service.graph({});
        await vi.waitFor(() => expect(worker.heldBatches).toHaveLength(2));
        service.dispose();
        expect(await graph).toEqual({ cancelled: true });
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(worker.messages.some((message) => message.type === 'finishHistory')).toBe(false);
        expect(service.status().busy).toBe(false);
    });

    it('does no work before the first graph visit', async () => {
        expect(createWorker).not.toHaveBeenCalled();
        expect(loadHistory).not.toHaveBeenCalled();
        expect(await service.people()).toEqual({ users: [] });
        service.cancel();
        expect(createWorker).not.toHaveBeenCalled();
        expect(service.status().busy).toBe(false);
    });

    it('offers every live friend for search before history is loaded without starting an import', async () => {
        expect(await service.people(scope)).toEqual({
            users: [{ id: 'person-one', name: 'person-one', is_friend: true, join_count: 0 }]
        });
        expect(createWorker).not.toHaveBeenCalled();
        expect(loadHistory).not.toHaveBeenCalled();
    });

    it('reuses one in-memory import across settings and later page visits', async () => {
        const first = await service.graph({ top_k: 12 });
        service.cancel();
        const second = await service.graph({ top_k: 8 });
        expect(first.nodes).toEqual(second.nodes);
        expect(createWorker).toHaveBeenCalledTimes(1);
        expect(loadHistory).toHaveBeenCalledTimes(1);
        expect(loadHistory).toHaveBeenCalledWith(expect.objectContaining({ rowFormat: 'arrays' }));
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(await service.people(scope)).toEqual({ users: [{ id: 'person-one', name: 'Person one' }] });
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
        await service.graph(scope);
        await service.graph({ current_user_id: 'another-account', friend_ids: ['another-friend'] });
        expect(loadHistory).toHaveBeenCalledTimes(1);
        await service.graph({}, true);
        expect(loadHistory).toHaveBeenCalledTimes(2);
    });

    it('forwards independent live scopes for graphs and people without rereading shared history', async () => {
        await service.graph({ ...scope, world_filter: 'one-world' });
        const searchScope = { current_user_id: 'another-account', friend_ids: ['new-friend', 'person-one'] };
        await service.people(searchScope);
        expect(worker.messages.find((message) => message.type === 'graph').payload).toMatchObject(scope);
        expect(worker.messages.find((message) => message.type === 'people').payload).toEqual(searchScope);
        const requests = worker.messages.length;
        expect(await service.people({ ...scope, friend_ids: [] })).toEqual({ users: [] });
        expect(await service.people()).toEqual({ users: [] });
        expect(worker.messages).toHaveLength(requests);
        expect(loadHistory).toHaveBeenCalledTimes(1);
    });

    it('captures friend IDs before an asynchronous import so later caller mutations do not change a request', async () => {
        const reading = deferred();
        loadHistory.mockImplementationOnce(() => reading.promise);
        const options = { ...scope, friend_ids: ['person-one'] };
        const first = service.graph(options);
        options.friend_ids.push('later-friend');
        reading.resolve();
        await first;
        expect(worker.messages.find((message) => message.type === 'graph').payload.friend_ids).toEqual(['person-one']);
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
