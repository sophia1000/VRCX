import { forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force';
import { friendsNetworkNodeRadius, friendsNetworkStrength } from './friendsNetworkAppearance';

const GOLDEN_ANGLE = 2.399963;

/** Restore Circles' original force distances, group targets and observation-sized nodes. */
export function createFriendsNetworkSimulation(graph, settings, warmPositions = {}) {
    // Copy graph attributes into the simulation's mutable nodes and links.
    const hasWarmPosition = (id) =>
        !settings.reinitialize && Number.isFinite(warmPositions[id]?.x) && Number.isFinite(warmPositions[id]?.y);
    const nodes = graph.mapNodes((id, attributes) => ({
        ...attributes,
        id,
        radius: friendsNetworkNodeRadius(attributes)
    }));
    const links = graph.mapEdges((_id, attributes, source, target) => ({ ...attributes, source, target }));
    const groups = new Map();
    const isolatedNodes = [];
    for (const node of nodes) {
        if (!graph.degree(node.id)) {
            isolatedNodes.push(node);
            continue;
        }
        if (!groups.has(node.community)) {
            groups.set(node.community, { id: node.community, nodes: [] });
        }
        groups.get(node.community).nodes.push(node);
    }
    // Arrange group targets along the spiral, then center those targets.
    const orderedGroups = [...groups.values()].sort(
        (a, b) => b.nodes.length - a.nodes.length || String(a.id).localeCompare(String(b.id))
    );
    const groupSpacingStep = 80 + (settings.groupSpacing / 100) * 180;
    orderedGroups.forEach((group, index) => {
        const radius = orderedGroups.length === 1 ? 0 : groupSpacingStep * Math.sqrt(index + 0.3);
        group.x = Math.cos(index * GOLDEN_ANGLE) * radius;
        group.y = Math.sin(index * GOLDEN_ANGLE) * radius;
    });
    const centerX = orderedGroups.reduce((sum, group) => sum + group.x, 0) / (orderedGroups.length || 1);
    const centerY = orderedGroups.reduce((sum, group) => sum + group.y, 0) / (orderedGroups.length || 1);
    for (const group of orderedGroups) {
        group.x -= centerX;
        group.y -= centerY;
        group.nodes.forEach((node, index) => {
            node.targetX = group.x;
            node.targetY = group.y;
            if (!hasWarmPosition(node.id)) {
                const radius = 8 * Math.sqrt(index);
                node.x = group.x + Math.cos(index * GOLDEN_ANGLE) * radius;
                node.y = group.y + Math.sin(index * GOLDEN_ANGLE) * radius;
            }
        });
    }
    // Unconnected people occupy a shelf instead of expanding the group spiral.
    const columns = Math.max(8, Math.ceil(Math.sqrt(isolatedNodes.length) * 1.8));
    const shelfY = orderedGroups.length
        ? Math.max(...orderedGroups.map((group) => group.y + Math.sqrt(group.nodes.length) * 11)) + 120
        : 0;
    isolatedNodes
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
        .forEach((node, index) => {
            node.targetX = ((index % columns) - (Math.min(columns, isolatedNodes.length) - 1) / 2) * 24;
            node.targetY = shelfY + Math.floor(index / columns) * 24;
            if (!hasWarmPosition(node.id)) {
                node.x = node.targetX;
                node.y = node.targetY;
            }
        });

    // Create a stopped simulation. The layout and drag controllers advance it.
    const groupPullStrength = 0.012 + (settings.groupTightness / 100) * 0.095;
    const simulation = forceSimulation(nodes)
        .stop()
        .alpha(Object.keys(warmPositions).length ? 0.35 : 1)
        .alphaDecay(0.032)
        .velocityDecay(0.4)
        .force(
            'link',
            forceLink(links)
                .id((node) => node.id)
                .distance((link) => 34 + 65 * (1 - friendsNetworkStrength(link)))
                .strength(
                    (link) =>
                        (0.025 + 0.1 * friendsNetworkStrength(link)) *
                        (link.source.community === link.target.community ? 1 : settings.betweenGroupPull / 100)
                )
        )
        .force(
            'charge',
            forceManyBody()
                .strength(-42 * Math.max(0.1, settings.layoutSpacing / 60))
                .distanceMax(420)
                .theta(1.05)
        )
        .force('collision', forceCollide((node) => node.radius + 4).iterations(1))
        .force('circles', (alpha) => {
            for (const node of nodes) {
                node.vx += (node.targetX - node.x) * groupPullStrength * alpha;
                node.vy += (node.targetY - node.y) * groupPullStrength * alpha;
            }
        });
    return { simulation, nodes };
}
