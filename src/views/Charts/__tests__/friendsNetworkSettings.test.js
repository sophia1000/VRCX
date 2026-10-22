import { describe, expect, it } from 'vitest';
import {
    applyFriendsNetworkPreset,
    createDefaultFriendsNetworkSettings,
    createFriendsNetworkPreset,
    FRIENDS_NETWORK_PRESETS,
    normalizeFriendsNetworkSettings,
    validFriendsNetworkPresets
} from '../friendsNetworkSettings';

describe('friends network presets and persisted preferences', () => {
    it('offers seven independent defaults and resets unrelated settings when applying one', () => {
        expect(FRIENDS_NETWORK_PRESETS).toHaveLength(7);
        const first = applyFriendsNetworkPreset(FRIENDS_NETWORK_PRESETS[0]);
        first.worldFilter = 'temporary filter';
        const restored = applyFriendsNetworkPreset(FRIENDS_NETWORK_PRESETS[0]);
        expect(restored.worldFilter).toBe('');
        expect(restored).not.toHaveProperty('account');
        expect(restored).not.toHaveProperty('friendsOnly');
    });

    it('keeps every preset independent of relative, all-history, and custom date windows', () => {
        const windows = [
            { days: 365, dateFrom: '', dateTo: '' },
            { days: null, dateFrom: '', dateTo: '' },
            { days: null, dateFrom: '2026-01-01', dateTo: '2026-04-30' }
        ];
        const legacy = { settings: { days: 30, dateFrom: '2020-01-01', dateTo: '', topK: 5 } };
        for (const window of windows) {
            const current = { ...createDefaultFriendsNetworkSettings(), ...window };
            for (const preset of [...FRIENDS_NETWORK_PRESETS, legacy]) {
                expect(applyFriendsNetworkPreset(preset, current)).toMatchObject(window);
            }
            const saved = createFriendsNetworkPreset('Saved', current, 'user:saved');
            expect(saved.settings).not.toHaveProperty('days');
            expect(saved.settings).not.toHaveProperty('dateFrom');
            expect(saved.settings).not.toHaveProperty('dateTo');
        }
    });

    it('restores the original close-knit and small-gathering scoring choices', () => {
        expect(
            applyFriendsNetworkPreset(FRIENDS_NETWORK_PRESETS.find((preset) => preset.nameKey === 'close'))
        ).toMatchObject({ relativeCloseness: 0.65, topK: 6, edgeSelection: 'bilateral', groupSpacing: 85 });
        expect(
            applyFriendsNetworkPreset(FRIENDS_NETWORK_PRESETS.find((preset) => preset.nameKey === 'small'))
        ).toMatchObject({ crowdMode: 'concurrent', crowdExponent: 1, minOverlapMinutes: 5 });
    });

    it('keeps the backbone disabled for existing settings and every built-in view', () => {
        expect(createDefaultFriendsNetworkSettings().backboneThreshold).toBe(1);
        expect(normalizeFriendsNetworkSettings({ topK: 8 }).backboneThreshold).toBe(1);
        for (const preset of FRIENDS_NETWORK_PRESETS) {
            expect(applyFriendsNetworkPreset(preset, { backboneThreshold: 0.05 }).backboneThreshold).toBe(1);
        }
    });

    it('saves the backbone threshold while keeping the history window independent', () => {
        const settings = {
            ...createDefaultFriendsNetworkSettings(),
            backboneThreshold: 0.05,
            days: null,
            dateFrom: '2026-01-01',
            dateTo: '2026-02-01'
        };
        const preset = createFriendsNetworkPreset('Distinctive connections', settings, 'user:backbone');
        expect(preset.settings.backboneThreshold).toBe(0.05);
        expect(applyFriendsNetworkPreset(preset, { days: 365 })).toMatchObject({ backboneThreshold: 0.05, days: 365 });
        expect(normalizeFriendsNetworkSettings({ backboneThreshold: '0.2' }).backboneThreshold).toBe(0.2);
        expect(normalizeFriendsNetworkSettings({ backboneThreshold: -1 }).backboneThreshold).toBe(0);
        expect(normalizeFriendsNetworkSettings({ backboneThreshold: 3 }).backboneThreshold).toBe(1);
        expect(normalizeFriendsNetworkSettings({ backboneThreshold: 'invalid' }).backboneThreshold).toBe(1);
    });

    it('ignores obsolete account preferences and bounds corrupt numeric preferences', () => {
        const normalized = normalizeFriendsNetworkSettings({
            account: 'usr_example',
            friendsOnly: false,
            topK: -100,
            hubDamping: 3
        });
        expect(normalized).not.toHaveProperty('account');
        expect(normalized).not.toHaveProperty('friendsOnly');
        const preset = createFriendsNetworkPreset(
            'Legacy',
            { account: 'old-account', friendsOnly: false },
            'user:legacy'
        );
        expect(preset.settings).not.toHaveProperty('account');
        expect(preset.settings).not.toHaveProperty('friendsOnly');
        expect(normalized.topK).toBe(0);
        expect(normalized.hubDamping).toBe(1);
    });

    it('copies user presets and never accepts built-in records as deletable saved presets', () => {
        const settings = createDefaultFriendsNetworkSettings();
        const preset = createFriendsNetworkPreset('  Weekend  ', settings, 'user:weekend');
        settings.topK = 2;
        expect(preset.name).toBe('Weekend');
        expect(preset.settings.topK).toBe(12);
        expect(validFriendsNetworkPresets([preset, preset, ...FRIENDS_NETWORK_PRESETS, null])).toEqual([preset]);
        expect(() => createFriendsNetworkPreset('Broken', settings, 'builtin:balanced')).toThrow();
    });
});
