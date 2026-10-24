import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/plugins/i18n';
import { watchState } from '@/services/watchState';

const network = vi.hoisted(() => ({ request: vi.fn(), cancel: vi.fn(), needsBuild: vi.fn(), status: vi.fn() }));
const session = vi.hoisted(() => ({ user: null, friend: null }));
vi.mock('@/stores', () => ({
    useUserStore: () => session.user,
    useFriendStore: () => session.friend,
    useAppearanceSettingsStore: () => ({ isDarkMode: ref(false) })
}));
vi.mock('pinia', () => ({ storeToRefs: (store) => store }));
vi.mock('@/services/friendsNetwork/service', () => ({ default: {} }));
vi.mock('@/services/config', () => ({
    default: {
        getString: (_key, fallback) => Promise.resolve(fallback),
        setString: () => Promise.resolve()
    }
}));
vi.mock('../friendsNetworkApi', async (importOriginal) => ({
    ...(await importOriginal()),
    requestFriendsNetwork: network.request,
    cancelFriendsNetwork: network.cancel,
    needsFriendsNetworkHistoryBuild: network.needsBuild,
    readFriendsNetworkStatus: network.status,
    readFriendsNetworkPeople: () => Promise.resolve({ users: [] })
}));
vi.mock('@/coordinators/userCoordinator', () => ({ showUserDialog: vi.fn() }));
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

// Keep the real view, composable, dialog and button together to exercise their
// click ordering. Replace native services and WebGL so builds can be held or failed.
describe('friends network build dialog', () => {
    let wrapper;
    let finishBuild;
    let failBuild;

    function dialog() {
        return new DOMWrapper(document.querySelector('[role="alertdialog"]'));
    }

    async function approve() {
        const button = dialog()
            .findAll('button')
            .find((item) => item.text() === 'Build local history');
        await button.trigger('click');
        await vi.advanceTimersByTimeAsync(1);
        await flushPromises();
    }

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetAllMocks();
        session.user = reactive({ currentUser: { id: 'account-one' } });
        session.friend = reactive({ friends: new Map([['friend-one', { name: 'Friend One' }]]) });
        watchState.isLoggedIn = true;
        watchState.isFriendsLoaded = true;
        network.cancel.mockResolvedValue();
        network.needsBuild.mockReturnValue(true);
        network.status.mockReturnValue({ stage: 'reading', progress: 0.25 });
        network.request.mockImplementation(() => {
            network.needsBuild.mockReturnValue(false);
            return new Promise((resolve, reject) => {
                finishBuild = resolve;
                failBuild = reject;
            });
        });
        wrapper = mount(FriendsNetwork, {
            global: {
                plugins: [i18n],
                stubs: { FriendsNetworkControls: true, VirtualCombobox: true, Spinner: true }
            }
        });
        await flushPromises();
    });

    afterEach(() => {
        wrapper.unmount();
        vi.useRealTimers();
    });

    it('starts once from a real approval click and keeps progress in the popup until completion', async () => {
        expect(network.request).not.toHaveBeenCalled();
        await approve();
        expect(network.request).toHaveBeenCalledOnce();
        expect(dialog().get('[role="progressbar"]').attributes('aria-valuenow')).toBe('25');
        network.status.mockReturnValue({ stage: 'reconstructing', progress: 0.65 });
        await vi.advanceTimersByTimeAsync(500);
        expect(dialog().text()).toContain('65%');
        finishBuild({ nodes: [{ id: 'friend-one', community: 0 }], links: [] });
        await flushPromises();
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    });

    it('can hide the popup while the approved build continues with page progress', async () => {
        await approve();
        await dialog().get('button').trigger('click');
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();
        expect(wrapper.get('[data-testid="friends-network-progress"]').text()).toContain('25%');
        expect(network.request).toHaveBeenCalledOnce();
        finishBuild({ nodes: [], links: [] });
        await flushPromises();
        expect(wrapper.find('[data-testid="friends-network-progress"]').exists()).toBe(false);
    });

    it('shows a build failure in the popup and retries from its approval button', async () => {
        await approve();
        network.needsBuild.mockReturnValue(true);
        failBuild(new Error('History read failed.'));
        await flushPromises();
        expect(dialog().get('[role="alert"]').text()).toBe('History read failed.');
        await approve();
        expect(network.request).toHaveBeenCalledTimes(2);
        expect(dialog().find('[role="alert"]').exists()).toBe(false);
        finishBuild({ nodes: [], links: [] });
        await flushPromises();
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    });

    it('does not build when Maybe later closes the dialog', async () => {
        await dialog().findAll('button')[0].trigger('click');
        await vi.advanceTimersByTimeAsync(500);
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();
        expect(network.request).not.toHaveBeenCalled();
    });
});
