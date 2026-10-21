#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace VRCX.FriendsNetwork;

internal sealed record SourceAccount(string Id, string Prefix, long FriendCount, long MutualCount)
{
    public JsonObject ToJson() => new()
    {
        ["id"] = Id,
        ["prefix"] = Prefix,
        ["label"] = Id,
        ["friend_count"] = FriendCount,
        ["mutual_count"] = MutualCount,
    };
}

internal sealed class ImportedUser(string id, string name)
{
    public string Id { get; } = id;
    public string Name { get; set; } = name;
    public int IsFriend { get; set; }
    public long JoinCount { get; set; }
    public double? LastSeen { get; set; }
    public double NameAt { get; set; } = double.NegativeInfinity;
}

internal sealed class ImportedVisit(
    long id, double start, double end, bool knownDuration, string location, string worldName)
{
    public long Id { get; } = id;
    public double Start { get; } = start;
    public double End { get; set; } = end;
    public bool KnownDuration { get; } = knownDuration;
    public string Location { get; } = location;
    public string WorldName { get; } = worldName;
    public double LatestObservation { get; set; } = start;
    public double NextVisitStart { get; set; } = double.PositiveInfinity;
}

internal sealed record SourceEvent(
    string? Timestamp, string? Type, string? Name, string? Location,
    string? UserId, double DurationSeconds);

/// <summary>Resolve names only after collecting all explicit identity evidence.</summary>
internal sealed class ImportIdentityIndex
{
    private static readonly Regex UserPattern = new(
        @"\Ausr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public Dictionary<string, ImportedUser> Users { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, HashSet<string>> Aliases { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> CurrentNames { get; } = new(StringComparer.Ordinal);

    public static string? CanonicalUser(string? value) =>
        value is not null && value != "usr_00000000-0000-0000-0000-000000000000"
        && UserPattern.IsMatch(value) ? value.ToLowerInvariant() : null;

    public string? Remember(
        string? rawUserId, string? name, double? seen = null,
        bool friend = false, bool observed = true)
    {
        string? userId = CanonicalUser(rawUserId);
        if (userId is null)
        {
            return null;
        }

        string displayName = name ?? "";
        if (!Users.TryGetValue(userId, out ImportedUser? user))
        {
            user = new ImportedUser(userId, displayName.Length > 0 ? displayName : userId);
            Users.Add(userId, user);
        }
        if (displayName.Length > 0)
        {
            RememberAlias(displayName, userId);
            double nameAt = seen ?? double.NegativeInfinity;
            if (nameAt >= user.NameAt)
            {
                user.Name = displayName;
                user.NameAt = nameAt;
            }
        }
        if (seen.HasValue && observed)
        {
            user.LastSeen = Math.Max(user.LastSeen ?? seen.Value, seen.Value);
        }
        if (friend)
        {
            user.IsFriend = 1;
        }
        return userId;
    }

    public void RememberAlias(string name, string userId)
    {
        if (!Aliases.TryGetValue(name, out HashSet<string>? candidates))
        {
            candidates = new HashSet<string>(StringComparer.Ordinal);
            Aliases.Add(name, candidates);
        }
        candidates.Add(userId);
    }

    public string? Resolve(string? rawUserId, string? name)
    {
        string? explicitId = CanonicalUser(rawUserId);
        if (explicitId is not null)
        {
            return explicitId;
        }
        return name is not null && Aliases.TryGetValue(name, out HashSet<string>? candidates)
            && candidates.Count == 1 ? candidates.First() : null;
    }

    public void PreferCurrentNames()
    {
        foreach ((string userId, string name) in CurrentNames)
        {
            Users[userId].Name = name;
        }
    }
}

/// <summary>Locate the observer visit active at a recorded event time.</summary>
internal sealed class ImportVisitIndex(List<ImportedVisit> visits)
{
    public List<ImportedVisit> Visits { get; } = visits;
    public Dictionary<long, ImportedVisit> ById { get; } = visits.ToDictionary(visit => visit.Id);

    public ImportedVisit? Find(double timestamp, string? location)
    {
        // Upper-bound search chooses the last visit when several share a start time.
        int low = 0;
        int high = Visits.Count;
        while (low < high)
        {
            int middle = low + (high - low) / 2;
            if (Visits[middle].Start <= timestamp)
            {
                low = middle + 1;
            }
            else
            {
                high = middle;
            }
        }
        if (low == 0)
        {
            return null;
        }

        ImportedVisit visit = Visits[low - 1];
        // Known durations allow log rounding. Unknown durations cannot span an offline gap.
        double matchingEnd = visit.KnownDuration
            ? visit.End + 2
            : Math.Min(visit.NextVisitStart, visit.Start + NetworkSource.MaxInferredTailSeconds);
        return visit.Location == location && timestamp <= matchingEnd ? visit : null;
    }
}

internal sealed class ImportQuality
{
    public long UnresolvedEvents { get; set; }
    public long AmbiguousNames { get; set; }
    public long InvalidTimestamps { get; set; }
    public long UnmatchedEvents { get; set; }
    public long DuplicateEvents { get; set; }
    public long InferredIntervals { get; set; }
    public long MissingDurationVisits { get; set; }

    public JsonObject ToJson() => new()
    {
        ["unresolved_events"] = UnresolvedEvents,
        ["ambiguous_names"] = AmbiguousNames,
        ["invalid_timestamps"] = InvalidTimestamps,
        ["unmatched_events"] = UnmatchedEvents,
        ["duplicate_events"] = DuplicateEvents,
        ["inferred_intervals"] = InferredIntervals,
        ["missing_duration_visits"] = MissingDurationVisits,
        ["tail_cap_seconds"] = NetworkSource.MaxInferredTailSeconds,
    };
}

internal readonly record struct PresenceKey(long VisitId, string UserId);
internal readonly record struct PresenceSpan(double Start, double End, int Inferred);
internal readonly record struct ImportedPresence(
    long VisitId, string UserId, double Start, double End, int Inferred);

/// <summary>Clip and union a person's spans before calculating any pair overlaps.</summary>
internal sealed class ImportPresenceIntervals(IReadOnlySet<string> observerIds)
{
    private readonly Dictionary<PresenceKey, List<PresenceSpan>> spans = [];

    public void Add(ImportedVisit visit, string userId, double start, double end, bool inferred)
    {
        start = Math.Max(start, visit.Start);
        end = Math.Min(end, visit.End);
        if (observerIds.Contains(userId) || end <= start)
        {
            return;
        }
        var key = new PresenceKey(visit.Id, userId);
        if (!spans.TryGetValue(key, out List<PresenceSpan>? userSpans))
        {
            userSpans = [];
            spans.Add(key, userSpans);
        }
        userSpans.Add(new PresenceSpan(start, end, inferred ? 1 : 0));
    }

    public IEnumerable<ImportedPresence> MergedRows(ImportQuality quality)
    {
        foreach ((PresenceKey key, List<PresenceSpan> userSpans) in spans)
        {
            var merged = new List<PresenceSpan>();
            foreach (PresenceSpan span in userSpans.OrderBy(span => span.Start)
                         .ThenBy(span => span.End).ThenBy(span => span.Inferred))
            {
                if (merged.Count > 0 && span.Start <= merged[^1].End)
                {
                    PresenceSpan previous = merged[^1];
                    merged[^1] = new PresenceSpan(
                        previous.Start, Math.Max(previous.End, span.End),
                        previous.Inferred != 0 || span.Inferred != 0 ? 1 : 0);
                }
                else
                {
                    merged.Add(span);
                }
            }
            foreach (PresenceSpan span in merged)
            {
                if (span.Inferred != 0)
                {
                    quality.InferredIntervals++;
                }
                yield return new ImportedPresence(
                    key.VisitId, key.UserId, span.Start, span.End, span.Inferred);
            }
        }
    }
}
