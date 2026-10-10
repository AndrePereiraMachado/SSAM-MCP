using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane B, C14: `replace` of a server or service action whose signature stays the same keeps its key (only the body is
/// rewritten), so consumers in other modules stay bound; a public action whose signature changes while the kernel knows
/// consumers is refused naming them (SIGNATURE_CHANGE_BREAKS_CONSUMERS), before anything is deleted.
/// </summary>
public sealed class PacoteBReplaceTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    private const string Api = """{"name":"PacoteBApi","public":true,"replace":true,"inputs":[{"name":"N","type":"Integer"}],"outputs":[{"name":"R","type":"Integer"}],"steps":[{"assign":{"R":"N + 2"}}]}""";

    private static (ModelHost Host, string Dir, string Base) Seed()
    {
        var dir = Path.Combine(Root, ".local", "pacote-b-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var host = new ModelHost(Path.Combine(dir, "work"));
        var seed = Path.Combine(dir, "seed.json");
        File.WriteAllText(seed, """
        {"base":"blank-service.oml","ops":[{"op":"logic","data":{"actions":[
          {"name":"PacoteBApi","public":true,"inputs":[{"name":"N","type":"Integer"}],"outputs":[{"name":"R","type":"Integer"}],"steps":[{"assign":{"R":"N + 1"}}]},
          {"name":"PacoteBUse","public":true,"outputs":[{"name":"O","type":"Integer"}],"steps":[{"call":"PacoteBApi","as":"Call","args":{"N":"1"}},{"assign":{"O":"Call.R"}}]}]}}]}
        """);
        var basePath = Path.Combine(dir, "seed.oml");
        var seeded = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, seed, basePath))!;
        Assert.True(seeded["accepted"]!.GetValue<bool>(), seeded["policyMessages"]!.ToJsonString() + seeded["details"]);
        return (host, dir, basePath);
    }

    [Fact]
    public void ReplacingAPublicServerActionWithTheSameSignatureKeepsItsKey()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (host, dir, basePath) = Seed();
        var job = Path.Combine(dir, "body.json");
        File.WriteAllText(job, """{"ops":[{"op":"logic","data":{"actions":[""" + Api + "]}}]}");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, job, Path.Combine(dir, "body.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]!.ToJsonString() + result["details"]);
        var replacement = Assert.Single(result["results"]![0]!["result"]!["replacements"]!.AsArray())!;
        Assert.True(replacement["identityRetained"]!.GetValue<bool>());
        Assert.Equal(replacement["oldKey"]!.GetValue<string>(), replacement["key"]!.GetValue<string>());
    }

    [Fact]
    public void ChangingThePublicSignatureWithAConsumerIsRefusedNamingIt()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (host, dir, basePath) = Seed();
        var job = Path.Combine(dir, "signature.json");
        var changed = Api.Replace("""[{"name":"N","type":"Integer"}]""", """[{"name":"N","type":"Integer"},{"name":"M","type":"Integer"}]""").Replace("N + 2", "N + M");
        File.WriteAllText(job, """{"ops":[{"op":"logic","data":{"actions":[""" + changed + "]}}]}");
        var output = Path.Combine(dir, "signature.oml");
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, basePath, job, output));
        var coded = Errors.FindCoded(error);
        Assert.NotNull(coded);
        Assert.Equal("SIGNATURE_CHANGE_BREAKS_CONSUMERS", coded!.Code);
        Assert.Contains("PacoteBUse", Errors.Text(error));
        Assert.Contains(coded.Problems!, p => p!["message"]!.GetValue<string>().Contains("PacoteBUse"));
        Assert.False(File.Exists(output));
        Assert.Equal("SIGNATURE_CHANGE_BREAKS_CONSUMERS", Errors.Envelope("apply", error, 1)["code"]!.GetValue<string>());
    }
}
