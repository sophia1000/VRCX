/**
 * Keep the settled worker simulation available for direct manipulation. Dragged
 * people follow the pointer, while their neighbors continue responding to forces.
 * At rest there is no timer and no background CPU work.
 */
export function createFriendsNetworkDragController(
    postMessage,
    { scheduleFrame = (callback) => setTimeout(callback, 16), clearFrame = clearTimeout } = {}
) {
    let activeLayout = null;
    let frameTimer = null;
    let draggedNodeIds = new Set();
    let isDraggingGroup = false;

    // Transfer only positions; the renderer already knows the node order.
    function publish() {
        const positions = new Float64Array(activeLayout.nodes.length * 2);
        activeLayout.nodes.forEach((node, index) => {
            positions[index * 2] = node.x;
            positions[index * 2 + 1] = node.y;
        });
        postMessage({ requestId: activeLayout.requestId, positions, live: true }, [positions.buffer]);
    }

    // Run frames while a pointer is held or the released layout is still settling.
    function tick() {
        frameTimer = null;
        if (!activeLayout) {
            return;
        }
        activeLayout.simulation.tick(2);
        publish();
        if (draggedNodeIds.size || activeLayout.simulation.alpha() >= activeLayout.simulation.alphaMin()) {
            frameTimer = scheduleFrame(tick);
        }
    }

    function wake() {
        if (frameTimer === null) {
            frameTimer = scheduleFrame(tick);
        }
    }

    // Remove simulation pins before a new drag, release or cancellation.
    function release() {
        for (const id of draggedNodeIds) {
            const node = activeLayout.byId.get(id);
            node.fx = null;
            node.fy = null;
        }
        draggedNodeIds.clear();
        activeLayout.simulation.alphaTarget(0);
    }

    // Attach settled layouts and handle messages for their request ID only.
    return {
        attach(state, requestId) {
            this.cancel();
            activeLayout = { ...state, requestId, byId: new Map(state.nodes.map((node) => [node.id, node])) };
        },
        handle(message) {
            if (!activeLayout || message.requestId !== activeLayout.requestId) {
                return;
            }
            if (message.phase === 'end') {
                release();
                wake();
                return;
            }
            if (message.phase === 'start') {
                release();
                draggedNodeIds = new Set(
                    (message.nodes || []).map((node) => node.id).filter((id) => activeLayout.byId.has(id))
                );
                isDraggingGroup = Boolean(message.group);
            }
            if (!draggedNodeIds.size) {
                return;
            }
            for (const update of message.nodes || []) {
                if (!draggedNodeIds.has(update.id) || !Number.isFinite(update.x) || !Number.isFinite(update.y)) {
                    continue;
                }
                const node = activeLayout.byId.get(update.id);
                if (isDraggingGroup) {
                    // Move a circle's anchor with it, so releasing the group does
                    // not immediately spring it back to its old spiral position.
                    node.targetX += update.x - node.x;
                    node.targetY += update.y - node.y;
                }
                node.x = node.fx = update.x;
                node.y = node.fy = update.y;
                node.vx = node.vy = 0;
            }
            activeLayout.simulation.alpha(Math.max(0.35, activeLayout.simulation.alpha())).alphaTarget(0.12);
            wake();
        },
        cancel() {
            // Stop scheduled work before releasing the worker-owned layout.
            if (frameTimer !== null) {
                clearFrame(frameTimer);
                frameTimer = null;
            }
            if (activeLayout) {
                release();
            }
            activeLayout = null;
        }
    };
}
