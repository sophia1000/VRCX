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
        expect(await readFriendsNetworkPeople()).toBe(people);
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
