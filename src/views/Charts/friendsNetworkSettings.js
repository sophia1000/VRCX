/**
 * View preferences use camelCase names. The parent chart owns analysis requests
 * and configRepository persistence; these helpers have no storage side effects.
 */
export function createDefaultFriendsNetworkSettings() {
    return {
        days: 90,
        dateFrom: '',
        dateTo: '',
        weighting: 'balanced',
        minEncounters: 2,
        minMinutes: 2,
        minOverlapMinutes: 0,
        sessionCapMinutes: 0,
        halfLifeDays: 90,
        crowdCorrection: true,
        crowdMode: 'visit',
        crowdExponent: 0.5,
        mutualOnly: false,
        topK: 12,
        edgeSelection: 'union',
        backboneThreshold: 1,
        maxNodes: 800,
        resolution: 1,
        includeIsolates: false,
        hubDamping: 0,
        relativeCloseness: 0,
        neighborSimilarity: 0,
        consistency: 0,
        worldFilter: '',
        excludedWorlds: '',
        layoutSpacing: 60,
        groupSpacing: 60,
        groupTightness: 50,
        betweenGroupPull: 100,
        showMemberships: true,
        colorByWeight: false,
        labels: true,
        edgeOpacity: 30
    };
}

const numberBounds = {
    minEncounters: [1, 10000],
    minMinutes: [0, 100000],
    minOverlapMinutes: [0, 10000],
    sessionCapMinutes: [0, 10000],
    halfLifeDays: [0, 3650],
    crowdExponent: [0, 2],
    topK: [0, 1000],
    backboneThreshold: [0, 1],
    maxNodes: [0, 10000],
    resolution: [0.1, 5],
    hubDamping: [0, 1],
    relativeCloseness: [0, 1],
    neighborSimilarity: [0, 1],
    consistency: [0, 1],
    layoutSpacing: [0, 100],
    groupSpacing: [0, 100],
    groupTightness: [0, 100],
    betweenGroupPull: [0, 100],
    edgeOpacity: [0, 100]
};

/** Restore missing values without retaining mutable objects from a saved view. */
export function normalizeFriendsNetworkSettings(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        value = {};
    }
    const defaults = createDefaultFriendsNetworkSettings();
    const settings = { ...defaults };
    for (const key of Object.keys(defaults)) {
        if (value[key] === undefined) {
            continue;
        }
        if (numberBounds[key]) {
            const number = Number(value[key]);
            const [minimum, maximum] = numberBounds[key];
            settings[key] = Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : defaults[key];
        } else if (typeof defaults[key] === 'boolean') {
            settings[key] = typeof value[key] === 'boolean' ? value[key] : defaults[key];
        } else if (typeof defaults[key] === 'string') {
            settings[key] = typeof value[key] === 'string' ? value[key] : defaults[key];
        }
    }
    const days = Number(value.days);
    if (value.days === null) {
        settings.days = null;
    } else if (Number.isFinite(days) && days > 0) {
        settings.days = days;
    }
    if (!['balanced', 'frequency', 'minutes', 'days'].includes(settings.weighting)) {
        settings.weighting = defaults.weighting;
    }
    if (!['union', 'bilateral'].includes(settings.edgeSelection)) {
        settings.edgeSelection = defaults.edgeSelection;
    }
    if (!['visit', 'concurrent'].includes(settings.crowdMode)) {
        settings.crowdMode = defaults.crowdMode;
    }
    return settings;
}

const builtins = [
    { id: 'builtin:balanced', nameKey: 'balanced', settings: {} },
    {
        id: 'builtin:regulars',
        nameKey: 'regulars',
        settings: {
            weighting: 'days',
            consistency: 0.5,
            hubDamping: 0.5,
            minOverlapMinutes: 5,
            sessionCapMinutes: 120,
            topK: 8,
            groupSpacing: 75,
            groupTightness: 70,
            betweenGroupPull: 30
        }
    },
    {
        id: 'builtin:close',
        nameKey: 'close',
        settings: {
            relativeCloseness: 0.65,
            hubDamping: 0.65,
            neighborSimilarity: 0.35,
            minOverlapMinutes: 10,
            resolution: 1.5,
            topK: 6,
            edgeSelection: 'bilateral',
            groupSpacing: 85,
            groupTightness: 75,
            betweenGroupPull: 15
        }
    },
    {
        id: 'builtin:recent',
        nameKey: 'recent',
        settings: { halfLifeDays: 14, hubDamping: 0.4, minOverlapMinutes: 5, groupSpacing: 70, betweenGroupPull: 45 }
    },
    {
        id: 'builtin:small',
        nameKey: 'small',
        settings: {
            crowdMode: 'concurrent',
            crowdExponent: 1,
            minOverlapMinutes: 5,
            sessionCapMinutes: 120,
            relativeCloseness: 0.3,
            groupSpacing: 75,
            betweenGroupPull: 35
        }
    },
    {
        id: 'builtin:history',
        nameKey: 'history',
        settings: { halfLifeDays: 0, weighting: 'days', hubDamping: 0.4, groupSpacing: 70, betweenGroupPull: 45 }
    },
    {
        id: 'builtin:bridges',
        nameKey: 'bridges',
        settings: { topK: 24, minEncounters: 2, resolution: 1.2, groupSpacing: 75, betweenGroupPull: 70 }
    }
];

export const FRIENDS_NETWORK_PRESETS = Object.freeze(
    builtins.map((preset) => Object.freeze({ ...preset, settings: Object.freeze(preset.settings) }))
);

/** History scope stays independent of presets, including when reading older saved views. */
function presetSettings(settings) {
    const view = normalizeFriendsNetworkSettings(settings);
    delete view.days;
    delete view.dateFrom;
    delete view.dateTo;
    return view;
}

/** Reset view controls consistently, while preserving the independently selected history window. */
export function applyFriendsNetworkPreset(preset, current = createDefaultFriendsNetworkSettings()) {
    const window = normalizeFriendsNetworkSettings(current);
    return normalizeFriendsNetworkSettings({
        ...presetSettings(preset.settings),
        days: window.days,
        dateFrom: window.dateFrom,
        dateTo: window.dateTo
    });
}

export function createFriendsNetworkPreset(name, settings, id = '') {
    const trimmed = name.trim().slice(0, 120);
    if (!trimmed) {
        throw new Error('A preset name is required.');
    }
    const random = new Uint32Array(4);
    if (!id) {
        globalThis.crypto.getRandomValues(random);
    }
    const uniqueId = id || `user:${Array.from(random, (value) => value.toString(16).padStart(8, '0')).join('')}`;
    if (uniqueId.startsWith('builtin:')) {
        throw new Error('Built-in presets cannot be replaced.');
    }
    return { id: uniqueId, name: trimmed, settings: presetSettings(settings) };
}

/** Ignore malformed preference records without ever presenting a default as deletable. */
export function validFriendsNetworkPresets(presets = []) {
    const seen = new Set();
    const records = Array.isArray(presets) ? presets : [];
    return records.filter((preset) => {
        if (
            !preset ||
            typeof preset.id !== 'string' ||
            !preset.id.trim() ||
            preset.id.startsWith('builtin:') ||
            seen.has(preset.id)
        ) {
            return false;
        }
        if (
            typeof preset.name !== 'string' ||
            !preset.name.trim() ||
            typeof preset.settings !== 'object' ||
            preset.settings === null ||
            Array.isArray(preset.settings)
        ) {
            return false;
        }
        seen.add(preset.id);
        return true;
    });
}
