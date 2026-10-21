#nullable enable

using System;
using System.Collections.Generic;
using System.Data.SQLite;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace VRCX.FriendsNetwork;

/// <summary>
/// One reusable history window. Large pair sets live in SQLite's temporary file,
/// rather than growing VRCX's database or retaining an unbounded managed array.
/// </summary>
internal sealed class NetworkWindow : IDisposable
{
    public SQLiteConnection Connection { get; }
    public TimeWindow Window { get; }
    public string Key { get; }
    private readonly Dictionary<string, Person> users = new(StringComparer.Ordinal);
    private readonly HashSet<(string, string)> mutuals = [];
    private readonly PairInterval[]? cachedIntervals;
    private Dictionary<long, CrowdTimeline>? concurrentCrowds;
    private const int MaximumCachedIntervals = 1_000_000;

    public NetworkWindow(string path, string key, GraphSettings settings, CancellationToken token)
    {
        Key = key;
        Window = settings.Window();
        Connection = NetworkSql.Open(path, readOnly: true);
        try
        {
            using var cancellation = new NetworkSqlCancellation(Connection, token);
            NetworkSql.Execute(Connection, "PRAGMA temp_store=FILE; PRAGMA cache_size=-16000;");
            ReadUsers(settings);
            ReadMutuals();
            PreparePresence(settings, token);
            ReadActivity(token);
            PreparePairs(token);
            using SQLiteCommand count = NetworkSql.Command(Connection, "SELECT COUNT(*) FROM network_window_pairs");
            if (Convert.ToInt64(count.ExecuteScalar()) <= MaximumCachedIntervals)
            {
                cachedIntervals = ReadPairs(token).ToArray();
            }
        }
        catch
        {
            Connection.Dispose();
            throw;
        }
    }

    private void ReadUsers(GraphSettings settings)
    {
        JsonObject metadata = NetworkSql.Metadata(Connection);
        var observers = (metadata["observer_ids"] as JsonArray ?? [])
            .Select(value => value!.ToString()).ToHashSet(StringComparer.Ordinal);
        using SQLiteCommand command = NetworkSql.Command(Connection,
            "SELECT id,name,is_friend,join_count,last_seen FROM mutual_network_users ORDER BY id");
        using SQLiteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            string id = reader.GetString(0);
            bool friend = reader.GetInt64(2) != 0;
            if (observers.Contains(id) || settings.Bool("friends_only") && !friend)
            {
                continue;
            }
            users.Add(id, new Person
            {
                Id = id,
                Name = reader.GetString(1),
                IsFriend = friend,
                JoinCount = reader.GetInt64(3),
                LastSeen = reader.IsDBNull(4) ? null : reader.GetDouble(4)
            });
        }
    }

    private void ReadMutuals()
    {
        using SQLiteCommand command = NetworkSql.Command(Connection,
            "SELECT user_a,user_b FROM mutual_network_mutuals");
        using SQLiteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            mutuals.Add((reader.GetString(0), reader.GetString(1)));
        }
    }

    private void PreparePresence(GraphSettings settings, CancellationToken token)
    {
        NetworkSql.Execute(Connection, """
            CREATE TEMP TABLE network_window_users (id TEXT PRIMARY KEY);
            CREATE TEMP TABLE network_window_visits (id INTEGER PRIMARY KEY, crowd INTEGER);
            """);
        using (SQLiteTransaction transaction = Connection.BeginTransaction())
        {
            using SQLiteCommand insert = NetworkSql.PreparedInsert(Connection, transaction,
                "INSERT INTO network_window_users VALUES ($id)", "$id");
            foreach (string id in users.Keys)
            {
                token.ThrowIfCancellationRequested();
                NetworkSql.Insert(insert, id);
            }
            transaction.Commit();
        }
        var excludedVisits = settings.ExcludedVisits().ToHashSet();
        string filter = settings.Text("world_filter");
        string[] excludedWorlds = settings.Text("excluded_worlds")
            .Split([',', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var visits = new List<long>();
        using (SQLiteCommand command = NetworkSql.Command(Connection, """
            SELECT id,location,world_name FROM mutual_network_visits
            WHERE end > $p0 AND start < $p1 ORDER BY id
            """, Window.Start, Window.End))
        {
            using SQLiteDataReader reader = command.ExecuteReader();
            while (reader.Read())
            {
                token.ThrowIfCancellationRequested();
                long id = reader.GetInt64(0);
                string world = reader.GetString(1) + " " + reader.GetString(2);
                if (excludedVisits.Contains(id) || filter.Length > 0 && !world.Contains(filter, StringComparison.OrdinalIgnoreCase)
                    || excludedWorlds.Any(excluded => world.Contains(excluded, StringComparison.OrdinalIgnoreCase)))
                {
                    continue;
                }
                visits.Add(id);
            }
        }
        using (SQLiteTransaction transaction = Connection.BeginTransaction())
        {
            using SQLiteCommand insert = NetworkSql.PreparedInsert(Connection, transaction,
                "INSERT INTO network_window_visits VALUES ($id, 2)", "$id");
            foreach (long id in visits)
            {
                token.ThrowIfCancellationRequested();
                NetworkSql.Insert(insert, id);
            }
            transaction.Commit();
        }
        // Crowd size includes non-friends, even when only friends are drawn.
        using (SQLiteCommand command = NetworkSql.Command(Connection, """
            UPDATE network_window_visits SET crowd = MAX(2, (
                SELECT COUNT(DISTINCT p.user_id) FROM mutual_network_presence p
                WHERE p.visit_id = network_window_visits.id AND p.end > $p0 AND p.start < $p1
            ));
            CREATE TEMP TABLE network_window_presence AS
                SELECT p.visit_id,p.user_id,MAX(p.start,$p0) AS start,MIN(p.end,$p1) AS end
                FROM mutual_network_presence p
                JOIN network_window_visits v ON v.id=p.visit_id
                JOIN network_window_users u ON u.id=p.user_id
                WHERE p.end > $p0 AND p.start < $p1;
            CREATE INDEX network_window_presence_visit ON network_window_presence(visit_id,user_id,start,end);
            """, Window.Start, Window.End))
        {
            command.ExecuteNonQuery();
        }
    }

    private void ReadActivity(CancellationToken token)
    {
        using SQLiteCommand command = NetworkSql.Command(Connection,
            "SELECT user_id,visit_id,start,end FROM network_window_presence ORDER BY user_id,visit_id,start");
        using SQLiteDataReader reader = command.ExecuteReader();
        string? previousUser = null;
        long previousVisit = -1;
        var days = new HashSet<long>();
        void FinishUser()
        {
            if (previousUser is not null)
            {
                users[previousUser].DistinctDays = days.Count;
                users[previousUser].DistinctWeeks = days.Select(GraphMath.Week).Distinct().Count();
            }
            days.Clear();
        }
        while (reader.Read())
        {
            token.ThrowIfCancellationRequested();
            string id = reader.GetString(0);
            long visit = reader.GetInt64(1);
            if (previousUser != id)
            {
                FinishUser();
                previousUser = id;
                previousVisit = -1;
            }
            if (previousVisit != visit)
            {
                users[id].Encounters++;
                previousVisit = visit;
            }
            double start = reader.GetDouble(2);
            double end = reader.GetDouble(3);
            users[id].Minutes += (end - start) / 60;
            days.UnionWith(GraphMath.Days(start, end));
        }
        FinishUser();
    }

    private void PreparePairs(CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        // Ordered insertion lets repeated scoring stream pairs by their sequence
        // without sorting a multi-gigabyte temporary result on every slider edit.
        NetworkSql.Execute(Connection, """
            CREATE TEMP TABLE network_window_pairs (
                sequence INTEGER PRIMARY KEY, a TEXT,b TEXT,visit_id INTEGER,start REAL,end REAL,crowd INTEGER
            );
            INSERT INTO network_window_pairs (a,b,visit_id,start,end,crowd)
                SELECT a.user_id,b.user_id,a.visit_id,MAX(a.start,b.start),MIN(a.end,b.end),v.crowd
                FROM network_window_presence a
                JOIN network_window_presence b ON a.visit_id=b.visit_id AND a.user_id < b.user_id
                    AND a.start < b.end AND b.start < a.end
                JOIN network_window_visits v ON v.id=a.visit_id
                ORDER BY a.user_id,b.user_id,a.visit_id,MAX(a.start,b.start),MIN(a.end,b.end);
            """);
    }

    private IEnumerable<PairInterval> ReadPairs(CancellationToken token)
    {
        using SQLiteCommand command = NetworkSql.Command(Connection,
            "SELECT a,b,visit_id,start,end,crowd FROM network_window_pairs ORDER BY sequence");
        using SQLiteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            token.ThrowIfCancellationRequested();
            yield return new PairInterval(reader.GetString(0), reader.GetString(1), reader.GetInt64(2),
                reader.GetDouble(3), reader.GetDouble(4), reader.GetInt32(5));
        }
    }

    public Evidence Score(GraphSettings settings, CancellationToken token)
    {
        var people = users.ToDictionary(pair => pair.Key, pair => pair.Value.Copy(), StringComparer.Ordinal);
        var links = new List<Connection>();
        var timelines = settings.Bool("crowd_correction") && settings.Text("crowd_mode") == "concurrent"
            ? concurrentCrowds ??= ReadConcurrentCrowds(token)
            : new Dictionary<long, CrowdTimeline>();
        int scanned = 0;
        IEnumerable<PairInterval> rows = cachedIntervals is null ? ReadPairs(token) : cachedIntervals;
        var options = new ParallelOptions
        {
            CancellationToken = token,
            MaxDegreeOfParallelism = Math.Max(1, Math.Min(8, Environment.ProcessorCount - 1))
        };
        foreach (List<PairInterval>[] batch in NetworkScoring.Consecutive(rows, row => (row.A, row.B)).Chunk(2048))
        {
            var results = new (Connection? Edge, int Scanned)[batch.Length];
            void ScorePair(int index)
            {
                token.ThrowIfCancellationRequested();
                PairInterval first = batch[index][0];
                bool mutual = mutuals.Contains((first.A, first.B));
                if (settings.Bool("mutual_only") && !mutual)
                {
                    return;
                }
                results[index] = NetworkScoring.ScorePair(batch[index], settings, Window, timelines);
                if (results[index].Edge is { } edge)
                {
                    edge.Mutual = mutual;
                }
            }
            if (batch.Length >= 256)
            {
                Parallel.For(0, batch.Length, options, ScorePair);
            }
            else
            {
                for (int index = 0; index < batch.Length; index++)
                {
                    ScorePair(index);
                }
            }
            foreach (var result in results)
            {
                scanned += result.Scanned;
                if (result.Edge is not null)
                {
                    links.Add(result.Edge);
                }
            }
        }
        return new Evidence(people, links, Window, scanned);
    }

    private Dictionary<long, CrowdTimeline> ReadConcurrentCrowds(CancellationToken token)
    {
        using SQLiteCommand command = NetworkSql.Command(Connection, """
            SELECT p.visit_id,MAX(p.start,$p0),MIN(p.end,$p1)
            FROM mutual_network_presence p JOIN network_window_visits v ON v.id=p.visit_id
            WHERE p.end > $p0 AND p.start < $p1 ORDER BY p.visit_id,p.start,p.end
            """, Window.Start, Window.End);
        using SQLiteDataReader reader = command.ExecuteReader();
        var result = new Dictionary<long, CrowdTimeline>();
        var changes = new SortedDictionary<double, int>();
        long previousVisit = -1;
        void FinishVisit()
        {
            if (changes.Count == 0)
            {
                return;
            }
            double[] boundaries = changes.Keys.ToArray();
            int count = 0;
            int index = 0;
            int[] counts = new int[changes.Count];
            foreach (int change in changes.Values)
            {
                count += change;
                counts[index++] = count;
            }
            result.Add(previousVisit, new CrowdTimeline(boundaries, counts));
            changes.Clear();
        }
        while (reader.Read())
        {
            token.ThrowIfCancellationRequested();
            long visit = reader.GetInt64(0);
            if (visit != previousVisit)
            {
                FinishVisit();
                previousVisit = visit;
            }
            double start = reader.GetDouble(1);
            double end = reader.GetDouble(2);
            changes[start] = changes.GetValueOrDefault(start) + 1;
            changes[end] = changes.GetValueOrDefault(end) - 1;
        }
        FinishVisit();
        return result;
    }

    public void Dispose() => Connection.Dispose();
}
