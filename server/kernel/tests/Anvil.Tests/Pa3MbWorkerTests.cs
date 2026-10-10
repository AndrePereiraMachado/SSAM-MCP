using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Package 3, lane mb, C02 (B1 and B2) without a Studio. The resident worker's base cache takes a spare by the capture's
/// content identity (`--base-content-sha256`, the facade's contentSha256) when both sides carry it: two captures of an
/// unchanged module are two files with other bytes but the same content. The kernel receipt proves a (base, candidate)
/// pair for the builder's fast path only when both hashes, the verdict and the footprint say so.
/// </summary>
public sealed class Pa3MbWorkerTests : IDisposable
{
    private sealed class Model { public required byte[] Bytes { get; init; } }

    private readonly string dir = Path.Combine(Path.GetTempPath(), "anvil-pa3mb-worker", Guid.NewGuid().ToString("N"));
    private string profile = "developerId=a";

    public Pa3MbWorkerTests() => Directory.CreateDirectory(dir);
    public void Dispose() { try { Directory.Delete(dir, true); } catch (IOException) { } }

    private BaseModelCache<Model> Cache() => new(BaseCacheOptions.Default,
        () => new BaseRuntime("test", "1.0", "studio", "kernel", profile),
        (bytes, _) => new Model { Bytes = bytes }, (_, _) => 10, _ => { }, null, () => DateTime.UtcNow, () => 0, () => 0, () => { });

    private string Base(string name, byte fill)
    {
        var path = Path.Combine(dir, name + ".oml");
        File.WriteAllBytes(path, Enumerable.Repeat(fill, 1000).ToArray());
        return path;
    }

    [Fact]
    public void BaseModelCacheHitsBySameContentFromAnotherPath()
    {
        var cache = Cache();
        var first = Base("capture-1", 1); var second = Base("capture-2", 2); var other = Base("capture-3", 3);
        Assert.Null(cache.Take(first, File.ReadAllBytes(first), contentSha256: "c1").Model);
        cache.Idle(CancellationToken.None);
        Assert.Equal(1, cache.Held);
        // Another capture (other bytes, other path) of the same content takes the spare.
        var hit = cache.Take(second, File.ReadAllBytes(second), contentSha256: "C1");
        Assert.NotNull(hit.Model);
        Assert.True(hit.Receipt["hit"]!.GetValue<bool>());
        // Another content misses.
        cache.Idle(CancellationToken.None);
        Assert.Null(cache.Take(other, File.ReadAllBytes(other), contentSha256: "c2").Model);
    }

    [Fact]
    public void WithoutContentOnBothSidesTheFileStillDecides()
    {
        var cache = Cache();
        var first = Base("capture-1", 1); var second = Base("capture-2", 2);
        cache.Take(first, File.ReadAllBytes(first), contentSha256: "c1");
        cache.Idle(CancellationToken.None);
        Assert.Null(cache.Take(second, File.ReadAllBytes(second)).Model); // no content identity: another file misses
    }

    [Fact]
    public void TheRequestsContentHintReachesTakeWithoutChangingItsCaller()
    {
        var cache = Cache();
        var first = Base("capture-1", 1); var second = Base("capture-2", 2);
        BaseModelCache.WithContent(first, "c1", () => cache.Take(first, File.ReadAllBytes(first)));
        cache.Idle(CancellationToken.None);
        // JobRunner calls Take(path, bytes, reusable) as always; the CLI's --base-content-sha256 is the hint of this request.
        var hit = BaseModelCache.WithContent(second, "c1", () => cache.Take(second, File.ReadAllBytes(second)));
        Assert.NotNull(hit.Model);
        Assert.Null(BaseModelCache.ContentOf(second)); // the hint ends with the request
    }

    [Fact]
    public void ASpareOfAnotherAuthorIsNeverTakenEvenWithTheSameContent()
    {
        var cache = Cache();
        var first = Base("capture-1", 1); var second = Base("capture-2", 2);
        cache.Take(first, File.ReadAllBytes(first), contentSha256: "c1");
        cache.Idle(CancellationToken.None);
        profile = "developerId=b"; // OdcRuntime.LoadProfile carries the request's developer id
        Assert.Null(cache.Take(second, File.ReadAllBytes(second), contentSha256: "c1").Model);
    }

    // The request's author as OdcRuntime keeps it (an AsyncLocal set by WithDeveloperId for one request), outside any request
    // the process's own; LoadProfile and the load carry it, as OdcRuntime.LoadProfile and OdcRuntime.Load do.
    private static readonly AsyncLocal<string?> RequestAuthor = new();
    private static T AsAuthor<T>(string author, Func<T> body)
    {
        var previous = RequestAuthor.Value;
        RequestAuthor.Value = author;
        try { return body(); }
        finally { RequestAuthor.Value = previous; }
    }
    private static string Author => RequestAuthor.Value ?? "process";

    [Fact]
    public void TheIdleStepPreparesTheSpareUnderTheAuthorOfTheRequestThatWantedIt()
    {
        // The worker's idle step runs on its dispatch thread, outside every request. Offline replay of the friend's labs 27
        // and 40 (2026-10-07): with --developer-id the spare was never ready (its key had the process's author), hit:false.
        var loadedAs = new List<string>();
        var cache = new BaseModelCache<Model>(BaseCacheOptions.Default,
            () => new BaseRuntime("test", "1.0", "studio", "kernel", "developerId=" + Author),
            (bytes, _) => { loadedAs.Add(Author); return new Model { Bytes = bytes }; }, (_, _) => 10, _ => { }, null, () => DateTime.UtcNow, () => 0, () => 0, () => { });
        var first = Base("capture-1", 1); var second = Base("capture-2", 2); var third = Base("capture-3", 3);
        Assert.Null(AsAuthor("d@x.test", () => cache.Take(first, File.ReadAllBytes(first), contentSha256: "c1")).Model);
        cache.Idle(CancellationToken.None);
        Assert.Equal(1, cache.Held);
        Assert.Equal(new[] { "d@x.test" }, loadedAs);
        var hit = AsAuthor("d@x.test", () => cache.Take(second, File.ReadAllBytes(second), contentSha256: "c1"));
        Assert.NotNull(hit.Model);
        Assert.True(hit.Receipt["hit"]!.GetValue<bool>());
        // The spare prepared for one author is never another author's.
        cache.Idle(CancellationToken.None);
        Assert.Equal(new[] { "d@x.test", "d@x.test" }, loadedAs);
        Assert.Null(AsAuthor("e@x.test", () => cache.Take(third, File.ReadAllBytes(third), contentSha256: "c1")).Model);
    }

    private static JsonObject Receipt(string outSha, string? baseSha, bool accepted = true, bool valid = true, int created = 1, int changed = 0, string? author = "a@x.test")
    {
        var data = new JsonObject { ["outSha256"] = outSha, ["accepted"] = accepted, ["isValid"] = valid, ["developerId"] = author,
            ["footprint"] = new JsonObject { ["createdTotal"] = created, ["changedTotal"] = changed } };
        if (baseSha != null) data["baseSha256"] = baseSha;
        return new JsonObject { ["ok"] = true, ["data"] = data };
    }

    [Fact]
    public void TheKernelReceiptProvesOnlyItsOwnBaseAndCandidate()
    {
        var proof = CandidateReceipt.FastPath(Receipt("aa11", "bb22", created: 2, changed: 3), "AA11", "BB22");
        Assert.True(proof.Applies); Assert.True(proof.SameFiles); Assert.Equal(2, proof.Created); Assert.Equal(3, proof.Changed);
        Assert.False(CandidateReceipt.FastPath(Receipt("aa11", "bb22"), "CC33", "BB22").Applies);      // tampered candidate
        Assert.False(CandidateReceipt.FastPath(Receipt("aa11", "bb22"), "AA11", "DD44").Applies);      // another base
        Assert.False(CandidateReceipt.FastPath(Receipt("aa11", null), "AA11", "BB22").Applies);        // CLI before baseSha256
        Assert.False(CandidateReceipt.FastPath(Receipt("aa11", "bb22", valid: false), "AA11", "BB22").Applies);
        var empty = CandidateReceipt.FastPath(Receipt("aa11", "bb22", created: 0, changed: 0), "AA11", "BB22");
        Assert.False(empty.Applies); Assert.True(empty.SameFiles);                                    // the models decide
        Assert.False(CandidateReceipt.FastPath(null, "AA11", "BB22").Applies);
        Assert.True(CandidateReceipt.FastPath(Receipt("aa11", "bb22"), "AA11", "BB22", "A@X.TEST").Applies);              // the snapshot author
        Assert.False(CandidateReceipt.FastPath(Receipt("aa11", "bb22"), "AA11", "BB22", "b@x.test").Applies);             // built as someone else
        Assert.False(CandidateReceipt.FastPath(Receipt("aa11", "bb22", author: null), "AA11", "BB22", "a@x.test").Applies); // author unknown
    }
}
