using System.Diagnostics;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Cell = Anvil.Core.EnvironmentData.Cell;
using Row = Anvil.Core.EnvironmentData.Row;

namespace Anvil.Tests;

/// <summary>
/// P3 (friction cc5deb6b, 2026-10-08): an o11_data read-all of AuditEntry from offset 100000 ran 330 s against the Studio and
/// the Studio froze and closed; read-all looped up to 1000 pages in one call with no deadline and no page timeout. A read
/// now stops at a row limit or at the call's deadline, every page has a hard timeout, and an incomplete answer gives the
/// offset to continue from. The server is a fake big table that answers 100 rows per page, optionally slowly.
/// </summary>
public sealed class O11DataBoundedReadTests
{
    private static readonly DataEntity Audit = new("AuditEntry", "e-audit", false,
        [new("Id", "k-id", true, false, "Long Integer"), new("Message", "k-message", false, false, "Text")]);
    private static readonly DataSchema Schema = new("DCIPS_Audit_CS", "e-module", [Audit]);

    private sealed class BigTable(int rows, int pageSize = 100)
    {
        public int Reads;
        public Func<int, TimeSpan> Delay = _ => TimeSpan.Zero;
        public EnvironmentData.DataStore Store() => new(Read,
            (_, _, _, _, _) => throw new InvalidOperationException("a read never writes"),
            (_, _, _) => throw new InvalidOperationException("a read keeps no receipt"));
        private Row[] Read(string entity, int? tenant, string[]? ids, int offset)
        {
            Interlocked.Increment(ref Reads);
            var delay = Delay(offset);
            if (delay > TimeSpan.Zero) Thread.Sleep(delay);
            return Enumerable.Range(offset, Math.Max(0, Math.Min(pageSize, rows - offset)))
                .Select(i => new Row((i + 1).ToString(), [new Cell("k-id", (i + 1).ToString()), new Cell("k-message", "m" + i)])).ToArray();
        }
    }

    private static JsonObject ReadAll(int offset = 0, int? limit = null, int? deadlineMs = null)
    {
        var op = new JsonObject { ["operation"] = "read-all", ["entity"] = "AuditEntry", ["offset"] = offset };
        if (limit != null) op["limit"] = limit;
        if (deadlineMs != null) op["deadlineMs"] = deadlineMs;
        return op;
    }

    private static JsonObject Only(JsonObject batch) => batch["results"]![0]!.AsObject();

    [Fact]
    public void AReadAllOfABigTableStopsAtTheRowLimitAndSaysWhereToContinue()
    {
        var table = new BigTable(50000);
        var result = Only(EnvironmentData.RunBatch(Schema, ReadAll(), table.Store()));
        Assert.True(result["ok"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Equal(2000, result["count"]!.GetValue<int>());   // the default limit (ReadLimits.DefaultMaxRows)
        Assert.Equal(20, table.Reads);   // 20 pages, never the 500 of the whole table
        Assert.False(result["complete"]?.GetValue<bool>() ?? true);
        Assert.Equal("limit", result["stoppedBy"]!.ToString());
        Assert.Equal(2000, result["continuation"]!["offset"]!.GetValue<int>());
        Assert.Contains("offset 2000", result["next"]!.ToString());
    }

    [Fact]
    public void TheContinuationReadsTheNextRowsUntilTheEndIsComplete()
    {
        var table = new BigTable(250);
        var first = Only(EnvironmentData.RunBatch(Schema, ReadAll(limit: 100), table.Store()));
        Assert.Equal(100, first["count"]!.GetValue<int>());
        var offset = first["continuation"]!["offset"]!.GetValue<int>();
        var second = Only(EnvironmentData.RunBatch(Schema, ReadAll(offset, limit: 100), table.Store()));
        Assert.Equal("101", second["records"]![0]!["Id"]!.ToString());
        var third = Only(EnvironmentData.RunBatch(Schema, ReadAll(second["continuation"]!["offset"]!.GetValue<int>(), limit: 100), table.Store()));
        Assert.True(third["complete"]!.GetValue<bool>(), third.ToJsonString());
        Assert.Equal(50, third["count"]!.GetValue<int>());
        Assert.Null(third["continuation"]);
    }

    [Fact]
    public void ASlowPageIsAbandonedAtItsTimeoutAndTheRowsBeforeItAreAnswered()
    {
        var table = new BigTable(100000) { Delay = offset => offset >= 200 ? TimeSpan.FromSeconds(20) : TimeSpan.Zero };
        var watch = Stopwatch.StartNew();
        var result = Only(EnvironmentData.RunBatch(Schema, ReadAll(), table.Store(),
            new EnvironmentData.ReadLimits(10000, TimeSpan.FromSeconds(30), TimeSpan.FromMilliseconds(300))));
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(5), $"the caller waited {watch.Elapsed}");
        Assert.True(result["ok"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Equal(200, result["count"]!.GetValue<int>());
        Assert.Equal("page-timeout", result["stoppedBy"]!.ToString());
        Assert.Equal(200, result["continuation"]!["offset"]!.GetValue<int>());
    }

    [Fact]
    public void ADeepOffsetWhosePageTimesOutAnswersDataReadTimeoutWithTheSameOffset()
    {
        // The 08/10 shape: offset 100000 of a big entity, the server slow on every page.
        var table = new BigTable(200000) { Delay = _ => TimeSpan.FromSeconds(20) };
        var watch = Stopwatch.StartNew();
        var batch = EnvironmentData.RunBatch(Schema, ReadAll(100000), table.Store(),
            new EnvironmentData.ReadLimits(2000, TimeSpan.FromSeconds(30), TimeSpan.FromMilliseconds(300)));
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(5), $"the caller waited {watch.Elapsed}");
        Assert.False(batch["ok"]!.GetValue<bool>());
        Assert.Equal("DATA_READ_TIMEOUT", batch["code"]!.ToString());
        var result = Only(batch);
        Assert.Equal(100000, result["continuation"]!["offset"]!.GetValue<int>());
        Assert.Contains("read by ids", result["error"]!.ToString());
    }

    [Fact]
    public void TheCallStopsAtItsDeadlineEvenWhenEveryPageIsQuick()
    {
        var table = new BigTable(1000000) { Delay = _ => TimeSpan.FromMilliseconds(50) };
        var watch = Stopwatch.StartNew();
        var result = Only(EnvironmentData.RunBatch(Schema, ReadAll(limit: 10000, deadlineMs: 1000), table.Store()));
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(3), $"the caller waited {watch.Elapsed}");
        Assert.Equal("deadline", result["stoppedBy"]!.ToString());
        Assert.False(result["complete"]!.GetValue<bool>());
        Assert.True(result["count"]!.GetValue<int>() < 10000);
        Assert.Equal(result["count"]!.GetValue<int>(), result["continuation"]!["offset"]!.GetValue<int>());
    }

    [Fact]
    public void LimitsOutsideTheirRangeAreRefusedBeforeAnyRead()
    {
        var table = new BigTable(10);
        foreach (var bad in new[] { ReadAll(limit: 0), ReadAll(limit: EnvironmentData.ReadLimits.RowCap + 1), ReadAll(deadlineMs: 10), ReadAll(deadlineMs: 600000) })
        {
            var result = EnvironmentData.RunBatch(Schema, bad, table.Store());
            Assert.False(result["ok"]!.GetValue<bool>());
            Assert.Equal("DATA_REQUEST_INVALID", result["code"]!.ToString());
        }
        Assert.Equal(0, table.Reads);
    }

    [Fact]
    public void BoundedGivesUpAtItsTimeoutAndPassesQuickAnswersThrough()
    {
        Assert.Equal(7, EnvironmentData.Bounded(() => 7, TimeSpan.FromSeconds(5), "quick"));
        var watch = Stopwatch.StartNew();
        var error = Assert.Throws<EnvironmentData.DataReadTimeoutException>(() =>
            EnvironmentData.Bounded(() => { Thread.Sleep(10000); return 1; }, TimeSpan.FromMilliseconds(200), "the page"));
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(3));
        Assert.StartsWith("the page did not answer", error.Message);
        Assert.Throws<InvalidOperationException>(() => EnvironmentData.Bounded<int>(() => throw new InvalidOperationException("x"), TimeSpan.FromSeconds(5), "fault"));
    }
}
