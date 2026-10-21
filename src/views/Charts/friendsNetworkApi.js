import friendsNetworkService from '@/services/friendsNetwork/service';

/** Map view preferences to analysis options without coupling the view to storage. */
export function toFriendsNetworkRequest(settings, revision) {
    const weighting = { balanced: 'balanced', frequency: 'count', minutes: 'time', days: 'days' };
    return {
        _revision: revision,
        account_ids: settings.account && settings.account !== 'all' ? [settings.account] : [],
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
        friends_only: settings.friendsOnly,
        mutual_only: settings.mutualOnly,
        top_k: settings.topK,
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

export async function requestFriendsNetwork(settings, revision, rebuild = false) {
    const result = await friendsNetworkService.graph(toFriendsNetworkRequest(settings, revision), rebuild);
    if (result.error) {
        throw new Error(result.error);
    }
    return result;
}

export async function readFriendsNetworkStatus() {
    return friendsNetworkService.status();
}

export async function cancelFriendsNetwork() {
    await friendsNetworkService.cancel();
}

export async function readFriendsNetworkPeople() {
    return friendsNetworkService.people();
}
