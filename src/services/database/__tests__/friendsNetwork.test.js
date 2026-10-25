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
        CREATE TABLE gamelog_location (id INTEGER PRIMARY KEY, created_at TEXT, location TEXT, world_name TEXT, time INTEGER);
        CREATE TABLE gamelog_join_leave (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, display_name TEXT, location TEXT, user_id TEXT, time INTEGER);
        CREATE TABLE ${PREFIX}_friend_log_current (user_id TEXT PRIMARY KEY, display_name TEXT);
        CREATE TABLE unrelated_settings (key TEXT, value TEXT);
        INSERT INTO unrelated_settings VALUES ('theme', 'dark');
        INSERT INTO gamelog_location VALUES (2, '2026-10-01', 'a', 'World A', 1000), (7, '2026-10-02', 'b', 'World B', 2000), (25, '2026-10-03', 'c', 'World C', 3000);
        INSERT INTO ${PREFIX}_friend_log_current VALUES ('a', 'Alice');
    `);
    mocks.execute.mockReset();
    mocks.execute.mockImplementation(async (callback, sql, args) => {
        const statement = database.prepare(sql);
        statement.setReturnArrays(true);
        const parameters = Object.fromEntries(Object.entries(args || {}).map(([key, value]) => [key.slice(1), value]));
        for (const row of statement.all(parameters)) {
            callback(row);
        }
    });
});

afterEach(() => database.close());

function objects(batch) {
    return batch.rows.map((row) => Object.fromEntries(batch.columns.map((column, index) => [column, row[index]])));
}

describe('observed history database reader', () => {
    test('reads sparse IDs in bounded array batches without changing the database', async () => {
        const batches = [];
        const before = database.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
        const result = await loadFriendsNetworkHistory({ batchSize: 2, onBatch: (batch) => batches.push(batch) });
        expect(result.rows).toBe(4);
        const locations = batches.filter((batch) => batch.table === 'gamelog_location');
        expect(locations.map((batch) => batch.rows.length)).toEqual([2, 1]);
        expect(locations.flatMap(objects).map((row) => row.id)).toEqual([2, 7, 25]);
        expect(locations.every((batch) => batch.columns.includes('created_at'))).toBe(true);
        expect(batches.find((batch) => batch.table === 'gamelog_join_leave').rows).toEqual([]);
        for (const [, sql, , options] of mocks.execute.mock.calls) {
            expect(sql).toMatch(/^SELECT/);
            expect(sql).not.toMatch(/OFFSET|PRAGMA|json_group|json_object/i);
            expect(options).toEqual({ bulk: true });
        }
        expect(database.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before);
        expect(database.prepare('SELECT * FROM unrelated_settings').get()).toEqual({ key: 'theme', value: 'dark' });
    });

    test('awaits consumers and excludes appends above each table watermark', async () => {
        let pending = false;
        const ids = [];
        await loadFriendsNetworkHistory({
            batchSize: 1,
            onBatch: async (batch) => {
                expect(pending).toBe(false);
                pending = true;
                if (batch.table === 'gamelog_location') {
                    ids.push(...objects(batch).map((row) => row.id));
                    if (ids.length === 1) {
                        database.exec("INSERT INTO gamelog_location VALUES (100, '2026-10-04', 'd', 'World D', 1000)");
                    }
                }
                await Promise.resolve();
                pending = false;
            }
        });
        expect(ids).toEqual([2, 7, 25]);
    });

    test('retains negative IDs and reads VRCX composite-primary-key tables by rowid', async () => {
        database.exec(`
            INSERT INTO gamelog_location VALUES (-2, '2026-09-30', 'negative', 'World', 1000);
            CREATE TABLE ${PREFIX}_mutual_graph_links (friend_id TEXT, mutual_id TEXT, PRIMARY KEY(friend_id, mutual_id));
            INSERT INTO ${PREFIX}_mutual_graph_links VALUES ('a', 'b'), ('a', 'c'), ('b', 'c');
        `);
        const batches = [];
        await loadFriendsNetworkHistory({ batchSize: 1, onBatch: (batch) => batches.push(batch) });
        expect(
            batches
                .filter((batch) => batch.table === 'gamelog_location')
                .flatMap(objects)
                .map((row) => row.id)
        ).toEqual([-2, 2, 7, 25]);
        expect(batches.filter((batch) => batch.table.endsWith('_mutual_graph_links')).flatMap(objects)).toEqual([
            { friend_id: 'a', mutual_id: 'b' },
            { friend_id: 'a', mutual_id: 'c' },
            { friend_id: 'b', mutual_id: 'c' }
        ]);
    });

    test('selects only known columns and registers unused account tables without reading their rows', async () => {
        database.exec(`
            ALTER TABLE gamelog_location ADD COLUMN data TEXT;
            CREATE TABLE ${PREFIX}_friend_log_history (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, previous_display_name TEXT, trust_level TEXT);
            INSERT INTO ${PREFIX}_friend_log_history VALUES (1, '2026-10-01', 'a', 'Alice', 'Old Alice', 'unused');
            CREATE TABLE ${PREFIX}_mutual_graph_friends (friend_id TEXT PRIMARY KEY);
            INSERT INTO ${PREFIX}_mutual_graph_friends VALUES ('a');
        `);
        const batches = [];
        await loadFriendsNetworkHistory({ onBatch: (batch) => batches.push(batch) });
        expect(objects(batches.find((batch) => batch.table.endsWith('_friend_log_history')))).toEqual([
            { created_at: '2026-10-01', user_id: 'a', display_name: 'Alice', previous_display_name: 'Old Alice' }
        ]);
        expect(batches.find((batch) => batch.table.endsWith('_mutual_graph_friends'))).toEqual({
            table: `${PREFIX}_mutual_graph_friends`,
            columns: [],
            rows: []
        });
        expect(
            mocks.execute.mock.calls.some(([, sql]) => sql.includes('FROM "' + PREFIX + '_mutual_graph_friends"'))
        ).toBe(false);
        expect(
            mocks.execute.mock.calls.every(([, sql]) => !sql.includes('trust_level') && !sql.includes('SELECT data'))
        ).toBe(true);
    });

    test('ignores crafted table names and never interpolates stored text into SQL', async () => {
        const payload = "Alice'; DROP TABLE unrelated_settings; --";
        database.prepare(`UPDATE ${PREFIX}_friend_log_current SET display_name = ?`).run(payload);
        database.exec(`
            CREATE TABLE "gamelog_location; DROP TABLE unrelated_settings" (id INTEGER);
            CREATE TABLE "${PREFIX}_friend_log_current; DROP TABLE unrelated_settings" (user_id TEXT);
            CREATE TABLE constructor (id INTEGER);
            CREATE TABLE cache_user (id TEXT, name TEXT);
        `);
        const batches = [];
        await loadFriendsNetworkHistory({ onBatch: (batch) => batches.push(batch) });
        expect(objects(batches.find((batch) => batch.table.endsWith('_friend_log_current')))[0].display_name).toBe(
            payload
        );
        expect(mocks.execute.mock.calls.every(([, sql]) => !sql.includes('DROP TABLE') && !sql.includes(payload))).toBe(
            true
        );
        expect(batches.some((batch) => ['constructor', 'cache_user'].includes(batch.table))).toBe(false);
        expect(database.prepare('SELECT COUNT(*) AS count FROM unrelated_settings').get().count).toBe(1);
    });

    test.each([
        [undefined, 10000],
        [999999, 20000],
        [2, 2]
    ])('bounds batch size %s to %s', async (batchSize, expected) => {
        await loadFriendsNetworkHistory({ batchSize, onBatch: () => {} });
        const calls = mocks.execute.mock.calls.filter(([, sql]) => sql.includes('LIMIT @limit'));
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(([, , args]) => args['@limit'] === expected)).toBe(true);
    });

    test('cancels between batches and reports numeric reading progress', async () => {
        const controller = new AbortController();
        await expect(
            loadFriendsNetworkHistory({ signal: controller.signal, onBatch: () => controller.abort() })
        ).rejects.toMatchObject({ name: 'AbortError' });
        const progress = [];
        await loadFriendsNetworkHistory({ onBatch: () => {}, onProgress: (status) => progress.push(status) });
        expect(progress.at(-1)).toEqual({ progress: 1, rows: 4 });
        expect(progress.every((status) => Object.keys(status).sort().join(',') === 'progress,rows')).toBe(true);
    });
});
