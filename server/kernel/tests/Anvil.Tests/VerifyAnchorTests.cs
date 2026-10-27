using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>
/// The Verify errors of a refusal mapped back to the job (UI-Mockup diagnosis of 2026-10-11, refs-validation.md §3.2, §4,
/// R7). FarmaVirtual session, 2026-10-10: call 99 refused 18 Verify errors on 6 Dropdowns with op and pointer null (the
/// owner of each message is the CustomProperty Values or Labels, which no walk of the module finds by its key), so the
/// author had to find /ops/328/value alone; in call 96 the two Expressions of the page (the CustomProperty Value of an
/// Expression widget) came with op null and the IfWidgets of the page all at /ops/245.
/// </summary>
public sealed class VerifyAnchorTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(VerifyAnchorTests).Assembly.Location)!)!;

    /// <summary>A page with a ProbeOption List (ops 0 and 1): containers ProbeA and ProbeB, three Ifs and an Expression.</summary>
    private static string Page(string? bindings = null) => """
        {"op":"spec","data":{"structures":[{"name":"ProbeOption","attributes":[{"name":"Value","type":"Integer"},{"name":"Label","type":"Text"}]}]}},
        {"op":"html","data":{"screen":"ProbeOpts","layout":"blank","roles":["Anonymous"],"stylesheet":"none",
          "vars":[{"name":"ProbeList","type":"ProbeOption List"},{"name":"ProbeSel","type":"Integer"},{"name":"ProbeOther","type":"Integer"}],
          "html":"<div id=\"ProbeA\">a</div><div id=\"ProbeB\">b</div><div data-av=\"v1\"><p>x</p></div><div data-av=\"v2\"><p>y</p></div><div data-av=\"v3\"><p>z</p></div><span data-av=\"t1\">t</span>",
          "bindings":{
        """ + (bindings ?? """
          "v1":{"kind":"visible","condition":"True"},"v2":{"kind":"visible","condition":"True"},"v3":{"kind":"visible","condition":"True"},"t1":{"kind":"text","value":"\"t\""}
        """) + """
        }}}
        """;

    /// <summary>The page and a Dropdown over its List: ops 0 to 6, Values at op 5, Labels at op 6.</summary>
    private static string Probe(string values, string labels, string? bindings = null) => Page(bindings) + """
        ,
        {"op":"create","parent":"IContainer:ProbeA","type":"IDropdown","name":"ProbeAInput","as":"$a"},
        {"op":"set","target":"$a","prop":"Variable","value":"ProbeSel"},
        {"op":"set","target":"$a","prop":"List","value":"ProbeList"},
        """ + $$"""
        {"op":"set","target":"$a","prop":"Values","value":{{JsonSerializer.Serialize(values)}}},
        {"op":"set","target":"$a","prop":"Labels","value":{{JsonSerializer.Serialize(labels)}}}
        """;

    /// <summary>A Verify error whose owner is a property object of a widget (the Values of a Dropdown) points at the set
    /// that wrote that property: op and /ops/i/value, never null, and never the set of another property (Labels came last).</summary>
    [Fact]
    public void AVerifyErrorOnADropdownPropertyPointsAtTheSetThatWroteIt()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (error, result) = Run(Scratch("values"), "values", Job(Probe("ProbeNoSuchValue", "Label")));
        Assert.True(error == null, error?.ToString());
        var problems = result!["problems"]!.AsArray().OfType<JsonObject>().ToList();
        Show(problems);
        Assert.False(result["accepted"]!.GetValue<bool>());
        var unknown = Assert.Single(problems, p => p["code"]!.GetValue<string>() == "ExpressionUnknownObject");
        Assert.Equal(5, unknown["op"]?.GetValue<int>());
        Assert.Equal("/ops/5/value", unknown["pointer"]?.GetValue<string>());
        Assert.All(problems, p => Assert.Equal("/ops/5/value", p["pointer"]?.GetValue<string>()));
    }

    /// <summary>A property no set of the job wrote (the Values an html fragment wrote with its Dropdown, as the ui.dropdown
    /// route teaches) is the op that created the widget, with the pointer at that op: never a later set of another property
    /// of the widget (the Labels, the List) and never its value (/ops/3/value is the text of the Labels).</summary>
    [Fact]
    public void AVerifyErrorOnAPropertyNoSetWrotePointsAtTheOpThatCreatedItsWidget()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        const string Fragment = """
            ,{"op":"html","parent":"IContainer:ProbeA","html":"<select id=\"ProbeDd\" bind=\"ProbeSel\" options=\"ProbeList\" value=\"ProbeNoSuchValue\" label=\"Label\"/>"}
            """;
        const string List = """
            ,{"op":"set","target":"IDropdown:ProbeDd","prop":"List","value":"ProbeList"}
            """;
        const string Labels = """
            ,{"op":"set","target":"IDropdown:ProbeDd","prop":"Labels","value":"Label"}
            """;
        foreach (var (name, sets) in new[] { ("fragment-labels", Labels), ("fragment-list-labels", List + Labels) })
        {
            var (error, result) = Run(Scratch(name), name, Job(Page() + Fragment + sets));
            Assert.True(error == null, error?.ToString());
            var problems = result!["problems"]!.AsArray().OfType<JsonObject>().ToList();
            Show(problems);
            var values = Assert.Single(problems, p => p["element"]?.GetValue<string>().EndsWith("/ Values (CustomProperty)", StringComparison.Ordinal) == true);
            Assert.Equal("ExpressionUnknownObject", values["code"]!.GetValue<string>());
            Assert.Equal(2, values["op"]?.GetValue<int>());
            Assert.Equal("/ops/2", values["pointer"]?.GetValue<string>());
            Assert.Null(values["patch"]);
        }
    }

    /// <summary>A Dropdown of the base (no op of the job created it) whose Values and Labels fail after a set of another of its
    /// properties (the List, now of records without the attributes they read): that set alone, at the op, never its value.</summary>
    [Fact]
    public void AVerifyErrorOnAPropertyOfAnElementOfTheBaseStaysAtTheSetAloneNeverItsValue()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch("base-element");
        var (error, result) = Run(dir, "base", Job(Probe("Value", "Label")));
        Assert.True(error == null, error?.ToString());
        Assert.True(result!["accepted"]!.GetValue<bool>(), result["details"]?.ToJsonString());
        var job = Job("""
            {"op":"spec","data":{"structures":[{"name":"ProbeAlt","attributes":[{"name":"Code","type":"Integer"},{"name":"Name","type":"Text"}]}]}},
            {"op":"create","parent":"IMobileScreen:ProbeOpts","type":"ILocalVariable","name":"ProbeAlts","as":"$v"},
            {"op":"set","target":"$v","prop":"DataType","value":"ProbeAlt List"},
            {"op":"set","target":"IDropdown:ProbeAInput","prop":"List","value":"ProbeAlts"}
            """);
        (error, result) = Run(dir, "list", job, Path.Combine(dir, "base.oml"));
        Assert.True(error == null, error?.ToString());
        var problems = result!["problems"]!.AsArray().OfType<JsonObject>().ToList();
        Show(problems);
        var items = problems.Where(p => p["element"]?.GetValue<string>() is { } e && (e.EndsWith("/ Values (CustomProperty)", StringComparison.Ordinal) || e.EndsWith("/ Labels (CustomProperty)", StringComparison.Ordinal))).ToList();
        Assert.Contains(items, p => p["message"]!.GetValue<string>().Contains("'Value'"));
        Assert.All(items, p =>
        {
            Assert.Equal(3, p["op"]?.GetValue<int>());
            Assert.Equal("/ops/3", p["pointer"]?.GetValue<string>());
            Assert.Null(p["patch"]);
        });
    }

    /// <summary>The Verify names some properties by their model name, not the name the set used (a set of StyleClasses on a
    /// Text is its Style): the set of the job on that element whose value is the text of the expression is the place, at
    /// /ops/i/value with the patch, before or after another set of the element; never the op that created the widget.</summary>
    [Fact]
    public void AVerifyErrorThatNamesAPropertyByItsModelNamePointsAtTheSetThatWroteItsText()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        const string Widget = """
            ,{"op":"create","parent":"IContainer:ProbeA","type":"ITextWidget","name":"ProbeTxt","as":"$t"}
            """;
        const string SetText = """
            ,{"op":"set","target":"$t","prop":"Text","value":"hello"}
            """;
        const string SetClasses = """
            ,{"op":"set","target":"$t","prop":"StyleClasses","value":"\"a \" + ProbeNoStyleName"}
            """;
        foreach (var (name, sets, at) in new[] { ("classes", SetClasses, 3), ("classes-text", SetClasses + SetText, 3), ("text-classes", SetText + SetClasses, 4) })
        {
            var (error, result) = Run(Scratch(name), name, Job(Page() + Widget + sets));
            Assert.True(error == null, error?.ToString());
            var problems = result!["problems"]!.AsArray().OfType<JsonObject>().ToList();
            Show(problems);
            var unknown = Assert.Single(problems, p => p["code"]!.GetValue<string>() == "ExpressionUnknownObject");
            Assert.EndsWith("/ ProbeTxt (TextWidget)", unknown["element"]!.GetValue<string>());
            Assert.Equal(at, unknown["op"]?.GetValue<int>());
            Assert.Equal($"/ops/{at}/value", unknown["pointer"]?.GetValue<string>());
        }
        var dir = Scratch("classes-lower");
        var job = Job(Page() + Widget + SetText + """
            ,{"op":"set","target":"$t","prop":"StyleClasses","value":"Lower(\"A\")"}
            """);
        var (lowerError, lower) = Run(dir, "lower", job);
        Assert.True(lowerError == null, lowerError?.ToString());
        var found = lower!["problems"]!.AsArray().OfType<JsonObject>().ToList();
        Show(found);
        var function = Assert.Single(found, p => p["code"]!.GetValue<string>() == "ExpressionUnknownFunction");
        Assert.Equal(4, function["op"]?.GetValue<int>());
        Assert.Equal("/ops/4/value", function["pointer"]?.GetValue<string>());
        Assert.Contains("ToLower", function["fix"]!.GetValue<string>());
        var patch = Assert.Single(function["patch"]!.AsArray())!.AsObject();
        Assert.Equal("/ops/4/value", patch["path"]!.GetValue<string>());
        Assert.Equal("ToLower(\"A\")", patch["value"]!.GetValue<string>());
        job["ops"]![4]!["value"] = patch["value"]!.GetValue<string>();
        var (fixedError, fixedResult) = Run(dir, "lower-fixed", job);
        Assert.True(fixedError == null, fixedError?.ToString());
        Assert.True(fixedResult!["accepted"]!.GetValue<bool>(), fixedResult["details"]?.ToJsonString());
    }

    /// <summary>The owner a message carries never keeps its model alive: the bridge keeps the messages of every snapshot of a
    /// Studio session (SnapshotRegistry, from snapshot_module), and the objects of a module the Studio closed or changed must
    /// still be collected. While the model lives, the owner is there.</summary>
    [Fact]
    public void AMessageNeverKeepsItsOwnerAlive()
    {
        var kept = new object();
        Assert.Same(kept, new MessageInfo("Id", "Error", "k", "p", "d") { Owner = kept }.Owner);
        GC.KeepAlive(kept);
        var (message, owner) = Message();
        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        Assert.False(owner.TryGetTarget(out _));
        Assert.Null(message.Owner);

        [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
        static (MessageInfo, WeakReference<object>) Message()
        {
            var o = new object();
            return (new MessageInfo("Id", "Error", "k", "p", "d") { Owner = o }, new WeakReference<object>(o));
        }
    }

    /// <summary>In the refusal of every phase (a Dropdown the preflight refuses with DROPDOWN_ITEM_SCOPE), the Verify of the
    /// same set is that fault again and is merged into it; the Verify of another set stays, with its own op and pointer.</summary>
    [Fact]
    public void TheVerifyOfASetThePreflightRefusedIsMergedAndAnotherSetKeepsItsPointer()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var job = Job(Probe("ProbeNoSuchValue", "Label") + """
            ,{"op":"create","parent":"IContainer:ProbeB","type":"IDropdown","name":"ProbeBInput","as":"$b"},
             {"op":"set","target":"$b","prop":"Variable","value":"ProbeOther"},
             {"op":"set","target":"$b","prop":"List","value":"ProbeList"},
             {"op":"set","target":"$b","prop":"Values","value":"Value"},
             {"op":"set","target":"$b","prop":"Labels","value":"ProbeList.Current.Label"}
            """);
        var (error, _) = Run(Scratch("merged"), "merged", job);
        var refused = Assert.IsType<JobPreflightException>(Errors.FindCoded(error!));
        var problems = refused.Problems.OfType<JsonObject>().ToList();
        Show(problems);
        Assert.True(refused.VerifyRan);
        // the Labels of the second Dropdown: the preflight's problem with its patch, the Verify's repetition merged into it
        var scoped = Assert.Single(problems, p => p["pointer"]?.GetValue<string>() == "/ops/11/value");
        Assert.Equal("DROPDOWN_ITEM_SCOPE", scoped["code"]!.GetValue<string>());
        // the Values of the first: the Verify, at its set
        Assert.Contains(problems, p => p["code"]!.GetValue<string>() == "ExpressionUnknownObject" && p["pointer"]?.GetValue<string>() == "/ops/5/value");
        Assert.All(problems, p => Assert.NotNull(p["op"]));
    }

    /// <summary>A Verify error inside a widget an html page op wrote (the Condition of an If, the CustomProperty Value of an
    /// Expression) points at the binding that holds its expression, when the op holds that text once.</summary>
    [Fact]
    public void AVerifyErrorInsideAPageWidgetPointsAtTheBindingThatHoldsItsExpression()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var bindings = """
            "v1":{"kind":"visible","condition":"ProbeNoFlag1"},"v2":{"kind":"visible","condition":"ProbeNoFlag2"},
            "v3":{"kind":"visible","condition":"True"},"t1":{"kind":"text","value":"ProbeNoText1"}
            """;
        var (error, result) = Run(Scratch("page"), "page", Job(Probe("Value", "Label", bindings)));
        Assert.True(error == null, error?.ToString());
        var problems = result!["problems"]!.AsArray().OfType<JsonObject>().ToList();
        Show(problems);
        Assert.All(problems, p => Assert.Equal(1, p["op"]?.GetValue<int>()));
        Assert.Equal(new[] { "/ops/1/data/bindings/t1/value", "/ops/1/data/bindings/v1/condition", "/ops/1/data/bindings/v2/condition" },
            problems.Select(p => p["pointer"]?.GetValue<string>()).Order(StringComparer.Ordinal));
    }

    /// <summary>An unknown function one built-in certainly means, in a value only a set writes (the base check reads logic and
    /// page expressions, not set values): the Verify's error comes at the set with the patch, and the patched job is accepted.</summary>
    [Fact]
    public void AnUnknownFunctionInASetValueComesWithThePatchOfTheBuiltinItMeans()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Scratch("lower");
        var job = Job(Probe("Value", "Lower(Label) + \" (Lower(x))\""));
        var (error, result) = Run(dir, "lower", job);
        Assert.True(error == null, error?.ToString());
        var problems = result!["problems"]!.AsArray().OfType<JsonObject>().ToList();
        Show(problems);
        var unknown = Assert.Single(problems, p => p["code"]!.GetValue<string>() == "ExpressionUnknownFunction");
        Assert.Equal("/ops/6/value", unknown["pointer"]?.GetValue<string>());
        Assert.Contains("ToLower", unknown["fix"]!.GetValue<string>());
        var patch = Assert.Single(unknown["patch"]!.AsArray())!.AsObject();
        Assert.Equal("/ops/6/value", patch["path"]!.GetValue<string>());
        Assert.Equal("ToLower(Label) + \" (Lower(x))\"", patch["value"]!.GetValue<string>());
        job["ops"]![6]!["value"] = patch["value"]!.GetValue<string>();
        var (fixedError, fixedResult) = Run(dir, "lower-fixed", job);
        Assert.True(fixedError == null, fixedError?.ToString());
        Assert.True(fixedResult!["accepted"]!.GetValue<bool>(), fixedResult["details"]?.ToJsonString());
    }

    // ---- the union of the phases: one Verify message is one problem -------------------------------------------------------

    /// <summary>Two messages of the Verify are two faults unless they are the same message on the same element (key): the
    /// IfWidgets of one html op share its op and pointer (call 96: 16 ExpressionUnknownFunction became 1), and the
    /// ExpressionUnknownObject of a Labels is the cause of the CustomObjectError on the same Labels (call 99), not a copy.</summary>
    [Fact]
    public void TheUnionNeverMergesTwoVerifyMessagesOfDifferentElementsOrFaults()
    {
        JsonObject P(string phase, string pointer, string code, string message, string? key = null)
        {
            var p = JobPreflight.Problem(int.Parse(pointer.Split('/')[2]), pointer, code, "error", message, "fix");
            p["phase"] = phase;
            if (key != null) p["key"] = key;
            return p;
        }
        string Lower(string widget) => $"Error ExpressionUnknownFunction: Invalid Expression | Unknown function 'Lower' in expression. @ content (MobileWidget) / {widget} (IfWidget)";
        const string Unknown = "Error ExpressionUnknownObject: Invalid Expression | Can't identify 'AccountsOptions' element in expression. @ FvAccountInput (Dropdown) / Labels (CustomProperty)";
        const string Typed = "Error CustomObjectError: Invalid Data Type | 'Text, Integer' data type required instead of 'None'. @ FvAccountInput (Dropdown) / Labels (CustomProperty)";
        var union = JobRunner.Union([
            P("verify", "/ops/245", "ExpressionUnknownFunction", Lower("IfFv33"), "k33"),
            P("verify", "/ops/245", "ExpressionUnknownFunction", Lower("IfFv38"), "k38"),
            P("verify", "/ops/245", "ExpressionUnknownFunction", Lower("IfFv43"), "k43"),
            P("verify", "/ops/328/value", "CustomObjectError", Typed, "kLabels"),
            P("verify", "/ops/328/value", "ExpressionUnknownObject", Unknown, "kLabels"),
            // the same message on the same element again: one
            P("verify", "/ops/328/value", "ExpressionUnknownObject", Unknown, "kLabels"),
        ], "/ops");
        Assert.Equal(new[] { "k33", "k38", "k43", "kLabels", "kLabels" }, union.Select(p => p["key"]!.GetValue<string>()));
        Assert.Equal(new[] { "CustomObjectError", "ExpressionUnknownObject" }, union.Skip(3).Select(p => p["code"]!.GetValue<string>()));
        // a fault an earlier phase already said still takes the Verify's repetition at its place
        var said = JobRunner.Union([
            P("preflight", "/ops/328/value", "DROPDOWN_ITEM_SCOPE", "Labels = AccountsOptions.Current.Label: ... 'AccountsOptions' ..."),
            P("verify", "/ops/328/value", "CustomObjectError", Typed, "kLabels"),
            P("verify", "/ops/328/value", "ExpressionUnknownObject", Unknown, "kLabels"),
        ], "/ops");
        Assert.Equal("DROPDOWN_ITEM_SCOPE", Assert.Single(said)["code"]!.GetValue<string>());
    }

    /// <summary>Through the Studio: three Ifs of one html page with the same invalid condition (the op holds the text three
    /// times, so each stays at the op) in a refusal of every phase: three problems, one per If.</summary>
    [Fact]
    public void EveryIfOfAPageWithTheSameInvalidConditionIsItsOwnProblem()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var bindings = """
            "v1":{"kind":"visible","condition":"ProbeNoFlag"},"v2":{"kind":"visible","condition":"ProbeNoFlag"},
            "v3":{"kind":"visible","condition":"ProbeNoFlag"},"t1":{"kind":"text","value":"\"t\""}
            """;
        // the second Dropdown reads its List's Current: the preflight refuses it, so the refusal is the union of the phases
        var job = Job(Probe("Value", "Label", bindings) + """
            ,{"op":"create","parent":"IContainer:ProbeB","type":"IDropdown","name":"ProbeBInput","as":"$b"},
             {"op":"set","target":"$b","prop":"Variable","value":"ProbeOther"},
             {"op":"set","target":"$b","prop":"List","value":"ProbeList"},
             {"op":"set","target":"$b","prop":"Values","value":"ProbeList.Current.Value"},
             {"op":"set","target":"$b","prop":"Labels","value":"Label"}
            """);
        var (error, _) = Run(Scratch("ifs"), "ifs", job);
        var refused = Assert.IsType<JobPreflightException>(Errors.FindCoded(error!));
        var problems = refused.Problems.OfType<JsonObject>().ToList();
        Show(problems);
        var ifs = problems.Where(p => p["code"]!.GetValue<string>() == "ExpressionUnknownObject" && p["element"]?.GetValue<string>().Contains("(IfWidget)") == true).ToList();
        Assert.Equal(3, ifs.Count);
        Assert.All(ifs, p => Assert.Equal("/ops/1", p["pointer"]?.GetValue<string>()));
        Assert.Equal(3, ifs.Select(p => p["key"]!.GetValue<string>()).Distinct().Count());
        Assert.Contains(problems, p => p["code"]!.GetValue<string>() == "DROPDOWN_ITEM_SCOPE" && p["pointer"]?.GetValue<string>() == "/ops/10/value");
    }

    // ---- the fix: the advice itself, never a placeholder nor a command -------------------------------------------------------

    private static readonly System.Text.RegularExpressions.Regex Placeholder = new(@"\{\d+\}");

    // A CLI command in a fix, and the ones the facade turns into the MCP call that does the same (the `anvil` head of
    // platforms/odc/facade/responses.mjs): any other command sends the app session to a shell it may not use.
    private static readonly System.Text.RegularExpressions.Regex CliCommand = new(@"\banvil(?:\.dll)?\s+([\w-]+)");
    private static readonly string[] FacadeRewrites = ["functions", "api", "signature"];

    /// <summary>The curated hints are the fix of a Verify problem and of a warning as they are (kernel and facade): a
    /// template placeholder stays empty there (call 96: "Corrigir o nome da funcao {0} ..."; call 99: "ler {1} no proprio
    /// texto").</summary>
    [Fact]
    public void NoCuratedHintCarriesAPlaceholder()
    {
        var hints = VerifyHints.Read(JobRunner.RepoRoot(Directory.GetCurrentDirectory())!);
        Assert.Equal(169, hints.Count);
        Assert.Empty(hints.Values.Where(h => Placeholder.IsMatch(h.Hint)).Select(h => $"{h.Id}: {h.Hint}"));
        Assert.Contains("Connect", hints["RequiredConnector_Out"].Hint);
    }

    /// <summary>Every fix of a refusal says the advice inline: the item scope of a Dropdown's Values and Labels (call 99 said
    /// "`anvil verify-message --name ExpressionUnknownObject` explains", a CLI the app session cannot run), the names of the
    /// page for an unknown name of a page widget, and an unknown function without a close built-in; no placeholder.</summary>
    [Fact]
    public void TheFixOfEveryProblemIsTheAdviceItselfNeverAPlaceholderNorACommand()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var bindings = """
            "v1":{"kind":"visible","condition":"ProbeNoFlagOne"},"v2":{"kind":"visible","condition":"True"},
            "v3":{"kind":"visible","condition":"True"},"t1":{"kind":"text","value":"\"t\""}
            """;
        var job = Job(Probe("ProbeNoSuchValue", "ProbeNoSuchLabel", bindings) + """
            ,{"op":"logic","data":{"actions":[{"name":"ProbeCalc","outputs":[{"name":"N","type":"Integer"}],"steps":[{"assign":{"N":"Zzqqxxw(1)"}}]}]}}
            """);
        var (error, _) = Run(Scratch("fixes"), "fixes", job);
        var problems = Assert.IsType<JobPreflightException>(Errors.FindCoded(error!)).Problems.OfType<JsonObject>().ToList();
        Show(problems);
        Assert.All(problems, p =>
        {
            var fix = p["fix"]?.GetValue<string>() ?? "";
            Assert.False(string.IsNullOrWhiteSpace(fix), p.ToJsonString());
            Assert.DoesNotMatch(Placeholder, fix);
            Assert.All(CliCommand.Matches(fix), c => Assert.Contains(c.Groups[1].Value, FacadeRewrites));
        });
        var dropdown = problems.Where(p => p["element"]?.GetValue<string>() is { } e && e.Contains("ProbeAInput (Dropdown)")).ToList();
        Assert.Contains(dropdown, p => p["pointer"]?.GetValue<string>() == "/ops/5/value");
        Assert.Contains(dropdown, p => p["pointer"]?.GetValue<string>() == "/ops/6/value" && p["code"]!.GetValue<string>() == "CustomObjectError");
        Assert.All(dropdown, p => Assert.Contains("per element of its List", p["fix"]!.GetValue<string>()));
        var flag = Assert.Single(problems, p => p["message"]!.GetValue<string>().Contains("'ProbeNoFlagOne'"));
        Assert.Contains("ProbeSel", flag["fix"]!.GetValue<string>());
        // No built-in is close to Zzqqxxw: the fix keeps the lookup of the built-ins, in the form the facade turns into
        // ssam_reference {kind:"functions", query:"Zzqqxxw"} with its continuation.
        var function = Assert.Single(problems, p => p["code"]!.GetValue<string>() == "FUNCTION_UNKNOWN");
        Assert.Contains("`anvil functions --find Zzqqxxw`", function["fix"]!.GetValue<string>());
    }

    /// <summary>The fix of an unknown name names what holds the element ("of its screen" sent the author of a block widget to
    /// a screen), and a CustomObjectError of a Dropdown's Labels is the item scope only for the type 'None' an unknown name
    /// leaves: a wrong type (Boolean) keeps its curated hint.</summary>
    [Fact]
    public void TheFixOfAnUnknownNameNamesWhatHoldsTheElementAndAWrongTypeIsNoItemScope()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        const string screenOps = """
            ,{"op":"create","parent":"IContainer:ProbeB","type":"IExpression","name":"ProbeScreenExpr","as":"$s"},
             {"op":"set","target":"$s","prop":"Value","value":"ProbeNoScreenName"}
            """;
        var job = Job(Probe("Value", "True") + screenOps + """
            ,{"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileBlock","name":"ProbeCard","as":"$card"},
             {"op":"create","parent":"$card","type":"IExpression","name":"ProbeBlockExpr","as":"$e"},
             {"op":"set","target":"$e","prop":"Value","value":"ProbeNoBlockName"}
            """);
        // R1 (fase scope, 24/10/2026): the unknown name of the block the job creates is refused by the scope phase before the
        // Verify (the run throws; the problem keeps the pointer and the fix the Verify anchor used to give). The screen's
        // unknown name and the wrong type are Verify verdicts: read from the same job without the block ops.
        var (error, result) = Run(Scratch("holders"), "holders", job);
        var problems = ProblemsOf(error, result);
        Show(problems);
        var block = Assert.Single(problems, p => p["message"]!.GetValue<string>().Contains("'ProbeNoBlockName'"));
        Assert.Equal("/ops/11/value", block["pointer"]?.GetValue<string>());
        Assert.Contains("of its block", block["fix"]!.GetValue<string>());
        Assert.DoesNotContain("screen", block["fix"]!.GetValue<string>());
        if (error != null) Assert.Equal("scope", block["phase"]?.GetValue<string>());
        var verified = error == null ? problems : ProblemsOf(Run(Scratch("holders-verify"), "holders-verify", Job(Probe("Value", "True") + screenOps)));
        Show(verified);
        var screen = Assert.Single(verified, p => p["message"]!.GetValue<string>().Contains("'ProbeNoScreenName'"));
        Assert.Equal("/ops/8/value", screen["pointer"]?.GetValue<string>());
        Assert.Contains("of its screen", screen["fix"]!.GetValue<string>());
        var typed = Assert.Single(verified, p => p["code"]!.GetValue<string>() == "CustomObjectError");
        Assert.Equal("/ops/6/value", typed["pointer"]?.GetValue<string>());
        Assert.DoesNotContain("'None'", typed["message"]!.GetValue<string>());
        Assert.DoesNotContain("per element of its List", typed["fix"]!.GetValue<string>());
    }

    /// <summary>The problems of a run: the result's when the apply ran, else those of the coded refusal (the scope phase stops
    /// the job before its first op and throws a JobPreflightException with every problem of preflight, base and scope).</summary>
    private static List<JsonObject> ProblemsOf((Exception? Error, JsonObject? Result) run) => ProblemsOf(run.Error, run.Result);

    private static List<JsonObject> ProblemsOf(Exception? error, JsonObject? result)
    {
        if (error == null) return result!["problems"]!.AsArray().OfType<JsonObject>().ToList();
        var coded = Errors.FindCoded(error);
        Assert.True(coded != null, error.ToString());
        return (coded!.Problems ?? new JsonArray()).OfType<JsonObject>().ToList();
    }

    // ---- fixtures -----------------------------------------------------------------------------------------------------------

    private static JsonObject Job(string ops) => JsonNode.Parse($$"""{"expectValid":true,"ops":[{{ops}}]}""")!.AsObject();

    private void Show(IEnumerable<JsonObject> problems)
    {
        foreach (var p in problems) output.WriteLine(p.ToJsonString());
    }

    private static string Scratch(string name)
    {
        var dir = Path.Combine(Root, ".local", "verify-anchor-tests", name + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static (Exception? Error, JsonObject? Result) Run(string dir, string name, JsonObject job, string? basePath = null)
    {
        var jobPath = Path.Combine(dir, name + ".json");
        File.WriteAllText(jobPath, job.ToJsonString());
        try
        {
            var result = JobRunner.Run(new ModelHost(Path.Combine(dir, "work-" + name)), basePath ?? Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml"), jobPath, Path.Combine(dir, name + ".oml"));
            return (null, JsonSerializer.SerializeToNode(result)!.AsObject());
        }
        catch (Exception ex) { return (ex, null); }
    }
}
