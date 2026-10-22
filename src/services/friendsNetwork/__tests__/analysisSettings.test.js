import { describe, expect, it } from 'vitest';
import { normalizeAnalysisSettings } from '../scoring';

describe('analysis backbone settings', () => {
    it('defaults to disabled and bounds finite thresholds to the significance range', () => {
        expect(normalizeAnalysisSettings().settings.backbone_threshold).toBe(1);
        expect(normalizeAnalysisSettings({ backbone_threshold: '0.05' }).settings.backbone_threshold).toBe(0.05);
        expect(normalizeAnalysisSettings({ backbone_threshold: -1 }).settings.backbone_threshold).toBe(0);
        expect(normalizeAnalysisSettings({ backbone_threshold: 2 }).settings.backbone_threshold).toBe(1);
    });

    it('rejects nonfinite thresholds before any graph work', () => {
        for (const value of [NaN, Infinity, -Infinity, 'invalid']) {
            expect(() => normalizeAnalysisSettings({ backbone_threshold: value })).toThrow(
                'backbone_threshold must be finite'
            );
        }
    });
});
