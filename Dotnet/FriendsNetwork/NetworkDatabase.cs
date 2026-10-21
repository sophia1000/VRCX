#nullable enable

using System;
using System.Collections.Generic;
using System.Data.SQLite;
using System.Globalization;
using System.IO;
using System.Text.Json.Nodes;
using System.Threading;

namespace VRCX.FriendsNetwork;

/// <summary>Connections are private to a background request, never shared with VRCX database work.</summary>
internal sealed class NetworkReadSnapshot : IDisposable
{
    public SQLiteConnection Connection { get; }
    private readonly NetworkSqlCancellation cancellation;
    private readonly CancellationToken token;
    private readonly string? temporaryPath;

    public NetworkReadSnapshot(string path, CancellationToken token = default, bool privateCopy = false)
    {
        this.token = token;
        Connection = OpenSnapshot(path, token, privateCopy, out temporaryPath);
        cancellation = new NetworkSqlCancellation(Connection, token);
        try
        {
            NetworkSql.Execute(Connection, "PRAGMA query_only=ON; BEGIN;");
        }
        catch
        {
            cancellation.Dispose();
            Connection.Dispose();
            DeleteTemporaryCopy();
            throw;
        }
    }

    private static SQLiteConnection OpenSnapshot(string path, CancellationToken token, bool privateCopy,
        out string? temporaryPath)
    {
        temporaryPath = null;
        SQLiteConnection source = NetworkSql.Open(path, readOnly: true);
        try
        {
            token.ThrowIfCancellationRequested();
            string? journalMode;
            using (SQLiteCommand journal = NetworkSql.Command(source, "PRAGMA journal_mode"))
            {
                journalMode = journal.ExecuteScalar()?.ToString();
            }
            if (!privateCopy || string.Equals(journalMode, "wal", StringComparison.OrdinalIgnoreCase))
            {
                return source;
            }

            // A long read transaction blocks logging in rollback-journal databases.
            // Online backup releases the source read lock between small page batches;
            // reconstruction then holds its consistent snapshot only on the private copy.
            temporaryPath = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(path))!,
                "." + Path.GetFileNameWithoutExtension(path) + ".mutual-network-snapshot-" + Guid.NewGuid().ToString("N") + ".sqlite3");
            SQLiteConnection.CreateFile(temporaryPath);
            using (SQLiteConnection destination = NetworkSql.Open(temporaryPath, readOnly: false))
            {
                source.BackupDatabase(destination, "main", "main", 256,
                    (_, _, _, _, _, _, _, _) =>
                    {
                        token.ThrowIfCancellationRequested();
                        return true;
                    }, 1);
            }
            token.ThrowIfCancellationRequested();
            source.Dispose();
            return NetworkSql.Open(temporaryPath, readOnly: true);
        }
        catch
        {
            source.Dispose();
            if (temporaryPath is not null)
            {
                File.Delete(temporaryPath);
            }
            throw;
        }
    }

    private void DeleteTemporaryCopy()
    {
        if (temporaryPath is not null)
        {
            File.Delete(temporaryPath);
        }
    }

    public SQLiteCommand Command(string sql)
    {
        token.ThrowIfCancellationRequested();
        return NetworkSql.Command(Connection, sql);
    }

    public long Count(string table)
    {
        using var command = Command($"SELECT COUNT(*) FROM \"{table}\"");
        return Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    public void Dispose()
    {
        cancellation.Dispose();
        Connection.Dispose();
        DeleteTemporaryCopy();
    }
}

internal sealed class NetworkSqlCancellation : IDisposable
{
    private readonly SQLiteConnection connection;
    private readonly SQLiteProgressEventHandler handler;

    public NetworkSqlCancellation(SQLiteConnection connection, CancellationToken token)
    {
        this.connection = connection;
        handler = (_, args) => args.ReturnCode = token.IsCancellationRequested
            ? SQLiteProgressReturnCode.Interrupt : SQLiteProgressReturnCode.Continue;
        connection.ProgressOps = 10000;
        connection.Progress += handler;
    }

    public void Dispose()
    {
        connection.Progress -= handler;
    }
}

internal static class NetworkSql
{
    public static SQLiteConnection Open(string path, bool readOnly)
    {
        if (!File.Exists(path))
        {
            throw new FileNotFoundException("The VRCX database is not available.", path);
        }
        var options = new SQLiteConnectionStringBuilder
        {
            DataSource = Path.GetFullPath(path),
            ReadOnly = readOnly,
            FailIfMissing = true,
            Pooling = false,
            DefaultTimeout = 5
        };
        var connection = new SQLiteConnection(options.ToString());
        try
        {
            connection.Open();
            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }

    public static SQLiteCommand Command(SQLiteConnection connection, string sql, params object?[] values)
    {
        var command = new SQLiteCommand(sql, connection);
        for (var index = 0; index < values.Length; index++)
        {
            command.Parameters.AddWithValue("$p" + index, values[index] ?? DBNull.Value);
        }
        return command;
    }

    public static JsonObject Metadata(SQLiteConnection connection)
    {
        var result = new JsonObject();
        try
        {
            using var command = Command(connection, "SELECT key,value FROM mutual_network_meta");
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                result[reader.GetString(0)] = JsonNode.Parse(reader.GetString(1));
            }
        }
        catch (Exception error) when (error is SQLiteException or System.Text.Json.JsonException)
        {
            return new JsonObject();
        }
        return result;
    }

    private static readonly string[] TimestampFormats =
    [
        "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK", "yyyy-MM-dd HH:mm:ss.FFFFFFFK",
        "yyyy-MM-dd'T'HH:mmK", "yyyy-MM-dd HH:mmK", "yyyy-MM-dd"
    ];

    public static void Execute(SQLiteConnection connection, string statement)
    {
        using SQLiteCommand command = connection.CreateCommand();
        command.CommandText = statement;
        command.ExecuteNonQuery();
    }

    public static string? Text(SQLiteDataReader reader, int column) =>
        reader.IsDBNull(column) ? null : Convert.ToString(reader.GetValue(column), CultureInfo.InvariantCulture);

    public static double? Number(SQLiteDataReader reader, int column) =>
        reader.IsDBNull(column) ? null : Convert.ToDouble(reader.GetValue(column), CultureInfo.InvariantCulture);

    public static double Duration(SQLiteDataReader reader, int column)
    {
        if (reader.IsDBNull(column))
        {
            return 0;
        }
        if (!double.TryParse(Text(reader, column), NumberStyles.Float,
                CultureInfo.InvariantCulture, out double milliseconds))
        {
            return 0;
        }
        double seconds = milliseconds / 1000;
        return double.IsFinite(seconds) && seconds > 0 ? seconds : 0;
    }

    public static double? Epoch(string? value)
    {
        // VRCX writes ISO timestamps. Accept their fractional precision while
        // rejecting ambiguous culture-specific dates from damaged or imported rows.
        if (!DateTimeOffset.TryParseExact(value, TimestampFormats, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out DateTimeOffset timestamp))
        {
            return null;
        }
        return (timestamp - DateTimeOffset.UnixEpoch).TotalSeconds;
    }

    public static SQLiteCommand PreparedInsert(
        SQLiteConnection connection, SQLiteTransaction transaction,
        string statement, params string[] parameterNames)
    {
        SQLiteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = statement;
        foreach (string name in parameterNames)
        {
            command.Parameters.Add(new SQLiteParameter(name, DBNull.Value));
        }
        command.Prepare();
        return command;
    }

    public static void Insert(SQLiteCommand command, params object?[] values)
    {
        for (int index = 0; index < values.Length; index++)
        {
            command.Parameters[index].Value = values[index] ?? DBNull.Value;
        }
        command.ExecuteNonQuery();
    }
}
