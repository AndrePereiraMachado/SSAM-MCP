using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class TraditionalEntryRecipeTests
{
    [Fact]
    public void TraditionalCrudRecipeKeepsItsDefaultEntryThroughNativeMerge()
    {
        StudioAssemblies.Bind();
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalEntryRecipeTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "traditional-entry-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(Path.Combine(work, "model"));
        var basis = Path.Combine(root, "tests", "fixtures", "traditional-ui.oml");
        var candidate = Path.Combine(work, "candidate.oml");
        var recipe = Path.Combine(root, "tests", "jobs", "screen-crud-traditional.json");
        var applied = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, recipe, candidate))!;
        File.WriteAllText(Path.Combine(work, "apply.json"), applied.ToJsonString());
        Assert.True(applied["accepted"]!.GetValue<bool>(), work + "\n" + applied.ToJsonString());
        var merged = Path.Combine(work, "merged.oml");
        var proof = MergeProbe.ThreeWay(host, File.ReadAllBytes(basis), File.ReadAllBytes(candidate), merged);
        File.WriteAllText(Path.Combine(work, "merge.json"), JsonSerializer.Serialize(proof));
        Assert.True(proof.LocalIsValid, work + "\n" + JsonSerializer.Serialize(proof));
        var readJob = Path.Combine(work, "read.json");
        File.WriteAllText(readJob, """{"ops":[{"op":"get","target":"IEntry:ContactsEntry"},{"op":"get","target":"IWebScreen:ContactsWeb"}]}""");
        foreach (var file in new[] { candidate, merged })
        {
            var read = JsonSerializer.SerializeToNode(JobRunner.Run(host, file, readJob, Path.Combine(work, "read-" + Path.GetFileName(file))))!;
            File.WriteAllText(Path.Combine(work, Path.GetFileNameWithoutExtension(file) + "-entry.json"), read.ToJsonString());
            Assert.True(read["accepted"]!.GetValue<bool>(), work + "\n" + read.ToJsonString());
            var entry = read["results"]![0]!["result"]!;
            var screen = read["results"]![1]!["result"]!;
            Assert.Equal("ContactsWeb", screen["name"]!.GetValue<string>());
            Assert.Equal("@" + screen["key"]!.GetValue<string>(), entry["properties"]!["Target"]!.GetValue<string>());
            Assert.Equal("True", entry["properties"]!["IsDefault"]!.GetValue<string>());
        }
    }
}
