using System.Data.SQLite;
using System.Text.Json;
using System.Text.Json.Nodes;
using VRCX.FriendsNetwork;

namespace VRCX.Tests.FriendsNetwork;

internal sealed class NetworkFixture : IDisposable
{
    public const string Owner = "usr_11111111-1111-1111-1111-111111111111";
    public const string Alt = "usr_22222222-2222-2222-2222-222222222222";
    public const string Alice = "usr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    public const string Bob = "usr_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    public const string Cara = "usr_cccccccc-cccc-cccc-cccc-cccccccccccc";
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "vrcx-network-" + Guid.NewGuid().ToString("N") + ".sqlite3");
    public FriendsNetworkService Service { get; }
    private long eventId;
    private long revision;

    public NetworkFixture()
    {
        SQLiteConnection.CreateFile(Path);
        using SQLiteConnection connection = NetworkSql.Open(Path, readOnly: false);
        NetworkSql.Execute(connection, """
            PRAGMA journal_mode=WAL;
            PRAGMA user_version=42;
            CREATE TABLE gamelog_location (id INTEGER PRIMARY KEY,created_at TEXT,location TEXT,world_name TEXT,time REAL);
            CREATE TABLE gamelog_join_leave (id INTEGER PRIMARY KEY,created_at TEXT,type TEXT,display_name TEXT,location TEXT,user_id TEXT,time REAL);
            CREATE TABLE unrelated_settings (key TEXT PRIMARY KEY,value TEXT);
            INSERT INTO unrelated_settings VALUES ('theme','midnight');
            """);
        AddAccount(Owner, [(Alice, "Alice"), (Cara, "Cara"), (Alt, "Alt")]);
        AddAccount(Alt, [(Bob, "Bob"), (Cara, "Cara"), (Owner, "Owner")]);
        AddVisit(1, "2026-10-01T00:00:00Z", "world-one", 3600);
        AddVisit(2, "2026-10-02T00:00:00Z", "world-two", 3600);
        AddSpan(1, Alice, "Alice", 5, 25);
        AddSpan(1, Bob, "Bob", 10, 30);
        AddSpan(1, Cara, "Cara", 40, 50);
        AddSpan(1, Owner, "Owner", 0, 60);
        AddSpan(1, Alt, "Alt", 0, 60);
        AddSpan(2, Alice, "Alice", 0, 20);
        AddSpan(2, Bob, "Bob", 0, 20);
        using SQLiteCommand mutual = NetworkSql.Command(connection,
            $"INSERT INTO {Prefix(Owner)}_mutual_graph_links VALUES ($p0,$p1)", Alice, Bob);
        mutual.ExecuteNonQuery();
        Service = new FriendsNetworkService(() => Path);
    }

    public static string Prefix(string id) => id.Replace("_", "").Replace("-", "");

    public void AddAccount(string owner, (string Id, string Name)[] friends)
    {
        using SQLiteConnection connection = NetworkSql.Open(Path, readOnly: false);
        string prefix = Prefix(owner);
        NetworkSql.Execute(connection, $"""
            CREATE TABLE {prefix}_friend_log_current (user_id TEXT PRIMARY KEY,display_name TEXT);
            CREATE TABLE {prefix}_friend_log_history (created_at TEXT,user_id TEXT,display_name TEXT,previous_display_name TEXT);
            CREATE TABLE {prefix}_mutual_graph_links (friend_id TEXT,mutual_id TEXT,PRIMARY KEY(friend_id,mutual_id));
            CREATE TABLE {prefix}_mutual_graph_meta (friend_id TEXT PRIMARY KEY,opted_out INTEGER);
            """);
        foreach (var friend in friends)
        {
            using SQLiteCommand command = NetworkSql.Command(connection,
                $"INSERT INTO {prefix}_friend_log_current VALUES ($p0,$p1)", friend.Id, friend.Name);
            command.ExecuteNonQuery();
        }
    }

    public void AddVisit(long id, string start, string world, double seconds)
    {
        using SQLiteConnection connection = NetworkSql.Open(Path, readOnly: false);
        using SQLiteCommand command = NetworkSql.Command(connection,
            "INSERT INTO gamelog_location VALUES ($p0,$p1,$p2,$p3,$p4)", id, start, world + ":instance", world, seconds * 1000);
        command.ExecuteNonQuery();
    }

    public void AddSpan(long visit, string user, string name, double startMinute, double endMinute)
    {
        AddEvent(visit, user, name, startMinute, "OnPlayerJoined", 0);
        AddEvent(visit, user, name, endMinute, "OnPlayerLeft", (endMinute - startMinute) * 60000);
    }

    public void AddEvent(long visit, string? user, string name, double minute, string type, double duration)
    {
        using SQLiteConnection connection = NetworkSql.Open(Path, readOnly: false);
        using SQLiteCommand location = NetworkSql.Command(connection, "SELECT created_at,location FROM gamelog_location WHERE id=$p0", visit);
        string start;
        string world;
        using (SQLiteDataReader reader = location.ExecuteReader())
        {
            reader.Read();
            start = reader.GetString(0);
            world = reader.GetString(1);
        }
        string timestamp = DateTimeOffset.Parse(start).AddMinutes(minute).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
        using SQLiteCommand command = NetworkSql.Command(connection,
            "INSERT INTO gamelog_join_leave VALUES ($p0,$p1,$p2,$p3,$p4,$p5,$p6)",
            ++eventId, timestamp, type, name, world, user, duration);
        command.ExecuteNonQuery();
    }

    public Task<JsonObject> Graph(JsonObject? changes = null, bool rebuild = false) => ReadGraph(changes, rebuild);

    private async Task<JsonObject> ReadGraph(JsonObject? changes, bool rebuild)
    {
        var settings = new JsonObject
        {
            ["_revision"] = ++revision, ["days"] = null, ["as_of"] = "2026-10-21T00:00:00Z",
            ["min_encounters"] = 1, ["min_minutes"] = 0, ["half_life_days"] = 0,
            ["crowd_correction"] = false, ["top_k"] = 0, ["max_nodes"] = 0
        };
        if (changes is not null)
        {
            foreach (var pair in changes)
            {
                settings[pair.Key] = pair.Value?.DeepClone();
            }
        }
        return JsonNode.Parse(await Service.GraphAsync(settings.ToJsonString(), rebuild))!.AsObject();
    }

    public string ExistingData()
    {
        using SQLiteConnection connection = NetworkSql.Open(Path, readOnly: true);
        var tables = new List<string>();
        using (SQLiteCommand command = NetworkSql.Command(connection,
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'mutual_network_%' ORDER BY name"))
        {
            using SQLiteDataReader reader = command.ExecuteReader();
            while (reader.Read())
            {
                tables.Add(reader.GetString(0));
            }
        }
        var result = new JsonObject();
        foreach (string table in tables)
        {
            using SQLiteCommand command = NetworkSql.Command(connection, $"SELECT * FROM \"{table}\" ORDER BY rowid");
            using SQLiteDataReader reader = command.ExecuteReader();
            var rows = new List<object[]>();
            while (reader.Read())
            {
                var values = new object[reader.FieldCount];
                reader.GetValues(values);
                rows.Add(values);
            }
            result[table] = JsonSerializer.SerializeToNode(rows);
        }
        return result.ToJsonString();
    }

    public void Dispose()
    {
        Service.Dispose();
        SQLiteConnection.ClearAllPools();
        File.Delete(Path);
        File.Delete(Path + "-wal");
        File.Delete(Path + "-shm");
    }
}
