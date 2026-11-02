using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>F1 conflict on both lanes (this file builds into Anvil.Tests and Anvil.Tests.Odc): the candidate rebased on the
/// live module keeps the delivery's value where the person edited the same property, and keeps the person's other edits
/// (MergePlanner.Rebase, the native MatchTree of each Studio with the candidate as the local side). Reached by reflection so
/// it builds on a kernel without the rebase (it then fails).</summary>
public class ConflictRebaseLaneTests
{
    public static IEnumerable<object[]> Fixtures() => HtmlCrossPlatformLifecycleTests.Fixtures();

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void TheRebasedCandidateKeepsTheDeliverysValueAndThePersonsOtherEdits(string fixture)
    {
        var binder = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") ?? typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethods().First(m => m.Name == "Bind");
        bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ConflictRebaseLaneTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "conflict-rebase-lane", fixture.Replace('/', '-'), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        string Run(string from, string name, string jobText)
        {
            var job = Path.Combine(work, name + ".json"); File.WriteAllText(job, jobText);
            var output = Path.Combine(work, name + ".oml");
            var applied = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(work, name)), from, job, output))!;
            Assert.True(applied["accepted"]!.GetValue<bool>(), name + ": " + applied.ToJsonString());
            return output;
        }
        const string action = """{"ops":[{"op":"logic","data":{"actions":[{"name":"NAME","kind":"server","outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"1"}}]}]}}]}""";
        static string Describe(string action, string text) => """{"ops":[{"op":"set","target":"ServerAction:ACTION","prop":"Description","value":"TEXT"}]}""".Replace("ACTION", action).Replace("TEXT", text);
        var basis = Run(Path.Combine(root, "tests", "fixtures", fixture), "base", action.Replace("NAME", "Shared"));
        var candidate = Run(basis, "candidate", Describe("Shared", "written by the job"));
        var edited = Run(basis, "person-1", Describe("Shared", "edited by the person"));
        var live = Run(edited, "live", action.Replace("NAME", "PersonsOwn"));
        var rebase = typeof(MergePlanner).GetMethod("Rebase", BindingFlags.Public | BindingFlags.Instance);
        Assert.True(rebase != null, "MergePlanner rebases a candidate on the live module");
        var rebased = Path.Combine(work, "rebased.oml");
        rebase!.Invoke(new MergePlanner(_ => host), [candidate, live, basis, rebased]);
        // What the job wrote is in the rebased candidate (the delivery's value won the conflict) ...
        var proof = MergeContentProof.Check(host, candidate, rebased, basis);
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof["differences"]!.ToJsonString());
        // ... and the person's own action came in.
        Assert.Contains(proof["outsideDelivery"]?["elements"]?.AsArray() ?? [], e => e!["element"]!.ToString().Contains("PersonsOwn", StringComparison.Ordinal));
    }
}