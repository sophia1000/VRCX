// All timestamps are Unix seconds. Days and weeks use UTC boundaries.
export const DAY = 86400;

export function compareIds(a, b) {
    if (a < b) {
        return -1;
    }
    return a > b ? 1 : 0;
}

// The Unix epoch falls on a Thursday; the offset aligns week boundaries to Monday.
export const weekOfDay = (day) => Math.floor((day + 3) / 7);

/** Return touched UTC days, excluding a day reached only at the interval's end. */
export function daysBetween(start, end) {
    const days = [];
    for (let day = Math.floor(start / DAY); day < Math.ceil(end / DAY); day++) {
        days.push(day);
    }
    return days;
}

// Analysis controls retain the worker protocol's snake_case field names.
const defaults = {
    days: 90,
    date_from: null,
    date_to: null,
    weighting: 'balanced',
    min_encounters: 2,
    min_minutes: 2,
    half_life_days: 90,
    crowd_correction: true,
    crowd_exponent: 0.5,
    mutual_only: false,
    top_k: 12,
    backbone_threshold: 1,
    edge_selection: 'union',
    max_nodes: 800,
    resolution: 1,
    include_isolates: false,
    as_of: null,
    hub_damping: 0,
    relative_closeness: 0,
    neighbor_similarity: 0,
    min_overlap_minutes: 0,
    session_cap_minutes: 0,
    consistency: 0,
    crowd_mode: 'visit',
    world_filter: '',
    excluded_worlds: '',
    current_user_id: '',
    friend_ids: []
};

/** The live login and friend store are authoritative, including an empty list. */
export function normalizeFriendsNetworkScope(input = {}) {
    const currentUserId = typeof input?.current_user_id === 'string' ? input.current_user_id.trim() : '';
    if (!currentUserId || !Array.isArray(input?.friend_ids)) {
        return { current_user_id: currentUserId, friend_ids: [] };
    }
    const ids = input.friend_ids
        .filter((id) => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => id && id !== currentUserId);
    return { current_user_id: currentUserId, friend_ids: [...new Set(ids)].sort(compareIds) };
}

/** Interpret Unix seconds or UTC date text, with inclusive date-only end bounds. */
function parseDate(value, inclusiveEnd = false) {
    if (value === null || value === '') {
        return null;
    }
    let seconds = value;
    if (typeof value !== 'number') {
        const hasTimezone = /(?:Z|[+-]\d\d:\d\d)$/i.test(String(value));
        seconds = Date.parse(hasTimezone ? value : `${value}Z`) / 1000;
    }
    if (!Number.isFinite(seconds)) {
        throw new Error('Invalid date window');
    }
    return seconds + (inclusiveEnd && typeof value === 'string' && value.length === 10 ? DAY : 0);
}

/** Validate controls and resolve the requested history window before consulting caches. */
export function normalizeAnalysisSettings(input = {}) {
    const settings = { ...defaults, friend_ids: [] };
    for (const [key, value] of Object.entries(input)) {
        if (Object.hasOwn(settings, key)) {
            settings[key] = value;
        }
    }
    settings.days = [null, 'all', '', 0, '0'].includes(settings.days)
        ? null
        : Math.max(1, Math.round(Number(settings.days)));
    for (const key of [
        'min_minutes',
        'half_life_days',
        'crowd_exponent',
        'resolution',
        'hub_damping',
        'relative_closeness',
        'neighbor_similarity',
        'consistency',
        'min_overlap_minutes',
        'session_cap_minutes',
        'min_encounters',
        'top_k',
        'max_nodes',
        'backbone_threshold'
    ]) {
        const number = Number(settings[key]);
        if (!Number.isFinite(number)) {
            throw new Error(`${key} must be finite`);
        }
        settings[key] = Math.max(0, number);
    }
    if (settings.days !== null && !Number.isFinite(settings.days)) {
        throw new Error('days must be finite');
    }
    for (const key of ['hub_damping', 'relative_closeness', 'neighbor_similarity', 'consistency']) {
        settings[key] = Math.min(1, settings[key]);
    }
    for (const key of ['min_encounters', 'top_k', 'max_nodes']) {
        settings[key] = Math.trunc(settings[key]);
    }
    settings.resolution = Math.max(0.01, settings.resolution);
    settings.backbone_threshold = Math.min(1, settings.backbone_threshold);
    for (const key of ['mutual_only', 'crowd_correction', 'include_isolates']) {
        const value = settings[key];
        if (typeof value === 'boolean') {
            settings[key] = value;
        } else if (value == null) {
            settings[key] = false;
        } else {
            settings[key] = Number.isNaN(Number(value)) ? String(value).length > 0 : Number(value) !== 0;
        }
    }
    for (const [key, choices] of Object.entries({
        weighting: ['count', 'time', 'balanced', 'days'],
        edge_selection: ['union', 'mutual'],
        crowd_mode: ['visit', 'concurrent']
    })) {
        if (!choices.includes(settings[key])) {
            throw new Error(`${key} must be ${choices.join(', ')}`);
        }
    }
    for (const key of ['world_filter', 'excluded_worlds']) {
        settings[key] = String(settings[key] ?? '').trim();
    }
    Object.assign(settings, normalizeFriendsNetworkScope(settings));
    settings.as_of ??= Math.floor(Date.now() / 60000) * 60;
    const now = parseDate(settings.as_of);
    const end = Math.min(now, parseDate(settings.date_to, true) ?? now);
    const start = parseDate(settings.date_from) ?? (settings.days === null ? 0 : end - settings.days * DAY);
    if (!(start < end)) {
        throw new Error('Date window must end after it starts');
    }
    return { settings, window: { start, end, now } };
}

// Presence intervals and crowd timelines

/** Merge overlapping or adjacent spans without filling rejoin gaps; sorts the input. */
export function mergeIntervals(intervals) {
    const result = [];
    for (const row of intervals.sort((a, b) => a.start - b.start || a.end - b.end)) {
        const previous = result[result.length - 1];
        if (previous && row.start <= previous.end) {
            previous.end = Math.max(previous.end, row.end);
        } else {
            result.push({ start: row.start, end: row.end });
        }
    }
    return result;
}

/** Build concurrent crowd counts from each visitor's already merged spans. */
export function crowdTimeline(presence) {
    const changes = new Map();
    for (const spans of presence.values()) {
        for (const span of spans) {
            changes.set(span.start, (changes.get(span.start) || 0) + 1);
            changes.set(span.end, (changes.get(span.end) || 0) - 1);
        }
    }
    const boundaries = [...changes.keys()].sort((a, b) => a - b);
    let count = 0;
    return { boundaries, counts: boundaries.map((time) => (count += changes.get(time))) };
}

/** Split an overlap only where concurrent crowd counts change. */
function* segments(start, end, crowd, timeline) {
    if (!timeline) {
        yield { start, end, crowd };
        return;
    }
    let low = 0;
    let high = timeline.boundaries.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (timeline.boundaries[middle] <= start) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    let index = Math.max(0, low - 1);
    while (start < end) {
        const next = Math.min(end, timeline.boundaries[index + 1] ?? end);
        yield { start, end: next, crowd: Math.max(2, timeline.counts[index]) };
        start = next;
        index++;
    }
}

// Independent evidence, accumulated before network-level score adjustments

export function createVisitEvidence() {
    return { minutes: 0, effective_minutes: 0, encounter_factor: 0, days: new Map(), scanned: 0 };
}

/** Add true overlap time with segment recency and crowd factors. */
export function scoreOverlap(evidence, start, end, crowd, timeline, settings, window) {
    evidence.scanned++;
    evidence.minutes += (end - start) / 60;
    for (const segment of segments(start, end, crowd, timeline)) {
        const crowdFactor = settings.crowd_correction
            ? Math.pow(Math.max(1, segment.crowd - 1), -settings.crowd_exponent)
            : 1;
        const recency = settings.half_life_days
            ? Math.pow(
                  2,
                  -Math.max(0, window.now - (segment.start + segment.end) / 2) / (settings.half_life_days * DAY)
              )
            : 1;
        const factor = crowdFactor * recency;
        evidence.effective_minutes += ((segment.end - segment.start) / 60) * factor;
        evidence.encounter_factor = Math.max(evidence.encounter_factor, factor);
        for (const day of daysBetween(segment.start, segment.end)) {
            evidence.days.set(day, Math.max(evidence.days.get(day) || 0, factor));
        }
    }
}

/** Count a qualifying visit once and cap only its effective time contribution. */
export function accumulateVisit(pair, visit, settings) {
    pair.scanned += visit.scanned;
    pair.observed_encounters++;
    pair.observed_minutes += visit.minutes;
    if (visit.minutes + 1e-9 < settings.min_overlap_minutes) {
        return;
    }
    pair.encounters++;
    pair.minutes += visit.minutes;
    pair.effective_encounters += visit.encounter_factor;
    const capFactor = settings.session_cap_minutes ? Math.min(1, settings.session_cap_minutes / visit.minutes) : 1;
    pair.effective_minutes += visit.effective_minutes * capFactor;
    for (const [day, factor] of visit.days) {
        pair.days.set(day, Math.max(pair.days.get(day) || 0, factor));
    }
}

export function createPairEvidence(source, target) {
    return {
        source,
        target,
        scanned: 0,
        encounters: 0,
        minutes: 0,
        effective_encounters: 0,
        effective_minutes: 0,
        observed_encounters: 0,
        observed_minutes: 0,
        days: new Map()
    };
}

/** Enforce independent pair minimums before selecting the requested weight measure. */
export function edgeFromEvidence(pair, settings, mutual) {
    if (!pair.encounters || pair.encounters < settings.min_encounters || pair.minutes + 1e-9 < settings.min_minutes) {
        return null;
    }
    let effectiveDays = 0;
    for (const factor of pair.days.values()) {
        effectiveDays += factor;
    }
    let weight;
    switch (settings.weighting) {
        case 'count':
            weight = pair.effective_encounters;
            break;
        case 'time':
            weight = pair.effective_minutes;
            break;
        case 'days':
            weight = effectiveDays;
            break;
        default:
            weight = Math.sqrt(pair.effective_encounters * pair.effective_minutes);
    }
    if (!(weight > 0) || !Number.isFinite(weight)) {
        return null;
    }
    return {
        source: pair.source,
        target: pair.target,
        encounters: pair.encounters,
        minutes: Number(pair.minutes.toFixed(6)),
        weight,
        base_weight: weight,
        distinct_days: pair.days.size,
        distinct_weeks: new Set([...pair.days.keys()].map(weekOfDay)).size,
        effective_encounters: pair.effective_encounters,
        effective_minutes: pair.effective_minutes,
        effective_days: effectiveDays,
        observed_encounters: pair.observed_encounters,
        observed_minutes: Number(pair.observed_minutes.toFixed(6)),
        mutual
    };
}
