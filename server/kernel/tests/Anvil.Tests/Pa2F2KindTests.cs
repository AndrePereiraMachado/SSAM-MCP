using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 2, lane F2 (A27): a kind is accepted with or without the I of its interface (`ServerActionSignature:X` is
/// `IServerActionSignature:X`), in the verbs and in the preflight that checks references against the base; in a client
/// flow, between a client and a server action of the same name that the reference admits, the client one is taken; and an
/// unresolved reference lists the candidates with their keys. The real case: `no ServerActionSignature named ListFilter;
/// objects with that name: IClientActionSignature, IServerActionSignature`.
/// </summary>
public sealed class Pa2F2KindTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    [Fact]
    public void AKindWithoutItsIIsCompletedOnlyWhenTheInterfaceExists()
    {
        Assert.Equal("IServerActionSignature", KindNames.Normalize("ServerActionSignature"));
        Assert.Equal("IServerAction", KindNames.Normalize("ServerAction"));
        Assert.Equal("IServerAction", KindNames.Normalize("IServerAction"));
        Assert.Equal("Note", KindNames.Normalize("Note"));   // no interface INote: a colon in plain text stays plain text
        Assert.Equal("", KindNames.Normalize(""));
    }

    [Fact]
    public void ThePreflightChecksAKindlessReferenceAgainstTheBaseAndLeavesTextValuesAlone()
    {
        var ops = JsonNode.Parse("""
        [{"op":"set","target":"ServerActionSignature:Pa2Missing","prop":"Description","value":"Note: not a reference"},
         {"op":"set","target":"IServerAction:Pa2Other","prop":"Description","value":"x"}]
        """)!.AsArray();
        var found = JobPreflight.BaseReferences(ops, "/ops");
        Assert.Equal(new[] { "IServerActionSignature:Pa2Missing", "IServerAction:Pa2Other" }, found.Select(r => r.Reference));
        Assert.Equal("IServerActionSignature", found[0].Type);
        Assert.Equal("/ops/0/target", found[0].Pointer);
    }

    private sealed record Candidate(string Name, string Kind, bool Client);

    [Fact]
    public void AClientFlowPrefersTheClientActionOfTheSameName()
    {
        var server = new Candidate("ListFilter", "IServerActionSignature", false);
        var client = new Candidate("ListFilter", "IClientActionSignature", true);
        Candidate[] traversal = [server, client];
        // Without a flow: the traversal order decides between equals, as before.
        Assert.Same(server, ReferencePrecedence.Prefer(traversal, c => c.Name, c => c.Kind, "IActionSignature", "ListFilter"));
        // In a client flow: the client one.
        Assert.Same(client, ReferencePrecedence.Prefer(traversal, c => c.Name, c => c.Kind, "IActionSignature", "ListFilter", c => c.Client));
        // An explicit kind still decides alone (exact kind outranks the flow).
        Assert.Same(server, ReferencePrecedence.Prefer(traversal, c => c.Name, c => c.Kind, "IServerActionSignature", "ListFilter", c => c.Client));
        // And the exact-case name still comes first.
        var lower = new Candidate("listfilter", "IClientActionSignature", true);
        Assert.Same(server, ReferencePrecedence.Prefer(new[] { lower, server }, c => c.Name, c => c.Kind, "IActionSignature", "ListFilter", c => c.Client));
    }

    [Fact]
    public void TheVerbsResolveAKindlessReferenceAndAClientCallTakesTheClientSignature()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Path.Combine(Root, ".local", "pa2-f2-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "kinds.json");
        // reactive-ui references (System) ListAppend both as a server and as a client action signature.
        File.WriteAllText(job, """
        {"base":"reactive-ui.oml","expectValid":false,"ops":[
          {"op":"get","target":"ServerActionSignature:Login"},
          {"op":"get","target":"ServerActionSignature:ListAppend"},
          {"op":"logic","data":{"actions":[
            {"name":"Pa2Juntar","kind":"client","inputs":[{"name":"Texto","type":"Text"}],"vars":[{"name":"Lista","type":"Text List"}],"steps":[
              {"call":"IActionSignature:ListAppend","as":"Juntar","args":{"List":"Lista","Element":"Texto"}}]},
            {"name":"Pa2JuntarServidor","inputs":[{"name":"Texto","type":"Text"}],"vars":[{"name":"Lista","type":"Text List"}],"steps":[
              {"call":"IActionSignature:ListAppend","as":"Juntar","args":{"List":"Lista","Element":"Texto"}}]}]}},
          {"op":"get","target":"IClientAction:Pa2Juntar/Juntar"},
          {"op":"get","target":"IServerAction:Pa2JuntarServidor/Juntar"}]}
        """);
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.Combine(dir, "kinds.oml")))!;
        var results = result["results"]!.AsArray();
        Assert.Equal("IServerActionSignature", results[0]!["result"]!["type"]!.GetValue<string>());
        Assert.Equal("Login", results[0]!["result"]!["name"]!.GetValue<string>());
        Assert.Equal("IServerActionSignature", results[1]!["result"]!["type"]!.GetValue<string>());
        Assert.Contains("ExecuteClientActionNode", results[3]!["result"]!["type"]!.GetValue<string>());
        Assert.Contains("ExecuteServerActionNode", results[4]!["result"]!["type"]!.GetValue<string>());
    }

    [Fact]
    public void AChildByATypedNameResolves()
    {
        // The real cases: `IMobileScreen 'Completion' has no child 'ILocalVariable:CompleteForm'`, `IMobileScreen 'MeusRestaurantes'
        // has no child 'IScreenAction:MeusRestaurantes_Carregar'` while that child was listed. A name never holds a colon.
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Path.Combine(Root, ".local", "pa2-f2-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "typed.json");
        File.WriteAllText(job, """
        {"base":"blank-service.oml","expectValid":false,"ops":[
          {"op":"logic","data":{"actions":[{"name":"Pa2Tipado","public":true,"inputs":[{"name":"N","type":"Integer"}],"outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"N"}}]}]}},
          {"op":"get","target":"IServerAction:Pa2Tipado/IInputParameter:N"},
          {"op":"get","target":"IServerAction:Pa2Tipado/OutputParameter:Out"}]}
        """);
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.Combine(dir, "typed.oml")))!;
        Assert.Equal("N", result["results"]![1]!["result"]!["name"]!.GetValue<string>());
        Assert.Equal("Out", result["results"]![2]!["result"]!["name"]!.GetValue<string>());
    }

    [Fact]
    public void AnUnresolvedKindListsTheCandidatesWithTheirKeys()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Path.Combine(Root, ".local", "pa2-f2-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "candidates.json");
        File.WriteAllText(job, """{"base":"reactive-ui.oml","ops":[{"op":"get","target":"IStructure:ListAppend"}]}""");
        var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.Combine(dir, "candidates.oml")));
        var text = Errors.Text(error);
        Assert.Contains("objects with that name: ", text);
        Assert.Matches(@"IClientActionSignature \(@[^)]+\)", text);
        Assert.Matches(@"IServerActionSignature \(@[^)]+\)", text);
    }
}
