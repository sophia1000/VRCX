import { defineComponent, nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({ request: vi.fn(), cancel: vi.fn(), status: vi.fn() }));
const storage = vi.hoisted(() => ({ getString: vi.fn(), setString: vi.fn() }));
vi.mock('@/services/config', () => ({ default: storage }));
vi.mock('@/services/friendsNetwork/service', () => ({ default: {} }));
vi.mock('../../friendsNetworkApi', async (importOriginal) => ({
    ...(await importOriginal()),
    requestFriendsNetwork: network.request,
    cancelFriendsNetwork: network.cancel,
    readFriendsNetworkStatus: network.status
}));

import { useFriendsNetwork } from '../useFriendsNetwork';

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('friends network request lifetime', () => {
    let wrapper;
    let chart;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetAllMocks();
        storage.getString.mockImplementation((_key, fallback) => Promise.resolve(fallback));
        storage.setString.mockResolvedValue();
        network.cancel.mockResolvedValue();
        network.status.mockResolvedValue({ stage: 'scoring' });
        network.request.mockResolvedValue({ nodes: [], links: [], accounts: [] });
        wrapper = mount(
            defineComponent({
                setup() {
                    chart = useFriendsNetwork();
                    return {};
                },
                template: '<div />'
            })
        );
    });

    afterEach(() => {
        wrapper.unmount();
        vi.useRealTimers();
    });

    async function start() {
        await flushPromises();
        await vi.advanceTimersByTimeAsync(100);
        await flushPromises();
    }

    it('defaults to all accounts and keeps display changes out of service analysis', async () => {
        await start();
        expect(chart.settings.value.account).toBe('all');
        expect(network.request).toHaveBeenCalledTimes(1);
        chart.settings.value = { ...chart.settings.value, labels: false, groupSpacing: 80, colorByWeight: true };
        await nextTick();
        await vi.advanceTimersByTimeAsync(120);
        expect(network.request).toHaveBeenCalledTimes(1);
        expect(storage.setString).toHaveBeenCalledWith('VRCX_FriendsNetworkSettings', expect.any(String));
    });

    it('invalidates an old response immediately while a slider change is debouncing', async () => {
        const first = deferred();
        network.request.mockReturnValueOnce(first.promise);
        await start();
        chart.settings.value = { ...chart.settings.value, topK: 6 };
        await nextTick();
        first.resolve({ nodes: [{ id: 'stale' }], links: [] });
        await flushPromises();
        expect(chart.graph.value).toBeNull();
        expect(network.cancel).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(100);
        expect(network.request).toHaveBeenCalledTimes(2);
        expect(chart.graph.value.nodes).toEqual([]);
    });

    it('coalesces rapid scoring edits and rebuilds only when requested', async () => {
        await start();
        for (const topK of [5, 8, 10]) {
            chart.settings.value = { ...chart.settings.value, topK };
            await nextTick();
            await vi.advanceTimersByTimeAsync(20);
        }
        await vi.advanceTimersByTimeAsync(100);
        expect(network.request).toHaveBeenCalledTimes(2);
        expect(network.request.mock.calls[1][0].topK).toBe(10);
        expect(network.request.mock.calls[1][2]).toBe(false);
        chart.refresh(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(network.request.mock.calls[2][2]).toBe(true);
    });

    it('reads first-import progress immediately and keeps polling until analysis finishes', async () => {
        const pending = deferred();
        network.request.mockReturnValueOnce(pending.promise);
        network.status.mockResolvedValueOnce({ busy: true, stage: 'reading', progress: 0.1 });
        await start();
        expect(chart.busy.value).toBe(true);
        expect(chart.status.value).toMatchObject({ stage: 'reading', progress: 0.1 });
        network.status.mockResolvedValue({ busy: true, stage: 'reconstructing', progress: 0.5 });
        await vi.advanceTimersByTimeAsync(500);
        expect(chart.status.value).toMatchObject({ stage: 'reconstructing', progress: 0.5 });
        pending.resolve({ nodes: [], links: [] });
        await flushPromises();
        expect(chart.busy.value).toBe(false);
        const reads = network.status.mock.calls.length;
        await vi.advanceTimersByTimeAsync(1000);
        expect(network.status).toHaveBeenCalledTimes(reads);
    });

    it('cancels requests and polling when the graph view closes', async () => {
        const pending = deferred();
        network.request.mockReturnValueOnce(pending.promise);
        await start();
        wrapper.unmount();
        const cancellations = network.cancel.mock.calls.length;
        pending.resolve({ nodes: [{ id: 'late' }], links: [] });
        await vi.advanceTimersByTimeAsync(1500);
        expect(chart.graph.value).toBeNull();
        expect(network.cancel.mock.calls.length).toBe(cancellations);
        expect(network.status).toHaveBeenCalledTimes(1);
    });
});
