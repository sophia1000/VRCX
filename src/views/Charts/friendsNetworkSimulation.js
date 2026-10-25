import { forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force';
import { friendsNetworkNodeRadius, friendsNetworkStrength } from './friendsNetworkAppearance';

const GOLDEN_ANGLE = 2.399963;

/** Create the shared simulation for initial layout and live dragging. */
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
    // Reserve each group's likely settled footprint, including larger circles.
    // Walk one shared spiral until that footprint clears the earlier groups.
    const orderedGroups = [...groups.values()].sort(
        (a, b) => b.nodes.length - a.nodes.length || String(a.id).localeCompare(String(b.id))
    );
    const groupGap = 80 + (settings.groupSpacing / 100) * 180;
    const placedGroups = [];
    let spiralIndex = 0;
    for (const group of orderedGroups) {
        const largestNode = group.nodes.reduce((radius, node) => Math.max(radius, node.radius), 0);
        group.radius = Math.max(40, 18 * Math.sqrt(group.nodes.length) + largestNode);
        do {
            const angle = spiralIndex * GOLDEN_ANGLE;
            const radius = groupGap * Math.sqrt(spiralIndex++);
            group.x = Math.cos(angle) * radius;
            group.y = Math.sin(angle) * radius;
        } while (
            placedGroups.some(
                (other) => Math.hypot(group.x - other.x, group.y - other.y) < group.radius + other.radius + groupGap
            )
        );
        placedGroups.push(group);
    }
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
    const shelfY = orderedGroups.length ? Math.max(...orderedGroups.map((group) => group.y + group.radius)) + 120 : 0;
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
                .distance((link) => {
                    const distance = 34 + 65 * (1 - friendsNetworkStrength(link));
                    if (link.source.community === link.target.community) {
                        return distance;
                    }
                    // Links between circles need room to span both groups;
                    // a short internal-link distance would pull them together again.
                    return (
                        distance + groups.get(link.source.community).radius + groups.get(link.target.community).radius
                    );
                })
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
