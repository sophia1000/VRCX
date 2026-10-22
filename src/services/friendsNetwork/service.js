import { loadFriendsNetworkHistory } from '../database/friendsNetwork';
import { normalizeFriendsNetworkScope } from './scoring';

/**
 * Own the observed-history worker for this application session.
 *
 * Importing this module does no work. The first graph request reads history,
 * and the worker retains its reconstructed data until the application closes.
 * Leaving the page cancels the requested graph without throwing that data away.
 */
export function createFriendsNetworkService({
    createWorker = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
    loadHistory = loadFriendsNetworkHistory
} = {}) {
    let worker;
    let nextMessageId = 0;
    let graphRevision = 0;
    let historyReady = false;
    let loadingHistory;
    let historyAbort;
    let disposed = false;
    let state = { busy: false, stage: 'idle', progress: 0, accounts: [] };
    const pending = new Map();

    function updateStatus(update) {
        state = { ...state, ...update };
    }

    function failWorker(reason) {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        for (const request of pending.values()) {
            request.reject(error);
        }
        pending.clear();
        historyAbort?.abort();
        worker?.terminate();
        worker = undefined;
        historyReady = false;
        updateStatus({ busy: false, stage: 'error' });
    }

    function ensureWorker() {
        if (disposed) {
            throw new Error('The friends network service has been disposed.');
        }
        if (worker) {
            return worker;
        }
        worker = createWorker();
        const target = worker;
        target.addEventListener('message', ({ data }) => {
            if (worker !== target) {
                return;
            }
            const request = pending.get(data.id);
            if (!request) {
                return;
            }
            if (data.type === 'progress') {
                request.onProgress?.(data.status);
                return;
            }
            pending.delete(data.id);
            if (data.error) {
                request.reject(new Error(data.error));
            } else {
                request.resolve(data.result);
            }
        });
        target.addEventListener('error', (event) => {
            event.preventDefault?.();
            if (worker !== target) {
                return;
            }
            failWorker(new Error(event.message || 'The friends network worker stopped unexpectedly.'));
        });
        target.addEventListener('messageerror', () => {
            if (worker !== target) {
                return;
            }
            failWorker(new Error('The friends network worker could not read a message.'));
        });
        return worker;
    }

    function request(type, payload = {}, onProgress = undefined) {
        const target = ensureWorker();
        const id = ++nextMessageId;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject, onProgress });
            try {
                target.postMessage({ id, type, payload });
            } catch (error) {
                pending.delete(id);
                reject(error);
            }
        });
    }

    async function ensureHistory(rebuild) {
        if (loadingHistory) {
            return loadingHistory;
        }
        if (historyReady && !rebuild) {
            return;
        }

        // All graph requests share this import. Slider edits and page navigation
        // must not repeatedly scan history while the first read is still running.
        const abort = new AbortController();
        historyAbort = abort;
        const checkImport = () => {
            if (abort.signal.aborted || disposed) {
                throw new DOMException('History loading was cancelled.', 'AbortError');
            }
        };
        loadingHistory = (async () => {
            const batchAcknowledgements = [];
            updateStatus({ busy: true, stage: 'reading', progress: 0 });
            await request('beginHistory');
            await loadHistory({
                signal: abort.signal,
                rowFormat: 'arrays',
                onBatch: async (batch) => {
                    checkImport();
                    const acknowledgement = request('historyBatch', batch);
                    // Observe failures immediately, even if a native read fails
                    // before this acknowledgement reaches the final barrier.
                    acknowledgement.catch(() => {});
                    batchAcknowledgements.push(acknowledgement);
                    // Keep at most two batches in flight. Native reads remain
                    // sequential while the next read overlaps worker processing.
                    if (batchAcknowledgements.length >= 2) {
                        await batchAcknowledgements.shift();
                    }
                },
                onProgress: (progress) => {
                    if (abort.signal.aborted || disposed) {
                        return;
                    }
                    updateStatus({
                        ...progress,
                        busy: true,
                        stage: 'reading',
                        progress: Math.max(0, Math.min(1, progress.progress || 0)) * 0.4
                    });
                }
            });
            // Reconstruction must never see an unacknowledged or failed batch.
            await Promise.all(batchAcknowledgements);
            checkImport();
            const result = await request('finishHistory', {}, (progress) => {
                if (abort.signal.aborted || disposed) {
                    return;
                }
                updateStatus({
                    ...progress,
                    busy: true,
                    stage: 'reconstructing',
                    progress: 0.4 + Math.max(0, Math.min(1, progress.progress || 0)) * 0.2
                });
            });
            checkImport();
            historyReady = true;
            updateStatus({ accounts: result.accounts, progress: 0.6 });
        })();

        try {
            await loadingHistory;
        } catch (error) {
            // Release an incomplete import without disturbing the last good
            // dataset. A later visit can retry after a transient read failure.
            if (worker && !disposed) {
                await request('discardHistory').catch(() => {});
            }
            throw error;
        } finally {
            // Late callbacks from a failed reader cannot mutate a newer import.
            abort.abort();
            if (historyAbort === abort) {
                historyAbort = undefined;
            }
            loadingHistory = undefined;
        }
    }

    async function graph(options = {}, rebuild = false) {
        if (disposed) {
            return { cancelled: true };
        }
        const revision = ++graphRevision;
        const scopedOptions = { ...options, ...normalizeFriendsNetworkScope(options) };
        worker?.postMessage({ type: 'cancel' });
        const needsHistory = !historyReady || rebuild || Boolean(loadingHistory);
        updateStatus(
            loadingHistory ? { busy: true } : { busy: true, stage: needsHistory ? 'reading' : 'overlaps', progress: 0 }
        );
        try {
            await ensureHistory(rebuild);
            if (revision !== graphRevision || disposed) {
                return { cancelled: true };
            }
            const result = await request('graph', scopedOptions, (progress) => {
                if (revision === graphRevision) {
                    const fraction = Math.max(0, Math.min(1, progress.progress || 0));
                    updateStatus({
                        ...progress,
                        busy: true,
                        progress: needsHistory ? 0.6 + fraction * 0.4 : fraction
                    });
                }
            });
            if (revision !== graphRevision || disposed) {
                return { cancelled: true };
            }
            updateStatus({ stage: 'ready', progress: 1 });
            return result;
        } catch (error) {
            if (revision !== graphRevision || disposed) {
                return { cancelled: true };
            }
            updateStatus({ stage: 'error' });
            throw error;
        } finally {
            if (revision === graphRevision && !disposed) {
                updateStatus({ busy: false });
            }
        }
    }

    function cancel() {
        const revision = ++graphRevision;
        worker?.postMessage({ type: 'cancel' });
        updateStatus({ busy: Boolean(loadingHistory) });
        // The shared import can finish after the page closes. Its completion
        // must release busy state even when no replacement graph was requested.
        loadingHistory
            ?.finally(() => {
                if (revision === graphRevision && !disposed) {
                    updateStatus({ busy: false });
                }
            })
            .catch(() => {});
    }

    async function people(scope = {}) {
        const currentScope = normalizeFriendsNetworkScope(scope);
        if (!currentScope.current_user_id || !currentScope.friend_ids.length) {
            return { users: [] };
        }
        if (loadingHistory) {
            await loadingHistory;
        }
        if (historyReady) {
            return request('people', currentScope);
        }
        return {
            users: currentScope.friend_ids.map((id) => ({ id, name: id, is_friend: true, join_count: 0 }))
        };
    }

    function dispose() {
        disposed = true;
        ++graphRevision;
        failWorker(new Error('The friends network service has been disposed.'));
    }

    return { graph, people, cancel, status: () => ({ ...state }), dispose };
}

export default createFriendsNetworkService();
