import { describe, expect, it, vi } from 'vitest';
import { createDefaultFriendsNetworkSettings } from '../friendsNetworkSettings';
import { requestFriendsNetwork, toFriendsNetworkRequest } from '../friendsNetworkApi';

describe('friends network native options', () => {
    it('uses all accounts by default and maps explicit account selection', () => {
        const settings = createDefaultFriendsNetworkSettings();
        expect(toFriendsNetworkRequest(settings, 12)).toMatchObject({ account_ids: [], _revision: 12, days: 90 });
        expect(toFriendsNetworkRequest({ ...settings, account: 'usr_example' }, 13).account_ids).toEqual([
            'usr_example'
        ]);
    });

    it('maps UI scoring names without sending layout preferences', () => {
        const settings = {
            ...createDefaultFriendsNetworkSettings(),
            weighting: 'minutes',
            topK: 6,
            edgeSelection: 'bilateral'
        };
        const request = toFriendsNetworkRequest(settings, 1);
        expect(request).toMatchObject({ weighting: 'time', top_k: 6, edge_selection: 'mutual' });
        expect(request).not.toHaveProperty('groupSpacing');
        expect(request).not.toHaveProperty('labels');
    });

    it('uses the existing AppApi bridge for refresh and explicit rebuild', async () => {
        const graph = vi.fn().mockResolvedValue('{"nodes":[],"links":[]}');
        const rebuild = vi.fn().mockResolvedValue('{"nodes":[],"links":[]}');
        vi.stubGlobal('AppApi', { FriendsNetworkGraph: graph, FriendsNetworkRebuild: rebuild });
        try {
            const settings = createDefaultFriendsNetworkSettings();
            await requestFriendsNetwork(settings, 1);
            await requestFriendsNetwork(settings, 2, true);
            expect(graph).toHaveBeenCalledOnce();
            expect(rebuild).toHaveBeenCalledOnce();
            expect(JSON.parse(rebuild.mock.calls[0][0])._revision).toBe(2);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
