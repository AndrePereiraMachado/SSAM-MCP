using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class AutoPatchProvenanceRevisionTwoTests
{
    [Fact]
    public void EditingACorrectedJobExplainsHowToDiscardItsStaleSourceSidecar()
    {
        var work = Path.Combine(Path.GetTempPath(), "source-provenance-review2", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, "job.json");
        File.WriteAllText(job, "{\"ops\":[]}");
        var hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(job))).ToLowerInvariant();
        File.WriteAllText(job + ".source.json", new JsonObject { ["jobSha256"] = hash, ["sourceDirectory"] = work }.ToJsonString());
        File.WriteAllText(job, "{\"ops\":[],\"autoPatch\":false}");
        var error = Assert.Throws<KernelRefusalException>(() => JobSources.DirectoryOf(job));
        Assert.Contains("SOURCE_PROVENANCE_INVALID", Errors.Envelope("apply", error, 0).ToJsonString());
        Assert.Contains("delete", error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(job + ".source.json", error.Message);
        // Evidence is intentionally retained in the task's private TEMP folder.
    }
}
