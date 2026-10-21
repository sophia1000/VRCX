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
const TIMESTAMP_COLUMNS = ['created_at', 'updated_at', 'added_at'];

function neededColumns(table) {
    const kind = table.replace(/^usr[0-9a-f]{32}_/i, '');
    switch (kind) {
        case 'gamelog_location':
            return new Set(['id', ...TIMESTAMP_COLUMNS, 'time', 'location', 'world_name']);
        case 'gamelog_join_leave':
            return new Set(['id', 'user_id', 'display_name', ...TIMESTAMP_COLUMNS, 'type', 'location', 'time']);
        case 'mutual_graph_meta':
            return new Set(['friend_id', 'opted_out']);
        case 'mutual_graph_links':
            return new Set(['friend_id', 'mutual_id']);
        default:
            return new Set([
                'user_id',
                'display_name',
                'name',
                ...TIMESTAMP_COLUMNS,
                'previous_display_name',
                ...(['cache_user', 'user_profile'].includes(kind) ? ['id'] : []),
                ...(kind.startsWith('gamelog_') ? ['location'] : [])
            ]);
    }
}

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
    await sqliteService.execute((row) => rows.push(row), sql, args, { bulk: true });
    checkCancelled(signal);
    return rows;
}

/**
 * Stream existing tables through the shared SQLite wrapper. Each bounded SELECT
 * releases its read lock before the next batch, allowing normal logging to run.
 * No feature cache or other state is written to the database.
 *
 * @param {{
 *     signal?: AbortSignal;
 *     onProgress?: Function;
 *     onBatch: Function;
 *     batchSize?: number;
 *     rowFormat?: 'objects' | 'arrays';
 * }} options
 */
export async function loadFriendsNetworkHistory({
    signal,
    onProgress,
    onBatch,
    batchSize = 10000,
    rowFormat = 'objects'
}) {
    if (typeof onBatch !== 'function') {
        throw new TypeError('A history batch consumer is required.');
    }
    if (rowFormat !== 'objects' && rowFormat !== 'arrays') {
        throw new TypeError('History row format must be objects or arrays.');
    }
    const limit = Math.min(20000, Math.max(1, Math.floor(Number(batchSize) || 10000)));
    const formatMetadata = rowFormat === 'arrays' ? { rowFormat } : {};
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
        // Keep eligible account tables even when their rows contain no consumed
        // fields, because an empty batch still identifies the observer account.
        const sourceColumns = info.map((row) => row[1]).filter((column) => SOURCE_COLUMNS.has(column));
        const needed = neededColumns(table);
        const columns = sourceColumns.filter((column) => needed.has(column));
        // Normal VRCX tables have rowid, including tables with text primary keys.
        // A primary-key tuple also supports imported WITHOUT ROWID snapshots.
        const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(definition || '');
        const keys = withoutRowid
            ? info
                  .filter((row) => Number(row[5]) > 0)
                  .sort((a, b) => a[5] - b[5])
                  .map((row) => row[1])
            : ['rowid'];
        if (!sourceColumns.length || !keys.length) {
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
            await onBatch({ ...formatMetadata, table, columns, rows: [] });
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
                        await onBatch({ ...formatMetadata, table, columns, rows: [] });
                    }
                    break;
                }
                after = raw[raw.length - 1].slice(0, keys.length);
                const rows =
                    rowFormat === 'arrays'
                        ? raw.map((row) => row.slice(keys.length))
                        : raw.map((row) =>
                              Object.fromEntries(columns.map((column, index) => [column, row[index + keys.length]]))
                          );
                await onBatch({ ...formatMetadata, table, columns: firstBatch ? columns : undefined, rows });
                // Native bridge calls and worker acknowledgements already yield
                // to the task queue. A timer here adds delay to every batch and
                // can be throttled heavily while the application is hidden.
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
