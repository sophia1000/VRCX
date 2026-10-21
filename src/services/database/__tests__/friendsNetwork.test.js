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
        for (const [, sql] of mocks.execute.mock.calls) {
            expect(sql).toMatch(/^(SELECT|PRAGMA table_info)/);
            expect(sql).not.toMatch(/OFFSET|json_group|json_object/i);
        }
        expect(database.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before);
        expect(database.prepare('SELECT * FROM unrelated_settings').get()).toEqual({ key: 'theme', value: 'dark' });
    });

    test('awaits the consumer and bounds each table to its initial high-water mark', async () => {
        let pending = false;
        const ids = [];
        await loadFriendsNetworkHistory({
            batchSize: 1,
            onBatch: async (batch) => {
                expect(pending).toBe(false);
                pending = true;
                if (batch.table === 'gamelog_location') {
                    ids.push(...batch.rows.map((row) => row.id));
                    if (ids.length === 1)
                        database.exec("INSERT INTO gamelog_location VALUES (100, '2026-10-04', 'd', 1000)");
                }
                await Promise.resolve();
                pending = false;
            }
        });
        expect(ids).toEqual([2, 7, 25]);
    });

    test('supports composite primary-key snapshots without rowid', async () => {
        database.exec(`CREATE TABLE ${PREFIX}_mutual_graph_links (friend_id TEXT, mutual_id TEXT, PRIMARY KEY(friend_id, mutual_id)) WITHOUT ROWID;
            INSERT INTO ${PREFIX}_mutual_graph_links VALUES ('a', 'b'), ('a', 'c'), ('b', 'c');`);
        const rows = [];
        await loadFriendsNetworkHistory({
            batchSize: 1,
            onBatch: (batch) => {
                if (batch.table.endsWith('_mutual_graph_links')) rows.push(...batch.rows);
            }
        });
        expect(rows).toEqual([
            { friend_id: 'a', mutual_id: 'b' },
            { friend_id: 'a', mutual_id: 'c' },
            { friend_id: 'b', mutual_id: 'c' }
        ]);
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
