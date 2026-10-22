<template>
    <div class="flex items-center gap-2">
        <Button variant="outline" :disabled="busy" @click="emit('rebuild-cache')">
            <Spinner v-if="busy" />
            <RefreshCw v-else class="size-4" />
            {{ t(`${prefix}.rebuild_cache`) }}
        </Button>
        <Sheet :modal="false">
            <SheetTrigger as-child>
                <Button variant="ghost" size="icon" class="rounded-full" :aria-label="t(`${prefix}.title`)">
                    <Settings class="size-4" />
                </Button>
            </SheetTrigger>
            <SheetContent side="right" class="w-full gap-0 sm:max-w-[420px]" @interact-outside.prevent>
                <SheetHeader>
                    <SheetTitle>{{ t(`${prefix}.title`) }}</SheetTitle>
                    <SheetDescription>{{ t(`${prefix}.description`) }}</SheetDescription>
                </SheetHeader>
                <div class="min-h-0 flex-1 overflow-y-auto">
                    <FieldGroup class="gap-5 p-4">
                        <p v-if="status" role="status" class="text-xs text-muted-foreground">{{ status }}</p>
                        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>

                        <Field>
                            <FieldLabel for="friends-network-preset">{{ t(`${prefix}.preset`) }}</FieldLabel>
                            <Select :model-value="activePresetId" @update:model-value="selectPreset">
                                <SelectTrigger id="friends-network-preset" class="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="custom">{{ t(`${prefix}.custom_settings`) }}</SelectItem>
                                    <SelectGroup>
                                        <SelectLabel>{{ t(`${prefix}.builtin_presets`) }}</SelectLabel>
                                        <SelectItem
                                            v-for="preset in FRIENDS_NETWORK_PRESETS"
                                            :key="preset.id"
                                            :value="preset.id">
                                            {{ t(`view.charts.friends_network.presets.${preset.nameKey}`) }}
                                        </SelectItem>
                                    </SelectGroup>
                                    <SelectGroup v-if="userPresets.length">
                                        <SelectLabel>{{ t(`${prefix}.saved_presets`) }}</SelectLabel>
                                        <SelectItem v-for="preset in userPresets" :key="preset.id" :value="preset.id">
                                            {{ preset.name }}
                                        </SelectItem>
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                            <FieldDescription>{{ t(`${prefix}.preset_window_help`) }}</FieldDescription>
                        </Field>

                        <FriendsNetworkTimeWindow
                            :settings="current"
                            @update:settings="emit('update:settings', $event)" />

                        <Field>
                            <FieldLabel for="friends-network-weighting">{{ label('weighting') }}</FieldLabel>
                            <Select
                                :model-value="current.weighting"
                                @update:model-value="updateSetting('weighting', $event)">
                                <SelectTrigger id="friends-network-weighting" class="w-full"
                                    ><SelectValue
                                /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem v-for="mode in weightingModes" :key="mode" :value="mode">
                                        {{ t(`${prefix}.weighting.${mode}`) }}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                            <FieldDescription>{{ t(`${prefix}.weighting_help`) }}</FieldDescription>
                        </Field>

                        <Field v-for="key in ['mutualOnly', 'includeIsolates']" :key="key" orientation="horizontal">
                            <FieldContent>
                                <FieldLabel :for="controlId(key)">{{ label(key) }}</FieldLabel>
                                <FieldDescription v-if="key === 'includeIsolates'">{{
                                    t(`${prefix}.isolates_help`)
                                }}</FieldDescription>
                            </FieldContent>
                            <Switch
                                :id="controlId(key)"
                                :model-value="current[key]"
                                :aria-label="label(key)"
                                @update:model-value="updateSetting(key, $event)" />
                        </Field>

                        <Collapsible class="border-t pt-3">
                            <CollapsibleTrigger as-child>
                                <Button variant="ghost" class="w-full justify-between px-0">
                                    {{ t(`${prefix}.connection_filters`) }}<ChevronDown class="size-4" />
                                </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                                <FieldGroup class="gap-4 pt-3">
                                    <Field v-for="field in numericFields" :key="field.key">
                                        <FieldLabel :for="controlId(field.key)">{{ label(field.key) }}</FieldLabel>
                                        <Input
                                            :id="controlId(field.key)"
                                            type="number"
                                            :model-value="current[field.key]"
                                            :min="field.min"
                                            :max="field.max"
                                            :step="field.step"
                                            @update:model-value="updateSetting(field.key, Number($event))" />
                                        <FieldDescription v-if="field.help">{{
                                            t(`${prefix}.${field.help}`)
                                        }}</FieldDescription>
                                    </Field>
                                    <Field v-for="field in filterSliders" :key="field.key">
                                        <FieldLabel :for="controlId(field.key)">{{ label(field.key) }}</FieldLabel>
                                        <FieldContent>
                                            <div class="flex items-center gap-3">
                                                <Slider
                                                    :id="controlId(field.key)"
                                                    :model-value="[current[field.key]]"
                                                    :min="field.min"
                                                    :max="field.max"
                                                    :step="field.step"
                                                    :aria-label="label(field.key)"
                                                    @update:model-value="updateSetting(field.key, $event[0])" />
                                                <span
                                                    class="min-w-12 text-right text-sm tabular-nums text-muted-foreground">
                                                    {{ current[field.key] }}
                                                </span>
                                            </div>
                                            <FieldDescription v-if="field.help">{{
                                                t(`${prefix}.${field.help}`)
                                            }}</FieldDescription>
                                        </FieldContent>
                                    </Field>
                                    <Field>
                                        <div class="flex items-center gap-1">
                                            <FieldLabel for="friends-network-backbone">{{
                                                label('backboneThreshold')
                                            }}</FieldLabel>
                                            <TooltipWrapper :content="t(`${prefix}.backbone_help`)" side="left">
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    class="size-5 text-muted-foreground"
                                                    :aria-label="t(`${prefix}.backbone_help_label`)">
                                                    <CircleHelp class="size-3.5" />
                                                </Button>
                                            </TooltipWrapper>
                                        </div>
                                        <Select
                                            data-testid="friends-network-backbone-select"
                                            :model-value="String(current.backboneThreshold)"
                                            @update:model-value="updateSetting('backboneThreshold', Number($event))">
                                            <SelectTrigger id="friends-network-backbone" class="w-full">
                                                <SelectValue>{{ backboneLabel }}</SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem
                                                    v-for="option in backboneThresholds"
                                                    :key="option.value"
                                                    :value="String(option.value)">
                                                    {{ t(`${prefix}.backbone_options.${option.name}`) }}
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <FieldDescription>{{ t(`${prefix}.backbone_description`) }}</FieldDescription>
                                    </Field>
                                    <Field>
                                        <FieldLabel for="friends-network-edge-selection">{{
                                            label('edgeSelection')
                                        }}</FieldLabel>
                                        <Select
                                            :model-value="current.edgeSelection"
                                            @update:model-value="updateSetting('edgeSelection', $event)">
                                            <SelectTrigger id="friends-network-edge-selection" class="w-full"
                                                ><SelectValue
                                            /></SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="union">{{
                                                    t(`${prefix}.edge_selection.union`)
                                                }}</SelectItem>
                                                <SelectItem value="bilateral">{{
                                                    t(`${prefix}.edge_selection.bilateral`)
                                                }}</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <FieldDescription>{{ t(`${prefix}.edge_selection_help`) }}</FieldDescription>
                                    </Field>
                                </FieldGroup>
                            </CollapsibleContent>
                        </Collapsible>

                        <Collapsible class="border-t pt-3">
                            <CollapsibleTrigger as-child>
                                <Button variant="ghost" class="w-full justify-between px-0">
                                    {{ t(`${prefix}.scoring`) }}<ChevronDown class="size-4" />
                                </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                                <FieldGroup class="gap-4 pt-3">
                                    <Field orientation="horizontal">
                                        <FieldLabel :for="controlId('crowdCorrection')">{{
                                            label('crowdCorrection')
                                        }}</FieldLabel>
                                        <Switch
                                            :id="controlId('crowdCorrection')"
                                            :model-value="current.crowdCorrection"
                                            :aria-label="label('crowdCorrection')"
                                            @update:model-value="updateSetting('crowdCorrection', $event)" />
                                    </Field>
                                    <Field>
                                        <FieldLabel for="friends-network-crowd-mode">{{
                                            t(`${prefix}.crowd_mode`)
                                        }}</FieldLabel>
                                        <Select
                                            :model-value="current.crowdMode"
                                            @update:model-value="updateSetting('crowdMode', $event)">
                                            <SelectTrigger id="friends-network-crowd-mode"
                                                ><SelectValue
                                            /></SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="visit">{{ t(`${prefix}.crowd_visit`) }}</SelectItem>
                                                <SelectItem value="concurrent">{{
                                                    t(`${prefix}.crowd_concurrent`)
                                                }}</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <FieldDescription>{{ t(`${prefix}.crowd_mode_help`) }}</FieldDescription>
                                    </Field>
                                    <Field v-for="field in scoringSliders" :key="field.key">
                                        <FieldLabel :for="controlId(field.key)">{{ label(field.key) }}</FieldLabel>
                                        <FieldContent>
                                            <div class="flex items-center gap-3">
                                                <Slider
                                                    :id="controlId(field.key)"
                                                    :model-value="[current[field.key]]"
                                                    :min="field.min"
                                                    :max="field.max"
                                                    :step="field.step"
                                                    :aria-label="label(field.key)"
                                                    @update:model-value="updateSetting(field.key, $event[0])" />
                                                <span
                                                    class="min-w-12 text-right text-sm tabular-nums text-muted-foreground">
                                                    {{
                                                        field.key === 'crowdExponent'
                                                            ? current[field.key]
                                                            : `${Math.round(current[field.key] * 100)}%`
                                                    }}
                                                </span>
                                            </div>
                                            <FieldDescription>{{ t(`${prefix}.${field.help}`) }}</FieldDescription>
                                        </FieldContent>
                                    </Field>
                                </FieldGroup>
                            </CollapsibleContent>
                        </Collapsible>

                        <Collapsible class="border-t pt-3">
                            <CollapsibleTrigger as-child>
                                <Button variant="ghost" class="w-full justify-between px-0">
                                    {{ t(`${prefix}.worlds`) }}<ChevronDown class="size-4" />
                                </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                                <FieldGroup class="gap-4 pt-3">
                                    <Field v-for="key in ['worldFilter', 'excludedWorlds']" :key="key">
                                        <FieldLabel :for="controlId(key)">{{ label(key) }}</FieldLabel>
                                        <Input
                                            :id="controlId(key)"
                                            :model-value="current[key]"
                                            @update:model-value="updateSetting(key, $event)" />
                                    </Field>
                                    <FieldDescription>{{ t(`${prefix}.worlds_help`) }}</FieldDescription>
                                </FieldGroup>
                            </CollapsibleContent>
                        </Collapsible>

                        <Collapsible class="border-t pt-3" :default-open="true">
                            <CollapsibleTrigger as-child>
                                <Button variant="ghost" class="w-full justify-between px-0">
                                    {{ t(`${prefix}.appearance`) }}<ChevronDown class="size-4" />
                                </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                                <FieldGroup class="gap-4 pt-3">
                                    <Field v-for="field in layoutSliders" :key="field.key">
                                        <FieldLabel :for="controlId(field.key)">{{ label(field.key) }}</FieldLabel>
                                        <div class="flex items-center gap-3">
                                            <Slider
                                                :id="controlId(field.key)"
                                                :model-value="[current[field.key]]"
                                                :min="0"
                                                :max="100"
                                                :step="1"
                                                :aria-label="label(field.key)"
                                                @update:model-value="updateSetting(field.key, $event[0])" />
                                            <span
                                                class="min-w-12 text-right text-sm tabular-nums text-muted-foreground">
                                                {{ current[field.key] }}%
                                            </span>
                                        </div>
                                    </Field>
                                    <Field
                                        v-for="key in ['labels', 'showMemberships', 'colorByWeight']"
                                        :key="key"
                                        orientation="horizontal">
                                        <FieldLabel :for="controlId(key)">{{ label(key) }}</FieldLabel>
                                        <Switch
                                            :id="controlId(key)"
                                            :model-value="current[key]"
                                            :aria-label="label(key)"
                                            @update:model-value="updateSetting(key, $event)" />
                                    </Field>
                                    <FieldDescription>{{ t(`${prefix}.weight_colors_help`) }}</FieldDescription>
                                </FieldGroup>
                            </CollapsibleContent>
                        </Collapsible>

                        <Collapsible class="border-t pt-3">
                            <CollapsibleTrigger as-child>
                                <Button variant="ghost" class="w-full justify-between px-0">
                                    {{ t(`${prefix}.manage_presets`) }}<ChevronDown class="size-4" />
                                </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                                <FieldGroup class="gap-3 pt-3">
                                    <Field>
                                        <FieldLabel for="friends-network-preset-name">{{
                                            t(`${prefix}.preset_name`)
                                        }}</FieldLabel>
                                        <Input
                                            id="friends-network-preset-name"
                                            v-model="presetName"
                                            :maxlength="120"
                                            @keydown.enter.prevent="savePreset" />
                                    </Field>
                                    <Button
                                        class="w-full"
                                        :disabled="!presetName.trim() || userPresets.length >= 40"
                                        @click="savePreset">
                                        {{ t(`${prefix}.save_preset`) }}
                                    </Button>
                                    <Button
                                        variant="destructive"
                                        class="w-full"
                                        :disabled="!selectedUserPreset || deleteConfirmationOpen"
                                        @click="deletePreset">
                                        {{ t(`${prefix}.delete_preset`) }}
                                    </Button>
                                    <FieldDescription>{{ t(`${prefix}.preset_help`) }}</FieldDescription>
                                </FieldGroup>
                            </CollapsibleContent>
                        </Collapsible>
                    </FieldGroup>
                </div>
                <AlertDialog v-if="deleteConfirmationOpen" v-model:open="deleteConfirmationOpen">
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>{{ t(`${prefix}.delete_title`) }}</AlertDialogTitle>
                            <AlertDialogDescription>
                                {{ t(`${prefix}.delete_description`, { name: pendingDeletion?.name || '' }) }}
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>{{ t('common.actions.cancel') }}</AlertDialogCancel>
                            <AlertDialogAction variant="destructive" @click="confirmPresetDeletion">
                                {{ t(`${prefix}.delete_preset`) }}
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </SheetContent>
        </Sheet>
    </div>
</template>

<script setup>
    import FriendsNetworkTimeWindow from './FriendsNetworkTimeWindow.vue';
    import { computed, ref } from 'vue';
    import { useI18n } from 'vue-i18n';
    import { ChevronDown, CircleHelp, RefreshCw, Settings } from 'lucide-vue-next';
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
    import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
    import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
    import { Input } from '@/components/ui/input';
    import {
        Select,
        SelectContent,
        SelectGroup,
        SelectItem,
        SelectLabel,
        SelectTrigger,
        SelectValue
    } from '@/components/ui/select';
    import {
        Sheet,
        SheetContent,
        SheetDescription,
        SheetHeader,
        SheetTitle,
        SheetTrigger
    } from '@/components/ui/sheet';
    import { Slider } from '@/components/ui/slider';
    import { Spinner } from '@/components/ui/spinner';
    import { Switch } from '@/components/ui/switch';
    import { TooltipWrapper } from '@/components/ui/tooltip';
    import {
        applyFriendsNetworkPreset,
        createDefaultFriendsNetworkSettings,
        createFriendsNetworkPreset,
        FRIENDS_NETWORK_PRESETS,
        normalizeFriendsNetworkSettings,
        validFriendsNetworkPresets
    } from '../friendsNetworkSettings';

    const props = defineProps({
        settings: { type: Object, default: createDefaultFriendsNetworkSettings },
        savedPresets: { type: Array, default: () => [] },
        busy: { type: Boolean, default: false },
        status: { type: String, default: '' },
        error: { type: String, default: '' }
    });
    const emit = defineEmits(['update:settings', 'update:savedPresets', 'rebuild-cache']);
    const { t } = useI18n();
    const prefix = 'view.charts.friends_network.controls';
    const current = computed(() => normalizeFriendsNetworkSettings(props.settings));
    const userPresets = computed(() => validFriendsNetworkPresets(props.savedPresets));
    const activePresetId = ref('custom');
    const presetName = ref('');
    const deleteConfirmationOpen = ref(false);
    const pendingDeletion = ref(null);
    const weightingModes = ['balanced', 'frequency', 'minutes', 'days'];
    const backboneThresholds = [
        { value: 1, name: 'off' },
        { value: 0.5, name: 'light' },
        { value: 0.2, name: 'moderate' },
        { value: 0.1, name: 'selective' },
        { value: 0.05, name: 'strict' }
    ];
    const backboneLabel = computed(() => {
        const option = backboneThresholds.find((entry) => entry.value === current.value.backboneThreshold);
        return option ? t(`${prefix}.backbone_options.${option.name}`) : String(current.value.backboneThreshold);
    });
    const selectedUserPreset = computed(() => userPresets.value.find((preset) => preset.id === activePresetId.value));
    const numericFields = [
        { key: 'minEncounters', min: 1, max: 10000, step: 1 },
        { key: 'minMinutes', min: 0, max: 100000, step: 1 },
        { key: 'minOverlapMinutes', min: 0, max: 10000, step: 1, help: 'overlap_help' },
        { key: 'sessionCapMinutes', min: 0, max: 10000, step: 1, help: 'session_cap_help' }
    ];
    const filterSliders = [
        { key: 'halfLifeDays', min: 0, max: 365, step: 1, help: 'half_life_help' },
        { key: 'topK', min: 0, max: 60, step: 1, help: 'top_k_help' },
        { key: 'maxNodes', min: 100, max: 2000, step: 100 },
        { key: 'resolution', min: 0.1, max: 3, step: 0.05, help: 'resolution_help' }
    ];
    const scoringSliders = [
        { key: 'crowdExponent', min: 0, max: 2, step: 0.1, help: 'crowd_help' },
        { key: 'hubDamping', min: 0, max: 1, step: 0.05, help: 'hub_help' },
        { key: 'relativeCloseness', min: 0, max: 1, step: 0.05, help: 'closeness_help' },
        { key: 'neighborSimilarity', min: 0, max: 1, step: 0.05, help: 'neighbors_help' },
        { key: 'consistency', min: 0, max: 1, step: 0.05, help: 'consistency_help' }
    ];
    const layoutSliders = ['layoutSpacing', 'groupSpacing', 'groupTightness', 'betweenGroupPull', 'edgeOpacity'].map(
        (key) => ({ key })
    );

    function label(key) {
        return t(`${prefix}.fields.${key}`);
    }

    function controlId(key) {
        return `friends-network-${key}`;
    }

    function updateSetting(key, value) {
        activePresetId.value = 'custom';
        emit('update:settings', normalizeFriendsNetworkSettings({ ...current.value, [key]: value }));
    }

    function selectPreset(id) {
        if (id === 'custom') {
            activePresetId.value = id;
            return;
        }
        const preset =
            FRIENDS_NETWORK_PRESETS.find((entry) => entry.id === id) ||
            userPresets.value.find((entry) => entry.id === id);
        if (!preset) {
            return;
        }
        const next = applyFriendsNetworkPreset(preset, current.value);
        activePresetId.value = id;
        presetName.value = preset.name || '';
        emit('update:settings', next);
    }

    function savePreset() {
        if (!presetName.value.trim() || userPresets.value.length >= 40) {
            return;
        }
        const preset = createFriendsNetworkPreset(presetName.value, current.value);
        emit('update:savedPresets', [...userPresets.value, preset]);
        activePresetId.value = preset.id;
        presetName.value = preset.name;
    }

    function deletePreset() {
        const preset = selectedUserPreset.value;
        if (!preset || deleteConfirmationOpen.value) {
            return;
        }
        // Capture identity when the dialog opens. A later selection cannot change
        // which saved view the confirmation refers to.
        pendingDeletion.value = { id: preset.id, name: preset.name };
        deleteConfirmationOpen.value = true;
    }

    function confirmPresetDeletion() {
        const preset = pendingDeletion.value;
        if (!preset || !userPresets.value.some((entry) => entry.id === preset.id)) {
            return;
        }
        emit(
            'update:savedPresets',
            userPresets.value.filter((entry) => entry.id !== preset.id)
        );
        if (activePresetId.value === preset.id) {
            activePresetId.value = 'custom';
            presetName.value = '';
        }
        pendingDeletion.value = null;
        deleteConfirmationOpen.value = false;
    }
</script>
