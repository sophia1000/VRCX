#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Text.Json.Nodes;

namespace VRCX.FriendsNetwork;

internal static class GraphPresentation
{
    public static void AdjustScores(Dictionary<string, Person> users, List<Connection> links, GraphSettings settings,
        CancellationToken cancellationToken = default)
    {
        var consistencySetting = settings.Number("consistency");
        var hubSetting = settings.Number("hub_damping");
        var relativeSetting = settings.Number("relative_closeness");
        var similaritySetting = settings.Number("neighbor_similarity");
        foreach (var edge in links)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var consistency = 1 + consistencySetting * Math.Log2(Math.Max(1, edge.DistinctWeeks));
            edge.Weight = edge.BaseWeight * consistency;
            edge.ScoreFactors = new JsonObject
            {
                ["consistency"] = consistency,
                ["hub_damping"] = 1.0,
                ["relative_closeness"] = 1.0,
                ["neighbor_similarity"] = 1.0,
                ["group_hint"] = 1.0
            };
        }

        var adjacency = settings.NeedsNetwork ? CommunityDetector.Adjacency(users.Keys, links) : [];
        var degrees = adjacency.ToDictionary(pair => pair.Key, pair => pair.Value.Count, StringComparer.Ordinal);
        var positiveDegrees = degrees.Values.Where(degree => degree > 0).Order().ToList();
        var typicalDegree = MedianDegree(positiveDegrees);
        var squared = adjacency.ToDictionary(
            pair => pair.Key,
            pair => CommunityDetector.SequentialSum(pair.Value.Values.Select(weight => weight * weight)),
            StringComparer.Ordinal);
        foreach (var edge in links)
        {
            cancellationToken.ThrowIfCancellationRequested();
            double hub = 1, relative = 1, similarityFactor = 1, hint = 1;
            if (hubSetting != 0)
            {
                var ratio = Math.Max(1, degrees[edge.Source] / typicalDegree) * Math.Max(1, degrees[edge.Target] / typicalDegree);
                hub = Math.Pow(ratio, -hubSetting / 2);
            }

            if (relativeSetting != 0)
            {
                var total = Math.Sqrt(users[edge.Source].Minutes * users[edge.Target].Minutes);
                relative = Math.Pow(total != 0 ? Math.Min(1, edge.Minutes / total) : 0, relativeSetting);
            }

            if (similaritySetting != 0)
            {
                var sourceNeighbors = adjacency[edge.Source];
                var targetNeighbors = adjacency[edge.Target];
                var common = sourceNeighbors.Keys.Intersect(targetNeighbors.Keys, StringComparer.Ordinal).Order(StringComparer.Ordinal);
                var numerator = CommunityDetector.SequentialSum(common.Select(id => sourceNeighbors[id] * targetNeighbors[id]));
                var sourceNorm = Math.Max(0, squared[edge.Source] - edge.Weight * edge.Weight);
                var targetNorm = Math.Max(0, squared[edge.Target] - edge.Weight * edge.Weight);
                var denominator = Math.Sqrt(sourceNorm * targetNorm);
                similarityFactor = 1 + similaritySetting * (denominator != 0 ? Math.Min(1, numerator / denominator) : 0);
            }

            if (settings.Hint(edge.Source).Length > 0 && settings.Hint(edge.Source) == settings.Hint(edge.Target))
            {
                hint = 1.1;
            }

            edge.ScoreFactors!["hub_damping"] = hub;
            edge.ScoreFactors["relative_closeness"] = relative;
            edge.ScoreFactors["neighbor_similarity"] = similarityFactor;
            edge.ScoreFactors["group_hint"] = hint;
            edge.Weight = edge.Weight * hub * relative * similarityFactor * hint;
        }
    }

    public static HashSet<string> Connected(IEnumerable<Connection> links)
    {
        var connected = new HashSet<string>(StringComparer.Ordinal);
        foreach (var edge in links)
        {
            connected.Add(edge.Source);
            connected.Add(edge.Target);
        }
        return connected;
    }
    public static (Dictionary<string, Person> Users, List<Connection> Links, int Hidden) Prune(
        Dictionary<string, Person> users,
        List<Connection> links,
        GraphSettings settings, CancellationToken cancellationToken = default)
    {
        var degrees = users.Keys.ToDictionary(id => id, _ => 0.0, StringComparer.Ordinal);
        foreach (var edge in links)
        {
            cancellationToken.ThrowIfCancellationRequested();
            degrees[edge.Source] += edge.Weight;
            degrees[edge.Target] += edge.Weight;
        }

        var order = users.Keys
            .OrderByDescending(id => degrees[id])
            .ThenByDescending(id => users[id].Encounters)
            .ThenBy(id => users[id].Name.ToLowerInvariant(), StringComparer.Ordinal)
            .ThenBy(id => id, StringComparer.Ordinal)
            .ToList();
        var limit = settings.Integer("max_nodes");
        if (limit != 0)
        {
            order = order.Take(limit).ToList();
        }

        var kept = order.ToHashSet(StringComparer.Ordinal);
        links = links.Where(edge => kept.Contains(edge.Source) && kept.Contains(edge.Target)).ToList();
        if (settings.Integer("top_k") != 0)
        {
            var ranked = Enumerable.Range(0, links.Count)
                .OrderByDescending(index => links[index].Weight)
                .ThenBy(index => links[index].Source, StringComparer.Ordinal)
                .ThenBy(index => links[index].Target, StringComparer.Ordinal);
            var chosen = new Dictionary<string, int>(StringComparer.Ordinal);
            var votes = new int[links.Count];
            foreach (var index in ranked)
            {
                cancellationToken.ThrowIfCancellationRequested();
                foreach (var id in new[]
                {
                    links[index].Source,
                    links[index].Target
                })
                {
                    if (chosen.GetValueOrDefault(id) < settings.Integer("top_k"))
                    {
                        chosen[id] = chosen.GetValueOrDefault(id) + 1;
                        votes[index]++;
                    }
                }
            }

            var required = settings.Text("edge_selection") == "mutual" ? 2 : 1;
            links = links.Where((_, index) => votes[index] >= required).ToList();
        }

        var hidden = 0;
        if (!settings.Bool("include_isolates"))
        {
            var connected = Connected(links);
            hidden = kept.Count(id => !connected.Contains(id));
            order = order.Where(connected.Contains).ToList();
        }

        return (order.ToDictionary(id => id, id => users[id], StringComparer.Ordinal), links, hidden);
    }

    public static JsonArray Communities(Dictionary<string, Person> users, Dictionary<string, int> labels)
    {
        foreach (var user in users.Values)
        {
            user.Community = labels[user.Id];
        }

        var result = new JsonArray();
        foreach (var group in users.Values.GroupBy(user => labels[user.Id]).OrderBy(group => group.Key))
        {
            result.Add(new JsonObject
            {
                ["id"] = group.Key,
                ["size"] = group.Count(),
                ["label"] = Label(group)
            });
        }

        return result;
    }

    public static JsonArray Annotate(Dictionary<string, Person> users, List<Connection> links, Dictionary<string, int> labels,
        GraphSettings settings, CancellationToken cancellationToken = default)
    {
        var adjacency = CommunityDetector.Adjacency(users.Keys, links);
        var strengths = adjacency.ToDictionary(pair => pair.Key, pair => CommunityDetector.SequentialSum(pair.Value.Values), StringComparer.Ordinal);
        var strongest = strengths.Count == 0 ? 0 : strengths.Values.Max();
        foreach (var user in users.Values)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var weights = new Dictionary<int, double>();
            foreach (var neighbor in adjacency[user.Id])
            {
                weights[labels[neighbor.Key]] = weights.GetValueOrDefault(labels[neighbor.Key]) + neighbor.Value;
            }

            var total = strengths[user.Id];
            user.Memberships = new JsonArray();
            if (total != 0)
            {
                foreach (var community in weights.OrderByDescending(pair => pair.Value).ThenBy(pair => pair.Key))
                {
                    user.Memberships.Add(new JsonObject
                    {
                        ["community"] = community.Key,
                        ["score"] = community.Value / total
                    });
                }

                user.BridgeScore = Math.Clamp(1 - weights.GetValueOrDefault(labels[user.Id]) / total, 0, 1);
            }
            else
            {
                user.Memberships.Add(new JsonObject
                {
                    ["community"] = labels[user.Id],
                    ["score"] = 1.0
                });
                user.BridgeScore = 0;
            }

            user.ConnectionScore = strongest != 0 ? total / strongest : 0;
            user.GroupHint = settings.Hint(user.Id);
        }

        var internalLinks = links
            .Where(edge => labels[edge.Source] == labels[edge.Target])
            .GroupBy(edge => labels[edge.Source])
            .ToDictionary(group => group.Key, group => group.ToList());
        var result = new JsonArray();
        foreach (var parent in users.Values.GroupBy(user => labels[user.Id]).OrderBy(group => group.Key))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var members = parent.Select(user => user.Id).ToList();
            var children = members.Count > 2
                ? CommunityDetector.Detect(
                    members,
                    internalLinks.GetValueOrDefault(parent.Key) ?? [],
                    settings.Number("resolution") * 1.5, cancellationToken)
                : members.ToDictionary(id => id, _ => 0, StringComparer.Ordinal);
            foreach (var user in parent)
            {
                user.Subcommunity = parent.Key + ":" + children[user.Id];
            }

            foreach (var child in parent.GroupBy(user => children[user.Id]).OrderBy(group => group.Key))
            {
                result.Add(new JsonObject
                {
                    ["id"] = parent.Key + ":" + child.Key,
                    ["parent"] = parent.Key,
                    ["size"] = child.Count(),
                    ["label"] = Label(child)
                });
            }
        }

        return result;
    }

    private static string Label(IEnumerable<Person> users)
    {
        var names = users.OrderByDescending(user => user.Encounters).ThenBy(user => user.Id, StringComparer.Ordinal).Take(3).Select(user => user.Name);
        return string.Join(", ", names);
    }

    private static double MedianDegree(List<int> sortedDegrees)
    {
        if (sortedDegrees.Count == 0)
        {
            return 1;
        }

        var middle = sortedDegrees.Count / 2;
        if (sortedDegrees.Count % 2 == 1)
        {
            return sortedDegrees[middle];
        }

        return (sortedDegrees[middle - 1] + sortedDegrees[middle]) / 2.0;
    }
}
