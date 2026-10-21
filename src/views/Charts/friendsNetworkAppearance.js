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
    const ordered = [...groups.values()].sort((a, b) => b.size - a.size || Number(a.id) - Number(b.id));
    return new Map(
        ordered.map((group, index) => [
            group.id,
            {
                ...group,
                color: FRIENDS_NETWORK_COLORS[index % FRIENDS_NETWORK_COLORS.length]
            }
        ])
    );
}

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

/** Canvas stays transparent: VRCX supplies the background in either theme. */
export function drawFriendsNetwork(view) {
    const { context, width, height, pixelRatio, transform, nodes, settings, communities } = view;
    const zoom = transform.k;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.translate(transform.x, transform.y);
    context.scale(zoom, zoom);
    const focus = view.nodesById.get(view.selectedId || view.hoveredId);
    const adjacent = focus ? new Set([focus.id, ...view.neighbors.get(focus.id)]) : null;

    drawCommunityFields(view);
    drawConnections(view, focus);
    for (const node of nodes) {
        const dimmed = adjacent && !adjacent.has(node.id);
        context.globalAlpha = dimmed ? 0.18 : 1;
        context.fillStyle = node.isolated
            ? '#6f8192'
            : communities.get(node.community)?.color || FRIENDS_NETWORK_COLORS[0];
        context.beginPath();
        context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        context.fill();
        if (node.is_friend && zoom > 0.65) {
            context.strokeStyle = '#d8f1ea';
            context.lineWidth = 0.55 / zoom;
            context.globalAlpha = dimmed ? 0.08 : 0.45;
            context.stroke();
        }
        context.globalAlpha = 1;
        if (settings.showMemberships && !dimmed) {
            drawFriendsNetworkMemberships(context, node, communities, zoom);
        }
        if (node === focus) {
            context.strokeStyle = communities.get(node.community)?.color || FRIENDS_NETWORK_COLORS[0];
            context.lineWidth = 1.3 / zoom;
            context.beginPath();
            context.arc(node.x, node.y, node.radius + 6 / zoom, 0, Math.PI * 2);
            context.stroke();
        }
    }
    if (settings.labels) {
        drawNames(view, focus, adjacent);
    }
    if (zoom > 0.3) {
        context.font = `${10 / zoom}px "Segoe UI", sans-serif`;
        context.textAlign = 'center';
        for (const group of view.groups) {
            if (group.nodes.length >= 6) {
                const label = `${group.label} · ${group.nodes.length}`;
                const baseline = group.y - group.radius - 8 / zoom;
                const labelWidth = context.measureText(label).width;
                // Keep the group handle readable and clickable over nearby people.
                context.fillStyle = view.dark ? '#171717e8' : '#fffffff0';
                context.fillRect(
                    group.x - labelWidth / 2 - 6 / zoom,
                    baseline - 11 / zoom,
                    labelWidth + 12 / zoom,
                    16 / zoom
                );
                context.fillStyle = view.dark ? '#9fb3c4' : '#536579';
                context.fillText(label, group.x, baseline);
            }
        }
    }
    context.globalAlpha = 1;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function drawCommunityFields({ context, groups }) {
    for (const group of groups) {
        // Dragging a person moves the soft field with the visible circle too.
        group.x = group.nodes.reduce((sum, node) => sum + node.x, 0) / group.nodes.length;
        group.y = group.nodes.reduce((sum, node) => sum + node.y, 0) / group.nodes.length;
        group.radius = Math.max(
            48,
            (group.nodes.reduce((sum, node) => sum + Math.hypot(node.x - group.x, node.y - group.y), 0) /
                group.nodes.length) *
                1.7
        );
        if (group.nodes.length < 3) {
            continue;
        }
        const gradient = context.createRadialGradient(group.x, group.y, 0, group.x, group.y, group.radius);
        gradient.addColorStop(0, `${group.color}0b`);
        gradient.addColorStop(0.65, `${group.color}06`);
        gradient.addColorStop(1, `${group.color}00`);
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(group.x, group.y, group.radius, 0, Math.PI * 2);
        context.fill();
    }
}

function drawConnections({ context, links, communities, settings, transform }, focus) {
    const opacity = settings.edgeOpacity / 100;
    if (!opacity) {
        return;
    }
    // Batch similar strokes, rather than issuing a separate draw call for every connection.
    const buckets = new Map();
    for (const link of links) {
        if (focus && link.source !== focus && link.target !== focus) {
            continue;
        }
        const group = settings.colorByWeight
            ? 'weight'
            : link.source.community === link.target.community
              ? link.source.community
              : 'cross';
        const level = settings.colorByWeight
            ? Math.round(friendsNetworkStrength(link) * 20)
            : Math.min(4, Math.floor(friendsNetworkStrength(link) * 5));
        const key = `${group}:${Boolean(link.mutual)}:${level}`;
        if (!buckets.has(key)) {
            buckets.set(key, []);
        }
        buckets.get(key).push(link);
    }
    for (const bucket of buckets.values()) {
        const sample = bucket[0];
        const strength = friendsNetworkStrength(sample);
        context.strokeStyle = settings.colorByWeight
            ? friendsNetworkWeightColor(Math.round(strength * 20) / 20)
            : sample.source.community === sample.target.community
              ? communities.get(sample.source.community)?.color || FRIENDS_NETWORK_COLORS[0]
              : '#718a9d';
        context.globalAlpha = Math.min(
            1,
            opacity * (focus ? 0.5 + 0.45 * strength : 0.2 + 0.65 * strength) * (sample.mutual ? 1.1 : 1)
        );
        context.lineWidth = (0.35 + 1.25 * strength + (sample.mutual ? 0.2 : 0)) / Math.sqrt(transform.k);
        context.beginPath();
        for (const link of bucket) {
            context.moveTo(link.source.x, link.source.y);
            context.lineTo(link.target.x, link.target.y);
        }
        context.stroke();
    }
    context.globalAlpha = 1;
}

function drawNames({ context, nodes, width, height, transform, dark }, focus, adjacent) {
    const zoom = transform.k;
    const placed = [];
    const ordered = [...nodes].sort((a, b) => Number(b === focus) - Number(a === focus) || b.radius - a.radius);
    context.font = `${11 / zoom}px "Segoe UI", sans-serif`;
    context.textAlign = 'left';
    context.lineJoin = 'round';
    context.lineWidth = 3 / zoom;
    context.strokeStyle = dark ? '#171717e8' : '#fffffff0';
    for (const node of ordered) {
        if (placed.length >= 180 || (adjacent && !adjacent.has(node.id))) {
            continue;
        }
        if (!focus && nodes.length > 180 && zoom < 1.8 && node.radius < 7.2) {
            continue;
        }
        const label = (node.name || node.id).slice(0, 36);
        const x = node.x + node.radius + 4 / zoom;
        const y = node.y + 3.5 / zoom;
        const box = {
            x: x * zoom + transform.x,
            y: y * zoom + transform.y - 11,
            w: context.measureText(label).width * zoom + 6,
            h: 14
        };
        if (box.x > width || box.y > height || box.x + box.w < 0 || box.y + box.h < 0) {
            continue;
        }
        if (
            placed.some(
                (other) =>
                    box.x < other.x + other.w &&
                    box.x + box.w > other.x &&
                    box.y < other.y + other.h &&
                    box.y + box.h > other.y
            )
        ) {
            continue;
        }
        placed.push(box);
        context.fillStyle = dark ? (focus ? '#e1ecf1' : '#9fb3c4') : focus ? '#182a3a' : '#465c6f';
        context.strokeText(label, x, y);
        context.fillText(label, x, y);
    }
}
