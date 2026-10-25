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

/** Copy the view's force controls into the layout worker request. */
export function toFriendsNetworkLayoutSettings(settings) {
    return {
        layoutIterations: 400,
        layoutSpacing: settings.layoutSpacing,
        groupSpacing: settings.groupSpacing,
        groupTightness: settings.groupTightness,
        betweenGroupPull: settings.betweenGroupPull,
        reinitialize: false
    };
}

/**
 * Sigma owns rendering, label placement, picking and camera interaction.
 * D3 physics stays in its worker. A small transparent overlay adds Circles'
 * membership arcs and group handles, which are specific to this view.
 */
export class FriendsNetworkRenderer {
    constructor(container, onSelect, { groupLabel = (id) => `Circle ${Number(id) + 1}` } = {}) {
        // Graph state and worker ownership
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
        this.pendingLayoutFrame = null;
        this.pendingDragMove = null;
        this.dirtyNodeIds = new Set();
        this.appearanceDirty = false;
        this.graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
        this.layout = createFriendsNetworkLayoutClient(() => new FriendsNetworkLayoutWorker(), {
            onProgress: (frame) => this.receiveLayoutFrame(frame)
        });
        // Sigma rendering and the membership overlay
        this.host = document.createElement('div');
        this.host.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
        container.append(this.host);
        this.sigma = new Sigma(this.graph, this.host, {
            settings: {
                allowInvalidContainer: true,
                stagePadding: 40,
                itemSizesReference: 'positions',
                zoomToSizeRatioFunction: (ratio) => ratio,
                enableCameraRotation: false,
                enableNodeDrag: false,
                minCameraRatio: 0.025,
                maxCameraRatio: 30,
                labelDensity: 0.7,
                labelRenderedSizeThreshold: 7.2
            },
            styles: {
                nodes: {
                    size: { attribute: 'size' },
                    label: { attribute: 'label' },
                    labelFont: 'Segoe UI, sans-serif',
                    labelSize: 11,
                    labelColor: () => (this.dark ? '#9fb3c4' : '#465c6f'),
                    backdropVisibility: 'hidden'
                }
            },
            // Neighborhood highlighting depends on the view's selected person,
            // so it stays in reducers. Sigma handles opacity and GPU labels.
            nodeReducer: (id, data) => this.nodeAppearance(id, data),
            edgeReducer: (id, data, attributes) => this.edgeAppearance(id, data, attributes)
        });
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
        this.context = this.canvas.getContext('2d');
        this.host.append(this.canvas);
        // Pointer events, frame updates and container resizing
        this.events = new AbortController();
        this.bindPointerEvents();
        this.sigma.on('beforeRender', () => this.flushUpdates());
        this.sigma.on('afterRender', () => this.drawOverlay());
        // A container-only resize does not trigger Sigma's window handler.
        // Refresh also rebuilds label placement after its canvases are resized.
        this.resizeObserver = new ResizeObserver(() => this.sigma.scheduleRefresh());
        this.resizeObserver.observe(container);
    }

    cancel() {
        this.finishDrag();
        this.pendingLayoutFrame = null;
        ++this.revision;
        this.layout.cancel();
    }

    // Graph replacement and appearance

    async update(data, settings, dark) {
        this.finishDrag();
        this.pendingLayoutFrame = null;
        const revision = ++this.revision;
        this.setAppearance(settings, dark);
        const result = await this.layout.layout({
            nodes: data.nodes,
            links: data.links,
            settings: toFriendsNetworkLayoutSettings(settings),
            positions: this.positions
        });
        if (this.disposed || revision !== this.revision || !result) {
            return;
        }

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
        if (!this.nodesById.has(this.selectedId)) {
            this.selectedId = null;
        }
        this.dirtyNodeIds.clear();
        this.appearanceDirty = false;
        this.graph.clear();
        for (const node of this.nodes) {
            // D3's positive Y points down; Sigma's graph coordinates point up.
            this.graph.addNode(node.id, { x: node.x, y: -node.y, size: node.radius, label: node.name || node.id });
        }
        // Draw the same connections used by physics, counts and person details.
        const links = data.links
            .filter((link) => this.nodesById.has(link.source) && this.nodesById.has(link.target))
            .sort((a, b) => b.weight - a.weight);
        for (const link of links) {
            this.neighbors.get(link.source).add(link.target);
            this.neighbors.get(link.target).add(link.source);
            this.graph.addEdge(link.source, link.target, { ...link });
        }
        const groups = new Map();
        for (const node of this.nodes) {
            node.isolated = !this.neighbors.get(node.id).size;
            if (!node.isolated) {
                if (!groups.has(node.community)) {
                    groups.set(node.community, []);
                }
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
        if (firstGraph) {
            this.resetCamera();
        }
        this.sigma.refresh();
    }

    setAppearance(settings, dark) {
        this.settings = { ...settings };
        this.dark = dark;
        this.sigma.setSetting('renderLabels', settings.labels);
    }

    nodeAppearance(id, data) {
        const node = this.nodesById.get(id);
        if (!node) {
            return data;
        }
        const focus = this.selectedId || this.hoveredId;
        const dimmed = focus && id !== focus && !this.neighbors.get(focus)?.has(id);
        const color = node.isolated ? '#6f8192' : this.communities.get(node.community).color;
        return {
            ...data,
            color,
            opacity: dimmed ? 0.18 : 1,
            label: dimmed ? null : data.label,
            labelVisibility: id === focus ? 'visible' : dimmed ? 'hidden' : 'auto',
            depth: id === focus ? 'topNodes' : 'nodes',
            zIndex: id === focus ? 1 : 0
        };
    }

    edgeAppearance(id, data, attributes) {
        const [source, target] = this.graph.extremities(id);
        const focus = this.selectedId || this.hoveredId;
        const strength = friendsNetworkStrength(attributes);
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
            (attributes.mutual ? 1.1 : 1);
        return {
            ...data,
            color,
            opacity: Math.max(0, Math.min(1, opacity)),
            size: 0.35 + 1.25 * strength + (attributes.mutual ? 0.2 : 0),
            visibility: !opacity || (focus && source !== focus && target !== focus) ? 'hidden' : 'visible'
        };
    }

    // Coalesce worker and pointer updates into the next Sigma frame.

    receiveLayoutFrame(frame) {
        if (this.disposed || !frame.live || frame.positions.length !== this.layoutNodeIds.length * 2) {
            return;
        }
        // Retain only the newest worker frame until Sigma actually draws it.
        // Remember its held nodes even if pointerup arrives before that render.
        this.pendingLayoutFrame = { positions: frame.positions, heldIds: this.drag?.heldIds };
        this.sigma.scheduleRender();
    }

    setNodePosition(node, x, y) {
        if (node.x === x && node.y === y) {
            return;
        }
        node.x = x;
        node.y = y;
        const position = this.positions[node.id];
        position.x = x;
        position.y = y;
        // This graph belongs only to the renderer. Mutate its public attribute
        // object, then notify Sigma once for the frame instead of once per node.
        const attributes = this.graph.getNodeAttributes(node.id);
        attributes.x = x;
        attributes.y = -y;
        this.dirtyNodeIds.add(node.id);
    }

    flushDragMove() {
        if (!this.pendingDragMove) {
            return;
        }
        this.layout.drag({ phase: 'move', nodes: this.pendingDragMove });
        this.pendingDragMove = null;
    }

    flushUpdates() {
        this.flushDragMove();
        const frame = this.pendingLayoutFrame;
        this.pendingLayoutFrame = null;
        if (frame) {
            this.layoutNodeIds.forEach((id, index) => {
                const node = this.nodesById.get(id);
                // A pointer move may start and finish after this frame arrived.
                // Keep its immediate coordinates until this draw commits them.
                if (!node || this.dirtyNodeIds.has(id) || frame.heldIds?.has(id) || this.drag?.heldIds.has(id)) {
                    return;
                }
                this.setNodePosition(node, frame.positions[index * 2], frame.positions[index * 2 + 1]);
            });
        }
        if (this.appearanceDirty) {
            this.appearanceDirty = false;
            this.sigma.refresh({ schedule: true });
        } else if (this.dirtyNodeIds.size) {
            // Coordinates require fresh label placement and GPU picking data.
            // Keep indexation enabled, while reusing every edge's appearance.
            this.sigma.refresh({
                partialGraph: { nodes: [...this.dirtyNodeIds] },
                skipIndexation: false,
                schedule: true
            });
        }
        this.dirtyNodeIds.clear();
    }

    requestAppearanceRefresh() {
        this.appearanceDirty = true;
        this.sigma.scheduleRender();
    }

    // Selection, camera movement and coordinate conversion

    highlight(id) {
        this.selectedId = this.nodesById.has(id) ? id : null;
        this.requestAppearanceRefresh();
    }

    focus(id) {
        const node = this.nodesById.get(id);
        if (!node) {
            return false;
        }
        const display = this.sigma.getNodeDisplayData(id);
        if (display) {
            this.sigma.getCamera().setState({
                x: display.x,
                y: display.y,
                ratio: Math.min(this.sigma.getCamera().getState().ratio, 0.6)
            });
        }
        this.highlight(id);
        return true;
    }

    resetCamera() {
        if (!this.nodes.length) {
            return;
        }
        const xCoordinates = this.nodes.map((node) => node.x);
        const yCoordinates = this.nodes.map((node) => -node.y);
        this.sigma.setCustomBBox({
            x: [Math.min(...xCoordinates) - 25, Math.max(...xCoordinates) + 25],
            y: [Math.min(...yCoordinates) - 25, Math.max(...yCoordinates) + 25]
        });
        this.sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
        this.sigma.refresh();
    }

    /** Convert downward-positive D3 coordinates to viewport pixels through Sigma. */
    toViewport(node) {
        return this.sigma.graphToViewport({ x: node.x, y: -node.y });
    }

    /** Convert viewport pixels back to the layout worker's D3 coordinates. */
    toWorld(point) {
        const position = this.sigma.viewportToGraph(point);
        return { x: position.x, y: -position.y };
    }

    drawOverlay() {
        if (!this.disposed && this.settings) {
            drawFriendsNetworkOverlay(this);
        }
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

    // Node and group dragging

    startDrag(payload, id) {
        if (payload.event.original.button !== undefined && payload.event.original.button !== 0) {
            return;
        }
        this.suppressClick = false;
        const point = payload.event;
        const node = this.nodesById.get(id);
        const group =
            this.groupAt(point) ||
            (payload.event.original.shiftKey && node ? this.groups.find((group) => group.id === node.community) : null);
        if (!node && !group) {
            return;
        }
        payload.preventSigmaDefault();
        this.sigma.getCamera().enabled = false;
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
        if (!drag) {
            return;
        }
        const containerBounds = this.host.getBoundingClientRect();
        const point = { x: event.clientX - containerBounds.left, y: event.clientY - containerBounds.top };
        if (!drag.moved && Math.hypot(point.x - drag.point.x, point.y - drag.point.y) <= 4) {
            return;
        }
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
        const nodeUpdates = drag.entries.map(({ node, x, y }) => {
            this.setNodePosition(node, x + world.x - drag.world.x, y + world.y - drag.world.y);
            return { id: node.id, x: node.x, y: node.y };
        });
        this.pendingDragMove = nodeUpdates;
        this.sigma.scheduleRender();
    }

    finishDrag() {
        const drag = this.drag;
        this.flushDragMove();
        this.drag = null;
        if (drag?.moved) {
            this.suppressClick = true;
        }
        if (drag?.heldIds.size) {
            this.layout.drag({ phase: 'end' });
        }
        this.sigma.getCamera().enabled = true;
    }

    bindPointerEvents() {
        this.sigma.on('downNode', (payload) => this.startDrag(payload, payload.node));
        this.sigma.on('downStage', (payload) => this.startDrag(payload));
        this.sigma.on('moveBody', (payload) => {
            // A pull belongs to the physics worker. Sigma must not also pan or
            // accumulate camera inertia from the same pointer movement.
            if (this.drag) {
                payload.preventSigmaDefault();
            }
        });
        this.sigma.on('clickNode', ({ node }) => {
            if (!this.suppressClick) {
                this.onSelect(node);
            }
        });
        this.sigma.on('clickStage', ({ event }) => {
            if (!this.suppressClick && !this.groupAt(event)) {
                this.onSelect(null);
            }
        });
        this.sigma.on('enterNode', ({ node }) => {
            this.hoveredId = node;
            const person = this.nodesById.get(node);
            if (!person) {
                return;
            }
            const memberships = friendsNetworkMemberships(person, this.communities);
            this.host.title = [
                person.name || person.id,
                ...memberships.map(
                    (membership) => `${this.groupLabel(membership.community)}: ${Math.round(membership.score * 100)}%`
                )
            ].join('\n');
            this.host.style.cursor = 'pointer';
            this.requestAppearanceRefresh();
        });
        this.sigma.on('leaveNode', () => {
            this.hoveredId = null;
            this.host.title = '';
            this.host.style.cursor = '';
            this.requestAppearanceRefresh();
        });
        const options = { signal: this.events.signal };
        // Document listeners keep a pull live when the pointer leaves the graph.
        document.addEventListener('pointermove', (event) => this.moveDrag(event), options);
        document.addEventListener('pointerup', () => this.finishDrag(), options);
        document.addEventListener('pointercancel', () => this.finishDrag(), options);
        window.addEventListener('blur', () => this.finishDrag(), options);
    }

    // Release every resource owned by this view.

    dispose() {
        this.finishDrag();
        this.disposed = true;
        this.pendingLayoutFrame = null;
        this.dirtyNodeIds.clear();
        ++this.revision;
        this.events.abort();
        this.resizeObserver.disconnect();
        this.layout.dispose();
        this.sigma.kill();
        this.host.remove();
    }
}
