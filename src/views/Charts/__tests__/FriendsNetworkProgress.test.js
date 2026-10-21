import { flushPromises, mount } from '@vue/test-utils';
import { ref, shallowRef } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/plugins/i18n';
import { createDefaultFriendsNetworkSettings } from '../friendsNetworkSettings';

const network = vi.hoisted(() => ({ view: null, people: vi.fn() }));
vi.mock('../composables/useFriendsNetwork', () => ({ useFriendsNetwork: () => network.view }));
vi.mock('../friendsNetworkApi', () => ({ readFriendsNetworkPeople: network.people }));
vi.mock('@/coordinators/userCoordinator', () => ({ showUserDialog: vi.fn() }));
vi.mock('pinia', () => ({ storeToRefs: (store) => store }));
vi.mock('@/stores', async () => {
    const { ref } = await import('vue');
    return { useAppearanceSettingsStore: () => ({ isDarkMode: ref(false) }) };
});
vi.mock('../friendsNetworkRenderer', () => ({
    FriendsNetworkRenderer: class {
        update() {
            return Promise.resolve();
        }
        setAppearance() {}
        cancel() {}
        dispose() {}
    },
    toFriendsNetworkLayoutSettings: () => ({})
}));

import FriendsNetwork from '../components/FriendsNetwork.vue';

describe('observed friends network loading progress', () => {
    let wrapper;

    beforeEach(() => {
        network.view = {
            settings: ref(createDefaultFriendsNetworkSettings()),
            savedPresets: ref([]),
            graph: shallowRef(null),
            accounts: ref([]),
            busy: ref(true),
            status: ref({ busy: true, stage: 'reading', progress: 0.25 }),
            error: ref(''),
            refresh: vi.fn()
        };
        network.people.mockResolvedValue({ users: [] });
        wrapper = mount(FriendsNetwork, {
            global: {
                plugins: [i18n],
                stubs: { VirtualCombobox: true, FriendsNetworkControls: true, Spinner: true }
            }
        });
    });

    afterEach(() => wrapper.unmount());

    it('shows a visible labeled determinate bar during first history import', () => {
        const progress = wrapper.get('[role="progressbar"]');
        expect(progress.attributes('aria-valuenow')).toBe('25');
        expect(progress.attributes('aria-valuemax')).toBe('100');
        expect(progress.attributes('aria-label')).toBe('Reading local history...');
        expect(wrapper.get('[data-testid="friends-network-progress"]').text()).toContain('25%');
    });

    it('translates later computation stages, clamps progress, and hides it when finished', async () => {
        network.view.status.value = { stage: 'communities', progress: 1.2 };
        await flushPromises();
        expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('100');
        expect(wrapper.get('[role="progressbar"]').attributes('aria-label')).toBe('Finding friend groups...');
        network.view.busy.value = false;
        await flushPromises();
        expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
    });

    it('uses readable fallback text for an unknown stage and reads the people service', async () => {
        network.view.status.value = { stage: 'new-stage', progress: NaN };
        network.view.graph.value = { nodes: [], links: [], stats: { cache_built_at: 'session' } };
        await flushPromises();
        expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('0');
        expect(wrapper.get('[role="progressbar"]').attributes('aria-label')).toBe('Loading observed connections...');
        expect(network.people).toHaveBeenCalledOnce();
    });
});
