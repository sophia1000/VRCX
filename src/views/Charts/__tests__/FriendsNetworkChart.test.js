import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/plugins/i18n';

const storage = vi.hoisted(() => ({ getString: vi.fn(), setString: vi.fn() }));
vi.mock('@/services/config', () => ({ default: storage }));
vi.mock('../components/MutualFriends.vue', () => ({ default: { name: 'OriginalMutualChart', render: () => null } }));
vi.mock('../components/FriendsNetwork.vue', () => ({ default: { name: 'ObservedHistoryChart', render: () => null } }));
import FriendsNetworkChart from '../components/FriendsNetworkChart.vue';

describe('existing friends network route', () => {
    beforeEach(() => {
        storage.getString.mockResolvedValue('mutual');
        storage.setString.mockResolvedValue();
    });

    it('defaults to the original mutual chart and switches only this route', async () => {
        const wrapper = mount(FriendsNetworkChart, { global: { plugins: [i18n] } });
        await flushPromises();
        expect(wrapper.findComponent({ name: 'OriginalMutualChart' }).exists()).toBe(true);
        expect(wrapper.findComponent({ name: 'ObservedHistoryChart' }).exists()).toBe(false);
        await wrapper.findAll('button')[1].trigger('click');
        expect(wrapper.findComponent({ name: 'ObservedHistoryChart' }).exists()).toBe(true);
        expect(storage.setString).toHaveBeenLastCalledWith('VRCX_FriendsNetworkMode', 'history');
        wrapper.unmount();
    });

    it('restores history mode without mounting the mutual API fetch flow', async () => {
        storage.getString.mockResolvedValue('history');
        const wrapper = mount(FriendsNetworkChart, { global: { plugins: [i18n] } });
        await flushPromises();
        expect(wrapper.findComponent({ name: 'OriginalMutualChart' }).exists()).toBe(false);
        expect(wrapper.findComponent({ name: 'ObservedHistoryChart' }).exists()).toBe(true);
        wrapper.unmount();
    });
});
