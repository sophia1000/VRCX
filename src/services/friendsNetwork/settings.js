// Shared by saved preferences and worker validation. This module contains no
// storage or UI dependencies; changing a default or limit changes both callers.
export const FRIENDS_NETWORK_DEFAULTS = {
    days: 90,
    dateFrom: '',
    dateTo: '',
    weighting: 'balanced',
    minEncounters: 2,
    minMinutes: 2,
    minOverlapMinutes: 0,
    sessionCapMinutes: 0,
    halfLifeDays: 90,
    crowdCorrection: true,
    crowdMode: 'visit',
    crowdExponent: 0.5,
    mutualOnly: false,
    topK: 12,
    edgeSelection: 'union',
    backboneThreshold: 1,
    maxNodes: 800,
    resolution: 1,
    includeIsolates: false,
    hubDamping: 0,
    relativeCloseness: 0,
    neighborSimilarity: 0,
    consistency: 0,
    worldFilter: '',
    excludedWorlds: '',
    layoutSpacing: 60,
    groupSpacing: 60,
    groupTightness: 50,
    betweenGroupPull: 100,
    showGroups: true,
    showMemberships: true,
    colorByWeight: false,
    labels: true,
    edgeOpacity: 30
};

export const FRIENDS_NETWORK_NUMBER_BOUNDS = {
    minEncounters: [1, 10000],
    minMinutes: [0, 100000],
    minOverlapMinutes: [0, 10000],
    sessionCapMinutes: [0, 10000],
    halfLifeDays: [0, 3650],
    crowdExponent: [0, 2],
    topK: [0, 1000],
    backboneThreshold: [0, 1],
    maxNodes: [0, 10000],
    resolution: [0.1, 5],
    hubDamping: [0, 1],
    relativeCloseness: [0, 1],
    neighborSimilarity: [0, 1],
    consistency: [0, 1],
    layoutSpacing: [0, 100],
    groupSpacing: [0, 100],
    groupTightness: [0, 100],
    betweenGroupPull: [0, 100],
    edgeOpacity: [0, 100]
};

// Explicit wire names keep old saved preferences compatible without maintaining
// a second set of defaults and ranges in the analysis worker.
export const ANALYSIS_SETTING_KEYS = {
    days: 'days',
    date_from: 'dateFrom',
    date_to: 'dateTo',
    weighting: 'weighting',
    min_encounters: 'minEncounters',
    min_minutes: 'minMinutes',
    min_overlap_minutes: 'minOverlapMinutes',
    session_cap_minutes: 'sessionCapMinutes',
    half_life_days: 'halfLifeDays',
    crowd_correction: 'crowdCorrection',
    crowd_mode: 'crowdMode',
    crowd_exponent: 'crowdExponent',
    mutual_only: 'mutualOnly',
    top_k: 'topK',
    edge_selection: 'edgeSelection',
    backbone_threshold: 'backboneThreshold',
    max_nodes: 'maxNodes',
    resolution: 'resolution',
    include_isolates: 'includeIsolates',
    hub_damping: 'hubDamping',
    relative_closeness: 'relativeCloseness',
    neighbor_similarity: 'neighborSimilarity',
    consistency: 'consistency',
    world_filter: 'worldFilter',
    excluded_worlds: 'excludedWorlds'
};

/** Select analysis controls and translate the few differently named choices. */
export function toAnalysisSettings(settings) {
    const result = Object.fromEntries(
        Object.entries(ANALYSIS_SETTING_KEYS).map(([key, viewKey]) => [key, settings[viewKey]])
    );
    result.date_from ||= null;
    result.date_to ||= null;
    const weighting = { balanced: 'balanced', frequency: 'count', minutes: 'time', days: 'days' };
    result.weighting = weighting[settings.weighting] || settings.weighting || 'balanced';
    result.edge_selection = settings.edgeSelection === 'bilateral' ? 'mutual' : 'union';
    return result;
}
