import { describe, expect, it } from 'vitest';
import { detectCommunities, filterBackbone } from '../grouping';

const edge = (source, target, weight) => ({ source, target, weight });

describe('library community detection', () => {
    it('keeps weighted groups and isolated people deterministic across row order and edge direction', async () => {
        const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'isolated'];
        const links = [
            edge('a', 'b', 20),
            edge('a', 'c', 20),
            edge('b', 'c', 20),
            edge('d', 'e', 20),
            edge('d', 'f', 20),
            edge('e', 'f', 20),
            edge('c', 'd', 0.1)
        ];
        const expected = { a: 0, b: 0, c: 0, d: 1, e: 1, f: 1, isolated: 2 };
        expect(Object.fromEntries(await detectCommunities(ids, links, 1))).toEqual(expected);
        const reversed = links.map(({ source, target, weight }) => edge(target, source, weight)).reverse();
        expect(Object.fromEntries(await detectCommunities([...ids].reverse(), reversed, 1))).toEqual(expected);
    });

    it('uses resolution to separate a dense group while preserving distinct isolate labels', async () => {
        const links = [edge('a', 'b', 10), edge('a', 'c', 10), edge('b', 'c', 10)];
        const ids = ['a', 'b', 'c', 'x', 'y'];
        const broad = await detectCommunities(ids, links, 0.5);
        const detailed = await detectCommunities(ids, links, 5);
        expect(new Set(['a', 'b', 'c'].map((id) => broad.get(id))).size).toBe(1);
        expect(new Set(detailed.values()).size).toBe(ids.length);
        expect(broad.get('x')).not.toBe(broad.get('y'));
    });

    it('ignores invalid weights, self-links and missing people before calling the library', async () => {
        const links = [
            edge('b', 'a', 10),
            edge('a', 'c', 0),
            edge('a', 'd', -1),
            edge('a', 'c', NaN),
            edge('a', 'd', Infinity),
            edge('a', 'a', 10),
            edge('a', 'missing', 10)
        ];
        const labels = await detectCommunities(['a', 'b', 'c', 'd'], links, 1);
        expect(Object.fromEntries(labels)).toEqual({ a: 0, b: 0, c: 1, d: 2 });
    });

    it('checks cancellation immediately before and after the synchronous Louvain call', async () => {
        let forcedChecks = 0;
        const cancelled = new Error('cancelled');
        cancelled.name = 'AbortError';
        const checkpoint = async (force) => {
            if (force && ++forcedChecks === 2) {
                throw cancelled;
            }
        };
        await expect(detectCommunities(['a', 'b'], [edge('a', 'b', 10)], 1, checkpoint)).rejects.toBe(cancelled);
        expect(forcedChecks).toBe(2);
    });
});

describe('disparity backbone', () => {
    const ids = ['a', 'b', 'c'];
    const links = [edge('a', 'b', 9), edge('a', 'c', 1), edge('b', 'c', 1)];

    it('is disabled at one and retains edges significant to either endpoint below the threshold', async () => {
        expect(await filterBackbone(ids, links, 1)).toEqual(links);
        expect(await filterBackbone(ids, links, 0.2)).toEqual([links[0]]);
        expect(await filterBackbone(ids, links, 0.5)).toEqual(links);
        expect(await filterBackbone(ids, links, 0)).toEqual([]);
    });

    it('uses the library significance for dyads without special exemptions', async () => {
        const dyad = [edge('a', 'b', 9)];
        expect(await filterBackbone(['a', 'b'], dyad, 1)).toEqual(dyad);
        expect(await filterBackbone(['a', 'b'], dyad, 0.9)).toEqual([]);
    });

    it('supports empty graphs and rejects invalid weights from either path', async () => {
        expect(await filterBackbone([], [], 0.1)).toEqual([]);
        const invalid = [edge('a', 'b', 0), edge('a', 'b', Infinity), edge('a', 'a', 1)];
        expect(await filterBackbone(ids, invalid, 1)).toEqual([]);
        expect(await filterBackbone(ids, invalid, 0.1)).toEqual([]);
    });
});
