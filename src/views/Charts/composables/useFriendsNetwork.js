import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import configRepository from '@/services/config';
import {
    cancelFriendsNetwork,
    readFriendsNetworkStatus,
    requestFriendsNetwork,
    toFriendsNetworkRequest
} from '../friendsNetworkApi';
import { createDefaultFriendsNetworkSettings, normalizeFriendsNetworkSettings } from '../friendsNetworkSettings';

const SETTINGS_KEY = 'VRCX_FriendsNetworkSettings';
const PRESETS_KEY = 'VRCX_FriendsNetworkSavedPresets';

/** Owns one graph view, including pending analysis and debounced settings. */
export function useFriendsNetwork() {
    const settings = ref(createDefaultFriendsNetworkSettings());
    const savedPresets = ref([]);
    const graph = shallowRef(null);
    const accounts = ref([]);
    const busy = ref(false);
    const status = ref({ stage: '', progress: 0 });
    const error = ref('');
    const ready = ref(false);
    let disposed = false;
    let revision = Date.now();
    let debounceTimer;
    let statusTimer;
    let polling = false;
    let saveQueue = Promise.resolve();

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

    async function pollStatus() {
        if (disposed || polling || !busy.value) {
            return;
        }
        polling = true;
        try {
            const next = await readFriendsNetworkStatus();
            if (!disposed) {
                status.value = next;
                if (Array.isArray(next.accounts)) {
                    accounts.value = next.accounts;
                }
            }
        } catch {
            // The graph request reports failures. Polling must not replace them.
        } finally {
            polling = false;
        }
    }

    async function loadGraph(requestRevision, rebuild) {
        if (disposed || requestRevision !== revision) {
            return;
        }
        busy.value = true;
        error.value = '';
        try {
            const pending = requestFriendsNetwork(settings.value, requestRevision, rebuild);
            // Capture the first import stage immediately, then poll while it runs.
            void pollStatus();
            const result = await pending;
            if (disposed || requestRevision !== revision || result.cancelled) {
                return;
            }
            graph.value = result;
            if (Array.isArray(result.accounts)) {
                accounts.value = result.accounts;
            }
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

    function refresh(rebuild = false) {
        clearTimeout(debounceTimer);
        const requestRevision = ++revision;
        busy.value = true;
        status.value = { stage: '', progress: 0 };
        // Invalidate immediately, including while the next slider edit settles.
        void cancelFriendsNetwork().catch(() => {});
        debounceTimer = setTimeout(() => loadGraph(requestRevision, rebuild), rebuild ? 0 : 100);
    }

    // Display-only controls do not trigger analysis or read history again.
    watch(
        () => JSON.stringify(toFriendsNetworkRequest(settings.value, 0)),
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
            savedPresets.value = Array.isArray(presets)
                ? presets.filter((preset) => preset && typeof preset.id === 'string' && typeof preset.name === 'string')
                : [];
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

    return { settings, savedPresets, graph, accounts, busy, status, error, ready, refresh };
}

function parsePreference(value, fallback) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}
