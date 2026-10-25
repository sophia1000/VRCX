import { normalizeAnalysisSettings } from '@/services/friendsNetwork/scoring';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultFriendsNetworkSettings, normalizeFriendsNetworkSettings } from '../friendsNetworkSettings';
const service = vi.hoisted(() => ({ graph: vi.fn(), status: vi.fn(), cancel: vi.fn(), people: vi.fn() }));
vi.mock('@/services/friendsNetwork/service', () => ({ default: service }));

import {
    cancelFriendsNetwork,
    readFriendsNetworkPeople,
    readFriendsNetworkStatus,
    requestFriendsNetwork,
    toFriendsNetworkRequest
} from '../friendsNetworkApi';

describe('friends network service options', () => {
    it('requires explicit runtime scope and ignores obsolete saved account selections', () => {
        const settings = { ...createDefaultFriendsNetworkSettings(), account: 'old-account', friendsOnly: false };
        const request = toFriendsNetworkRequest(settings, {
            current_user_id: 'current-account',
            friend_ids: ['a', 'b']
        });
        expect(request).toMatchObject({
            current_user_id: 'current-account',
            friend_ids: ['a', 'b'],
            days: 90
        });
        expect(request).not.toHaveProperty('account_ids');
        expect(request).not.toHaveProperty('friends_only');
        expect(toFriendsNetworkRequest(settings)).toMatchObject({ current_user_id: '', friend_ids: [] });
        expect(request).not.toHaveProperty('_revision');
    });

    it('maps UI scoring names without sending layout preferences', () => {
        const settings = {
            ...createDefaultFriendsNetworkSettings(),
            weighting: 'minutes',
            topK: 6,
            backboneThreshold: 0.1,
            edgeSelection: 'bilateral'
        };
        const request = toFriendsNetworkRequest(settings);
        expect(request).toMatchObject({
            weighting: 'time',
            top_k: 6,
            backbone_threshold: 0.1,
            edge_selection: 'mutual'
        });
        expect(request).not.toHaveProperty('groupSpacing');
        expect(request).not.toHaveProperty('labels');
    });

    it('passes plain options to the service for refresh and explicit rebuild', async () => {
        const result = { nodes: [], links: [] };
        service.graph.mockResolvedValue(result);
        const settings = createDefaultFriendsNetworkSettings();
        expect(await requestFriendsNetwork(settings)).toBe(result);
        await requestFriendsNetwork(settings, true);
        expect(service.graph).toHaveBeenCalledWith(toFriendsNetworkRequest(settings), false);
        expect(service.graph).toHaveBeenCalledWith(toFriendsNetworkRequest(settings), true);
    });

    it('reads progress and people without serializing payloads and accepts synchronous cancellation', async () => {
        const status = { stage: 'reading', progress: 0.25 };
        const people = { users: [{ id: 'usr_example', name: 'Example' }] };
        service.status.mockReturnValue(status);
        service.people.mockResolvedValue(people);
        service.cancel.mockReturnValue(undefined);
        expect(readFriendsNetworkStatus()).toBe(status);
        expect(
            await readFriendsNetworkPeople({ current_user_id: 'current-account', friend_ids: ['usr_example'] })
        ).toBe(people);
        expect(service.people).toHaveBeenCalledWith({
            current_user_id: 'current-account',
            friend_ids: ['usr_example']
        });
        await expect(cancelFriendsNetwork()).resolves.toBeUndefined();
        expect(service.cancel).toHaveBeenCalledOnce();
    });

    it('reports service failures and preserves cancelled results', async () => {
        const settings = createDefaultFriendsNetworkSettings();
        service.graph.mockRejectedValueOnce(new Error('History read failed'));
        await expect(requestFriendsNetwork(settings)).rejects.toThrow('History read failed');
        service.graph.mockResolvedValueOnce({ cancelled: true });
        expect(await requestFriendsNetwork(settings)).toEqual({ cancelled: true });
    });
});

// Exercise both public paths so drift between restored preferences and worker
// validation cannot silently change the effective controls.
it('uses the same scoring defaults and numeric limits in preferences and analysis', () => {
    const request = toFriendsNetworkRequest(createDefaultFriendsNetworkSettings());
    expect(normalizeAnalysisSettings().settings).toMatchObject(request);
    const restored = normalizeFriendsNetworkSettings({ resolution: 99, minEncounters: -10, maxNodes: 99999 });
    const direct = normalizeAnalysisSettings({ resolution: 99, min_encounters: -10, max_nodes: 99999 }).settings;
    expect(toFriendsNetworkRequest(restored)).toMatchObject({ resolution: 5, min_encounters: 1, max_nodes: 10000 });
    expect(direct).toMatchObject({
        resolution: restored.resolution,
        min_encounters: restored.minEncounters,
        max_nodes: restored.maxNodes
    });
});
