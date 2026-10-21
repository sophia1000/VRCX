import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../sqlite.js', () => ({ default: { execute: mocks.execute } }));
import { loadFriendsNetworkHistory } from '../friendsNetwork.js';

const PREFIX = 'usr11111111111111111111111111111111';
let database;

beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(`
        CREATE TABLE gamelog_location (id INTEGER PRIMARY KEY, created_at TEXT, location TEXT, time INTEGER);
        CREATE TABLE gamelog_join_leave (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT);
        CREATE TABLE unrelated_settings (key TEXT, value TEXT);
        INSERT INTO unrelated_settings VALUES ('theme', 'dark');
        INSERT INTO gamelog_location VALUES (2, '2026-10-01', 'a', 1000), (7, '2026-10-02', 'b', 2000), (25, '2026-10-03', 'c', 3000);
        CREATE TABLE ${PREFIX}_friend_log_current (user_id TEXT PRIMARY KEY, display_name TEXT);
        INSERT INTO ${PREFIX}_friend_log_current VALUES ('a', 'Alice');
    `);
    mocks.execute.mockReset();
    mocks.execute.mockImplementation(async (callback, sql, args) => {
        const statement = database.prepare(sql);
        statement.setReturnArrays(true);
        const parameters = Object.fromEntries(Object.entries(args || {}).map(([key, value]) => [key.slice(1), value]));
        for (const row of statement.all(parameters)) callback(row);
    });
});
afterEach(() => database.close());

describe('observed history database reader', () => {
    test('streams sparse row IDs in bounded batches and only issues read statements', async () => {
        const batches = [];
        const before = database.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
        const result = await loadFriendsNetworkHistory({ batchSize: 2, onBatch: (batch) => batches.push(batch) });
        expect(result.rows).toBe(4);
        const locations = batches.filter((batch) => batch.table === 'gamelog_location');
        expect(locations.map((batch) => batch.rows.length)).toEqual([2, 1]);
        expect(locations.flatMap((batch) => batch.rows.map((row) => row.id))).toEqual([2, 7, 25]);
        expect(batches.find((batch) => batch.table === 'gamelog_join_leave')).toMatchObject({ rows: [] });
        for (const [, sql, , options] of mocks.execute.mock.calls) {
            expect(sql).toMatch(/^(SELECT|PRAGMA table_info)/);
            expect(options).toEqual({ bulk: true });
            expect(sql).not.toMatch(/OFFSET|json_group|json_object/i);
        }
        expect(database.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before);
        expect(database.prepare('SELECT * FROM unrelated_settings').get()).toEqual({ key: 'theme', value: 'dark' });
    });

    test('array batches preserve object data and send column metadata once per table', async () => {
        const objectBatches = [];
        const arrayBatches = [];
        await loadFriendsNetworkHistory({ batchSize: 2, onBatch: (batch) => objectBatches.push(batch) });
        await loadFriendsNetworkHistory({
            batchSize: 2,
            rowFormat: 'arrays',
            onBatch: (batch) => arrayBatches.push(batch)
        });
        const columnsByTable = new Map();
        expect(arrayBatches).toHaveLength(objectBatches.length);
        for (let index = 0; index < arrayBatches.length; index++) {
            const batch = arrayBatches[index];
            expect(batch.rowFormat).toBe('arrays');
            if (columnsByTable.has(batch.table)) {
                expect(batch.columns).toBeUndefined();
            } else {
                expect(Array.isArray(batch.columns)).toBe(true);
                columnsByTable.set(batch.table, batch.columns);
            }
            const columns = columnsByTable.get(batch.table);
            const rows = batch.rows.map((row) =>
                Object.fromEntries(columns.map((column, columnIndex) => [column, row[columnIndex]]))
            );
            expect({ table: batch.table, rows }).toEqual({
                table: objectBatches[index].table,
                rows: objectBatches[index].rows
            });
            expect(objectBatches[index]).not.toHaveProperty('rowFormat');
        }
        expect(arrayBatches.find((batch) => batch.table === 'gamelog_join_leave')).toMatchObject({
            columns: ['id', 'created_at', 'user_id'],
            rows: []
        });
    });

    test.each(['objects', 'arrays'])(
        'awaits the %s consumer and bounds tables to their initial high-water mark',
        async (rowFormat) => {
            let pending = false;
            const ids = [];
            await loadFriendsNetworkHistory({
                batchSize: 1,
                rowFormat,
                onBatch: async (batch) => {
                    expect(pending).toBe(false);
                    pending = true;
                    if (batch.table === 'gamelog_location') {
                        ids.push(...batch.rows.map((row) => (rowFormat === 'arrays' ? row[0] : row.id)));
                        if (ids.length === 1)
                            database.exec("INSERT INTO gamelog_location VALUES (100, '2026-10-04', 'd', 1000)");
                    }
                    await Promise.resolve();
                    pending = false;
                }
            });
            expect(ids).toEqual([2, 7, 25]);
        }
    );

    test.each(['objects', 'arrays'])('supports %s composite primary-key snapshots without rowid', async (rowFormat) => {
        database.exec(`CREATE TABLE ${PREFIX}_mutual_graph_links (friend_id TEXT, mutual_id TEXT, PRIMARY KEY(friend_id, mutual_id)) WITHOUT ROWID;
            INSERT INTO ${PREFIX}_mutual_graph_links VALUES ('a', 'b'), ('a', 'c'), ('b', 'c');`);
        const rows = [];
        await loadFriendsNetworkHistory({
            batchSize: 1,
            rowFormat,
            onBatch: (batch) => {
                if (batch.table.endsWith('_mutual_graph_links')) {
                    rows.push(
                        ...batch.rows.map((row) =>
                            rowFormat === 'arrays' ? { friend_id: row[0], mutual_id: row[1] } : row
                        )
                    );
                }
            }
        });
        expect(rows).toEqual([
            { friend_id: 'a', mutual_id: 'b' },
            { friend_id: 'a', mutual_id: 'c' },
            { friend_id: 'b', mutual_id: 'c' }
        ]);
    });

    test('projects only consumed columns while retaining timestamp fallbacks and aliases', async () => {
        database.exec(`
            ALTER TABLE gamelog_location ADD COLUMN data TEXT;
            ALTER TABLE gamelog_location ADD COLUMN display_name TEXT;
            CREATE TABLE cache_user (id TEXT, name TEXT, updated_at TEXT, data TEXT);
            INSERT INTO cache_user VALUES ('a', 'Alice', '2026-10-01', 'unused profile blob');
            CREATE TABLE ${PREFIX}_friend_log_history (id INTEGER, user_id TEXT, display_name TEXT, previous_display_name TEXT, created_at TEXT, updated_at TEXT, added_at TEXT, type TEXT, data TEXT);
            INSERT INTO ${PREFIX}_friend_log_history VALUES (1, 'a', 'Alice', 'Old Alice', NULL, '2026-10-02', '2026-10-01', 'unused type', 'unused history blob');
        `);
        const batches = [];
        await loadFriendsNetworkHistory({ onBatch: (batch) => batches.push(batch) });
        expect(batches.find((batch) => batch.table === 'cache_user').rows).toEqual([
            { id: 'a', name: 'Alice', updated_at: '2026-10-01' }
        ]);
        expect(batches.find((batch) => batch.table.endsWith('_friend_log_history')).rows).toEqual([
            {
                user_id: 'a',
                display_name: 'Alice',
                previous_display_name: 'Old Alice',
                created_at: null,
                updated_at: '2026-10-02',
                added_at: '2026-10-01'
            }
        ]);
        for (const [, sql] of mocks.execute.mock.calls) {
            if (sql.includes('LIMIT @limit')) {
                expect(sql).not.toContain('"data"');
                if (sql.includes('FROM "gamelog_location"')) expect(sql).not.toContain('"display_name"');
            }
        }
    });

    test('retains account batches when all recognized source columns are unused', async () => {
        database.exec(
            `CREATE TABLE ${PREFIX}_notes (id TEXT, data TEXT); INSERT INTO ${PREFIX}_notes VALUES ('a', 'unused note');`
        );
        const batches = [];
        await loadFriendsNetworkHistory({ rowFormat: 'arrays', onBatch: (batch) => batches.push(batch) });
        expect(batches.find((batch) => batch.table.endsWith('_notes'))).toMatchObject({ columns: [], rows: [[]] });
    });

    test.each([
        [undefined, 10000],
        [999999, 20000],
        [2, 2]
    ])('bounds batch size %s to %s rows', async (batchSize, expected) => {
        await loadFriendsNetworkHistory({ batchSize, onBatch: () => {} });
        const batchQueries = mocks.execute.mock.calls.filter(([, sql]) => sql.includes('LIMIT @limit'));
        expect(batchQueries.length).toBeGreaterThan(0);
        expect(batchQueries.every(([, , args]) => args['@limit'] === expected)).toBe(true);
    });

    test('cancels between batches and does not read unrelated or crafted table names', async () => {
        database.exec('CREATE TABLE "gamelog_location; DROP TABLE unrelated_settings" (id INTEGER);');
        const controller = new AbortController();
        await expect(
            loadFriendsNetworkHistory({ signal: controller.signal, onBatch: () => controller.abort() })
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.execute.mock.calls.every(([, sql]) => !sql.includes('DROP TABLE'))).toBe(true);
        expect(database.prepare('SELECT COUNT(*) AS count FROM unrelated_settings').get().count).toBe(1);
    });
});
