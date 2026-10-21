import { defineComponent, nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ request: vi.fn(), cancel: vi.fn(), status: vi.fn() }));
const storage = vi.hoisted(() => ({ getString: vi.fn(), setString: vi.fn() }));
vi.mock('@/services/config', () => ({ default: storage }));
vi.mock('../../friendsNetworkApi', async (importOriginal) => ({
    ...(await importOriginal()),
    requestFriendsNetwork: native.request,
    cancelFriendsNetwork: native.cancel,
    readFriendsNetworkStatus: native.status
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
        native.cancel.mockResolvedValue();
        native.status.mockResolvedValue({ stage: 'scoring' });
        native.request.mockResolvedValue({ nodes: [], links: [], accounts: [] });
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

    it('defaults to all accounts and keeps display changes out of native analysis', async () => {
        await start();
        expect(chart.settings.value.account).toBe('all');
        expect(native.request).toHaveBeenCalledTimes(1);
        chart.settings.value = { ...chart.settings.value, labels: false, groupSpacing: 80, colorByWeight: true };
        await nextTick();
        await vi.advanceTimersByTimeAsync(120);
        expect(native.request).toHaveBeenCalledTimes(1);
        expect(storage.setString).toHaveBeenCalledWith('VRCX_FriendsNetworkSettings', expect.any(String));
    });

    it('invalidates an old response immediately while a slider change is debouncing', async () => {
        const first = deferred();
        native.request.mockReturnValueOnce(first.promise);
        await start();
        chart.settings.value = { ...chart.settings.value, topK: 6 };
        await nextTick();
        first.resolve({ nodes: [{ id: 'stale' }], links: [] });
        await flushPromises();
        expect(chart.graph.value).toBeNull();
        expect(native.cancel).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(100);
        expect(native.request).toHaveBeenCalledTimes(2);
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
        expect(native.request).toHaveBeenCalledTimes(2);
        expect(native.request.mock.calls[1][0].topK).toBe(10);
        expect(native.request.mock.calls[1][2]).toBe(false);
        chart.refresh(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(native.request.mock.calls[2][2]).toBe(true);
    });

    it('cancels requests and polling when the graph view closes', async () => {
        const pending = deferred();
        native.request.mockReturnValueOnce(pending.promise);
        await start();
        wrapper.unmount();
        const cancellations = native.cancel.mock.calls.length;
        pending.resolve({ nodes: [{ id: 'late' }], links: [] });
        await vi.advanceTimersByTimeAsync(1500);
        expect(chart.graph.value).toBeNull();
        expect(native.cancel.mock.calls.length).toBe(cancellations);
        expect(native.status).not.toHaveBeenCalled();
    });
});
