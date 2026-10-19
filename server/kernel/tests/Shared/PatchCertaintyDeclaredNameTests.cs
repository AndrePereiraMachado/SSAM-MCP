using System.Security;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>Option B of the owner (2026-10-17): a word of three letters or more one slip (Damerau: a letter replaced, removed,
/// added, or two neighbours swapped; also two letters swapped apart, Costumer for Customer) from a name the job or the compiled
/// page declares is a choice, never a quoted literal.
/// Brackets and an underscore between letters are code shapes. Names of the module and its references count only when written
/// exactly (or with two neighbours swapped): one letter from a System name (Usr, Emal) stays certain, the accepted limit.</summary>
public sealed class PatchCertaintyDeclaredNameTests
{
    private const string Declarations = "<var name='Hint' type='Text'/><var name='Customer' type='Text'/>";

    [Theory]
    [InlineData("Hunt obrigatorio")]
    [InlineData("Hnt obrigatorio")]
    [InlineData("Hiint obrigatorio")]
    [InlineData("Hints obrigatorio")]
    [InlineData("Hunt: obrigatorio")]
    [InlineData("Custmer obrigatorio")]
    [InlineData("Costumer obrigatorio")]
    [InlineData("hunt obrigatorio")]
    public void AOneLetterSlipOfANamesThePageDeclaresIsAChoice(string text)
        => AssertChoice(PatchCertaintyJobProbe.Run("declared-name-slip", PatchCertaintyJobProbe.Flow("SlipFlow"),
            PatchCertaintyJobProbe.Screen("SlipProbe", "SlipFlow", Declarations + Input(text))));

    [Theory]
    [InlineData("Lista[0] obrigatorio")]
    [InlineData("Itens[1] selecionado")]
    [InlineData("nome_cliente obrigatorio")]
    [InlineData("Itens] selecionados")]
    public void BracketsAndUnderscoresBetweenLettersAreCodeShapes(string text)
        => AssertChoice(PatchCertaintyJobProbe.Run("declared-name-shape", PatchCertaintyJobProbe.Flow("ShapeFlow"),
            PatchCertaintyJobProbe.Screen("ShapeProbe", "ShapeFlow", Input(text))));

    [Fact]
    public void ASlipOfANameAnotherPageOfTheJobDeclaresIsAChoice()
        => AssertChoice(PatchCertaintyJobProbe.Run("declared-name-job", PatchCertaintyJobProbe.Flow("JobSlipFlow"),
            PatchCertaintyJobProbe.Screen("JobSlipFirst", "JobSlipFlow", Declarations + "<var name='Q0' type='Text'/><input bind='Q0'/>"),
            PatchCertaintyJobProbe.Screen("JobSlipSecond", "JobSlipFlow", Input("Hunt obrigatorio"))));

    [Fact]
    public void ASlipOfAnActionTheJobDeclaresIsAChoice()
        => AssertChoice(PatchCertaintyJobProbe.Run("declared-name-action", PatchCertaintyJobProbe.Flow("ActionSlipFlow"),
            PatchCertaintyJobProbe.Screen("ActionSlipProbe", "ActionSlipFlow", Input("Arqivar pedido")),
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(new JsonObject {
                ["name"] = "Arquivar", ["steps"] = new JsonArray() }) } }));

    [Theory]
    [InlineData("Buscar por nome")]
    [InlineData("Nome completo")]
    [InlineData("Soma itens")]
    [InlineData("Telefone com DDD")]
    public void NeutralProseNextToDeclaredNamesStaysACertainLiteral(string text)
    {
        var (result, saved) = PatchCertaintyJobProbe.Run("declared-name-control", PatchCertaintyJobProbe.Flow("ControlFlow"),
            PatchCertaintyJobProbe.Screen("ControlProbe", "ControlFlow", Declarations + Input(text)));
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        Assert.True(saved);
        var applied = Assert.IsType<JsonArray>(result["patchesApplied"]).OfType<JsonObject>().ToList();
        Assert.Single(applied);
        Assert.Equal("TEXT_LITERAL_QUOTED", applied[0]["patchRule"]?.ToString());
    }

    [Theory]
    [InlineData("Hint", "Hunt", true)]
    [InlineData("Hint", "Hnt", true)]
    [InlineData("Hint", "Hiint", true)]
    [InlineData("Hint", "Hints", true)]
    [InlineData("Hint", "Hnit", true)]
    [InlineData("Customer", "Custmer", true)]
    [InlineData("Customer", "Costumer", true)]
    [InlineData("Customer", "customer", true)]
    [InlineData("Hint", "Hunts", false)]
    [InlineData("Hint", "Hit", true)]
    [InlineData("Hint", "Hn", false)]
    [InlineData("Customer", "Costumers", false)]
    [InlineData("Name", "Nome", true)]
    [InlineData("Total", "Soma", false)]
    public void OneSlipIsOneLetterReplacedRemovedAddedOrTwoLettersSwapped(string name, string word, bool expected)
    {
        Assert.Equal(expected, ScreenHtml.OneSlipApart(name, word));
        Assert.Equal(expected, ScreenHtml.OneSlipApart(word, name));
    }

    [Theory]
    [InlineData("Hunt obrigatorio")]
    [InlineData("Hnt obrigatorio")]
    [InlineData("Hiint obrigatorio")]
    [InlineData("Hints obrigatorio")]
    [InlineData("Hunt: obrigatorio")]
    [InlineData("Custmer obrigatorio")]
    [InlineData("Costumer obrigatorio")]
    [InlineData("Lista[0] obrigatorio")]
    [InlineData("Itens[1] selecionado")]
    [InlineData("nome_cliente obrigatorio")]
    [InlineData("valor_1 obrigatorio")]
    public void TheRuleRefusesCertaintyForSlipsOfDeclaredNamesAndCodeShapes(string text)
        => Assert.False(ScreenHtml.CertainLiteral(text, ["Hint", "Customer"], ["Hint", "Customer", "Value"]));

    [Theory]
    [InlineData("Buscar por nome")]
    [InlineData("Nome completo")]
    [InlineData("Soma itens")]
    [InlineData("Telefone com DDD")]
    public void ProseNextToDeclaredAndSystemNamesStaysCertain(string text)
        => Assert.True(ScreenHtml.CertainLiteral(text, ["Hint", "Customer", "User", "Name", "Email"], ["Hint", "Customer", "Value", "W0", "W10"]));

    /// <summary>The owner's accepted limit (2026-10-17): one letter from a name of the module or its references that the job and
    /// the page do not declare stays certain, System's User and Email included. Option A would refuse these, and with them the
    /// prose "Nome completo" (one letter from System's Name) in almost every module.</summary>
    [Theory]
    [InlineData("Usr obrigatorio")]
    [InlineData("Emal obrigatorio")]
    [InlineData("Nane completo")]
    public void OneLetterFromANameNobodyDeclaredStaysCertainAsTheOwnersAcceptedLimit(string text)
        => Assert.True(ScreenHtml.CertainLiteral(text, ["User", "Email", "Name"], ["Hint", "Customer", "Value"]));

    private static string Input(string text) => "<var name='Value' type='Text'/><input bind='Value' placeholder=\"" + SecurityElement.Escape(text) + "\"/>";

    private static void AssertChoice((JsonObject Result, bool Saved) run)
    {
        var (result, saved) = run;
        Assert.False(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        Assert.False(saved, "a choice saves nothing");
        Assert.Null(result["patchesApplied"]);
        var literals = (result["problems"] as JsonArray ?? []).OfType<JsonObject>().Where(p => p["code"]?.ToString() == "HTML_INVALID").ToList();
        Assert.NotEmpty(literals);
        Assert.All(literals, p => {
            Assert.Equal("TEXT_LITERAL_CHOICE", p["patchRule"]?.ToString());
            Assert.False(PatchCertainty.IsCertain(p), p.ToJsonString());
        });
    }
}

/// <summary>Runs a small job on the lane's reactive fixture. A refusal answers with its coded problems.</summary>
internal static class PatchCertaintyJobProbe
{
    internal static string Lane => typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") != null ? "odc" : "o11";

    internal static JsonObject Flow(string name) => new() { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IMobileFlow", ["name"] = name };

    internal static JsonObject Screen(string name, string flow, string body)
        => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = $"<screen name='{name}' flow='{flow}'>{body}</screen>" } };

    internal static (JsonObject Result, bool Saved) Run(string work, params JsonObject[] ops)
    {
        var kernel = Path.Combine(TextRoundTripCorpus.Root()!, "kernel");
        var fixture = Path.Combine(kernel, "tests", "fixtures", Lane == "odc" ? "odc/blank-mobile.oml" : "reactive-ui.oml");
        var directory = Path.Combine(kernel, ".local", work, Lane, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var job = new JsonObject { ["expectValid"] = true, ["ops"] = new JsonArray(ops.Select(o => (JsonNode)o).ToArray()) };
        if (Lane == "odc") job["expectedMessages"] = new JsonArray(new JsonObject {
            ["id"] = "AnonymousAccess_NoPermissions", ["all"] = true, ["why"] = "a test screen without a role" });
        var jobPath = Path.Combine(directory, "job.json"); File.WriteAllText(jobPath, job.ToJsonString());
        var output = Path.Combine(directory, "candidate.oml");
        try {
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(directory, "runtime")), fixture, jobPath, output))!.AsObject();
            return (result, File.Exists(output));
        }
        catch (Exception error) {
            var coded = Errors.FindCoded(error);
            Assert.True(coded != null, Errors.Text(error));
            return (new JsonObject { ["accepted"] = false, ["code"] = coded!.Code, ["problems"] = coded.Problems?.DeepClone() }, File.Exists(output));
        }
    }
}
