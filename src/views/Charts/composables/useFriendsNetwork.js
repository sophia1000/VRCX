import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';

import configRepository from '@/services/config';
import { useFriendStore, useUserStore } from '@/stores';
import { watchState } from '@/services/watchState';

import {
    cancelFriendsNetwork,
    readFriendsNetworkStatus,
    requestFriendsNetwork,
    toFriendsNetworkRequest
} from '../friendsNetworkApi';
import {
    createDefaultFriendsNetworkSettings,
    createFriendsNetworkPreset,
    normalizeFriendsNetworkSettings,
    validFriendsNetworkPresets
} from '../friendsNetworkSettings';

const SETTINGS_KEY = 'VRCX_FriendsNetworkSettings';
const PRESETS_KEY = 'VRCX_FriendsNetworkSavedPresets';

/** Owns one graph view, including pending analysis and debounced settings. */
export function useFriendsNetwork() {
    const userStore = useUserStore();
    const friendStore = useFriendStore();

    // --- View state ---

    const settings = ref(createDefaultFriendsNetworkSettings());
    const savedPresets = ref([]);
    const graph = shallowRef(null);
    const busy = ref(false);
    const status = ref({ stage: '', progress: 0 });
    const error = ref('');
    const ready = ref(false);
    let disposed = false;
    let revision = Date.now();
    let debounceTimer;
    let statusTimer;
    let saveQueue = Promise.resolve();

    // --- Authenticated friend scope ---

    // The live friend map is populated for one authenticated account at a time.
    // An ID change must not borrow an old account's still-loaded map while the
    // normal friend initialization flow resets and hydrates the new account.
    const friendAccountId = ref(watchState.isLoggedIn && watchState.isFriendsLoaded ? userStore.currentUser.id : '');
    watch(
        [() => userStore.currentUser.id, () => watchState.isLoggedIn, () => watchState.isFriendsLoaded],
        ([id, loggedIn, loaded], [previousId, previouslyLoggedIn, previouslyLoaded]) => {
            if (!loggedIn || !loaded || (id !== previousId && previouslyLoggedIn && previouslyLoaded)) {
                friendAccountId.value = '';
                return;
            }
            friendAccountId.value = id;
        },
        { flush: 'sync' }
    );
    const scopeReady = computed(
        () =>
            watchState.isLoggedIn &&
            watchState.isFriendsLoaded &&
            Boolean(userStore.currentUser.id) &&
            friendAccountId.value === userStore.currentUser.id
    );
    const friendContext = computed(() => {
        const id = watchState.isLoggedIn ? userStore.currentUser.id : '';
        return {
            current_user_id: id,
            friend_ids: scopeReady.value
                ? [...friendStore.friends.keys()].filter((friend) => typeof friend === 'string' && friend !== id).sort()
                : []
        };
    });
    const scopeKey = computed(
        () => `${friendContext.value.current_user_id}:${scopeReady.value}:${friendContext.value.friend_ids.join(',')}`
    );
    const currentFriends = computed(() =>
        friendContext.value.friend_ids.map((id) => {
            const friend = friendStore.friends.get(id);
            return { id, name: friend?.ref?.displayName || friend?.name || '' };
        })
    );

    // --- Preference persistence ---

    // Serialize preference writes so a slow save cannot restore an older edit.
    function savePreference(key, value) {
        const serialized = JSON.stringify(value);
        saveQueue = saveQueue
            .catch(() => {})
            .then(() => configRepository.setString(key, serialized))
            .catch((reason) => {
                if (!disposed) {
                    error.value = String(reason.message || reason);
                }
            });
    }

    // --- Graph request lifetime ---

    function pollStatus() {
        if (!disposed && busy.value) {
            status.value = readFriendsNetworkStatus();
        }
    }

    /** Publish only the graph response that still owns the current request revision. */
    async function loadGraph(requestRevision, rebuild) {
        if (disposed || requestRevision !== revision) {
            return;
        }
        busy.value = true;
        error.value = '';
        try {
            const pending = requestFriendsNetwork(settings.value, rebuild, friendContext.value);
            // Capture the first import stage immediately, then poll while it runs.
            pollStatus();
            const result = await pending;
            if (disposed || requestRevision !== revision || result.cancelled) {
                return;
            }
            graph.value = result;
        } catch (reason) {
            if (!disposed && requestRevision === revision) {
                error.value = String(reason.message || reason);
            }
        } finally {
            if (!disposed && requestRevision === revision) {
                busy.value = false;
            }
        }
    }

    /** Schedule analysis while immediately invalidating work for the previous view. */
    function refresh(rebuild = false) {
        clearTimeout(debounceTimer);
        const requestRevision = ++revision;
        status.value = { stage: '', progress: 0 };
        error.value = '';
        // Invalidate immediately, including while the next slider edit settles.
        void cancelFriendsNetwork().catch(() => {});
        if (!scopeReady.value || !friendContext.value.friend_ids.length) {
            graph.value = { nodes: [], links: [], communities: [] };
            busy.value = false;
            return;
        }
        busy.value = true;
        debounceTimer = setTimeout(() => loadGraph(requestRevision, rebuild), rebuild ? 0 : 100);
    }

    // --- Scope and settings watchers ---

    watch(
        scopeKey,
        () => {
            // Clear the old account immediately, before any replacement analysis.
            graph.value = null;
            if (ready.value) {
                refresh();
            }
        },
        { flush: 'sync' }
    );

    // Display-only controls do not trigger analysis or read history again.
    watch(
        () => JSON.stringify(toFriendsNetworkRequest(settings.value)),
        () => {
            if (ready.value) {
                refresh();
            }
        }
    );
    watch(
        settings,
        (value) => {
            if (ready.value) {
                savePreference(SETTINGS_KEY, value);
            }
        },
        { deep: true }
    );
    watch(
        savedPresets,
        (value) => {
            if (ready.value) {
                savePreference(PRESETS_KEY, value);
            }
        },
        { deep: true }
    );

    // --- View lifecycle ---

    onMounted(async () => {
        try {
            const [storedSettings, storedPresets] = await Promise.all([
                configRepository.getString(SETTINGS_KEY, '{}'),
                configRepository.getString(PRESETS_KEY, '[]')
            ]);
            if (disposed) {
                return;
            }
            settings.value = normalizeFriendsNetworkSettings(parsePreference(storedSettings, {}));
            const presets = parsePreference(storedPresets, []);
            savedPresets.value = validFriendsNetworkPresets(presets).map((preset) =>
                createFriendsNetworkPreset(preset.name, preset.settings, preset.id)
            );
            // Let watchers consume restored values before enabling persistence.
            await Promise.resolve();
            ready.value = true;
            statusTimer = setInterval(pollStatus, 500);
            refresh();
        } catch (reason) {
            if (!disposed) {
                error.value = String(reason.message || reason);
            }
        }
    });

    onBeforeUnmount(() => {
        disposed = true;
        ++revision;
        clearTimeout(debounceTimer);
        clearInterval(statusTimer);
        void cancelFriendsNetwork().catch(() => {});
    });

    return {
        settings,
        savedPresets,
        graph,
        friendContext,
        currentFriends,
        scopeKey,
        scopeReady,
        busy,
        status,
        error,
        ready,
        refresh
    };
}

function parsePreference(value, fallback) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}
