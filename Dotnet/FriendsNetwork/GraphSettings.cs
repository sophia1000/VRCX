#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Globalization;
using System.Text.Json.Nodes;

namespace VRCX.FriendsNetwork;

internal sealed class GraphSettings
{
    public ScoringOptions Scoring { get; }
    public JsonObject Json { get; }

    public GraphSettings(JsonObject? input)
    {
        Json = Defaults();
        var aliases = new Dictionary<string, string>
        {
            ["window_days"] = "days",
            ["start_date"] = "date_from",
            ["end_date"] = "date_to",
            ["weight_mode"] = "weighting",
            ["recency_half_life_days"] = "half_life_days",
            ["cluster_resolution"] = "resolution"
        };
        if (input is not null)
        {
            foreach (var item in input)
            {
                var key = aliases.GetValueOrDefault(item.Key, item.Key);
                if (Json.ContainsKey(key))
                {
                    Json[key] = item.Value?.DeepClone();
                }
            }
        }

        if (Json["days"] is not null)
        {
            var days = Text("days");
            Json["days"] = days is "all" or "" or "0" ? null : Math.Max(1, Convert.ToInt32(Number("days")));
        }

        foreach (var key in new[]
        {
            "min_minutes",
            "half_life_days",
            "crowd_exponent",
            "resolution",
            "hub_damping",
            "relative_closeness",
            "neighbor_similarity",
            "consistency",
            "min_overlap_minutes",
            "session_cap_minutes"
        })
        {
            var value = Number(key);
            if (!double.IsFinite(value))
            {
                throw new ArgumentException(key + " must be finite");
            }

            Json[key] = Math.Max(0, value);
        }

        foreach (var key in new[]
        {
            "hub_damping",
            "relative_closeness",
            "neighbor_similarity",
            "consistency"
        })
        {
            Json[key] = Math.Min(1, Number(key));
        }

        Json["resolution"] = Math.Max(.01, Number("resolution"));
        foreach (var key in new[]
        {
            "min_encounters",
            "top_k",
            "max_nodes"
        })
        {
            Json[key] = Math.Max(0, (int)Number(key));
        }

        foreach (var key in new[]
        {
            "friends_only",
            "mutual_only",
            "crowd_correction",
            "include_isolates"
        })
        {
            Json[key] = Bool(key);
        }

        RequireChoice("weighting", "count", "time", "balanced", "days");
        RequireChoice("edge_selection", "union", "mutual");
        RequireChoice("crowd_mode", "visit", "concurrent");
        foreach (var key in new[]
        {
            "world_filter",
            "excluded_worlds",
            "excluded_visits"
        })
        {
            Json[key] = Text(key).Trim();
        }

        if (Json["group_hints"] is not JsonObject hints)
        {
            throw new ArgumentException("group_hints must map user IDs to group labels");
        }

        var normalizedHints = new JsonObject();
        foreach (var item in hints)
        {
            var label = item.Value?.ToString().Trim() ?? "";
            if (label.Length > 0)
            {
                normalizedHints[item.Key] = label;
            }
        }

        Json["group_hints"] = normalizedHints;
        // Validate exclusions even for an empty evidence window.
        _ = ExcludedVisits();
        Scoring = new ScoringOptions(
            Number("half_life_days") * GraphMath.Day, Bool("crowd_correction"),
            Number("crowd_exponent"), Number("session_cap_minutes"),
            Number("min_overlap_minutes"), Integer("min_encounters"),
            Number("min_minutes"), Text("weighting"));
    }

    public static JsonObject Defaults() => new()
    {
        ["days"] = 90,
        ["date_from"] = null,
        ["date_to"] = null,
        ["weighting"] = "balanced",
        ["min_encounters"] = 2,
        ["min_minutes"] = 2.0,
        ["half_life_days"] = 90.0,
        ["crowd_correction"] = true,
        ["crowd_exponent"] = .5,
        ["friends_only"] = true,
        ["mutual_only"] = false,
        ["top_k"] = 12,
        ["edge_selection"] = "union",
        ["max_nodes"] = 800,
        ["resolution"] = 1.0,
        ["include_isolates"] = false,
        ["as_of"] = null,
        ["hub_damping"] = 0.0,
        ["relative_closeness"] = 0.0,
        ["neighbor_similarity"] = 0.0,
        ["min_overlap_minutes"] = 0.0,
        ["session_cap_minutes"] = 0.0,
        ["consistency"] = 0.0,
        ["crowd_mode"] = "visit",
        ["world_filter"] = "",
        ["excluded_worlds"] = "",
        ["excluded_visits"] = "",
        ["group_hints"] = new JsonObject()
    };
    public double Number(string key) => double.Parse(Json[key]?.ToString() ?? "0", CultureInfo.InvariantCulture);
    public int Integer(string key) => (int)Number(key);
    public string Text(string key) => Json[key]?.ToString() ?? "";
    public bool Bool(string key)
    {
        var value = Json[key];
        if (value is null)
        {
            return false;
        }

        if (value is JsonValue scalar && scalar.TryGetValue<bool>(out var boolean))
        {
            return boolean;
        }

        if (double.TryParse(value.ToString(), CultureInfo.InvariantCulture, out var number))
        {
            return number != 0;
        }

        return value.ToString().Length > 0;
    }

    public string Hint(string id) => (Json["group_hints"] as JsonObject)?[id]?.ToString() ?? "";
    public bool NeedsNetwork => Number("hub_damping") != 0 || Number("relative_closeness") != 0 || Number("neighbor_similarity") != 0;

    private void RequireChoice(string key, params string[] choices)
    {
        if (!choices.Contains(Text(key), StringComparer.Ordinal))
        {
            throw new ArgumentException(key + " must be " + string.Join(", ", choices));
        }
    }

    public long[] ExcludedVisits()
    {
        var tokens = Text("excluded_visits").Replace(',', ' ').Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        try
        {
            return tokens.Select(token => long.Parse(token, CultureInfo.InvariantCulture)).Distinct().Order().ToArray();
        }
        catch (FormatException error)
        {
            throw new ArgumentException("excluded_visits must contain comma- or space-separated visit IDs", error);
        }
    }

    public TimeWindow Window()
    {
        var now = ParseDate(Json["as_of"]) ?? GraphMath.Now();
        var end = Math.Min(now, ParseDate(Json["date_to"], true) ?? now);
        var start = ParseDate(Json["date_from"]);
        start ??= Json["days"] is null ? 0 : end - Number("days") * GraphMath.Day;
        if (start >= end)
        {
            throw new ArgumentException("Date window must end after it starts");
        }

        return new TimeWindow(start.Value, end, now);
    }

    private static double? ParseDate(JsonNode? value, bool inclusiveEnd = false)
    {
        if (value is null || value.ToString() == "")
        {
            return null;
        }

        if (value.GetValueKind() == System.Text.Json.JsonValueKind.Number)
        {
            return double.Parse(value.ToString(), CultureInfo.InvariantCulture);
        }

        var text = value.ToString();
        var parsed = DateTimeOffset.Parse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
        var result = (parsed - DateTimeOffset.UnixEpoch).TotalSeconds;
        return result + (inclusiveEnd && text.Length == 10 ? GraphMath.Day : 0);
    }

    public string EvidenceKey()
    {
        var excluded = new HashSet<string>(StringComparer.Ordinal)
        {
            "top_k",
            "edge_selection",
            "max_nodes",
            "resolution",
            "include_isolates",
            "hub_damping",
            "relative_closeness",
            "neighbor_similarity",
            "consistency",
            "group_hints"
        };
        var settings = new JsonObject();
        foreach (var item in Json.OrderBy(item => item.Key, StringComparer.Ordinal))
        {
            if (!excluded.Contains(item.Key))
            {
                settings[item.Key] = item.Value?.DeepClone();
            }
        }

        return settings.ToJsonString();
    }

    // Changes to scoring and community controls share the same observed history.
    // Only these filters change which raw intervals and activity rows are loaded.
    public string WindowKey()
    {
        var filters = new JsonObject();
        foreach (var key in new[]
        {
            "days", "date_from", "date_to", "as_of", "friends_only",
            "world_filter", "excluded_worlds", "excluded_visits"
        })
        {
            filters[key] = Json[key]?.DeepClone();
        }
        return filters.ToJsonString();
    }
}

/// <summary>Immutable values read once, outside the parallel interval scoring loops.</summary>
internal sealed record ScoringOptions(
    double HalfLife, bool CrowdCorrection, double CrowdExponent, double SessionCap,
    double MinimumOverlap, int MinimumEncounters, double MinimumMinutes, string Weighting);
