import { layerBorder } from '@sigma/node-border';
import { layerFill, pathCurved, pathLine } from 'sigma/rendering';

/**
 * Keep the original mutual graph's appearance on Sigma's native v4 renderer.
 *
 * @returns {import('sigma/types').SigmaOptions<
 *     any,
 *     any,
 *     any,
 *     { isNeighbor: boolean },
 *     {},
 *     { hasActiveSubgraph: boolean }
 * >}
 */
export function createMutualFriendsAppearance({ dark, fetchedText }) {
    const edgeColor = dark ? '#334155' : '#94a3b8';
    const activeEdgeColor = dark ? '#bac1c9' : '#0f172a';

    return {
        settings: {
            allowInvalidContainer: true,
            itemSizesReference: 'screen',
            renderLabels: true,
            labelRenderedSizeThreshold: 10
        },
        customNodeState: { isNeighbor: false },
        customGraphState: { hasActiveSubgraph: false },
        primitives: {
            nodes: {
                layers: [
                    layerFill(),
                    layerBorder({
                        borders: [
                            { size: 0.1, color: '#f2f2f2' },
                            { size: 0, fill: true, color: 'transparent' }
                        ]
                    })
                ],
                // Sigma places this small second line below the hovered label.
                // Canvas text keeps display names and translated text out of HTML.
                labelAttachments: {
                    fetched: ({ attributes }) => {
                        const text = fetchedText(attributes);
                        if (!text) {
                            return null;
                        }
                        const canvas = document.createElement('canvas');
                        const context = canvas.getContext('2d');
                        const font = '12px sans-serif';
                        context.font = font;
                        canvas.width = Math.ceil(context.measureText(text).width) + 2;
                        canvas.height = 18;
                        context.font = font;
                        context.fillStyle = attributes.optedOut ? '#dc2626' : '#6b7280';
                        context.fillText(text, 0, 13);
                        return { type: 'canvas', canvas };
                    }
                }
            },
            edges: { paths: [pathLine(), pathCurved({ curvature: { attribute: 'curvature' } })] }
        },
        styles: {
            nodes: [
                {
                    size: { attribute: 'size' },
                    color: (attributes) => (attributes.optedOut ? '#d1d5db' : attributes.color),
                    label: { attribute: 'label' },
                    labelColor: dark ? '#e2e8f0' : '#111827',
                    backdropVisibility: 'hidden'
                },
                {
                    when: (_attributes, state, graphState) =>
                        graphState.hasActiveSubgraph && !state.isHovered && !state.isNeighbor,
                    then: { opacity: dark ? 0.04 : 0.06, size: 0.7, labelVisibility: 'hidden' }
                },
                {
                    whenState: 'isNeighbor',
                    then: { size: (attributes) => attributes.size * 1.2, labelColor: '#111827' }
                },
                {
                    whenState: 'isHovered',
                    then: {
                        color: '#facc15',
                        size: (attributes) => attributes.size * 1.6,
                        label: (attributes) => `${attributes.label} (${attributes.degree})`,
                        labelColor: '#111827',
                        labelVisibility: 'visible',
                        depth: 'topNodes',
                        backdropVisibility: 'visible',
                        backdropColor: '#ffffff',
                        backdropShadowColor: 'rgba(0, 0, 0, 0.25)',
                        backdropShadowBlur: 6,
                        backdropPadding: 6,
                        labelAttachment: 'fetched',
                        labelAttachmentPlacement: 'below'
                    }
                }
            ],
            edges: [
                { size: { attribute: 'size', defaultValue: 1 }, color: edgeColor, path: { attribute: 'path' } },
                {
                    when: (_attributes, _state, graphState) => graphState.hasActiveSubgraph,
                    then: { visibility: 'hidden' }
                },
                { whenState: 'isHighlighted', then: { visibility: 'visible', color: activeEdgeColor } }
            ]
        }
    };
}
