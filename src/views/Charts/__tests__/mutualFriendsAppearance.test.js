import { afterAll, describe, expect, it, vi } from 'vitest';
import Graph from 'graphology';

// The real style evaluator needs only WebGL enum values, not a GPU context.
vi.stubGlobal('WebGL2RenderingContext', { UNSIGNED_BYTE: 5121, FLOAT: 5126 });
const { evaluateNodeStyle, evaluateEdgeStyle } = await import('sigma/types');
const { createMutualFriendsAppearance } = await import('../mutualFriendsAppearance');
afterAll(() => vi.unstubAllGlobals());

describe('Sigma v4 mutual graph appearance', () => {
    const graph = new Graph();
    const attributes = { x: 10, y: 20, size: 8, color: '#5470c6', label: 'Friend', degree: 12 };

    it.each([false, true])('preserves colors, hover counts and neighbor emphasis with dark=%s', (dark) => {
        const options = createMutualFriendsAppearance({ dark, fetchedText: () => '' });
        const node = (state, active = false, attrs = attributes) =>
            evaluateNodeStyle(options.styles.nodes, attrs, state, { hasActiveSubgraph: active }, graph);
        expect(node({})).toMatchObject({ color: '#5470c6', size: 8, label: 'Friend', opacity: 1 });
        expect(node({ isNeighbor: true }, true)).toMatchObject({ size: 9.6, label: 'Friend', opacity: 1 });
        expect(node({}, true)).toMatchObject({ size: 0.7, labelVisibility: 'hidden', opacity: dark ? 0.04 : 0.06 });
        expect(node({ isHovered: true }, true)).toMatchObject({
            color: '#facc15',
            size: 12.8,
            label: 'Friend (12)',
            labelVisibility: 'visible',
            labelAttachment: 'fetched',
            backdropVisibility: 'visible'
        });
        expect(node({}, false, { ...attributes, optedOut: true }).color).toBe('#d1d5db');
    });

    it('keeps straight and curved paths and hides only unrelated edges during hover', () => {
        const options = createMutualFriendsAppearance({ dark: true, fetchedText: () => '' });
        const edge = (path, highlighted = false, active = false) =>
            evaluateEdgeStyle(
                options.styles.edges,
                { path },
                { isHighlighted: highlighted },
                { hasActiveSubgraph: active },
                graph
            );
        expect(edge('straight')).toMatchObject({ path: 'straight', visibility: 'visible', color: '#334155' });
        expect(edge('curved')).toMatchObject({ path: 'curved', visibility: 'visible' });
        expect(edge('curved', false, true).visibility).toBe('hidden');
        expect(edge('curved', true, true)).toMatchObject({ visibility: 'visible', color: '#bac1c9' });
    });
});
