<template>
    <div class="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
        <div
            class="flex shrink-0 items-center gap-2 p-2"
            role="group"
            :aria-label="t('view.charts.friends_network.mode')">
            <Button
                :disabled="!loaded"
                :variant="mode === 'mutual' ? 'default' : 'outline'"
                :aria-pressed="mode === 'mutual'"
                @click="setMode('mutual')">
                {{ t('view.charts.friends_network.mutual_mode') }}
            </Button>
            <Button
                :disabled="!loaded"
                :variant="mode === 'history' ? 'default' : 'outline'"
                :aria-pressed="mode === 'history'"
                @click="setMode('history')">
                {{ t('view.charts.friends_network.history_mode') }}
            </Button>
        </div>
        <MutualFriendsGraph v-if="loaded && mode === 'mutual'" class="min-h-0 flex-1" />
        <div v-else-if="loaded" class="x-container x-container--auto-height min-h-0 flex-1">
            <FriendsNetwork />
        </div>
    </div>
</template>

<script setup>
    import { onMounted, ref } from 'vue';
    import { useI18n } from 'vue-i18n';

    import { Button } from '@/components/ui/button';

    import configRepository from '@/services/config';

    import FriendsNetwork from './FriendsNetwork.vue';
    import MutualFriendsGraph from './MutualFriends.vue';

    defineOptions({ name: 'ChartsMutual' });

    // --- Persisted source selection ---

    const MODE_KEY = 'VRCX_FriendsNetworkMode';
    const { t } = useI18n();
    const mode = ref('mutual');
    const loaded = ref(false);

    // Restore the source before mounting either chart's data flow.
    onMounted(async () => {
        try {
            const saved = await configRepository.getString(MODE_KEY, 'mutual');
            mode.value = saved === 'history' ? 'history' : 'mutual';
        } catch (error) {
            console.error('[FriendsNetwork] Failed to restore graph mode', error);
        } finally {
            loaded.value = true;
        }
    });

    function setMode(value) {
        mode.value = value;
        void configRepository.setString(MODE_KEY, value).catch((error) => {
            console.error('[FriendsNetwork] Failed to save graph mode', error);
        });
    }
</script>
