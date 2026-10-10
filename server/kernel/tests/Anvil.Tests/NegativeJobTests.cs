using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Jobs em tests/jobs-negative com `expectError`: o runner tem de FALHAR e a mensagem que o CLI/worker devolvem (Errors.Text,
/// a mesma do envelope) tem de conter cada trecho esperado. E assim que se prova que um erro ensina a correcao: o texto que a
/// LLM ve e o texto testado.
/// </summary>
public class NegativeJobTests
{
    private static readonly string Root = FindRoot();
    private static readonly string Work = Path.Combine(Root, ".local", Environment.GetEnvironmentVariable("ANVIL_LANE") == "ss5" ? "lane-ss5" : "", "test-work");

    public static IEnumerable<object[]> Jobs()
    {
        var dir = Path.Combine(Root, "tests", "jobs-negative");
        if (!Directory.Exists(dir)) yield break;
        foreach (var f in Directory.GetFiles(dir, "*.json").OrderBy(x => x))
        {
            var job = JsonNode.Parse(File.ReadAllText(f))!.AsObject();
            if (job["expectError"] != null) yield return new object[] { Path.GetFileNameWithoutExtension(f) };
        }
    }

    [Theory]
    [MemberData(nameof(Jobs))]
    public void JobFailsWithTheTeachingMessage(string jobName)
    {
        if (!StudioAvailable()) return;
        var jobPath = Path.Combine(Root, "tests", "jobs-negative", jobName + ".json");
        var job = JsonNode.Parse(File.ReadAllText(jobPath))!.AsObject();
        var expected = job["expectError"] is JsonArray a ? a.Select(x => x!.GetValue<string>()).ToList() : new List<string> { job["expectError"]!.GetValue<string>() };
        var host = new ModelHost(Work);
        Exception? caught = null;
        try { JobRunner.Run(host, null, jobPath, Path.Combine(Work, jobName + ".oml")); }
        catch (Exception ex) { caught = ex; }
        Assert.True(caught != null, $"{jobName}: o job devia falhar e passou");
        var text = Errors.Text(caught!);
        foreach (var e in expected)
            Assert.True(text.Contains(e, StringComparison.Ordinal), $"{jobName}: a mensagem nao contem '{e}':\n{text}");
    }

    [Fact]
    public void ErrorTextKeepsTheOpPrefixAndTheRootType()
    {
        var root = new KeyNotFoundException("no IMobileScreen named Catalog");
        var outer = new InvalidOperationException("op #4 (set Destination): KeyNotFoundException: no IMobileScreen named Catalog | extra", root);
        var wrapped = new System.Reflection.TargetInvocationException(outer);
        var (type, message, _) = Errors.Describe(wrapped);
        Assert.Equal("KeyNotFoundException", type);
        Assert.StartsWith("op #4 (set Destination)", message);
        Assert.EndsWith("| extra", message);
    }

    [Fact]
    public void ForwardRefsListsEveryUseBeforeCreate()
    {
        var json = """
        [
          {"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"Home","as":"$home"},
          {"op":"set","target":"$b1/OnClick","prop":"Destination","value":"IMobileScreen:Catalog"},
          {"op":"create","parent":"$home","type":"IButton","name":"B","as":"$b1"},
          {"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"Catalog","as":"$cat"}
        ]
        """;
        var ops = JsonNode.Parse(json)!.AsArray();
        var refs = ForwardRefs.Find(ops);
        Assert.Contains(refs, r => r.UsedAt == 1 && r.Reference == "IMobileScreen:Catalog" && r.CreatedAt == 3);
        Assert.Contains(refs, r => r.UsedAt == 1 && r.Reference == "$b1" && r.CreatedAt == 2);
        var text = ForwardRefs.Explain(ops, 1, "Catalog");
        Assert.Contains("created at op #3", text);
        Assert.Contains("$b1", text);
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(NegativeJobTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
