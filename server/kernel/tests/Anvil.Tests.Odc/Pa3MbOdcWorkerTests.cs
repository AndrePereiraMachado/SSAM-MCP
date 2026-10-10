using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// Package 3, lane mb, C02 B2: the delivery's kernel runs in the resident ODC worker, one process for many requests. Each
/// request carries its author (`apply --developer-id`, the snapshot's developerId) and the stamps of what it writes
/// (LastModifiedBy) are that author's, never the process's or the previous request's. Needs the ODC Studio installed;
/// without it the test returns without asserting.
/// </summary>
public class Pa3MbOdcWorkerTests
{
    private static readonly string Root = FindRoot();

    [Fact]
    public void TwoAppliesInOneProcessStampTheirOwnAuthor()
    {
        if (!StudioAvailable()) return;
        var dir = Path.Combine(Root, ".local", "lane-odc", "test-work", "pa3mb-author", Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        var basePath = Path.Combine(dir, "base.oml");
        File.Copy(Path.Combine(Root, "tests", "fixtures", "odc", "blank-mobile.oml"), basePath);
        var job = Path.Combine(dir, "stamp.json");
        File.WriteAllText(job, new JsonObject
        {
            ["expectValid"] = true,
            ["ops"] = new JsonArray(new JsonObject
            {
                ["op"] = "spec",
                ["data"] = new JsonObject { ["structures"] = new JsonArray(new JsonObject { ["name"] = "Pa3MbStamp",
                    ["attributes"] = new JsonArray(new JsonObject { ["name"] = "Value", ["type"] = "Text" }) }) }
            })
        }.ToJsonString());
        var host = new ModelHost(Path.Combine(dir, "work"));
        string StampOf(string author, string name)
        {
            var output = Path.Combine(dir, name + ".oml");
            var result = JsonSerializer.SerializeToNode(OdcRuntime.WithDeveloperId(author, () => JobRunner.Run(host, basePath, job, output)))!;
            Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString());
            var model = (IModelObject)host.Load(File.ReadAllBytes(output));
            try
            {
                var structure = Walk(model).Single(n => n.GetType().Name.EndsWith("Structure", StringComparison.Ordinal) && Name(n) == "Pa3MbStamp");
                return structure.Descriptor.Properties.Single(p => p.Name == "LastModifiedBy").GetValue(structure)?.ToString() ?? "";
            }
            finally { ModelHost.Release((ServiceStudio.Model.ESpace)model); }
        }
        Assert.Equal("first@pa3mb.test", StampOf("first@pa3mb.test", "first"));
        Assert.Equal("second@pa3mb.test", StampOf("second@pa3mb.test", "second"));
        // The scope ends with the request: the process identity is back.
        Assert.NotEqual("second@pa3mb.test", OdcRuntime.DeveloperId);
    }

    private static IEnumerable<IModelObject> Walk(IModelObject root)
    {
        var stack = new Stack<IModelObject>(); stack.Push(root);
        while (stack.TryPop(out var node)) { yield return node; foreach (var child in node.Children) stack.Push(child); }
    }

    private static string? Name(IModelObject node) { try { return node.DisplayName; } catch { return null; } }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(Pa3MbOdcWorkerTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
