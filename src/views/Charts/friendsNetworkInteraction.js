/**
 * Keep the settled worker simulation available for direct manipulation. Dragged
 * people follow the pointer, while their neighbors continue responding to forces.
 * At rest there is no timer and no background CPU work.
 */
export function createFriendsNetworkDragController(
    postMessage,
    { scheduleFrame = (callback) => setTimeout(callback, 16), clearFrame = clearTimeout } = {}
) {
    let active = null;
    let timer = null;
    let dragged = new Set();
    let draggingGroup = false;

    function publish() {
        const positions = new Float64Array(active.nodes.length * 2);
        active.nodes.forEach((node, index) => {
            positions[index * 2] = node.x;
            positions[index * 2 + 1] = node.y;
        });
        postMessage({ requestId: active.requestId, positions, live: true }, [positions.buffer]);
    }

    function tick() {
        timer = null;
        if (!active) {
            return;
        }
        active.simulation.tick(2);
        publish();
        if (dragged.size || active.simulation.alpha() >= active.simulation.alphaMin()) {
            timer = scheduleFrame(tick);
        }
    }

    function wake() {
        if (timer === null) {
            timer = scheduleFrame(tick);
        }
    }

    function release() {
        for (const id of dragged) {
            const node = active.byId.get(id);
            node.fx = null;
            node.fy = null;
        }
        dragged.clear();
        active.simulation.alphaTarget(0);
    }

    return {
        attach(state, requestId) {
            this.cancel();
            active = { ...state, requestId, byId: new Map(state.nodes.map((node) => [node.id, node])) };
        },
        handle(message) {
            if (!active || message.requestId !== active.requestId) {
                return;
            }
            if (message.phase === 'end') {
                release();
                wake();
                return;
            }
            if (message.phase === 'start') {
                release();
                dragged = new Set((message.nodes || []).map((node) => node.id).filter((id) => active.byId.has(id)));
                draggingGroup = Boolean(message.group);
            }
            if (!dragged.size) {
                return;
            }
            for (const update of message.nodes || []) {
                if (!dragged.has(update.id) || !Number.isFinite(update.x) || !Number.isFinite(update.y)) {
                    continue;
                }
                const node = active.byId.get(update.id);
                if (draggingGroup) {
                    // Move a circle's anchor with it, so releasing the group does
                    // not immediately spring it back to its old spiral position.
                    node.targetX += update.x - node.x;
                    node.targetY += update.y - node.y;
                }
                node.x = node.fx = update.x;
                node.y = node.fy = update.y;
                node.vx = node.vy = 0;
            }
            active.simulation.alpha(Math.max(0.35, active.simulation.alpha())).alphaTarget(0.12);
            wake();
        },
        cancel() {
            if (timer !== null) {
                clearFrame(timer);
                timer = null;
            }
            if (active) {
                release();
            }
            active = null;
        }
    };
}
