import { toAnalysisSettings } from '@/services/friendsNetwork/settings';
import friendsNetworkService from '@/services/friendsNetwork/service';

// --- View-to-analysis options ---

/** Map view preferences to analysis options without coupling the view to storage. */
export function toFriendsNetworkRequest(settings, scope = {}) {
    return {
        ...toAnalysisSettings(settings),
        current_user_id: scope.current_user_id ?? '',
        friend_ids: scope.friend_ids ?? []
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
