using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>Atritos 2, lane F7b, A28: a module reservation records the kernel root, the process and the time of the task that
/// holds it (contract I8), and a conflict refuses with a code: MODULE_RESERVED for this root (the "resume task" text the
/// facade reads stays), MODULE_RESERVED_FOREIGN with root, pid and time for another root. Real case of 2026-10-05: the shared
/// authority held a reservation of 29/09 (owner a471638c...) of another root, and the doctor offered ssam_task, which answered
/// TASK_NOT_FOUND. Temporary folders only.</summary>
public sealed class Pa2F7bReservationTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "pa2-f7b-res-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { try { Directory.Delete(directory, true); } catch (IOException) { } }

    private string FileOf(string environment, string moduleKey) => Path.Combine(directory, DurableJson.Hash(environment.ToLowerInvariant() + "\n" + moduleKey) + ".json");

    [Fact]
    public void ThePayloadRecordsRootPidAndSince()
    {
        var before = DateTimeOffset.UtcNow.AddSeconds(-1);
        using (new ModuleReservation(directory, "Dev.Example.Test", "k1", "task-A")) { }
        var payload = DurableJson.Read(FileOf("Dev.Example.Test", "k1"));
        Assert.Equal("task-A", payload["owner"]!.ToString());
        Assert.Equal("Dev.Example.Test", payload["environment"]!.ToString());
        Assert.Equal("k1", payload["moduleKey"]!.ToString());
        Assert.Equal(JobSources.KernelRoot(), payload["root"]!.ToString());
        Assert.Equal(Environment.ProcessId, payload["pid"]!.GetValue<int>());
        var since = DateTimeOffset.Parse(payload["since"]!.ToString(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
        Assert.Equal(TimeSpan.Zero, since.Offset);
        Assert.InRange(since, before, DateTimeOffset.UtcNow.AddSeconds(1));
    }

    [Fact]
    public void TheSameOwnerResumingKeepsTheFirstSince()
    {
        using (new ModuleReservation(directory, "env", "k2", "task-A")) { }
        var first = DurableJson.Read(FileOf("env", "k2"))["since"]!.ToString();
        Thread.Sleep(20);
        using (var resumed = new ModuleReservation(directory, "env", "k2", "task-A")) resumed.Release();
        var released = DurableJson.Read(FileOf("env", "k2"));
        Assert.Equal(first, released["since"]!.ToString());
        Assert.Null(released["owner"]);
    }

    [Fact]
    public void AConflictOfAnotherRootRefusesWithModuleReservedForeignRootPidAndSince()
    {
        Directory.CreateDirectory(directory);
        var other = Path.Combine(Path.GetTempPath(), "another-ssam-root", "kernel");
        DurableJson.Write(FileOf("personal-x.outsystemscloud.com", "3TPPF1FCb0y5LDfjJpzx9Q"), new JsonObject { ["owner"] = "a471638cb0484920a6d0c0166b6f8a46",
            ["environment"] = "personal-x.outsystemscloud.com", ["moduleKey"] = "3TPPF1FCb0y5LDfjJpzx9Q", ["root"] = other, ["pid"] = 4242, ["since"] = "2026-09-29T21:14:03.0000000+00:00" });
        var ex = Assert.Throws<KernelRefusalException>(() => new ModuleReservation(directory, "personal-x.outsystemscloud.com", "3TPPF1FCb0y5LDfjJpzx9Q", "task-B"));
        Assert.Equal(ModuleReservation.ForeignCode, ex.Code);
        Assert.Equal("MODULE_RESERVED_FOREIGN", Errors.FindCoded(ex)!.Code);
        Assert.Contains("a471638cb0484920a6d0c0166b6f8a46", ex.Message);
        Assert.Contains(other, ex.Message);
        Assert.Contains("pid 4242", ex.Message);
        Assert.Contains("since 2026-09-29T21:14:03.0000000+00:00", ex.Message);
        Assert.Contains("ssam_doctor {lane:\"o11\", release}", ex.Message);
        Assert.DoesNotContain("resume task", ex.Message);
        // The CLI envelope carries the code (the facade reads it), and the refused task never took the module.
        Assert.Equal("MODULE_RESERVED_FOREIGN", Errors.Envelope("deliver", ex, 0)["code"]!.ToString());
        Assert.Equal("a471638cb0484920a6d0c0166b6f8a46", DurableJson.Read(FileOf("personal-x.outsystemscloud.com", "3TPPF1FCb0y5LDfjJpzx9Q"))["owner"]!.ToString());
    }

    [Fact]
    public void AConflictOfThisRootKeepsTheResumeTaskTextWithModuleReserved()
    {
        using (new ModuleReservation(directory, "env", "k3", "task-A")) { }
        var ex = Assert.Throws<InvalidOperationException>(() => new ModuleReservation(directory, "env", "k3", "task-B"));
        Assert.Equal("Module has an unfinished delivery; resume task task-A before starting another", ex.Message);
        Assert.Equal("MODULE_RESERVED", Errors.FindCoded(ex)!.Code);
        Assert.Equal("MODULE_RESERVED", Errors.Envelope("deliver", ex, 0)["code"]!.ToString());
        Assert.Matches("resume task task-A before starting another", Errors.Text(ex));
    }

    [Fact]
    public void AReservationWrittenBeforeTheRootFieldIsThisRootsAndSoIsTheSameRootWrittenDifferently()
    {
        Directory.CreateDirectory(directory);
        DurableJson.Write(FileOf("env", "k4"), new JsonObject { ["owner"] = "task-old", ["environment"] = "env", ["moduleKey"] = "k4" });
        var legacy = Assert.Throws<InvalidOperationException>(() => new ModuleReservation(directory, "env", "k4", "task-B"));
        Assert.Equal("MODULE_RESERVED", Errors.FindCoded(legacy)!.Code);
        var root = JobSources.KernelRoot()!;
        DurableJson.Write(FileOf("env", "k5"), new JsonObject { ["owner"] = "task-same", ["environment"] = "env", ["moduleKey"] = "k5",
            ["root"] = (OperatingSystem.IsWindows() ? root.ToUpperInvariant() : root) + Path.DirectorySeparatorChar, ["pid"] = 1, ["since"] = "2026-10-06T00:00:00Z" });
        var same = Assert.Throws<InvalidOperationException>(() => new ModuleReservation(directory, "env", "k5", "task-B"));
        Assert.Equal("MODULE_RESERVED", Errors.FindCoded(same)!.Code);
        Assert.Contains("resume task task-same", same.Message);
    }

    [Fact]
    public void AReservationTheDoctorReleasedIsFreeForTheNextTask()
    {
        // The envelope the facade writes on ssam_doctor {release} (DurableJson: {format:1, sha256 of the payload text, payload}).
        Directory.CreateDirectory(directory);
        var payload = "{\"owner\":null,\"environment\":\"env\",\"moduleKey\":\"k6\",\"root\":\"C:\\\\other\\\\kernel\",\"pid\":4242,\"since\":\"2026-09-29T21:14:03Z\","
            + "\"releasedBy\":\"doctor\",\"wordsSha256\":\"" + DurableJson.Hash("libere a reserva") + "\"}";
        var envelope = new JsonObject { ["format"] = 1, ["sha256"] = DurableJson.Hash(payload), ["payload"] = payload };
        File.WriteAllBytes(FileOf("env", "k6"), Encoding.UTF8.GetBytes(envelope.ToJsonString()));
        using (var next = new ModuleReservation(directory, "env", "k6", "task-B"))
            Assert.Equal("task-B", DurableJson.Read(FileOf("env", "k6"))["owner"]!.ToString());
    }

    [Fact]
    public void RootsCompareAsFolders()
    {
        var root = Path.Combine(Path.GetTempPath(), "x", "kernel");
        Assert.True(ModuleReservation.SameRoot(root, root + Path.DirectorySeparatorChar));
        Assert.True(ModuleReservation.SameRoot(root, Path.Combine(Path.GetTempPath(), "x", "y", "..", "kernel")));
        Assert.False(ModuleReservation.SameRoot(root, Path.Combine(Path.GetTempPath(), "z", "kernel")));
        if (OperatingSystem.IsWindows()) Assert.True(ModuleReservation.SameRoot(root, root.ToUpperInvariant()));
    }
}
