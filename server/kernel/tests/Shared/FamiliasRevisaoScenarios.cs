using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Linked into both test projects: the review of integration 24-1 familias (2026-10-13) through a real job on the lane's
/// fixture (JobRunner: preflight, apply, Verify), the same scenario on O11 and ODC.
/// (1) and (2): one screen with three problems of three rules, an identifier ordered against a number in an aggregate (the
/// preflight's patch), prose in a placeholder (the compile's patch) and an expression typed wrong in another placeholder (two
/// readings, no patch): every patched problem carries ONE patch with both corrections, the typo is never written as its literal,
/// and that patch with the typo fixed by hand is accepted.
/// (6) a file name in src is the module image of its base name, a Binary Data binding is the binary content, a URL with its
/// scheme is External (accepted); an unknown file name is refused with the nearest image as its patch, which is accepted.
/// (5) a rule for the inside of an svg is a problem of the same refusal.
/// </summary>
public static class FamiliasRevisaoScenarios
{
    private static string Roles(string lane) => lane == "odc" ? "" : " roles=\"Registered\"";
    // The test screens have no role on ODC: it warns (a message O11 does not have).
    private static JsonArray Expected(string lane) => lane == "odc"
        ? new JsonArray(new JsonObject { ["id"] = "AnonymousAccess_NoPermissions", ["all"] = true, ["why"] = "a test screen without a role" }) : new JsonArray();

    private static string Job(string dir, string name, string fixture, string lane, params JsonNode[] ops)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, new JsonObject { ["base"] = fixture, ["expectedMessages"] = Expected(lane), ["ops"] = new JsonArray(ops) }.ToJsonString());
        return path;
    }

    private static JsonObject Run(string dir, string job) => JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.ChangeExtension(job, ".oml")))!.AsObject();

    private static List<JsonObject> Refused(string dir, string job)
    {
        var error = Assert.ThrowsAny<Exception>(() => Run(dir, job));
        var coded = Errors.FindCoded(error);
        Assert.True(coded != null, Errors.Text(error));
        File.WriteAllText(Path.ChangeExtension(job, ".refusal.json"), coded!.Problems?.ToJsonString() + Environment.NewLine + Errors.Text(error));
        return (coded.Problems ?? new JsonArray()).OfType<JsonObject>().Where(p => p["severity"]?.ToString() != "warning").ToList();
    }

    private static JsonObject Html(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };

    public static void OneDocumentOnePatchAndATypoIsNeverItsLiteral(string dir, string fixture, string lane)
    {
        var spec = JsonNode.Parse("""{"op":"spec","data":{"entities":[{"name":"FamRevVisita","attributes":[{"name":"Nome","type":"Text","length":50}]}]}}""")!;
        const string typo = "placeholder=\"If(Busca = &quot;&quot;, &quot;Novo&quot;, &quot;Editar&quot;\"";
        var html = $"<screen name=\"FamRevTela\"{Roles(lane)}>\n<var name=\"Busca\" type=\"Text\"/>\n<var name=\"Nota\" type=\"Text\"/>\n"
            + "<aggregate name=\"FamRevVisitas\" from=\"FamRevVisita\" where=\"FamRevVisita.Id &gt; 10\" max=\"50\"/>\n"
            + "<input class=\"input\" placeholder=\"Buscar por nome, cidade\" bind=\"Busca\"/>\n"
            + $"<input class=\"input\" {typo} bind=\"Nota\"/>\n</screen>";
        var problems = Refused(dir, Job(dir, "rev-doc", fixture, lane, spec, Html(html)));
        var operand = Assert.Single(problems, p => p["code"]?.ToString() == "OPERAND_TYPES");
        var prose = problems.First(p => p["message"]!.ToString().Contains("Buscar por nome, cidade", StringComparison.Ordinal) && p["patch"] is JsonArray);
        var wrong = problems.Where(p => p["message"]!.ToString().Contains("If(Busca", StringComparison.Ordinal) || (p["message"] + " " + p["fix"]).Contains("not closed", StringComparison.Ordinal)).ToList();
        // (2) the expression typed wrong: refused, no patch, what its syntax lacks named.
        Assert.NotEmpty(wrong);
        Assert.All(wrong, p => Assert.Null(p["patch"]));
        Assert.Contains(wrong, p => (p["message"] + " " + p["fix"]).Contains("not closed", StringComparison.Ordinal));
        // (1) one patch for the document: every patched problem has the same one, with both corrections.
        Assert.NotNull(prose["patch"]);
        var patched = problems.Where(p => p["patch"] is JsonArray).ToList();
        Assert.Single(patched.Select(p => p["patch"]!.ToJsonString()).Distinct());
        var value = prose["patch"]!.AsArray().Single(s => s!["path"]!.ToString().EndsWith("/data/html", StringComparison.Ordinal))!["value"]!.GetValue<string>();
        Assert.Contains("placeholder='\"Buscar por nome, cidade\"'", value);
        Assert.DoesNotContain("placeholder='\"If(", value);
        if (operand["patch"] is JsonArray)
        {
            Assert.Contains("IdentifierToLongInteger(FamRevVisita.Id)", value);
            Assert.Equal(2, prose["patchJoins"]!.GetValue<int>());
        }
        // The patch, and the typo the author fixes: accepted in the next call.
        var fixedHtml = value.Replace(typo, typo[..^1] + ")\"");
        if (operand["patch"] is not JsonArray) fixedHtml = fixedHtml.Replace("FamRevVisita.Id &gt; 10", "IdentifierToLongInteger(FamRevVisita.Id) &gt; 10");
        var result = Run(dir, Job(dir, "rev-doc-fixed", fixture, lane, spec.DeepClone(), Html(fixedHtml)));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() + result["policyMessages"]?.ToJsonString());
    }

    private const string Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    private static JsonObject Image() => new() { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IImage", ["name"] = "FamRevLogo", ["args"] = new JsonObject { ["binary"] = Png, ["originalPath"] = "fam-rev-logo.png" } };

    public static void AnImageIsTheModulesByItsFileNameItsBinaryByTypeOrRefusedWithTheNearest(string dir, string fixture, string lane)
    {
        var html = $"<screen name=\"FamRevImagens\"{Roles(lane)}>\n<var name=\"Foto\" type=\"Binary Data\"/>\n"
            + "<img class=\"a\" src=\"assets/famrevlogo.png\"/>\n<img class=\"b\" src=\"{{ Foto }}\"/>\n<img class=\"c\" src=\"https://example.com/a.png\"/>\n</screen>";
        var result = Run(dir, Job(dir, "rev-img", fixture, lane, Image(), Html(html)));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString() + result["policyMessages"]?.ToJsonString());
        var text = result.ToJsonString();
        Assert.Contains("IMG_FILE_IMAGE", text);
        // A file name of no image: the nearest is the patch, accepted.
        var wrong = $"<screen name=\"FamRevImagem2\"{Roles(lane)}>\n<img class=\"a\" src=\"img/famrevlogoo.png\"/>\n</screen>";
        var problems = Refused(dir, Job(dir, "rev-img-wrong", fixture, lane, Image(), Html(wrong)));
        var problem = Assert.Single(problems);
        Assert.Equal("HTML_IMAGE_FILE", problem["code"]!.ToString());
        var value = problem["patch"]!.AsArray().Single()!["value"]!.GetValue<string>();
        Assert.Contains("src=\"FamRevLogo\"", value);
        var again = Run(dir, Job(dir, "rev-img-patched", fixture, lane, Image(), Html(value)));
        Assert.True(again["accepted"]!.GetValue<bool>(), again["details"]?.ToJsonString());
    }

    public static void ARuleForTheInsideOfAnSvgIsAProblemOfTheSameRefusal(string dir, string fixture, string lane)
    {
        var html = $"<screen name=\"FamRevSvg\"{Roles(lane)}>\n<style>.fam-ico path{{stroke:red}}</style>\n"
            + "<span class=\"fam-ico\"><svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\"><path d=\"M5 12h14\"/></svg></span>\n</screen>";
        var problems = Refused(dir, Job(dir, "rev-svg", fixture, lane, Html(html)));
        var problem = Assert.Single(problems);
        Assert.Equal("HTML_SVG_INNER_CSS", problem["code"]!.ToString());
        Assert.Contains(".fam-ico path", problem["message"]!.ToString());
    }
}
