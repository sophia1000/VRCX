import { createFriendsNetworkHistoryBuilder } from './history';
import { createFriendsNetworkAnalysis } from './analysis';

/**
 * Handle the small message protocol shared by the worker and its lifetime tests.
 * History arrives in acknowledged batches so the renderer never queues an
 * unbounded number of copies. Only a completed import replaces the active data.
 */
export function createFriendsNetworkWorkerController(
    send,
    { createHistoryBuilder = createFriendsNetworkHistoryBuilder, createAnalysis = createFriendsNetworkAnalysis } = {}
) {
    let builder;
    let analysis;
    let graphRevision = 0;
    let graphQueue = Promise.resolve();

    /** Dispatch worker requests while keeping graph computations on one queue. */
    async function handle({ id, type, payload = {} }) {
        if (type === 'cancel') {
            ++graphRevision;
            return;
        }

        function progress(status) {
            send({ id, type: 'progress', status });
        }

        try {
            let result;
            switch (type) {
                // History import
                case 'beginHistory':
                    builder = createHistoryBuilder();
                    result = {};
                    break;
                case 'historyBatch':
                    if (!builder) {
                        throw new Error('History loading has not started.');
                    }
                    builder.addBatch(payload);
                    result = {};
                    break;
                case 'finishHistory': {
                    if (!builder) {
                        throw new Error('History loading has not started.');
                    }
                    const dataset = await builder.finish({ onProgress: progress });
                    dataset.builtAt = Date.now() / 1000;
                    analysis = createAnalysis(dataset);
                    builder = undefined;
                    result = {};
                    break;
                }
                // Graph requests can supersede work while retaining imported history.
                case 'graph': {
                    if (!analysis) {
                        throw new Error('History is not ready.');
                    }
                    const revision = ++graphRevision;
                    const currentAnalysis = analysis;
                    const computation = graphQueue.then(() => {
                        if (revision !== graphRevision) {
                            return { cancelled: true };
                        }
                        return currentAnalysis.graph(payload, {
                            onProgress: (status) => {
                                if (revision === graphRevision) {
                                    progress(status);
                                }
                            },
                            isCancelled: () => revision !== graphRevision
                        });
                    });
                    // Analysis retains mutable window/evidence caches. Finish a
                    // cancelled computation before allowing another to use them.
                    graphQueue = computation.then(
                        () => {},
                        () => {}
                    );
                    result = await computation;
                    if (revision !== graphRevision) {
                        result = { cancelled: true };
                    }
                    break;
                }
                // Directory requests carry their own current friend scope.
                case 'people':
                    result = analysis ? analysis.people(payload) : { users: [] };
                    break;
                case 'discardHistory':
                    builder = undefined;
                    result = {};
                    break;
                default:
                    throw new Error(`Unknown friends network request: ${type}`);
            }
            send({ id, type: 'result', result });
        } catch (error) {
            if (error.name === 'AbortError') {
                send({ id, type: 'result', result: { cancelled: true } });
            } else {
                send({ id, type: 'result', error: error.message || String(error) });
            }
        }
    }

    return { handle };
}
