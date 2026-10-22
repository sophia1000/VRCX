import friendsNetworkService from '@/services/friendsNetwork/service';

// --- View-to-analysis options ---

/** Map view preferences to analysis options without coupling the view to storage. */
export function toFriendsNetworkRequest(settings, scope = {}) {
    const weighting = { balanced: 'balanced', frequency: 'count', minutes: 'time', days: 'days' };
    return {
        current_user_id: scope.current_user_id ?? '',
        friend_ids: scope.friend_ids ?? [],
        days: settings.days,
        date_from: settings.dateFrom || null,
        date_to: settings.dateTo || null,
        weighting: weighting[settings.weighting] || settings.weighting || 'balanced',
        min_encounters: settings.minEncounters,
        min_minutes: settings.minMinutes,
        min_overlap_minutes: settings.minOverlapMinutes,
        session_cap_minutes: settings.sessionCapMinutes,
        half_life_days: settings.halfLifeDays,
        crowd_correction: settings.crowdCorrection,
        crowd_mode: settings.crowdMode,
        crowd_exponent: settings.crowdExponent,
        mutual_only: settings.mutualOnly,
        top_k: settings.topK,
        backbone_threshold: settings.backboneThreshold,
        edge_selection: settings.edgeSelection === 'bilateral' ? 'mutual' : 'union',
        max_nodes: settings.maxNodes,
        resolution: settings.resolution,
        include_isolates: settings.includeIsolates,
        hub_damping: settings.hubDamping,
        relative_closeness: settings.relativeCloseness,
        neighbor_similarity: settings.neighborSimilarity,
        consistency: settings.consistency,
        world_filter: settings.worldFilter,
        excluded_worlds: settings.excludedWorlds
    };
}

// --- Session service requests ---

export function requestFriendsNetwork(settings, rebuild = false, scope = {}) {
    return friendsNetworkService.graph(toFriendsNetworkRequest(settings, scope), rebuild);
}

/** Read progress without starting history loading or graph computation. */
export function readFriendsNetworkStatus() {
    return friendsNetworkService.status();
}

/** Cancel the current graph request while retaining shared imported history. */
export async function cancelFriendsNetwork() {
    friendsNetworkService.cancel();
}

/** Read every scoped friend independently of the current graph filters. */
export function readFriendsNetworkPeople(scope = {}) {
    return friendsNetworkService.people(scope);
}
