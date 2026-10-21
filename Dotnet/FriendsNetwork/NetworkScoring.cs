#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Text.Json.Nodes;

namespace VRCX.FriendsNetwork;

internal static class NetworkScoring
{
    public static IEnumerable<List<T>> Consecutive<T, TKey>(IEnumerable<T> source, Func<T, TKey> key)
    {
        var group = new List<T>();
        TKey? previous = default;
        foreach (var item in source)
        {
            var current = key(item);
            if (group.Count > 0 && !EqualityComparer<TKey>.Default.Equals(previous!, current))
            {
                yield return group;
                group = new List<T>();
            }

            previous = current;
            group.Add(item);
        }

        if (group.Count > 0)
        {
            yield return group;
        }
    }

    private static IEnumerable<(double Start, double End, int Crowd)> Segments(double start, double end, int crowd, CrowdTimeline? timeline)
    {
        if (timeline is null)
        {
            yield return (start, end, crowd);
            yield break;
        }

        var position = Array.BinarySearch(timeline.Boundaries, start);
        position = position >= 0 ? position : Math.Max(0, ~position - 1);
        while (start < end)
        {
            var boundary = position + 1 < timeline.Boundaries.Length ? timeline.Boundaries[position + 1] : end;
            var segmentEnd = Math.Min(end, boundary);
            yield return (start, segmentEnd, Math.Max(2, timeline.Counts[position]));
            start = segmentEnd;
            position++;
        }
    }

    private static VisitEvidence ScoreVisit(IEnumerable<PairInterval> rows, ScoringOptions scoring, TimeWindow window, CrowdTimeline? timeline, bool report)
    {
        var result = new VisitEvidence();
        var halfLife = scoring.HalfLife;
        foreach (var row in rows)
        {
            var start = Math.Max(window.Start, row.Start);
            var end = Math.Min(window.End, row.End);
            if (end <= start)
            {
                continue;
            }

            result.Scanned++;
            result.Minutes += (end - start) / 60.0;
            result.Start = result.Start is null ? start : Math.Min(result.Start.Value, start);
            result.End = result.End is null ? end : Math.Max(result.End.Value, end);
            foreach (var segment in Segments(start, end, row.Crowd, timeline))
            {
                var crowdFactor = scoring.CrowdCorrection ? Math.Pow(Math.Max(1, segment.Crowd - 1), -scoring.CrowdExponent) : 1;
                var recencyFactor = halfLife != 0 ? Math.Pow(2, -Math.Max(0, window.Now - (segment.Start + segment.End) / 2) / halfLife) : 1;
                var factor = crowdFactor * recencyFactor;
                var minutes = (segment.End - segment.Start) / 60.0;
                result.EffectiveMinutes += minutes * factor;
                // Rejoins and concurrency splits still contribute one encounter.
                result.EncounterFactor = Math.Max(result.EncounterFactor, factor);
                foreach (var day in GraphMath.Days(segment.Start, segment.End))
                {
                    result.DayFactors[day] = Math.Max(result.DayFactors.GetValueOrDefault(day), factor);
                }

                if (report)
                {
                    result.Intervals.Add(new JsonObject
                    {
                        ["start"] = segment.Start,
                        ["end"] = segment.End,
                        ["minutes"] = minutes,
                        ["crowd"] = segment.Crowd,
                        ["factor"] = factor,
                        ["crowd_factor"] = crowdFactor,
                        ["recency_factor"] = recencyFactor
                    });
                }
            }
        }

        var cap = scoring.SessionCap;
        if (cap != 0 && result.Minutes > cap)
        {
            result.CapFactor = cap / result.Minutes;
            result.EffectiveMinutes *= result.CapFactor;
        }

        result.Qualifies = result.Minutes > 0 && result.Minutes + 1e-9 >= scoring.MinimumOverlap;
        return result;
    }

    public static (Connection? Edge, int Scanned) ScorePair(
        IEnumerable<PairInterval> input,
        GraphSettings settings,
        TimeWindow window,
        Dictionary<long, CrowdTimeline> timelines,
        List<JsonObject>? reports = null)
    {
        var rows = input as IReadOnlyList<PairInterval> ?? input.ToArray();
        var scoring = settings.Scoring;
        if (rows.Count == 0)
        {
            return (null, 0);
        }

        int encounters = 0, observedEncounters = 0, scanned = 0;
        double minutes = 0, observedMinutes = 0, effectiveEncounters = 0, effectiveMinutes = 0;
        var days = new Dictionary<long, double>();
        foreach (var visit in Consecutive(rows, row => row.VisitId))
        {
            var evidence = ScoreVisit(visit, scoring, window, timelines.GetValueOrDefault(visit[0].VisitId), reports is not null);
            scanned += evidence.Scanned;
            if (evidence.Minutes > 0)
            {
                observedEncounters++;
                observedMinutes += evidence.Minutes;
            }

            if (evidence.Qualifies)
            {
                encounters++;
                minutes += evidence.Minutes;
                effectiveEncounters += evidence.EncounterFactor;
                effectiveMinutes += evidence.EffectiveMinutes;
                foreach (var day in evidence.DayFactors)
                {
                    days[day.Key] = Math.Max(days.GetValueOrDefault(day.Key), day.Value);
                }
            }

            reports?.Add(evidence.Report(visit[0].VisitId, settings));
        }

        if (encounters == 0 || encounters < scoring.MinimumEncounters || minutes + 1e-9 < scoring.MinimumMinutes)
        {
            return (null, scanned);
        }

        var effectiveDays = days.Values.Sum();
        var weight = scoring.Weighting switch
        {
            "count" => effectiveEncounters,
            "time" => effectiveMinutes,
            "days" => effectiveDays,
            _ => Math.Sqrt(effectiveEncounters * effectiveMinutes)
        };
        if (weight <= 0 || !double.IsFinite(weight))
        {
            return (null, scanned);
        }

        var edge = new Connection
        {
            Source = rows[0].A,
            Target = rows[0].B,
            Encounters = encounters,
            Minutes = GraphMath.RoundMinutes(minutes),
            Weight = weight,
            BaseWeight = weight,
            DistinctDays = days.Count,
            DistinctWeeks = days.Keys.Select(GraphMath.Week).Distinct().Count(),
            EffectiveEncounters = effectiveEncounters,
            EffectiveMinutes = effectiveMinutes,
            EffectiveDays = effectiveDays,
            ObservedEncounters = observedEncounters,
            ObservedMinutes = GraphMath.RoundMinutes(observedMinutes)
        };
        return (edge, scanned);
    }

}
