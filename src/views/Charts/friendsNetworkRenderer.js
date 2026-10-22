import Graph from 'graphology';
import Sigma from 'sigma';
import FriendsNetworkLayoutWorker from './friendsNetworkLayoutWorker.js?worker&inline';
import { createFriendsNetworkLayoutClient } from './friendsNetworkLayout';
import {
    drawFriendsNetworkOverlay,
    friendsNetworkCommunityStyles,
    friendsNetworkMemberships,
    friendsNetworkNodeRadius,
    friendsNetworkStrength,
    friendsNetworkWeightColor
} from './friendsNetworkAppearance';

export function toFriendsNetworkLayoutSettings(settings) {
    return {
        layoutIterations: 400,
        layoutSpacing: settings.layoutSpacing,
        groupSpacing: settings.groupSpacing,
        groupTightness: settings.groupTightness,
        betweenGroupPull: settings.betweenGroupPull,
        resolution: settings.resolution,
        reinitialize: false
    };
}

function transparent(color, opacity) {
    // Sigma 3 uses premultiplied WebGL blending. Scale the RGB channels as
    // well as alpha so many faint connections do not add up to white lines.
    const alpha = Math.max(0, Math.min(1, opacity));
    const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) * alpha);
    return '#' + [...channels, alpha * 255].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('');
}

/**
 * Sigma owns rendering, label placement, picking and camera interaction.
 * D3 physics stays in its worker. A small transparent overlay adds Circles'
 * membership arcs and group handles, which are specific to this view.
 */
export class FriendsNetworkRenderer {
    constructor(container, onSelect, { groupLabel = (id) => `Circle ${Number(id) + 1}` } = {}) {
        this.container = container;
        this.onSelect = onSelect;
        this.groupLabel = groupLabel;
        this.revision = 0;
        this.disposed = false;
        this.positions = {};
        this.nodes = [];
        this.groups = [];
        this.nodesById = new Map();
        this.neighbors = new Map();
        this.communities = new Map();
        this.selectedId = null;
        this.hoveredId = null;
        this.drag = null;
        this.suppressClick = false;
        this.layoutNodeIds = [];
        this.groupHandles = [];
        this.graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
        this.worker = new FriendsNetworkLayoutWorker();
        this.layout = createFriendsNetworkLayoutClient(this.worker, {
            onProgress: (frame) => this.receiveLayoutFrame(frame)
        });
        this.host = document.createElement('div');
        this.host.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
        container.append(this.host);
        this.sigma = new Sigma(this.graph, this.host, {
            allowInvalidContainer: true,
            stagePadding: 40,
            itemSizesReference: 'positions',
            zoomToSizeRatioFunction: (ratio) => ratio,
            enableCameraRotation: false,
            minCameraRatio: 0.025,
            maxCameraRatio: 30,
            labelFont: 'Segoe UI, sans-serif',
            labelSize: 11,
            labelDensity: 0.7,
            labelRenderedSizeThreshold: 7.2,
            defaultDrawNodeHover: () => {},
            nodeReducer: (id, data) => this.nodeAppearance(id, data),
            edgeReducer: (id, data) => this.edgeAppearance(id, data)
        });
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
        this.context = this.canvas.getContext('2d');
        this.host.append(this.canvas);
        this.events = new AbortController();
        this.bindPointerEvents();
        this.sigma.on('afterRender', () => this.drawOverlay());
        // A container-only resize does not trigger Sigma's window handler.
        // Refresh also rebuilds label placement after its canvases are resized.
        this.resizeObserver = new ResizeObserver(() => this.sigma.scheduleRefresh());
        this.resizeObserver.observe(container);
    }

    cancel() {
        this.finishDrag();
        ++this.revision;
        this.layout.cancel();
    }

    async update(data, settings, dark) {
        this.finishDrag();
        const revision = ++this.revision;
        this.setAppearance(settings, dark);
        const result = await this.layout.layout({
            nodes: data.nodes,
            links: data.links,
            settings: toFriendsNetworkLayoutSettings(settings),
            positions: this.positions
        });
        if (this.disposed || revision !== this.revision || !result) return;

        const firstGraph = !this.nodes.length;
        this.positions = result.positions;
        this.layoutNodeIds = result.nodeIds || Object.keys(result.positions);
        this.nodes = data.nodes.map((node) => ({
            ...node,
            ...result.positions[node.id],
            radius: friendsNetworkNodeRadius(node)
        }));
        this.nodesById = new Map(this.nodes.map((node) => [node.id, node]));
        this.neighbors = new Map(this.nodes.map((node) => [node.id, new Set()]));
        this.communities = friendsNetworkCommunityStyles(this.nodes, data.communities);
        // Clearing Sigma's graph drops its hover without a leaveNode event.
        // Drop the view's matching state too, especially when filters hide it.
        this.hoveredId = null;
        this.host.title = '';
        this.host.style.cursor = '';
        if (!this.nodesById.has(this.selectedId)) this.selectedId = null;
        this.graph.clear();
        for (const node of this.nodes) {
            // D3's positive Y points down; Sigma's graph coordinates point up.
            this.graph.addNode(node.id, { x: node.x, y: -node.y, size: node.radius, label: node.name || node.id });
        }
        const links = data.links
            .filter((link) => this.nodesById.has(link.source) && this.nodesById.has(link.target))
            .sort((a, b) => b.weight - a.weight)
            .slice(0, 20000);
        for (const link of links) {
            this.neighbors.get(link.source).add(link.target);
            this.neighbors.get(link.target).add(link.source);
            this.graph.addEdge(link.source, link.target, { ...link });
        }
        const groups = new Map();
        for (const node of this.nodes) {
            node.isolated = !this.neighbors.get(node.id).size;
            if (!node.isolated) {
                if (!groups.has(node.community)) groups.set(node.community, []);
                groups.get(node.community).push(node);
            }
        }
        this.groups = [...groups].map(([id, nodes]) => ({
            id,
            nodes,
            color: this.communities.get(id).color,
            label: this.groupLabel(id)
        }));
        // Freeze normalization bounds during interaction. Moving a node must
        // not rescale the entire graph or shift the camera under the pointer.
        if (firstGraph) this.resetCamera();
        this.sigma.refresh();
    }

    setAppearance(settings, dark) {
        this.settings = { ...settings };
        this.dark = dark;
        this.sigma.setSettings({ renderLabels: settings.labels, labelColor: { color: dark ? '#9fb3c4' : '#465c6f' } });
        this.sigma.scheduleRefresh();
    }

    nodeAppearance(id, data) {
        const node = this.nodesById.get(id);
        if (!node) return data;
        const focus = this.selectedId || this.hoveredId;
        const dimmed = focus && id !== focus && !this.neighbors.get(focus)?.has(id);
        const color = node.isolated ? '#6f8192' : this.communities.get(node.community).color;
        return {
            ...data,
            color: transparent(color, dimmed ? 0.18 : 1),
            label: dimmed ? null : data.label,
            forceLabel: id === focus,
            zIndex: id === focus ? 1 : 0
        };
    }

    edgeAppearance(id, data) {
        const [source, target] = this.graph.extremities(id);
        const focus = this.selectedId || this.hoveredId;
        const strength = friendsNetworkStrength(data);
        const sourceGroup = this.nodesById.get(source)?.community;
        const targetGroup = this.nodesById.get(target)?.community;
        const color = this.settings?.colorByWeight
            ? friendsNetworkWeightColor(strength)
            : sourceGroup === targetGroup
              ? this.communities.get(sourceGroup).color
              : '#718a9d';
        const opacity =
            ((this.settings?.edgeOpacity ?? 25) / 100) *
            (focus ? 0.5 + 0.45 * strength : 0.2 + 0.65 * strength) *
            (data.mutual ? 1.1 : 1);
        return {
            ...data,
            color: transparent(color, opacity),
            size: 0.35 + 1.25 * strength + (data.mutual ? 0.2 : 0),
            hidden: !opacity || Boolean(focus && source !== focus && target !== focus)
        };
    }

    receiveLayoutFrame(frame) {
        if (this.disposed || !frame.live || frame.positions.length !== this.layoutNodeIds.length * 2) return;
        this.layoutNodeIds.forEach((id, index) => {
            const node = this.nodesById.get(id);
            if (!node || this.drag?.heldIds.has(id)) return;
            this.setNodePosition(node, frame.positions[index * 2], frame.positions[index * 2 + 1]);
        });
        this.sigma.scheduleRefresh();
    }

    setNodePosition(node, x, y) {
        node.x = x;
        node.y = y;
        this.positions[node.id] = { x, y };
        this.graph.mergeNodeAttributes(node.id, { x, y: -y });
    }

    highlight(id) {
        this.selectedId = this.nodesById.has(id) ? id : null;
        this.sigma.scheduleRefresh();
    }

    focus(id) {
        const node = this.nodesById.get(id);
        if (!node) return false;
        const display = this.sigma.getNodeDisplayData(id);
        if (display)
            this.sigma.getCamera().setState({
                x: display.x,
                y: display.y,
                ratio: Math.min(this.sigma.getCamera().getState().ratio, 0.6)
            });
        this.highlight(id);
        return true;
    }

    resetCamera() {
        if (!this.nodes.length) return;
        const xs = this.nodes.map((node) => node.x);
        const ys = this.nodes.map((node) => -node.y);
        this.sigma.setCustomBBox({
            x: [Math.min(...xs) - 25, Math.max(...xs) + 25],
            y: [Math.min(...ys) - 25, Math.max(...ys) + 25]
        });
        this.sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
        this.sigma.refresh();
    }

    toViewport(node) {
        return this.sigma.graphToViewport({ x: node.x, y: -node.y });
    }

    toWorld(point) {
        const position = this.sigma.viewportToGraph(point);
        return { x: position.x, y: -position.y };
    }

    drawOverlay() {
        if (!this.disposed && this.settings) drawFriendsNetworkOverlay(this);
    }

    groupAt(point) {
        return this.groupHandles.find(
            (handle) =>
                point.x >= handle.x &&
                point.x <= handle.x + handle.width &&
                point.y >= handle.y &&
                point.y <= handle.y + handle.height
        )?.group;
    }

    startDrag(payload, id) {
        if (payload.event.original.button !== undefined && payload.event.original.button !== 0) return;
        this.suppressClick = false;
        const point = payload.event;
        const node = this.nodesById.get(id);
        const group =
            this.groupAt(point) ||
            (payload.event.original.shiftKey && node ? this.groups.find((group) => group.id === node.community) : null);
        if (!node && !group) return;
        payload.preventSigmaDefault();
        this.sigma.getCamera().disable();
        this.drag = {
            point: { x: point.x, y: point.y },
            world: this.toWorld(point),
            node,
            group,
            moved: false,
            heldIds: new Set(),
            entries: []
        };
    }

    moveDrag(event) {
        const drag = this.drag;
        if (!drag) return;
        const bounds = this.host.getBoundingClientRect();
        const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        if (!drag.moved && Math.hypot(point.x - drag.point.x, point.y - drag.point.y) <= 4) return;
        if (!drag.moved) {
            drag.moved = true;
            const nodes = drag.group ? drag.group.nodes : [drag.node];
            drag.entries = nodes.map((node) => ({ node, x: node.x, y: node.y }));
            drag.heldIds = new Set(nodes.map((node) => node.id));
            this.layout.drag({
                phase: 'start',
                group: Boolean(drag.group),
                nodes: nodes.map(({ id, x, y }) => ({ id, x, y }))
            });
        }
        const world = this.toWorld(point);
        const updates = drag.entries.map(({ node, x, y }) => {
            this.setNodePosition(node, x + world.x - drag.world.x, y + world.y - drag.world.y);
            return { id: node.id, x: node.x, y: node.y };
        });
        this.layout.drag({ phase: 'move', nodes: updates });
        this.sigma.scheduleRefresh();
    }

    finishDrag() {
        const drag = this.drag;
        this.drag = null;
        if (drag?.moved) this.suppressClick = true;
        if (drag?.heldIds.size) this.layout.drag({ phase: 'end' });
        this.sigma.getCamera().enable();
    }

    bindPointerEvents() {
        this.sigma.on('downNode', (payload) => this.startDrag(payload, payload.node));
        this.sigma.on('downStage', (payload) => this.startDrag(payload));
        this.sigma.on('moveBody', (payload) => {
            // A pull belongs to the physics worker. Sigma must not also pan or
            // accumulate camera inertia from the same pointer movement.
            if (this.drag) payload.preventSigmaDefault();
        });
        this.sigma.on('clickNode', ({ node }) => {
            if (!this.suppressClick) this.onSelect(node);
        });
        this.sigma.on('clickStage', ({ event }) => {
            if (!this.suppressClick && !this.groupAt(event)) this.onSelect(null);
        });
        this.sigma.on('enterNode', ({ node }) => {
            this.hoveredId = node;
            const person = this.nodesById.get(node);
            if (!person) return;
            const memberships = friendsNetworkMemberships(person, this.communities);
            this.host.title = [
                person.name || person.id,
                ...memberships.map(
                    (membership) => `${this.groupLabel(membership.community)}: ${Math.round(membership.score * 100)}%`
                )
            ].join('\n');
            this.host.style.cursor = 'pointer';
            this.sigma.scheduleRefresh();
        });
        this.sigma.on('leaveNode', () => {
            this.hoveredId = null;
            this.host.title = '';
            this.host.style.cursor = '';
            this.sigma.scheduleRefresh();
        });
        const options = { signal: this.events.signal };
        // Document listeners keep a pull live when the pointer leaves the graph.
        document.addEventListener('pointermove', (event) => this.moveDrag(event), options);
        document.addEventListener('pointerup', () => this.finishDrag(), options);
        document.addEventListener('pointercancel', () => this.finishDrag(), options);
        window.addEventListener('blur', () => this.finishDrag(), options);
    }

    dispose() {
        this.finishDrag();
        this.disposed = true;
        ++this.revision;
        this.events.abort();
        this.resizeObserver.disconnect();
        this.layout.dispose();
        this.sigma.kill();
        this.host.remove();
    }
}
