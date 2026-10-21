import { describe, expect, test } from 'vitest';
import {
    buildFriendsNetworkHistory,
    createFriendsNetworkHistoryBuilder,
    historyTimestamp,
    canonicalHistoryUserId
} from '../history.js';

const OWNER = 'usr_11111111-1111-1111-1111-111111111111';
const ALT = 'usr_22222222-2222-2222-2222-222222222222';
const ALICE = 'usr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOB = 'usr_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const prefix = (id) => id.replaceAll('_', '').replaceAll('-', '');
const at = (seconds) => new Date(Date.UTC(2026, 9, 1) + seconds * 1000).toISOString();
const epoch = historyTimestamp(at(0));
const batch = (table, rows) => ({ table, rows });
const visit = (id = 1, start = 0, time = 3600000, location = 'world:instance') => ({
    id,
    created_at: at(start),
    location,
    time,
    world_name: 'World'
});
const event = (id, user_id, display_name, seconds, type = 'OnPlayerJoined', time = 0, location = 'world:instance') => ({
    id,
    user_id,
    display_name,
    created_at: at(seconds),
    type,
    time,
    location
});
const account = (id, friends) =>
    batch(
        `${prefix(id)}_friend_log_current`,
        friends.map(([user_id, display_name]) => ({ user_id, display_name }))
    );

describe('observed history reconstruction', () => {
    test('uses milliseconds, real join/leave spans, and excludes every observer', () => {
        const dataset = buildFriendsNetworkHistory([
            account(OWNER, [
                [ALICE, 'Alice'],
                [ALT, 'Alt']
            ]),
            account(ALT, [
                [BOB, 'Bob'],
                [OWNER, 'Owner']
            ]),
            batch('gamelog_location', [visit()]),
            batch('gamelog_join_leave', [
                event(1, ALICE, 'Alice', 300),
                event(2, ALICE, 'Alice', 1500, 'OnPlayerLeft', 1200000),
                event(3, BOB, 'Bob', 600),
                event(4, BOB, 'Bob', 1800, 'OnPlayerLeft', 1200000),
                event(5, OWNER, 'Owner', 0),
                event(6, OWNER, 'Owner', 3600, 'OnPlayerLeft'),
                event(7, ALT, 'Alt', 0),
                event(8, ALT, 'Alt', 3600, 'OnPlayerLeft')
            ])
        ]);
        expect(dataset.visits[0].end - dataset.visits[0].start).toBe(3600);
        expect(dataset.presence).toHaveLength(2);
        expect(dataset.presence.find((span) => span.user_id === ALICE)).toMatchObject({
            start: epoch + 300,
            end: epoch + 1500,
            inferred: 0
        });
        expect(dataset.observerIds).toEqual([OWNER, ALT]);
        expect(dataset.accounts.map((item) => item.friendIds)).toContainEqual([BOB, OWNER]);
    });

    test('resolves historical names from all account snapshots and refuses ambiguous aliases', () => {
        const dataset = buildFriendsNetworkHistory([
            account(OWNER, [
                [ALICE, 'Current Alice'],
                [BOB, 'Bob']
            ]),
            batch(`${prefix(OWNER)}_friend_log_history`, [
                { user_id: ALICE, display_name: 'Alice', previous_display_name: 'Old Alice', created_at: at(-10) }
            ]),
            batch(`${prefix(ALT)}_feed_status`, [{ user_id: BOB, display_name: 'Shared', created_at: at(-20) }]),
            batch('gamelog_location', [visit()]),
            batch('gamelog_join_leave', [
                event(1, null, 'Old Alice', 100),
                event(2, null, 'Old Alice', 200, 'OnPlayerLeft'),
                event(3, null, 'Shared', 300),
                event(4, ALICE, 'Shared', 400),
                event(5, ALICE, 'Shared', 500, 'OnPlayerLeft')
            ])
        ]);
        expect(dataset.quality.ambiguous_names).toBe(1);
        expect(dataset.quality.unresolved_events).toBe(1);
        expect(dataset.presence).toHaveLength(2);
        expect(dataset.users.find((user) => user.id === ALICE).name).toBe('Current Alice');
    });

    test('deduplicates repeated joins and unions overlapping leave-duration evidence', () => {
        const dataset = buildFriendsNetworkHistory([
            batch('gamelog_location', [visit()]),
            batch('gamelog_join_leave', [
                event(1, ALICE, 'Alice', 100),
                event(2, ALICE, 'Alice', 100),
                event(3, ALICE, 'Alice', 110),
                event(4, ALICE, 'Alice', 200, 'OnPlayerLeft'),
                event(5, ALICE, 'Alice', 250, 'OnPlayerLeft', 100000)
            ])
        ]);
        expect(dataset.users[0].join_count).toBe(1);
        expect(dataset.quality.duplicate_events).toBe(2);
        expect(dataset.presence).toEqual([
            { visit_id: 1, user_id: ALICE, start: epoch + 100, end: epoch + 250, inferred: 1 }
        ]);
    });

    test('bounds unknown durations by activity, four hours, and offline sentinels', () => {
        const dataset = buildFriendsNetworkHistory([
            batch('gamelog_location', [
                visit(1, 0, null),
                visit(2, 600, null, 'offline'),
                visit(3, 2000, null, 'other:instance')
            ]),
            batch('gamelog_join_leave', [
                event(1, ALICE, 'Alice', 0),
                event(2, ALICE, 'Alice', 1000, 'OnPlayerLeft', 1000000),
                event(3, BOB, 'Bob', 2000, 'OnPlayerJoined', 0, 'other:instance'),
                event(4, BOB, 'Bob', 20000, 'OnPlayerLeft', 18000000, 'other:instance')
            ]),
            batch('gamelog_event', [
                { created_at: at(300), data: 'VideoError: unavailable' },
                { created_at: at(16400), data: 'Observer activity' }
            ])
        ]);
        expect(dataset.visits.map((item) => item.end)).toEqual([epoch + 300, epoch + 16400]);
        expect(dataset.presence.map((span) => span.end - span.start)).toEqual([300, 14400]);
        expect(dataset.quality.unmatched_events).toBe(2);
    });

    test('caps inferred open tails even on a long known visit', () => {
        const dataset = buildFriendsNetworkHistory([
            batch('gamelog_location', [visit(1, 0, 86400000)]),
            batch('gamelog_join_leave', [event(1, ALICE, 'Alice', 0)])
        ]);
        expect(dataset.presence[0].end - dataset.presence[0].start).toBe(14400);
    });

    test('preserves disjoint rejoins and suppresses opted-out mutuals across accounts', () => {
        const dataset = buildFriendsNetworkHistory([
            account(OWNER, [[ALICE, 'Alice']]),
            account(ALT, [[BOB, 'Bob']]),
            batch(`${prefix(OWNER)}_mutual_graph_links`, [
                { friend_id: ALICE, mutual_id: BOB },
                { friend_id: BOB, mutual_id: ALICE },
                { friend_id: OWNER, mutual_id: ALICE }
            ]),
            batch(`${prefix(ALT)}_mutual_graph_meta`, [{ friend_id: BOB.toUpperCase(), opted_out: 1 }]),
            batch('gamelog_location', [visit()]),
            batch('gamelog_join_leave', [
                event(1, ALICE, 'Alice', 0),
                event(2, ALICE, 'Alice', 100, 'OnPlayerLeft'),
                event(3, ALICE, 'Alice', 200),
                event(4, ALICE, 'Alice', 300, 'OnPlayerLeft')
            ])
        ]);
        expect(dataset.presence).toHaveLength(2);
        expect(dataset.accounts.flatMap((item) => item.mutualPairs)).toEqual([]);
        expect(dataset.accounts.find((item) => item.id === OWNER).friendIds).toEqual([ALICE]);
        expect(dataset.accounts.find((item) => item.id === ALT).friendIds).toEqual([BOB]);
    });

    test('supports streaming batches and finishes only once', () => {
        const builder = createFriendsNetworkHistoryBuilder();
        builder.addBatch(account(OWNER, []));
        builder.addBatch(batch('gamelog_location', [visit()]));
        builder.addBatch(batch('gamelog_join_leave', [event(1, ALICE, 'Alice', 0)]));
        builder.addBatch(batch('gamelog_join_leave', [event(2, ALICE, 'Alice', 100, 'OnPlayerLeft')]));
        expect(builder.finish().presence).toHaveLength(1);
        expect(() => builder.finish()).toThrow('already finished');
    });

    test('rejects culture-dependent dates and placeholder identities', () => {
        expect(historyTimestamp('10/11/2026')).toBeNull();
        expect(historyTimestamp('2026-02-30')).toBeNull();
        expect(historyTimestamp('2026-10-01 00:00:00.123')).toBe(epoch + 0.123);
        expect(historyTimestamp('2026-10-01T00:00:00.1234567Z')).not.toBeNull();
        expect(canonicalHistoryUserId('usr_00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    test('validates leap days, clock limits, and explicit timezone offsets', () => {
        for (const value of [
            '2024-02-30',
            '2023-02-29',
            '1900-02-29',
            '0000-02-29',
            '2026-00-01',
            '2026-13-01',
            '2026-04-31',
            '2026-10-01T24:00:00Z',
            '2026-10-01T00:60:00Z',
            '2026-10-01T00:00:60Z',
            '2026-10-01T00:00:00+24:00'
        ]) {
            expect(historyTimestamp(value), value).toBeNull();
        }
        for (const value of ['2024-02-29', '2000-02-29', '0004-02-29']) {
            expect(historyTimestamp(value), value).toBe(Date.parse(value) / 1000);
        }
        for (const value of [
            '2026-10-01',
            '2026-10-01T00:00',
            '2026-10-01 00:00:00',
            '2026-10-01T02:30:00+02:30',
            '2026-09-30T21:30:00-0230'
        ]) {
            expect(historyTimestamp(value), value).toBe(epoch);
        }
    });

    test('retains timestamp and identity semantics across repeated streamed rows', () => {
        const builder = createFriendsNetworkHistoryBuilder();
        builder.addBatch(batch('gamelog_location', [visit()]));
        builder.addBatch(
            batch('gamelog_join_leave', [
                event(20, ALICE.toUpperCase(), 'Later sorted name', 100),
                event(10, ALICE, 'Earlier sorted name', 100),
                { ...event(30, ALICE, 'Invalid timestamp', 100), created_at: '2026-02-30' }
            ])
        );
        builder.addBatch(
            batch('gamelog_join_leave', [
                { ...event(31, ALICE, 'Invalid timestamp', 100), created_at: '2026-02-30' },
                event(40, null, 'Later sorted name', 200, 'OnPlayerLeft'),
                event(50, 'usr_00000000-0000-0000-0000-000000000000', 'Unknown', 200),
                event(60, null, 'Unknown', 200, 'OnPlayerLeft')
            ])
        );
        const dataset = builder.finish();
        expect(dataset.users).toEqual([
            { id: ALICE, name: 'Later sorted name', is_friend: 0, join_count: 1, last_seen: epoch + 200 }
        ]);
        expect(dataset.presence).toEqual([
            { visit_id: 1, user_id: ALICE, start: epoch + 100, end: epoch + 200, inferred: 0 }
        ]);
        expect(dataset.quality).toMatchObject({ invalid_timestamps: 2, duplicate_events: 1, unresolved_events: 2 });
    });

    test('reconstructs array batches with per-table schemas and empty accounts exactly like object batches', () => {
        const batches = [
            account(OWNER, [[ALICE, 'Current Alice']]),
            account(ALT, []),
            batch('gamelog_location', [visit()]),
            batch('gamelog_join_leave', [event(1, ALICE.toUpperCase(), 'Alice', 100)]),
            batch('gamelog_join_leave', [event(2, ALICE, 'Alice', 200, 'OnPlayerLeft')]),
            batch(`${prefix(OWNER)}_friend_log_history`, [
                { user_id: BOB, display_name: 'Bob', previous_display_name: 'Old Bob', created_at: at(-10) }
            ]),
            batch('gamelog_join_leave', [event(3, null, 'Old Bob', 300)]),
            batch('gamelog_join_leave', [event(4, null, 'Old Bob', 400, 'OnPlayerLeft')])
        ];
        const schemas = new Map();
        const arrayBatches = batches.map(({ table, rows }) => {
            const firstBatch = !schemas.has(table);
            const columns = schemas.get(table) ?? Object.keys(rows[0] ?? { user_id: null, display_name: null });
            schemas.set(table, columns);
            return {
                table,
                rowFormat: 'arrays',
                columns: firstBatch ? columns : undefined,
                rows: rows.map((row) => columns.map((column) => row[column]))
            };
        });
        const objects = buildFriendsNetworkHistory(batches);
        const arrays = buildFriendsNetworkHistory(arrayBatches);
        expect(arrays).toEqual(objects);
        expect(arrays.accounts).toHaveLength(2);
        expect(arrays.accounts.find(({ id }) => id === ALT).friend_count).toBe(0);
        expect(arrays.presence).toHaveLength(2);
    });

    test('rejects array batches without that table schema, including empty batches', () => {
        const builder = createFriendsNetworkHistoryBuilder();
        builder.addBatch({ table: 'gamelog_location', rowFormat: 'arrays', columns: ['id'], rows: [] });
        expect(() => builder.addBatch({ table: 'gamelog_join_leave', rowFormat: 'arrays', rows: [] })).toThrow(
            'History array columns are missing for gamelog_join_leave'
        );
        builder.addBatch(batch('gamelog_location', [visit()]));
        expect(builder.finish().visits).toHaveLength(1);
    });
});
