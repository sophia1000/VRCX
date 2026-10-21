using System.Data.SQLite;
using System.Text.Json.Nodes;
using VRCX.FriendsNetwork;
using Xunit;

namespace VRCX.Tests.FriendsNetwork;

public class FriendsNetworkTests
{
    [Fact]
    public void RollbackJournalImportAllowsExistingClientWritesAndRemovesItsPrivateSnapshot()
    {
        using var fixture = new NetworkFixture();
        using (SQLiteConnection setup = NetworkSql.Open(fixture.Path, readOnly: false))
        {
            NetworkSql.Execute(setup, "PRAGMA journal_mode=DELETE");
        }
        bool wroteDuringImport = false;
        NetworkSource.EnsureCache(fixture.Path, NetworkSource.AllAccounts, rebuild: true,
            (stage, _, _) =>
            {
                if (stage != "visits")
                {
                    return;
                }
                using SQLiteConnection oldClient = NetworkSql.Open(fixture.Path, readOnly: false);
                using SQLiteCommand command = NetworkSql.Command(oldClient,
                    "INSERT INTO unrelated_settings VALUES ('during-import','logging remains available')");
                command.CommandTimeout = 1;
                command.ExecuteNonQuery();
                wroteDuringImport = true;
            }, CancellationToken.None);
        Assert.True(wroteDuringImport);
        string pattern = "." + Path.GetFileNameWithoutExtension(fixture.Path) + ".mutual-network-snapshot-*";
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(fixture.Path)!, pattern));
    }

    [Fact]
    public void CancelledRollbackJournalImportRemovesItsPrivateSnapshot()
    {
        using var fixture = new NetworkFixture();
        using (SQLiteConnection setup = NetworkSql.Open(fixture.Path, readOnly: false))
        {
            NetworkSql.Execute(setup, "PRAGMA journal_mode=DELETE");
        }
        using var cancellation = new CancellationTokenSource();
        Assert.Throws<OperationCanceledException>(() =>
            NetworkSource.EnsureCache(fixture.Path, NetworkSource.AllAccounts, rebuild: true,
                (stage, _, _) =>
                {
                    if (stage == "visits")
                    {
                        cancellation.Cancel();
                    }
                }, cancellation.Token));
        string pattern = "." + Path.GetFileNameWithoutExtension(fixture.Path) + ".mutual-network-snapshot-*";
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(fixture.Path)!, pattern));
    }

    [Theory]
    [InlineData("2026-10-21T00:00:00Z")]
    [InlineData("2026-10-21T00:00:00.1234567Z")]
    [InlineData("2026-10-21 00:00:00.123")]
    public void TimestampPrecisionUsesUtcWithoutCultureDependentParsing(string timestamp)
    {
        Assert.NotNull(NetworkSql.Epoch(timestamp));
        Assert.Null(NetworkSql.Epoch("10/11/2026"));
        Assert.Null(ImportIdentityIndex.CanonicalUser("usr_00000000-0000-0000-0000-000000000000"));
    }

    [Fact]
    public async Task RejoinsInOneVisitCountOneEncounterAndOnlyTheOverlappingSegments()
    {
        using var fixture = new NetworkFixture();
        fixture.AddVisit(3, "2026-10-03T00:00:00Z", "rejoin-test", 3600);
        fixture.AddSpan(3, NetworkFixture.Alice, "Alice", 0, 10);
        fixture.AddSpan(3, NetworkFixture.Alice, "Alice", 20, 30);
        fixture.AddSpan(3, NetworkFixture.Bob, "Bob", 0, 30);
        JsonObject graph = await fixture.Graph(new JsonObject { ["world_filter"] = "rejoin-test" });
        Assert.Null(graph["error"]);
        JsonNode link = Assert.Single(graph["links"]!.AsArray())!;
        Assert.Equal(1, link["encounters"]!.GetValue<int>());
        Assert.Equal(20, link["minutes"]!.GetValue<double>(), 6);
    }

    [Fact]
    public async Task ConcurrentCrowdCorrectionDoesNotCountPeopleWhoArrivedLater()
    {
        using var fixture = new NetworkFixture();
        var settings = new JsonObject
        {
            ["world_filter"] = "world-one", ["crowd_correction"] = true, ["weighting"] = "time"
        };
        JsonObject visit = await fixture.Graph(settings);
        double wholeVisitWeight = Assert.Single(visit["links"]!.AsArray())!["weight"]!.GetValue<double>();
        settings["crowd_mode"] = "concurrent";
        JsonObject concurrent = await fixture.Graph(settings);
        double concurrentWeight = Assert.Single(concurrent["links"]!.AsArray())!["weight"]!.GetValue<double>();
        Assert.Equal(15 / Math.Sqrt(2), wholeVisitWeight, 6);
        Assert.Equal(15, concurrentWeight, 6);
    }

    [Fact]
    public async Task AllAccountsUsesRealOverlapAndExcludesEveryObserver()
    {
        using var fixture = new NetworkFixture();
        fixture.AddEvent(1, NetworkFixture.Alice, "Alice", 5, "OnPlayerJoined", 0);
        JsonObject graph = await fixture.Graph();
        Assert.Null(graph["error"]);
        JsonArray links = graph["links"]!.AsArray();
        JsonObject link = Assert.Single(links)!.AsObject();
        Assert.Equal(2, link["encounters"]!.GetValue<int>());
        Assert.Equal(35, link["minutes"]!.GetValue<double>(), 6);
        Assert.True(link["mutual"]!.GetValue<bool>());
        Assert.Equal(2, graph["accounts"]!.AsArray().Count);
        string[] ids = graph["nodes"]!.AsArray().Select(node => node!["id"]!.ToString()).ToArray();
        Assert.Contains(NetworkFixture.Alice, ids);
        Assert.Contains(NetworkFixture.Bob, ids);
        Assert.DoesNotContain(NetworkFixture.Owner, ids);
        Assert.DoesNotContain(NetworkFixture.Alt, ids);
    }

    [Fact]
    public async Task ExistingDataAndDatabaseVersionRemainReadableAndUnchanged()
    {
        using var fixture = new NetworkFixture();
        string before = fixture.ExistingData();
        Assert.Null((await fixture.Graph())["error"]);
        Assert.Null((await fixture.Graph(new JsonObject { ["top_k"] = 3 }, rebuild: true))["error"]);
        Assert.Equal(before, fixture.ExistingData());
        using SQLiteConnection oldClient = NetworkSql.Open(fixture.Path, readOnly: false);
        using SQLiteCommand version = NetworkSql.Command(oldClient, "PRAGMA user_version");
        Assert.Equal(42L, Convert.ToInt64(version.ExecuteScalar()));
        NetworkSql.Execute(oldClient, "INSERT INTO unrelated_settings VALUES ('old-client','still works')");
        using SQLiteCommand read = NetworkSql.Command(oldClient, "SELECT value FROM unrelated_settings WHERE key='old-client'");
        Assert.Equal("still works", read.ExecuteScalar());
    }

    [Fact]
    public async Task SingleAccountCanBeSelectedWithoutDuplicatingSharedHistory()
    {
        using var fixture = new NetworkFixture();
        JsonObject first = await fixture.Graph(new JsonObject { ["account_ids"] = new JsonArray(NetworkFixture.Owner) });
        Assert.Empty(first["links"]!.AsArray());
        JsonObject all = await fixture.Graph();
        Assert.Equal(35, Assert.Single(all["links"]!.AsArray())!["minutes"]!.GetValue<double>(), 6);
        JsonObject people = JsonNode.Parse(await fixture.Service.PeopleAsync())!.AsObject();
        Assert.Contains(people["users"]!.AsArray(), person => person!["id"]!.ToString() == NetworkFixture.Cara);
    }

    [Fact]
    public async Task DateClippingAndMinimumPerVisitUseActualMinutes()
    {
        using var fixture = new NetworkFixture();
        JsonObject clipped = await fixture.Graph(new JsonObject
        {
            ["date_from"] = "2026-10-01T00:15:00Z", ["date_to"] = "2026-10-01T00:20:00Z"
        });
        Assert.Null(clipped["error"]);
        Assert.Equal(5, Assert.Single(clipped["links"]!.AsArray())!["minutes"]!.GetValue<double>(), 6);
        JsonObject minimum = await fixture.Graph(new JsonObject { ["min_overlap_minutes"] = 20 });
        JsonNode link = Assert.Single(minimum["links"]!.AsArray())!;
        Assert.Equal(1, link["encounters"]!.GetValue<int>());
        Assert.Equal(20, link["minutes"]!.GetValue<double>(), 6);
    }

    [Fact]
    public async Task WorldFiltersAndWarmScoringDoNotRewriteSourceLogs()
    {
        using var fixture = new NetworkFixture();
        string before = fixture.ExistingData();
        JsonObject filtered = await fixture.Graph(new JsonObject { ["world_filter"] = "WORLD-TWO", ["weighting"] = "time" });
        Assert.Null(filtered["error"]);
        JsonNode link = Assert.Single(filtered["links"]!.AsArray())!;
        Assert.Equal(20, link["weight"]!.GetValue<double>(), 6);
        JsonObject count = await fixture.Graph(new JsonObject { ["world_filter"] = "WORLD-TWO", ["weighting"] = "count" });
        Assert.Equal(1, Assert.Single(count["links"]!.AsArray())!["weight"]!.GetValue<double>(), 6);
        Assert.Equal(before, fixture.ExistingData());
    }

    [Fact]
    public async Task OptOutInAnySnapshotSuppressesMutualFlagButRetainsObservedEvidence()
    {
        using var fixture = new NetworkFixture();
        using (SQLiteConnection connection = NetworkSql.Open(fixture.Path, readOnly: false))
        {
            using SQLiteCommand command = NetworkSql.Command(connection,
                $"INSERT INTO {NetworkFixture.Prefix(NetworkFixture.Alt)}_mutual_graph_meta VALUES ($p0,1)", NetworkFixture.Bob);
            command.ExecuteNonQuery();
        }
        JsonObject graph = await fixture.Graph();
        Assert.False(Assert.Single(graph["links"]!.AsArray())!["mutual"]!.GetValue<bool>());
        JsonObject mutualOnly = await fixture.Graph(new JsonObject { ["mutual_only"] = true });
        Assert.Empty(mutualOnly["links"]!.AsArray());
    }

    [Fact]
    public async Task CancelledPublicationPreservesThePreviousCompleteCache()
    {
        using var fixture = new NetworkFixture();
        JsonObject graph = await fixture.Graph();
        Assert.Null(graph["error"]);
        string generation;
        using (SQLiteConnection connection = NetworkSql.Open(fixture.Path, readOnly: true))
        {
            generation = NetworkSql.Metadata(connection)["generation"]!.ToString();
        }
        using var cancellation = new CancellationTokenSource();
        Assert.Throws<OperationCanceledException>(() => NetworkSource.EnsureCache(fixture.Path, "all", true,
            (stage, _, _) => { if (stage == "publishing") { cancellation.Cancel(); } }, cancellation.Token));
        using SQLiteConnection after = NetworkSql.Open(fixture.Path, readOnly: true);
        Assert.Equal(generation, NetworkSql.Metadata(after)["generation"]!.ToString());
        Assert.Empty(Directory.GetFiles(System.IO.Path.GetDirectoryName(fixture.Path)!, ".mutual-network-stage-*.sqlite3"));
    }

    [Fact]
    public async Task AStaleNativeRevisionCannotReplaceANewerRequest()
    {
        using var fixture = new NetworkFixture();
        Assert.Null((await fixture.Graph())["error"]);
        JsonObject stale = JsonNode.Parse(await fixture.Service.GraphAsync("{\"_revision\":1}"))!.AsObject();
        Assert.True(stale["cancelled"]!.GetValue<bool>());
        Assert.Null(stale["nodes"]);
    }
}
