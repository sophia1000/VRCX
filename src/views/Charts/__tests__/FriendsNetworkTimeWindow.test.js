import { shallowMount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { i18n } from '@/plugins/i18n';
import FriendsNetworkTimeWindow from '../components/FriendsNetworkTimeWindow.vue';
import { createDefaultFriendsNetworkSettings } from '../friendsNetworkSettings';

describe('independent friends network history window', () => {
    it('changes only the history window and keeps an empty custom range open across preset edits', async () => {
        const settings = { ...createDefaultFriendsNetworkSettings(), topK: 6, groupSpacing: 85 };
        const wrapper = shallowMount(FriendsNetworkTimeWindow, {
            props: { settings },
            global: { plugins: [i18n], renderStubDefaultSlot: true }
        });
        wrapper.vm.changePeriod('custom');
        const next = wrapper.emitted('update:settings')[0][0];
        expect(next).toEqual({ ...settings, days: null, dateFrom: '', dateTo: '' });
        await wrapper.setProps({ settings: { ...next, topK: 24 } });
        expect(wrapper.vm.period).toBe('custom');
        wrapper.vm.changeDate('dateFrom', '2026-01-01');
        expect(wrapper.emitted('update:settings')[1][0]).toMatchObject({
            topK: 24,
            days: null,
            dateFrom: '2026-01-01'
        });
        wrapper.unmount();
    });
});
