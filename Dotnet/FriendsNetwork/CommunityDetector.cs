#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
namespace VRCX.FriendsNetwork;

/// <summary>Deterministic multilevel weighted Louvain with a separate label for each isolate.</summary>
internal static class CommunityDetector
{
    public static Dictionary<string, Dictionary<string, double>> Adjacency(IEnumerable<string> users, IEnumerable<Connection> links)
    {
        var adjacency = users.Order(StringComparer.Ordinal).ToDictionary(
            id => id,
            _ => new Dictionary<string, double>(StringComparer.Ordinal),
            StringComparer.Ordinal);
        foreach (var edge in links)
        {
            adjacency[edge.Source][edge.Target] = adjacency[edge.Source].GetValueOrDefault(edge.Target) + edge.Weight;
            adjacency[edge.Target][edge.Source] = adjacency[edge.Target].GetValueOrDefault(edge.Source) + edge.Weight;
        }

        return adjacency;
    }

    public static Dictionary<string, int> Detect(IEnumerable<string> users, List<Connection> links, double resolution,
        CancellationToken cancellationToken = default)
    {
        var adjacency = Adjacency(users, links);
        var members = adjacency.Keys.ToDictionary(id => id, id => new HashSet<string>(StringComparer.Ordinal) { id }, StringComparer.Ordinal);
        for (var level = 0; level < 20; level++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var (partition, changed) = Partition(adjacency, resolution, cancellationToken);
            var groups = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
            foreach (var node in adjacency.Keys.Order(StringComparer.Ordinal))
            {
                var community = partition[node];
                if (!groups.TryGetValue(community, out var group))
                {
                    groups[community] = group = new HashSet<string>(StringComparer.Ordinal);
                }

                group.UnionWith(members[node]);
            }

            if (!changed || groups.Count == adjacency.Count)
            {
                break;
            }

            (adjacency, members) = Aggregate(adjacency, partition, groups);
        }

        var result = new Dictionary<string, int>(StringComparer.Ordinal);
        var ordered = members.Values
            .OrderByDescending(group => group.Count)
            .ThenBy(group => group.Min(StringComparer.Ordinal), StringComparer.Ordinal)
            .ToList();
        for (var index = 0; index < ordered.Count; index++)
        {
            foreach (var user in ordered[index])
            {
                result[user] = index;
            }
        }

        return result;
    }

    private static (Dictionary<string, string> Partition, bool Changed) Partition(
        Dictionary<string, Dictionary<string, double>> adjacency, double resolution, CancellationToken cancellationToken)
    {
        var nodes = adjacency.Keys.Order(StringComparer.Ordinal).ToList();
        var degrees = nodes.ToDictionary(node => node, node => SequentialSum(adjacency[node].Values), StringComparer.Ordinal);
        var total = SequentialSum(degrees.Values);
        var communities = nodes.ToDictionary(node => node, node => node, StringComparer.Ordinal);
        if (total == 0)
        {
            return (communities, false);
        }

        var totals = new Dictionary<string, double>(degrees, StringComparer.Ordinal);
        var changed = false;
        for (var pass = 0; pass < 50; pass++)
        {
            var moved = false;
            foreach (var node in nodes)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (degrees[node] == 0)
                {
                    continue;
                }

                var previous = communities[node];
                var neighborWeights = new Dictionary<string, double>(StringComparer.Ordinal);
                foreach (var neighbor in adjacency[node])
                {
                    // An aggregated internal edge is a doubled self-loop: it counts
                    // toward degree but stays with the vertex after any move.
                    if (neighbor.Key == node)
                    {
                        continue;
                    }

                    var community = communities[neighbor.Key];
                    neighborWeights[community] = neighborWeights.GetValueOrDefault(community) + neighbor.Value;
                }

                totals[previous] -= degrees[node];
                var best = previous;
                var bestGain = neighborWeights.GetValueOrDefault(previous) - resolution * degrees[node] * totals[previous] / total;
                // Sorted candidates and a strict tolerance preserve identical-input
                // ties. Equal-gain moves keep the current community.
                foreach (var candidate in neighborWeights.Keys.Order(StringComparer.Ordinal))
                {
                    var gain = neighborWeights[candidate] - resolution * degrees[node] * totals[candidate] / total;
                    if (gain > bestGain + 1e-12)
                    {
                        best = candidate;
                        bestGain = gain;
                    }
                }

                communities[node] = best;
                totals[best] += degrees[node];
                if (best != previous)
                {
                    changed = true;
                    moved = true;
                }
            }

            if (!moved)
            {
                break;
            }
        }

        return (communities, changed);
    }

    private static (Dictionary<string, Dictionary<string, double>>, Dictionary<string, HashSet<string>>) Aggregate(
        Dictionary<string, Dictionary<string, double>> adjacency,
        Dictionary<string, string> partition,
        Dictionary<string, HashSet<string>> groups)
    {
        var canonical = groups.ToDictionary(pair => pair.Key, pair => pair.Value.Min(StringComparer.Ordinal)!, StringComparer.Ordinal);
        var result = groups.Keys.ToDictionary(group => canonical[group], _ => new Dictionary<string, double>(StringComparer.Ordinal), StringComparer.Ordinal);
        foreach (var node in adjacency)
        {
            var source = canonical[partition[node.Key]];
            foreach (var neighbor in node.Value)
            {
                var target = canonical[partition[neighbor.Key]];
                result[source][target] = result[source].GetValueOrDefault(target) + neighbor.Value;
            }
        }

        // Both directions of each internal edge become one doubled self-loop.
        return (result, groups.ToDictionary(pair => canonical[pair.Key], pair => pair.Value, StringComparer.Ordinal));
    }

    public static double SequentialSum(IEnumerable<double> values)
    {
        double sum = 0;
        foreach (var value in values)
        {
            sum += value;
        }

        return sum;
    }
}
