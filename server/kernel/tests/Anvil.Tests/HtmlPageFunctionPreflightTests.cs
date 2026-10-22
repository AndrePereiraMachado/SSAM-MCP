using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.PreflightRules;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The html-path findings of the UI-Mockup diagnosis of 2026-10-11 (an\DIAGNOSTICO.md, G5 and G6) closed in the engine:
/// G5, an unknown function in the bindings of an html page op (job 0314 of the html replay reached the Verify with 18
/// ExpressionUnknownFunction 'Lower') is refused once with autoPatch:false, or repaired with a receipt by default;
/// G6, the Values/Labels of a Dropdown read as List.Current (12 ExpressionUnknownObject + 6 CustomObjectError in the same
/// job) are refused from the job alone with the patch that reads the element's attributes, and the select hint of the page
/// form no longer teaches List.Current.
/// </summary>
public sealed class HtmlPageFunctionPreflightTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HtmlPageFunctionPreflightTests).Assembly.Location)!)!;

    // ---- G5: the expressions of a page op ---------------------------------------------------------------------------------

    [Fact]
    public void G5_TheExpressionsOfAPageAreItsBindingsSourcesAndVariableDefaultsWithTheirPointers()
    {
        var data = JsonNode.Parse("""
            {"screen":"P","title":"Lower(x)","vars":[{"name":"A","type":"Text"},{"name":"B","type":"Integer","default":"1 + 1"}],
             "sources":[{"entity":"Incident","as":"Get","where":["Incident.Title <> \"\"","Lower(Incident.Title) = A"],"sort":[["Incident.Title","Ascending"]]},
                        {"action":"Read","as":"R","args":{"Q":"Lower(A)"}}],
             "scripts":[{"name":"Fmt","inputs":[],"outputs":[{"name":"R","type":"Text"}],"code":"$parameters.R = Lower('x');"}],
             "search":{"key":"s","field":"Title","label":"Buscar (nome)"},
             "bindings":{"t":{"kind":"text","value":"Lower(A)"},"v":{"kind":"visible","condition":"A <> \"\""},"c":{"kind":"class","value":"\"x\""},
                         "st":{"kind":"style","value":"\"width:1px\""},"n":{"kind":"navigate","destination":"Home","args":{"Id":"B"}},
                         "k":{"kind":"call","action":"Go","args":{"a/b":"B + 1"}},"b":{"kind":"block","block":"Card","args":{"X":"A"}},
                         "f":{"kind":"field","field":"Title"},"l":{"kind":"list","source":"Get"},"d":{"kind":"date","variable":"D","format":"dd(MM)"},
                         "s":{"kind":"search","variable":"A","label":"Lower (x)"}}}
            """)!.AsObject();
        var sites = HtmlExpander.Expressions(data).ToList();
        Assert.Equal(new[]
        {
            "/vars/1/default", "/sources/0/where/0", "/sources/0/where/1", "/sources/0/sort/0/0", "/sources/1/args/Q",
            "/bindings/t/value", "/bindings/v/condition", "/bindings/c/value", "/bindings/st/value", "/bindings/n/args/Id",
            "/bindings/k/args/a~1b", "/bindings/b/args/X",
        }, sites.Select(s => s.Pointer));
        Assert.Equal("Lower(Incident.Title) = A", sites.Single(s => s.Pointer == "/sources/0/where/1").Text);
        // the title, the labels, the date format and the JavaScript of the scripts are not expressions
        Assert.DoesNotContain(sites, s => s.Text.Contains("Lower('x')") || s.Text == "Lower(x)" || s.Text.Contains("Lower (x)"));
    }

    /// <summary>The real case: job 0314 (FarmaVirtual into Haiku_UI, 2026-10-10 20:37) and its 18 sites of 'Lower'.</summary>
    [Fact]
    public void G5_TheEighteenLowerSitesOfJob0314AreExpressionsOfItsPageOp()
    {
        var bindings = new JsonObject();
        foreach (var key in new[] { "fv.60", "fv.61" }) bindings[key] = JsonNode.Parse("""{"kind":"text","value":"IntegerToText(If(Index(Lower(Client.FvNome1), Lower(Busca)) >= 0, 1, 0))"}""");
        foreach (var key in new[] { "fv.33", "fv.38", "fv.43", "fv.47", "fv.51", "fv.55", "fv.59", "fv.64", "fv.238", "fv.244", "fv.250", "fv.256", "fv.262", "fv.268", "fv.274", "fv.280" })
            bindings[key] = JsonNode.Parse("""{"kind":"visible","condition":"GestaoBusca = \"\" or Index(Lower(Client.FvNome1), Lower(GestaoBusca)) >= 0"}""");
        var data = new JsonObject { ["screen"] = "FarmaVirtual", ["html"] = "<p>x</p>", ["bindings"] = bindings };
        Assert.Equal(18, HtmlExpander.Expressions(data).Count(s => s.Text.Contains("Lower(", StringComparison.Ordinal)));
    }

    /// <summary>Explicit refusal and automatic repair are separate page-function contracts.</summary>
    [Fact]
    public void G5_AnUnknownFunctionOfThePageBindingsIsRefusedOnceWithThePatchThatRenamesItInEveryBinding()
        => CheckPageRefusal("Lower", "ToLower");

    [Fact]
    public void G5_AnotherCertainFunctionIsRefusedOnceWithEveryBindingInItsPatch()
        => CheckPageRefusal("Upper", "ToUpper");

    private static void CheckPageRefusal(string function, string replacement)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch("g5-refusal");
        var job = PageJob(function);
        // Certain renames are automatic by default. This contract requests the verified refusal.
        job["autoPatch"] = false;
        var (error, _) = Run(dir, "lower", job);
        var refused = Assert.IsType<JobPreflightException>(Errors.FindCoded(error!));
        var problems = refused.Problems.OfType<JsonObject>().ToList();
        var unknown = Assert.Single(problems, p => p["code"]!.GetValue<string>() == "FUNCTION_UNKNOWN");
        Assert.Equal("base", unknown["phase"]!.GetValue<string>());
        Assert.Equal(0, unknown["op"]!.GetValue<int>());
        Assert.Contains("'" + function + "('", unknown["message"]!.GetValue<string>());
        Assert.Contains(replacement, unknown["fix"]!.GetValue<string>());
        var patch = unknown["patch"]!.AsArray().OfType<JsonObject>().ToDictionary(p => p["path"]!.GetValue<string>(), p => p["value"]!.GetValue<string>());
        Assert.Equal(PageRepairs(replacement), patch);
        // the page's own client function is no unknown function, and the Verify's ExpressionUnknownFunction of the same op is
        // the same fault: not a second problem
        Assert.DoesNotContain(problems, p => p["message"]!.GetValue<string>().Contains("'Twice", StringComparison.Ordinal));
        Assert.DoesNotContain(problems, p => p["code"]!.GetValue<string>() == "ExpressionUnknownFunction" && p["op"] is JsonValue);
        // the patch is the whole fix: the patched job is accepted by the Studio's Verify
        foreach (var (path, value) in patch) Replace(job, path, value);
        var (fixedError, result) = Run(dir, "lower-fixed", job);
        Assert.True(fixedError == null, fixedError?.ToString());
        Assert.True(result!["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
    }


    [Theory]
    [InlineData(null, "Lower", "ToLower")]
    [InlineData(null, "Upper", "ToUpper")]
    [InlineData(true, "Lower", "ToLower")]
    [InlineData(true, "Upper", "ToUpper")]
    public void G5_CertainPageFunctionsAreRepairedWithACompleteReceipt(bool? autoPatch, string function, string replacement)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch("g5-auto");
        var job = PageJob(function);
        if (autoPatch.HasValue) job["autoPatch"] = autoPatch.Value;
        var sent = job.ToJsonString();
        var (error, result) = Run(dir, "automatic", job);
        Assert.True(error == null, error?.ToString());
        Assert.True(result!["accepted"]!.GetValue<bool>());
        Assert.Equal(1, result["autoPatch"]!["rounds"]!.GetValue<int>());
        var repair = Assert.Single(result["patchesApplied"]!.AsArray().OfType<JsonObject>());
        Assert.Equal("FUNCTION_UNKNOWN", repair["code"]!.ToString());
        Assert.Equal("BUILTIN_FUNCTION_RENAMED", repair["patchRule"]!.ToString());
        Assert.Equal(sent, job.ToJsonString());
        Assert.True(JsonNode.DeepEquals(job, JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "automatic.json")))));
        var expected = job.DeepClone().AsObject();
        foreach (var (path, value) in PageRepairs(replacement)) Replace(expected, path, value);
        var corrected = JsonNode.Parse(File.ReadAllText(result["patchedJob"]!["path"]!.ToString()));
        Assert.True(JsonNode.DeepEquals(expected, corrected), corrected?.ToJsonString());
    }

    [Fact]
    public void G5_AFunctionWithoutACertainRenameStillHasOneRefusalByDefault()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch("g5-unknown");
        var job = PageJob("NoSuchPageFunctionAtAll");
        var (error, _) = Run(dir, "unknown", job);
        var refused = Assert.IsType<JobPreflightException>(Errors.FindCoded(error!));
        var problem = Assert.Single(refused.Problems.OfType<JsonObject>(), p => p["code"]?.ToString() == "FUNCTION_UNKNOWN");
        Assert.Null(problem["patch"]);
        Assert.False(File.Exists(Path.Combine(dir, "unknown.oml")));
    }

    private static Dictionary<string, string> PageRepairs(string replacement) => new()
    {
        ["/ops/0/data/bindings/st/value"] = "If(" + replacement + "(Name) = \"ana\", \"color:red\", \"color:blue\")",
        ["/ops/0/data/bindings/t/value"] = replacement + "(Name)",
        ["/ops/0/data/bindings/v/condition"] = replacement + "(Name) <> \"\" or Shown",
        ["/ops/0/data/bindings/c/value"] = "If(Index(" + replacement + "(Name), \"a\") >= 0, \"on\", \"off\")",
    };

    private static JsonObject PageJob(string function)
    {
        var job = new JsonObject
        {
            ["expectValid"] = true,
            ["ops"] = new JsonArray(new JsonObject
            {
                ["op"] = "html",
                ["data"] = JsonNode.Parse("""
                    {"screen":"FnPage","layout":"blank","roles":["Anonymous"],"stylesheet":"none",
                     "vars":[{"name":"Name","type":"Text","default":"\"Ana\""},{"name":"Shown","type":"Boolean","default":"True"}],
                     "scripts":[{"name":"Twice","inputs":[{"name":"S","type":"Text"}],"outputs":[{"name":"R","type":"Text"}],"code":"$parameters.R = $parameters.S + $parameters.S;"}],
                     "html":"<div><span data-av=\"t\">x</span><span data-av=\"u\">y</span><div data-av=\"v\"><p>z</p></div><span class=\"pill\" data-av=\"c\">w</span></div>",
                     "bindings":{"t":{"kind":"text","value":"Lower(Name)"},
                                 "u":{"kind":"text","value":"Twice(Name) + \" Lower(\""},
                                 "v":{"kind":"visible","condition":"Lower(Name) <> \"\" or Shown"},
                                 "c":{"kind":"class","value":"If(Index(Lower(Name), \"a\") >= 0, \"on\", \"off\")"}}}
                    """),
            }),
        };
        var page = job["ops"]![0]!["data"]!.AsObject();
        page["html"] = page["html"]!.ToString() + "<span data-av=\"st\">style</span>";
        page["bindings"]!["st"] = new JsonObject { ["kind"] = "style", ["value"] = "" };
        foreach (var (path, value) in PageRepairs(function)) Replace(job, path, value);
        return job;
    }

    // ---- G6: the Values/Labels of a Dropdown -----------------------------------------------------------------------------

    [Fact]
    public void G6_ValuesAndLabelsThatReadTheListsCurrentAreRefusedWithThePatchThatReadsTheElement()
    {
        var job = JsonNode.Parse("""
            {"ops":[
              {"op":"create","parent":"IContainer:A","type":"IDropdown","name":"OptsInput","as":"$d"},
              {"op":"set","target":"$d","prop":"List","value":"Opts"},
              {"op":"set","target":"$d","prop":"Values","value":"Opts.Current.Value"},
              {"op":"set","target":"$d","prop":"Labels","value":"\"# \" + Opts.Current.Label + \" (Opts.Current.Label)\""},
              {"op":"create","parent":"IContainer:B","type":"IDropdown","name":"Agg","as":"$e"},
              {"op":"set","target":"IDropdown:Agg","prop":"List","value":"GetItems.List"},
              {"op":"set","target":"$e","prop":"Values","value":"GetItems.List.Current.Item.Id"},
              {"op":"set","target":"$e","prop":"Labels","value":"Item.Label"},
              {"op":"create","parent":"IContainer:C","type":"IDropdown","name":"Good","as":"$g"},
              {"op":"set","target":"$g","prop":"List","value":"Opts"},
              {"op":"set","target":"$g","prop":"Values","value":"Value"},
              {"op":"set","target":"$g","prop":"Labels","value":"Label"}]}
            """)!.AsObject();
        var problems = DropdownItemScopeRules.Check(job["ops"]!.AsArray(), "o11").ToList();
        Assert.Equal(new[] { "/ops/2/value", "/ops/3/value", "/ops/6/value" }, problems.Select(p => p["pointer"]!.GetValue<string>()));
        Assert.All(problems, p => Assert.Equal("DROPDOWN_ITEM_SCOPE", p["code"]!.GetValue<string>()));
        Assert.Equal(new[] { "Value", "\"# \" + Label + \" (Opts.Current.Label)\"", "Item.Id" }, problems.Select(p => p["patch"]![0]!["value"]!.GetValue<string>()));
        Assert.Contains("ExpressionUnknownObject 'Opts'", problems[0]["message"]!.GetValue<string>());
        // through the preflight of the job: the same problems, in one answer
        var analyzed = JobPreflight.Analyze(job["ops"]!.AsArray(), job)["problems"]!.AsArray().OfType<JsonObject>().Where(p => p["code"]!.GetValue<string>() == "DROPDOWN_ITEM_SCOPE").ToList();
        Assert.Equal(3, analyzed.Count);
        // ODC: not proved there, not judged
        Assert.Empty(DropdownItemScopeRules.Check(job["ops"]!.AsArray(), "odc"));
    }

    [Fact]
    public void G6_TheFragmentSelectThatReadsOptionsCurrentIsRefusedWithTheAttributePath()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => HtmlVisual.Preflight("<div class=\"a\"><select bind=\"Sel\" options=\"Opts\" value=\"Opts.Current.Value\" label=\"Label\"/></div>", "$screen"));
        var problem = Assert.Single(Errors.FindCoded(ex)!.Problems!.OfType<JsonObject>());
        Assert.Equal("DROPDOWN_ITEM_SCOPE", problem["code"]!.GetValue<string>());
        Assert.Equal("write value=\"Value\"", problem["fix"]!.GetValue<string>());
        // the attribute path compiles
        HtmlVisual.Preflight("<div class=\"a\"><select bind=\"Sel\" options=\"GetItems.List\" value=\"Item.Id\" label=\"Item.Label\"/></div>", "$screen");
    }

    [Fact]
    public void G6_TheSelectHintOfThePageFormTeachesTheElementsAttributesNotListCurrent()
    {
        var data = JsonNode.Parse("""{"screen":"Orders","layout":"theme","html":"<select><option>A</option></select>"}""")!.AsObject();
        var (_, refusal) = HtmlExpander.Analyze(data, null);
        var message = Errors.FindCoded(refusal!)!.Problems!.OfType<JsonObject>().Select(p => p["message"]!.GetValue<string>()).Single(m => m.Contains("<select bind=", StringComparison.Ordinal));
        var start = message.IndexOf("<select bind=", StringComparison.Ordinal);
        var fragment = message[start..(message.IndexOf("/>", start, StringComparison.Ordinal) + 2)];
        Assert.Equal("<select bind='Var' options='GetItems.List' value='Item.Id' label='Item.Label'/>", fragment);
        Assert.DoesNotContain(".Current", fragment);
        Assert.Contains("never List.Current", message);
        // the fragment the hint gives compiles, the read of its Current is refused
        HtmlVisual.Preflight(fragment.Replace('\'', '"'), "$screen");
    }

    /// <summary>G6 through the Studio, the probe of 2026-10-11 on Haiku_UI as a test: the Verify refuses a Dropdown whose
    /// Values/Labels read the list variable's Current (ExpressionUnknownObject on the list), the preflight says it with the
    /// patch, and the patched job is accepted.</summary>
    [Fact]
    public void G6_TheVerifyRefusesListCurrentInADropdownAndThePatchedJobIsAccepted()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch("g6");
        var job = JsonNode.Parse("""
            {"expectValid":true,"ops":[
              {"op":"spec","data":{"structures":[{"name":"ProbeOption","attributes":[{"name":"Value","type":"Integer"},{"name":"Label","type":"Text"}]}]}},
              {"op":"html","data":{"screen":"ProbeOpts","layout":"blank","roles":["Anonymous"],"stylesheet":"none",
                "vars":[{"name":"ProbeList","type":"ProbeOption List"},{"name":"ProbeSel","type":"Integer"}],
                "html":"<div id=\"ProbeA\">a</div>"}},
              {"op":"create","parent":"IContainer:ProbeA","type":"IDropdown","name":"ProbeAInput","as":"$a"},
              {"op":"set","target":"$a","prop":"Variable","value":"ProbeSel"},
              {"op":"set","target":"$a","prop":"List","value":"ProbeList"},
              {"op":"set","target":"$a","prop":"Values","value":"ProbeList.Current.Value"},
              {"op":"set","target":"$a","prop":"Labels","value":"ProbeList.Current.Label"}]}
            """)!.AsObject();
        var (error, _) = Run(dir, "dropdown", job);
        var problems = Assert.IsType<JobPreflightException>(Errors.FindCoded(error!)).Problems.OfType<JsonObject>().ToList();
        var scoped = problems.Where(p => p["code"]!.GetValue<string>() == "DROPDOWN_ITEM_SCOPE").ToList();
        Assert.Equal(new[] { "/ops/5/value", "/ops/6/value" }, scoped.Select(p => p["pointer"]!.GetValue<string>()));
        foreach (var p in scoped) Replace(job, p["patch"]![0]!["path"]!.GetValue<string>(), p["patch"]![0]!["value"]!.GetValue<string>());
        Assert.Equal("Value", job["ops"]![5]!["value"]!.GetValue<string>());
        var (fixedError, result) = Run(dir, "dropdown-fixed", job);
        Assert.True(fixedError == null, fixedError?.ToString());
        Assert.True(result!["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
    }

    // ---- fixtures -----------------------------------------------------------------------------------------------------------

    private static string Scratch(string name)
    {
        var dir = Path.Combine(Root, ".local", "html-g-tests", name + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static (Exception? Error, JsonObject? Result) Run(string dir, string name, JsonObject job)
    {
        var jobPath = Path.Combine(dir, name + ".json");
        File.WriteAllText(jobPath, job.ToJsonString());
        try
        {
            var result = JobRunner.Run(new ModelHost(Path.Combine(dir, "work-" + name)), Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"), jobPath, Path.Combine(dir, name + ".oml"));
            return (null, JsonSerializer.SerializeToNode(result)!.AsObject());
        }
        catch (Exception ex) { return (ex, null); }
    }

    /// <summary>The replace step of an RFC 6902 patch on the job document.</summary>
    private static void Replace(JsonObject document, string pointer, string value)
    {
        var segments = pointer.Split('/').Skip(1).Select(s => s.Replace("~1", "/").Replace("~0", "~")).ToArray();
        JsonNode node = document;
        foreach (var segment in segments[..^1]) node = node is JsonArray array ? array[int.Parse(segment)]! : node[segment]!;
        if (node is JsonArray list) list[int.Parse(segments[^1])] = value;
        else node[segments[^1]] = value;
    }
}
