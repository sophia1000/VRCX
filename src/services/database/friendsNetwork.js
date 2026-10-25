import sqliteService from '../sqlite.js';

// These projections follow database/index.js. Unused profile blobs and log
// payloads stay in SQLite; only history reconstruction inputs cross the bridge.
const GLOBAL_COLUMNS = {
    gamelog_location: ['id', 'created_at', 'location', 'world_name', 'time'],
    gamelog_join_leave: ['id', 'created_at', 'type', 'display_name', 'location', 'user_id', 'time'],
    gamelog_event: ['created_at'],
    gamelog_external: ['created_at', 'display_name', 'user_id', 'location'],
    gamelog_portal_spawn: ['created_at', 'display_name', 'user_id', 'location'],
    gamelog_video_play: ['created_at', 'display_name', 'user_id', 'location']
};
const ACCOUNT_COLUMNS = {
    friend_log_current: ['user_id', 'display_name'],
    friend_log_history: ['created_at', 'user_id', 'display_name', 'previous_display_name'],
    mutual_graph_links: ['friend_id', 'mutual_id'],
    mutual_graph_meta: ['friend_id', 'opted_out'],
    mutual_graph_friends: [],
    feed_gps: ['created_at', 'user_id', 'display_name'],
    feed_status: ['created_at', 'user_id', 'display_name'],
    feed_bio: ['created_at', 'user_id', 'display_name'],
    feed_avatar: ['created_at', 'user_id', 'display_name'],
    feed_online_offline: ['created_at', 'user_id', 'display_name'],
    notes: ['user_id', 'display_name', 'created_at'],
    moderation: ['user_id', 'updated_at', 'display_name'],
    user_profile: ['user_id', 'updated_at']
};

function columnsForTable(table) {
    if (Object.hasOwn(GLOBAL_COLUMNS, table)) {
        return GLOBAL_COLUMNS[table];
    }
    const account = /^usr[0-9a-f]{32}_([a-z_]+)$/i.exec(table);
    return account && Object.hasOwn(ACCOUNT_COLUMNS, account[1]) ? ACCOUNT_COLUMNS[account[1]] : null;
}

function checkCancelled(signal) {
    if (signal?.aborted) {
        throw new DOMException('History loading was cancelled.', 'AbortError');
    }
}

async function query(sql, args, signal) {
    checkCancelled(signal);
    const rows = [];
    await sqliteService.execute((row) => rows.push(row), sql, args, { bulk: true });
    checkCancelled(signal);
    return rows;
}

/**
 * Read VRCX history in bounded batches, without creating or changing any tables.
 * Each batch carries its column order and compact array rows to the worker.
 *
 * @param {{ signal?: AbortSignal; onProgress?: Function; onBatch: Function; batchSize?: number }} options
 */
export async function loadFriendsNetworkHistory({ signal, onProgress, onBatch, batchSize = 10000 }) {
    const limit = Math.min(20000, Math.max(1, Math.floor(Number(batchSize) || 10000)));
    const names = await query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", null, signal);
    const tables = names.flatMap(([table]) => {
        const columns = columnsForTable(table);
        return columns ? [{ table, columns }] : [];
    });
    if (!['gamelog_location', 'gamelog_join_leave'].every((name) => tables.some(({ table }) => table === name))) {
        throw new Error('VRCX game log tables are not available yet.');
    }

    let totalRows = 0;
    for (const [index, { table, columns }] of tables.entries()) {
        checkCancelled(signal);
        // Identifiers come only from the fixed catalog and validated account
        // prefixes above. All cursor values and the limit remain SQL parameters.
        const source = `"${table}"`;
        const upperRows = columns.length ? await query(`SELECT MAX(rowid) FROM ${source}`, null, signal) : [];
        const upper = upperRows[0]?.[0];
        if (upper == null) {
            // Empty account tables still identify an observer. The mutual friend
            // ID table adds no evidence, so its rows do not need to be scanned.
            await onBatch({ table, columns, rows: [] });
        } else {
            let after = null;
            while (true) {
                const afterClause = after === null ? '' : ' AND rowid > @after';
                const args = { '@upper': upper, '@limit': limit };
                if (after !== null) {
                    args['@after'] = after;
                }
                // The upper watermark excludes appends made during this scan.
                // A first page without a lower bound also retains negative IDs.
                const raw = await query(
                    `SELECT rowid, ${columns.join(', ')} FROM ${source} WHERE rowid <= @upper${afterClause} ORDER BY rowid LIMIT @limit`,
                    args,
                    signal
                );
                const rows = raw.map((row) => row.slice(1));
                await onBatch({ table, columns, rows });
                checkCancelled(signal);
                totalRows += rows.length;
                onProgress?.({ progress: index / tables.length, rows: totalRows });
                if (raw.length < limit) {
                    break;
                }
                after = raw[raw.length - 1][0];
                if (after >= upper) {
                    break;
                }
            }
        }
        checkCancelled(signal);
        onProgress?.({ progress: (index + 1) / tables.length, rows: totalRows });
    }
    return { tables: tables.length, rows: totalRows };
}
