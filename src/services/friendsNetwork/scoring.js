// All timestamps are Unix seconds. Days and weeks use UTC boundaries.
export const DAY = 86400;
export function compareIds(a, b) {
    if (a < b) {
        return -1;
    }
    return a > b ? 1 : 0;
}
export const weekOfDay = (day) => Math.floor((day + 3) / 7);
export function daysBetween(start, end) {
    const days = [];
    for (let day = Math.floor(start / DAY); day < Math.ceil(end / DAY); day++) {
        days.push(day);
    }
    return days;
}

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
    friends_only: true,
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
    excluded_visits: '',
    group_hints: {},
    account_ids: []
};

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

export function normalizeAnalysisSettings(input = {}) {
    const settings = { ...defaults, group_hints: {}, account_ids: [] };
    const aliases = {
        window_days: 'days',
        start_date: 'date_from',
        end_date: 'date_to',
        weight_mode: 'weighting',
        recency_half_life_days: 'half_life_days',
        cluster_resolution: 'resolution'
    };
    for (const [original, value] of Object.entries(input)) {
        const key = aliases[original] || original;
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
    for (const key of ['friends_only', 'mutual_only', 'crowd_correction', 'include_isolates']) {
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
    for (const key of ['world_filter', 'excluded_worlds', 'excluded_visits']) {
        settings[key] = String(settings[key] ?? '').trim();
    }
    const visitTokens = settings.excluded_visits.split(/[,\s]+/).filter(Boolean);
    if (visitTokens.some((token) => !/^-?\d+$/.test(token) || !Number.isSafeInteger(Number(token)))) {
        throw new Error('excluded_visits must contain comma- or space-separated visit IDs');
    }
    if (!settings.group_hints || typeof settings.group_hints !== 'object' || Array.isArray(settings.group_hints)) {
        throw new Error('group_hints must map user IDs to group labels');
    }
    settings.group_hints = Object.fromEntries(
        Object.entries(settings.group_hints)
            .map(([id, hint]) => [id, String(hint ?? '').trim()])
            .filter(([, hint]) => hint)
    );
    if (
        !Array.isArray(settings.account_ids) ||
        settings.account_ids.length > 1 ||
        settings.account_ids.some((id) => typeof id !== 'string' || !id)
    ) {
        throw new Error('Select all accounts or one valid account ID');
    }
    settings.account_ids = [...settings.account_ids];
    settings.as_of ??= Math.floor(Date.now() / 60000) * 60;
    const now = parseDate(settings.as_of);
    const end = Math.min(now, parseDate(settings.date_to, true) ?? now);
    const start = parseDate(settings.date_from) ?? (settings.days === null ? 0 : end - settings.days * DAY);
    if (!(start < end)) {
        throw new Error('Date window must end after it starts');
    }
    return { settings, window: { start, end, now }, excludedVisits: new Set(visitTokens.map(Number)) };
}

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

export function createVisitEvidence() {
    return { minutes: 0, effective_minutes: 0, encounter_factor: 0, days: new Map(), scanned: 0 };
}

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
