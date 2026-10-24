import { defineComponent, nextTick, reactive } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({ request: vi.fn(), cancel: vi.fn(), status: vi.fn(), needsBuild: vi.fn() }));
const session = vi.hoisted(() => ({ user: null, friend: null }));
vi.mock('@/stores', () => ({ useUserStore: () => session.user, useFriendStore: () => session.friend }));
const storage = vi.hoisted(() => ({ getString: vi.fn(), setString: vi.fn() }));
vi.mock('@/services/config', () => ({ default: storage }));
vi.mock('@/services/friendsNetwork/service', () => ({ default: {} }));
vi.mock('../../friendsNetworkApi', async (importOriginal) => ({
    ...(await importOriginal()),
    requestFriendsNetwork: network.request,
    cancelFriendsNetwork: network.cancel,
    needsFriendsNetworkHistoryBuild: network.needsBuild,
    readFriendsNetworkStatus: network.status
}));

import { useFriendsNetwork } from '../useFriendsNetwork';
import { watchState } from '@/services/watchState';

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
        session.user = reactive({ currentUser: { id: 'account-one' } });
        session.friend = reactive({
            friends: new Map([
                ['friend-one', { name: 'Friend One' }],
                ['friend-two', { name: 'Friend Two' }]
            ])
        });
        watchState.isLoggedIn = true;
        watchState.isFriendsLoaded = true;
        storage.getString.mockImplementation((_key, fallback) => Promise.resolve(fallback));
        storage.setString.mockResolvedValue();
        network.cancel.mockResolvedValue();
        network.needsBuild.mockReturnValue(false);
        network.status.mockReturnValue({ stage: 'scoring' });
        network.request.mockResolvedValue({ nodes: [], links: [], accounts: [] });
        mountChart();
    });

    function mountChart() {
        wrapper = mount(
            defineComponent({
                setup() {
                    chart = useFriendsNetwork();
                    return {};
                },
                template: '<div />'
            })
        );
    }

    function requireHistoryBuild() {
        wrapper.unmount();
        network.needsBuild.mockReturnValue(true);
        mountChart();
    }

    afterEach(() => {
        wrapper.unmount();
        vi.useRealTimers();
    });

    async function start() {
        await flushPromises();
        await vi.advanceTimersByTimeAsync(100);
        await flushPromises();
    }

    it('asks before a cold build and uses the latest settings only after approval', async () => {
        requireHistoryBuild();
        await start();
        expect(chart.buildConfirmationOpen.value).toBe(true);
        expect(chart.busy.value).toBe(false);
        expect(network.request).not.toHaveBeenCalled();
        chart.settings.value.topK = 7;
        await nextTick();
        await vi.advanceTimersByTimeAsync(200);
        expect(network.request).not.toHaveBeenCalled();
        chart.confirmHistoryBuild();
        network.needsBuild.mockReturnValue(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(chart.buildConfirmationOpen.value).toBe(false);
        expect(network.request).toHaveBeenCalledOnce();
        expect(network.request.mock.calls[0][0].topK).toBe(7);
        expect(chart.historyBuildPending.value).toBe(false);
    });

    it('does not build or ask again after a decline until the build button is used', async () => {
        requireHistoryBuild();
        await start();
        chart.dismissHistoryBuild();
        chart.settings.value.topK = 8;
        await nextTick();
        await vi.advanceTimersByTimeAsync(500);
        expect(chart.buildConfirmationOpen.value).toBe(false);
        expect(chart.historyBuildPending.value).toBe(true);
        expect(network.request).not.toHaveBeenCalled();
        chart.refresh(true);
        expect(chart.buildConfirmationOpen.value).toBe(true);
        chart.confirmHistoryBuild();
        await vi.advanceTimersByTimeAsync(1);
        expect(network.request).toHaveBeenCalledOnce();
        expect(network.request.mock.calls[0][1]).toBe(true);
    });

    it('closes an unanswered build prompt on leaving and ignores late approval', async () => {
        requireHistoryBuild();
        await start();
        expect(chart.buildConfirmationOpen.value).toBe(true);
        wrapper.unmount();
        chart.confirmHistoryBuild();
        await vi.advanceTimersByTimeAsync(500);
        expect(chart.buildConfirmationOpen.value).toBe(false);
        expect(network.request).not.toHaveBeenCalled();
    });

    it('asks again if the cached worker fails while a graph request is debouncing', async () => {
        await start();
        chart.settings.value.topK = 9;
        await nextTick();
        network.needsBuild.mockReturnValue(true);
        await vi.advanceTimersByTimeAsync(100);
        expect(chart.buildConfirmationOpen.value).toBe(true);
        expect(network.request).toHaveBeenCalledOnce();
    });

    it('uses live friend scope and keeps display changes out of service analysis', async () => {
        await start();
        expect(chart.buildConfirmationOpen.value).toBe(false);
        expect(chart.settings.value).not.toHaveProperty('account');
        expect(chart.settings.value).not.toHaveProperty('friendsOnly');
        expect(network.request.mock.calls[0][2]).toEqual({
            current_user_id: 'account-one',
            friend_ids: ['friend-one', 'friend-two']
        });
        expect(network.request).toHaveBeenCalledTimes(1);
        chart.settings.value = { ...chart.settings.value, labels: false, groupSpacing: 80, colorByWeight: true };
        await nextTick();
        await vi.advanceTimersByTimeAsync(300);
        expect(network.request).toHaveBeenCalledTimes(1);
        expect(storage.setString).toHaveBeenCalledWith('VRCX_FriendsNetworkSettings', expect.any(String));
    });

    it('coalesces preference writes and flushes the final edit when leaving', async () => {
        await start();
        for (const topK of [5, 8, 10]) {
            chart.settings.value.topK = topK;
            await nextTick();
            await vi.advanceTimersByTimeAsync(50);
        }
        expect(storage.setString).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(300);
        expect(storage.setString).toHaveBeenCalledOnce();
        expect(JSON.parse(storage.setString.mock.calls[0][1]).topK).toBe(10);
        chart.settings.value.topK = 15;
        await nextTick();
        wrapper.unmount();
        await flushPromises();
        expect(storage.setString).toHaveBeenCalledTimes(2);
        expect(JSON.parse(storage.setString.mock.calls[1][1]).topK).toBe(15);
    });

    it('keeps logged-out and partially loaded accounts empty without reading history', async () => {
        watchState.isLoggedIn = false;
        watchState.isFriendsLoaded = false;
        await start();
        expect(network.request).not.toHaveBeenCalled();
        expect(chart.graph.value.nodes).toEqual([]);
        expect(chart.currentFriends.value).toEqual([]);
        watchState.isLoggedIn = true;
        await vi.advanceTimersByTimeAsync(200);
        expect(network.request).not.toHaveBeenCalled();
        expect(chart.friendContext.value.friend_ids).toEqual([]);
        watchState.isFriendsLoaded = true;
        await vi.advanceTimersByTimeAsync(100);
        expect(network.request).toHaveBeenCalledOnce();
    });

    it('clears an old graph synchronously when a live friend is removed', async () => {
        network.request.mockResolvedValueOnce({ nodes: [{ id: 'friend-one' }, { id: 'friend-two' }], links: [] });
        await start();
        expect(chart.graph.value.nodes).toHaveLength(2);
        session.friend.friends.delete('friend-one');
        expect(chart.graph.value).toBeNull();
        expect(chart.currentFriends.value.map((friend) => friend.id)).toEqual(['friend-two']);
        await vi.advanceTimersByTimeAsync(100);
        expect(network.request.mock.calls.at(-1)[2]).toEqual({
            current_user_id: 'account-one',
            friend_ids: ['friend-two']
        });
    });

    it('rejects stale account results and waits for a new friend-list loading cycle', async () => {
        const old = deferred();
        network.request.mockReturnValueOnce(old.promise);
        await start();
        session.user.currentUser.id = 'account-two';
        expect(chart.scopeReady.value).toBe(false);
        expect(chart.graph.value.nodes).toEqual([]);
        expect(chart.currentFriends.value).toEqual([]);
        old.resolve({ nodes: [{ id: 'friend-one' }], links: [] });
        await flushPromises();
        expect(chart.graph.value.nodes).toEqual([]);
        await vi.advanceTimersByTimeAsync(200);
        expect(network.request).toHaveBeenCalledOnce();
        watchState.isFriendsLoaded = false;
        session.friend.friends.clear();
        session.friend.friends.set('new-friend', { name: 'New Friend' });
        watchState.isFriendsLoaded = true;
        await vi.advanceTimersByTimeAsync(100);
        expect(network.request.mock.calls.at(-1)[2]).toEqual({
            current_user_id: 'account-two',
            friend_ids: ['new-friend']
        });
        expect(chart.currentFriends.value).toEqual([{ id: 'new-friend', name: 'New Friend' }]);
        watchState.isLoggedIn = false;
        expect(chart.graph.value.nodes).toEqual([]);
        expect(chart.friendContext.value).toEqual({ current_user_id: '', friend_ids: [] });
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
        expect(network.request.mock.calls[1][1]).toBe(false);
        chart.refresh(true);
        expect(chart.buildConfirmationOpen.value).toBe(true);
        expect(network.request).toHaveBeenCalledTimes(2);
        chart.confirmHistoryBuild();
        await vi.advanceTimersByTimeAsync(1);
        expect(network.request.mock.calls[2][1]).toBe(true);
    });

    it('reads first-import progress immediately and keeps polling until analysis finishes', async () => {
        const pending = deferred();
        network.request.mockReturnValueOnce(pending.promise);
        network.status.mockReturnValueOnce({ stage: 'reading', progress: 0.1 });
        await start();
        expect(chart.busy.value).toBe(true);
        expect(chart.status.value).toMatchObject({ stage: 'reading', progress: 0.1 });
        network.status.mockReturnValue({ stage: 'reconstructing', progress: 0.5 });
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
