using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Integration of the atritos 2 package (lanes F3 and F2): a declared action is (owner, name) (I5), so the same screen action
/// name on two screens is two actions. ModelSession.LogicCore keyed its replacements by the name alone: two replace:true of
/// OnSave on two screens collided, and a replace of one screen's OnSave next to a new OnSave on another screen bound the new
/// one to the replaced action. The replacements are keyed by "owner/name".
/// </summary>
public sealed class Pa2IntegracaoReplaceTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    private static string Screen(string name) => """{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"NAME"}""".Replace("NAME", name);
    private static string OnSave(string screen, bool replace = false)
        => """{"name":"OnSave","kind":"screen","owner":"IMobileScreen:SCREEN",REPLACE"vars":[{"name":"Done","type":"Boolean"}],"steps":[{"assign":{"Done":"True"}}]}"""
            .Replace("SCREEN", screen).Replace("REPLACE", replace ? "\"replace\":true," : "");

    private static (ModelHost Host, string Dir, string Base) Seed()
    {
        var dir = Path.Combine(Root, ".local", "pa2-integracao-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var host = new ModelHost(Path.Combine(dir, "work"));
        var seed = Path.Combine(dir, "seed.json");
        File.WriteAllText(seed, """{"base":"reactive-ui.oml","expectValid":true,"ops":[""" + Screen("PaDetail") + "," + Screen("PaEdit") + ","
            + """{"op":"logic","data":{"actions":[""" + OnSave("PaDetail") + "," + OnSave("PaEdit") + "]}}]}");
        var basePath = Path.Combine(dir, "seed.oml");
        var seeded = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, seed, basePath))!;
        Assert.True(seeded["accepted"]!.GetValue<bool>(), seeded["policyMessages"]!.ToJsonString() + seeded["details"]);
        return (host, dir, basePath);
    }

    private static JsonNode Run(ModelHost host, string dir, string basePath, string name, string ops)
    {
        var job = Path.Combine(dir, name + ".json");
        File.WriteAllText(job, """{"expectValid":true,"ops":[""" + ops + "]}");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, job, Path.Combine(dir, name + ".oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]!.ToJsonString() + result["details"]);
        return result;
    }

    [Fact]
    public void TheSameScreenActionReplacedOnTwoScreensKeepsEachKey()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (host, dir, basePath) = Seed();
        var result = Run(host, dir, basePath, "both", """{"op":"logic","data":{"actions":[""" + OnSave("PaDetail", true) + "," + OnSave("PaEdit", true) + "]}}");
        var logic = result["results"]!.AsArray().Single(r => r!["op"]!.ToString() == "logic")!["result"]!;
        var replacements = logic["replacements"]!.AsArray();
        Assert.Equal(2, replacements.Count);
        Assert.All(replacements, r => Assert.True(r!["identityRetained"]!.GetValue<bool>(), r.ToJsonString()));
        Assert.All(replacements, r => Assert.Equal(r!["oldKey"]!.GetValue<string>(), r["key"]!.GetValue<string>()));
        Assert.NotEqual(replacements[0]!["key"]!.GetValue<string>(), replacements[1]!["key"]!.GetValue<string>());
    }

    [Fact]
    public void ANewScreenActionNextToAReplacedOneOfTheSameNameIsItsOwnAction()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (host, dir, basePath) = Seed();
        var result = Run(host, dir, basePath, "third", Screen("PaThird") + ","
            + """{"op":"logic","data":{"actions":[""" + OnSave("PaDetail", true) + "," + OnSave("PaThird") + "]}},"
            + """{"op":"get","target":"IMobileScreen:PaThird/OnSave"},{"op":"get","target":"IMobileScreen:PaDetail/OnSave"}""");
        var rows = result["results"]!.AsArray();
        var replacement = Assert.Single(rows.Single(r => r!["op"]!.ToString() == "logic")!["result"]!["replacements"]!.AsArray())!;
        Assert.True(replacement["identityRetained"]!.GetValue<bool>());
        var keys = rows.Where(r => r!["op"]!.ToString() == "get").Select(r => r!["result"]!["key"]!.GetValue<string>()).ToArray();
        Assert.Equal(2, keys.Length);
        Assert.Equal(replacement["key"]!.GetValue<string>(), keys[1]);
        Assert.NotEqual(keys[1], keys[0]);
    }
}
