export const MAX_INFERRED_TAIL_SECONDS = 4 * 3600;
const ACCOUNT_PREFIX = /^(usr[0-9a-f]{32})_(.+)$/i;
const USER_ID = /^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY_USER = 'usr_00000000-0000-0000-0000-000000000000';
const HISTORY_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const HISTORY_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Accept stable VRChat user IDs and reject the empty-ID sentinel. */
export function canonicalHistoryUserId(value) {
    if (typeof value !== 'string' || !USER_ID.test(value)) {
        return null;
    }
    const id = value.toLowerCase();
    return id !== EMPTY_USER ? id : null;
}

/** Parse VRCX's ISO dates as UTC, including old SQLite dates without a zone. */
export function historyTimestamp(value) {
    if (typeof value !== 'string' || !HISTORY_DATE.test(value)) {
        return null;
    }
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    // Match Date.UTC's historical validation of years 0000 through 0099.
    const calendarYear = year < 100 ? year + 1900 : year;
    const leapYear = calendarYear % 4 === 0 && (calendarYear % 100 !== 0 || calendarYear % 400 === 0);
    const monthDays = month === 2 && leapYear ? 29 : MONTH_DAYS[month - 1];
    if (month < 1 || month > 12 || day < 1 || day > monthDays) {
        return null;
    }
    if (
        value.length > 10 &&
        (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)
    ) {
        return null;
    }
    let iso = value[10] === ' ' ? value.replace(' ', 'T') : value;
    if (iso.length > 10 && !HISTORY_ZONE.test(iso)) {
        iso += 'Z';
    }
    const time = Date.parse(iso) / 1000;
    return Number.isFinite(time) ? time : null;
}

/** Convert stored VRCX durations to the seconds used by reconstructed presence. */
function durationSeconds(value) {
    // Both historical and current VRCX time columns are milliseconds.
    const seconds = Number(value) / 1000;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function accountId(prefix) {
    const id = prefix.slice(3);
    return `usr_${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** Collect historical aliases without treating a shared display name as identity. */
class IdentityIndex {
    users = new Map();
    aliases = new Map();

    remember(rawId, name, seen = null, observed = false) {
        // Most log rows repeat an already canonical identity. The map lookup
        // avoids validating and lowercasing that same ID for every event.
        const known = this.users.get(rawId);
        if (known) {
            this.update(known, name, seen, observed);
            return known.id;
        }
        const id = canonicalHistoryUserId(rawId);
        if (!id) {
            return null;
        }
        let user = this.users.get(id);
        if (!user) {
            user = { id, name: id, is_friend: 0, join_count: 0, last_seen: null, nameAt: -Infinity };
            this.users.set(id, user);
        }
        this.update(user, name, seen, observed);
        return user.id;
    }

    update(user, name, seen, observed) {
        if (typeof name === 'string' && name.length) {
            if (user.lastAlias !== name) {
                this.alias(name, user.id);
                user.lastAlias = name;
            }
            if ((seen ?? -Infinity) >= user.nameAt) {
                user.name = name;
                user.nameAt = seen ?? -Infinity;
            }
        }
        if (seen !== null && observed) {
            user.last_seen = Math.max(user.last_seen ?? seen, seen);
        }
    }

    alias(name, id) {
        if (typeof name !== 'string' || !name.length) {
            return;
        }
        let candidates = this.aliases.get(name);
        if (!candidates) {
            candidates = new Set();
            this.aliases.set(name, candidates);
        }
        candidates.add(id);
    }

    resolve(id, name) {
        // Event IDs have already been canonicalized by remember during import.
        if (id) {
            return id;
        }
        const candidates = this.aliases.get(name);
        return candidates?.size === 1 ? candidates.values().next().value : null;
    }
}

/** Find the preceding visit while respecting known ends and bounded inferred tails. */
function findVisit(visits, timestamp, location) {
    let low = 0;
    let high = visits.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (visits[middle].start <= timestamp) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    if (!low) {
        return null;
    }
    const visit = visits[low - 1];
    const matchingEnd = visit.knownDuration
        ? visit.end + 2
        : Math.min(visit.nextStart, visit.start + MAX_INFERRED_TAIL_SECONDS);
    return timestamp <= matchingEnd && (location === undefined || location === visit.location) ? visit : null;
}

/**
 * Incremental worker-side importer. Identity rows are folded into indexes as
 * batches arrive; only compact visits and events remain until reconstruction.
 * Call finish once, then release this builder and retain its canonical dataset.
 */
export function createFriendsNetworkHistoryBuilder() {
    const identities = new IdentityIndex();
    const accountMap = new Map();
    const visits = [];
    const events = [];
    const observations = [];
    const optedOut = new Set();
    const eventStrings = new Map();
    const tableColumns = new Map();
    function internEventString(value) {
        if (typeof value !== 'string') {
            return value;
        }
        // Bridge batches allocate fresh strings. Reuse repeated instance IDs and
        // display names so a long visit does not retain one copy per log event.
        const existing = eventStrings.get(value);
        if (existing !== undefined) {
            return existing;
        }
        eventStrings.set(value, value);
        return value;
    }
    const quality = {
        unresolved_events: 0,
        ambiguous_names: 0,
        invalid_timestamps: 0,
        unmatched_events: 0,
        duplicate_events: 0,
        inferred_intervals: 0,
        missing_duration_visits: 0,
        tail_cap_seconds: MAX_INFERRED_TAIL_SECONDS
    };
    let finished = false;
    let previousTimestampValue;
    let previousTimestamp = null;

    /** Retain one account snapshot across its tables and incoming batches. */
    function getAccount(prefix) {
        prefix = prefix.toLowerCase();
        if (!accountMap.has(prefix)) {
            accountMap.set(prefix, {
                id: accountId(prefix),
                prefix,
                friend_count: 0,
                mutual_count: 0,
                friends: new Set(),
                currentNames: new Map(),
                pairs: new Map()
            });
        }
        return accountMap.get(prefix);
    }
    return {
        /** Fold each batch into identity indexes and compact reconstruction inputs. */
        addBatch({ table, columns, rows, rowFormat }) {
            if (finished) {
                throw new Error('History import has already finished.');
            }
            if (columns !== undefined) {
                tableColumns.set(table, columns);
            }
            const arrayRows = rowFormat === 'arrays';
            const schema = tableColumns.get(table);
            if (arrayRows && !Array.isArray(schema)) {
                throw new Error(`History array columns are missing for ${table}.`);
            }
            const match = ACCOUNT_PREFIX.exec(table);
            const account = match ? getAccount(match[1]) : null;
            const kind = match ? match[2] : table;
            for (const sourceRow of rows) {
                let row = sourceRow;
                if (arrayRows) {
                    // Decode after crossing the worker boundary so the renderer
                    // only handles compact arrays and one schema per table.
                    row = {};
                    for (let index = 0; index < schema.length; index++) {
                        row[schema[index]] = sourceRow[index];
                    }
                }
                const timestampValue = row.created_at ?? row.updated_at ?? row.added_at;
                if (timestampValue !== previousTimestampValue) {
                    previousTimestampValue = timestampValue;
                    previousTimestamp = historyTimestamp(timestampValue);
                }
                const timestamp = previousTimestamp;
                if (kind === 'gamelog_location') {
                    if (timestamp === null) {
                        quality.invalid_timestamps++;
                        continue;
                    }
                    const seconds = durationSeconds(row.time);
                    // Sentinel locations are retained as boundaries, so a missing
                    // duration never carries a visit through a recorded offline gap.
                    visits.push({
                        id: row.id,
                        start: timestamp,
                        end: timestamp + seconds,
                        location: row.location,
                        world_name: row.world_name || '',
                        knownDuration: seconds > 0,
                        latestObservation: timestamp,
                        usable: !!row.location && !['traveling', 'offline', 'private'].includes(row.location)
                    });
                    continue;
                }
                if (kind === 'gamelog_join_leave') {
                    const userId = identities.remember(row.user_id, row.display_name, timestamp, true);
                    events.push({
                        id: row.id,
                        timestamp,
                        type: row.type,
                        name: internEventString(row.display_name),
                        location: internEventString(row.location),
                        userId,
                        duration: durationSeconds(row.time)
                    });
                    continue;
                }
                if (kind === 'mutual_graph_meta') {
                    const id = canonicalHistoryUserId(row.friend_id);
                    if (id && Number(row.opted_out)) {
                        optedOut.add(id);
                    }
                    continue;
                }
                if (kind === 'mutual_graph_links') {
                    account.mutual_count++;
                    const first = identities.remember(row.friend_id, null);
                    const second = identities.remember(row.mutual_id, null);
                    if (first && second && first !== second) {
                        const pair = [first, second].sort();
                        account.pairs.set(pair.join('|'), pair);
                    }
                    continue;
                }
                const rawId = row.user_id ?? (kind === 'cache_user' || kind === 'user_profile' ? row.id : null);
                const id = identities.remember(
                    rawId,
                    row.display_name ?? row.name,
                    timestamp,
                    kind.startsWith('gamelog_') && kind !== 'gamelog_event'
                );
                if (id) {
                    identities.alias(row.previous_display_name, id);
                }
                if (kind === 'friend_log_current') {
                    account.friend_count++;
                    if (id) {
                        account.friends.add(id);
                        if (row.display_name) {
                            account.currentNames.set(id, row.display_name);
                        }
                    }
                }
                if (kind.startsWith('gamelog_') && timestamp !== null) {
                    // General game events prove observer activity, but do not
                    // prove that any named person was present or joined.
                    observations.push({ timestamp, location: internEventString(row.location) });
                }
            }
        },

        /**
         * Resolve all collected inputs into one reusable history generation.
         *
         * @param {{ onProgress?: Function }} [options]
         */
        finish({ onProgress } = {}) {
            if (finished) {
                throw new Error('History import has already finished.');
            }
            finished = true;
            onProgress?.({ stage: 'identities', progress: 0.1, message: 'Resolving historical names' });

            // Account identities and preferred display names
            const accounts = [...accountMap.values()].sort(
                (a, b) => b.mutual_count - a.mutual_count || b.friend_count - a.friend_count || a.id.localeCompare(b.id)
            );
            const observers = new Set(accounts.map((account) => account.id));
            const currentNames = new Map();
            for (const account of accounts) {
                for (const id of account.friends) {
                    identities.users.get(id).is_friend = 1;
                }
                for (const [id, name] of account.currentNames) {
                    if (!currentNames.has(id)) {
                        currentNames.set(id, name);
                    }
                }
            }
            // Visit boundaries, including observations that bound missing durations
            visits.sort((a, b) => a.start - b.start || Number(a.id) - Number(b.id));
            for (let index = 0; index < visits.length; index++) {
                const visit = visits[index];
                visit.nextStart = visits[index + 1]?.start ?? Infinity;
                if (visit.knownDuration) {
                    visit.end = Math.min(visit.end, visit.nextStart);
                } else if (visit.usable) {
                    quality.missing_duration_visits++;
                }
            }
            // Scan explicit identities before resolving any name-only row. A name
            // shared by multiple stable IDs must never manufacture a connection.
            for (const event of events) {
                if (event.timestamp === null) {
                    continue;
                }
                const visit = findVisit(visits, event.timestamp, event.location);
                if (visit) {
                    visit.latestObservation = Math.max(visit.latestObservation, event.timestamp);
                }
            }
            for (const observation of observations) {
                const visit = findVisit(visits, observation.timestamp, observation.location);
                if (visit) {
                    visit.latestObservation = Math.max(visit.latestObservation, observation.timestamp);
                }
            }
            for (const visit of visits) {
                if (!visit.knownDuration) {
                    visit.end = visit.latestObservation;
                }
            }
            quality.ambiguous_names = [...identities.aliases.values()].filter((ids) => ids.size > 1).length;

            // Join/leave reconstruction and duplicate-event handling
            events.sort((a, b) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity) || Number(a.id) - Number(b.id));
            onProgress?.({ stage: 'presence', progress: 0.4, message: 'Reconstructing observed presence' });
            const active = new Map();
            const spans = new Map();
            function addSpan(visit, id, start, end, inferred) {
                start = Math.max(start, visit.start);
                end = Math.min(end, visit.end);
                if (!visit.usable || observers.has(id) || end <= start) {
                    return;
                }
                const key = `${visit.id}|${id}`;
                if (!spans.has(key)) {
                    spans.set(key, []);
                }
                spans.get(key).push({ visit_id: visit.id, user_id: id, start, end, inferred: inferred ? 1 : 0 });
            }
            let previousTime = null;
            const signatures = new Set();
            for (const event of events) {
                if (event.timestamp === null) {
                    quality.invalid_timestamps++;
                    continue;
                }
                if (!['OnPlayerJoined', 'OnPlayerLeft'].includes(event.type)) {
                    continue;
                }
                const id = identities.resolve(event.userId, event.name);
                if (!id) {
                    quality.unresolved_events++;
                    continue;
                }
                identities.update(identities.users.get(id), event.name, event.timestamp, true);
                if (previousTime !== event.timestamp) {
                    signatures.clear();
                    previousTime = event.timestamp;
                }
                const signature = JSON.stringify([event.type, id, event.location]);
                if (signatures.has(signature)) {
                    quality.duplicate_events++;
                    continue;
                }
                signatures.add(signature);
                const visit = findVisit(visits, event.timestamp, event.location);
                const key = visit ? `${visit.id}|${id}` : null;
                if (event.type === 'OnPlayerJoined') {
                    if (key && active.has(key)) {
                        quality.duplicate_events++;
                        continue;
                    }
                    identities.users.get(id).join_count++;
                }
                if (!visit || !visit.usable) {
                    quality.unmatched_events++;
                    continue;
                }
                if (event.type === 'OnPlayerJoined') {
                    active.set(key, { visit, id, start: event.timestamp });
                } else {
                    const joined = active.get(key);
                    active.delete(key);
                    if (joined || event.duration > 0) {
                        addSpan(visit, id, joined?.start ?? event.timestamp - event.duration, event.timestamp, !joined);
                    }
                }
            }
            // Close inferred tails and union overlapping spans within each visit.
            for (const { visit, id, start } of active.values()) {
                addSpan(visit, id, start, Math.min(visit.end, start + MAX_INFERRED_TAIL_SECONDS), true);
            }
            const presence = [];
            for (const userSpans of spans.values()) {
                userSpans.sort((a, b) => a.start - b.start || a.end - b.end || a.inferred - b.inferred);
                let previous = null;
                for (const span of userSpans) {
                    if (previous && span.start <= previous.end) {
                        previous.end = Math.max(previous.end, span.end);
                        previous.inferred ||= span.inferred;
                    } else {
                        presence.push(span);
                        previous = span;
                    }
                }
            }
            quality.inferred_intervals = presence.filter((span) => span.inferred).length;
            for (const [id, name] of currentNames) {
                identities.users.get(id).name = name;
            }
            // Publish compact facts; raw import buffers are no longer needed.
            const dataset = {
                users: [...identities.users.values()].map(({ id, name, is_friend, join_count, last_seen }) => ({
                    id,
                    name,
                    is_friend,
                    join_count,
                    last_seen
                })),
                visits: visits
                    .filter((visit) => visit.usable)
                    .map(({ id, start, end, location, world_name }) => ({ id, start, end, location, world_name })),
                presence,
                accounts: accounts.map((account) => ({
                    id: account.id,
                    prefix: account.prefix,
                    label: identities.users.get(account.id)?.name ?? account.id,
                    friend_count: account.friend_count,
                    mutual_count: account.mutual_count,
                    friendIds: [...account.friends],
                    mutualPairs: [...account.pairs.values()].filter(
                        ([a, b]) => !observers.has(a) && !observers.has(b) && !optedOut.has(a) && !optedOut.has(b)
                    )
                })),
                observerIds: [...observers].sort(),
                quality
            };
            // Drop raw history promptly after canonical intervals have been built.
            events.length = 0;
            observations.length = 0;
            eventStrings.clear();
            onProgress?.({ stage: 'ready', progress: 1, message: 'Observed history is ready' });
            return dataset;
        }
    };
}

/** Build a generation from an existing collection of batches using the same importer. */
export function buildFriendsNetworkHistory(batches, options) {
    const builder = createFriendsNetworkHistoryBuilder();
    for (const batch of batches) {
        builder.addBatch(batch);
    }
    return builder.finish(options);
}
