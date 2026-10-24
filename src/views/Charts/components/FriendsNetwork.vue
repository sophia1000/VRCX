<template>
    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden" data-testid="friends-network">
        <div class="flex shrink-0 flex-wrap items-center gap-3">
            <div class="w-64">
                <VirtualCombobox
                    :model-value="selectedId"
                    :groups="peopleGroups"
                    :placeholder="t('view.charts.friends_network.search')"
                    :aria-label="t('view.charts.friends_network.search')"
                    :search-placeholder="t('view.charts.friends_network.search')"
                    @update:model-value="selectPerson" />
            </div>
            <div class="w-48">
                <VirtualCombobox
                    v-model="selectedGroup"
                    :groups="communityGroups"
                    :placeholder="t('view.charts.friends_network.all_groups')"
                    :aria-label="t('view.charts.friends_network.all_groups')" />
            </div>
            <Button variant="outline" @click="fitGraph">
                {{ t('view.charts.friends_network.fit') }}
            </Button>
            <span class="text-xs text-muted-foreground" role="status" aria-live="polite">
                {{ graphSummary }}
            </span>
            <div class="ml-auto flex items-center gap-2">
                <Spinner v-if="busy || layingOut" />
                <FriendsNetworkControls
                    v-model:settings="settings"
                    v-model:saved-presets="savedPresets"
                    :busy="busy"
                    :history-build-pending="historyBuildPending"
                    :status="statusText"
                    :error="error"
                    @rebuild-cache="refresh(true)" />
            </div>
        </div>

        <div v-if="busy" class="shrink-0 space-y-1" data-testid="friends-network-progress">
            <div
                class="flex items-center justify-between gap-3 text-xs text-muted-foreground"
                role="status"
                aria-live="polite">
                <span>{{ statusText }}</span>
                <span class="tabular-nums">{{ progressPercent }}%</span>
            </div>
            <Progress :model-value="progressPercent" :max="100" :aria-label="statusText" />
        </div>
        <p v-if="error" class="shrink-0 text-sm text-destructive" role="alert">{{ error }}</p>
        <AlertDialog :open="buildConfirmationOpen" @update:open="!$event && dismissHistoryBuild()">
            <AlertDialogContent @escape-key-down="dismissHistoryBuild">
                <AlertDialogHeader>
                    <AlertDialogTitle>{{ t('view.charts.friends_network.build_prompt.title') }}</AlertDialogTitle>
                    <AlertDialogDescription>
                        {{ t('view.charts.friends_network.build_prompt.message') }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel @click="dismissHistoryBuild">
                        {{ t('view.charts.friends_network.build_prompt.cancel') }}
                    </AlertDialogCancel>
                    <AlertDialogAction @click="confirmHistoryBuild">
                        {{ t('view.charts.friends_network.build_prompt.confirm') }}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
        <div class="flex min-h-0 flex-1 gap-3 overflow-hidden">
            <div class="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border">
                <div ref="canvas" class="absolute inset-0" />
                <div
                    v-if="historyBuildPending && !busy && !graph"
                    class="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
                    {{ t('view.charts.friends_network.build_prompt.empty') }}
                </div>
                <div
                    v-if="visibleGraph.nodes.length"
                    :class="settings.colorByWeight ? 'max-w-[calc(100%_-_12rem)]' : 'max-w-[90%]'"
                    class="pointer-events-none absolute bottom-3 left-3 rounded-md bg-background/90 px-3 py-2 text-xs text-muted-foreground">
                    {{ t('view.charts.friends_network.drag_help') }}
                </div>
                <div
                    v-if="settings.colorByWeight && visibleGraph.links.length"
                    class="pointer-events-none absolute right-3 bottom-3 w-36 rounded-md bg-background/90 px-3 py-2 text-xs">
                    <div class="mb-1 flex justify-between text-muted-foreground">
                        <span>{{ t('view.charts.friends_network.weak') }}</span>
                        <span>{{ t('view.charts.friends_network.strong') }}</span>
                    </div>
                    <div class="h-1.5 rounded-full" style="background: linear-gradient(to right, #3b82f6, #ef4444)" />
                </div>
                <div
                    v-if="graph && !visibleGraph.nodes.length && !busy"
                    class="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
                    {{ emptyText }}
                </div>
            </div>
            <aside
                v-if="selectedPerson"
                class="flex min-h-0 w-64 shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border p-4">
                <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                        <h3 class="truncate font-medium">{{ selectedPerson.name }}</h3>
                        <p class="break-all text-xs text-muted-foreground">{{ selectedPerson.id }}</p>
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        :aria-label="t('view.charts.friends_network.close_details')"
                        @click="selectPerson(null)">
                        <X class="size-4" />
                    </Button>
                </div>
                <Button variant="outline" size="sm" class="w-full" @click="showUserDialog(selectedPerson.id)">
                    {{ t('view.charts.mutual_friend.context_menu.view_details') }}
                </Button>
                <p v-if="!isSelectedVisible" class="text-xs text-muted-foreground">
                    {{ t('view.charts.friends_network.filtered_person') }}
                </p>
                <p class="text-xs text-muted-foreground">
                    {{ t('view.charts.friends_network.joins', { count: selectedPerson.join_count || 0 }) }}
                </p>
                <div v-if="selectedMemberships.length" class="space-y-2">
                    <h4 class="text-sm font-medium">{{ t('view.charts.friends_network.memberships') }}</h4>
                    <ul class="space-y-1 text-xs">
                        <li
                            v-for="membership in selectedMemberships"
                            :key="membership.community"
                            class="flex items-center gap-2">
                            <span class="size-2 rounded-full" :style="{ backgroundColor: membership.color }" />
                            <span>{{
                                t('view.charts.friends_network.group', { number: Number(membership.community) + 1 })
                            }}</span>
                            <span class="ml-auto tabular-nums">{{ Math.round(membership.score * 100) }}%</span>
                        </li>
                    </ul>
                    <p class="text-xs text-muted-foreground">{{ t('view.charts.friends_network.memberships_help') }}</p>
                </div>
                <h4 class="text-sm font-medium">{{ t('view.charts.friends_network.connections') }}</h4>
                <div class="flex gap-2">
                    <Button variant="outline" size="sm" @click="connectionSort = 'weight'">
                        {{ t('view.charts.friends_network.by_strength') }}
                    </Button>
                    <Button variant="outline" size="sm" @click="connectionSort = 'name'">
                        {{ t('view.charts.friends_network.by_name') }}
                    </Button>
                </div>
                <ul class="shrink-0 space-y-2">
                    <li v-for="connection in selectedConnections" :key="connection.id">
                        <button
                            class="w-full cursor-pointer rounded-md p-2 text-left hover:bg-accent"
                            @click="selectPerson(connection.id)">
                            <span class="block truncate text-sm">{{ connection.name }}</span>
                            <span class="text-xs text-muted-foreground">
                                {{
                                    t('view.charts.friends_network.evidence', {
                                        encounters: connection.encounters,
                                        hours: (connection.minutes / 60).toFixed(1)
                                    })
                                }}
                            </span>
                        </button>
                    </li>
                </ul>
            </aside>
        </div>
    </div>
</template>

<script setup>
    import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
    import { storeToRefs } from 'pinia';
    import { useI18n } from 'vue-i18n';
    import { X } from 'lucide-vue-next';

    import { Button } from '@/components/ui/button';
    import {
        AlertDialog,
        AlertDialogAction,
        AlertDialogCancel,
        AlertDialogContent,
        AlertDialogDescription,
        AlertDialogFooter,
        AlertDialogHeader,
        AlertDialogTitle
    } from '@/components/ui/alert-dialog';
    import { Spinner } from '@/components/ui/spinner';
    import { Progress } from '@/components/ui/progress';
    import { VirtualCombobox } from '@/components/ui/virtual-combobox';

    import { useAppearanceSettingsStore } from '@/stores';
    import { showUserDialog } from '@/coordinators/userCoordinator';

    import { readFriendsNetworkPeople } from '../friendsNetworkApi';
    import { useFriendsNetwork } from '../composables/useFriendsNetwork';
    import { FriendsNetworkRenderer, toFriendsNetworkLayoutSettings } from '../friendsNetworkRenderer';
    import { friendsNetworkCommunityStyles, friendsNetworkMemberships } from '../friendsNetworkAppearance';

    import FriendsNetworkControls from './FriendsNetworkControls.vue';

    const { t } = useI18n();
    const { isDarkMode } = storeToRefs(useAppearanceSettingsStore());
    const {
        settings,
        savedPresets,
        graph,
        friendContext,
        currentFriends,
        scopeKey,
        scopeReady,
        busy,
        status,
        error,
        buildConfirmationOpen,
        historyBuildPending,
        confirmHistoryBuild,
        dismissHistoryBuild,
        refresh
    } = useFriendsNetwork();

    // --- View state ---

    const canvas = ref(null);
    const selectedId = ref(null);
    const selectedGroup = ref(null);
    const connectionSort = ref('weight');
    const layingOut = ref(false);
    const directory = ref([]);
    let renderer;
    let disposed = false;
    let layoutRevision = 0;
    let directoryRevision = 0;
    let directoryKey = '';

    // --- Graph and friend projections ---

    const visibleGraph = computed(() => {
        const friends = new Set(friendContext.value.friend_ids);
        const nodes = (graph.value?.nodes || []).filter(
            (node) => friends.has(node.id) && (!selectedGroup.value || String(node.community) === selectedGroup.value)
        );
        const ids = new Set(nodes.map((node) => node.id));
        return {
            nodes,
            communities: graph.value?.communities || [],
            links: (graph.value?.links || []).filter((link) => ids.has(link.source) && ids.has(link.target))
        };
    });
    const names = computed(() => {
        const evidence = new Map(
            [...directory.value, ...(graph.value?.nodes || [])].map((person) => [person.id, person])
        );
        return new Map(
            currentFriends.value.map((friend) => {
                const person = evidence.get(friend.id);
                return [friend.id, { ...person, id: friend.id, name: friend.name || person?.name || friend.id }];
            })
        );
    });
    const selectedPerson = computed(() => names.value.get(selectedId.value));
    const communityStyles = computed(() =>
        friendsNetworkCommunityStyles(graph.value?.nodes || [], graph.value?.communities || [])
    );
    const selectedMemberships = computed(() =>
        selectedPerson.value ? friendsNetworkMemberships(selectedPerson.value, communityStyles.value) : []
    );
    const isSelectedVisible = computed(() => visibleGraph.value.nodes.some((node) => node.id === selectedId.value));
    const peopleGroups = computed(() => [
        {
            key: 'people',
            label: t('view.charts.friends_network.people'),
            items: [...names.value.values()]
                .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
                .map((person) => ({ value: person.id, label: person.name, search: `${person.name} ${person.id}` }))
        }
    ]);
    const communityGroups = computed(() => [
        {
            key: 'groups',
            label: t('view.charts.friends_network.groups'),
            items: [...new Set((graph.value?.nodes || []).map((node) => node.community))]
                .sort((a, b) => Number(a) - Number(b))
                .map((id) => ({
                    value: String(id),
                    label: t('view.charts.friends_network.group', { number: Number(id) + 1 })
                }))
        }
    ]);
    const selectedConnections = computed(() => {
        const connections = (graph.value?.links || [])
            .filter((link) => link.source === selectedId.value || link.target === selectedId.value)
            .map((link) => {
                const id = link.source === selectedId.value ? link.target : link.source;
                return { ...link, id, name: names.value.get(id)?.name || id };
            });
        return connections.sort((a, b) =>
            connectionSort.value === 'name'
                ? a.name.localeCompare(b.name)
                : b.weight - a.weight || a.name.localeCompare(b.name)
        );
    });
    const graphSummary = computed(() =>
        graph.value
            ? t('view.charts.friends_network.summary', {
                  people: visibleGraph.value.nodes.length,
                  connections: visibleGraph.value.links.length
              })
            : t('view.charts.friends_network.loading')
    );
    const emptyText = computed(() => {
        if (scopeReady.value) {
            return t('view.charts.friends_network.empty');
        }
        return t(
            friendContext.value.current_user_id
                ? 'view.charts.friends_network.friends_loading'
                : 'view.charts.friends_network.login_required'
        );
    });
    const progressPercent = computed(() => {
        const value = Number(status.value.progress);
        return Number.isFinite(value) ? Math.round(Math.max(0, Math.min(1, value)) * 100) : 0;
    });
    const statusText = computed(() => {
        if (!busy.value) {
            return graphSummary.value;
        }
        const stages = ['reading', 'reconstructing', 'overlaps', 'scoring', 'communities', 'ready'];
        return stages.includes(status.value.stage)
            ? t(`view.charts.friends_network.stages.${status.value.stage}`)
            : t('view.charts.friends_network.loading');
    });

    // --- Selection and canvas interaction ---

    function selectPerson(id) {
        selectedId.value = id;
        if (id) {
            renderer?.focus(id);
        } else {
            renderer?.highlight(null);
        }
    }

    function fitGraph() {
        renderer?.resetCamera();
    }

    /** Apply the layout without accepting completions from a replaced view. */
    async function render() {
        if (!canvas.value || !graph.value || disposed || !friendContext.value.friend_ids.length) {
            return;
        }
        if (!renderer) {
            renderer = new FriendsNetworkRenderer(canvas.value, selectPerson, {
                groupLabel: (id) => t('view.charts.friends_network.group', { number: Number(id) + 1 })
            });
        }
        const revision = ++layoutRevision;
        layingOut.value = true;
        try {
            await renderer.update(visibleGraph.value, settings.value, isDarkMode.value);
            if (revision === layoutRevision && selectedId.value) {
                renderer.highlight(selectedId.value);
            }
        } catch (reason) {
            if (!disposed && revision === layoutRevision) {
                error.value = String(reason.message || reason);
            }
        } finally {
            if (!disposed && revision === layoutRevision) {
                layingOut.value = false;
            }
        }
    }

    /** Enrich the live friend directory without accepting an obsolete scope response. */
    async function loadPeople() {
        const revision = ++directoryRevision;
        try {
            const response = await readFriendsNetworkPeople(friendContext.value);
            if (!disposed && revision === directoryRevision && Array.isArray(response.users)) {
                directory.value = response.users;
            }
        } catch {
            // Rendered people remain searchable if the directory is unavailable.
        }
    }

    // --- Reactive graph updates ---

    watch(
        scopeKey,
        () => {
            ++directoryRevision;
            ++layoutRevision;
            directory.value = [];
            directoryKey = '';
            selectedId.value = null;
            selectedGroup.value = null;
            layingOut.value = false;
            // Remove the previous account's canvas before the replacement worker
            // request can settle. Cancellation alone would leave its pixels visible.
            renderer?.dispose();
            renderer = undefined;
            if (scopeReady.value && friendContext.value.friend_ids.length) {
                void loadPeople();
            }
        },
        { flush: 'sync' }
    );
    watch(graph, () => {
        selectedGroup.value = null;
        if (!graph.value || !friendContext.value.friend_ids.length) {
            return;
        }
        const key = `${scopeKey.value}:${graph.value?.stats?.cache_built_at || ''}`;
        if (key !== directoryKey) {
            directoryKey = key;
            void loadPeople();
        }
    });
    watch([visibleGraph, () => JSON.stringify(toFriendsNetworkLayoutSettings(settings.value))], render);
    watch(
        [
            isDarkMode,
            () => settings.value.labels,
            () => settings.value.edgeOpacity,
            () => settings.value.showGroups,
            () => settings.value.showMemberships,
            () => settings.value.colorByWeight
        ],
        () => {
            renderer?.setAppearance(settings.value, isDarkMode.value);
        }
    );
    watch(busy, (value) => {
        if (value) {
            ++layoutRevision;
            layingOut.value = false;
            renderer?.cancel();
        }
    });

    // --- View lifecycle ---

    onMounted(async () => {
        await nextTick();
        if (!disposed) {
            await render();
        }
    });
    onBeforeUnmount(() => {
        disposed = true;
        ++directoryRevision;
        ++layoutRevision;
        renderer?.dispose();
    });
</script>
