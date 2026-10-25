// Preserve Circles' graph colors independently of the surrounding VRCX theme.
export const FRIENDS_NETWORK_COLORS = Object.freeze([
    '#61d4c4',
    '#8d9fee',
    '#d9ab6a',
    '#c28bd6',
    '#6eb6de',
    '#a8c779',
    '#de8f9c',
    '#86c5b5',
    '#b2a2dc',
    '#d6bf81',
    '#7dacc5',
    '#d8a5cb'
]);

/** Use the full graph's community order so filtering one circle does not recolor it. */
export function friendsNetworkCommunityStyles(nodes, communities = []) {
    const groups = new Map(communities.map((group) => [group.id, { ...group }]));
    for (const node of nodes) {
        if (!groups.has(node.community)) {
            groups.set(node.community, { id: node.community, size: 0 });
        }
        if (!communities.length) {
            groups.get(node.community).size++;
        }
    }
    const orderedGroups = [...groups.values()].sort((a, b) => b.size - a.size || Number(a.id) - Number(b.id));
    return new Map(
        orderedGroups.map((group, index) => [
            group.id,
            {
                ...group,
                color: FRIENDS_NETWORK_COLORS[index % FRIENDS_NETWORK_COLORS.length]
            }
        ])
    );
}

// Node sizes, edge strengths and membership colors

export function friendsNetworkNodeRadius(node) {
    return 3.7 + Math.min(5.6, Math.sqrt(Math.max(0, node.encounters || node.join_count || 0)) * 0.33);
}

export function friendsNetworkStrength(link) {
    const strength = Number.isFinite(link.strength) ? link.strength : Math.log1p(Number(link.weight) || 0) / 8;
    return Math.min(1, Math.max(0, strength));
}

/** A continuous cool-to-warm scale for the final normalized connection score. */
export function friendsNetworkWeightColor(strength) {
    const value = Math.min(1, Math.max(0, strength));
    const blue = [59, 130, 246];
    const red = [239, 68, 68];
    const channels = blue.map((channel, index) => Math.round(channel + (red[index] - channel) * value));
    return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** The original ring displays up to three significant memberships around a person. */
export function friendsNetworkMemberships(node, communities) {
    return (node.memberships || [])
        .filter((membership) => Number.isFinite(membership.score) && membership.score >= 0.1)
        .slice(0, 3)
        .map((membership) => ({
            ...membership,
            color: communities.get(membership.community)?.color || '#75899b'
        }));
}

/** Draw membership arcs with a fixed screen-space gap and stroke width. */
export function drawFriendsNetworkMemberships(context, node, communities, zoom) {
    const memberships = friendsNetworkMemberships(node, communities);
    if (memberships.length < 2) {
        return;
    }
    const total = memberships.reduce((sum, membership) => sum + membership.score, 0);
    let angle = -Math.PI / 2;
    context.lineWidth = 1.8 / zoom;
    for (const membership of memberships) {
        const end = angle + (membership.score / total) * Math.PI * 2;
        context.strokeStyle = membership.color;
        context.beginPath();
        context.arc(node.x, node.y, node.radius + 3 / zoom, angle + 0.04, end - 0.04);
        context.stroke();
        angle = end;
    }
}

/**
 * Sigma draws people, connections and labels. This overlay only adds the
 * observation-specific membership rings, soft group fields and drag handles.
 * Its coordinates come from Sigma so every decoration follows the same camera.
 */
export function drawFriendsNetworkOverlay(view) {
    const { context, canvas, sigma, settings, communities } = view;
    // Match Sigma's viewport while keeping canvas strokes sharp on high-DPI displays.
    const { width, height } = sigma.getDimensions();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * pixelRatio);
    const pixelHeight = Math.round(height * pixelRatio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    const zoom = sigma.getGraphToViewportRatio();
    const focus = view.selectedId || view.hoveredId;
    // Hidden groups have no label hit targets. Shift-dragging a person still
    // moves their circle, independently of these decorations.
    view.groupHandles = [];
    for (const group of settings.showGroups ? view.groups : []) {
        const x = group.nodes.reduce((sum, node) => sum + node.x, 0) / group.nodes.length;
        const y = group.nodes.reduce((sum, node) => sum + node.y, 0) / group.nodes.length;
        const radius =
            Math.max(
                48,
                (group.nodes.reduce((sum, node) => sum + Math.hypot(node.x - x, node.y - y), 0) / group.nodes.length) *
                    1.7
            ) * zoom;
        const center = view.toViewport({ x, y });
        if (group.nodes.length >= 3 && radius > 0) {
            const gradient = context.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
            gradient.addColorStop(0, `${group.color}0b`);
            gradient.addColorStop(0.65, `${group.color}06`);
            gradient.addColorStop(1, `${group.color}00`);
            context.fillStyle = gradient;
            context.beginPath();
            context.arc(center.x, center.y, radius, 0, Math.PI * 2);
            context.fill();
        }
        if (group.nodes.length >= 6 && zoom > 0.3) {
            const label = `${group.label} · ${group.nodes.length}`;
            context.font = '10px "Segoe UI", sans-serif';
            context.textAlign = 'center';
            const width = context.measureText(label).width + 12;
            const baseline = center.y - radius - 8;
            const handle = { group, x: center.x - width / 2, y: baseline - 11, width, height: 16 };
            view.groupHandles.push(handle);
            context.fillStyle = view.dark ? '#171717e8' : '#fffffff0';
            context.fillRect(handle.x, handle.y, width, handle.height);
            context.fillStyle = view.dark ? '#9fb3c4' : '#536579';
            context.fillText(label, center.x, baseline);
        }
    }
    // Add rings and selection outlines at Sigma's projected node positions.
    for (const node of view.nodes) {
        const point = view.toViewport(node);
        const radius = sigma.scaleSize(node.radius);
        if (point.x + radius < 0 || point.x - radius > width || point.y + radius < 0 || point.y - radius > height) {
            continue;
        }
        const dimmed = focus && focus !== node.id && !view.neighbors.get(focus)?.has(node.id);
        if (node.is_friend && zoom > 0.65) {
            context.globalAlpha = dimmed ? 0.08 : 0.45;
            context.strokeStyle = '#d8f1ea';
            context.lineWidth = 0.55;
            context.beginPath();
            context.arc(point.x, point.y, radius, 0, Math.PI * 2);
            context.stroke();
        }
        context.globalAlpha = 1;
        if (settings.showMemberships && !dimmed) {
            drawFriendsNetworkMemberships(context, { ...node, ...point, radius }, communities, 1);
        }
        if (focus === node.id) {
            context.strokeStyle = communities.get(node.community)?.color || FRIENDS_NETWORK_COLORS[0];
            context.lineWidth = 1.3;
            context.beginPath();
            context.arc(point.x, point.y, radius + 6, 0, Math.PI * 2);
            context.stroke();
        }
    }
}
