<template>
    <div class="flex flex-col gap-3">
        <Field class="gap-1">
            <FieldLabel for="friends-network-window">{{ t(`${prefix}.time_window`) }}</FieldLabel>
            <Select :model-value="period" @update:model-value="changePeriod">
                <SelectTrigger id="friends-network-window" class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                    <SelectItem v-for="value in periods" :key="value" :value="value">
                        {{ t(`${prefix}.periods.${value}`) }}
                    </SelectItem>
                </SelectContent>
            </Select>
        </Field>
        <div v-if="period === 'custom'" class="grid grid-cols-2 gap-3">
            <Field v-for="key in ['dateFrom', 'dateTo']" :key="key" class="min-w-0 gap-1">
                <FieldLabel :for="`friends-network-${key}`">{{ t(`${prefix}.fields.${key}`) }}</FieldLabel>
                <Input
                    :id="`friends-network-${key}`"
                    type="date"
                    :model-value="settings[key]"
                    @update:model-value="changeDate(key, $event)" />
            </Field>
        </div>
        <p v-if="invalidDates" class="text-xs text-destructive" role="alert">
            {{ t(`${prefix}.invalid_dates`) }}
        </p>
    </div>
</template>

<script setup>
    import { computed, ref, watch } from 'vue';
    import { useI18n } from 'vue-i18n';

    import { Field, FieldLabel } from '@/components/ui/field';
    import { Input } from '@/components/ui/input';
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

    import { createDefaultFriendsNetworkSettings } from '../friendsNetworkSettings';

    // --- Time-window selection ---

    const props = defineProps({ settings: { type: Object, default: createDefaultFriendsNetworkSettings } });
    const emit = defineEmits(['update:settings']);
    const { t } = useI18n();
    const prefix = 'view.charts.friends_network.controls';
    const periods = ['30', '90', '365', 'all', 'custom'];
    const period = ref(periodFromSettings(props.settings));
    const invalidDates = computed(
        () => props.settings.dateFrom && props.settings.dateTo && props.settings.dateFrom > props.settings.dateTo
    );

    /** Map persisted relative or custom dates back to the period selector. */
    function periodFromSettings(settings) {
        return settings.dateFrom || settings.dateTo ? 'custom' : settings.days === null ? 'all' : String(settings.days);
    }

    watch(
        () => props.settings,
        (settings) => {
            // Selecting custom dates must keep the empty editors open until the first date is entered.
            if (period.value === 'custom' && settings.days === null && !settings.dateFrom && !settings.dateTo) {
                return;
            }
            period.value = periodFromSettings(settings);
        }
    );

    // --- History-window edits ---

    /** Reset date bounds when switching between relative, full-history and custom windows. */
    function changePeriod(value) {
        period.value = value;
        emit('update:settings', {
            ...props.settings,
            days: value === 'all' || value === 'custom' ? null : Number(value),
            dateFrom: '',
            dateTo: ''
        });
    }

    function changeDate(key, value) {
        emit('update:settings', { ...props.settings, [key]: value });
    }
</script>
