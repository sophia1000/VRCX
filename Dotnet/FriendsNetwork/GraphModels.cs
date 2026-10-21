#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Text.Json.Nodes;

namespace VRCX.FriendsNetwork;

internal sealed record Presence(long VisitId, string UserId, double Start, double End);
internal readonly record struct PairInterval(string A, string B, long VisitId, double Start, double End, int Crowd);
internal sealed record TimeWindow(double Start, double End, double Now);
internal sealed record CrowdTimeline(double[] Boundaries, int[] Counts);
internal sealed class Person
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public bool IsFriend { get; init; }
    public long JoinCount { get; init; }
    public double? LastSeen { get; init; }
    public int Encounters { get; set; }
    public double Minutes { get; set; }
    public int DistinctDays { get; set; }
    public int DistinctWeeks { get; set; }
    public int? Community { get; set; }
    public string? Subcommunity { get; set; }
    public JsonArray? Memberships { get; set; }
    public double ConnectionScore { get; set; }
    public double BridgeScore { get; set; }
    public string GroupHint { get; set; } = "";

    public Person Copy() => (Person)MemberwiseClone();
    public JsonObject ToJson()
    {
        var result = new JsonObject
        {
            ["id"] = Id,
            ["name"] = Name,
            ["is_friend"] = IsFriend,
            ["join_count"] = JoinCount,
            ["last_seen"] = LastSeen,
            ["encounters"] = Encounters,
            ["minutes"] = Minutes,
            ["distinct_days"] = DistinctDays,
            ["distinct_weeks"] = DistinctWeeks
        };
        if (Community is not null)
        {
            result["community"] = Community;
            result["subcommunity"] = Subcommunity;
            result["memberships"] = Memberships?.DeepClone();
            result["connection_score"] = ConnectionScore;
            result["bridge_score"] = BridgeScore;
            result["group_hint"] = GroupHint;
        }

        return result;
    }
}

internal sealed class Connection
{
    public required string Source { get; init; }
    public required string Target { get; init; }
    public int Encounters { get; init; }
    public double Minutes { get; init; }
    public double BaseWeight { get; init; }
    public double Weight { get; set; }
    public double? Strength { get; set; }
    public bool Mutual { get; set; }
    public int DistinctDays { get; init; }
    public int DistinctWeeks { get; init; }
    public double EffectiveEncounters { get; init; }
    public double EffectiveMinutes { get; init; }
    public double EffectiveDays { get; init; }
    public int ObservedEncounters { get; init; }
    public double ObservedMinutes { get; init; }
    public JsonObject? ScoreFactors { get; set; }

    public Connection Copy() => (Connection)MemberwiseClone();
    public JsonObject ToJson()
    {
        var result = new JsonObject
        {
            ["source"] = Source,
            ["target"] = Target,
            ["encounters"] = Encounters,
            ["minutes"] = Minutes,
            ["weight"] = Weight,
            ["base_weight"] = BaseWeight,
            ["distinct_days"] = DistinctDays,
            ["distinct_weeks"] = DistinctWeeks,
            ["effective_encounters"] = EffectiveEncounters,
            ["effective_minutes"] = EffectiveMinutes,
            ["effective_days"] = EffectiveDays,
            ["observed_encounters"] = ObservedEncounters,
            ["observed_minutes"] = ObservedMinutes,
            ["mutual"] = Mutual
        };
        if (ScoreFactors is not null)
        {
            result["score_factors"] = ScoreFactors.DeepClone();
        }

        if (Strength is not null)
        {
            result["strength"] = Strength;
        }

        return result;
    }
}

internal sealed record Evidence(Dictionary<string, Person> Users, List<Connection> Links, TimeWindow Window, int IntervalsScanned)
{
    public Evidence Copy(string? focus = null)
    {
        var users = Users.ToDictionary(pair => pair.Key, pair => pair.Value.Copy(), StringComparer.Ordinal);
        var links = Links.Where(edge => focus is null || edge.Source == focus || edge.Target == focus).Select(edge => edge.Copy()).ToList();
        return new Evidence(users, links, Window, IntervalsScanned);
    }

    public JsonObject Stats() => new()
    {
        ["window_start"] = Window.Start,
        ["window_end"] = Window.End,
        ["as_of"] = Window.Now,
        ["intervals_scanned"] = IntervalsScanned
    };
}

internal sealed class VisitEvidence
{
    public double Minutes { get; set; }
    public double EffectiveMinutes { get; set; }
    public double EncounterFactor { get; set; }
    public int Scanned { get; set; }
    public Dictionary<long, double> DayFactors { get; } = new();
    public double? Start { get; set; }
    public double? End { get; set; }
    public bool Qualifies { get; set; }
    public double CapFactor { get; set; } = 1;
    public JsonArray Intervals { get; } = new();

    public JsonObject Report(long visitId, GraphSettings settings) => new()
    {
        ["visit_id"] = visitId,
        ["start"] = Start,
        ["end"] = End,
        ["minutes"] = Minutes,
        ["effective_minutes"] = EffectiveMinutes,
        ["encounter_factor"] = EncounterFactor,
        ["distinct_days"] = DayFactors.Count,
        ["distinct_weeks"] = DayFactors.Keys.Select(GraphMath.Week).Distinct().Count(),
        ["qualifies"] = Qualifies,
        ["exclusion_reason"] = Qualifies ? null : "Below minimum overlap per visit",
        ["session_cap_factor"] = CapFactor,
        ["crowd_mode"] = settings.Text("crowd_mode"),
        ["intervals"] = Intervals.DeepClone()
    };
}

internal static class GraphMath
{
    public const double Day = 86400;
    public static long Week(long day) => (long)Math.Floor((day + 3) / 7.0);
    public static IEnumerable<long> Days(double start, double end)
    {
        for (long day = (long)Math.Floor(start / Day); day < Math.Ceiling(end / Day); day++)
        {
            yield return day;
        }
    }

    public static double RoundMinutes(double value) => Math.Round(value, 6, MidpointRounding.ToEven);
    public static double Now() => (DateTimeOffset.UtcNow - DateTimeOffset.UnixEpoch).TotalSeconds;
}
