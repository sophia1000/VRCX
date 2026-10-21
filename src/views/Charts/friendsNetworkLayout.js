import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { createFriendsNetworkSimulation } from './friendsNetworkSimulation';
import { createFriendsNetworkDragController } from './friendsNetworkInteraction';

const DEFAULT_SETTINGS = Object.freeze({
    layoutIterations: 400,
    layoutSpacing: 60,
    groupSpacing: 60,
    groupTightness: 50,
    betweenGroupPull: 100,
    resolution: 1,
    seed: 1,
    batchIterations: 8,
    reinitialize: false,
    recomputeCommunities: false
});

/** Return normalized settings without changing the caller's saved values. */
export function normalizeFriendsNetworkLayoutSettings(settings = {}) {
    function bounded(key, minimum, maximum) {
        const value = Number(settings[key] ?? DEFAULT_SETTINGS[key]);
        return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : DEFAULT_SETTINGS[key]));
    }

    return {
        layoutIterations: Math.round(bounded('layoutIterations', 1, 3000)),
        layoutSpacing: bounded('layoutSpacing', 0, 100),
        groupSpacing: bounded('groupSpacing', 0, 100),
        groupTightness: bounded('groupTightness', 0, 100),
        betweenGroupPull: bounded('betweenGroupPull', 0, 100),
        resolution: bounded('resolution', 0.01, 10),
        seed: Math.trunc(bounded('seed', 0, 0xffffffff)),
        batchIterations: Math.round(bounded('batchIterations', 1, 32)),
        reinitialize: Boolean(settings.reinitialize),
        recomputeCommunities: Boolean(settings.recomputeCommunities)
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

function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = Math.imul(state ^ (state >>> 15), state | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function finitePosition(position) {
    return Number.isFinite(position?.x) && Number.isFinite(position?.y);
}

function initialPosition(id, count, seed) {
    const random = seededRandom(hashString(`${seed}:${id}`));
    const angle = random() * Math.PI * 2;
    const radius = (0.2 + Math.sqrt(random())) * Math.max(30, Math.sqrt(count) * 10);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/**
 * Build the narrow Graphology adapter used by the layout worker.
 *
 * Input accepts backend {id,name,...} nodes and {source,target,weight,...} or
 * {a,b,weight,...} links, as well as the existing {id,attributes} serialization.
 * Evidence attributes and backend membership scores are kept unchanged.
 * This function performs no community detection or force iterations on the UI.
 */
export function buildFriendsNetworkGraph(data, settings = {}, positions = {}) {
    const options = normalizeFriendsNetworkLayoutSettings(settings);
    const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
    const nodes = new Map();
    for (const node of data.nodes ?? []) {
        if (node?.id === undefined || node.id === null || String(node.id) === '') {
            continue;
        }
        nodes.set(String(node.id), { ...node, ...node.attributes });
    }

    const warmNodes = new Set();
    for (const id of [...nodes.keys()].sort(compareIds)) {
        const node = nodes.get(id);
        const warmPosition = positions[id] ?? node;
        const useWarmPosition = !options.reinitialize && finitePosition(warmPosition);
        const position = useWarmPosition ? warmPosition : initialPosition(id, nodes.size, options.seed);
        if (useWarmPosition) {
            warmNodes.add(id);
        }
        graph.addNode(id, {
            ...node,
            x: position.x,
            y: position.y,
            label: node.label || node.name || node.displayName || id,
            type: node.type || 'circle'
        });
    }

    const links = new Map();
    for (const input of data.links ?? data.edges ?? []) {
        const edge = { ...input, ...input.attributes };
        const source = String(edge.source ?? edge.a ?? '');
        const target = String(edge.target ?? edge.b ?? '');
        const weight = Number(edge.weight ?? 1);
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
    graph.forEachNode((id) => {
        if (warmNodes.size && !warmNodes.has(id) && !options.reinitialize) {
            const neighbors = graph.neighbors(id).filter((neighbor) => warmNodes.has(neighbor));
            if (neighbors.length) {
                const center = neighbors.reduce(
                    (sum, neighbor) => {
                        const attributes = graph.getNodeAttributes(neighbor);
                        return { x: sum.x + attributes.x, y: sum.y + attributes.y };
                    },
                    { x: 0, y: 0 }
                );
                const offset = initialPosition(id, 1, options.seed);
                graph.mergeNodeAttributes(id, {
                    x: center.x / neighbors.length + offset.x * 0.1,
                    y: center.y / neighbors.length + offset.y * 0.1
                });
            }
        }
    });
    return graph;
}

function hasCommunity(value) {
    return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value !== '');
}

/** Assign stable weighted communities in the worker, or retain complete backend labels. */
export function assignFriendsNetworkCommunities(graph, settings = {}) {
    const options = normalizeFriendsNetworkLayoutSettings(settings);
    const useBackend =
        !options.recomputeCommunities &&
        graph.nodes().every((id) => hasCommunity(graph.getNodeAttribute(id, 'community')));
    const communities = Object.create(null);
    if (useBackend) {
        graph.forEachNode((id, attributes) => {
            communities[id] = graph.degree(id) === 0 ? `singleton:${id}` : attributes.community;
        });
    } else {
        const partition = graph.size
            ? louvain(graph, {
                  getEdgeWeight: 'weight',
                  resolution: options.resolution,
                  randomWalk: false,
                  rng: seededRandom(options.seed)
              })
            : Object.fromEntries(graph.nodes().map((id) => [id, id]));
        const groups = new Map();
        for (const id of graph.nodes()) {
            const label = graph.degree(id) === 0 ? `singleton:${id}` : partition[id];
            if (!groups.has(label)) {
                groups.set(label, []);
            }
            groups.get(label).push(id);
        }
        const ordered = [...groups.values()].sort(
            (left, right) => right.length - left.length || compareIds(left[0], right[0])
        );
        ordered.forEach((group, community) => {
            for (const id of group) {
                communities[id] = community;
            }
        });
    }
    graph.forEachNode((id) => graph.setNodeAttribute(id, 'community', communities[id]));
    return { communities, communitySource: useBackend ? 'backend' : 'weighted-louvain' };
}

/** Create a stopped D3 simulation. Worker batches advance it without using UI timers. */
export function createFriendsNetworkLayout(data) {
    const settings = normalizeFriendsNetworkLayoutSettings(data.settings);
    const graph = buildFriendsNetworkGraph(data, settings, data.positions);
    const partition = assignFriendsNetworkCommunities(graph, settings);
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

export function collectFriendsNetworkPositions(graph) {
    const positions = Object.create(null);
    graph.forEachNode((id, attributes) => {
        if (!finitePosition(attributes)) {
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
    const interaction = createFriendsNetworkDragController(postMessage);
    return {
        async handle(data) {
            if (data.type === 'drag') {
                interaction.handle(data);
                return;
            }
            const current = ++generation;
            interaction.cancel();
            if (data.cancel) {
                return;
            }
            try {
                // Yield before reconstruction too, so a burst of slider events
                // skips obsolete jobs before community detection starts.
                await yieldControl();
                if (current !== generation) {
                    return;
                }
                const state = createFriendsNetworkLayout(data);
                while (!stepFriendsNetworkLayout(state)) {
                    await yieldControl();
                    if (current !== generation) {
                        return;
                    }
                }
                if (current === generation) {
                    const result = finishFriendsNetworkLayout(state);
                    interaction.attach(state, data.requestId);
                    postMessage({
                        requestId: data.requestId,
                        ...result,
                        nodeIds: state.nodes.map((node) => node.id),
                        done: true
                    });
                }
            } catch (error) {
                if (current === generation) {
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
            interaction.cancel();
        }
    };
}

/**
 * Main-thread adapter. Superseded requests resolve null immediately, and stale
 * worker replies can never apply positions to a newer graph or changed settings.
 *
 * @param {Worker} worker
 * @param {{ onProgress?: (data: any) => void }} options
 */
export function createFriendsNetworkLayoutClient(worker, { onProgress } = {}) {
    let sequence = 0;
    let pending = null;
    let disposed = false;
    let activeRequestId = 0;
    const onMessage = ({ data }) => {
        if (data.live) {
            if (!disposed && data.requestId === activeRequestId && !pending) {
                onProgress?.(data);
            }
            return;
        }
        if (!pending || pending.requestId !== data.requestId) {
            return;
        }
        if (data.error) {
            pending.reject(new Error(data.error));
            pending = null;
        } else if (data.done === false) {
            onProgress?.(data);
        } else {
            pending.resolve(data);
            pending = null;
        }
    };
    const onError = (event) => {
        pending?.reject(new Error(event.message || 'Friends network layout worker failed.'));
        pending = null;
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    return {
        layout(data) {
            if (disposed) {
                return Promise.reject(new Error('Friends network layout client is disposed.'));
            }
            pending?.resolve(null);
            const requestId = ++sequence;
            activeRequestId = requestId;
            return new Promise((resolve, reject) => {
                pending = { requestId, resolve, reject };
                try {
                    worker.postMessage({ ...data, requestId });
                } catch (error) {
                    pending = null;
                    reject(error);
                }
            });
        },
        cancel() {
            pending?.resolve(null);
            pending = null;
            activeRequestId = 0;
            worker.postMessage({ requestId: ++sequence, cancel: true });
        },
        drag(message) {
            if (!disposed && activeRequestId && !pending) {
                worker.postMessage({ ...message, type: 'drag', requestId: activeRequestId });
            }
        },
        dispose() {
            pending?.resolve(null);
            pending = null;
            disposed = true;
            activeRequestId = 0;
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            worker.terminate();
        }
    };
}
