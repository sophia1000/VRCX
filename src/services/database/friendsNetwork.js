import sqliteService from '../sqlite.js';

const ACCOUNT_TABLE =
    /^usr[0-9a-f]{32}_(?:friend_log_current|friend_log_history|mutual_graph_links|mutual_graph_meta|mutual_graph_friends|feed_(?:gps|status|bio|avatar|online_offline)|user_profile|notes|moderation)$/i;
const GLOBAL_TABLES = new Set([
    'gamelog_location',
    'gamelog_join_leave',
    'gamelog_event',
    'gamelog_external',
    'gamelog_portal_spawn',
    'gamelog_video_play',
    'cache_user',
    'user_history',
    'user_profile'
]);
const SOURCE_COLUMNS = new Set([
    'id',
    'user_id',
    'display_name',
    'previous_display_name',
    'name',
    'created_at',
    'updated_at',
    'added_at',
    'type',
    'location',
    'world_name',
    'time',
    'friend_id',
    'mutual_id',
    'opted_out',
    'data'
]);

function quoteIdentifier(value) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
        throw new Error('Invalid history table or column identifier.');
    }
    return `"${value}"`;
}

function checkCancelled(signal) {
    if (signal?.aborted) {
        throw new DOMException('History loading was cancelled.', 'AbortError');
    }
}

async function query(sql, args, signal) {
    checkCancelled(signal);
    const rows = [];
    await sqliteService.execute((row) => rows.push(row), sql, args);
    checkCancelled(signal);
    return rows;
}

/**
 * Stream existing tables through the shared SQLite wrapper. Each bounded SELECT
 * releases its read lock before the next batch, allowing normal logging to run.
 * No feature cache or other state is written to the database.
 *
 * @param {{ signal?: AbortSignal; onProgress?: Function; onBatch: Function; batchSize?: number }} options
 */
export async function loadFriendsNetworkHistory({ signal, onProgress, onBatch, batchSize = 2000 }) {
    if (typeof onBatch !== 'function') {
        throw new TypeError('A history batch consumer is required.');
    }
    const limit = Math.min(5000, Math.max(1, Math.floor(Number(batchSize) || 2000)));
    const schema = await query("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name", null, signal);
    const tables = schema.filter(([name]) => GLOBAL_TABLES.has(name) || ACCOUNT_TABLE.test(name));
    if (
        !tables.some(([name]) => name === 'gamelog_location') ||
        !tables.some(([name]) => name === 'gamelog_join_leave')
    ) {
        throw new Error('VRCX game log tables are not available yet.');
    }
    let totalRows = 0;
    for (let tableIndex = 0; tableIndex < tables.length; tableIndex++) {
        const [table, definition] = tables[tableIndex];
        const quotedTable = quoteIdentifier(table);
        const info = await query(`PRAGMA table_info(${quotedTable})`, null, signal);
        const columns = info.map((row) => row[1]).filter((column) => SOURCE_COLUMNS.has(column));
        // Normal VRCX tables have rowid, including tables with text primary keys.
        // A primary-key tuple also supports imported WITHOUT ROWID snapshots.
        const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(definition || '');
        const keys = withoutRowid
            ? info
                  .filter((row) => Number(row[5]) > 0)
                  .sort((a, b) => a[5] - b[5])
                  .map((row) => row[1])
            : ['rowid'];
        if (!columns.length || !keys.length) {
            continue;
        }
        const keySql = keys.map(quoteIdentifier);
        const keyTuple = `(${keySql.join(', ')})`;
        const upperRows = await query(
            `SELECT ${keySql.join(', ')} FROM ${quotedTable} ORDER BY ${keySql.map((key) => `${key} DESC`).join(', ')} LIMIT 1`,
            null,
            signal
        );
        let after = null;
        let firstBatch = true;
        if (!upperRows.length) {
            await onBatch({ table, columns, rows: [] });
        } else {
            const upper = upperRows[0];
            while (true) {
                const args = { '@limit': limit };
                const placeholders = (prefix, values) =>
                    values
                        .map((value, index) => {
                            const name = `@${prefix}${index}`;
                            args[name] = value;
                            return name;
                        })
                        .join(', ');
                const upperTuple = `(${placeholders('upper', upper)})`;
                const afterClause = after ? ` AND ${keyTuple} > (${placeholders('after', after)})` : '';
                const raw = await query(
                    `SELECT ${[...keySql, ...columns.map(quoteIdentifier)].join(', ')} FROM ${quotedTable} WHERE ${keyTuple} <= ${upperTuple}${afterClause} ORDER BY ${keySql.join(', ')} LIMIT @limit`,
                    args,
                    signal
                );
                if (!raw.length) {
                    if (firstBatch) {
                        await onBatch({ table, columns, rows: [] });
                    }
                    break;
                }
                after = raw[raw.length - 1].slice(0, keys.length);
                const rows = raw.map((row) =>
                    Object.fromEntries(columns.map((column, index) => [column, row[index + keys.length]]))
                );
                await onBatch({ table, columns: firstBatch ? columns : undefined, rows });
                checkCancelled(signal);
                firstBatch = false;
                totalRows += rows.length;
                onProgress?.({
                    stage: 'reading',
                    table,
                    rows: totalRows,
                    completedTables: tableIndex,
                    totalTables: tables.length,
                    progress: tableIndex / tables.length,
                    message: `Reading history: ${totalRows.toLocaleString()} rows`
                });
                if (raw.length < limit) {
                    break;
                }
                // Yield between bridge calls even when a test or alternate bridge
                // resolves synchronously; the renderer must remain responsive.
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }
    }
    onProgress?.({
        stage: 'reading',
        rows: totalRows,
        completedTables: tables.length,
        totalTables: tables.length,
        progress: 1,
        message: 'History read complete'
    });
    return { tables: tables.length, rows: totalRows };
}
