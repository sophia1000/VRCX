import { shallowMount, flushPromises } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { i18n } from '@/plugins/i18n';
import {
    createDefaultFriendsNetworkSettings,
    createFriendsNetworkPreset,
    FRIENDS_NETWORK_PRESETS
} from '../friendsNetworkSettings';

import FriendsNetworkControls from '../components/FriendsNetworkControls.vue';

function mountControls() {
    const preset = createFriendsNetworkPreset('Quiet evenings', createDefaultFriendsNetworkSettings(), 'user:quiet');
    const wrapper = shallowMount(FriendsNetworkControls, {
        props: { savedPresets: [preset] },
        global: { plugins: [i18n], renderStubDefaultSlot: true }
    });
    return { wrapper, preset };
}

describe('friends network preset actions', () => {
    it('offers no account selector or friends-only toggle', () => {
        const { wrapper } = mountControls();
        expect(wrapper.find('#friends-network-account').exists()).toBe(false);
        expect(wrapper.find('#friends-network-friendsOnly').exists()).toBe(false);
        expect(wrapper.text()).not.toContain('Friends only');
        expect(wrapper.text()).toContain('current friends');
        wrapper.unmount();
    });

    it('applies settings immediately with no apply action', () => {
        const { wrapper } = mountControls();
        wrapper.vm.updateSetting('topK', 6);
        expect(wrapper.emitted('update:settings')[0][0].topK).toBe(6);
        expect(wrapper.text()).not.toContain('Apply settings');
        wrapper.unmount();
    });

    it('offers an optional backbone and applies a selection without changing the time window', async () => {
        const { wrapper } = mountControls();
        const control = wrapper.findComponent('[data-testid="friends-network-backbone-select"]');
        expect(control.props('modelValue')).toBe('1');
        expect(wrapper.text()).toContain('Connection backbone');
        expect(wrapper.findComponent({ name: 'TooltipWrapper' }).props('content')).toContain('unusually strong');
        await wrapper.setProps({
            settings: {
                ...createDefaultFriendsNetworkSettings(),
                days: null,
                dateFrom: '2026-01-01',
                dateTo: '2026-06-01'
            }
        });
        control.vm.$emit('update:modelValue', '0.1');
        await flushPromises();
        expect(wrapper.emitted('update:settings')[0][0]).toMatchObject({
            backboneThreshold: 0.1,
            days: null,
            dateFrom: '2026-01-01',
            dateTo: '2026-06-01'
        });
        expect(wrapper.vm.activePresetId).toBe('custom');
        wrapper.unmount();
    });

    it('captures the enabled backbone in a saved view and restores it through preset selection', async () => {
        const { wrapper } = mountControls();
        await wrapper.setProps({ settings: { ...createDefaultFriendsNetworkSettings(), backboneThreshold: 0.05 } });
        wrapper.vm.presetName = 'Distinctive connections';
        wrapper.vm.savePreset();
        const saved = wrapper.emitted('update:savedPresets')[0][0];
        expect(saved[1].settings.backboneThreshold).toBe(0.05);
        await wrapper.setProps({ savedPresets: saved, settings: createDefaultFriendsNetworkSettings() });
        wrapper.vm.selectPreset(saved[1].id);
        expect(wrapper.emitted('update:settings')[0][0].backboneThreshold).toBe(0.05);
        wrapper.unmount();
    });

    it('preserves a custom history window while selecting a preset', async () => {
        const { wrapper } = mountControls();
        await wrapper.setProps({
            settings: {
                ...createDefaultFriendsNetworkSettings(),
                days: null,
                dateFrom: '2026-01-01',
                dateTo: '2026-06-01'
            }
        });
        wrapper.vm.selectPreset('builtin:recent');
        expect(wrapper.emitted('update:settings')[0][0]).toMatchObject({
            days: null,
            dateFrom: '2026-01-01',
            dateTo: '2026-06-01',
            halfLifeDays: 14
        });
        wrapper.unmount();
    });

    it('protects built-in presets from deletion', async () => {
        const { wrapper } = mountControls();
        wrapper.vm.selectPreset(FRIENDS_NETWORK_PRESETS[0].id);
        await wrapper.vm.deletePreset();
        expect(wrapper.vm.deleteConfirmationOpen).toBe(false);
        expect(wrapper.emitted('update:savedPresets')).toBeUndefined();
        wrapper.unmount();
    });

    it('names the captured preset in the confirmation and preserves it on cancel', async () => {
        const { wrapper, preset } = mountControls();
        wrapper.vm.selectPreset(preset.id);
        await wrapper.vm.deletePreset();
        expect(wrapper.vm.pendingDeletion.name).toBe('Quiet evenings');
        wrapper.vm.deleteConfirmationOpen = false;
        expect(wrapper.emitted('update:savedPresets')).toBeUndefined();
        await wrapper.vm.deletePreset();
        wrapper.vm.confirmPresetDeletion();
        await flushPromises();
        expect(wrapper.emitted('update:savedPresets')[0][0]).toEqual([]);
        wrapper.unmount();
    });
});
