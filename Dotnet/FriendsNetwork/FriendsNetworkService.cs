#nullable enable

using System;
using System.Data.SQLite;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace VRCX.FriendsNetwork;

/// <summary>
/// Feature boundary for native requests. A single background gate owns the reusable
/// window; a separate short lock protects cancellation and progress notifications.
/// </summary>
internal sealed class FriendsNetworkService(Func<string> databasePath) : IDisposable
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly object stateLock = new();
    private CancellationTokenSource? active;
    private long latestRevision;
    private NetworkWindow? window;
    private Evidence? scoredEvidence;
    private string scoreKey = "";
    private string cachedPath = "";
    private string cachedAccount = "";
    private DateTime nextSourceCheck = DateTime.MinValue;
    private JsonObject metadata = new();
    private JsonObject status = new() { ["busy"] = false, ["stage"] = "idle", ["progress"] = 0 };
    private bool disposed;

    public Task<string> GraphAsync(string json, bool rebuild = false)
    {
        JsonObject input;
        try
        {
            input = JsonNode.Parse(json) as JsonObject
                ?? throw new ArgumentException("Friends network settings must be a JSON object.");
        }
        catch (Exception error) when (error is ArgumentException or System.Text.Json.JsonException)
        {
            return Task.FromResult(Error(error));
        }
        CancellationTokenSource request;
        lock (stateLock)
        {
            if (disposed)
            {
                return Task.FromResult("{\"cancelled\":true}");
            }
            long revision = long.TryParse(input["_revision"]?.ToString(), out long supplied)
                ? supplied : latestRevision + 1;
            if (revision <= latestRevision)
            {
                return Task.FromResult("{\"cancelled\":true}");
            }
            latestRevision = revision;
            active?.Cancel();
            active = request = new CancellationTokenSource();
            status = new JsonObject { ["busy"] = true, ["stage"] = "waiting", ["progress"] = 0 };
        }
        return Task.Run(async () =>
        {
            bool entered = false;
            try
            {
                await gate.WaitAsync(request.Token).ConfigureAwait(false);
                entered = true;
                request.Token.ThrowIfCancellationRequested();
                return BuildGraph(input, rebuild, request.Token).ToJsonString();
            }
            catch (OperationCanceledException)
            {
                return "{\"cancelled\":true}";
            }
            catch (SQLiteException) when (request.IsCancellationRequested)
            {
                return "{\"cancelled\":true}";
            }
            catch (Exception error)
            {
                return Error(error);
            }
            finally
            {
                if (entered)
                {
                    gate.Release();
                }
                lock (stateLock)
                {
                    if (ReferenceEquals(active, request))
                    {
                        active = null;
                        status["busy"] = false;
                    }
                }
                request.Dispose();
            }
        });
    }

    private JsonObject BuildGraph(JsonObject input, bool rebuild, CancellationToken token)
    {
        string path = databasePath();
        string account = SelectedAccount(input);
        var settings = new GraphSettings(input);
        // A minute is well below the history controls' resolution. Holding it stable
        // lets scoring and display changes reuse one exact clipped history window.
        settings.Json["as_of"] ??= JsonValue.Create(Math.Floor(GraphMath.Now() / 60) * 60);
        if (path != cachedPath || account != cachedAccount || rebuild || DateTime.UtcNow >= nextSourceCheck)
        {
            Report("checking", 0, "Checking the history cache");
            JsonObject next = NetworkSource.EnsureCache(path, account, rebuild, Report, token);
            if (path != cachedPath || metadata["generation"]?.ToString() != next["generation"]?.ToString())
            {
                window?.Dispose();
                window = null;
                scoredEvidence = null;
            }
            metadata = next;
            cachedPath = path;
            cachedAccount = account;
            nextSourceCheck = DateTime.UtcNow.AddSeconds(30);
        }
        string windowKey = WindowKey(settings);
        if (window is null || window.Key != windowKey)
        {
            window?.Dispose();
            window = null;
            scoredEvidence = null;
            Report("overlaps", .1, "Finding actual overlapping presence");
            window = new NetworkWindow(path, windowKey, settings, token);
        }
        using var cancellation = new NetworkSqlCancellation(window.Connection, token);
        string nextScoreKey = settings.EvidenceKey();
        if (scoredEvidence is null || scoreKey != nextScoreKey)
        {
            Report("scoring", .55, "Scoring independent connections");
            Evidence evidence = window.Score(settings, token);
            token.ThrowIfCancellationRequested();
            scoredEvidence = evidence;
            scoreKey = nextScoreKey;
        }
        Evidence scored = scoredEvidence.Copy();
        int eligibleNodes = scored.Users.Count;
        int eligibleEdges = scored.Links.Count;
        GraphPresentation.AdjustScores(scored.Users, scored.Links, settings, token);
        var (users, links, hidden) = GraphPresentation.Prune(scored.Users, scored.Links, settings, token);
        Report("communities", .85, "Separating weighted friend groups");
        var labels = CommunityDetector.Detect(users.Keys, links, settings.Number("resolution"), token);
        double maximum = links.Count == 0 ? 1 : links.Max(edge => edge.Weight);
        foreach (Connection edge in links)
        {
            edge.Strength = Math.Sqrt(edge.Weight / maximum);
        }
        JsonArray communities = GraphPresentation.Communities(users, labels);
        JsonArray subcommunities = GraphPresentation.Annotate(users, links, labels, settings, token);
        token.ThrowIfCancellationRequested();
        JsonObject stats = scored.Stats();
        stats["eligible_nodes"] = eligibleNodes;
        stats["eligible_edges"] = eligibleEdges;
        stats["hidden_isolates"] = hidden;
        stats["cache_built_at"] = metadata["built_at"]?.DeepClone();
        Report("ready", 1, "Graph ready");
        return new JsonObject
        {
            ["nodes"] = new JsonArray(users.Values.Select(user => (JsonNode?)user.ToJson()).ToArray()),
            ["links"] = new JsonArray(links.Select(edge => (JsonNode?)edge.ToJson()).ToArray()),
            ["communities"] = communities,
            ["subcommunities"] = subcommunities,
            ["accounts"] = metadata["accounts"]?.DeepClone(),
            ["stats"] = stats,
            ["settings"] = settings.Json.DeepClone(),
            ["quality"] = metadata["quality"]?.DeepClone()
        };
    }

    private static string SelectedAccount(JsonObject input)
    {
        if (input["account_ids"] is not JsonArray ids || ids.Count == 0)
        {
            return NetworkSource.AllAccounts;
        }
        if (ids.Count != 1 || ImportIdentityIndex.CanonicalUser(ids[0]?.ToString()) is not { } account)
        {
            throw new ArgumentException("Select all accounts or one valid account ID.");
        }
        return account;
    }

    private static string WindowKey(GraphSettings settings) => new JsonArray(new[]
    {
        "days", "date_from", "date_to", "as_of", "friends_only", "world_filter", "excluded_worlds", "excluded_visits"
    }.Select(key => settings.Json[key]?.DeepClone()).ToArray()).ToJsonString();

    public string Status()
    {
        lock (stateLock)
        {
            return status.ToJsonString();
        }
    }

    private void Report(string stage, double progress, string message)
    {
        lock (stateLock)
        {
            status["stage"] = stage;
            status["progress"] = progress;
            status["message"] = message;
            status["accounts"] = metadata["accounts"]?.DeepClone();
        }
    }

    public void Cancel()
    {
        lock (stateLock)
        {
            active?.Cancel();
        }
    }

    public Task<string> PeopleAsync() => Task.Run(async () =>
    {
        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (disposed || cachedPath.Length == 0)
            {
                return "{\"users\":[]}";
            }
            using SQLiteConnection connection = NetworkSql.Open(cachedPath, readOnly: true);
            using SQLiteCommand command = NetworkSql.Command(connection,
                "SELECT id,name,is_friend,join_count FROM mutual_network_users ORDER BY name,id");
            using SQLiteDataReader reader = command.ExecuteReader();
            var users = new JsonArray();
            while (reader.Read())
            {
                users.Add(new JsonObject
                {
                    ["id"] = reader.GetString(0), ["name"] = reader.GetString(1),
                    ["is_friend"] = reader.GetInt64(2) != 0, ["join_count"] = reader.GetInt64(3)
                });
            }
            return new JsonObject { ["users"] = users }.ToJsonString();
        }
        catch (Exception error)
        {
            return Error(error);
        }
        finally
        {
            gate.Release();
        }
    });

    private static string Error(Exception error) => new JsonObject { ["error"] = error.Message }.ToJsonString();

    public void Dispose()
    {
        lock (stateLock)
        {
            disposed = true;
            active?.Cancel();
        }
        gate.Wait();
        try
        {
            window?.Dispose();
            window = null;
            scoredEvidence = null;
        }
        finally
        {
            gate.Release();
        }
    }
}
