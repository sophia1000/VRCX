import { describe, expect, it, vi } from 'vitest';
import {
    drawFriendsNetworkMemberships,
    FRIENDS_NETWORK_COLORS,
    friendsNetworkStrength,
    friendsNetworkWeightColor,
    friendsNetworkCommunityStyles
} from '../friendsNetworkAppearance';

describe('Circles graph appearance', () => {
    it('maps zero to weak blue and full strength to strong red without changing node colors', () => {
        expect(friendsNetworkStrength({ weight: 100, strength: 0 })).toBe(0);
        expect(friendsNetworkWeightColor(0)).toBe('#3b82f6');
        expect(friendsNetworkWeightColor(1)).toBe('#ef4444');
        expect(friendsNetworkWeightColor(-2)).toBe('#3b82f6');
        expect(friendsNetworkWeightColor(4)).toBe('#ef4444');
        expect(friendsNetworkWeightColor(0.5)).not.toBe(friendsNetworkWeightColor(0));
    });
    it('keeps the original palette and group colors when a single circle is filtered', () => {
        const communities = [
            { id: 0, size: 100 },
            { id: 1, size: 20 }
        ];
        const full = friendsNetworkCommunityStyles([{ community: 0 }, { community: 1 }], communities);
        const filtered = friendsNetworkCommunityStyles([{ community: 1 }], communities);
        expect(FRIENDS_NETWORK_COLORS.slice(0, 3)).toEqual(['#61d4c4', '#8d9fee', '#d9ab6a']);
        expect(filtered.get(1).color).toBe(full.get(1).color);
    });

    it('draws proportional membership arcs in circle colors with zoom-independent strokes', () => {
        const colors = [];
        const context = {
            beginPath: vi.fn(),
            arc: vi.fn(),
            stroke: vi.fn(() => colors.push(context.strokeStyle)),
            strokeStyle: '',
            lineWidth: 0
        };
        const communities = friendsNetworkCommunityStyles(
            [],
            [
                { id: 0, size: 5 },
                { id: 1, size: 3 }
            ]
        );
        drawFriendsNetworkMemberships(
            context,
            {
                x: 10,
                y: 20,
                radius: 5,
                memberships: [
                    { community: 0, score: 0.6 },
                    { community: 1, score: 0.3 },
                    { community: 2, score: 0.09 }
                ]
            },
            communities,
            2
        );
        expect(colors).toEqual(['#61d4c4', '#8d9fee']);
        expect(context.lineWidth).toBe(0.9);
        expect(context.arc).toHaveBeenCalledTimes(2);
        const [first, second] = context.arc.mock.calls;
        expect(first.slice(0, 3)).toEqual([10, 20, 6.5]);
        expect(first[4] - first[3] + 0.08).toBeCloseTo((Math.PI * 2 * 2) / 3);
        expect(second[4] - second[3] + 0.08).toBeCloseTo((Math.PI * 2) / 3);
        context.arc.mockClear();
        drawFriendsNetworkMemberships(context, { memberships: [{ community: 0, score: 1 }] }, communities, 2);
        expect(context.arc).not.toHaveBeenCalled();
    });
});
