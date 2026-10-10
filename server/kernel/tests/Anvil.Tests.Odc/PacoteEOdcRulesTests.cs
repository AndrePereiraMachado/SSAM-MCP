using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.PreflightRules;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// Lane E of the 2026-10-05 package (C07): the ODC platform rules as pure preflight rules (I1). Each case is the minimal
/// synthetic form of a refusal the ODC Studio gave in session 62a884e8 (QuizLiveWeb, 2026-10-04 22:08-22:29); each
/// problem names the rule, the op, the pointer and the exact fix. The rules never fire on O11 and never on the ODC suite
/// jobs (tests/jobs-odc), which the Studio accepts.
/// </summary>
public class PacoteEOdcRulesTests
{
    private static JsonArray Ops(string json) => JsonNode.Parse(json)!.AsArray();
    private static List<JsonObject> Check(string json, string lane = "odc") => OdcPlatformRules.Check(Ops(json), lane).ToList();

    [Fact]
    public void ServiceActionOfTheSameAppCalledFromAFlowIsRefusedWithTheServerActionFix()
    {
        var problems = Check("""
            [{"op":"logic","data":{"actions":[
              {"name":"Quiz_Criar","kind":"service","public":true,"inputs":[{"name":"Titulo","type":"Text"}],"steps":[]},
              {"name":"Home_Criar","kind":"server","steps":[{"call":"Quiz_Criar","as":"Criar","args":{"Titulo":"\"x\""}}]}]}},
             {"op":"set","target":"$node","prop":"Action","value":"IServiceAction:Quiz_Criar"}]
            """);
        Assert.Equal(2, problems.Count(p => p["code"]!.GetValue<string>() == "ODC_SERVICE_ACTION_SAME_APP"));
        var call = problems.First(p => p["op"]!.GetValue<int>() == 0);
        Assert.Equal("/ops/0/data/actions/1/steps/0/call", call["pointer"]!.GetValue<string>());
        Assert.Equal("error", call["severity"]!.GetValue<string>());
        Assert.Contains("kind:\"server\"", call["fix"]!.GetValue<string>());
        Assert.Equal("/ops/1/value", problems.First(p => p["op"]!.GetValue<int>() == 1)["pointer"]!.GetValue<string>());
    }

    [Fact]
    public void ServiceActionOfAnotherAppIsNotRefused()
    {
        // A referenced Service Action of another app is a signature; a name the job does not declare is unknown here.
        Assert.Empty(Check("""
            [{"op":"logic","data":{"actions":[{"name":"Run","kind":"server","steps":[{"call":"IServiceActionSignature:Other_Api","as":"C"},{"call":"Existing_Helper","as":"D"}]}]}}]
            """));
    }

    [Fact]
    public void GenerateGuidAndModAreRefusedWithTheFixTheSessionUsed()
    {
        var problems = Check("""
            [{"op":"logic","data":{"actions":[{"name":"Codigo_Gerar","kind":"server","outputs":[{"name":"Codigo","type":"Text"}],
              "vars":[{"name":"Base","type":"Long Integer"}],
              "steps":[{"assign":{"Codigo":"ToUpper(Substr(GenerateGuid(), 0, 5))"},"as":"Primeiro"},
                       {"if":"Base > 0","then":[{"assign":{"Codigo":"LongIntegerToText(10000 + ((Base * 7919) mod 90000))"},"as":"Novo"}]}]}]}},
             {"op":"create","parent":"$screen","type":"IExpression","args":{"Value":"GenerateGuid()"}}]
            """);
        var unavailable = problems.Where(p => p["code"]!.GetValue<string>() == "ODC_FUNCTION_UNAVAILABLE").ToList();
        Assert.Equal(3, unavailable.Count);
        Assert.Contains(unavailable, p => p["pointer"]!.GetValue<string>() == "/ops/0/data/actions/0/steps/0/assign/Codigo" && p["fix"]!.GetValue<string>().Contains("IdentifierToLongInteger"));
        Assert.Contains(unavailable, p => p["pointer"]!.GetValue<string>() == "/ops/0/data/actions/0/steps/1/then/0/assign/Codigo" && p["fix"]!.GetValue<string>().Contains("DecimalToInteger(x / n) * n"));
        Assert.Contains(unavailable, p => p["op"]!.GetValue<int>() == 1);
    }

    [Fact]
    public void TextThatOnlyMentionsTheNamesIsNotRefused()
    {
        Assert.Empty(Check("""
            [{"op":"logic","data":{"actions":[{"name":"Mod","kind":"server","description":"GenerateGuid() is not on ODC","vars":[{"name":"mod","type":"Integer"}],
              "steps":[{"assign":{"mod":"Length(\"mod GenerateGuid()\")"},"as":"A"}]}]}},
             {"op":"set","target":"$t","prop":"Description","value":"uses GenerateGuid() and mod"}]
            """));
    }

    [Fact]
    public void CountAssignedToAnIntegerIsRefusedWithAMechanicalPatch()
    {
        var problems = Check("""
            [{"op":"logic","data":{"actions":[{"name":"Respondidas_Contar","kind":"server",
              "outputs":[{"name":"TotalJogadores","type":"Integer"},{"name":"Total","type":"Long Integer"}],
              "steps":[{"get":"Jogador","as":"GetJogadores","where":"Jogador.PartidaId = PartidaId"},
                       {"assign":{"TotalJogadores":"GetJogadores.Count","Total":"GetJogadores.Count"},"as":"Contar"}]}]}}]
            """);
        var count = Assert.Single(problems);
        Assert.Equal("ODC_COUNT_IS_LONG", count["code"]!.GetValue<string>());
        Assert.Equal("/ops/0/data/actions/0/steps/1/assign/TotalJogadores", count["pointer"]!.GetValue<string>());
        var patch = Assert.Single(count["patch"]!.AsArray())!.AsObject();
        Assert.Equal("replace", patch["op"]!.GetValue<string>());
        Assert.Equal(count["pointer"]!.GetValue<string>(), patch["path"]!.GetValue<string>());
        Assert.Equal("LongIntegerToInteger(GetJogadores.Count)", patch["value"]!.GetValue<string>());
        Assert.Contains("LongIntegerToInteger(GetJogadores.Count)", count["fix"]!.GetValue<string>());
    }

    [Fact]
    public void ConvertedCountAndTheO11LaneAreNotRefused()
    {
        const string converted = """
            [{"op":"logic","data":{"actions":[{"name":"A","kind":"server","outputs":[{"name":"N","type":"Integer"}],
              "steps":[{"get":"Jogador","as":"GetJogadores"},{"assign":{"N":"LongIntegerToInteger(GetJogadores.Count)"}}]}]}}]
            """;
        Assert.Empty(Check(converted));
        const string all = """
            [{"op":"logic","data":{"actions":[
              {"name":"S","kind":"service","steps":[]},
              {"name":"A","kind":"server","outputs":[{"name":"N","type":"Integer"}],
               "steps":[{"get":"Jogador","as":"GetJogadores"},{"assign":{"N":"GetJogadores.Count + (5 mod 2)"}},{"call":"S"},{"assign":{"N":"GenerateGuid()"}}]}]}}]
            """;
        Assert.NotEmpty(Check(all));
        Assert.Empty(Check(all, "o11"));
    }

    [Fact]
    public void EveryOdcSuiteJobPassesTheRules()
    {
        var dir = Path.Combine(FindRoot(), "tests", "jobs-odc");
        Assert.True(Directory.Exists(dir), dir);
        var refused = new List<string>();
        foreach (var file in Directory.GetFiles(dir, "*.json").OrderBy(f => f, StringComparer.Ordinal))
        {
            var job = JsonNode.Parse(File.ReadAllText(file))!;
            JsonArray ops;
            try { ops = JobRunner.CollectOps(job, dir); } catch { continue; }
            foreach (var p in OdcPlatformRules.Check(ops, "odc"))
                refused.Add($"{Path.GetFileName(file)} op #{p["op"]} {p["code"]} {p["pointer"]}");
        }
        Assert.True(refused.Count == 0, string.Join("\n", refused));
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(PacoteEOdcRulesTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
