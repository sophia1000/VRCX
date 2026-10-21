#nullable enable

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Data.SQLite;

namespace VRCX.FriendsNetwork;

internal sealed record NetworkDataset(
    ImportIdentityIndex Identities, ImportVisitIndex Visits, ImportPresenceIntervals Presence,
    HashSet<(string First, string Second)> Mutuals, ImportQuality Quality,
    List<SourceAccount> Accounts, HashSet<string> Observers, string Fingerprint);

/// <summary>Reconstruct permitted game logs without using VRCX's shared connection.</summary>
internal static class NetworkSource
{
    public const int CacheVersion = 1;
    public const string AllAccounts = "all";
    public const int MaxInferredTailSeconds = 4 * 3600;
    private static readonly Regex AccountPattern = new(
        @"\A(usr[0-9a-f]{32})_(?:friend_log_current|friend_log_history|mutual_graph_links|mutual_graph_meta)\z",
        RegexOptions.CultureInvariant);
    private const string LocationQuery = """
        SELECT id, created_at, location, world_name, time
        FROM gamelog_location
        ORDER BY created_at, id
        """;
    private const string EventQuery = """
        SELECT id, created_at, type, display_name, location, user_id, time
        FROM gamelog_join_leave
        ORDER BY created_at, id
        """;
    private const string Schema = """
        CREATE TABLE IF NOT EXISTS mutual_network_users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            is_friend INTEGER NOT NULL DEFAULT 0,
            join_count INTEGER NOT NULL DEFAULT 0,
            last_seen REAL
        );
        CREATE TABLE IF NOT EXISTS mutual_network_visits (
            id INTEGER PRIMARY KEY,
            start REAL NOT NULL,
            end REAL NOT NULL,
            location TEXT NOT NULL,
            world_name TEXT
        );
        CREATE TABLE IF NOT EXISTS mutual_network_presence (
            visit_id INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            start REAL NOT NULL,
            end REAL NOT NULL,
            inferred INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (visit_id) REFERENCES mutual_network_visits(id),
            FOREIGN KEY (user_id) REFERENCES mutual_network_users(id),
            UNIQUE (visit_id, user_id, start, end)
        );
        CREATE INDEX IF NOT EXISTS mutual_network_presence_visit ON mutual_network_presence(visit_id, start, end);
        CREATE INDEX IF NOT EXISTS mutual_network_presence_user ON mutual_network_presence(user_id, start);
        CREATE TABLE IF NOT EXISTS mutual_network_mutuals (
            user_a TEXT NOT NULL,
            user_b TEXT NOT NULL,
            PRIMARY KEY (user_a, user_b)
        );
        CREATE TABLE IF NOT EXISTS mutual_network_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """;

    /// <summary>
    /// Build in a private staging file first. Publication changes only this feature's
    /// tables in one transaction, so cancellation leaves the previous cache usable.
    /// </summary>
    public static JsonObject EnsureCache(string path, string account, bool rebuild,
        Action<string, double, string> report, CancellationToken token)
    {
        // Check the inexpensive cache signature before making a private import copy.
        // WAL databases already allow logging alongside the normal read snapshot.
        if (!rebuild)
        {
            using var probe = new NetworkReadSnapshot(path, token);
            HashSet<string> tables = ReadTables(probe);
            if (!tables.Contains("gamelog_location") || !tables.Contains("gamelog_join_leave"))
            {
                throw new InvalidOperationException("VRCX game log tables are not available yet.");
            }
            List<SourceAccount> selected = SelectAccounts(ReadAccounts(probe, tables), account);
            string fingerprint = Fingerprint(probe, tables, selected, token);
            JsonObject existing = NetworkSql.Metadata(probe.Connection);
            if (existing["version"]?.ToString() == CacheVersion.ToString(CultureInfo.InvariantCulture)
                && existing["fingerprint"]?.ToString() == fingerprint
                && existing["account"]?.ToString() == account)
            {
                return existing;
            }
        }
        NetworkDataset dataset;
        using (var source = new NetworkReadSnapshot(path, token, privateCopy: true))
        {
            HashSet<string> tables = ReadTables(source);
            if (!tables.Contains("gamelog_location") || !tables.Contains("gamelog_join_leave"))
            {
                throw new InvalidOperationException("VRCX game log tables are not available yet.");
            }
            List<SourceAccount> available = ReadAccounts(source, tables);
            List<SourceAccount> selected = SelectAccounts(available, account);
            string fingerprint = Fingerprint(source, tables, selected, token);
            JsonObject existing = NetworkSql.Metadata(source.Connection);
            if (!rebuild && existing["version"]?.ToString() == CacheVersion.ToString(CultureInfo.InvariantCulture)
                && existing["fingerprint"]?.ToString() == fingerprint
                && existing["account"]?.ToString() == account)
            {
                return existing;
            }
            var quality = new ImportQuality();
            var identities = new ImportIdentityIndex();
            foreach (SourceAccount selectedAccount in selected)
            {
                ReadFriends(source, selectedAccount.Prefix, tables, identities, token);
            }
            var observers = available.Select(item => item.Id).ToHashSet(StringComparer.Ordinal);
            report("visits", .05, "Reading observed instance visits");
            ImportVisitIndex visits = ReadVisits(source, quality, token);
            long events = source.Count("gamelog_join_leave");
            ScanIdentities(source, identities, visits, quality, events, report, token);
            ImportPresenceIntervals presence = ReconstructPresence(source, identities, visits,
                quality, observers, events, report, token);
            var mutuals = ReadMutuals(source, selected, tables, identities, observers, token);
            dataset = new NetworkDataset(identities, visits, presence, mutuals, quality,
                available, observers, fingerprint);
        }

        string stagingPath = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(path))!,
            ".mutual-network-stage-" + Guid.NewGuid().ToString("N") + ".sqlite3");
        try
        {
            SQLiteConnection.CreateFile(stagingPath);
            JsonObject metadata;
            using (SQLiteConnection staging = NetworkSql.Open(stagingPath, readOnly: false))
            {
                NetworkSql.Execute(staging, Schema);
                using SQLiteTransaction transaction = staging.BeginTransaction();
                report("cache", .82, "Preparing the observed connections cache");
                WriteRecords(staging, transaction, dataset.Identities, dataset.Visits,
                    dataset.Presence, dataset.Mutuals, dataset.Quality, token);
                metadata = new JsonObject
                {
                    ["version"] = CacheVersion,
                    ["fingerprint"] = dataset.Fingerprint,
                    ["account"] = account,
                    ["generation"] = Guid.NewGuid().ToString("N"),
                    ["built_at"] = DateTimeOffset.UtcNow.ToString("O"),
                    ["accounts"] = new JsonArray(dataset.Accounts.Select(item => (JsonNode?)new JsonObject
                    {
                        ["id"] = item.Id,
                        ["name"] = dataset.Identities.Users.GetValueOrDefault(item.Id)?.Name ?? item.Id
                    }).ToArray()),
                    ["observer_ids"] = new JsonArray(dataset.Observers.Order(StringComparer.Ordinal)
                        .Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
                    ["quality"] = dataset.Quality.ToJson()
                };
                WriteMetadata(staging, transaction, metadata, token);
                token.ThrowIfCancellationRequested();
                transaction.Commit();
            }
            Publish(path, stagingPath, report, token);
            return metadata;
        }
        finally
        {
            File.Delete(stagingPath);
        }
    }

    private static string Fingerprint(NetworkReadSnapshot source, HashSet<string> tables,
        List<SourceAccount> accounts, CancellationToken token)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        void Append(string value) => hash.AppendData(Encoding.UTF8.GetBytes(value.Length + ":" + value));
        foreach (string table in new[] { "gamelog_location", "gamelog_join_leave" })
        {
            // Counts also detect pruning; duration totals detect updates to an open
            // visit whose row ID does not change while VRChat is running.
            using SQLiteCommand command = source.Command(
                $"SELECT COUNT(*), MAX(id), MAX(created_at), TOTAL(time) FROM \"{table}\"");
            using SQLiteDataReader reader = command.ExecuteReader();
            reader.Read();
            for (int column = 0; column < reader.FieldCount; column++)
            {
                Append(NetworkSql.Text(reader, column) ?? "");
            }
        }
        foreach (SourceAccount account in accounts)
        {
            Append(account.Id);
            foreach (string suffix in new[] { "friend_log_current", "friend_log_history", "mutual_graph_links", "mutual_graph_meta" })
            {
                string table = account.Prefix + "_" + suffix;
                if (!tables.Contains(table))
                {
                    continue;
                }
                Append(table);
                using SQLiteCommand command = source.Command($"SELECT * FROM \"{table}\" ORDER BY rowid");
                using SQLiteDataReader reader = command.ExecuteReader();
                while (reader.Read())
                {
                    token.ThrowIfCancellationRequested();
                    for (int column = 0; column < reader.FieldCount; column++)
                    {
                        Append(NetworkSql.Text(reader, column) ?? "");
                    }
                }
            }
        }
        return Convert.ToHexString(hash.GetHashAndReset());
    }

    private static void Publish(string path, string stagingPath,
        Action<string, double, string> report, CancellationToken token)
    {
        using SQLiteConnection target = NetworkSql.Open(path, readOnly: false);
        using var cancellation = new NetworkSqlCancellation(target, token);
        using (SQLiteCommand attach = NetworkSql.Command(target, "ATTACH DATABASE $p0 AS network_stage", stagingPath))
        {
            attach.ExecuteNonQuery();
        }
        using SQLiteTransaction transaction = target.BeginTransaction();
        NetworkSql.Execute(target, Schema);
        report("publishing", .95, "Publishing the prepared cache");
        foreach (string table in new[] { "presence", "mutuals", "visits", "users", "meta" })
        {
            token.ThrowIfCancellationRequested();
            NetworkSql.Execute(target, $"DELETE FROM mutual_network_{table}");
        }
        foreach (string table in new[] { "users", "visits", "presence", "mutuals", "meta" })
        {
            token.ThrowIfCancellationRequested();
            NetworkSql.Execute(target, $"INSERT INTO mutual_network_{table} SELECT * FROM network_stage.mutual_network_{table}");
        }
        token.ThrowIfCancellationRequested();
        transaction.Commit();
    }


    private static HashSet<string> ReadTables(NetworkReadSnapshot source)
    {
        var tables = new HashSet<string>(StringComparer.Ordinal);
        using SQLiteCommand command = source.Command("SELECT name FROM sqlite_master WHERE type='table'");
        using SQLiteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            tables.Add(reader.GetString(0));
        }
        return tables;
    }

    private static List<SourceAccount> ReadAccounts(NetworkReadSnapshot source, HashSet<string> tables)
    {
        var accounts = new List<SourceAccount>();
        var prefixes = new HashSet<string>(StringComparer.Ordinal);
        foreach (string table in tables.Order(StringComparer.Ordinal))
        {
            Match match = AccountPattern.Match(table);
            if (!match.Success)
            {
                continue;
            }
            string prefix = match.Groups[1].Value;
            if (!prefixes.Add(prefix))
            {
                continue;
            }
            string rawId = prefix[3..];
            string accountId = $"usr_{rawId[..8]}-{rawId[8..12]}-{rawId[12..16]}-{rawId[16..20]}-{rawId[20..]}";
            string mutualTable = prefix + "_mutual_graph_links";
            string friendsTable = prefix + "_friend_log_current";
            accounts.Add(new SourceAccount(accountId, prefix,
                tables.Contains(friendsTable) ? source.Count(friendsTable) : 0,
                tables.Contains(mutualTable) ? source.Count(mutualTable) : 0));
        }
        return accounts.OrderByDescending(account => account.MutualCount)
            .ThenByDescending(account => account.FriendCount)
            .ThenBy(account => account.Id, StringComparer.Ordinal).ToList();
    }

    private static List<SourceAccount> SelectAccounts(List<SourceAccount> accounts, string? account)
    {
        if (string.IsNullOrWhiteSpace(account) || account == AllAccounts)
        {
            return accounts;
        }
        var selected = accounts.FirstOrDefault(candidate => candidate.Id == account || candidate.Prefix == account)
            ?? throw new ArgumentException("The selected account is not present in this VRCX database");
        return [selected];
    }

    private static void ReadFriends(
        NetworkReadSnapshot source, string? prefix, HashSet<string> tables,
        ImportIdentityIndex identities, CancellationToken cancellationToken)
    {
        if (prefix is null)
        {
            return;
        }
        string historyTable = prefix + "_friend_log_history";
        if (tables.Contains(historyTable))
        {
            var columns = new HashSet<string>(StringComparer.Ordinal);
            using (SQLiteCommand schema = source.Command($"PRAGMA table_info(\"{historyTable}\")"))
            {
                using SQLiteDataReader schemaReader = schema.ExecuteReader();
                while (schemaReader.Read())
                {
                    columns.Add(schemaReader.GetString(1));
                }
            }
            string previousName = columns.Contains("previous_display_name") ? "previous_display_name" : "NULL";
            using SQLiteCommand history = source.Command($"""
                SELECT created_at, user_id, display_name, {previousName}
                FROM "{historyTable}"
                """);
            using SQLiteDataReader reader = history.ExecuteReader();
            while (reader.Read())
            {
                cancellationToken.ThrowIfCancellationRequested();
                string? userId = identities.Remember(NetworkSql.Text(reader, 1), NetworkSql.Text(reader, 2),
                    NetworkSql.Epoch(NetworkSql.Text(reader, 0)), observed: false);
                string? oldName = NetworkSql.Text(reader, 3);
                if (!string.IsNullOrEmpty(oldName) && userId is not null)
                {
                    identities.RememberAlias(oldName, userId);
                }
            }
        }
        if (!tables.Contains(prefix + "_friend_log_current"))
        {
            return;
        }
        using SQLiteCommand current = source.Command(
            $"SELECT user_id, display_name FROM \"{prefix}_friend_log_current\"");
        using SQLiteDataReader currentReader = current.ExecuteReader();
        while (currentReader.Read())
        {
            cancellationToken.ThrowIfCancellationRequested();
            string? rawUserId = NetworkSql.Text(currentReader, 0);
            string? name = NetworkSql.Text(currentReader, 1);
            string? userId = identities.Remember(rawUserId, name, friend: true);
            if (userId is not null)
            {
                // Accounts are ordered by snapshot coverage. Prefer the first current
                // name while still collecting aliases from every selected snapshot.
                identities.CurrentNames.TryAdd(userId, string.IsNullOrEmpty(name) ? rawUserId! : name);
            }
        }
    }

    private static ImportVisitIndex ReadVisits(
        NetworkReadSnapshot source, ImportQuality quality, CancellationToken cancellationToken)
    {
        var visits = new List<ImportedVisit>();
        using SQLiteCommand command = source.Command(LocationQuery);
        using SQLiteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            cancellationToken.ThrowIfCancellationRequested();
            double? start = NetworkSql.Epoch(NetworkSql.Text(reader, 1));
            if (!start.HasValue)
            {
                quality.InvalidTimestamps++;
                continue;
            }
            string? location = NetworkSql.Text(reader, 2);
            if (string.IsNullOrEmpty(location) || location is "traveling" or "offline" or "private")
            {
                continue;
            }
            double seconds = NetworkSql.Duration(reader, 4);
            visits.Add(new ImportedVisit(reader.GetInt64(0), start.Value, start.Value + seconds,
                seconds > 0, location, NetworkSql.Text(reader, 3) ?? ""));
        }
        visits = visits.OrderBy(visit => visit.Start).ThenBy(visit => visit.Id).ToList();
        for (int index = 0; index < visits.Count; index++)
        {
            ImportedVisit visit = visits[index];
            if (index + 1 < visits.Count)
            {
                visit.NextVisitStart = visits[index + 1].Start;
            }
            if (visit.KnownDuration)
            {
                visit.End = Math.Min(visit.End, visit.NextVisitStart);
            }
            else
            {
                quality.MissingDurationVisits++;
            }
        }
        return new ImportVisitIndex(visits);
    }

    private static IEnumerable<SourceEvent> ReadEvents(NetworkReadSnapshot source)
    {
        using SQLiteCommand command = source.Command(EventQuery);
        using SQLiteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            yield return new SourceEvent(
                NetworkSql.Text(reader, 1), NetworkSql.Text(reader, 2), NetworkSql.Text(reader, 3),
                NetworkSql.Text(reader, 4), NetworkSql.Text(reader, 5), NetworkSql.Duration(reader, 6));
        }
    }

    private static void ScanIdentities(
        NetworkReadSnapshot source, ImportIdentityIndex identities, ImportVisitIndex visits,
        ImportQuality quality, long totalEvents, Action<string, double, string> report,
        CancellationToken cancellationToken)
    {
        long index = 0;
        foreach (SourceEvent entry in ReadEvents(source))
        {
            cancellationToken.ThrowIfCancellationRequested();
            double? observedAt = NetworkSql.Epoch(entry.Timestamp);
            identities.Remember(entry.UserId, entry.Name, observedAt);
            if (observedAt.HasValue)
            {
                ImportedVisit? visit = visits.Find(observedAt.Value, entry.Location);
                if (visit is not null)
                {
                    visit.LatestObservation = Math.Max(visit.LatestObservation, observedAt.Value);
                }
            }
            if (index % 10000 == 0)
            {
                report("identities", 0.12 + 0.26 * index / Math.Max(totalEvents, 1),
                    "Resolving stable user IDs and historical names");
            }
            index++;
        }
        foreach (ImportedVisit visit in visits.Visits)
        {
            if (!visit.KnownDuration)
            {
                visit.End = visit.LatestObservation;
            }
        }
        quality.AmbiguousNames = identities.Aliases.Values.Count(candidates => candidates.Count > 1);
    }

    private static ImportPresenceIntervals ReconstructPresence(
        NetworkReadSnapshot source, ImportIdentityIndex identities, ImportVisitIndex visits,
        ImportQuality quality, IReadOnlySet<string> observerIds, long totalEvents,
        Action<string, double, string> report, CancellationToken cancellationToken)
    {
        var intervals = new ImportPresenceIntervals(observerIds);
        var active = new Dictionary<PresenceKey, double>();
        string? previousTimestamp = null;
        var signatures = new HashSet<(string Type, string UserId, string? Location)>();
        long index = -1;
        foreach (SourceEvent entry in ReadEvents(source))
        {
            index++;
            cancellationToken.ThrowIfCancellationRequested();
            double? timestamp = NetworkSql.Epoch(entry.Timestamp);
            if (!timestamp.HasValue)
            {
                quality.InvalidTimestamps++;
                continue;
            }
            if (entry.Type is not ("OnPlayerJoined" or "OnPlayerLeft"))
            {
                continue;
            }
            string? userId = identities.Resolve(entry.UserId, entry.Name);
            if (userId is null)
            {
                quality.UnresolvedEvents++;
                continue;
            }
            double observedAt = timestamp.Value;
            identities.Remember(userId, entry.Name, observedAt);
            if (entry.Timestamp != previousTimestamp)
            {
                previousTimestamp = entry.Timestamp;
                signatures.Clear();
            }
            if (!signatures.Add((entry.Type, userId, entry.Location)))
            {
                quality.DuplicateEvents++;
                continue;
            }
            ImportedVisit? visit = visits.Find(observedAt, entry.Location);
            if (entry.Type == "OnPlayerJoined")
            {
                if (visit is not null && active.ContainsKey(new PresenceKey(visit.Id, userId)))
                {
                    quality.DuplicateEvents++;
                    continue;
                }
                identities.Users[userId].JoinCount++;
            }
            if (visit is null)
            {
                quality.UnmatchedEvents++;
                continue;
            }
            var key = new PresenceKey(visit.Id, userId);
            if (entry.Type == "OnPlayerJoined")
            {
                active[key] = observedAt;
            }
            else
            {
                bool joined = active.Remove(key, out double start);
                if (!joined)
                {
                    if (entry.DurationSeconds <= 0)
                    {
                        continue;
                    }
                    start = observedAt - entry.DurationSeconds;
                }
                intervals.Add(visit, userId, start, observedAt, inferred: !joined);
            }
            if (index % 10000 == 0)
            {
                report("presence", 0.4 + 0.4 * index / Math.Max(totalEvents, 1),
                    "Reconstructing bounded presence intervals");
            }
        }
        foreach ((PresenceKey key, double start) in active)
        {
            ImportedVisit visit = visits.ById[key.VisitId];
            intervals.Add(visit, key.UserId, start,
                Math.Min(visit.End, start + MaxInferredTailSeconds), inferred: true);
        }
        return intervals;
    }

    private static HashSet<(string First, string Second)> ReadMutuals(
        NetworkReadSnapshot source, List<SourceAccount> accounts, HashSet<string> tables,
        ImportIdentityIndex identities, IReadOnlySet<string> observerIds, CancellationToken cancellationToken)
    {
        var mutuals = new HashSet<(string First, string Second)>();
        var optedOut = new HashSet<string>(StringComparer.Ordinal);
        // Read all selected opt-outs before combining edges. A stale snapshot
        // from another account must not reintroduce an opted-out person's links.
        foreach (var account in accounts)
        {
            if (!tables.Contains(account.Prefix + "_mutual_graph_meta"))
            {
                continue;
            }
            using SQLiteCommand metadata = source.Command(
                $"SELECT friend_id FROM \"{account.Prefix}_mutual_graph_meta\" WHERE opted_out != 0");
            using SQLiteDataReader reader = metadata.ExecuteReader();
            while (reader.Read())
            {
                cancellationToken.ThrowIfCancellationRequested();
                string? userId = NetworkSql.Text(reader, 0);
                if (userId is not null)
                {
                    optedOut.Add(userId);
                }
            }
        }
        foreach (var account in accounts)
        {
            if (!tables.Contains(account.Prefix + "_mutual_graph_links"))
            {
                continue;
            }
            using SQLiteCommand links = source.Command(
                $"SELECT friend_id, mutual_id FROM \"{account.Prefix}_mutual_graph_links\"");
            using SQLiteDataReader linkReader = links.ExecuteReader();
            while (linkReader.Read())
            {
                cancellationToken.ThrowIfCancellationRequested();
                string? firstId = ImportIdentityIndex.CanonicalUser(NetworkSql.Text(linkReader, 0));
                string? secondId = ImportIdentityIndex.CanonicalUser(NetworkSql.Text(linkReader, 1));
                if (firstId is null || secondId is null || firstId == secondId
                    || observerIds.Contains(firstId) || observerIds.Contains(secondId)
                    || optedOut.Contains(firstId) || optedOut.Contains(secondId))
                {
                    continue;
                }
                identities.Remember(firstId, null);
                identities.Remember(secondId, null);
                mutuals.Add(string.CompareOrdinal(firstId, secondId) < 0
                    ? (firstId, secondId) : (secondId, firstId));
            }
        }
        return mutuals;
    }

    private static void WriteRecords(
        SQLiteConnection target, SQLiteTransaction transaction, ImportIdentityIndex identities,
        ImportVisitIndex visits, ImportPresenceIntervals intervals,
        HashSet<(string First, string Second)> mutuals, ImportQuality quality,
        CancellationToken cancellationToken)
    {
        identities.PreferCurrentNames();
        using SQLiteCommand users = NetworkSql.PreparedInsert(target, transaction,
            "INSERT INTO mutual_network_users VALUES ($id, $name, $friend, $joins, $seen)",
            "$id", "$name", "$friend", "$joins", "$seen");
        foreach (ImportedUser user in identities.Users.Values)
        {
            cancellationToken.ThrowIfCancellationRequested();
            NetworkSql.Insert(users, user.Id, user.Name, user.IsFriend, user.JoinCount, user.LastSeen);
        }
        using SQLiteCommand locations = NetworkSql.PreparedInsert(target, transaction,
            "INSERT INTO mutual_network_visits VALUES ($id, $start, $end, $location, $world)",
            "$id", "$start", "$end", "$location", "$world");
        foreach (ImportedVisit visit in visits.Visits)
        {
            cancellationToken.ThrowIfCancellationRequested();
            NetworkSql.Insert(locations, visit.Id, visit.Start, visit.End, visit.Location, visit.WorldName);
        }
        using SQLiteCommand presence = NetworkSql.PreparedInsert(target, transaction,
            "INSERT INTO mutual_network_presence VALUES ($visit, $user, $start, $end, $inferred)",
            "$visit", "$user", "$start", "$end", "$inferred");
        foreach (ImportedPresence span in intervals.MergedRows(quality))
        {
            cancellationToken.ThrowIfCancellationRequested();
            NetworkSql.Insert(presence, span.VisitId, span.UserId, span.Start, span.End, span.Inferred);
        }
        using SQLiteCommand cachedLinks = NetworkSql.PreparedInsert(target, transaction,
            "INSERT INTO mutual_network_mutuals VALUES ($first, $second)", "$first", "$second");
        foreach ((string first, string second) in mutuals.OrderBy(pair => pair.First, StringComparer.Ordinal)
                     .ThenBy(pair => pair.Second, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            NetworkSql.Insert(cachedLinks, first, second);
        }
    }

    private static void WriteMetadata(
        SQLiteConnection target, SQLiteTransaction transaction,
        JsonObject metadata, CancellationToken cancellationToken)
    {
        using SQLiteCommand command = NetworkSql.PreparedInsert(target, transaction,
            "INSERT INTO mutual_network_meta VALUES ($key, $value)", "$key", "$value");
        foreach ((string key, JsonNode? value) in metadata)
        {
            cancellationToken.ThrowIfCancellationRequested();
            NetworkSql.Insert(command, key, value?.ToJsonString() ?? "null");
        }
    }

}
