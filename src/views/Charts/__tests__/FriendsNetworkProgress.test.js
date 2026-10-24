import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { ref, shallowRef } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/plugins/i18n';
import { createDefaultFriendsNetworkSettings } from '../friendsNetworkSettings';

const network = vi.hoisted(() => ({ view: null, people: vi.fn(), rendered: [], dispose: vi.fn() }));
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
        constructor(container) {
            this.canvas = document.createElement('canvas');
            container.append(this.canvas);
        }
        update(data) {
            network.rendered.push(data);
            return Promise.resolve();
        }
        setAppearance() {}
        cancel() {}
        focus() {}
        highlight() {}
        dispose() {
            this.canvas.remove();
            network.dispose();
        }
    },
    toFriendsNetworkLayoutSettings: () => ({})
}));

import FriendsNetwork from '../components/FriendsNetwork.vue';

describe('observed friends network loading progress', () => {
    let wrapper;

    beforeEach(() => {
        vi.clearAllMocks();
        network.rendered.length = 0;
        network.view = {
            settings: ref(createDefaultFriendsNetworkSettings()),
            savedPresets: ref([]),
            graph: shallowRef(null),
            friendContext: ref({ current_user_id: 'account-one', friend_ids: ['friend-one', 'hidden-friend'] }),
            currentFriends: ref([
                { id: 'friend-one', name: 'Live Friend' },
                { id: 'hidden-friend', name: 'Hidden Friend' }
            ]),
            scopeKey: ref('account-one:friend-one,hidden-friend'),
            scopeReady: ref(true),
            busy: ref(true),
            status: ref({ busy: true, stage: 'reading', progress: 0.25 }),
            error: ref(''),
            buildConfirmationOpen: ref(false),
            buildingHistory: ref(false),
            historyBuildPending: ref(false),
            confirmHistoryBuild: vi.fn(),
            dismissHistoryBuild: vi.fn(),
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

    it('uses the themed build prompt with the performance warning and explicit actions', async () => {
        network.view.busy.value = false;
        network.view.historyBuildPending.value = true;
        network.view.buildConfirmationOpen.value = true;
        await flushPromises();
        const dialog = new DOMWrapper(document.querySelector('[role="alertdialog"]'));
        expect(dialog.text()).toContain('Build local history cache?');
        expect(dialog.text()).toContain('slower PCs');
        expect(dialog.text()).toContain('HDDs');
        expect(dialog.text()).toContain('until VRCX closes');
        expect(network.view.confirmHistoryBuild).not.toHaveBeenCalled();
        const buttons = dialog.findAll('button');
        expect(buttons.map((button) => button.text())).toEqual(['Maybe later', 'Build local history']);
        await buttons[1].trigger('click');
        expect(network.view.confirmHistoryBuild).toHaveBeenCalledOnce();
    });

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

    it('searches all current friends and excludes historical nonfriends from search and the canvas', async () => {
        network.people.mockResolvedValueOnce({
            users: [
                { id: 'friend-one', name: 'Historical Friend', join_count: 8 },
                { id: 'intruder', name: 'Other Account Friend' }
            ]
        });
        network.view.graph.value = {
            nodes: [
                { id: 'friend-one', community: 0 },
                { id: 'intruder', community: 0 }
            ],
            links: [{ source: 'friend-one', target: 'intruder', weight: 1 }]
        };
        await flushPromises();
        const search = wrapper.findAllComponents({ name: 'VirtualCombobox' })[0];
        expect(search.props('groups')[0].items).toEqual([
            { value: 'hidden-friend', label: 'Hidden Friend', search: 'Hidden Friend hidden-friend' },
            { value: 'friend-one', label: 'Live Friend', search: 'Live Friend friend-one' }
        ]);
        expect(network.people).toHaveBeenCalledWith({
            current_user_id: 'account-one',
            friend_ids: ['friend-one', 'hidden-friend']
        });
        expect(network.rendered.at(-1).nodes.map((node) => node.id)).toEqual(['friend-one']);
        expect(network.rendered.at(-1).links).toEqual([]);
        search.vm.$emit('update:modelValue', 'hidden-friend');
        await flushPromises();
        expect(wrapper.text()).toContain('This person is outside the current graph filters.');
        expect(wrapper.text()).toContain('Hidden Friend');
    });

    it('removes the previous canvas and ignores a delayed directory during an account switch', async () => {
        let resolveOld;
        network.people.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveOld = resolve;
            })
        );
        network.view.graph.value = { nodes: [{ id: 'friend-one', community: 0 }], links: [] };
        await flushPromises();
        expect(wrapper.find('canvas').exists()).toBe(true);
        network.view.friendContext.value = { current_user_id: 'account-two', friend_ids: ['new-friend'] };
        network.view.currentFriends.value = [{ id: 'new-friend', name: 'New Friend' }];
        network.view.graph.value = null;
        network.view.scopeKey.value = 'account-two:new-friend';
        expect(wrapper.find('canvas').exists()).toBe(false);
        expect(network.dispose).toHaveBeenCalledOnce();
        resolveOld({ users: [{ id: 'friend-one', name: 'Old Account Friend' }] });
        await flushPromises();
        const search = wrapper.findAllComponents({ name: 'VirtualCombobox' })[0];
        expect(search.props('groups')[0].items.map((person) => person.value)).toEqual(['new-friend']);
        network.view.friendContext.value = { current_user_id: '', friend_ids: [] };
        network.view.currentFriends.value = [];
        network.view.scopeReady.value = false;
        network.view.graph.value = { nodes: [], links: [] };
        network.view.busy.value = false;
        network.view.scopeKey.value = 'logged-out';
        await flushPromises();
        expect(search.props('groups')[0].items).toEqual([]);
        expect(wrapper.text()).toContain('Log in to view your current friends');
        expect(wrapper.find('canvas').exists()).toBe(false);
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
