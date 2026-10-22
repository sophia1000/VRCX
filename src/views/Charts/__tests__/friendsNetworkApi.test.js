import { describe, expect, it, vi } from 'vitest';
import { createDefaultFriendsNetworkSettings } from '../friendsNetworkSettings';
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
        const request = toFriendsNetworkRequest(settings, 12, {
            current_user_id: 'current-account',
            friend_ids: ['b', 'a', 'a', 'current-account']
        });
        expect(request).toMatchObject({
            current_user_id: 'current-account',
            friend_ids: ['a', 'b'],
            _revision: 12,
            days: 90
        });
        expect(request).not.toHaveProperty('account_ids');
        expect(request).not.toHaveProperty('friends_only');
        expect(toFriendsNetworkRequest(settings, 13)).toMatchObject({ current_user_id: '', friend_ids: [] });
    });

    it('maps UI scoring names without sending layout preferences', () => {
        const settings = {
            ...createDefaultFriendsNetworkSettings(),
            weighting: 'minutes',
            topK: 6,
            backboneThreshold: 0.1,
            edgeSelection: 'bilateral'
        };
        const request = toFriendsNetworkRequest(settings, 1);
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
        expect(await requestFriendsNetwork(settings, 1)).toBe(result);
        await requestFriendsNetwork(settings, 2, true);
        expect(service.graph).toHaveBeenCalledWith(toFriendsNetworkRequest(settings, 1), false);
        expect(service.graph).toHaveBeenCalledWith(toFriendsNetworkRequest(settings, 2), true);
    });

    it('reads progress and people without serializing payloads and accepts synchronous cancellation', async () => {
        const status = { stage: 'reading', progress: 0.25, busy: true };
        const people = { users: [{ id: 'usr_example', name: 'Example' }] };
        service.status.mockReturnValue(status);
        service.people.mockResolvedValue(people);
        service.cancel.mockReturnValue(undefined);
        expect(await readFriendsNetworkStatus()).toBe(status);
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
        service.graph.mockResolvedValueOnce({ error: 'History read failed' });
        await expect(requestFriendsNetwork(settings, 1)).rejects.toThrow('History read failed');
        service.graph.mockResolvedValueOnce({ cancelled: true });
        expect(await requestFriendsNetwork(settings, 2)).toEqual({ cancelled: true });
    });
});
