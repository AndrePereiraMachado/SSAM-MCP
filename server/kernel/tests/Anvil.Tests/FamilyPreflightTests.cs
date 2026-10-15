using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Familias (2026-10-12): the problems the owner's VisitaCerta_UI session (screens written by hand as text) got only from
/// the Verify or from the apply, one round each, generalized to their families and decided in the first preflight pass:
/// normalized and listed when they have one reading (LITERAL_FOLDED, DDL_DECLARATION_NORMALIZED, FLOW_END_AFTER_TERMINATOR,
/// FLOW_ASSIGN_WRITTEN, CSS_FUNCTION_REWRITTEN), refused in the same pass with a verified patch when they do not
/// (OPERAND_TYPES on a document's aggregate, DEFAULT_NOT_LITERAL of a module-wide value). Each family: the case it fixes,
/// the case it leaves alone. Synthetic names, every form that writes the slot. Only the rule codes are named (strings), so
/// the same file runs against a kernel without the rules and fails there.
/// </summary>
public sealed class FamilyPreflightTests
{
    public FamilyPreflightTests() { try { StudioAssemblies.Bind(); } catch { /* no Studio: the checked-in catalogs answer */ } }

    private static (JsonNode Job, JsonObject Result) Analyze(string json)
    {
        var job = JsonNode.Parse(json)!;
        return (job, JobPreflight.Analyze(job["ops"]!.AsArray(), job, []));
    }

    private static JsonObject[] Problems(JsonObject result, string code)
        => result["problems"]!.AsArray().OfType<JsonObject>().Where(p => p["code"]!.GetValue<string>() == code).ToArray();

    private static JsonObject[] Normalizations(JsonObject result, string rule)
        => (result["normalizations"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Where(n => n["rule"]!.GetValue<string>() == rule).ToArray();

    private static string Ops(params JsonNode[] ops) => new JsonObject { ["ops"] = new JsonArray(ops) }.ToJsonString();

    private static JsonObject Ddl(string text) => new() { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = text } };
    private static JsonObject Flow(params string[] texts) => new() { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(texts.Select(t => (JsonNode)t).ToArray()) } };
    private static JsonObject Html(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };
    private static JsonObject Css(string css) => new() { ["op"] = "set", ["target"] = "IMobileTheme:FamTema", ["prop"] = "StyleSheet", ["value"] = css };

    private const string Screen = """<screen name="FamTela" flow="MainFlow" title="&quot;Tela&quot;" roles="Registered" actions="FamIr">""";
    private const string Body = """<Block name="LayoutBlank"><slot name="Content"><button onclick="FamIr">Ir</button></slot></Block></screen>""";

    // ---- LITERAL_FOLDED: every form that writes a literal-only slot -------------------------------------------------------

    [Fact]
    public void AConstantInALiteralOnlySlotIsItsLiteralInEveryForm()
    {
        // VisitaCerta_UI: TextToDate("...") as the default of client variables (raw sets and the data text) and of screen
        // variables (the document): 8 Verify errors InvalidPropertyValue_DefaultValue in two rounds.
        var (job, result) = Analyze(Ops(
            Ddl("client variable FamDia: Date = TextToDate(\"2026-05-04\")\nclient variable FamHora: Time\nclient variable FamQuando: Date Time = NewDateTime(2026, 5, 4, 9, 30, 0)\n"),
            new JsonObject { ["op"] = "set", ["target"] = "IClientVariable:FamHora", ["prop"] = "DefaultValue", ["value"] = "TextToTime(\"09:30\")" },
            Html(Screen + """<var name="FamData" type="Date" default="TextToDate(&quot;2026-10-12&quot;)"/><var name="FamTexto" type="Text" default="IntegerToText(7)"/>""" + Body),
            Flow("action FamTela.FamIr\n  local FamLimite: Date = NewDate(2026, 12, 31)\n  assign FamData = FamLimite\n  end\n"),
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(new JsonObject
            {
                ["name"] = "FamCalcular", ["kind"] = "server",
                ["vars"] = new JsonArray(new JsonObject { ["name"] = "FamInicio", ["type"] = "Date Time", ["default"] = "DateToDateTime(#2026-01-02#)" }),
                ["steps"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["FamInicio"] = "CurrDateTime()" } }),
            }) } }));
        var folded = Normalizations(result, "LITERAL_FOLDED");
        Assert.Equal(7, folded.Length);
        var ops = job["ops"]!.AsArray();
        Assert.Contains("client variable FamDia: Date = #2026-05-04#", ops[0]!["data"]!["ddl"]!.GetValue<string>());
        Assert.Contains("= #2026-05-04 09:30:00#", ops[0]!["data"]!["ddl"]!.GetValue<string>());
        Assert.Equal("#09:30:00#", ops[1]!["value"]!.GetValue<string>());
        var html = ops[2]!["data"]!["html"]!.GetValue<string>();
        Assert.Contains("default=\"#2026-10-12#\"", html);
        Assert.Contains("default=\"&quot;7&quot;\"", html);
        Assert.Contains("local FamLimite: Date = #2026-12-31#", ops[3]!["data"]!["flow"]![0]!.GetValue<string>());
        Assert.Equal("#2026-01-02 00:00:00#", ops[4]!["data"]!["actions"]![0]!["vars"]![0]!["default"]!.GetValue<string>());
        Assert.Empty(Problems(result, "DEFAULT_NOT_LITERAL"));
        Assert.Equal("/ops/2/data/html", folded.Single(f => f["from"]!.GetValue<string>().Contains("2026-10-12"))["path"]!.GetValue<string>());
    }

    [Fact]
    public void WhatIsNoConstantIsNeverFoldedNorRefusedHere()
    {
        // CurrDate() is no constant (the Studio even accepts it as a screen variable's default: html-replay 0162), and
        // 2026-02-30 is no day: both stay as written, for the Verify.
        var (job, result) = Analyze(Ops(
            Ddl("client variable FamHoje: Date = CurrDate()\nclient variable FamFev: Date = TextToDate(\"2026-02-30\")\n"),
            new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IClientVariable", ["name"] = "FamAgora", ["as"] = "$agora" },
            new JsonObject { ["op"] = "set", ["target"] = "$agora", ["prop"] = "DataType", ["value"] = "Date Time" },
            new JsonObject { ["op"] = "set", ["target"] = "$agora", ["prop"] = "DefaultValue", ["value"] = "CurrDateTime()" }));
        Assert.Empty(Normalizations(result, "LITERAL_FOLDED"));
        Assert.Contains("= TextToDate(\"2026-02-30\")", job["ops"]![0]!["data"]!["ddl"]!.GetValue<string>());
        Assert.Equal("CurrDateTime()", job["ops"]![3]!["value"]!.GetValue<string>());
        Assert.Empty(Problems(result, "DEFAULT_NOT_LITERAL"));
        // A literal of another type in a typed slot whose meaning is one, and none when there is none.
        Assert.Equal("#2026-05-04#", Anvil.Core.Preflight.LiteralFolding.Fold("\"2026-05-04\"", "Date"));
        Assert.Equal("#2026-05-04 00:00:00#", Anvil.Core.Preflight.LiteralFolding.Fold("TextToDate(\"2026-05-04\")", "Date Time"));
        Assert.Equal("5", Anvil.Core.Preflight.LiteralFolding.Fold("TextToInteger(\"5\")", null));
        Assert.Null(Anvil.Core.Preflight.LiteralFolding.Fold("TextToDate(\"2026-05-04\")", "Text"));
        Assert.Null(Anvil.Core.Preflight.LiteralFolding.Fold("TextToDate(\"2026-05-04\")", "Pedido Identifier"));
        Assert.Null(Anvil.Core.Preflight.LiteralFolding.Fold("\"2026-05-04\"", "Date", callsOnly: true));
        Assert.Null(Anvil.Core.Preflight.LiteralFolding.Fold("TextToInteger(\"5x\")", "Integer"));
    }
    // ---- DDL_DECLARATION_NORMALIZED ---------------------------------------------------------------------------------------

    [Fact]
    public void ALineStatementWithASemicolonOrARawDefaultIsTheGrammarsLine()
    {
        // 20:33: 41 client variables "os:DefaultValue=...;" refused one by one as "unknown declaration clause ''".
        var (job, result) = Analyze(Ops(Ddl(
            "/// Estado.\nclient variable FamConta: Integer os:DefaultValue=5;\nclient variable FamNome: Text os:DefaultValue=\"Cliente João\";\n"
            + "client variable FamFavorito: Boolean os:DefaultValue=True\nsite property FamLimite: Integer = 10;\nclient variable FamDia: Date os:DefaultValue=TextToDate(\"2026-05-04\");\n")));
        Assert.Empty(Problems(result, "DDL_SYNTAX"));
        var ddl = job["ops"]![0]!["data"]!["ddl"]!.GetValue<string>();
        Assert.Contains("client variable FamConta: Integer = 5\n", ddl);
        Assert.Contains("client variable FamNome: Text = \"Cliente João\"\n", ddl);   // the text, never the bare words
        Assert.Contains("client variable FamFavorito: Boolean = True\n", ddl);
        Assert.Contains("site property FamLimite: Integer = 10\n", ddl);
        Assert.Contains("client variable FamDia: Date = #2026-05-04#", ddl);
        Assert.Equal(5, Normalizations(result, "DDL_DECLARATION_NORMALIZED").Length);
        // A line the rewrite does not make valid keeps its text and its refusal.
        var (kept, keptResult) = Analyze(Ops(Ddl("client variable FamOutra: Integer bogus;\n")));
        Assert.Single(Problems(keptResult, "DDL_SYNTAX"));
        Assert.Empty(Normalizations(keptResult, "DDL_DECLARATION_NORMALIZED"));
        Assert.Equal("client variable FamOutra: Integer bogus;\n", kept["ops"]![0]!["data"]!["ddl"]!.GetValue<string>());
    }

    // ---- FLOW_END_AFTER_TERMINATOR / FLOW_ASSIGN_WRITTEN -----------------------------------------------------------------

    [Fact]
    public void AnEndAfterATerminatorAndAStatementAssignmentAreTheGrammarsLines()
    {
        // 20:33: 24 texts "navigate X()" + "end" refused as "unexpected line: end"; 20:34: an assignment after an assign
        // block, indented as a statement, refused as "expected '('".
        var (job, result) = Analyze(Ops(Flow(
            "action FamTela.FamIr\n  navigate FamOutra()\n  end\n",
            "action FamTela.FamSalvar\n  if FamOk:\n    raise FamErro(\"x\")\n    end\n  assign\n    FamA = 1\n  Client.FamB = FamA + 1\n  navigate FamOutra()\n")));
        Assert.Empty(Problems(result, "FLOW_SYNTAX"));
        Assert.Equal(2, Normalizations(result, "FLOW_END_AFTER_TERMINATOR").Length);
        Assert.Single(Normalizations(result, "FLOW_ASSIGN_WRITTEN"));
        var texts = job["ops"]![0]!["data"]!["flow"]!.AsArray();
        Assert.Equal("action FamTela.FamIr\n  navigate FamOutra()\n\n", texts[0]!.GetValue<string>());   // the line stays, blank: lines keep their numbers
        Assert.Contains("  assign Client.FamB = FamA + 1\n", texts[1]!.GetValue<string>());
    }

    [Fact]
    public void ATextThatParsesOrALineWithoutOneReadingIsLeftAlone()
    {
        // A named call is a node, never an assignment, even written wrong (two readings: a call node, or an assignment of a
        // function); a step after navigate is no `end`: the refusals say them.
        var (job, result) = Analyze(Ops(Flow(
            "action FamTela.FamSomar\n  FamTotal = FamCalcular(A=1)\n  end\n",
            "action FamTela.FamDepois\n  navigate FamOutra()\n  assign FamA = 1\n",
            "action FamTela.FamTalvez\n  FamTotal = FamCalcular(A = 1)\n  end\n")));
        Assert.Empty(Normalizations(result, "FLOW_ASSIGN_WRITTEN"));
        Assert.Empty(Normalizations(result, "FLOW_END_AFTER_TERMINATOR"));
        Assert.Equal(2, Problems(result, "FLOW_SYNTAX").Length);
        Assert.Equal("action FamTela.FamSomar\n  FamTotal = FamCalcular(A=1)\n  end\n", job["ops"]![0]!["data"]!["flow"]![0]!.GetValue<string>());
        Assert.Equal("action FamTela.FamTalvez\n  FamTotal = FamCalcular(A = 1)\n  end\n", job["ops"]![0]!["data"]!["flow"]![2]!.GetValue<string>());
    }

    // ---- CSS_FUNCTION_REWRITTEN -----------------------------------------------------------------------------------------

    [Fact]
    public void AColorMixOfACustomPropertyIsTheColorItComputesInEveryRuleThatDefinesIt()
    {
        // 20:33: color-mix(in oklch, var(--card) 60%, transparent) x3, refused with no substitute; written by hand as one fixed
        // rgba, the dark theme lost its color.
        var css = ":root{\n  --card: #ffffff;\n  --ink: oklch(94% 0.008 240);\n  --sub: var(--ink);\n}\n[data-theme=\"dark\"]{\n  --card: oklch(22% 0.025 245)\n}\n"
            + ".topbar{ background: color-mix(in oklch, var(--card) 60%, transparent); }\n.row:hover{ background: color-mix(in oklch, var(--sub) 50%, transparent); }\n";
        var (job, result) = Analyze(Ops(Css(css)));
        Assert.DoesNotContain(Anvil.Core.PreflightRules.StyleSheetRules.Check(job["ops"]!.AsArray(), "o11"), p => p["code"]!.GetValue<string>() == "CSS_FUNCTION_UNSUPPORTED");
        Assert.Equal(2, Normalizations(result, "CSS_FUNCTION_REWRITTEN").Length);
        var written = job["ops"]![0]!["value"]!.GetValue<string>();
        Assert.DoesNotContain("color-mix", written);
        Assert.Contains("--card: #ffffff; --card-mix-", written);
        Assert.Contains("rgba(255, 255, 255, 0.6);", written);
        Assert.Contains("--card: oklch(22% 0.025 245); --card-mix-", written);   // the dark rule had no ';': one is written
        Assert.Contains("oklch(22% 0.025 245 / 0.6);", written);
        Assert.Contains(".row:hover{ background: oklch(94% 0.008 240 / 0.5); }", written);   // defined once: the color itself
    }

    [Fact]
    public void LightDarkInAStyleSheetIsExpandedAndWhatHasNoSingleRenderingIsStillRefused()
    {
        var (job, result) = Analyze(Ops(Css(".a { color: light-dark(#111111, #eeeeee); border-color: color-mix(in srgb, #000000 50%, #ffffff); }\n")));
        Assert.Equal(2, Normalizations(result, "CSS_FUNCTION_REWRITTEN").Length);
        Assert.Empty(Anvil.Core.PreflightRules.StyleSheetRules.Check(job["ops"]!.AsArray(), "o11").Where(p => p["severity"]!.GetValue<string>() == "error"));
        var written = job["ops"]![0]!["value"]!.GetValue<string>();
        Assert.Contains("@media (prefers-color-scheme: dark)", written);
        Assert.Contains("#808080", written);
        // An OutSystems UI token may be defined by the base theme: never resolved here (StyleSheetRules refuses it).
        var (tokenJob, token) = Analyze(Ops(Css(":root{--color-primary:#ff0000}\n.b{ color: color-mix(in oklch, var(--color-primary) 40%, transparent); }\n")));
        Assert.Empty(Normalizations(token, "CSS_FUNCTION_REWRITTEN"));
        Assert.Contains("color-mix(in oklch, var(--color-primary) 40%, transparent)", tokenJob["ops"]![0]!["value"]!.GetValue<string>());
        Assert.Contains(Anvil.Core.PreflightRules.StyleSheetRules.Check(tokenJob["ops"]!.AsArray(), "o11"), p => p["code"]!.GetValue<string>() == "CSS_FUNCTION_UNSUPPORTED");
    }

    // ---- OPERAND_TYPES on a document's aggregate ------------------------------------------------------------------------

    [Fact]
    public void AnIdentifierOrderedAgainstANumberInAnAggregateIsRefusedWithTheVerifiedConversion()
    {
        // Round 38: `MockPlace.Id < 6` in the filter of the screen's aggregate, OperatorIncompatibleTypes from the Verify.
        var spec = new JsonObject { ["op"] = "spec", ["data"] = new JsonObject
        {
            ["static"] = new JsonArray(new JsonObject { ["name"] = "FamLugar", ["records"] = new JsonArray(new JsonObject { ["name"] = "A", ["id"] = 1 }) }),
            ["entities"] = new JsonArray(new JsonObject { ["name"] = "FamVisita", ["attributes"] = new JsonArray(new JsonObject { ["name"] = "Nome", ["type"] = "Text" }) }),
        } };
        var html = Screen + """<aggregate name="FamLugares" from="FamLugar" where="FamLugar.Id &lt; 6 or FamLugar.Label = &quot;x&quot;"/><aggregate name="FamVisitas" from="FamVisita" where="FamVisita.Id &gt; 10"/>""" + Body;
        var (_, result) = Analyze(Ops(spec, Html(html)));
        var problems = Problems(result, "OPERAND_TYPES");
        Assert.Equal(2, problems.Length);
        var patch = Assert.Single(problems[0]["patch"]!.AsArray()).AsObject();
        Assert.Equal("/ops/1/data/html", patch["path"]!.GetValue<string>());
        Assert.Contains("where=\"IdentifierToInteger(FamLugar.Id) &lt; 6 or FamLugar.Label = &quot;x&quot;\"", patch["value"]!.GetValue<string>());
        Assert.Contains("IdentifierToLongInteger(FamVisita.Id) &gt; 10", problems[1]["patch"]![0]!["value"]!.GetValue<string>());
        // Both patches applied: the same rule finds nothing (the patch is proved by the rule that refused).
        var patched = problems[0]["patch"]![0]!["value"]!.GetValue<string>().Replace("FamVisita.Id &gt; 10", "IdentifierToLongInteger(FamVisita.Id) &gt; 10");
        var (_, again) = Analyze(Ops(spec.DeepClone(), Html(patched)));
        Assert.Empty(Problems(again, "OPERAND_TYPES"));
        // An entity the job does not declare: its types are unknown, nothing is said.
        var (_, unknown) = Analyze(Ops(Html(Screen + """<aggregate name="FamOutros" from="Outra" where="Outra.Id &lt; 6"/>""" + Body)));
        Assert.Empty(Problems(unknown, "OPERAND_TYPES"));
        // The same family in the logic JSON: the rule that only said it now writes the conversion.
        var logic = new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(new JsonObject
        {
            ["name"] = "FamProximo", ["kind"] = "server",
            ["inputs"] = new JsonArray(new JsonObject { ["name"] = "Lugar", ["type"] = "FamLugar Identifier" }),
            ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Total", ["type"] = "Integer" }),
            ["steps"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["Total"] = "Lugar + 1" } }),
        }) } };
        var (_, inLogic) = Analyze(Ops(spec.DeepClone(), logic));
        var logicProblem = Assert.Single(Problems(inLogic, "OPERAND_TYPES"));
        Assert.Equal("IdentifierToInteger(Lugar) + 1", logicProblem["patch"]![0]!["value"]!.GetValue<string>());
    }
}

/// <summary>
/// Familias (2026-10-12, the round of 20:33: 244 pointers, 173 of them the cascade of four faults): a problem of the apply or
/// the Verify that names what a failed part of the job declares (a screen action of a logic text that did not parse, the
/// screen of a document that failed) leaves the problems; the root says blocks: N. Transitive, and a part that failed for a
/// fault of its own keeps it as a root.
/// </summary>
public sealed class FamilyCascadeTests
{
    private static JsonArray Job() => JsonNode.Parse("""
        [{"op":"html","data":{"html":"<screen name=\"FamTela\" flow=\"MainFlow\" actions=\"FamIr, FamOutro\"><Block name=\"LayoutBlank\"><slot name=\"Content\"></slot></Block></screen>"}},
         {"op":"logic","data":{"flow":["action FamTela.FamIr\n  navigat FamX()\n","action FamTela.FamOutro\n  end\n"]}}]
        """)!.AsArray();

    private static JsonObject P(string phase, int op, string pointer, string code, string message)
        => new() { ["phase"] = phase, ["op"] = op, ["pointer"] = pointer, ["code"] = code, ["severity"] = "error", ["message"] = message };

    [Fact]
    public void ANameAFailedPartDeclaresIsItsCascadeAndTheRootSaysWhatItBlocks()
    {
        var root = P("preflight", 1, "/ops/1/data/flow/0", "FLOW_SYNTAX", "logic: line 2: expected '(' at column 8: navigat FamX()");
        var all = new List<JsonObject>
        {
            root,
            P("apply", 0, "/ops/0/data/html", "HTML_NAME_UNKNOWN", "html: line 1 col 1: screen action 'FamIr' is not declared"),
            P("apply", 1, "/ops/1/data/flow/1", "FLOW_OWNER_UNKNOWN", "the header names the owner FamTela, and the module has no screen, block or email of that name (nearest: Login)"),
        };
        var folded = JobRunner.FoldCascade(all, Job(), "/ops");
        var only = Assert.Single(folded);
        Assert.Same(root, only);
        Assert.Equal(2, only["blocks"]!.GetValue<int>());   // the document failed only for it, and the second text for the document
    }

    [Fact]
    public void APartWithAFaultOfItsOwnKeepsItAsARootAndANameNoPartDeclaresStays()
    {
        var flow = P("preflight", 1, "/ops/1/data/flow/0", "FLOW_SYNTAX", "logic: line 2: expected '(' at column 8: navigat FamX()");
        var own = P("apply", 0, "/ops/0/data/html", "HTML_NAME_UNKNOWN", "html: line 1 col 40: onclick=\"FamNada\": no Object is named 'FamNada'");
        var all = new List<JsonObject>
        {
            flow, own,
            P("apply", 0, "/ops/0/data/html", "HTML_NAME_UNKNOWN", "html: line 1 col 1: screen action 'FamIr' is not declared"),
            P("apply", 1, "/ops/1/data/flow/1", "FLOW_OWNER_UNKNOWN", "the header names the owner FamTela, and the module has no screen, block or email of that name (nearest: Login)"),
        };
        var folded = JobRunner.FoldCascade(all, Job(), "/ops");
        Assert.Equal(2, folded.Count);
        Assert.Equal(1, flow["blocks"]!.GetValue<int>());
        Assert.Equal(1, own["blocks"]!.GetValue<int>());
        // Nothing failed: nothing is folded.
        var alone = new List<JsonObject> { P("apply", 0, "/ops/0/data/html", "HTML_NAME_UNKNOWN", "html: line 1 col 1: screen action 'FamIr' is not declared") };
        Assert.Single(JobRunner.FoldCascade(alone, Job(), "/ops"));
        // A part the Verify refused was applied: what it declares is there, a name problem elsewhere is a fault of its own.
        var applied = new List<JsonObject>
        {
            P("verify", 1, "/ops/1/data/flow/0", "InvalidFlow_NoStart", "Error InvalidFlow_NoStart: ... @ FamTela (MobileScreen) / FamIr (ScreenAction)"),
            P("verify", 0, "/ops/0", "ExpressionUnknownObject", "Error ExpressionUnknownObject: Unknown object 'FamIr' @ FamTela (MobileScreen)"),
        };
        Assert.Equal(2, JobRunner.FoldCascade(applied, Job(), "/ops").Count);
    }
}
