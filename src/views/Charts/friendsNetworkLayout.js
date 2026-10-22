import Graph from 'graphology';
import { createFriendsNetworkSimulation } from './friendsNetworkSimulation';
import { createFriendsNetworkDragController } from './friendsNetworkInteraction';

const DEFAULT_SETTINGS = Object.freeze({
    layoutIterations: 400,
    layoutSpacing: 60,
    groupSpacing: 60,
    groupTightness: 50,
    betweenGroupPull: 100,
    seed: 1,
    batchIterations: 8,
    reinitialize: false
});

// Settings and deterministic initial positions

/** Return normalized settings without changing the caller's saved values. */
export function normalizeFriendsNetworkLayoutSettings(settings = {}) {
    function getBoundedSetting(key, minimum, maximum) {
        const value = Number(settings[key] ?? DEFAULT_SETTINGS[key]);
        return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : DEFAULT_SETTINGS[key]));
    }

    return {
        layoutIterations: Math.round(getBoundedSetting('layoutIterations', 1, 3000)),
        layoutSpacing: getBoundedSetting('layoutSpacing', 0, 100),
        groupSpacing: getBoundedSetting('groupSpacing', 0, 100),
        groupTightness: getBoundedSetting('groupTightness', 0, 100),
        betweenGroupPull: getBoundedSetting('betweenGroupPull', 0, 100),
        seed: Math.trunc(getBoundedSetting('seed', 0, 0xffffffff)),
        batchIterations: Math.round(getBoundedSetting('batchIterations', 1, 32)),
        reinitialize: Boolean(settings.reinitialize)
    };
}

function compareIds(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    }
    return hash >>> 0;
}

function createSeededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = Math.imul(state ^ (state >>> 15), state | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function hasFinitePosition(position) {
    return Number.isFinite(position?.x) && Number.isFinite(position?.y);
}

function getInitialPosition(id, count, seed) {
    const random = createSeededRandom(hashString(`${seed}:${id}`));
    const angle = random() * Math.PI * 2;
    const radius = (0.2 + Math.sqrt(random())) * Math.max(30, Math.sqrt(count) * 10);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/**
 * Build the narrow Graphology adapter used by the layout worker.
 *
 * Analysis supplies {id, community, ...} nodes and {source, target, weight, ...}
 * links. Evidence attributes and membership scores are kept unchanged.
 * This function performs no community detection or force iterations on the UI.
 */
export function buildFriendsNetworkGraph(data, settings = {}, positions = {}) {
    const options = normalizeFriendsNetworkLayoutSettings(settings);
    const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
    // Normalize node input and retain positions from the previous graph.
    const nodes = new Map();
    for (const node of data.nodes ?? []) {
        if (node?.id === undefined || node.id === null || String(node.id) === '') {
            continue;
        }
        nodes.set(String(node.id), node);
    }

    const positionedNodeIds = new Set();
    for (const id of [...nodes.keys()].sort(compareIds)) {
        const node = nodes.get(id);
        const existingPosition = positions[id] ?? node;
        const useExistingPosition = !options.reinitialize && hasFinitePosition(existingPosition);
        const position = useExistingPosition ? existingPosition : getInitialPosition(id, nodes.size, options.seed);
        if (useExistingPosition) {
            positionedNodeIds.add(id);
        }
        graph.addNode(id, {
            ...node,
            x: position.x,
            y: position.y,
            label: node.name || id,
            type: node.type || 'circle'
        });
    }

    // Normalize undirected edges before adding them in a stable order.
    const links = new Map();
    for (const edge of data.links ?? []) {
        const source = edge.source;
        const target = edge.target;
        const weight = edge.weight;
        if (source === target || !graph.hasNode(source) || !graph.hasNode(target)) {
            continue;
        }
        if (!Number.isFinite(weight) || weight <= 0) {
            continue;
        }
        const [first, second] = [source, target].sort(compareIds);
        const key = JSON.stringify([first, second]);
        // Defensive duplicate handling avoids counting a serialized undirected
        // edge twice. The backend already aggregates raw encounter evidence.
        if (!links.has(key) || links.get(key).weight < weight) {
            links.set(key, { ...edge, source: first, target: second, weight });
        }
    }

    for (const key of [...links.keys()].sort(compareIds)) {
        const edge = links.get(key);
        graph.addEdgeWithKey(key, edge.source, edge.target, edge);
    }
    // Place newly introduced nodes near neighbors whose positions were retained.
    graph.forEachNode((id) => {
        if (positionedNodeIds.size && !positionedNodeIds.has(id) && !options.reinitialize) {
            const neighbors = graph.neighbors(id).filter((neighbor) => positionedNodeIds.has(neighbor));
            if (neighbors.length) {
                const center = neighbors.reduce(
                    (sum, neighbor) => {
                        const attributes = graph.getNodeAttributes(neighbor);
                        return { x: sum.x + attributes.x, y: sum.y + attributes.y };
                    },
                    { x: 0, y: 0 }
                );
                const offset = getInitialPosition(id, 1, options.seed);
                graph.mergeNodeAttributes(id, {
                    x: center.x / neighbors.length + offset.x * 0.1,
                    y: center.y / neighbors.length + offset.y * 0.1
                });
            }
        }
    });
    return graph;
}

// Community labels and the worker-owned simulation

function hasCommunity(value) {
    return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value !== '');
}

/** Retain analysis labels; isolated nodes have independent layout targets. */
export function assignFriendsNetworkCommunities(graph) {
    const communities = Object.create(null);
    graph.forEachNode((id, attributes) => {
        if (!hasCommunity(attributes.community)) {
            throw new Error(`Missing community for friends network node ${id}.`);
        }
        const community = graph.degree(id) === 0 ? `singleton:${id}` : attributes.community;
        communities[id] = community;
        graph.setNodeAttribute(id, 'community', community);
    });
    return { communities, communitySource: 'backend' };
}

/** Create a stopped D3 simulation. Worker batches advance it without using UI timers. */
export function createFriendsNetworkLayout(data) {
    const settings = normalizeFriendsNetworkLayoutSettings(data.settings);
    const graph = buildFriendsNetworkGraph(data, settings, data.positions);
    const partition = assignFriendsNetworkCommunities(graph);
    return {
        graph,
        settings,
        ...partition,
        ...createFriendsNetworkSimulation(graph, settings, data.positions),
        completedIterations: 0
    };
}

/** Advance a bounded batch, then let the worker receive newer settings or cancellation. */
export function stepFriendsNetworkLayout(state) {
    const remaining = state.settings.layoutIterations - state.completedIterations;
    const iterations = Math.min(state.settings.batchIterations, remaining);
    state.simulation.tick(iterations);
    state.completedIterations += iterations;
    return (
        state.simulation.alpha() < state.simulation.alphaMin() ||
        state.completedIterations >= state.settings.layoutIterations
    );
}

/** Copy finite graph coordinates into the worker's settled layout reply. */
export function collectFriendsNetworkPositions(graph) {
    const positions = Object.create(null);
    graph.forEachNode((id, attributes) => {
        if (!hasFinitePosition(attributes)) {
            throw new Error('Friends network layout produced a non-finite position.');
        }
        positions[id] = { x: attributes.x, y: attributes.y };
    });
    return positions;
}

/** Publish positions only after the requested simulation has settled. */
export function finishFriendsNetworkLayout(state) {
    for (const node of state.nodes) {
        state.graph.mergeNodeAttributes(node.id, { x: node.x, y: node.y });
    }
    return {
        positions: collectFriendsNetworkPositions(state.graph),
        communities: state.communities,
        communitySource: state.communitySource
    };
}

/**
 * Latest-request-wins worker controller, exported for tests without worker globals.
 * The simulation retains velocity and convergence between worker batches.
 */
export function createFriendsNetworkLayoutController(
    postMessage,
    { yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)) } = {}
) {
    let generation = 0;
    const dragController = createFriendsNetworkDragController(postMessage);
    return {
        async handle(data) {
            // Drag messages update the settled simulation without replacing it.
            if (data.type === 'drag') {
                dragController.handle(data);
                return;
            }
            const currentGeneration = ++generation;
            dragController.cancel();
            if (data.cancel) {
                return;
            }
            try {
                // Yield before reconstruction too, so a burst of slider events
                // skips obsolete jobs before community detection starts.
                await yieldControl();
                if (currentGeneration !== generation) {
                    return;
                }
                // Advance bounded batches so newer requests can cancel this job.
                const state = createFriendsNetworkLayout(data);
                while (!stepFriendsNetworkLayout(state)) {
                    await yieldControl();
                    if (currentGeneration !== generation) {
                        return;
                    }
                }
                // Keep the settled simulation for later pointer interaction.
                if (currentGeneration === generation) {
                    const result = finishFriendsNetworkLayout(state);
                    dragController.attach(state, data.requestId);
                    postMessage({
                        requestId: data.requestId,
                        ...result,
                        nodeIds: state.nodes.map((node) => node.id),
                        done: true
                    });
                }
            } catch (error) {
                if (currentGeneration === generation) {
                    postMessage({
                        requestId: data.requestId,
                        error: error instanceof Error ? error.message : String(error),
                        done: true
                    });
                }
            }
        },
        cancel() {
            generation++;
            dragController.cancel();
        }
    };
}

/**
 * Main-thread adapter. Superseded requests resolve null immediately, and stale
 * worker replies can never apply positions to a newer graph or changed settings.
 *
 * @param {() => Worker} createWorker
 * @param {{ onProgress?: (data: any) => void }} options
 */
export function createFriendsNetworkLayoutClient(createWorker, { onProgress } = {}) {
    let worker;
    let listeners;
    let requestSequence = 0;
    let pendingRequest = null;
    let disposed = false;
    let activeRequestId = 0;
    // Resolve pending layouts and route live frames for the active request only.
    const handleWorkerMessage = ({ data }) => {
        if (data.live) {
            if (!disposed && data.requestId === activeRequestId && !pendingRequest) {
                onProgress?.(data);
            }
            return;
        }
        if (!pendingRequest || pendingRequest.requestId !== data.requestId) {
            return;
        }
        if (data.error) {
            pendingRequest.reject(new Error(data.error));
            pendingRequest = null;
        } else if (data.done === false) {
            onProgress?.(data);
        } else {
            pendingRequest.resolve(data);
            pendingRequest = null;
        }
    };
    function releaseWorker() {
        if (!worker) {
            return;
        }
        for (const [name, handler] of Object.entries(listeners)) {
            worker.removeEventListener(name, handler);
        }
        worker.terminate();
        worker = undefined;
    }

    function failWorker(event) {
        event.preventDefault?.();
        pendingRequest?.reject(new Error(event.message || 'Friends network layout worker failed.'));
        pendingRequest = null;
        activeRequestId = 0;
        releaseWorker();
    }

    // A failed worker cannot be reused. Create a replacement only on the next
    // layout request, and ignore any queued events from the previous instance.
    function ensureWorker() {
        if (!worker) {
            const target = createWorker();
            worker = target;
            listeners = {
                message: (event) => {
                    if (worker === target) {
                        handleWorkerMessage(event);
                    }
                },
                error: (event) => {
                    if (worker === target) {
                        failWorker(event);
                    }
                },
                messageerror: (event) => {
                    if (worker === target) {
                        failWorker(event);
                    }
                }
            };
            for (const [name, handler] of Object.entries(listeners)) {
                target.addEventListener(name, handler);
            }
        }
        return worker;
    }
    return {
        layout(data) {
            if (disposed) {
                return Promise.reject(new Error('Friends network layout client is disposed.'));
            }
            pendingRequest?.resolve(null);
            const requestId = ++requestSequence;
            activeRequestId = requestId;
            return new Promise((resolve, reject) => {
                pendingRequest = { requestId, resolve, reject };
                try {
                    ensureWorker().postMessage({ ...data, requestId });
                } catch (error) {
                    pendingRequest = null;
                    activeRequestId = 0;
                    releaseWorker();
                    reject(error);
                }
            });
        },
        cancel() {
            pendingRequest?.resolve(null);
            pendingRequest = null;
            activeRequestId = 0;
            worker?.postMessage({ requestId: ++requestSequence, cancel: true });
        },
        drag(message) {
            if (!disposed && activeRequestId && !pendingRequest) {
                worker.postMessage({ ...message, type: 'drag', requestId: activeRequestId });
            }
        },
        dispose() {
            // This client owns the worker and its event listeners.
            pendingRequest?.resolve(null);
            pendingRequest = null;
            disposed = true;
            activeRequestId = 0;
            releaseWorker();
        }
    };
}
