using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 2, lane F2 (A02 items 5 and 6, A04 with the base): the apply that collects everything, on the disposable copy
/// of the base. Every failing op is recorded with phase "apply", what depends on it is skipped (never repeated as a failure
/// of its own) and the job is refused once, before the Verify and before anything is saved. What only the base can answer
/// (a child of a path, a callee of the module, the attributes of a module entity, the module type) is refused with phase
/// "base", all at once, before the first op.
/// </summary>
public sealed class Pa2F2ApplyTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    private static string Dir()
    {
        var dir = Path.Combine(Root, ".local", "pa2-f2-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static (JsonNode? Result, Exception? Error, string Output) Run(string dir, string name, string job, string? output = null)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        output ??= Path.Combine(dir, name + ".oml");
        try { return (JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, output)), null, output); }
        catch (Exception ex) { return (null, ex, output); }
    }

    [Fact]
    public void ThreeIndependentApplyFailuresAreRefusedOnceWithEveryProblemAndTheDependentsSkipped()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        // A child that is not there (its dependent is skipped), a property the node does not write, an enum value that does not
        // exist: three rounds before, one refusal now. The targets are paths and keys, which only the apply resolves.
        var (_, error, output) = Run(dir, "three", """
        {"base":"blank-service.oml","ops":[
          {"op":"spec","data":{"entities":[{"name":"Pa2Pedido","attributes":[{"name":"Cliente","type":"Text"}]}]}},
          {"op":"logic","data":{"actions":[{"name":"Pa2Calcular","public":true,"inputs":[{"name":"N","type":"Integer"}],"outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"N"}}]}]}},
          {"op":"create","parent":"IServerAction:Pa2Calcular/NaoExiste","type":"IInputParameter","name":"Extra","as":"$extra"},
          {"op":"set","target":"$extra","prop":"Description","value":"skipped: it uses $extra"},
          {"op":"set","target":"IServerAction:Pa2Calcular/#IStartNode","prop":"Destination","value":"IServerAction:Pa2Calcular"},
          {"op":"set","target":"@espace/Pa2Pedido/Cliente","prop":"DeleteRule","value":"Cascade"}]}
        """);
        Assert.NotNull(error);
        var refused = Assert.IsType<JobPreflightException>(error);
        Assert.Equal("PREFLIGHT_REFUSED", refused.Code);
        var problems = refused.Problems.OfType<JsonObject>().ToArray();
        Assert.Equal(new[] { 2, 4, 5 }, problems.Select(p => p["op"]!.GetValue<int>()));
        Assert.Equal(new[] { "CHILD_NOT_FOUND", "PROPERTY_NOT_WRITABLE", "ENUM_VALUE_INVALID" }, problems.Select(p => p["code"]!.GetValue<string>()));
        Assert.All(problems, p => Assert.Equal("apply", p["phase"]!.GetValue<string>()));
        Assert.All(problems, p => Assert.StartsWith("/ops/" + p["op"], p["pointer"]!.GetValue<string>()));
        Assert.All(problems, p => Assert.False(string.IsNullOrWhiteSpace(p["fix"]?.GetValue<string>())));
        // The dependent is skipped and named, never a fourth problem.
        Assert.Contains("op #3 skipped", refused.Message);
        Assert.Contains(refused.Warnings.OfType<JsonObject>(), w => w["code"]!.GetValue<string>() == "APPLY_SKIPPED" && w["op"]!.GetValue<int>() == 3);
        // Each failure keeps its own text, and nothing was saved.
        Assert.Contains("has no child 'NaoExiste'", refused.Message);
        Assert.Contains("has no writable property or setter 'Destination'", refused.Message);
        Assert.Contains("Invalid", refused.Message);
        Assert.False(File.Exists(output));
        Assert.Equal("PREFLIGHT_REFUSED", Errors.Envelope("apply", error!, 1)["code"]!.GetValue<string>());
    }

    [Fact]
    public void OneUncodedFailureIsAPreflightRefusalWithItsOwnTextAndACodedOneKeepsItsCode()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var (_, single, _) = Run(dir, "single", """
        {"base":"blank-service.oml","ops":[
          {"op":"logic","data":{"actions":[{"name":"Pa2Um","public":true,"inputs":[{"name":"N","type":"Integer"}],"outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"N"}}]}]}},
          {"op":"set","target":"IServerAction:Pa2Um/#IStartNode","prop":"Destination","value":"IServerAction:Pa2Um"}]}
        """);
        var refused = Assert.IsType<JobPreflightException>(single);
        var problem = Assert.Single(refused.Problems)!;
        Assert.Equal("PROPERTY_NOT_WRITABLE", problem["code"]!.GetValue<string>());
        Assert.Equal("apply", problem["phase"]!.GetValue<string>());
        Assert.StartsWith("op #1 (set Destination): ", Errors.Describe(single!).Message);

        // DELETE_HAS_CONSUMERS stays the refusal tools already read, now with the phase; with another failure both go in one.
        const string caller = """{"op":"logic","data":{"actions":[{"name":"Pa2Chamador","public":true,"outputs":[{"name":"Out","type":"Integer"}],"steps":[{"call":"Pa2Alvo","as":"Alvo"},{"assign":{"Out":"Alvo.Out"}}]},{"name":"Pa2Alvo","outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"1"}}]}]}}""";
        var (_, coded, _) = Run(dir, "coded", "{\"base\":\"blank-service.oml\",\"ops\":[" + caller + ",{\"op\":\"delete\",\"target\":\"IServerAction:Pa2Alvo\"}]}");
        var consumers = Errors.FindCoded(coded!)!;
        Assert.Equal("DELETE_HAS_CONSUMERS", consumers.Code);
        Assert.All(consumers.Problems!, p => Assert.Equal("apply", p!["phase"]!.GetValue<string>()));
        var (_, both, _) = Run(dir, "both", "{\"base\":\"blank-service.oml\",\"ops\":[" + caller + ",{\"op\":\"delete\",\"target\":\"IServerAction:Pa2Alvo\"},"
            + "{\"op\":\"set\",\"target\":\"IServerAction:Pa2Chamador/#IStartNode\",\"prop\":\"Destination\",\"value\":\"IServerAction:Pa2Alvo\"}]}");
        var all = Assert.IsType<JobPreflightException>(both);
        Assert.Contains(all.Problems, p => p!["code"]!.GetValue<string>() == "DELETE_HAS_CONSUMERS" && p["op"]!.GetValue<int>() == 1);
        Assert.Contains(all.Problems, p => p!["code"]!.GetValue<string>() == "PROPERTY_NOT_WRITABLE" && p["op"]!.GetValue<int>() == 2);
    }

    [Fact]
    public void ANameTheStudioWouldRenameInSilenceIsANameCollisionAtApply()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var (_, error, output) = Run(dir, "collision", """
        {"base":"blank-service.oml","ops":[
          {"op":"create","parent":"@espace","type":"IServerAction","name":"Pa2ObterCardapio","as":"$a"},
          {"op":"create","parent":"$a","type":"IOutputParameter","name":"Categorias","as":"$o1"},
          {"op":"create","parent":"$a","type":"IOutputParameter","name":"Categorias","as":"$o2"}]}
        """);
        var refused = Assert.IsType<JobPreflightException>(error);
        var problem = Assert.Single(refused.Problems, p => p!["phase"]!.GetValue<string>() == "apply")!;
        Assert.Equal("NAME_COLLISION", problem["code"]!.GetValue<string>());
        Assert.Equal(2, problem["op"]!.GetValue<int>());
        Assert.Contains("Categorias2", problem["message"]!.GetValue<string>());
        // primeira-certa A2: the Verify of what did apply joins the refusal (the raw action has no Start), never a later round.
        Assert.Contains(refused.Problems, p => p!["phase"]!.GetValue<string>() == "verify" && p["code"]!.GetValue<string>() == "InvalidFlow_NoStart" && p["op"]!.GetValue<int>() == 0);
        Assert.False(File.Exists(output));
    }

    /// <summary>A base built by a job of its own (the module the job edits), so the base check reads its entities and actions.
    /// It is written under a `work` folder of .local, which JobSources accepts as a capture of the SSAM.</summary>
    private static string Base(string dir)
    {
        var (result, error, output) = Run(dir, "base", """
        {"base":"blank-service.oml","ops":[
          {"op":"spec","data":{"entities":[
            {"name":"Pa2Ticket","public":true,"attributes":[{"name":"Titulo","type":"Text"}]},
            {"name":"Pa2UserAccessScope","public":true,"attributes":[{"name":"RoleId","type":"Long Integer"}]}]}},
          {"op":"logic","data":{"actions":[{"name":"Pa2Gravar","public":true,"inputs":[{"name":"TicketId","type":"Pa2Ticket Identifier"},{"name":"Nota","type":"Text","mandatory":false}],
            "outputs":[{"name":"Ok","type":"Boolean"}],"steps":[{"assign":{"Ok":"TicketId <> NullIdentifier() and Nota <> \"\""}}]},
            {"name":"Pa2Listar","public":true,"outputs":[{"name":"N","type":"Long Integer"}],"steps":[{"get":"Pa2Ticket","as":"Tickets","where":"Pa2Ticket.Titulo <> \"\""},{"assign":{"N":"Tickets.Count"}}]}]}}]}
        """, Path.Combine(dir, "work", "base.oml"));
        Assert.True(error == null, error?.ToString());
        Assert.True(result!["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        return output;
    }

    [Fact]
    public void WhatOnlyTheBaseAnswersIsRefusedAllAtOnceBeforeTheFirstOp()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var basePath = Base(dir).Replace('\\', '/');
        // A callee of the module without its mandatory input; an aggregate over a module entity read without the entity; a child
        // the module does not have (the real case: `IServerEntity 'UserAccessScope' has no child 'IEntityIndex:AutoIndex_RoleId'`).
        var (_, error, output) = Run(dir, "against-base", $$$"""
        {"base":"{{{basePath}}}","ops":[
          {"op":"logic","data":{"actions":[{"name":"Pa2Fechar","public":true,"inputs":[{"name":"Id","type":"Pa2Ticket Identifier"}],"outputs":[{"name":"T","type":"Text"}],"steps":[
            {"call":"Pa2Gravar","as":"Gravar","args":{"Notas":"\"x\""}},
            {"get":"Pa2Ticket","as":"Tickets","where":"Pa2Ticket.Id = Id","max":1},
            {"if":"not Tickets.List.Empty","then":[{"assign":{"T":"Tickets.List.Current.Pa2Ticket.Titlo"}}]}]}]}},
          {"op":"delete","target":"IServerEntity:Pa2UserAccessScope/IEntityIndex:AutoIndex_Role"},
          {"op":"set","target":"IServerAction:Pa2Listar/Tickets/**IFilter","prop":"Condition","value":"CheckPa2AdminRole(Pa2Ticket.Titulo)"}]}
        """);
        var refused = Assert.IsType<JobPreflightException>(Errors.FindCoded(error!));
        var problems = refused.Problems.OfType<JsonObject>().ToArray();
        Assert.All(problems, p => Assert.Equal("base", p["phase"]!.GetValue<string>()));
        Assert.Contains(problems, p => p["code"]!.GetValue<string>() == "REQUIRED_ARGUMENT" && p["message"]!.GetValue<string>().Contains("'TicketId'"));
        Assert.Contains(problems, p => p["code"]!.GetValue<string>() == "ARGUMENT_UNKNOWN" && p["fix"]!.GetValue<string>().Contains("Nota"));
        // Only the base knows the attributes of Pa2Ticket: the pure preflight left it, the base check answers it.
        Assert.Contains(problems, p => p["code"]!.GetValue<string>() == "EXPR_UNKNOWN_IDENTIFIER" && p["fix"]!.GetValue<string>().Contains("Titulo"));
        var child = Assert.Single(problems, p => p["code"]!.GetValue<string>() == "CHILD_NOT_FOUND");
        Assert.Equal("/ops/1/target", child["pointer"]!.GetValue<string>());
        Assert.Contains("AutoIndex_Role", child["message"]!.GetValue<string>());
        // A raw correction of a filter of the module (the real case: a role check given an attribute of the aggregate).
        var raw = Assert.Single(problems, p => p["code"]!.GetValue<string>() == "DB_FUNCTION_IN_AGGREGATE");
        Assert.Equal("/ops/2/value", raw["pointer"]!.GetValue<string>());
        Assert.False(File.Exists(output));

        // The same job written right applies.
        var (result, fine, _) = Run(dir, "against-base-right", $$$"""
        {"base":"{{{basePath}}}","ops":[
          {"op":"logic","data":{"actions":[{"name":"Pa2Fechar","public":true,"inputs":[{"name":"Id","type":"Pa2Ticket Identifier"}],"outputs":[{"name":"T","type":"Text"}],"steps":[
            {"call":"Pa2Gravar","as":"Gravar","args":{"TicketId":"Id","Nota":"\"x\""}},
            {"get":"Pa2Ticket","as":"Tickets","where":"Pa2Ticket.Id = Id","max":1},
            {"if":"not Tickets.List.Empty and Gravar.Ok","then":[{"assign":{"T":"Tickets.List.Current.Pa2Ticket.Titulo"}}]}]}]}}]}
        """);
        Assert.True(fine == null, fine?.ToString());
        Assert.True(result!["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
    }
}
