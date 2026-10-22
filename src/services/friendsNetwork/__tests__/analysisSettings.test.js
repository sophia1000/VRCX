import { describe, expect, it } from 'vitest';
import { normalizeAnalysisSettings, normalizeFriendsNetworkScope } from '../scoring';

describe('live friends network scope', () => {
    it('normalizes authoritative friend IDs and ignores obsolete snapshot selectors', () => {
        const { settings } = normalizeAnalysisSettings({
            current_user_id: ' owner ',
            friend_ids: ['b', 'a', 'b', 'owner', '', null],
            account_ids: ['another-account'],
            friends_only: false
        });
        expect(settings.current_user_id).toBe('owner');
        expect(settings.friend_ids).toEqual(['a', 'b']);
        expect(settings).not.toHaveProperty('account_ids');
        expect(settings).not.toHaveProperty('friends_only');
    });

    it('never infers friends when login context or the friend list is absent', () => {
        expect(normalizeFriendsNetworkScope()).toEqual({ current_user_id: '', friend_ids: [] });
        expect(normalizeFriendsNetworkScope({ friend_ids: ['a'] }).friend_ids).toEqual([]);
        expect(normalizeFriendsNetworkScope({ current_user_id: 'owner' }).friend_ids).toEqual([]);
        expect(normalizeFriendsNetworkScope({ current_user_id: 'owner', friend_ids: 'a' }).friend_ids).toEqual([]);
        expect(normalizeFriendsNetworkScope({ current_user_id: 'owner', friend_ids: [] }).friend_ids).toEqual([]);
    });
});

describe('analysis backbone settings', () => {
    it('defaults to disabled and bounds finite thresholds to the significance range', () => {
        expect(normalizeAnalysisSettings().settings.backbone_threshold).toBe(1);
        expect(normalizeAnalysisSettings({ backbone_threshold: '0.05' }).settings.backbone_threshold).toBe(0.05);
        expect(normalizeAnalysisSettings({ backbone_threshold: -1 }).settings.backbone_threshold).toBe(0);
        expect(normalizeAnalysisSettings({ backbone_threshold: 2 }).settings.backbone_threshold).toBe(1);
    });

    it('rejects nonfinite thresholds before any graph work', () => {
        for (const value of [NaN, Infinity, -Infinity, 'invalid']) {
            expect(() => normalizeAnalysisSettings({ backbone_threshold: value })).toThrow(
                'backbone_threshold must be finite'
            );
        }
    });
});
