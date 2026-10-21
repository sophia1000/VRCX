import FriendsNetworkLayoutWorker from './friendsNetworkLayoutWorker.js?worker&inline';
import { createFriendsNetworkLayoutClient } from './friendsNetworkLayout';
import {
    drawFriendsNetwork,
    friendsNetworkCommunityStyles,
    friendsNetworkMemberships,
    friendsNetworkNodeRadius
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

/**
 * Canvas preserves Circles' visual style while VRCX owns the surrounding UI.
 * Physics runs in the cancellable worker. Pointer interaction and repainting
 * stay local, so zooming and appearance changes never query the history cache.
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
        this.links = [];
        this.groups = [];
        this.nodesById = new Map();
        this.neighbors = new Map();
        this.communities = new Map();
        this.transform = { x: 0, y: 0, k: 1 };
        this.selectedId = null;
        this.hoveredId = null;
        this.width = 1;
        this.height = 1;
        this.frame = 0;
        this.drag = null;
        this.layoutNodeIds = [];
        this.worker = new FriendsNetworkLayoutWorker();
        this.layout = createFriendsNetworkLayoutClient(this.worker, {
            onProgress: (frame) => this.receiveLayoutFrame(frame)
        });
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
        this.context = this.canvas.getContext('2d');
        container.append(this.canvas);
        this.events = new AbortController();
        this.bindPointerEvents();
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(container);
        this.resize();
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
        if (this.disposed || revision !== this.revision || !result) {
            return;
        }
        const firstGraph = !this.nodes.length;
        this.positions = result.positions;
        this.layoutNodeIds = result.nodeIds || Object.keys(result.positions);
        // Keep backend memberships and community IDs together. Worker singleton
        // labels must not replace the identities used for membership colors.
        this.nodes = data.nodes.map((node) => ({
            ...node,
            ...result.positions[node.id],
            radius: friendsNetworkNodeRadius(node)
        }));
        this.nodesById = new Map(this.nodes.map((node) => [node.id, node]));
        this.neighbors = new Map(this.nodes.map((node) => [node.id, new Set()]));
        this.links = data.links
            .filter((link) => this.nodesById.has(link.source) && this.nodesById.has(link.target))
            .map((link) => {
                this.neighbors.get(link.source).add(link.target);
                this.neighbors.get(link.target).add(link.source);
                return { ...link, source: this.nodesById.get(link.source), target: this.nodesById.get(link.target) };
            })
            .sort((a, b) => b.weight - a.weight)
            .slice(0, 20000);
        this.communities = friendsNetworkCommunityStyles(this.nodes, data.communities);
        const groups = new Map();
        for (const node of this.nodes) {
            node.isolated = !this.neighbors.get(node.id).size;
            if (node.isolated) {
                continue;
            }
            if (!groups.has(node.community)) {
                groups.set(node.community, []);
            }
            groups.get(node.community).push(node);
        }
        this.groups = [...groups].map(([id, nodes]) => {
            const x = nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length;
            const y = nodes.reduce((sum, node) => sum + node.y, 0) / nodes.length;
            const radius = Math.max(
                48,
                (nodes.reduce((sum, node) => sum + Math.hypot(node.x - x, node.y - y), 0) / nodes.length) * 1.7
            );
            return { id, nodes, x, y, radius, color: this.communities.get(id).color, label: this.groupLabel(id) };
        });
        // Appearance can change while physics runs. Repaint with the most recent
        // theme and toggles rather than restoring this request's older values.
        this.requestDraw();
        if (firstGraph) {
            this.resetCamera();
        }
    }

    setAppearance(settings, dark) {
        this.settings = { ...settings };
        this.dark = dark;
        this.requestDraw();
    }

    receiveLayoutFrame(frame) {
        if (this.disposed || !frame.live || frame.positions.length !== this.layoutNodeIds.length * 2) {
            return;
        }
        this.layoutNodeIds.forEach((id, index) => {
            const node = this.nodesById.get(id);
            // A queued worker frame must not move the grabbed person behind the pointer.
            if (!node || this.drag?.heldIds.has(id)) {
                return;
            }
            node.x = frame.positions[index * 2];
            node.y = frame.positions[index * 2 + 1];
            this.positions[id].x = node.x;
            this.positions[id].y = node.y;
        });
        this.requestDraw();
    }

    highlight(id) {
        this.selectedId = this.nodesById.has(id) ? id : null;
        this.requestDraw();
    }

    focus(id) {
        const node = this.nodesById.get(id);
        if (!node) {
            return false;
        }
        const k = Math.max(this.transform.k, 1.4);
        this.transform = { k, x: this.width / 2 - node.x * k, y: this.height / 2 - node.y * k };
        this.highlight(id);
        return true;
    }

    resetCamera() {
        if (!this.nodes.length) {
            return;
        }
        const xs = this.nodes.map((node) => node.x);
        const ys = this.nodes.map((node) => node.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const k = Math.max(
            0.02,
            Math.min(
                2,
                (this.width - 80) / Math.max(80, maxX - minX + 30),
                (this.height - 80) / Math.max(80, maxY - minY + 30)
            )
        );
        this.transform = {
            k,
            x: this.width / 2 - ((minX + maxX) / 2) * k,
            y: this.height / 2 - ((minY + maxY) / 2) * k
        };
        this.requestDraw();
    }

    resize() {
        const width = Math.max(1, this.container.clientWidth);
        const height = Math.max(1, this.container.clientHeight);
        this.transform.x += (width - this.width) / 2;
        this.transform.y += (height - this.height) / 2;
        this.width = width;
        this.height = height;
        this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas.width = Math.round(width * this.pixelRatio);
        this.canvas.height = Math.round(height * this.pixelRatio);
        this.requestDraw();
    }

    requestDraw() {
        if (this.disposed || this.frame || !this.settings) {
            return;
        }
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            drawFriendsNetwork(this);
        });
    }

    pointerPosition(event) {
        const bounds = this.canvas.getBoundingClientRect();
        return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    }

    nodeAt(point) {
        const { k, x, y } = this.transform;
        const worldX = (point.x - x) / k;
        const worldY = (point.y - y) / k;
        let nearest = null;
        let distance = Infinity;
        for (const node of this.nodes) {
            const candidate = Math.hypot(node.x - worldX, node.y - worldY);
            if (candidate < node.radius + 5 / k && candidate < distance) {
                nearest = node;
                distance = candidate;
            }
        }
        return nearest;
    }

    groupAt(point) {
        if (this.transform.k <= 0.3) {
            return null;
        }
        const { x, y, k } = this.transform;
        this.context.font = `${10 / k}px "Segoe UI", sans-serif`;
        return this.groups.find((group) => {
            if (group.nodes.length < 6) {
                return false;
            }
            const center = group.x * k + x;
            const baseline = (group.y - group.radius) * k + y - 8;
            const width = this.context.measureText(`${group.label} · ${group.nodes.length}`).width * k;
            return Math.abs(point.x - center) <= width / 2 + 7 && point.y >= baseline - 14 && point.y <= baseline + 5;
        });
    }

    startPulling() {
        const drag = this.drag;
        const nodes = drag.group ? drag.group.nodes : drag.node ? [drag.node] : [];
        drag.entries = nodes.map((node) => ({ node, x: node.x, y: node.y }));
        drag.heldIds = new Set(nodes.map((node) => node.id));
        if (nodes.length) {
            this.layout.drag({
                phase: 'start',
                group: Boolean(drag.group),
                nodes: nodes.map(({ id, x, y }) => ({ id, x, y }))
            });
        }
    }

    movePulling(point) {
        const drag = this.drag;
        const dx = (point.x - drag.point.x) / this.transform.k;
        const dy = (point.y - drag.point.y) / this.transform.k;
        const updates = drag.entries.map(({ node, x, y }) => {
            node.x = x + dx;
            node.y = y + dy;
            this.positions[node.id] = { x: node.x, y: node.y };
            return { id: node.id, x: node.x, y: node.y };
        });
        this.layout.drag({ phase: 'move', nodes: updates });
    }

    finishDrag() {
        const drag = this.drag;
        this.drag = null;
        if (drag?.heldIds.size) {
            this.layout.drag({ phase: 'end' });
        }
        if (drag && this.canvas.hasPointerCapture(drag.pointerId)) {
            this.canvas.releasePointerCapture(drag.pointerId);
        }
    }

    bindPointerEvents() {
        const options = { signal: this.events.signal };
        this.canvas.addEventListener(
            'pointerdown',
            (event) => {
                if (event.button !== 0) {
                    return;
                }
                const point = this.pointerPosition(event);
                const node = this.nodeAt(point);
                const group =
                    this.groupAt(point) ||
                    (event.shiftKey && node ? this.groups.find((group) => group.id === node.community) : null);
                this.drag = {
                    point,
                    previous: point,
                    node,
                    group,
                    moved: false,
                    entries: [],
                    heldIds: new Set(),
                    pointerId: event.pointerId
                };
                this.canvas.setPointerCapture(event.pointerId);
            },
            options
        );
        this.canvas.addEventListener(
            'pointermove',
            (event) => {
                const point = this.pointerPosition(event);
                const drag = this.drag;
                if (drag) {
                    if (!drag.moved && Math.hypot(point.x - drag.point.x, point.y - drag.point.y) > 4) {
                        drag.moved = true;
                        this.startPulling();
                    }
                    if (drag.moved) {
                        if (drag.entries.length) {
                            this.movePulling(point);
                        } else {
                            this.transform.x += point.x - drag.previous.x;
                            this.transform.y += point.y - drag.previous.y;
                        }
                        this.requestDraw();
                    }
                    drag.previous = point;
                    return;
                }
                const node = this.nodeAt(point);
                const group = this.groupAt(point);
                this.canvas.style.cursor = group ? 'move' : node ? 'pointer' : 'grab';
                if (node?.id !== this.hoveredId) {
                    this.hoveredId = node?.id || null;
                    const memberships = node ? friendsNetworkMemberships(node, this.communities) : [];
                    this.canvas.title = node
                        ? [
                              node.name || node.id,
                              ...memberships.map(
                                  (membership) =>
                                      `${this.groupLabel(membership.community)}: ${Math.round(membership.score * 100)}%`
                              )
                          ].join('\n')
                        : '';
                    this.requestDraw();
                }
            },
            options
        );
        this.canvas.addEventListener(
            'pointerup',
            (event) => {
                const drag = this.drag;
                if (drag && !drag.moved && !drag.group) {
                    this.onSelect(drag.node?.id || null);
                }
                this.finishDrag();
                if (this.canvas.hasPointerCapture(event.pointerId)) {
                    this.canvas.releasePointerCapture(event.pointerId);
                }
            },
            options
        );
        this.canvas.addEventListener('pointercancel', () => this.finishDrag(), options);
        this.canvas.addEventListener('lostpointercapture', () => this.finishDrag(), options);
        this.canvas.addEventListener(
            'pointerleave',
            () => {
                this.hoveredId = null;
                this.canvas.title = '';
                this.requestDraw();
            },
            options
        );
        this.canvas.addEventListener(
            'wheel',
            (event) => {
                event.preventDefault();
                const point = this.pointerPosition(event);
                const previous = this.transform;
                const k = Math.min(12, Math.max(0.02, previous.k * Math.exp(-event.deltaY * 0.0015)));
                this.transform = {
                    k,
                    x: point.x - ((point.x - previous.x) / previous.k) * k,
                    y: point.y - ((point.y - previous.y) / previous.k) * k
                };
                this.requestDraw();
            },
            { ...options, passive: false }
        );
    }

    dispose() {
        this.finishDrag();
        this.disposed = true;
        ++this.revision;
        cancelAnimationFrame(this.frame);
        this.events.abort();
        this.resizeObserver.disconnect();
        this.layout.dispose();
        this.canvas.remove();
    }
}
