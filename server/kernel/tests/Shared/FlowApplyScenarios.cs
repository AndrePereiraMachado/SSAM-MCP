using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Linked into both test projects: the logic op's text form (stage LG2, ModelSession.ApplyFlowText) through a real job
/// (JobRunner: preflight, apply, Verify, save) on the lane's blank fixture. A job creates an action with the JSON form; its
/// text is read from the saved module (ModuleFlow, the text ssam_map view "flow" serves), edited, and sent back as
/// {"op":"logic","data":{"flow":[{"text","basedOn"}]}}: only what changed is written, every element the text kept keeps
/// its key, and the saved module reads back as the text. The rules refuse once with every problem; a query in a new loop is
/// QUERY_IN_LOOP (T3) as for any op; a stale read is FLOW_BASE_CHANGED with the current text.
/// </summary>
public static class FlowApplyScenarios
{
    // ---- calls and caches of one op (lab/batch-speed, R5) ----------------------------------------------------------------

    // A screen or block action calls the action of its own owner: two blocks with a Reset each, created, saved, reloaded,
    // merged and edited, never cross; a call of a name only another owner has is FLOW_NAME_UNKNOWN.
    public static void SameNamedUiCallsBindToTheirOwnerAcrossCreateReloadEditAndMerge(string dir, string fixture, string lane, Action<ModelHost, string, string, string> merge)
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(FlowApplyScenarios).Assembly.Location)!)!;
        var host = new ModelHost(Path.Combine(dir, "work"));
        fixture = Path.IsPathRooted(fixture) ? fixture : Path.Combine(root, fixture.StartsWith("tests/") ? fixture : Path.Combine("tests", "fixtures", fixture));
        string Apply(string name, string basis, string job)
        {
            var source = Path.Combine(dir, name + ".json"); File.WriteAllText(source, job);
            var target = Path.Combine(dir, name + ".oml");
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, source, target))!;
            Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString()); return target;
        }
        var original = """
        {"ops":[{"op":"html","data":{"html":"<block name=\"OtherPanel\" actions=\"Run,Reset\"><var name=\"Value\" type=\"Integer\"/><button onclick=\"Run\">Run</button></block>"}},
        {"op":"logic","data":{"flow":["action OtherPanel.Reset\n  in Amount: Integer\n  assign Value = Amount\n  end\n","action OtherPanel.Run\n  Reset(Amount=99)\n  end\n"]}}]}
        """;
        var basis = Apply("ui-owner-base", fixture, original);
        var job = """
        {"ops":[{"op":"html","data":{"html":"<block name=\"LocalPanel\" actions=\"RunA,RunB,Reset\"><var name=\"Value\" type=\"Integer\"/><button onclick=\"RunA\">A</button><button onclick=\"RunB\">B</button></block>"}},
        {"op":"logic","data":{"flow":["action LocalPanel.RunA\n  Reset(Amount=11)\n  end\n","action LocalPanel.RunB\n  Reset(Amount=13)\n  end\n","action LocalPanel.Reset\n  in Amount: Integer\n  assign Value = Value+Amount\n  end\n"]}}]}
        """;
        var candidate = Apply("ui-owner-create", basis, job);
        void Bound(string path, string a = "11")
        {
            var model = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [path])!;
            try {
                var session = (ModelSession)Activator.CreateInstance(typeof(ModelSession), model)!;
                var wanted = session.Get(session.Resolve("IMobileBlock:LocalPanel/Reset"))["key"]!.ToString();
                foreach (var (caller, amount) in new[] { ("RunA", a), ("RunB", "13") }) {
                    var call = session.Get(session.Resolve("IMobileBlock:LocalPanel/" + caller + "/Reset"));
                    Assert.Equal("@" + wanted, call["properties"]!["Action"]!.ToString());
                    var arg = session.Get(session.Resolve("IMobileBlock:LocalPanel/" + caller + "/Reset/Amount"));
                    Assert.Equal(amount, arg["properties"]!["Value"]!.ToString());
                }
                var other = session.Get(session.Resolve("IMobileBlock:OtherPanel/Reset"))["key"]!.ToString();
                Assert.NotEqual(wanted, other);
                Assert.Equal("@" + other, session.Get(session.Resolve("IMobileBlock:OtherPanel/Run/Reset"))["properties"]!["Action"]!.ToString());
            } finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [model]); }
        }
        Bound(candidate);
        var merged = Path.Combine(dir, "merged.oml");
        merge(host, basis, candidate, merged); Bound(merged);
        List<FlowEntry> Flows(string path)
        {
            var bytes = File.ReadAllBytes(path);
            return host.BuildFlow(bytes, Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant(), lane).Actions.ToList();
        }
        var beforeFlows = Flows(merged);
        var current = beforeFlows.Single(f => f.Name.EndsWith("/LocalPanel/RunA"));
        var changed = System.Text.RegularExpressions.Regex.Replace(current.Text, @"Amount\s*=\s*11", "Amount=17");
        Assert.NotEqual(current.Text, changed);
        var edit = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject {
            ["flow"] = changed, ["basedOn"] = current.TextSha } }) };
        var edited = Apply("ui-owner-edit", merged, edit.ToJsonString());
        Bound(edited, "17");
        var afterFlows = Flows(edited).ToDictionary(f => f.Key);
        foreach (var flow in beforeFlows.Where(f => !f.Name.EndsWith("/LocalPanel/RunA")))
            Assert.Equal(flow.Text, afterFlows[flow.Key].Text);
        var foreignOnly = """{"ops":[{"op":"html","data":{"html":"<block name=\"ForeignOnly\" actions=\"Run\"><button onclick=\"Run\">Run</button></block>"}},{"op":"logic","data":{"flow":"action ForeignOnly.Run\n  Reset(Amount=1)\n  end\n"}}]}""";
        var refused = Assert.ThrowsAny<Exception>(() => Apply("ui-owner-refused", edited, foreignOnly));
        Assert.Equal("FLOW_NAME_UNKNOWN", (Errors.FindCoded(refused) as KernelRefusalException)?.Code);
    }

    // The entities and structures a logic-text op names are indexed once for the op, and again for an op after a data op
    // (which adds a record the next texts map).
    public static void RecordTypeIndexIsSharedWithinLogicAndRenewedAfterDataChanges(string dir, string fixture, string lane)
    {
        var initial = "type IxSource = { Code: Text(40); Quantity: Integer; }\ntype IxTarget = { Code: Text(40); Total: Integer; }";
        string Map(string name, string source, string code, string count) => $"server action {name}\n  in Rows: {source} List\n  out Result: IxTarget List\n  assign Result = Rows mapTo {{ Code: {code}, Total: {count} }}\n  end\n";
        var a = Map("IxFirst", "IxSource", "Code", "Quantity+1");
        var b = Map("IxSecond", "IxSource", "ToUpper(Code)", "Quantity*2");
        var c = Map("IxLaterMap", "IxLater", "Label", "Count+3");
        JsonObject Ddl(string text) => new() { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = text } };
        using var metrics = NativePerformanceCapture.Begin();
        var result = Run(dir, "ix-types", $$$"""{"base":"{{{fixture}}}","ops":[{{{Ddl(initial).ToJsonString()}}},{{{Texts(a, b)}}},{{{Ddl("type IxLater = { Label: Text(40); Count: Integer; }").ToJsonString()}}},{{{Texts(c)}}}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var phases = metrics.Snapshot().Phases;
        Assert.True(phases.TryGetValue("flow.types.recordIndex", out var index));
        Assert.Equal(2, index!.Calls);
        Assert.False(phases.ContainsKey("flow.types.nameIndex"));
        foreach (var (name, text) in new[] { ("IxFirst", a), ("IxSecond", b), ("IxLaterMap", c) })
            Assert.Equal(text, Bare(Read(dir, "ix-types", lane, name).Text));
    }

    // ---- the tolerated shapes of a text (R1, FlowTolerance) ---------------------------------------------------------------

    // A job whose texts are written in the shapes a model writes (one space a level, `assign X=v`, `Result=Action(P = v)`,
    // `else:`, a declaration among the steps, a label after one space, a mapping without spaces after its commas) is
    // normalized, each shape listed, and applied: no FLOW_NOT_EXACT; the saved module reads back (FlowExtract) as the canonical
    // text, and that text sent again writes nothing.
    public static void ToleratedShapesApplyAndReadBackAsTheCanonicalText(string dir, string fixture, string lane)
    {
        var ddl = new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = "type TolSource = { Code: Text(40); Quantity: Integer; }\ntype TolTarget = { Code: Text(40); Total: Integer; }" } };
        var twice = "server action TolTwice\n in N: Integer\n out R: Integer\n assign R=N*2\n end\n";
        var use = "server action TolUse\n  in Rows: TolSource List\n  in A: Integer\n  assign Total=0\n  out Total: Integer\n  out Copy: TolTarget List\n"
            + "  if A > 0:\n    Saved=TolTwice(N = A)\n    assign Total=Saved.R\n  else:\n    assign Total = 1 # none\n  assign Copy = Rows mapTo { Code: Code,Total: Quantity+1 }\n  end\n";
        var result = Run(dir, "tolerated", $$$"""{"base":"{{{fixture}}}","ops":[{{{ddl.ToJsonString()}}},{{{Texts(twice, use)}}}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var rules = (result["normalizations"] as JsonArray ?? []).OfType<JsonObject>().Select(n => n["rule"]!.ToString()).ToHashSet();
        foreach (var rule in new[] { FlowTolerance.IndentUnit, FlowTolerance.AssignSpacing, FlowTolerance.ResultSpacing, FlowTolerance.ArgumentSpacing,
                     FlowTolerance.Else, FlowTolerance.DeclarationOrder, FlowTextEdit.LabelSpacing })
            Assert.Contains(rule, rules);
        Assert.Equal("server action TolTwice\n  in N: Integer\n  out R: Integer\n  assign R = N*2\n  end\n", Bare(Read(dir, "tolerated", lane, "TolTwice").Text));
        var read = Read(dir, "tolerated", lane, "TolUse");
        var bare = Bare(read.Text);
        foreach (var line in new[] { "  out Total: Integer\n  out Copy: TolTarget List\n  assign Total = 0\n", "    Saved = TolTwice(N=A)\n", "    assign Total = Saved.R\n",
                     "  assign Total = 1  # none\n", "  assign Copy = Rows mapTo { Code: Code, Total: Quantity+1 }\n" })
            Assert.Contains(line, bare);
        Assert.DoesNotContain("else", bare);
        var again = Run(dir, "tolerated-again", "{\"ops\":[" + Flow((read.Text, read.TextSha)) + "]}", Path.Combine(dir, "tolerated.oml"));
        Assert.True(again["accepted"]!.GetValue<bool>(), again.ToJsonString());
        Assert.Equal(read.Text, Read(dir, "tolerated-again", lane, "TolUse").Text);
    }

    // ---- the general language of ssam-flow/1 (R7, FlowGeneral) ---------------------------------------------------------

    private const string GeneralData = """
        {"op":"spec","data":{"entities":[
          {"name":"GxOrder","attributes":[{"name":"Code","type":"Text","length":40},{"name":"Total","type":"Decimal"},{"name":"Status","type":"Integer"}]}],
          "structures":[{"name":"GxRow","attributes":[{"name":"Code","type":"Text","length":40},{"name":"Total","type":"Decimal"}]}]}}
        """;
    private const string GeneralException = """{"op":"create","parent":"@espace","type":"IUserException","name":"GxRejected"}""";

    // The texts as a model writes them in the general language (let, require, return, the joins of If, For Each and Switch,
    // a copy, the parameters of a sql) go through a real job: each form is listed in normalizations, the saved module reads
    // back (FlowExtract) as the expanded text, and that text sent again writes nothing.
    public static void GeneralFormsApplyAndReadBackAsTheExpandedText(string dir, string fixture, string lane)
    {
        string L(params string[] lines) => string.Join("\n", lines) + "\n";
        var texts = new[] {
            L("server action GxPrice", "  in Total: Decimal", "  in Rate: Decimal", "  out Price: Decimal", "  out Label: Text",
                "  require Total >= 0 and Rate > 0 else GxRejected(\"invalid\")", "  let Gross = Total * (1 + Rate)", "  let Name = \"P\" + DecimalToText(Gross)",
                "  if Gross > 1000:", "    return Price = 1000, Label = \"capped\"", "  return Price = Gross, Label = Name"),
            L("server action GxCount", "  in Rows: GxRow List", "  in Minimum: Decimal", "  in Source: GxRow", "  out Count: Integer", "  out Copy: GxRow", "  let Seen = 0",
                "  foreach Rows:", "    if Rows.Current.Total >= Minimum:", "      assign Seen = Seen + 1", "  if Seen = 0:", "    assign Seen = -1",
                "  Totals = sql -> GxRow max 1", "    | SELECT {GxOrder}.[Code], {GxOrder}.[Total] FROM {GxOrder} WHERE {GxOrder}.[Total] >= @Minimum",
                "  assign Copy = { ...Source, Total: Source.Total + Minimum }", "  return Count = Seen"),
            L("server action GxGrade", "  in Score: Integer", "  out Grade: Text", "  let Bonus = 5", "  switch:", "    case Score + Bonus >= 90:", "      assign Grade = \"A\"",
                "    case Score + Bonus >= 70:", "      return Grade = \"B\"", "    otherwise:", "      assign Grade = \"C\"", "  assign Grade = Grade + \"!\"", "  return"),
        };
        var result = Run(dir, "general", $$$"""{"base":"{{{fixture}}}","ops":[{{{GeneralData}}},{{{GeneralException}}},{{{Texts(texts)}}}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var rules = (result["normalizations"] as JsonArray ?? []).OfType<JsonObject>().Select(n => n["rule"]!.ToString()).ToHashSet();
        foreach (var rule in new[] { FlowGeneral.Let, FlowGeneral.Require, FlowGeneral.Return, FlowGeneral.Join, FlowGeneral.Copy, FlowGeneral.SqlBind })
            Assert.Contains(rule, rules);
        var reads = new List<(string Text, string TextSha)>();
        foreach (var (name, text) in new[] { "GxPrice", "GxCount", "GxGrade" }.Zip(texts)) {
            var read = Read(dir, "general", lane, name);
            // The module reads back as the expanded text: the same action (graph, values, declarations) as its normalization.
            var expanded = ModuleFlow.Read(FlowTextNormalizer.Normalize(text).Text);
            var written = ModuleFlow.Read(read.Text);
            Assert.Equal(Bare(ModuleFlow.Print(expanded).Text).Replace("\r\n", "\n"), Bare(read.Text));
            Assert.DoesNotContain("let ", read.Text);
            Assert.Equal(expanded.Items.Count(i => i.Role == "node"), written.Items.Count(i => i.Role == "node"));
            reads.Add((read.Text, read.TextSha));
        }
        Assert.Contains("    in Minimum: Decimal = Minimum\n", Bare(Read(dir, "general", lane, "GxCount").Text));
        var again = Run(dir, "general-again", "{\"ops\":[" + Flow(reads.ToArray()) + "]}", Path.Combine(dir, "general.oml"));
        Assert.True(again["accepted"]!.GetValue<bool>(), again.ToJsonString());
        foreach (var (name, read) in new[] { "GxPrice", "GxCount", "GxGrade" }.Zip(reads)) Assert.Equal(read.Text, Read(dir, "general-again", lane, name).Text);
    }

    // Part 2 of the general language through a real job: a contract with a binding above the action that uses it, the record
    // operations (load ... locked, update, insert, delete: the entity actions), a bind under a sql node and a copy (two
    // assigns); the module reads back as the expanded text and that text sent again writes nothing.
    public static void RecordsContractsAndBindsApplyAndReadBackAsTheExpandedText(string dir, string fixture, string lane)
    {
        string L(params string[] lines) => string.Join("\n", lines) + "\n";
        var texts = new[] {
            L("contract GxOwned:", "  in OrderId: GxOrder Identifier", "  load Order: GxOrder by OrderId locked", "  require Order.Status > 0 else GxRejected(\"closed\")",
                "binding Floor: Decimal = 0", "", "server action GxPay", "  use GxOwned", "  in Amount: Decimal", "  out Total: Decimal", "  out Others: Integer",
                "  update Order {Total=Order.Total+Amount, Status=Order.Status+1}", "  Rows = sql -> GxRow max 10", "    bind Code: Text = Order.Code",
                "    | SELECT {GxOrder}.[Code], {GxOrder}.[Total] FROM {GxOrder} WHERE {GxOrder}.[Code] <> @Code AND {GxOrder}.[Total] > @Floor",
                "  return Total = Order.Total, Others = Rows.List.Length"),
            L("server action GxOpen", "  in Code: Text", "  in Source: GxRow", "  out Id: GxOrder Identifier", "  insert N: GxOrder {Code=Code, Total=Source.Total, Status=1}",
                "  let Copy = { ...Source, Total: Source.Total * 2 }", "  require Copy.Total > 0 else GxRejected(\"empty\")", "  load Again: GxOrder by N.Id locked", "  delete Again",
                "  return Id = N.Id"),
        };
        var result = Run(dir, "general-records", $$$"""{"base":"{{{fixture}}}","ops":[{{{GeneralData}}},{{{GeneralException}}},{{{Texts(texts)}}}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var rules = (result["normalizations"] as JsonArray ?? []).OfType<JsonObject>().Select(n => n["rule"]!.ToString()).ToHashSet();
        foreach (var rule in new[] { FlowGeneral.Contract, FlowGeneral.Record, FlowGeneral.SqlBind, FlowGeneral.Copy, FlowGeneral.Let })
            Assert.Contains(rule, rules);
        var reads = new List<(string Text, string TextSha)>();
        foreach (var (name, text) in new[] { "GxPay", "GxOpen" }.Zip(texts)) {
            var read = Read(dir, "general-records", lane, name);
            Assert.Equal(Bare(ModuleFlow.Print(ModuleFlow.Read(FlowTextNormalizer.Normalize(text).Text)).Text).Replace("\r\n", "\n"), Bare(read.Text));
            reads.Add((read.Text, read.TextSha));
        }
        var pay = Bare(reads[0].Text);
        foreach (var line in new[] { "  in OrderId: GxOrder Identifier\n", "GetGxOrderForUpdate(Id=OrderId)", "UpdateGxOrder(Source=Order)", "    in Code: Text = Order.Code\n", "    in Floor: Decimal = 0\n" })
            Assert.Contains(line, pay);
        foreach (var line in new[] { "CreateGxOrder(Source=N)", "DeleteGxOrder(Id=Again.Id)", "  assign Copy = Source\n" }) Assert.Contains(line, Bare(reads[1].Text));
        var again = Run(dir, "general-records-again", "{\"ops\":[" + Flow(reads.ToArray()) + "]}", Path.Combine(dir, "general-records.oml"));
        Assert.True(again["accepted"]!.GetValue<bool>(), again.ToJsonString());
        foreach (var (name, read) in new[] { "GxPay", "GxOpen" }.Zip(reads)) Assert.Equal(read.Text, Read(dir, "general-records-again", lane, name).Text);
    }

    // The forms that need the module or the whole op (a context, a projection mapTo { * }, a let typed by an attribute or by
    // the output of an action of the op) expand through FlowTextNormalizer.NormalizeAll with the schema of the job's own
    // records; the texts they give apply and read back as written, the context an input of the actions that read it and of
    // their callers.
    public static void ContextProjectionAndTypedLetsApplyThroughTheOp(string dir, string fixture, string lane)
    {
        string L(params string[] lines) => string.Join("\n", lines) + "\n";
        var schema = FlowSchema.Of(new Dictionary<string, IReadOnlyList<(string Name, string Type)>> {
            ["GxRow"] = [("Code", "Text"), ("Total", "Decimal")],
            ["GxOrder"] = [("Id", "GxOrder Identifier"), ("Code", "Text"), ("Total", "Decimal"), ("Status", "Integer")],
        });
        var authored = new[] {
            L("context Tenant: Integer", "", "server action GxTenantTotal", "  in Rows: GxRow List", "  out Doubled: GxOrder List", "  out Total: Decimal",
                "  require Tenant > 0 and not Rows.Empty else GxRejected(\"no tenant\")", "  let First = Rows.Current.Total", "  let Count = Rows.Length",
                "  assign Doubled = Rows mapTo { *, Total: Total * 2, Status: 1, Id: NullIdentifier() }", "  return Total = First * Count"),
            L("server action GxTenantRun", "  in Rows: GxRow List", "  out Total: Decimal", "  Inner = GxTenantTotal(Rows)", "  let Result = Inner.Total", "  return Total = Result"),
        };
        var normalized = FlowTextNormalizer.NormalizeAll(authored, schema);
        foreach (var n in normalized) Assert.Contains(n.Edits, e => e.Rule.StartsWith("FLOW_GENERAL_", StringComparison.Ordinal));
        Assert.Contains("  assign Doubled = Rows mapTo { Id: NullIdentifier(), Code: Code, Total: Total * 2, Status: 1 }\n", normalized[0].Text);
        Assert.Contains("  local First: Decimal\n", normalized[0].Text);
        Assert.Contains("  in Tenant: Integer\n", normalized[1].Text);
        Assert.Contains("  Inner = GxTenantTotal(Rows, Tenant)\n", normalized[1].Text);
        Assert.Contains("  local Result: Decimal\n", normalized[1].Text);
        var texts = normalized.Select(n => n.Text.TrimStart('\n')).ToArray();
        var result = Run(dir, "general-op", $$$"""{"base":"{{{fixture}}}","ops":[{{{GeneralData}}},{{{GeneralException}}},{{{Texts(texts)}}}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        foreach (var (name, text) in new[] { "GxTenantTotal", "GxTenantRun" }.Zip(texts))
            Assert.Equal(Bare(ModuleFlow.Print(ModuleFlow.Read(text)).Text).Replace("\r\n", "\n"), Bare(Read(dir, "general-op", lane, name).Text));
    }

    // ---- connectors of If, Switch and For Each changed by an edit (lab/batch-speed, R5) ----------------------------------

    // The branches of an If and two cases of a Switch trade their targets: every node keeps its key, the connectors change
    // (each changed one is disconnected before it is linked again) and the Switch keeps the order of its conditions.
    public static void SwappingDecisionTargetsKeepsEveryNodeIdentity(string dir, string fixture, string lane)
    {
        var sources = new[] {
            "server action SwapIf\n  in Choice: Integer\n  out Total: Integer\n  if Choice=1:\n    assign Total = 10\n    end\n  assign Total = 20\n  end\n",
            "server action SwapSwitch\n  in Choice: Integer\n  out Total: Integer\n  switch:\n    case Choice=1:\n      assign Total = 10\n      end\n    case Choice=2:\n      assign Total = 20\n      end\n    otherwise:\n      assign Total = 30\n      end\n"
        };
        var initial = new JsonObject { ["base"] = fixture, ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(sources.Select(s => (JsonNode)JsonValue.Create(s)!).ToArray()) } }) };
        Assert.True(Run(dir, "decisions-original", initial.ToJsonString())["accepted"]!.GetValue<bool>());
        var reads = new[] { "SwapIf", "SwapSwitch" }.Select(n => Read(dir, "decisions-original", lane, n)).ToArray();
        var edits = reads.Select(r => {
            var a = Line(r.Text, "assign Total = 10"); var b = Line(r.Text, "assign Total = 20");
            static string Indent(string line) => line[..(line.Length - line.TrimStart().Length)];
            return (r.Text.Replace(a, "__SWAP_BRANCH__").Replace(b, Indent(b) + a.TrimStart()).Replace("__SWAP_BRANCH__", Indent(a) + b.TrimStart()), r.TextSha);
        }).ToArray();
        var changed = Run(dir, "decisions-swapped", "{\"ops\":[" + Flow(edits) + "]}", Path.Combine(dir, "decisions-original.oml"));
        Assert.True(changed["accepted"]!.GetValue<bool>(), changed.ToJsonString());
        foreach (var old in reads) {
            var after = Read(dir, "decisions-swapped", lane, old.Name);
            Assert.Equal(old.Ids.Values.Order(), after.Ids.Values.Order());
            Assert.True(after.Text.IndexOf("assign Total = 20", StringComparison.Ordinal) < after.Text.IndexOf("assign Total = 10", StringComparison.Ordinal), after.Text);
        }
        var swapped = Read(dir, "decisions-swapped", lane, "SwapSwitch").Text;
        Assert.True(swapped.IndexOf("case Choice=1:", StringComparison.Ordinal) < swapped.IndexOf("case Choice=2:", StringComparison.Ordinal), swapped);
    }

    // A For Each nested in another moves out to follow it: its nodes keep their keys, the old connectors are detached (the
    // new body is not reached through the old exit), and the text read again is a fixed point.
    public static void MovingNestedLoopToSequencePreservesNodesAndDetachesOldEdges(string dir, string fixture, string lane)
    {
        var text = """
        server action ReorganizeLoops
          in Rows: Integer List
          in Other: Integer List
          out Total: Integer
          foreach Rows:
            assign Total = 0
            foreach Other:
              if Other.Current>0:
                assign Total = Total+1
            if Total=0:
              assign Total = 2
          assign Total = 3
          end
        """;
        var initial = new JsonObject { ["base"] = fixture, ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(text) } }) };
        var first = Run(dir, "loop-original", initial.ToJsonString()); Assert.True(first["accepted"]!.GetValue<bool>(), first.ToJsonString());
        var read = Read(dir, "loop-original", lane, "ReorganizeLoops");
        var lines = read.Text.Split('\n');
        var header = string.Join('\n', lines.TakeWhile(l => !l.TrimStart().StartsWith("foreach Rows:")));
        string At(string content, int spaces) => new string(' ', spaces) + Line(read.Text, content).TrimStart();
        var edited = header + "\n" + string.Join('\n', new[] {
            At("foreach Rows:", 2), At("assign Total = 0", 4), "    next",
            At("foreach Other:", 2), At("if Total=0:", 4), At("assign Total = 2", 6), "      next",
            At("assign Total = Total+1", 4), "    next", At("assign Total = 3", 2), At("end @", 2) }) + "\n";
        var changed = Run(dir, "loop-reordered", "{\"ops\":[" + Flow((edited, read.TextSha)) + "]}", Path.Combine(dir, "loop-original.oml"));
        Assert.True(changed["accepted"]!.GetValue<bool>(), changed.ToJsonString());
        var after = Read(dir, "loop-reordered", lane, "ReorganizeLoops");
        var removed = Line(read.Text, "if Other.Current>0:").Split('@').Last().Trim();
        foreach (var id in read.Ids.Where(p => p.Key != removed)) Assert.Contains(id.Value, after.Ids.Values);
        Assert.Equal(2, after.Text.Split('\n').Count(l => l.StartsWith("  foreach ")));
        Assert.DoesNotContain("    foreach ", after.Text);
        Assert.Contains("if Total=0:", after.Text);
        var unchanged = Run(dir, "loop-fixed-point", "{\"ops\":[" + Flow((after.Text, after.TextSha)) + "]}", Path.Combine(dir, "loop-reordered.oml"));
        Assert.True(unchanged["accepted"]!.GetValue<bool>(), unchanged.ToJsonString());
        Assert.Equal(after.Text, Read(dir, "loop-fixed-point", lane, "ReorganizeLoops").Text);
    }

    private const string Spec = """
        {"op":"spec","data":{"entities":[{"name":"FaOrder","attributes":[{"name":"Title","type":"Text","length":50},{"name":"Qty","type":"Integer"}]}]}}
        """;

    private const string Action = """
        {"op":"logic","data":{"actions":[{"name":"FaCount","inputs":[{"name":"Limit","type":"Integer"}],"outputs":[{"name":"Total","type":"Integer"}],
          "vars":[{"name":"Seen","type":"Long Integer"}],"steps":[
          {"assign":{"Total":"0"},"as":"Reset"},
          {"get":"FaOrder","as":"GetOrders","where":"FaOrder.Qty > 0","max":"Limit"},
          {"foreach":"GetOrders.List","as":"EachOrder","do":[{"assign":{"Total":"Total + GetOrders.List.Current.FaOrder.Qty"},"as":"AddQty"}]},
          {"assign":{"Seen":"GetOrders.Count"},"as":"CountSeen"}]}]}}
        """;

    // basePath: the saved module of an earlier job of the scenario (its keys, which the text names; a job: base would run
    // that job again and give new keys).
    private static JsonNode Run(string dir, string name, string job, string? basePath = null)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), basePath, path, Path.Combine(dir, name + ".oml")))!;
    }

    private static JsonArray Refused(string dir, string name, string job, string? basePath = null)
    {
        var error = Assert.ThrowsAny<Exception>(() => Run(dir, name, job, basePath));
        var coded = Errors.FindCoded(error);
        Assert.True(coded != null, Errors.Text(error));
        File.WriteAllText(Path.Combine(dir, name + ".refusal.json"), coded!.Problems?.ToJsonString() + Environment.NewLine + Errors.Text(error));
        return coded.Problems!;
    }

    // The action as the saved module reads (the store the facade serves is built the same way).
    private static FlowEntry Read(string dir, string name, string lane, string action)
    {
        var bytes = File.ReadAllBytes(Path.Combine(dir, name + ".oml"));
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var flow = new ModelHost(Path.Combine(dir, "work")).BuildFlow(bytes, sha, lane);
        var entry = flow.Actions.Single(a => a.Name == action || action.Contains('/') && a.Name.EndsWith('/' + action, StringComparison.Ordinal));
        Assert.True(entry.FixedPoint, string.Join("\n", entry.Problems));
        return entry;
    }

    private static string Flow(params (string Text, string BasedOn)[] texts) =>
        new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(texts.Select(t => (JsonNode)new JsonObject { ["text"] = t.Text, ["basedOn"] = t.BasedOn }).ToArray()) } }.ToJsonString();

    private static string Line(string text, string contains) => text.Split('\n').Single(l => l.Contains(contains, StringComparison.Ordinal));

    // The lines of the element whose line contains `contains`: its line and the deeper lines under it (@{...}, assignments).
    private static string Block(string text, string contains)
    {
        var lines = text.Split('\n');
        var at = Array.FindIndex(lines, l => l.Contains(contains, StringComparison.Ordinal));
        int Depth(string l) => l.Length - l.TrimStart().Length;
        var end = at + 1;
        while (end < lines.Length && lines[end].Length > 0 && Depth(lines[end]) > Depth(lines[at])) end++;
        return string.Join("\n", lines[at..end]) + "\n";
    }

    public static void AnEditedTextWritesOnlyWhatChangedAndReadsBackAsTheText(string dir, string fixture, string lane)
    {
        Run(dir, "fa-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{Action}}}]}""");
        var read = Read(dir, "fa-base", lane, "FaCount");
        // An expression, a new step without an id after the loop, the local renamed with its id (every expression that
        // names it with it) and the first assign removed.
        var text = read.Text.Replace("Total + GetOrders.List.Current.FaOrder.Qty", "Total + GetOrders.List.Current.FaOrder.Qty * 2");
        var countSeen = Block(text, "assign Seen = GetOrders.Count");
        text = text.Replace(countSeen, countSeen + "  assign Total = Total + 1  # Count the call\n");
        text = System.Text.RegularExpressions.Regex.Replace(text, @"\bSeen\b", "Visited");
        text = text.Replace(Block(text, "assign Total = 0"), "");
        var result = Run(dir, "fa-edit", $$$"""{"ops":[{{{Flow((text, read.TextSha))}}}]}""", Path.Combine(dir, "fa-base.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var receipt = result["results"]![0]!["result"]!["flow"]![0]!;
        Assert.Equal(1, receipt["created"]!.AsObject().Count);
        Assert.Contains(receipt["renamed"]!.AsArray(), r => r!["from"]!.ToString() == "Seen" && r["to"]!.ToString() == "Visited");
        Assert.Single(receipt["deleted"]!.AsArray());
        Assert.Null(receipt["defaults"]);
        // The saved module reads back as the text: the kept elements with the ids of the read (their keys), the new one with
        // the id the job gave it.
        var after = Read(dir, "fa-edit", lane, "FaCount");
        Assert.Equal(receipt["textSha"]!.ToString(), after.TextSha);
        var ids = read.Ids.Where(p => p.Key != "start").ToDictionary(p => p.Value, p => p.Key);
        foreach (var (id, key) in receipt["keys"]!.AsObject()) ids[key!.ToString()] = id;
        var item = ModuleFlow.Read(after.Text, after.Ids);
        Assert.Equal(text.Replace("  # Count the call\n", "  # Count the call @+1\n"), ModuleFlow.Print(item, ids).Text);
        // Every key of the read but the removed node is still there.
        var removed = read.Ids[Line(read.Text, "assign Total = 0")[(Line(read.Text, "assign Total = 0").LastIndexOf('@') + 1)..]];
        Assert.All(read.Ids.Values.Where(k => k != removed), key => Assert.Contains(key, after.Ids.Values));
        // The same text again writes nothing.
        var again = Run(dir, "fa-again", $$$"""{"ops":[{{{Flow((after.Text, after.TextSha))}}}]}""", Path.Combine(dir, "fa-edit.oml"));
        Assert.Equal(0, again["results"]![0]!["result"]!["flow"]![0]!["ops"]!.AsObject().Count);
    }

    public static void TheRulesRefuseTheTextOnceWithEveryProblem(string dir, string fixture, string lane)
    {
        Run(dir, "fa-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{Action}}}]}""");
        var read = Read(dir, "fa-base", lane, "FaCount");
        var countSeen = Block(read.Text, "assign Seen = GetOrders.Count");
        var text = read.Text.Replace(countSeen, countSeen + "  assign Total = 1 @n99\n"
            + "  foreach GetOrders.List:\n    if GetOrders.List.Current.FaOrder.Qty > 1:\n      (System).ListAppend(Element=GetOrders.List.Current, List=Picked)\n      next\n    next\n");
        var problems = Refused(dir, "fa-rules", $$$"""{"ops":[{{{Flow((text, read.TextSha))}}}]}""", Path.Combine(dir, "fa-base.oml"));
        var codes = problems.Select(p => p!["code"]!.ToString()).ToList();
        Assert.Contains("FLOW_KEY_FOREIGN", codes);
        var foreach_ = Assert.Single(problems, p => p!["code"]!.ToString() == "FLOW_FOREACH_LIST_ACTION")!;
        Assert.Contains("ListFilter(Condition=GetOrders.List.Current.FaOrder.Qty > 1, SourceList=GetOrders.List)", foreach_["text"]!.ToString());
        Assert.All(problems.Where(p => p!["code"]!.ToString().StartsWith("FLOW_", StringComparison.Ordinal)), p => Assert.Equal("/ops/0/data/flow/0", p!["pointer"]!.ToString()));
        // A stale read: the action changed after it (basedOn is the read's textSha): refused with the current text.
        var stale = Refused(dir, "fa-stale", $$$"""{"ops":[{{{Flow((read.Text, "0000000000000000"))}}}]}""", Path.Combine(dir, "fa-base.oml"));
        var changed = Assert.Single(stale);
        Assert.Equal("FLOW_BASE_CHANGED", changed!["code"]!.ToString());
        Assert.Equal(read.Text, changed["text"]!.ToString());
        // T3: a query inside a new loop is QUERY_IN_LOOP, decided on the candidate as for every op.
        var loop = read.Text.Replace(countSeen, countSeen + "  foreach GetOrders.List:\n"
            + "    GetMore = aggregate FROM FaOrder WHERE (FaOrder.Id = GetOrders.List.Current.FaOrder.Id) MAX 1\n    next\n");
        var query = Refused(dir, "fa-t3", $$$"""{"ops":[{{{Flow((loop, read.TextSha))}}}]}""", Path.Combine(dir, "fa-base.oml"));
        Assert.Contains(query, p => p!["code"]!.ToString() == QueryInLoopRule.Code && p["query"]!.ToString() == "GetMore");
    }

    // The job with the patches of a refusal applied (RFC 6902 replace/add/remove over the job's JSON, every distinct patch once,
    // in the order of the problems), as the facade's patch + basedOn does.
    private static string Patched(string job, JsonArray problems)
    {
        var document = JsonNode.Parse(job)!;
        foreach (var patch in problems.Select(p => p!["patch"]).OfType<JsonArray>().DistinctBy(p => p.ToJsonString()))
            foreach (var step in patch.OfType<JsonObject>())
            {
                var tokens = step["path"]!.ToString().Split('/').Skip(1).Select(t => t.Replace("~1", "/").Replace("~0", "~")).ToList();
                if (tokens.Count == 0) { document = step["value"]!.DeepClone(); continue; }
                var parent = document;
                foreach (var token in tokens.SkipLast(1)) parent = parent is JsonArray list ? list[int.Parse(token)]! : parent[token]!;
                var last = tokens[^1];
                if (step["op"]!.ToString() is "replace" or "add")
                {
                    if (parent is JsonArray array) {
                        if (last == "-") array.Add(step["value"]!.DeepClone());
                        else if (step["op"]!.ToString() == "add") array.Insert(int.Parse(last), step["value"]!.DeepClone());
                        else array[int.Parse(last)] = step["value"]!.DeepClone();
                    }
                    else parent[last] = step["value"]!.DeepClone();
                }
                else if (parent is JsonArray array) array.RemoveAt(int.Parse(last));
                else parent.AsObject().Remove(last);
            }
        return document.ToJsonString();
    }

    public static void TheRulesBringCheckedPatchesThatWriteTheJob(string dir, string fixture, string lane)
    {
        // B2 (conferência of 2026-10-12): T1 and T3 came with patch null. Each refusal now carries the patch of the job, and the
        // job with it applied is written and reads back as the List action (or the read before the loop).
        Run(dir, "fa-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{Action}}}]}""");
        var read = Read(dir, "fa-base", lane, "FaCount");
        var countSeen = Block(read.Text, "assign Seen = GetOrders.Count");
        var basePath = Path.Combine(dir, "fa-base.oml");
        // T1, on the action of the read: a new foreach that only filters a list into another.
        var local = Line(read.Text, "local Seen");
        var t1 = read.Text.Replace(local + "\n", local + "\n  local Pool: FaOrder List\n  local Picked: FaOrder List\n")
            .Replace(countSeen, countSeen + "  foreach Pool:\n    if Pool.Current.Qty > 1:\n      (System).ListAppend(Element=Pool.Current, List=Picked)\n      next\n    next\n");
        var job1 = $$$"""{"ops":[{{{Flow((t1, read.TextSha))}}}]}""";
        var filter = Assert.Single(Refused(dir, "fa-t1", job1, basePath), p => p!["code"]!.ToString() == "FLOW_FOREACH_LIST_ACTION")!;
        Assert.Equal("/ops/0/data/flow", filter["patch"]![0]!["path"]!.ToString());
        var written1 = Run(dir, "fa-t1-patched", Patched(job1, new JsonArray(filter.DeepClone())), basePath);
        Assert.True(written1["accepted"]!.GetValue<bool>(), written1["policyMessages"]?.ToJsonString() + written1["details"]);
        Assert.Contains("FilterPicked = (System).ListFilter(Condition=Pool.Current.Qty > 1, SourceList=Pool)", Read(dir, "fa-t1-patched", lane, "FaCount").Text);
        // T3: an aggregate the new loop runs per item, read once before it.
        var t3 = read.Text.Replace(countSeen, countSeen + "  foreach GetOrders.List:\n"
            + "    GetMore = aggregate FROM FaOrder WHERE (FaOrder.Id = GetOrders.List.Current.FaOrder.Id) MAX 1\n    assign Total = Total + GetMore.List.Current.FaOrder.Qty\n    next\n");
        var job3 = $$$"""{"ops":[{{{Flow((t3, read.TextSha))}}}]}""";
        var loop = Assert.Single(Refused(dir, "fa-t3", job3, basePath), p => p!["code"]!.ToString() == QueryInLoopRule.Code)!;
        Assert.Equal("GetMore", loop["query"]!.ToString());
        Assert.IsType<JsonArray>(loop["patch"]);
        var written3 = Run(dir, "fa-t3-patched", Patched(job3, new JsonArray(loop.DeepClone())), basePath);
        Assert.True(written3["accepted"]!.GetValue<bool>(), written3["policyMessages"]?.ToJsonString() + written3["details"]);
        var hoisted = Read(dir, "fa-t3-patched", lane, "FaCount").Text;
        Assert.Contains("GetMore = aggregate FROM FaOrder", hoisted);
        Assert.Contains("FilterGetMore = (System).ListFilter(", hoisted);
        // Not certain (the aggregate is read again after the loop): the candidate's QUERY_IN_LOOP, pointing at the text, no patch.
        var named = t3.Replace("    assign Total = Total + GetMore.List.Current.FaOrder.Qty\n    next\n",
            "    assign Total = Total + GetMore.List.Current.FaOrder.Qty\n    next\n  assign Total = Total + GetMore.Count\n");
        Assert.NotEqual(t3, named);
        var candidate = Assert.Single(Refused(dir, "fa-t3-named", $$$"""{"ops":[{{{Flow((named, read.TextSha))}}}]}""", basePath), p => p!["code"]!.ToString() == QueryInLoopRule.Code)!;
        Assert.Equal("/ops/0/data/flow/0", candidate["pointer"]!.ToString());
        Assert.Null(candidate["patch"]);
        // A new server action whose foreach only copies: refused by the job alone, and its patch writes the job too.
        var fresh = "/// Keeps the rows.\nserver action FaKeep\n  in Rows: FaOrder List\n  out Kept: FaOrder List\n  foreach Rows:\n    (System).ListAppend(Element=Rows.Current, List=Kept)\n    next\n  end\n";
        var job4 = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = fresh } }) }.ToJsonString();
        var copy = Assert.Single(Refused(dir, "fa-keep", job4, basePath), p => p!["code"]!.ToString() == "FLOW_FOREACH_LIST_ACTION")!;
        var written4 = Run(dir, "fa-keep-patched", Patched(job4, new JsonArray(copy.DeepClone())), basePath);
        Assert.True(written4["accepted"]!.GetValue<bool>(), written4["policyMessages"]?.ToJsonString() + written4["details"]);
        Assert.Contains("(System).ListAppendAll(List=Kept, SourceList=Rows)", Read(dir, "fa-keep-patched", lane, "FaKeep").Text);
    }

    // A job of one logic op whose data.flow is the texts given (new actions, without @key).
    private static string JobOfTexts(params string[] texts) => new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic",
        ["data"] = new JsonObject { ["flow"] = new JsonArray(texts.Select(t => (JsonNode)t).ToArray()) } }) }.ToJsonString();

    // A job that is applied but refused by the Verify (no exception): its problems.
    private static JsonArray VerifyRefused(string dir, string name, string job, string basePath)
    {
        var result = Run(dir, name, job, basePath);
        Assert.False(result["accepted"]!.GetValue<bool>(), "expected the Verify to refuse " + name);
        return result["problems"]!.AsArray();
    }

    public static void TheRowsOfAnAggregateAreT1AndTheRefusalBringsTheVerifyOfTheRest(string dir, string fixture, string lane)
    {
        // The review of 2026-10-12: a new foreach over GetX.List that appends GetX.List.Current.Entity was accepted on both lanes
        // (p4, e2, e3), and a refusal for an owner's rule hid the Verify of the rest of the op (e12: a second round for the
        // other action's unknown name). Now the loop is T1 with the List action of the lane as a checked patch, and the refusal
        // brings the Verify of the other action at once (afterPatch: found with the patch applied).
        Run(dir, "fa-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{Action}}}]}""");
        var basePath = Path.Combine(dir, "fa-base.oml");
        var rows = "/// The orders above a quantity.\nserver action FaBig\n  in Limit: Integer\n  out Big: FaOrder List\n  GetAll = aggregate FROM FaOrder\n  foreach GetAll.List:\n"
            + "    if GetAll.List.Current.FaOrder.Qty > Limit:\n      (System).ListAppend(Element=GetAll.List.Current.FaOrder, List=Big)\n      next\n    next\n  end\n";
        var wrong = "/// One more than a name nothing has.\nserver action FaWrong\n  out Y: Integer\n  assign Y = FaMissing + 1\n  end\n";
        var job = JobOfTexts(rows, wrong);
        var problems = Refused(dir, "fa-rows", job, basePath);
        var rule = Assert.Single(problems, p => p!["code"]!.ToString() == "FLOW_FOREACH_LIST_ACTION")!;
        Assert.Contains("T1: the loop only filters GetAll.List into Big", rule["message"]!.ToString());
        Assert.IsType<JsonArray>(rule["patch"]);
        var verify = Assert.Single(problems, p => p!["phase"]?.ToString() == "verify")!;
        Assert.Equal("/ops/0/data/flow/1", verify["pointer"]!.ToString());
        Assert.True(verify["afterPatch"]!.GetValue<bool>());
        Assert.Contains("FaMissing", verify["message"]!.ToString());
        // The patch applied, only the error of FaWrong is left; with it fixed, the job is written and FaBig reads as the List action.
        var patched = Patched(job, new JsonArray(rule.DeepClone()));
        var left = VerifyRefused(dir, "fa-rows-patched", patched, basePath);
        Assert.All(left, p => Assert.Equal("/ops/0/data/flow/1", p!["pointer"]!.ToString()));
        var written = Run(dir, "fa-rows-fixed", patched.Replace("FaMissing", "2"), basePath);
        Assert.True(written["accepted"]!.GetValue<bool>(), written["policyMessages"]?.ToJsonString() + written["details"]);
        var big = Read(dir, "fa-rows-fixed", lane, "FaBig").Text;
        Assert.Contains("FilterBig = (System).ListFilter(Condition=GetAll.List.Current.FaOrder.Qty > Limit, SourceList=GetAll.List)", big);
        // The conversion ODC makes of the row (mapTo {  }, which the patch writes) reads as the value: one form in both lanes.
        Assert.Contains("(System).ListAppendAll(List=Big, SourceList=FilterBig.FilteredList)", big);
    }

    public static void AValueOrAFieldMapIsAMappingWrittenAsThePlatformPrintsIt(string dir, string fixture, string lane)
    {
        // The review of 2026-10-12: ODC offered a mapping with no field for a list of values (e6, "Mapping cannot be empty") and a
        // mapping in the order of the assignments, which the platform read back as a second mapping (e7, FLOW_NOT_EXACT); O11
        // accepted both loops (p8, p9). Now ODC maps a value into a list of values ({ Value: ... }), and both lanes map the fields
        // in the order of the record (O11 writes the mapping in the argument's TypeConversion, the junction of the O11 record
        // mapping). Both lanes write a list of values as Value: <expression>. Every patch is applied and read back here.
        var structure = """{"op":"spec","data":{"structures":[{"name":"FaLine","attributes":[{"name":"Code","type":"Text"},{"name":"Qty","type":"Integer"}]}]}}""";
        Run(dir, "fa-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{structure}}}]}""");
        var basePath = Path.Combine(dir, "fa-base.oml");
        var titles = "/// The titles of the orders.\nserver action FaTitles\n  in Rows: FaOrder List\n  out Titles: Text List\n  foreach Rows:\n"
            + "    (System).ListAppend(Element=Rows.Current.Title, List=Titles)\n    next\n  end\n";
        var lines = "/// The orders as lines.\nserver action FaLines\n  in Rows: FaOrder List\n  out Lines: FaLine List\n  local Line: FaLine\n  foreach Rows:\n    assign\n"
            + "      Line.Qty = Rows.Current.Qty\n      Line.Code = Rows.Current.Title\n    (System).ListAppend(Element=Line, List=Lines)\n    next\n  end\n";
        foreach (var (name, text, action, expected) in new[] {
            ("fa-titles", titles, "FaTitles", "(System).ListAppendAll(List=Titles, SourceList=Rows mapTo { Value: Title })"),
            ("fa-lines", lines, "FaLines", "(System).ListAppendAll(List=Lines, SourceList=Rows mapTo { Code: Title, Qty: Qty })") }) {
            var job = JobOfTexts(text);
            var problem = Assert.Single(Refused(dir, name, job, basePath))!;
            Assert.Equal("FLOW_FOREACH_LIST_ACTION", problem["code"]!.ToString());
            Assert.Equal(expected, problem["text"]!.ToString());
            var written = Run(dir, name + "-patched", Patched(job, new JsonArray(problem.DeepClone())), basePath);
            Assert.True(written["accepted"]!.GetValue<bool>(), written["policyMessages"]?.ToJsonString() + written["details"]);
            var read = Read(dir, name + "-patched", lane, action).Text;
            Assert.Contains(expected, read);
            Assert.DoesNotContain("local Line", read);
        }
    }

    public static void AScriptMovedOutOfAScreenActionTakesANameNoActionOrScreenHas(string dir, string fixture, string lane)
    {
        // The review of 2026-10-12 (e1): the client action the patch of decision 6 creates took the name of a screen action of the
        // same screen; the Studio renamed it (NAME_COLLISION) and the call would have reached the screen action. The name is one no
        // action (a screen's included), screen, block or flow of the module has: Login is a screen and a screen action, so Login2.
        Run(dir, "fa-ui-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}}]}""");
        var basePath = Path.Combine(dir, "fa-ui-base.oml");
        var bytes = File.ReadAllBytes(basePath);
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var read = new ModelHost(Path.Combine(dir, "work")).BuildFlow(bytes, sha, lane).Actions.Single(a => a.Name.EndsWith("ForgotPassword", StringComparison.Ordinal) && a.FixedPoint);
        var lines = read.Text.Split('\n').ToList();
        var end = lines.FindIndex(l => l.StartsWith("  end", StringComparison.Ordinal));
        lines.Insert(end, "  Login = javascript\n    out Done: Boolean\n    | $parameters.Done = true;");
        var job = $$$"""{"ops":[{{{Flow((string.Join("\n", lines), read.TextSha))}}}]}""";
        var problem = Assert.Single(Refused(dir, "fa-ui-js", job, basePath))!;
        Assert.Equal("FLOW_JAVASCRIPT_NOT_ISOLATED", problem["code"]!.ToString());
        Assert.Contains("client action Login2", problem["patch"]!.ToJsonString());
        var written = Run(dir, "fa-ui-js-patched", Patched(job, new JsonArray(problem.DeepClone())), basePath);
        Assert.True(written["accepted"]!.GetValue<bool>(), written["policyMessages"]?.ToJsonString() + written["details"]);
        Assert.True(FlowDiff.Isolated(ModuleFlow.Read(Read(dir, "fa-ui-js-patched", lane, "Login2").Text)));
    }

    public static void ANewJavaScriptMovesIntoItsOwnClientActionAndAnExistingOneStaysEditable(string dir, string fixture, string lane)
    {
        // B1 (decision 6): a new JavaScript node in an action that does more than run it was accepted on both lanes.
        Run(dir, "fa-js-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(
            "/// Counts the characters of a code.\nclient action FaHighlight\n  in Code: Text\n  local Count: Integer\n  assign Count = Length(Code)\n  end\n",
            "/// Copies a text to the clipboard (the runtime has no action for it).\nclient action FaCopy\n  in Value: Text\n  Copy = javascript\n    in Value: Text = Value\n    | navigator.clipboard.writeText($parameters.Value);\n  end\n") } }.ToJsonString()}}}]}""");
        var basePath = Path.Combine(dir, "fa-js-base.oml");
        var read = Read(dir, "fa-js-base", lane, "FaHighlight");
        var assign = Line(read.Text, "assign Count = Length(Code)");
        var text = read.Text.Replace(assign + "\n", assign + "\n  Paint = javascript\n    in Value: Text = Code\n    out Done: Boolean\n    | $parameters.Done = !!document.getElementById($parameters.Value);\n"
            + "  assign Count = If(Paint.Done, 1, 0)\n");
        var job = $$$"""{"ops":[{{{Flow((text, read.TextSha))}}}]}""";
        var problem = Assert.Single(Refused(dir, "fa-js", job, basePath))!;
        Assert.Equal("FLOW_JAVASCRIPT_NOT_ISOLATED", problem["code"]!.ToString());
        Assert.Equal("/ops/0/data/flow", problem["patch"]![0]!["path"]!.ToString());
        var written = Run(dir, "fa-js-patched", Patched(job, new JsonArray(problem.DeepClone())), basePath);
        Assert.True(written["accepted"]!.GetValue<bool>(), written["policyMessages"]?.ToJsonString() + written["details"]);
        // The caller calls the new client action where the node was; the client action runs only the script.
        Assert.Contains("  Paint(Value=Code) @", Read(dir, "fa-js-patched", lane, "FaHighlight").Text);
        var isolated = Read(dir, "fa-js-patched", lane, "Paint");
        Assert.True(FlowDiff.Isolated(ModuleFlow.Read(isolated.Text)));
        // The isolated client action of the module keeps its JavaScript editable.
        var copy = Read(dir, "fa-js-base", lane, "FaCopy");
        var edited = copy.Text.Replace("navigator.clipboard.writeText($parameters.Value);", "navigator.clipboard.writeText(String($parameters.Value));");
        var kept = Run(dir, "fa-js-edit", $$$"""{"ops":[{{{Flow((edited, copy.TextSha))}}}]}""", basePath);
        Assert.True(kept["accepted"]!.GetValue<bool>(), kept["policyMessages"]?.ToJsonString() + kept["details"]);
    }

    public static void SeveralTextsAreCheckedTogetherAndANewCalleeComesFirst(string dir, string fixture, string lane)
    {
        Run(dir, "fa-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{Action}}}]}""");
        var read = Read(dir, "fa-base", lane, "FaCount");
        // Two texts with a problem each (an id the read never gave; a new action named after one the module has): one
        // refusal with both, each at its text. The base finds the collision and supplies the Studio's free-name patch.
        var countSeen = Line(read.Text, "assign Seen = GetOrders.Count");
        var foreign = read.Text.Replace(countSeen + "\n", countSeen + "\n  assign Total = 1 @n99\n");
        var job = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject {
            ["flow"] = new JsonArray(new JsonObject { ["text"] = foreign, ["basedOn"] = read.TextSha }, "server action FaCount\n  end\n") } }) }.ToJsonString();
        var problems = Refused(dir, "fa-two-bad", job, Path.Combine(dir, "fa-base.oml"));
        Assert.Contains(problems, p => p!["code"]!.ToString() == "FLOW_KEY_FOREIGN" && p["pointer"]!.ToString() == "/ops/0/data/flow/0");
        var taken = Assert.Single(problems, p => p!["code"]!.ToString() == "NAME_COLLISION")!;
        Assert.Equal("/ops/0/data/flow/1", taken["pointer"]!.ToString());
        Assert.Equal("base", taken["phase"]!.ToString());
        Assert.Equal("FaCount", taken["taken"]!["name"]!.ToString());
        var rename = Assert.Single(taken["patch"]!.AsArray());
        Assert.Equal("/ops/0/data/flow/1", rename!["path"]!.ToString());
        Assert.Equal("server action FaCount2\n  end\n", rename["value"]!.ToString());
        // A new action another text of the op calls is created first, whatever the order of the texts.
        var caller = "server action FaCaller\n  out Total: Integer\n  Helped = FaHelper(N=1)\n  assign Total = Helped.R\n  end\n";
        var helper = "server action FaHelper\n  in N: Integer\n  out R: Integer\n  assign R = N + 1\n  end\n";
        var two = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(caller, helper) } }) }.ToJsonString();
        var result = Run(dir, "fa-two", two, Path.Combine(dir, "fa-base.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var receipts = result["results"]![0]!["result"]!["flow"]!.AsArray();
        Assert.Equal(["FaCaller", "FaHelper"], receipts.Select(r => r!["action"]!.ToString()));
        string Bare(string text) => System.Text.RegularExpressions.Regex.Replace(text, @" @[A-Za-z0-9+/_=-]+$", "", System.Text.RegularExpressions.RegexOptions.Multiline);
        Assert.Equal(caller, Bare(Read(dir, "fa-two", lane, "FaCaller").Text));
        Assert.Equal(helper, Bare(Read(dir, "fa-two", lane, "FaHelper").Text));
    }

    public static void AServiceActionTextReadsBackWithoutTheStudioTemplate(string dir, string fixture, string lane)
    {
        Run(dir, "fa-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}}]}""");
        // A new service action is the text whole: the template comment the Studio gives a new service action is not kept.
        var text = "/// Counts the orders.\nservice action FaService public\n  out Total: Integer\n"
            + "  GetOrders = aggregate FROM FaOrder WHERE (FaOrder.Qty > 0) MAX 10\n  assign Total = GetOrders.Count\n  end\n";
        var job = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = text } }) }.ToJsonString();
        var result = Run(dir, "fa-service", job, Path.Combine(dir, "fa-base.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var after = Read(dir, "fa-service", lane, "FaService");
        Assert.Equal(text, System.Text.RegularExpressions.Regex.Replace(after.Text, @" @[A-Za-z0-9+/_=-]+$", "", System.Text.RegularExpressions.RegexOptions.Multiline));
    }

    // ---- screen, block and data actions born from their texts (header with the owner: action Screen.Name) --------------

    private const string Shop = "<screen name=\"FaShop\">\n<var name=\"Picked\" type=\"Integer\"/>\n"
        + "<Block name=\"LayoutTopMenu\"><slot name=\"Title\">Shop</slot><slot name=\"MainContent\"><p>Shop</p></slot></Block>\n</screen>";
    private const string Panel = "<block name=\"FaPanel\">\n<var name=\"Open\" type=\"Boolean\"/>\n<div><p>Panel</p></div>\n</block>";

    // The test screens have no role: ODC warns about it (a message O11 does not have).
    private static string NoRole(string lane) => lane == "odc"
        ? "\"expectedMessages\":[{\"id\":\"AnonymousAccess_NoPermissions\",\"all\":true,\"why\":\"a test screen without a role\"}]" : "\"expectedMessages\":[]";
    private static string Html(string html) => new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }.ToJsonString();
    private static string Texts(params string[] texts) =>
        new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(texts.Select(t => (JsonNode)t).ToArray()) } }.ToJsonString();
    private static string Bare(string text) => string.Join("\n", text.Split('\n').Select(line => line.TrimStart().StartsWith('|')
        ? line : System.Text.RegularExpressions.Regex.Replace(line, @" @[A-Za-z0-9+/_=-]+$", "")));

    // An action of a screen or block as the saved module reads (its entry is Flow/Owner/Action).
    private static FlowEntry ReadOwned(string dir, string name, string lane, string owner, string action)
    {
        var bytes = File.ReadAllBytes(Path.Combine(dir, name + ".oml"));
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var flow = new ModelHost(Path.Combine(dir, "work")).BuildFlow(bytes, sha, lane);
        var entry = flow.Actions.Single(a => a.Name.EndsWith("/" + owner + "/" + action, StringComparison.Ordinal));
        Assert.True(entry.FixedPoint, string.Join("\n", entry.Problems));
        return entry;
    }

    public static void ScreenBlockAndDataActionsAreBornFromTheirTexts(string dir, string fixture, string lane)
    {
        Run(dir, "fo-base", $$$"""{"base":"{{{fixture}}}",{{{NoRole(lane)}}},"ops":[{{{Spec}}},{{{Html(Shop)}}},{{{Html(Panel)}}}]}""");
        var basePath = Path.Combine(dir, "fo-base.oml");
        // One text per kind: a screen action, a block action, a data action with its outputs and its server flow (fetched on
        // demand), each written as a model writes a new action (no ids).
        var pick = "/// Counts a pick of the order.\naction FaShop.FaPick\n  in OrderId: FaOrder Identifier\n  assign Picked = Picked + 1  # Count the pick\n  end\n";
        var toggle = "action FaPanel.FaToggle\n  assign Open = not Open\n  end\n";
        var totals = "data action FaShop.FaGetTotals fetch=OnDemand\n  out Total: Integer\n  out Count: Long Integer\n"
            + "  GetOrders = aggregate FROM FaOrder WHERE (FaOrder.Qty > 0) MAX 50\n  assign\n    Total = 0\n    Count = GetOrders.Count\n  end\n";
        var result = Run(dir, "fo-new", $$$"""{"ops":[{{{Texts(pick, toggle, totals)}}}]}""", basePath);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var receipts = result["results"]![0]!["result"]!["flow"]!.AsArray();
        Assert.Equal(["FaShop", "FaPanel", "FaShop"], receipts.Select(r => r!["owner"]!.ToString()));
        Assert.All(receipts, r => Assert.True(r!["new"]!.GetValue<bool>()));
        Assert.Equal(["ScreenAction", "ScreenAction", "DataAction"], receipts.Select(r => r!["kind"]!.ToString()));
        // Each one reads back as the text written, with the keys its creates gave (the receipt's ids are the read's).
        foreach (var (owner, action, text, receipt) in new[] { ("FaShop", "FaPick", pick, receipts[0]!), ("FaPanel", "FaToggle", toggle, receipts[1]!), ("FaShop", "FaGetTotals", totals, receipts[2]!) }) {
            var after = ReadOwned(dir, "fo-new", lane, owner, action);
            Assert.Equal(text, Bare(after.Text));
            Assert.Equal(receipt["textSha"]!.ToString(), after.TextSha);
            Assert.Equal(receipt["key"]!.ToString(), after.Key);
            Assert.All(receipt["keys"]!.AsObject(), p => Assert.Contains(p.Value!.ToString(), after.Ids.Values));
        }
        // The text of a new action is edited like any other: the header as read (with its owner), a value changed.
        var read = ReadOwned(dir, "fo-new", lane, "FaShop", "FaPick");
        var edit = Run(dir, "fo-edit", $$$"""{"ops":[{{{Flow((read.Text.Replace("Picked + 1", "Picked + 2"), read.TextSha))}}}]}""", Path.Combine(dir, "fo-new.oml"));
        Assert.True(edit["accepted"]!.GetValue<bool>(), edit["policyMessages"]?.ToJsonString() + edit["details"]);
        Assert.Equal(pick.Replace("Picked + 1", "Picked + 2"), Bare(ReadOwned(dir, "fo-edit", lane, "FaShop", "FaPick").Text));
        // What needs the module, once with every problem: the action moved to another owner, an owner the module does not
        // have (with the nearest names), and a name the owner already has (its text is the patch).
        var problems = Refused(dir, "fo-rules", new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(
            new JsonObject { ["text"] = read.Text.Replace("action FaShop.FaPick", "action FaPanel.FaPick"), ["basedOn"] = read.TextSha },
            "action FaShopp.FaOther\n  end\n", "action FaShop.FaPick\n  end\n") } }) }.ToJsonString(), Path.Combine(dir, "fo-new.oml"));
        Assert.Equal(["FLOW_ACTION_OWNER", "FLOW_OWNER_UNKNOWN", "FLOW_ACTION_NAME_TAKEN"], problems.Select(p => p!["code"]!.ToString()));
        Assert.Contains("FaShop", problems[1]!["message"]!.ToString());
        Assert.Equal(read.Text, problems[2]!["text"]!.ToString());
        // What needs no module is refused before it: a new screen action with an output, a new one without its owner.
        var early = Refused(dir, "fo-early", $$$"""{"ops":[{{{Texts("action FaShop.FaOut\n  out R: Integer\n  end\n", "action FaNoOwner\n  end\n")}}}]}""", Path.Combine(dir, "fo-new.oml"));
        Assert.Equal(["FLOW_SCREEN_ACTION_OUTPUT", "FLOW_NEW_ACTION_OWNER"], early.Select(p => p!["code"]!.ToString()));
    }

    // The document form of the html op and the flow texts of the same job: the screen action the document names
    // (actions="FaAdd", an event binds it) is born before the content as a shell, and the text that names it fills it in
    // place (its key and its input stay); the data action the document names (data-actions) is created by its text after.
    public static void TheDocumentAndTheFlowTextsOfOneJobBindAndFill(string dir, string fixture, string lane)
    {
        var cart = "<screen name=\"FaCart\" actions=\"FaAdd\" data-actions=\"FaLoad\">\n<var name=\"Qty\" type=\"Integer\"/>\n"
            + "<Block name=\"LayoutTopMenu\"><slot name=\"Title\">Cart</slot><slot name=\"MainContent\">\n"
            + "<button class=\"btn btn-primary\" onclick=\"FaAdd(Amount = 2)\">Add</button>\n<span>{{ Qty }}</span>\n</slot></Block>\n</screen>";
        var add = "/// Adds to the cart.\naction FaCart.FaAdd\n  in Amount: Integer\n  assign Qty = Qty + Amount\n  end\n";
        var load = "data action FaCart.FaLoad\n  out Total: Integer\n  assign Total = 1\n  end\n";
        var result = Run(dir, "fd-job", $$$"""{"base":"{{{fixture}}}",{{{NoRole(lane)}}},"ops":[{{{Spec}}},{{{Html(cart)}}},{{{Texts(add, load)}}}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var document = result["results"]!.AsArray().Select(r => r!["result"]!).First(r => r["form"]?.ToString() == "document").AsObject();
        var shell = Assert.Single(document["sameJobScreenActions"]!.AsArray())!;
        Assert.Equal(("FaAdd", "flow"), (shell["name"]!.ToString(), shell["form"]!.ToString()));
        var receipts = result["results"]!.AsArray().Select(r => r!["result"]!).First(r => r["flow"] is JsonArray)["flow"]!.AsArray();
        Assert.True(receipts[0]!["filledShell"]!.GetValue<bool>());
        Assert.Null(receipts[1]!["filledShell"]);
        Assert.Equal(add, Bare(ReadOwned(dir, "fd-job", lane, "FaCart", "FaAdd").Text));
        Assert.Equal(load, Bare(ReadOwned(dir, "fd-job", lane, "FaCart", "FaLoad").Text));
        // The event of the document is bound to the action the text filled (the same key), with its argument.
        var page = new ModelHost(Path.Combine(dir, "work")).HtmlRead(File.ReadAllBytes(Path.Combine(dir, "fd-job.oml")), "MobileScreen:FaCart", withKeys: false)["documents"]![0]!["html"]!.ToString();
        Assert.Contains("onclick=\"FaAdd(", page);
        Assert.Equal(ReadOwned(dir, "fd-job", lane, "FaCart", "FaAdd").Key, receipts[0]!["key"]!.ToString());
    }

    // Traditional has server screen actions, but does not have Reactive data actions.
    public static void ATraditionalOwnerRejectsDataActions(string dir, string fixture, string lane)
    {
        var problems = Refused(dir, "ft-traditional", $$$"""{"base":"{{{fixture}}}","ops":[{{{Texts("data action ApplicationTitle.FaClick\n  end\n")}}}]}""");
        var problem = Assert.Single(problems)!;
        Assert.Equal("FLOW_OWNER_KIND", problem["code"]!.ToString());
        Assert.Contains("ApplicationTitle", problem["message"]!.ToString());
    }

    // The examples of the work packet's text section (platforms/odc/facade/text-examples.json, read by text-packet.mjs): what
    // the packet calls proven is proven here. The data statements, the user exception the action raises and the action text
    // go in ONE job on the blank fixture of the lane, as the packet's call orders them; the action reads back as the text
    // written and every element the data text names exists. The screen document with the text of the screen action it names
    // goes in one job on the Reactive fixture (ThePacketScreenExampleAppliesInOneJob).
    private static JsonObject PacketExamples()
    {
        var relative = Path.Combine("platforms", "odc", "facade", "text-examples.json");
        var dir = Path.GetDirectoryName(typeof(FlowApplyScenarios).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, relative))) dir = Path.GetDirectoryName(dir);
        Assert.True(dir != null, relative + " not found above the test assembly");
        return JsonNode.Parse(File.ReadAllText(Path.Combine(dir!, relative)))!["examples"]!.AsObject();
    }

    private static string ExampleOf(JsonObject examples, string form, string lane) => (examples[form]![lane] ?? examples[form]!["text"])!.ToString();

    private static string DataOp(string ddl) => new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = ddl } }.ToJsonString();

    public static void ThePacketExamplesApplyInOneJob(string dir, string fixture, string lane)
    {
        var examples = PacketExamples();
        var ddl = ExampleOf(examples, "ssam-ddl/1", lane);
        var flow = ExampleOf(examples, "ssam-flow/1", lane);
        var exceptions = examples["ssam-flow/1"]!["exceptions"]!.AsArray().Select(e => new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IUserException", ["name"] = e!.ToString() }.ToJsonString());
        var result = Run(dir, "px-data", $$$"""{"base":"{{{fixture}}}","ops":[{{{DataOp(ddl)}}},{{{string.Join(",", exceptions)}}},{{{Texts(flow)}}}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var action = System.Text.RegularExpressions.Regex.Match(flow, @"^server action (\w+)", System.Text.RegularExpressions.RegexOptions.Multiline).Groups[1].Value;
        Assert.Equal(flow, Bare(Read(dir, "px-data", lane, action).Text));
        var bytes = File.ReadAllBytes(Path.Combine(dir, "px-data.oml"));
        var blocks = new ModelHost(Path.Combine(dir, "work")).BuildDdl(bytes, "", lane).Blocks.Select(b => b.Name).ToHashSet(StringComparer.Ordinal);
        foreach (System.Text.RegularExpressions.Match named in System.Text.RegularExpressions.Regex.Matches(ddl, @"^(?:create (?:static )?entity|type|site property|setting) (\w+)", System.Text.RegularExpressions.RegexOptions.Multiline))
            Assert.Contains(named.Groups[1].Value, blocks);
    }

    public static void ThePacketScreenExampleAppliesInOneJob(string dir, string fixture, string lane)
    {
        var examples = PacketExamples();
        var screen = examples["ssam-html/1"]!;
        var actions = screen["actions"]!.AsArray().Select(a => a!.ToString()).ToArray();
        var result = Run(dir, "px-ui", $$$"""{"base":"{{{fixture}}}",{{{NoRole(lane)}}},"ops":[{{{DataOp(ExampleOf(examples, "ssam-ddl/1", lane))}}},{{{Html(screen["text"]!.ToString())}}},{{{Texts(actions)}}}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var owner = System.Text.RegularExpressions.Regex.Match(screen["text"]!.ToString(), "<screen name=\"(\\w+)\"").Groups[1].Value;
        foreach (var text in actions)
        {
            var name = System.Text.RegularExpressions.Regex.Match(text, @"^action \w+\.(\w+)", System.Text.RegularExpressions.RegexOptions.Multiline).Groups[1].Value;
            Assert.Equal(text, Bare(ReadOwned(dir, "px-ui", lane, owner, name).Text));
        }
    }

    public static void ATextWithoutKeyCreatesTheAction(string dir, string fixture, string lane)
    {
        Run(dir, "fa-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}}]}""");
        var text = "/// Counts the orders with a quantity.\nserver action FaNew\n  in Limit: Integer\n  out Total: Integer\n"
            + "  GetOrders = aggregate FROM FaOrder WHERE (FaOrder.Qty > 0) MAX Limit\n  assign Total = GetOrders.Count  # Count them\n  end\n";
        var result = Run(dir, "fa-new", $$$"""{"ops":[{{{new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = text } }.ToJsonString()}}}]}""", Path.Combine(dir, "fa-base.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var receipt = result["results"]![0]!["result"]!["flow"]![0]!;
        Assert.True(receipt["new"]!.GetValue<bool>());
        var after = Read(dir, "fa-new", lane, "FaNew");
        // The text it reads as is the one written, with the ids of a read.
        Assert.Equal(text, System.Text.RegularExpressions.Regex.Replace(after.Text, @" @[A-Za-z0-9+/_=-]+$", "", System.Text.RegularExpressions.RegexOptions.Multiline));
    }

    // The three-way merge (FlowMerge): an edit written on a read the store kept, delivered after the action changed (another
    // job, as the Studio would change it), is merged with what changed: both edits stay, a change of the same element on
    // both sides keeps the delivery's and is listed in merged.conflicts. A read the store does not keep is refused with the
    // current text and a ready edit.
    public static void AnEditOfAnOlderReadIsMergedWithWhatChangedSince(string dir, string fixture, string lane)
    {
        var store = ModuleIndexStore.Default();
        if (store == null) return;   // no store here (no workspace, no SSAM_MODULE_INDEX_ROOT): nothing keeps the read
        Run(dir, "fm-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{Action}}}]}""");
        var read = Read(dir, "fm-base", lane, "FaCount");
        var baseSha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(Path.Combine(dir, "fm-base.oml")))).ToLowerInvariant();
        store.SaveFlowReading(FlowReading.Of(read, lane, baseSha));
        // The Studio's change: a step after CountSeen, and another reset value.
        var countSeen = Block(read.Text, "assign Seen = GetOrders.Count");
        var studio = read.Text.Replace(countSeen, countSeen + "  assign Total = Total + 10\n").Replace("assign Total = 0", "assign Total = 5");
        var changed = Run(dir, "fm-studio", $$$"""{"ops":[{{{Flow((studio, read.TextSha))}}}]}""", Path.Combine(dir, "fm-base.oml"));
        Assert.True(changed["accepted"]!.GetValue<bool>(), changed["policyMessages"]?.ToJsonString() + changed["details"]);
        // The model's edit, on the read it was given: the loop's expression (only it changed it) and the reset (both did).
        var edited = read.Text.Replace("Total + GetOrders.List.Current.FaOrder.Qty", "Total + GetOrders.List.Current.FaOrder.Qty * 2").Replace("assign Total = 0", "assign Total = 9");
        var result = Run(dir, "fm-merge", $$$"""{"ops":[{{{Flow((edited, read.TextSha))}}}]}""", Path.Combine(dir, "fm-studio.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var receipt = result["results"]![0]!["result"]!["flow"]![0]!;
        Assert.Equal("three-way", receipt["merged"]!["merge"]!.ToString());
        var conflict = Assert.Single(receipt["merged"]!["conflicts"]!.AsArray())!;
        Assert.Contains("Total = 5", conflict["studio"]!.ToString());
        Assert.Contains("Total = 9", conflict["delivered"]!.ToString());
        var after = Read(dir, "fm-merge", lane, "FaCount");
        Assert.Contains("Total + GetOrders.List.Current.FaOrder.Qty * 2", after.Text);
        Assert.Contains("assign Total = Total + 10", after.Text);
        Assert.Contains("assign Total = 9", after.Text);
        Assert.DoesNotContain("assign Total = 5", after.Text);
        // Every key of the Studio's action is still there (nothing it did was lost, nothing was re-created).
        var studioRead = Read(dir, "fm-studio", lane, "FaCount");
        Assert.All(studioRead.Ids.Values, key => Assert.Contains(key, after.Ids.Values));
        // A read the store does not keep: refused with the current text, and the edit ready to send on it.
        var stale = Refused(dir, "fm-stale", $$$"""{"ops":[{{{Flow((edited, "1111111111111111"))}}}]}""", Path.Combine(dir, "fm-studio.oml"));
        var problem = Assert.Single(stale)!;
        Assert.Equal("FLOW_BASE_CHANGED", problem["code"]!.ToString());
        Assert.Equal(studioRead.Text, problem["text"]!.ToString());
        Assert.Equal(studioRead.TextSha, problem["edit"]!["basedOn"]!.ToString());
        Assert.Contains("not kept here", problem["message"]!.ToString());
    }

    // The junction of the merge and the owner's rules (2026-10-12): a text written on an older read is merged with what the
    // Studio changed since, and the rules judge the merged text as they judge a text. The certain fix is written into the merged
    // text: the patch sends it with the basedOn of the action now (it is not merged again), and the job it writes is accepted
    // with what the Studio did kept.
    public static void AnOlderReadThatBreaksARuleIsRefusedWithThePatchOfTheMergedText(string dir, string fixture, string lane)
    {
        var store = ModuleIndexStore.Default();
        if (store == null) return;
        Run(dir, "fq-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{Action}}}]}""");
        var read = Read(dir, "fq-base", lane, "FaCount");
        var baseSha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(Path.Combine(dir, "fq-base.oml")))).ToLowerInvariant();
        store.SaveFlowReading(FlowReading.Of(read, lane, baseSha));
        var countSeen = Block(read.Text, "assign Seen = GetOrders.Count");
        var studio = read.Text.Replace(countSeen, countSeen + "  assign Total = Total + 10\n");
        var changed = Run(dir, "fq-studio", $$$"""{"ops":[{{{Flow((studio, read.TextSha))}}}]}""", Path.Combine(dir, "fq-base.oml"));
        Assert.True(changed["accepted"]!.GetValue<bool>(), changed["policyMessages"]?.ToJsonString() + changed["details"]);
        var now = Read(dir, "fq-studio", lane, "FaCount");
        // The model's edit on the read it was given: a new foreach that only filters a list into another (T1).
        var local = Line(read.Text, "local Seen");
        var edited = read.Text.Replace(local + "\n", local + "\n  local Pool: FaOrder List\n  local Picked: FaOrder List\n")
            .Replace(countSeen, countSeen + "  foreach Pool:\n    if Pool.Current.Qty > 1:\n      (System).ListAppend(Element=Pool.Current, List=Picked)\n      next\n    next\n");
        var job = $$$"""{"ops":[{{{Flow((edited, read.TextSha))}}}]}""";
        var problem = Assert.Single(Refused(dir, "fq-t1", job, Path.Combine(dir, "fq-studio.oml")), p => p!["code"]!.ToString() == "FLOW_FOREACH_LIST_ACTION")!;
        Assert.Contains("assign Total = Total + 10", problem["merged"]!.ToString());
        var step = Assert.Single(problem["patch"]!.AsArray())!;
        Assert.Equal("/ops/0/data/flow", step["path"]!.ToString());
        var item = step["value"]![0]!;
        Assert.Equal(now.TextSha, item["basedOn"]!.ToString());
        Assert.Contains("FilterPicked = (System).ListFilter(Condition=Pool.Current.Qty > 1, SourceList=Pool)", item["text"]!.ToString());
        var written = Run(dir, "fq-t1-patched", Patched(job, new JsonArray(problem.DeepClone())), Path.Combine(dir, "fq-studio.oml"));
        Assert.True(written["accepted"]!.GetValue<bool>(), written["policyMessages"]?.ToJsonString() + written["details"]);
        Assert.Null(written["results"]![0]!["result"]!["flow"]![0]!["merged"]);
        var after = Read(dir, "fq-t1-patched", lane, "FaCount");
        Assert.Contains("FilterPicked = (System).ListFilter(Condition=Pool.Current.Qty > 1, SourceList=Pool)", after.Text);
        Assert.Contains("assign Total = Total + 10", after.Text);
        Assert.All(now.Ids.Values, key => Assert.Contains(key, after.Ids.Values));
    }

    // The data text's three-way merge (DdlMerge): statements written on a read the store kept, delivered after the module
    // changed (an attribute added by another job, as the Studio would), keep that attribute although the statement does not
    // have it. Without the read, the statement is refused instead of deleting it (DDL_BASE_UNKNOWN).
    public static void DataStatementsOfAnOlderReadAreMergedWithWhatChangedSince(string dir, string fixture, string lane)
    {
        var store = ModuleIndexStore.Default();
        if (store == null) return;
        Run(dir, "dm-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}}]}""");
        var bytes = File.ReadAllBytes(Path.Combine(dir, "dm-base.oml"));
        var baseSha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        var ddl = new ModelHost(Path.Combine(dir, "work")).BuildDdl(bytes, baseSha, lane);
        store.SaveDdl(ddl);
        var block = ddl.Blocks.Single(b => b.Name == "FaOrder").Text;
        Assert.Contains("Title Text(50)", block);
        // The Studio's change: an attribute added at the end.
        var lines = block.Split('\n').ToList();
        var last = lines.FindLastIndex(l => l.StartsWith("  ", StringComparison.Ordinal) && !l.StartsWith("  ///", StringComparison.Ordinal) && l.Contains(" -- @", StringComparison.Ordinal) && !l.Contains(" index ", StringComparison.Ordinal));
        var cut = lines[last].LastIndexOf(" -- @", StringComparison.Ordinal);
        lines[last] = lines[last][..cut] + "," + lines[last][cut..];
        lines.Insert(last + 1, "  Note Text(30)");
        var changed = Run(dir, "dm-studio", $$$"""{"ops":[{{{DataSpec(string.Join('\n', lines), baseSha)}}}]}""", Path.Combine(dir, "dm-base.oml"));
        Assert.True(changed["accepted"]!.GetValue<bool>(), changed["policyMessages"]?.ToJsonString() + changed["details"]);
        // The model's statement, written on the read: Title longer; it does not have Note.
        var edited = block.Replace("Title Text(50)", "Title Text(80)");
        var result = Run(dir, "dm-merge", $$$"""{"ops":[{{{DataSpec(edited, baseSha)}}}]}""", Path.Combine(dir, "dm-studio.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var merged = result["results"]![0]!["result"]!["merged"]!;
        Assert.Equal("three-way", merged["merge"]!.ToString());
        Assert.Contains(merged["kept"]!.AsArray(), k => k!.ToString() == "FaOrder.Note");
        Assert.Null(merged["conflicts"]);
        var after = new ModelHost(Path.Combine(dir, "work")).BuildDdl(File.ReadAllBytes(Path.Combine(dir, "dm-merge.oml")), "", lane);
        var now = after.Blocks.Single(b => b.Name == "FaOrder").Text;
        Assert.Contains("Title Text(80)", now);
        Assert.Contains("Note Text(30)", now);
        // Without the read (a basedOn the store does not keep): refused, Note named, nothing deleted.
        var stale = Refused(dir, "dm-stale", $$$"""{"ops":[{{{DataSpec(edited, new string('f', 64))}}}]}""", Path.Combine(dir, "dm-studio.oml"));
        Assert.Contains(stale, p => p!["code"]!.ToString() == "DDL_BASE_UNKNOWN" && p["message"]!.ToString().Contains("Note"));
    }

    // ---- review of the junction feat/texto-ssam-2 --------------------------------------------------------------------------

    // A text of an action (a header with @key) names the elements of a read by their ids: without basedOn those ids would be
    // read against the action now, and what the Studio changed since would be undone. Refused with the current text and the
    // edit ready (FLOW_BASE_REQUIRED). A list of one text takes the shared data.basedOn (a read the store kept: merged).
    public static void ATextOfAnActionNeedsTheReadItWasWrittenOn(string dir, string fixture, string lane)
    {
        Run(dir, "fb-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{Action}}}]}""");
        var basePath = Path.Combine(dir, "fb-base.oml");
        var read = Read(dir, "fb-base", lane, "FaCount");
        var edited = read.Text.Replace("assign Total = 0", "assign Total = 3");
        Assert.NotEqual(read.Text, edited);
        var bare = Refused(dir, "fb-bare", $$$"""{"ops":[{{{new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = edited } }.ToJsonString()}}}]}""", basePath);
        var problem = Assert.Single(bare)!;
        Assert.Equal("FLOW_BASE_REQUIRED", problem["code"]!.ToString());
        Assert.Equal(read.Text, problem["text"]!.ToString());
        Assert.Equal(read.TextSha, problem["edit"]!["basedOn"]!.ToString());
        var store = ModuleIndexStore.Default();
        if (store == null) return;
        var baseSha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(basePath))).ToLowerInvariant();
        store.SaveFlowReading(FlowReading.Of(read, lane, baseSha));
        var studio = read.Text.Replace("assign Seen = GetOrders.Count", "assign Seen = GetOrders.Count + 1");
        var changed = Run(dir, "fb-studio", $$$"""{"ops":[{{{Flow((studio, read.TextSha))}}}]}""", basePath);
        Assert.True(changed["accepted"]!.GetValue<bool>(), changed["policyMessages"]?.ToJsonString() + changed["details"]);
        var shared = Run(dir, "fb-shared", new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject {
            ["flow"] = new JsonArray(edited), ["basedOn"] = read.TextSha } }) }.ToJsonString(), Path.Combine(dir, "fb-studio.oml"));
        Assert.True(shared["accepted"]!.GetValue<bool>(), shared["policyMessages"]?.ToJsonString() + shared["details"]);
        Assert.Equal("three-way", shared["results"]![0]!["result"]!["flow"]![0]!["merged"]?["merge"]?.ToString());
        var after = Read(dir, "fb-shared", lane, "FaCount").Text;
        Assert.Contains("assign Total = 3", after);
        Assert.Contains("assign Seen = GetOrders.Count + 1", after);
    }

    // The texts of one op are written in an order where what a text names exists: a handler an event of another text goes
    // to, and a data action a refresh of another text names, come first, whatever the order of the texts.
    public static void TheActionsAnEventOrARefreshNamesAreWrittenFirst(string dir, string fixture, string lane)
    {
        Run(dir, "fe-base", $$$"""{"base":"{{{fixture}}}",{{{NoRole(lane)}}},"ops":[{{{Spec}}},{{{Html(Shop)}}}]}""");
        var load = "data action FaShop.FaLoad\n  on AfterFetch -> FaOnLoaded()\n  out Total: Integer\n  assign Total = 1\n  end\n";
        var handler = "action FaShop.FaOnLoaded\n  assign Picked = Picked + 1\n  end\n";
        var reload = "action FaShop.FaReload\n  refresh FaLoad5\n  end\n";
        var load5 = "data action FaShop.FaLoad5\n  out Total: Integer\n  assign Total = 5\n  end\n";
        var result = Run(dir, "fe-new", $$$"""{"ops":[{{{Texts(load, handler, reload, load5)}}}]}""", Path.Combine(dir, "fe-base.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        foreach (var (action, text) in new[] { ("FaLoad", load), ("FaOnLoaded", handler), ("FaReload", reload), ("FaLoad5", load5) })
            Assert.Equal(text, Bare(ReadOwned(dir, "fe-new", lane, "FaShop", action).Text));
    }

    // A lifecycle event goes to an action of its owner: an entity attribute named like the handler (FaCollision.Loaded) and
    // a same-named handler of another screen are no Destination.
    public static void LifecycleDestinationIgnoresSameNamedEntityFields(string dir, string fixture, string lane)
    {
        var ddl = new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = "create entity FaCollision (Id Long Integer identifier auto required, Loaded Text(40));" } };
        var handler = "action FaShop.Loaded\n  assign Picked = Picked + 1\n  end\n";
        var other = handler.Replace("FaShop", "FaOther");
        var first = Run(dir, "lc-base", $$$"""{"base":"{{{fixture}}}",{{{NoRole(lane)}}},"ops":[{{{Spec}}},{{{ddl.ToJsonString()}}},{{{Html(Shop)}}},{{{Html(Shop.Replace("FaShop", "FaOther"))}}},{{{Texts(other)}}}]}""");
        Assert.True(first["accepted"]!.GetValue<bool>(), first.ToJsonString());
        var load = "data action FaShop.Initial\n  on AfterFetch -> Loaded()\n  out Total: Integer\n  assign Total = 1\n  end\n";
        var result = Run(dir, "lc-new", $$$"""{"ops":[{{{Texts(load, handler)}}}]}""", Path.Combine(dir, "lc-base.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Equal(load, Bare(ReadOwned(dir, "lc-new", lane, "FaShop", "Initial").Text));
        Assert.Equal(handler, Bare(ReadOwned(dir, "lc-new", lane, "FaShop", "Loaded").Text));
        Assert.Equal(other, Bare(ReadOwned(dir, "lc-new", lane, "FaOther", "Loaded").Text));
    }

    // Two old owners make a stale name index visibly ambiguous: the new owner refreshes its own LoadRows, whatever the order
    // of the texts.
    public static void NewlyCreatedDataSourcesReplaceStaleOwnerLookup(string dir, string fixture, string lane)
    {
        var oldA = Shop.Replace("FaShop", "FaOldA");
        var oldB = Shop.Replace("FaShop", "FaOldB");
        var loadA = "data action FaOldA.LoadRows\n  out Total: Integer\n  assign Total = 1\n  end\n";
        var loadB = loadA.Replace("FaOldA", "FaOldB");
        Run(dir, "cache-base", $$$"""{"base":"{{{fixture}}}",{{{NoRole(lane)}}},"ops":[{{{Spec}}},{{{Html(oldA)}}},{{{Html(oldB)}}},{{{Texts(loadA, loadB)}}}]}""");
        var screen = Shop.Replace("FaShop", "FaNew");
        var warm = "action FaOldA.Warm\n  refresh LoadRows\n  end\n";
        var reload = "action FaNew.ReloadRows\n  refresh LoadRows\n  end\n";
        var load = loadA.Replace("FaOldA", "FaNew");
        var result = Run(dir, "cache-new", $$$"""{ {{{NoRole(lane)}}},"ops":[{{{Html(screen)}}},{{{Texts(warm, reload, load)}}}]}""", Path.Combine(dir, "cache-base.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Equal(reload, Bare(ReadOwned(dir, "cache-new", lane, "FaNew", "ReloadRows").Text));
    }

    // A parameter or local renamed onto the name of an attribute of the source of a mapping that names it would be read as
    // that attribute inside the mapping (the source's attributes come first there): refused, with a free name.
    public static void ARenameAMappingWouldReadAsAnAttributeIsRefused(string dir, string fixture, string lane)
    {
        const string Structures = """
            {"op":"spec","data":{"structures":[
              {"name":"SrcRow","attributes":[{"name":"Code","type":"Text","length":50},{"name":"Amount","type":"Decimal"},{"name":"Note","type":"Text","length":50}]},
              {"name":"DstRow","attributes":[{"name":"Key","type":"Text","length":50},{"name":"Total","type":"Decimal"},{"name":"Label","type":"Text","length":50}]}]}}
            """;
        var scope = "server action FaScope\n  in SrcOne: SrcRow\n  in Factor: Decimal\n  out One: DstRow\n  local Suffix: Text\n"
            + "  assign One = SrcOne mapTo { Total: Amount * Factor, Label: Note + Suffix }\n  end\n";
        var created = Run(dir, "fr-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Structures}}},{{{Texts(scope)}}}]}""");
        Assert.True(created["accepted"]!.GetValue<bool>(), created["policyMessages"]?.ToJsonString() + created["details"]);
        var read = Read(dir, "fr-base", lane, "FaScope");
        Assert.Contains("Label: Note + Suffix", read.Text);
        var captured = read.Text.Replace("local Suffix:", "local Note:").Replace("Note + Suffix", "Note + Note");
        var problems = Refused(dir, "fr-captured", $$$"""{"ops":[{{{Flow((captured, read.TextSha))}}}]}""", Path.Combine(dir, "fr-base.oml"));
        var problem = Assert.Single(problems)!;
        Assert.Equal("FLOW_RENAME_CAPTURED", problem["code"]!.ToString());
        Assert.Contains("Note", problem["message"]!.ToString());
        // Another name is a rename as any other.
        var free = read.Text.Replace("local Suffix:", "local Tail:").Replace("Note + Suffix", "Note + Tail");
        var renamed = Run(dir, "fr-free", $$$"""{"ops":[{{{Flow((free, read.TextSha))}}}]}""", Path.Combine(dir, "fr-base.oml"));
        Assert.True(renamed["accepted"]!.GetValue<bool>(), renamed["policyMessages"]?.ToJsonString() + renamed["details"]);
        Assert.Contains("Label: Note + Tail", Read(dir, "fr-free", lane, "FaScope").Text);
    }

    // A list of records assigned to a list of another record type (an aggregate's list to a list of its entity) is the value
    // as written in both lanes: ODC keeps an empty mapping the platform makes (mapTo {  }), the read leaves it out, and an
    // empty mapping a text writes is that value.
    public static void AListAssignedAcrossTypesReadsAsTheValueWritten(string dir, string fixture, string lane)
    {
        Run(dir, "fl-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}}]}""");
        var text = "server action FaAggList\n  out Orders: FaOrder List\n  GetOrders = aggregate FROM FaOrder WHERE (FaOrder.Qty > 0) MAX 5\n  assign Orders = GetOrders.List\n  end\n";
        var result = Run(dir, "fl-new", $$$"""{"ops":[{{{Texts(text)}}}]}""", Path.Combine(dir, "fl-base.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        Assert.Equal(text, Bare(Read(dir, "fl-new", lane, "FaAggList").Text));
        var empty = text.Replace("FaAggList", "FaAggEmpty").Replace("assign Orders = GetOrders.List", "assign Orders = GetOrders.List mapTo { }");
        var written = Run(dir, "fl-empty", $$$"""{"ops":[{{{Texts(empty)}}}]}""", Path.Combine(dir, "fl-base.oml"));
        Assert.True(written["accepted"]!.GetValue<bool>(), written["policyMessages"]?.ToJsonString() + written["details"]);
        Assert.Equal(text.Replace("FaAggList", "FaAggEmpty"), Bare(Read(dir, "fl-empty", lane, "FaAggEmpty").Text));
    }

    // VisitaCerta 2026-10-12, both lanes: a mapping over a list whose values read the list's Current (`L.Current.X`, as the
    // model wrote 18 actions) maps each item: the values are the item's (FLOW_MAPPING_RELATIVE, listed), the job is accepted
    // and the action reads back in that form.
    public static void AListMappingThatReadsItsListsCurrentMapsTheItem(string dir, string fixture, string lane)
    {
        var structure = """{"op":"spec","data":{"structures":[{"name":"FaRow","attributes":[{"name":"Code","type":"Text"},{"name":"Qty","type":"Integer"}]}]}}""";
        Run(dir, "fr-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{structure}}}]}""");
        var text = "server action FaRowsOf\n  out Rows: FaRow List\n  GetOrders = aggregate FROM FaOrder WHERE (FaOrder.Qty > 0) MAX 5\n"
            + "  assign Rows = GetOrders.List mapTo { Code: GetOrders.List.Current.FaOrder.Title, Qty: GetOrders.List.Current.FaOrder.Qty }\n  end\n";
        var result = Run(dir, "fr-new", $$$"""{"ops":[{{{Texts(text)}}}]}""", Path.Combine(dir, "fr-base.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>() && result["isValid"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        Assert.Contains((result["normalizations"] as JsonArray ?? []).OfType<JsonObject>(), n => n["rule"]?.ToString() == FlowTextEdit.MappingRelative);
        Assert.Equal(text.Replace("GetOrders.List.Current.", ""), Bare(Read(dir, "fr-new", lane, "FaRowsOf").Text));
    }

    // Review of VisitaCerta 2026-10-12, both lanes (the model's types decide, never one lane's mapping API): a mapping that copies
    // every attribute of the target from one record of the item reads in the platform's form and is listed (FLOW_MAPPING_PLATFORM:
    // the plain value for a row of that one record or the record of a row, `Value: Record` for a row of several entities or a
    // structure that holds the record); a plain value the platform maps by itself is listed when the mapping takes the record
    // whole (FLOW_MAPPING_STUDIO); a mapping that reads the list's Current inside an expression, on two lines, is relative on
    // both. Refused, never taken silently: the platform's own mapping that leaves an attribute of the target empty, and a mapping
    // the platform does not keep (FLOW_MAPPING_TYPES, every text of the op in one refusal); an edit of a read that writes the
    // list's Current (FLOW_MAPPING_CURSOR, with the patch).
    public static void AMappingThePlatformKeepsInItsOwnFormIsListedAndOneThatSaysSomethingElseIsRefused(string dir, string fixture, string lane)
    {
        var spec = """
            {"op":"spec","data":{"entities":[
              {"name":"VxPlace","attributes":[{"name":"Name","type":"Text","length":50},{"name":"City","type":"Text","length":50}]},
              {"name":"VxForecast","attributes":[{"name":"Title","type":"Text","length":50}]},
              {"name":"VxHour","attributes":[{"name":"VxForecastId","type":"VxForecast Identifier"},{"name":"Temp","type":"Decimal"}]}],
             "structures":[
              {"name":"VxRow","attributes":[{"name":"Name","type":"Text"},{"name":"Code","type":"Text"}]},
              {"name":"VxWrap","attributes":[{"name":"Place","type":"VxPlace"},{"name":"Note","type":"Text"}]}]}}
            """;
        Run(dir, "vx-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{spec}}}]}""");
        var basePath = Path.Combine(dir, "vx-base.oml");
        const string Q = "  Q = aggregate FROM VxPlace WHERE (VxPlace.Name <> \"\") MAX 50\n";
        const string Join = "  Cache = aggregate FROM VxForecast, VxHour JOIN Inner VxForecast~VxHour ON VxHour.VxForecastId = VxForecast.Id WHERE (VxForecast.Title <> \"\") MAX 50\n";
        string Action(string name, string declarations, string body) => "server action " + name + "\n" + declarations + body + "  end\n";
        var places = Action("VxPlaces", "  out Places: VxPlace List\n", Q
            + "  assign Places = Q.List mapTo { Id: Q.List.Current.VxPlace.Id, Name: Q.List.Current.VxPlace.Name, City: Q.List.Current.VxPlace.City }\n");
        var hours = Action("VxHours", "  out Hours: VxHour List\n", Join
            + "  assign Hours = Cache.List mapTo { Id: Cache.List.Current.VxHour.Id, VxForecastId: Cache.List.Current.VxHour.VxForecastId, Temp: Cache.List.Current.VxHour.Temp }\n");
        var nested = Action("VxNested", "  in Wraps: VxWrap List\n  out Places: VxPlace List\n",
            "  assign Places = Wraps mapTo { Id: Wraps.Current.Place.Id, Name: Wraps.Current.Place.Name, City: Wraps.Current.Place.City }\n");
        var one = Action("VxOne", "  out One: VxPlace\n", Q + "  assign One = Q.List.Current mapTo { Id: VxPlace.Id, Name: VxPlace.Name, City: VxPlace.City }\n");
        var studio = Action("VxStudio", "  out Hours: VxHour List\n", Join + "  assign Hours = Cache.List\n");
        const string Cursor = "Q.List mapTo { Name: Q.List.Current.VxPlace.Name, Code: Trim(Q.List.Current.VxPlace.City) }";
        var cursor = Action("VxCursor", "  out Rows: VxRow List\n  out Rows2: VxRow List\n", Q + "  assign Rows = " + Cursor + "\n  assign Rows2 = " + Cursor + "\n");
        // An argument: the parameter of a List action takes the type of its List.
        var append = Action("VxAppend", "  out Places: VxPlace List\n", Q
            + "  (System).ListAppendAll(List=Places, SourceList=Q.List mapTo { Id: Q.List.Current.VxPlace.Id, Name: Q.List.Current.VxPlace.Name, City: Q.List.Current.VxPlace.City })\n");
        var result = Run(dir, "vx-forms", $$$"""{"ops":[{{{Texts(places, hours, nested, one, studio, cursor, append)}}}]}""", basePath);
        Assert.True(result["accepted"]!.GetValue<bool>() && result["isValid"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var rules = (result["normalizations"] as JsonArray ?? []).OfType<JsonObject>().Select(n => n["rule"]!.ToString()).ToList();
        Assert.Equal(5, rules.Count(r => r == "FLOW_MAPPING_PLATFORM"));
        Assert.Contains("SourceList=Q.List)\n", Bare(Read(dir, "vx-forms", lane, "VxAppend").Text));
        Assert.Equal(1, rules.Count(r => r == "FLOW_MAPPING_STUDIO"));
        Assert.Contains("  assign Places = Q.List\n", Bare(Read(dir, "vx-forms", lane, "VxPlaces").Text));
        Assert.Contains("  assign Hours = Cache.List mapTo { Value: VxHour }\n", Bare(Read(dir, "vx-forms", lane, "VxHours").Text));
        Assert.Contains("  assign Places = Wraps mapTo { Value: Place }\n", Bare(Read(dir, "vx-forms", lane, "VxNested").Text));
        Assert.Contains("  assign One = Q.List.Current\n", Bare(Read(dir, "vx-forms", lane, "VxOne").Text));
        Assert.Contains("  assign Hours = Cache.List mapTo { Value: VxHour }\n", Bare(Read(dir, "vx-forms", lane, "VxStudio").Text));
        var rows = Bare(Read(dir, "vx-forms", lane, "VxCursor").Text);
        Assert.Contains("  assign Rows = Q.List mapTo { Name: VxPlace.Name, Code: Trim(VxPlace.City) }\n", rows);
        Assert.Contains("  assign Rows2 = Q.List mapTo { Name: VxPlace.Name, Code: Trim(VxPlace.City) }\n", rows);

        // The platform's own mapping of a plain value that leaves Code empty, and a mapping the platform does not keep: one
        // refusal with both, each with its reason, nothing kept.
        var partial = Action("VxPartial", "  out Rows: VxRow List\n", Q + "  assign Rows = Q.List\n");
        var alias = Action("VxAlias", "  out Places: VxPlace List\n",
            "  Cache = aggregate FROM VxPlace, P2=VxPlace JOIN Inner VxPlace~P2 ON P2.Name = VxPlace.City MAX 50\n  assign Places = Cache.List mapTo { Value: P2 }\n");
        var problems = Refused(dir, "vx-refused", $$$"""{"ops":[{{{Texts(partial, alias)}}}]}""", basePath).OfType<JsonObject>().ToList();
        Assert.DoesNotContain(problems, p => p["code"]!.ToString() == "FLOW_NOT_EXACT");
        var leaves = Assert.Single(problems, p => p["code"]!.ToString() == "FLOW_MAPPING_TYPES" && p["pointer"]?.ToString() == "/ops/0/data/flow/0");
        Assert.Contains("leaves Code empty", leaves["message"]!.ToString());
        Assert.Contains("Q.List mapTo { Name: VxPlace.Name, Code: <value> }", leaves["fix"]!.ToString());
        Assert.Single(problems, p => p["code"]!.ToString() == "FLOW_MAPPING_TYPES" && p["pointer"]?.ToString() == "/ops/0/data/flow/1");

        // An edit of the read that writes the list's Current into a mapping: the relative mapping is proposed, then
        // checked. Some runtimes cannot keep this non-identity entity mapping; that failed correction is never offered.
        var read = Read(dir, "vx-forms", lane, "VxPlaces");
        var edited = read.Text.Replace("  assign Places = Q.List @", "  assign Places = Q.List mapTo { Id: Q.List.Current.VxPlace.Id, Name: Q.List.Current.VxPlace.City, City: Q.List.Current.VxPlace.Name } @");
        Assert.NotEqual(read.Text, edited);
        var cursorProblems = Refused(dir, "vx-edit", $$$"""{"ops":[{{{Flow((edited, read.TextSha))}}}]}""", Path.Combine(dir, "vx-forms.oml"));
        var problem = Assert.Single(cursorProblems.OfType<JsonObject>(), p => p["code"]!.ToString() == "FLOW_MAPPING_CURSOR");
        if (problem["patch"] is JsonArray patch)
        {
            Assert.Contains("Q.List mapTo { Id: VxPlace.Id, Name: VxPlace.City, City: VxPlace.Name }", patch.ToJsonString());
            Assert.DoesNotContain("Q.List.Current", patch.ToJsonString());
        }
        else
        {
            Assert.Null(problem["patch"]);
            Assert.Contains("no patch: applied to the job, the corrected op was refused: FLOW_MAPPING_TYPES", problem["fix"]!.ToString());
            Assert.Contains("Q.List mapTo { Id: VxPlace.Id, Name: VxPlace.City, City: VxPlace.Name }", problem["fix"]!.ToString());
        }
    }

    private const string VySpec = """
        {"op":"spec","data":{"entities":[
          {"name":"VyPlace","attributes":[{"name":"Name","type":"Text","length":50},{"name":"City","type":"Text","length":50}]},
          {"name":"VySetting","attributes":[{"name":"Key","type":"Text","length":50},{"name":"Value","type":"Text","length":50}]},
          {"name":"VyReq","attributes":[{"name":"Name","type":"Text","length":50,"mandatory":true},{"name":"City","type":"Text","length":50}]}],
         "structures":[
          {"name":"VyRow","attributes":[{"name":"Name","type":"Text"},{"name":"Code","type":"Text"}]},
          {"name":"VyValRow","attributes":[{"name":"Value","type":"Text"},{"name":"Code","type":"Text"}]}]}}
        """;

    // Re-check of VisitaCerta 2026-10-12 (probes N1, N1b, N1c and N7b, both lanes): the platform's own mapping of a value is
    // taken only when it says what the text said. `Value: Setting.Value` into a structure that has an attribute named Value
    // fills that attribute, not the record whole: Code stays empty in every item, for a list, a record and a List action's
    // argument alike (FLOW_MAPPING_TYPES naming Code, never FLOW_MAPPING_STUDIO). A mapping that leaves a mandatory attribute
    // out is FLOW_MAPPING_TYPES naming it on both lanes (ODC fills it by itself from its namesake: never FLOW_NOT_EXACT).
    public static void APlatformMappingThatLeavesAnAttributeEmptyIsRefusedWhateverItsNames(string dir, string fixture, string lane)
    {
        Run(dir, "vy-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{VySpec}}}]}""");
        var basePath = Path.Combine(dir, "vy-base.oml");
        const string S = "  S = aggregate FROM VySetting WHERE (VySetting.Key <> \"\") MAX 50\n";
        const string Q = "  Q = aggregate FROM VyPlace WHERE (VyPlace.Name <> \"\") MAX 50\n";
        string Action(string name, string declarations, string body) => "server action " + name + "\n" + declarations + body + "  end\n";
        var list = Action("VyValueList", "  out Rows: VyValRow List\n", S + "  assign Rows = S.List\n");
        var record = Action("VyValueRecord", "  out R: VyValRow\n", S + "  assign R = S.List.Current\n");
        var argument = Action("VyValueArgument", "  out Rows: VyValRow List\n", S + "  (System).ListAppendAll(List=Rows, SourceList=S.List)\n");
        var problems = Refused(dir, "vy-value", $$$"""{"ops":[{{{Texts(list, record)}}}]}""", basePath).OfType<JsonObject>().ToList();
        Assert.DoesNotContain(problems, p => p["code"]!.ToString() == "FLOW_NOT_EXACT");
        foreach (var pointer in new[] { "/ops/0/data/flow/0", "/ops/0/data/flow/1" }) {
            var leaves = Assert.Single(problems, p => p["code"]!.ToString() == "FLOW_MAPPING_TYPES" && p["pointer"]?.ToString() == pointer);
            Assert.Contains("leaves Code empty", leaves["message"]!.ToString());
            Assert.Contains("Value: VySetting.Value, Code: <value>", leaves["fix"]!.ToString());
        }
        // The argument of a List action: ODC maps it by itself (refused, naming Code); O11 maps it in some runs only (refused the
        // same way) and leaves it plain in others, which its Verify refuses (ExpressionMissingTypeConversion). Never accepted.
        JsonNode? plain = null;
        Exception? refusal = null;
        try { plain = Run(dir, "vy-value-argument", $$$"""{"ops":[{{{Texts(argument)}}}]}""", basePath); } catch (Exception error) { refusal = error; }
        if (lane == "odc" || refusal != null) {
            var appendAll = (refusal != null ? Errors.FindCoded(refusal)?.Problems ?? new JsonArray() : new JsonArray()).OfType<JsonObject>().ToList();
            Assert.True(appendAll.Count > 0, refusal != null ? Errors.Text(refusal) : "accepted: " + plain?["policyMessages"]?.ToJsonString());
            Assert.DoesNotContain(appendAll, p => p["code"]!.ToString() == "FLOW_NOT_EXACT");
            var leaves = Assert.Single(appendAll, p => p["code"]!.ToString() == "FLOW_MAPPING_TYPES" && p["pointer"]?.ToString() == "/ops/0/data/flow/0");
            Assert.Contains("leaves Code empty", leaves["message"]!.ToString());
        } else {
            Assert.False(plain!["accepted"]!.GetValue<bool>());
            Assert.Contains("ExpressionMissingTypeConversion", plain["policyMessages"]!.ToJsonString());
        }

        var missing = Action("VyReqMissing", "  out Reqs: VyReq List\n", Q + "  assign Reqs = Q.List mapTo { Id: NullIdentifier(), City: VyPlace.City }\n");
        var mandatory = Refused(dir, "vy-mandatory", $$$"""{"ops":[{{{Texts(missing)}}}]}""", basePath).OfType<JsonObject>().ToList();
        Assert.DoesNotContain(mandatory, p => p["code"]!.ToString() == "FLOW_NOT_EXACT");
        var name = Assert.Single(mandatory, p => p["code"]!.ToString() == "FLOW_MAPPING_TYPES");
        Assert.Contains("Name", name["message"]!.ToString());
        Assert.Equal("/ops/0/data/flow/0", name["pointer"]?.ToString());
    }

    // Re-check of VisitaCerta 2026-10-12 (probes E0-E5, both lanes): a mapping of a read that reads its list's Current (as an
    // older engine or the Studio left it) is the Studio's. An edit that removes the assignment before it, swaps the two or adds
    // one before it never touches it: it is kept by its content (the same node, variable and value), never by its place, so
    // the edit is accepted and the mapping stays as the read has it (no FLOW_MAPPING_CURSOR, no patch that rewrites it).
    public static void AnEditThatLeavesAnExistingCursorMappingAsItWasKeepsIt(string dir, string fixture, string lane)
    {
        Run(dir, "vy-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{VySpec}}}]}""");
        const string Mapping = "Rows = Q.List mapTo { Name: Q.List.Current.VyPlace.Name, Code: Q.List.Current.VyPlace.City }";
        const string Legacy = "server action VyCursor\n  out N: Integer\n  out Rows: VyRow List\n  Q = aggregate FROM VyPlace WHERE (VyPlace.Name <> \"\") MAX 50\n"
            + "  assign\n    N = Q.Count\n    " + Mapping + "\n  end\n";
        // Written by the session alone (no job, no preflight, no normalizer), as a module an earlier engine left it.
        var host = new ModelHost(Path.Combine(dir, "work"));
        var model = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [Path.Combine(dir, "vy-base.oml")])!;
        try {
            var session = (ModelSession)Activator.CreateInstance(typeof(ModelSession), model)!;
            session.Apply(new JsonArray(JsonNode.Parse(Texts(Legacy))!));
            File.WriteAllBytes(Path.Combine(dir, "vy-legacy.oml"), (byte[])typeof(ModelHost).GetMethods().Single(m => m.Name == "Save" && m.GetParameters().Length == 1).Invoke(host, [model])!);
        } finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [model]); }
        var read = Read(dir, "vy-legacy", lane, "VyCursor");
        var lines = read.Text.Replace("\r\n", "\n").Split('\n').ToList();
        var n = lines.FindIndex(l => l.TrimStart().StartsWith("N = Q.Count", StringComparison.Ordinal));
        var rows = lines.FindIndex(l => l.TrimStart().StartsWith(Mapping, StringComparison.Ordinal));
        Assert.True(n >= 0 && rows >= 0, read.Text);
        var removed = lines.ToList(); removed.RemoveAt(n);
        var swapped = lines.ToList(); (swapped[n], swapped[rows]) = (swapped[rows], swapped[n]);
        var added = lines.ToList(); added.Insert(rows, new string(' ', lines[rows].Length - lines[rows].TrimStart().Length) + "N = 0");
        foreach (var (label, edit) in new[] { ("vy-removed", removed), ("vy-swapped", swapped), ("vy-added", added) }) {
            var text = string.Join("\n", edit);
            var result = Run(dir, label, $$$"""{"ops":[{{{Flow((text, read.TextSha))}}}]}""", Path.Combine(dir, "vy-legacy.oml"));
            Assert.True(result["accepted"]!.GetValue<bool>() && result["isValid"]!.GetValue<bool>(), label + ": " + result["policyMessages"]?.ToJsonString() + result["details"]);
            Assert.Contains(Mapping + "\n", Bare(Read(dir, label, lane, "VyCursor").Text));
        }
        // The block of one assignment is printed on the assign line.
        Assert.Contains("  assign " + Mapping + "\n", Bare(Read(dir, "vy-removed", lane, "VyCursor").Text));
        Assert.Contains("    " + Mapping + "\n    N = Q.Count\n", Bare(Read(dir, "vy-swapped", lane, "VyCursor").Text));
        Assert.Contains("    N = Q.Count\n    N = 0\n    " + Mapping + "\n", Bare(Read(dir, "vy-added", lane, "VyCursor").Text));

        // An edit of a mapping of the read (the whole mapping a FLOW_MAPPING_TYPES asks for) reads back as written: on ODC the
        // mapping is the conversion the setter builds from the whole text, never written inside the old value's text
        // (`... mapTo { ... } mapTo {  }`, a syntax error the Verify refused).
        const string Before = "Q.List mapTo { Name: VyPlace.Name, Code: VyPlace.Name }";
        const string After = "Q.List mapTo { Name: VyPlace.Name, Code: VyPlace.City }";
        Run(dir, "vy-rows", $$$"""{"ops":[{{{Texts("server action VyRows\n  out Rows: VyRow List\n  Q = aggregate FROM VyPlace WHERE (VyPlace.Name <> \"\") MAX 50\n  assign Rows = " + Before + "\n  end\n")}}}]}""", Path.Combine(dir, "vy-legacy.oml"));
        var mapping = Read(dir, "vy-rows", lane, "VyRows");
        var remapped = mapping.Text.Replace("  assign Rows = " + Before + " @", "  assign Rows = " + After + " @");
        Assert.NotEqual(mapping.Text, remapped);
        var written = Run(dir, "vy-remapped", $$$"""{"ops":[{{{Flow((remapped, mapping.TextSha))}}}]}""", Path.Combine(dir, "vy-rows.oml"));
        Assert.True(written["accepted"]!.GetValue<bool>() && written["isValid"]!.GetValue<bool>(), written["policyMessages"]?.ToJsonString() + written["details"]);
        Assert.Contains("  assign Rows = " + After + "\n", Bare(Read(dir, "vy-remapped", lane, "VyRows").Text));
    }

    // Statements with keys need the read they were written on: without basedOn, refused with the current declarations and
    // the edit ready (DDL_BASE_REQUIRED); on the capture the job runs on, compared with the module now, and the receipt
    // names the basedOn of the next edit (kept in the store: an edit of it after the Studio changed the module is merged);
    // a read the store does not keep is refused (DDL_BASE_UNKNOWN) instead of undoing what the Studio changed, and a read
    // of another module is refused (DDL_BASE_FOREIGN).
    public static void DataStatementsNeedTheirReadAndGiveTheNext(string dir, string fixture, string lane)
    {
        var store = ModuleIndexStore.Default();
        if (store == null) return;
        Run(dir, "dn-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}}]}""");
        var basePath = Path.Combine(dir, "dn-base.oml");
        var baseSha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(basePath))).ToLowerInvariant();
        var ddl = new ModelHost(Path.Combine(dir, "work")).BuildDdl(File.ReadAllBytes(basePath), baseSha, lane);
        var block = ddl.Blocks.Single(b => b.Name == "FaOrder").Text;
        Assert.Contains("Title Text(50)", block);
        var noBase = Refused(dir, "dn-nobase", $$$"""{"ops":[{{{DataSpec(block.Replace("Title Text(50)", "Title Text(60)"), null)}}}]}""", basePath);
        var required = Assert.Single(noBase)!;
        Assert.Equal("DDL_BASE_REQUIRED", required["code"]!.ToString());
        Assert.Contains("Title Text(50)", required["edit"]!["ddl"]!.ToString());
        Assert.Equal(64, required["edit"]!["basedOn"]!.ToString().Length);
        // On the capture the job runs on: no read needed.
        var first = Run(dir, "dn-first", $$$"""{"ops":[{{{DataSpec(block.Replace("Title Text(50)", "Title Text(60)"), baseSha)}}}]}""", basePath);
        Assert.True(first["accepted"]!.GetValue<bool>(), first["policyMessages"]?.ToJsonString() + first["details"]);
        var next = first["results"]![0]!["result"]!["nextBasedOn"]?.ToString();
        Assert.Equal(64, next?.Length ?? 0);
        // The Studio's change after it (another job): Qty gets a default. The model's next edit, on its own write.
        var firstPath = Path.Combine(dir, "dn-first.oml");
        var firstSha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(firstPath))).ToLowerInvariant();
        var firstBlock = new ModelHost(Path.Combine(dir, "work")).BuildDdl(File.ReadAllBytes(firstPath), firstSha, lane).Blocks.Single(b => b.Name == "FaOrder").Text;
        var qty = firstBlock.Split('\n').Single(l => l.TrimStart().StartsWith("Qty Integer", StringComparison.Ordinal));
        var studio = Run(dir, "dn-studio", $$$"""{"ops":[{{{DataSpec(firstBlock.Replace(qty, qty.Replace("Qty Integer", "Qty Integer default 7")), firstSha)}}}]}""", firstPath);
        Assert.True(studio["accepted"]!.GetValue<bool>(), studio["policyMessages"]?.ToJsonString() + studio["details"]);
        var model = firstBlock.Replace("Title Text(60)", "Title Text(70)");
        var merged = Run(dir, "dn-next", $$$"""{"ops":[{{{DataSpec(model, next!)}}}]}""", Path.Combine(dir, "dn-studio.oml"));
        Assert.True(merged["accepted"]!.GetValue<bool>(), merged["policyMessages"]?.ToJsonString() + merged["details"]);
        Assert.Equal("three-way", merged["results"]![0]!["result"]!["merged"]!["merge"]!.ToString());
        var now = new ModelHost(Path.Combine(dir, "work")).BuildDdl(File.ReadAllBytes(Path.Combine(dir, "dn-next.oml")), "", lane).Blocks.Single(b => b.Name == "FaOrder").Text;
        Assert.Contains("Title Text(70)", now);
        Assert.Contains("default 7", now);
        // A read the store does not keep: refused, the Studio's default is not undone.
        var unknown = Refused(dir, "dn-unknown", $$$"""{"ops":[{{{DataSpec(model, new string('b', 64))}}}]}""", Path.Combine(dir, "dn-studio.oml"));
        Assert.Contains(unknown, p => p!["code"]!.ToString() == "DDL_BASE_UNKNOWN" && p["edit"]?["ddl"]?.ToString().Contains("default 7") == true);
        // A read of another module.
        var other = JsonNode.Parse(ddl.ToJson(store.Adapter))!.AsObject();
        var otherSha = new string('c', 64);
        other["sourceSha256"] = otherSha; other["module"]!["key"] = "AnotherModuleKey000000";
        Directory.CreateDirectory(Path.GetDirectoryName(store.DdlPathOf(otherSha))!);
        File.WriteAllText(store.DdlPathOf(otherSha), other.ToJsonString());
        var foreign = Refused(dir, "dn-foreign", $$$"""{"ops":[{{{DataSpec(model, otherSha)}}}]}""", Path.Combine(dir, "dn-studio.oml"));
        Assert.Contains(foreign, p => p!["code"]!.ToString() == "DDL_BASE_FOREIGN");
    }

    private static string DataSpec(string ddl, string? basedOn)
    {
        var data = new JsonObject { ["ddl"] = ddl };
        if (basedOn != null) data["basedOn"] = basedOn;
        return new JsonObject { ["op"] = "spec", ["data"] = data }.ToJsonString();
    }

    // CX3: the list-mapping alternative must work through both public forms, not only the flow-text writer.
    public static void ListMappingsWorkInTextAndJson(string dir, string fixture, string lane)
    {
        const string sub = """{"op":"spec","data":{"structures":[{"name":"SubRow","attributes":[{"name":"Code","type":"Text","length":50},{"name":"Amount","type":"Decimal"}]}]}}""";
        Run(dir, "cx-map-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Records}}},{{{sub}}}]}""");
        var basePath = Path.Combine(dir, "cx-map-base.oml");
        const string mapping = "Src mapTo { Key: Code, Total: Amount + 1, Label: Note }";
        const string same = "Src mapTo { Code: Code, Amount: Amount }";
        var text = "server action CxText\n  in Src: SrcRow List\n  out Dst: DstRow List\n  out Appended: DstRow List\n"
            + "  assign Dst = " + mapping + "\n  (System).ListAppendAll(List=Appended, SourceList=" + mapping + ")\n  end\n";
        var homonym = "server action CxSame\n  in Src: SrcRow List\n  out Dst: SubRow List\n  out Appended: SubRow List\n"
            + "  assign Dst = " + same + "\n  (System).ListAppendAll(List=Appended, SourceList=" + same + ")\n  end\n";
        var textual = Run(dir, "cx-map-text", JobOfTexts(text, homonym), basePath);
        Assert.True(textual["accepted"]!.GetValue<bool>() && textual["isValid"]!.GetValue<bool>(), textual.ToJsonString());
        Assert.Equal(text, Bare(Read(dir, "cx-map-text", lane, "CxText").Text));
        if (lane == "o11") {
            Assert.Contains(textual["normalizations"]!.AsArray(), n => n!["rule"]?.ToString() == "FLOW_MAPPING_PLATFORM");
            Assert.DoesNotContain("mapTo", Bare(Read(dir, "cx-map-text", lane, "CxSame").Text));
        } else Assert.Equal(homonym, Bare(Read(dir, "cx-map-text", lane, "CxSame").Text));

        JsonObject Action(string name, string type, string value) => new() {
            ["name"] = name,
            ["inputs"] = new JsonArray(new JsonObject { ["name"] = "Src", ["type"] = "SrcRow List" }),
            ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Dst", ["type"] = type }, new JsonObject { ["name"] = "Appended", ["type"] = type }),
            ["steps"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["Dst"] = value }, ["as"] = "MapRows" },
                new JsonObject { ["call"] = "ListAppendAll", ["as"] = "ListAppendAll", ["args"] = new JsonObject { ["List"] = "Appended", ["SourceList"] = value } }) };
        var actions = new JsonArray(Action("CxJson", "DstRow List", mapping), Action("CxJsonSame", "SubRow List", same));
        var job = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = actions } }) }.ToJsonString();
        var json = Run(dir, "cx-map-json", job, basePath);
        Assert.True(json["accepted"]!.GetValue<bool>() && json["isValid"]!.GetValue<bool>(), json.ToJsonString());
        if (lane == "o11") Assert.Contains(json["normalizations"]!.AsArray(), n => n!["rule"]?.ToString() == "FLOW_MAPPING_PLATFORM"
            && n["path"]!.ToString().StartsWith("/ops/0/data/actions/1/steps/", StringComparison.Ordinal));
        Assert.Equal(text.Replace("CxText", "CxJson").Replace("Label: Note }\n", "Label: Note }  # MapRows\n"), Bare(Read(dir, "cx-map-json", lane, "CxJson").Text));
        if (lane == "o11") Assert.DoesNotContain("mapTo", Bare(Read(dir, "cx-map-json", lane, "CxJsonSame").Text));
        else Assert.Equal(homonym.Replace("CxSame", "CxJsonSame").Replace("Amount: Amount }\n", "Amount: Amount }  # MapRows\n"),
            Bare(Read(dir, "cx-map-json", lane, "CxJsonSame").Text));
        if (lane == "o11") {
            var invalid = job.Replace("Key: Code", "NotAnAttribute: Code").Replace("CxJson", "CxInvalid");
            Assert.Contains("NotAnAttribute", invalid);
            Assert.Contains(Refused(dir, "cx-map-invalid", invalid, basePath), p => p!["code"]?.ToString() == "FLOW_MAPPING_TYPES");
        }
    }

    public static void JsonForEachRefusalsCarryIndividualCheckedPatches(string dir, string fixture, string lane)
    {
        Run(dir, "cx-loop-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Records}}}]}""");
        var basePath = Path.Combine(dir, "cx-loop-base.oml");
        const string job = """
            {"ops":[{"op":"logic","data":{"actions":[{"name":"CxLoops","inputs":[{"name":"Rows","type":"SrcRow List"}],
            "outputs":[{"name":"Mapped","type":"DstRow List"},{"name":"Kept","type":"SrcRow List"}],"vars":[{"name":"Row","type":"DstRow"}],"steps":[
            {"foreach":"Rows","as":"EachMapped","do":[{"if":"Rows.Current.Amount > 0","then":[
              {"assign":{"Row.Key":"Rows.Current.Code","Row.Total":"Rows.Current.Amount","Row.Label":"Rows.Current.Note"}},
              {"call":"ListAppend","args":{"List":"Mapped","Element":"Row"}}]}]},
            {"foreach":"Rows","as":"EachKept","do":[{"if":"Rows.Current.Amount > 1","then":[
              {"call":"ListAppend","args":{"List":"Kept","Element":"Rows.Current"}}]}]}]}]}}]}
            """;
        var problems = Refused(dir, "cx-loop-refused", job, basePath);
        Assert.Equal(2, problems.Count);
        Assert.All(problems, p => {
            Assert.Equal("FLOW_FOREACH_LIST_ACTION", p!["code"]?.ToString());
            var patch = Assert.IsType<JsonArray>(p["patch"]);
            Assert.Equal(2, patch.Count);
            Assert.Equal("replace", patch[0]!["op"]?.ToString());
            Assert.Equal("add", patch[1]!["op"]?.ToString());
            Assert.Equal(p["pointer"]?.ToString(), patch[0]!["path"]?.ToString());
            Assert.Contains("ListAppendAll", p["text"]!.ToString());
        });
        Assert.EndsWith("/steps/1", problems[0]!["pointer"]!.ToString());
        var corrected = Patched(job, problems);
        var pure = JobPreflight.Analyze(JsonNode.Parse(corrected)!["ops"]!.AsArray());
        Assert.True(pure["valid"]!.GetValue<bool>(), pure.ToJsonString());
        Assert.DoesNotContain("allowForEach", corrected);
        var result = Run(dir, "cx-loop-patched", corrected, basePath);
        Assert.True(result["accepted"]!.GetValue<bool>() && result["isValid"]!.GetValue<bool>(), result.ToJsonString());
        var read = Read(dir, "cx-loop-patched", lane, "CxLoops");
        Assert.DoesNotContain("foreach ", read.Text);
        Assert.Contains("SourceList=FilterMapped.FilteredList mapTo { Key: Code, Total: Amount, Label: Note }", read.Text);
        Assert.Contains("SourceList=FilterKept.FilteredList", read.Text);
    }

    public static void JsonMappingValuesKeepTheirRelativeScope(string dir, string fixture, string lane)
    {
        // Pure preflight: fields have item scope, but only a whole assign or call argument admits mapTo.
        JsonObject Check(string steps) {
            var ops = JsonNode.Parse("""[{"op":"logic","data":{"actions":[{"name":"CxSyntax","inputs":[{"name":"Rows","type":"SrcRow List"}],"outputs":[{"name":"Dst","type":"DstRow List"}],"steps":STEPS}]}}]""".Replace("STEPS", steps))!.AsArray();
            return JobPreflight.Analyze(ops);
        }
        var good = Check("""[{"assign":{"Dst":"Rows mapTo { Key: ItemOnlyName, Total: UnknownToAction + 1 }"}},{"call":"ListAppendAll","args":{"List":"Dst","SourceList":"Rows mapTo { Key: ItemOnlyName }"}}]""");
        Assert.DoesNotContain(good["problems"]!.AsArray(), p => p!["code"]?.ToString() is "EXPRESSION_SYNTAX" or "EXPR_UNKNOWN_IDENTIFIER" or "OPERAND_TYPES");
        var wrong = Check("""[{"if":"Rows mapTo { Key: Code }","then":[]},{"get":"SrcRow","as":"Q","where":"Rows mapTo { Key: Code }","sort":"Rows mapTo { Key: Code }"},{"assign":{"Dst":"Rows mapTo { Key: Code + }"}}]""");
        var syntax = wrong["problems"]!.AsArray().Where(p => p!["code"]?.ToString() == "EXPRESSION_SYNTAX").ToArray();
        Assert.Equal(4, syntax.Length);
        Assert.Equal(3, syntax.Count(p => p!["fix"]!.ToString().Contains("whole assign/argument", StringComparison.Ordinal)));
    }

    // ---- corrections of the third junction (Corrigir 1) -----------------------------------------------------------------------

    private const string Records = """
        {"op":"spec","data":{"structures":[
          {"name":"SrcRow","attributes":[{"name":"Code","type":"Text","length":50},{"name":"Amount","type":"Decimal"},{"name":"Note","type":"Text","length":50}]},
          {"name":"DstRow","attributes":[{"name":"Key","type":"Text","length":50},{"name":"Total","type":"Decimal"},{"name":"Label","type":"Text","length":50}]}]}}
        """;

    private static string IdOf(string text, string contains) { var line = Line(text, contains); return line[(line.LastIndexOf('@') + 1)..]; }

    // Two data texts of one job, both written on the capture the job runs on (basedOn = its sha256, as a partial job writes them):
    // the second is merged three ways with the data text the job started from, so what the first changed stays (it was set
    // back to the capture's value with no merge and no conflict listed).
    public static void TwoDataTextsOfOneJobOnTheCaptureKeepEachOther(string dir, string fixture, string lane)
    {
        Run(dir, "dt-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}}]}""");
        var basePath = Path.Combine(dir, "dt-base.oml");
        var baseSha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(basePath))).ToLowerInvariant();
        var block = new ModelHost(Path.Combine(dir, "work")).BuildDdl(File.ReadAllBytes(basePath), baseSha, lane).Blocks.Single(b => b.Name == "FaOrder").Text;
        var qty = block.Split('\n').Single(l => l.TrimStart().StartsWith("Qty Integer", StringComparison.Ordinal));
        var first = block.Replace("Title Text(50)", "Title Text(150)");
        var second = block.Replace(qty, qty.Replace("Qty Integer", "Qty Integer default 7"));
        var result = Run(dir, "dt-two", $$$"""{"ops":[{{{DataSpec(first, baseSha)}}},{{{DataSpec(second, baseSha)}}}]}""", basePath);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        Assert.Equal("three-way", result["results"]![1]!["result"]!["merged"]!["merge"]!.ToString());
        var now = new ModelHost(Path.Combine(dir, "work")).BuildDdl(File.ReadAllBytes(Path.Combine(dir, "dt-two.oml")), "", lane).Blocks.Single(b => b.Name == "FaOrder").Text;
        Assert.Contains("Title Text(150)", now);
        Assert.Contains("default 7", now);
    }

    // The JavaScript of an action that does more than run it (written while the action was isolated, then a step added): the
    // Studio removes it, the delivery, on the read before, changes it. The merge writes it again with a new id and lists the
    // conflict; it is the action's own JavaScript (existing JavaScript is preserved, the delivery wins a true conflict), never
    // refused as a new one (FLOW_JAVASCRIPT_NOT_ISOLATED).
    public static void AJavaScriptTheStudioRemovedAndTheDeliveryChangedIsWrittenAgain(string dir, string fixture, string lane)
    {
        var store = ModuleIndexStore.Default();
        if (store == null) return;
        var basePath = MixedScript(dir, fixture, lane, "fs");
        var read = Read(dir, "fs-mixed", lane, "FaJsMix");
        store.SaveFlowReading(FlowReading.Of(read, lane, Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(basePath))).ToLowerInvariant()));
        var script = Block(read.Text, "Hint = javascript");
        var studio = Run(dir, "fs-studio", $$$"""{"ops":[{{{Flow((read.Text.Replace(script, ""), read.TextSha))}}}]}""", basePath);
        Assert.True(studio["accepted"]!.GetValue<bool>(), studio["policyMessages"]?.ToJsonString() + studio["details"]);
        Assert.DoesNotContain("javascript", Read(dir, "fs-studio", lane, "FaJsMix").Text);
        var edited = read.Text.Replace("console.log(y);", "console.log(y * 2);");
        var merged = Run(dir, "fs-merge", $$$"""{"ops":[{{{Flow((edited, read.TextSha))}}}]}""", Path.Combine(dir, "fs-studio.oml"));
        Assert.True(merged["accepted"]!.GetValue<bool>(), merged["policyMessages"]?.ToJsonString() + merged["details"]);
        var receipt = merged["results"]![0]!["result"]!["flow"]![0]!;
        Assert.Equal("three-way", receipt["merged"]!["merge"]!.ToString());
        Assert.Contains(receipt["merged"]!["conflicts"]!.AsArray(), c => c!["what"]!.ToString() == "removed in the Studio");
        var after = Read(dir, "fs-merge", lane, "FaJsMix").Text;
        Assert.Contains("Hint = javascript", after);
        Assert.Contains("console.log(y * 2);", after);
        Assert.Contains("if A > 0:", after);
    }

    // The merge battery over that action: every case exact and no reload. Its undo writes the read back over a case that left
    // the JavaScript removed (the read's JavaScript again, FlowRestore, as the LG2 battery's undo), and the case where the Studio
    // removed it and the delivery changed it is merged and written (it was refused, and the reload cut the action's cases).
    public static void TheMergeBatteryUndoesAndMergesAnExistingJavaScript(string dir, string fixture, string lane)
    {
        var basePath = MixedScript(dir, fixture, lane, "fb");
        var tally = FlowMergeBattery.Run(new ModelHost(Path.Combine(dir, "work")), File.ReadAllBytes(basePath), "fb", lane, seed: 1, every: 1, disjoint: 2, only: "FaJsMix");
        var json = tally.ToJson().ToJsonString();
        Assert.Equal(1, tally.Actions);
        Assert.True(tally.Failures.Count == 0, json);
        Assert.Equal(0, tally.Reloads);
        Assert.Equal(tally.Cases, tally.Exact);
        Assert.True(tally.ByCase.GetValueOrDefault("changed-removed") == 1 && tally.ByCase.GetValueOrDefault("removed-changed") == 1, json);
        Assert.True(tally.ByCase.GetValueOrDefault("code-same-line") == 1, json);
    }

    // A client action whose JavaScript was written while it only ran it (isolated), then given a decision after it: existing
    // JavaScript in an action that does more than run it, the only step of the action (what a removal case picks). Answers the
    // module with it.
    private static string MixedScript(string dir, string fixture, string lane, string prefix)
    {
        var js = "client action FaJsMix\n  in A: Integer\n  Hint = javascript\n    in In1: Integer = A\n    | var x = $parameters.In1;\n    | var y = x + 1;\n    | console.log(y);\n  end\n";
        var created = Run(dir, prefix + "-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Texts(js)}}}]}""");
        Assert.True(created["accepted"]!.GetValue<bool>(), created["policyMessages"]?.ToJsonString() + created["details"]);
        var read = Read(dir, prefix + "-base", lane, "FaJsMix");
        var end = read.Text.Split('\n').Last(l => l.StartsWith("  end", StringComparison.Ordinal));
        var mixed = Run(dir, prefix + "-mixed", $$$"""{"ops":[{{{Flow((read.Text.Replace(end, "  if A > 0:\n    end\n" + end), read.TextSha))}}}]}""", Path.Combine(dir, prefix + "-base.oml"));
        Assert.True(mixed["accepted"]!.GetValue<bool>(), mixed["policyMessages"]?.ToJsonString() + mixed["details"]);
        Assert.False(FlowDiff.Isolated(ModuleFlow.Read(Read(dir, prefix + "-mixed", lane, "FaJsMix").Text)));
        return Path.Combine(dir, prefix + "-mixed.oml");
    }

    // A parameter of a SQL or JavaScript node renamed by its text (the code naming it renamed too): the rename verb, and the
    // node's argument stays bound under the new name (it failed with KeyNotFoundException, the old name written empty).
    public static void ANodeParameterRenamedByTheTextKeepsItsArgument(string dir, string fixture, string lane)
    {
        var sql = "server action FaSqlP\n  in MinQty: Integer\n  GetQ = sql -> FaOrder\n    in Lim: Integer = MinQty\n    | SELECT {FaOrder}.*\n    | FROM {FaOrder}\n    | WHERE {FaOrder}.[Qty] > @Lim\n  end\n";
        var js = "client action FaJsP\n  in A: Integer\n  out R: Integer\n  Calc = javascript\n    in In1: Integer = A\n    out Out1: Integer\n    | $parameters.Out1 = $parameters.In1 * 2;\n  assign R = Calc.Out1\n  end\n";
        var created = Run(dir, "fp-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{Texts(sql, js)}}}]}""");
        Assert.True(created["accepted"]!.GetValue<bool>(), created["policyMessages"]?.ToJsonString() + created["details"]);
        var sqlRead = Read(dir, "fp-base", lane, "FaSqlP"); var jsRead = Read(dir, "fp-base", lane, "FaJsP");
        var sqlText = sqlRead.Text.Replace("in Lim: Integer = MinQty", "in Limit: Integer = MinQty").Replace("> @Lim\n", "> @Limit\n");
        var jsText = jsRead.Text.Replace("in In1: Integer = A", "in Qty: Integer = A").Replace("$parameters.In1", "$parameters.Qty");
        var renamed = Run(dir, "fp-rename", $$$"""{"ops":[{{{Flow((sqlText, sqlRead.TextSha), (jsText, jsRead.TextSha))}}}]}""", Path.Combine(dir, "fp-base.oml"));
        Assert.True(renamed["accepted"]!.GetValue<bool>(), renamed["policyMessages"]?.ToJsonString() + renamed["details"]);
        Assert.Equal(sqlText, Read(dir, "fp-rename", lane, "FaSqlP").Text);
        Assert.Equal(jsText, Read(dir, "fp-rename", lane, "FaJsP").Text);
    }

    // The raw rename of a parameter onto the name of an attribute of the source of a mapping that names it: refused as the text
    // refuses it (FLOW_RENAME_CAPTURED); the value would read Src.Note, and the next read would print it the same.
    public static void ARawRenameAMappingWouldReadAsAnAttributeIsRefused(string dir, string fixture, string lane)
    {
        var text = "server action FaRaw\n  in SrcOne: SrcRow\n  in Pfx: Text\n  out One: DstRow\n  assign One = SrcOne mapTo { Key: Pfx + Code, Total: Amount }\n  end\n";
        var created = Run(dir, "fw-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Records}}},{{{Texts(text)}}}]}""");
        Assert.True(created["accepted"]!.GetValue<bool>(), created["policyMessages"]?.ToJsonString() + created["details"]);
        var read = Read(dir, "fw-base", lane, "FaRaw");
        var key = read.Ids[IdOf(read.Text, "in Pfx:")];
        var problems = Refused(dir, "fw-captured", $$$"""{"ops":[{"op":"rename","target":"@{{{key}}}","name":"Note"}]}""", Path.Combine(dir, "fw-base.oml"));
        var problem = Assert.Single(problems)!;
        Assert.Equal("FLOW_RENAME_CAPTURED", problem["code"]!.ToString());
        Assert.Contains("Note", problem["message"]!.ToString());
        var free = Run(dir, "fw-free", $$$"""{"ops":[{"op":"rename","target":"@{{{key}}}","name":"Tail"}]}""", Path.Combine(dir, "fw-base.oml"));
        Assert.True(free["accepted"]!.GetValue<bool>(), free["policyMessages"]?.ToJsonString() + free["details"]);
        Assert.Contains("Key: Tail + Code", Read(dir, "fw-free", lane, "FaRaw").Text);
    }

    // The source of a mapping that is the output of a call node (FaGetSrc.Row) is typed through the action it calls: a rename
    // onto one of its attributes is refused (the value would read FaGetSrc.Row.Note). A mapping from the output of a call the
    // same text creates is written in one text (O11 refused it: the new call's output had no conversion yet).
    public static void AMappingFromACallsOutputIsTypedThroughTheAction(string dir, string fixture, string lane)
    {
        var getSrc = "server action FaGetSrc\n  out Row: SrcRow\n  end\n";
        var capture = "server action FaCapC\n  in Prefix: Text\n  out One: DstRow\n  FaGetSrc()\n  assign One = FaGetSrc.Row mapTo { Label: Prefix }\n  end\n";
        var created = Run(dir, "fo-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Records}}},{{{Texts(getSrc, capture)}}}]}""");
        Assert.True(created["accepted"]!.GetValue<bool>(), created["policyMessages"]?.ToJsonString() + created["details"]);
        var read = Read(dir, "fo-base", lane, "FaCapC");
        Assert.Equal(capture, Bare(read.Text));
        var renamed = read.Text.Replace("in Prefix: Text", "in Note: Text").Replace("Label: Prefix", "Label: Note");
        var problem = Assert.Single(Refused(dir, "fo-captured", $$$"""{"ops":[{{{Flow((renamed, read.TextSha))}}}]}""", Path.Combine(dir, "fo-base.oml")))!;
        Assert.Equal("FLOW_RENAME_CAPTURED", problem["code"]!.ToString());
        Assert.Contains("FaGetSrc.Row", problem["message"]!.ToString());
    }

    // A rename the Studio made since the read is read into the delivery's mapping values only where they name the renamed
    // element: Key: Code names the source's attribute and stays; Label: Prefix names the input and takes its final name. When
    // the final name is an attribute of the source (Note), the value would read Src.Note: refused (FLOW_RENAME_CAPTURED).
    public static void AStudioRenameIsNotReadIntoAMappingAsTheSourcesAttribute(string dir, string fixture, string lane)
    {
        var store = ModuleIndexStore.Default();
        if (store == null) return;
        var text = "server action FaCapA\n  in Src: SrcRow\n  in Code: Text\n  in Prefix: Text\n  out One: DstRow\n  assign One = Src mapTo { Total: Amount }\n  end\n";
        var created = Run(dir, "fn-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Records}}},{{{Texts(text)}}}]}""");
        Assert.True(created["accepted"]!.GetValue<bool>(), created["policyMessages"]?.ToJsonString() + created["details"]);
        var basePath = Path.Combine(dir, "fn-base.oml");
        var read = Read(dir, "fn-base", lane, "FaCapA");
        store.SaveFlowReading(FlowReading.Of(read, lane, Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(basePath))).ToLowerInvariant()));
        var delivered = read.Text.Replace("Src mapTo { Total: Amount }", "Src mapTo { Key: Code, Total: Amount, Label: Prefix }");
        var studio = Run(dir, "fn-studio", $$$"""{"ops":[{{{Flow((read.Text.Replace("in Code: Text", "in ProductCode: Text").Replace("in Prefix: Text", "in Tail: Text"), read.TextSha))}}}]}""", basePath);
        Assert.True(studio["accepted"]!.GetValue<bool>(), studio["policyMessages"]?.ToJsonString() + studio["details"]);
        var merged = Run(dir, "fn-merge", $$$"""{"ops":[{{{Flow((delivered, read.TextSha))}}}]}""", Path.Combine(dir, "fn-studio.oml"));
        Assert.True(merged["accepted"]!.GetValue<bool>(), merged["policyMessages"]?.ToJsonString() + merged["details"]);
        Assert.Contains("Src mapTo { Key: Code, Total: Amount, Label: Tail }", Read(dir, "fn-merge", lane, "FaCapA").Text);
        var studio2 = Run(dir, "fn-studio2", $$$"""{"ops":[{{{Flow((read.Text.Replace("in Prefix: Text", "in Note: Text"), read.TextSha))}}}]}""", basePath);
        Assert.True(studio2["accepted"]!.GetValue<bool>(), studio2["policyMessages"]?.ToJsonString() + studio2["details"]);
        var problems = Refused(dir, "fn-captured", $$$"""{"ops":[{{{Flow((delivered, read.TextSha))}}}]}""", Path.Combine(dir, "fn-studio2.oml"));
        var problem = Assert.Single(problems)!;
        Assert.Equal("FLOW_RENAME_CAPTURED", problem["code"]!.ToString());
        Assert.Contains("Note", problem["message"]!.ToString());
        Assert.Equal(Read(dir, "fn-studio2", lane, "FaCapA").Text, problem["edit"]!["text"]!.ToString());
    }

    // T2 into a list of an entity: the mapping names every mandatory attribute of the entity, its identifier with
    // NullIdentifier() as the local the loop built left it, on both lanes (ODC withheld the patch: the Verify requires the
    // identifier there too), and the patch writes the job.
    public static void TheT2PatchIntoAnEntityListNamesItsIdentifier(string dir, string fixture, string lane)
    {
        Run(dir, "fi-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{Records}}}]}""");
        var loop = "server action FaLoopE\n  in Src: SrcRow List\n  out Dst: FaOrder List\n  local Row: FaOrder\n  foreach Src:\n    assign\n      Row.Title = Src.Current.Code\n      Row.Qty = 1\n"
            + "    (System).ListAppend(List=Dst, Element=Row)\n    next\n  end\n";
        var job = $$$"""{"ops":[{{{Texts(loop)}}}]}""";
        var problem = Assert.Single(Refused(dir, "fi-t2", job, Path.Combine(dir, "fi-base.oml")))!;
        Assert.Equal("FLOW_FOREACH_LIST_ACTION", problem["code"]!.ToString());
        Assert.True(problem["patch"] is JsonArray, problem.ToJsonString());
        Assert.Contains("Id: NullIdentifier()", problem["text"]!.ToString());
        var written = Run(dir, "fi-patched", Patched(job, new JsonArray(problem.DeepClone())), Path.Combine(dir, "fi-base.oml"));
        Assert.True(written["accepted"]!.GetValue<bool>(), written["policyMessages"]?.ToJsonString() + written["details"]);
        Assert.Contains("(System).ListAppendAll(List=Dst, SourceList=Src mapTo { Id: NullIdentifier(), Title: Code, Qty: 1 })", Read(dir, "fi-patched", lane, "FaLoopE").Text);
    }

    // An existing mapping is edited by its text on both lanes: its source, a field's value and the set of fields of an
    // assignment, the fields of an argument, and two assignments that trade places. ODC wrote the new text inside the old
    // conversion (Src mapTo { new } mapTo { old }, FLOW_NOT_EXACT) or left a hidden one around a moved value (the Verify's
    // ParserUnexpectedElement); now the value is written whole and the job is valid.
    public static void AnExistingMappingIsEditedByItsText(string dir, string fixture, string lane)
    {
        var text = "server action FaMapX\n  in Src: SrcRow\n  in Src2: SrcRow\n  in Srcs: SrcRow List\n  out One: DstRow\n  out Two: DstRow\n  local Rows: DstRow List\n"
            + "  assign\n    One = Src mapTo { Total: Amount }\n    Two = Src mapTo { Key: Code }\n  (System).ListAppendAll(List=Rows, SourceList=Srcs mapTo { Key: Code })\n  end\n";
        var created = Run(dir, "fx-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Records}}},{{{Texts(text)}}}]}""");
        Assert.True(created["accepted"]!.GetValue<bool>(), created["policyMessages"]?.ToJsonString() + created["details"]);
        var read = Read(dir, "fx-base", lane, "FaMapX");
        var edited = read.Text.Replace("One = Src mapTo { Total: Amount }", "One = Src2 mapTo { Total: Amount + 1, Label: Note }")
            .Replace("SourceList=Srcs mapTo { Key: Code }", "SourceList=Srcs mapTo { Key: Code, Total: Amount }");
        Assert.NotEqual(read.Text, edited);
        var result = Run(dir, "fx-edit", $$$"""{"ops":[{{{Flow((edited, read.TextSha))}}}]}""", Path.Combine(dir, "fx-base.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var after = Read(dir, "fx-edit", lane, "FaMapX");
        Assert.Contains("One = Src2 mapTo { Total: Amount + 1, Label: Note }", after.Text);
        Assert.Contains("SourceList=Srcs mapTo { Key: Code, Total: Amount }", after.Text);
        // The two assignments trade places (each keeps its own value).
        var one = Line(after.Text, "One = Src2"); var two = Line(after.Text, "Two = Src");
        var swapped = after.Text.Replace(one, "\u0001").Replace(two, one).Replace("\u0001", two);
        var moved = Run(dir, "fx-swap", $$$"""{"ops":[{{{Flow((swapped, after.TextSha))}}}]}""", Path.Combine(dir, "fx-edit.oml"));
        Assert.True(moved["accepted"]!.GetValue<bool>(), moved["policyMessages"]?.ToJsonString() + moved["details"]);
        var final = Read(dir, "fx-swap", lane, "FaMapX").Text;
        Assert.True(final.IndexOf("Two = Src mapTo { Key: Code }", StringComparison.Ordinal) < final.IndexOf("One = Src2 mapTo", StringComparison.Ordinal), final);
    }

    // ODC: a record literal is the value of an argument (ListAppend's Element), written parsed (it was kept as text the platform
    // does not parse, which read back as written and the Verify refused), and edited the same way; as the value of an assignment
    // the platform refuses it, so the text is refused before anything is written (FLOW_VALUE_RECORD_LITERAL).
    public static void ARecordLiteralIsWrittenParsedAndOnlyAsAnArgument(string dir, string fixture, string lane)
    {
        var text = "server action FaLit\n  in Code: Text\n  local Rows: DstRow List\n  (System).ListAppend(List=Rows, Element={ Key: Code, Total: 1, Label: \"a\" })\n  end\n";
        var created = Run(dir, "fy-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Records}}},{{{Texts(text)}}}]}""");
        Assert.True(created["accepted"]!.GetValue<bool>(), created["policyMessages"]?.ToJsonString() + created["details"]);
        var read = Read(dir, "fy-base", lane, "FaLit");
        Assert.Contains("Element={ Key: Code, Total: 1, Label: \"a\" }", read.Text);
        var edited = read.Text.Replace("Label: \"a\" }", "Label: Trim(Code) }");
        var result = Run(dir, "fy-edit", $$$"""{"ops":[{{{Flow((edited, read.TextSha))}}}]}""", Path.Combine(dir, "fy-base.oml"));
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        Assert.Contains("Label: Trim(Code) }", Read(dir, "fy-edit", lane, "FaLit").Text);
        var assigned = "server action FaLitAssign\n  out One: DstRow\n  assign One = { Key: \"a\", Total: 1, Label: \"b\" }\n  end\n";
        var problem = Assert.Single(Refused(dir, "fy-assign", $$$"""{"ops":[{{{Texts(assigned)}}}]}""", Path.Combine(dir, "fy-base.oml")))!;
        Assert.Equal("FLOW_VALUE_RECORD_LITERAL", problem["code"]!.ToString());
        Assert.Contains("One.Key = \"a\"", problem["fix"]!.ToString());
    }

    // ---- corrections of the third junction (Corrigir 2) -----------------------------------------------------------------------

    private static string Sha(string path) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

    // Two loops of one new text, each refused with the List action: the patch names the second ListAppendAll as the Studio would
    // (ListAppendAll2), so the job it writes reads back exactly as the corrected text (the creation battery found the second one
    // read with that name as a label: DCIPS_Staff_Reports, Reports/CustomDashboard).
    public static void TwoLoopsOfOneTextArePatchedAndReadBackAsThePatch(string dir, string fixture, string lane)
    {
        Run(dir, "f2-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}}]}""");
        var basePath = Path.Combine(dir, "f2-base.oml");
        var two = "/// Keeps two lists.\nserver action FaTwo\n  in Rows: FaOrder List\n  in More: FaOrder List\n  out Kept: FaOrder List\n  out Also: FaOrder List\n"
            + "  foreach Rows:\n    (System).ListAppend(Element=Rows.Current, List=Kept)\n    next\n"
            + "  foreach More:\n    (System).ListAppend(Element=More.Current, List=Also)\n    next\n  end\n";
        var job = JobOfTexts(two);
        var problems = Refused(dir, "f2-two", job, basePath);
        Assert.Equal(2, problems.Count(p => p!["code"]!.ToString() == "FLOW_FOREACH_LIST_ACTION"));
        var patched = Patched(job, new JsonArray(problems.Select(p => p!.DeepClone()).ToArray()));
        var written = Run(dir, "f2-patched", patched, basePath);
        Assert.True(written["accepted"]!.GetValue<bool>(), written["policyMessages"]?.ToJsonString() + written["details"]);
        var read = Read(dir, "f2-patched", lane, "FaTwo").Text;
        Assert.Contains("  (System).ListAppendAll(List=Kept, SourceList=Rows)", read);
        Assert.Contains("  ListAppendAll2 = (System).ListAppendAll(List=Also, SourceList=More)", read);
        var sent = JsonNode.Parse(patched)!["ops"]![0]!["data"]!["flow"]![0]!;
        var corrected = sent is JsonValue ? sent.ToString() : sent["text"]!.ToString();
        Assert.Equal(Bare(corrected), Bare(read));
    }

    // The rename of an attribute (the raw verb, and the data text that runs it) onto the name of an input a mapping of that
    // record reads in a field value: inside the mapping the source's attributes come first, so `Key: Prefix + Code` would read
    // Src.Prefix after the rename (accepted, valid, the input never used). Refused (FLOW_RENAME_CAPTURED); a free name is renamed
    // and the mapping follows it (review r2, o-dr / d-dr on both lanes).
    public static void AnAttributeRenameAMappingWouldReadAsAnotherElementIsRefused(string dir, string fixture, string lane)
    {
        var text = "server action FaAttr\n  in Src: SrcRow\n  in Prefix: Text\n  out One: DstRow\n  assign One = Src mapTo { Key: Prefix + Code, Label: Note }\n  end\n";
        var created = Run(dir, "fr-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Records}}},{{{Texts(text)}}}]}""");
        Assert.True(created["accepted"]!.GetValue<bool>(), created["policyMessages"]?.ToJsonString() + created["details"]);
        var basePath = Path.Combine(dir, "fr-base.oml");
        var baseSha = Sha(basePath);
        var block = new ModelHost(Path.Combine(dir, "work")).BuildDdl(File.ReadAllBytes(basePath), baseSha, lane).Blocks.Single(b => b.Name == "SrcRow").Text;
        var note = block.Split('\n').Single(l => l.TrimStart().StartsWith("Note:", StringComparison.Ordinal));
        var key = note[(note.LastIndexOf('@') + 1)..].Trim();
        var raw = Assert.Single(Refused(dir, "fr-raw", $$$"""{"ops":[{"op":"rename","target":"@{{{key}}}","name":"Prefix"}]}""", basePath))!;
        Assert.Equal("FLOW_RENAME_CAPTURED", raw["code"]!.ToString());
        Assert.Contains("Prefix", raw["message"]!.ToString());
        Assert.Contains("FaAttr", raw["message"]!.ToString());
        var ddl = Refused(dir, "fr-ddl", $$$"""{"ops":[{{{DataSpec(block.Replace(note, note.Replace("Note:", "Prefix:")), baseSha)}}}]}""", basePath);
        Assert.Contains(ddl, p => p!["code"]!.ToString() == "FLOW_RENAME_CAPTURED");
        var free = Run(dir, "fr-free", $$$"""{"ops":[{"op":"rename","target":"@{{{key}}}","name":"Remark"}]}""", basePath);
        Assert.True(free["accepted"]!.GetValue<bool>(), free["policyMessages"]?.ToJsonString() + free["details"]);
        var after = Read(dir, "fr-free", lane, "FaAttr").Text;
        Assert.Contains("Key: Prefix + Code", after);
        Assert.Contains("Label: Remark", after);
    }

    // The review of round 2 (round trip, high, (b) and (c)): an attribute renamed in the Studio (outside SSAM: here a raw set of its
    // Name, which no rename check sees) onto the name of an input a mapping's field value reads. (b) The reading carries that node
    // opaque (the model binds the value to the input; the text would read the attribute): never written back from text. (c) A text
    // of the older read is never merged into a value that would read the attribute: one that changes that mapping touches the opaque
    // node; one that adds a field naming the input, in a mapping the rename left readable, is FLOW_RENAME_CAPTURED.
    public static void AnAttributeRenamedInTheStudioIsNeitherAFixedPointNorMerged(string dir, string fixture, string lane)
    {
        var store = ModuleIndexStore.Default();
        if (store == null) return;
        var one = "server action FaAttr\n  in Src: SrcRow\n  in Prefix: Text\n  out One: DstRow\n  assign One = Src mapTo { Key: Prefix + Code, Label: Note }\n  end\n";
        var two = "server action FaAttr2\n  in Src: SrcRow\n  in Prefix: Text\n  out One: DstRow\n  assign One = Src mapTo { Label: Note }\n  end\n";
        var created = Run(dir, "fs2-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Records}}},{{{Texts(one, two)}}}]}""");
        Assert.True(created["accepted"]!.GetValue<bool>(), created["policyMessages"]?.ToJsonString() + created["details"]);
        var basePath = Path.Combine(dir, "fs2-base.oml");
        var readOne = Read(dir, "fs2-base", lane, "FaAttr"); var readTwo = Read(dir, "fs2-base", lane, "FaAttr2");
        foreach (var read in new[] { readOne, readTwo }) store.SaveFlowReading(FlowReading.Of(read, lane, Sha(basePath)));
        var block = new ModelHost(Path.Combine(dir, "work")).BuildDdl(File.ReadAllBytes(basePath), Sha(basePath), lane).Blocks.Single(b => b.Name == "SrcRow").Text;
        var note = block.Split('\n').Single(l => l.TrimStart().StartsWith("Note:", StringComparison.Ordinal));
        var studio = Run(dir, "fs2-studio", $$$"""{"ops":[{"op":"set","target":"@{{{note[(note.LastIndexOf('@') + 1)..].Trim()}}}","prop":"Name","value":"Prefix"}]}""", basePath);
        Assert.True(studio["accepted"]!.GetValue<bool>(), studio["policyMessages"]?.ToJsonString() + studio["details"]);
        var studioPath = Path.Combine(dir, "fs2-studio.oml");
        // (b) The node whose value reads the input is opaque in the reading; the one that reads the attribute is text.
        var nowOne = Read(dir, "fs2-studio", lane, "FaAttr");
        Assert.True(nowOne.Opaque is { Count: > 0 }, nowOne.Text);
        Assert.Contains("opaque", nowOne.Text);
        Assert.DoesNotContain("Key: Prefix + Code", nowOne.Text);
        var nowTwo = Read(dir, "fs2-studio", lane, "FaAttr2");
        Assert.Contains("Src mapTo { Label: Prefix }", nowTwo.Text);
        // (c) The older read changes the mapping the Studio left ambiguous: refused (the node is the module's, untouched).
        var touched = Refused(dir, "fs2-merge-one", $$$"""{"ops":[{{{Flow((readOne.Text.Replace("Key: Prefix + Code", "Key: Prefix + Code + \"-\""), readOne.TextSha))}}}]}""", studioPath);
        Assert.Contains(touched, p => p!["code"]!.ToString() is "FLOW_OPAQUE_TOUCHED" or "FLOW_RENAME_CAPTURED");
        // The older read adds a field naming the input to the mapping the rename left readable: two readings, refused.
        var added = Refused(dir, "fs2-merge-two", $$$"""{"ops":[{{{Flow((readTwo.Text.Replace("Src mapTo { Label: Note }", "Src mapTo { Key: Prefix, Label: Note }"), readTwo.TextSha))}}}]}""", studioPath);
        var captured = Assert.Single(added, p => p!["code"]!.ToString() == "FLOW_RENAME_CAPTURED")!;
        Assert.Contains("Prefix", captured["message"]!.ToString());
    }

    // What the platform's parser or Verify would refuse is refused in the plan, with the fix (review r2): O11 reads no record
    // literal (o-l1: it read back exact and only the Verify refused it); a mapping into an entity that leaves its identifier empty
    // is FLOW_MAPPING_TYPES on both lanes (ODC: d-p8, two Verify errors and no code before), with the patch that names it, which
    // writes the job.
    public static void AValueThePlatformWouldRefuseIsRefusedInThePlan(string dir, string fixture, string lane)
    {
        Run(dir, "fv-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{Records}}}]}""");
        var basePath = Path.Combine(dir, "fv-base.oml");
        var literal = "server action FaLitB\n  local L: DstRow List\n  (System).ListAppend(List=L, Element={ Key: \"k\", Total: 2, Label: \"c\" })\n  end\n";
        if (lane != "odc") {
            var problem = Assert.Single(Refused(dir, "fv-literal", JobOfTexts(literal), basePath))!;
            Assert.Equal("FLOW_VALUE_RECORD_LITERAL", problem["code"]!.ToString());
        }
        var mapping = "server action FaMand\n  in SrcOne: SrcRow\n  out Rec: FaOrder\n  assign Rec = SrcOne mapTo { Title: Code, Qty: 1 }\n  end\n";
        var job = JobOfTexts(mapping);
        var all = Refused(dir, "fv-mand", job, basePath);
        // In the plan on both lanes (the 24.1 fixes: O11 refused it only when it wrote the mapping, with no patch), alone.
        var refused = Assert.Single(all)!;
        Assert.Equal("FLOW_MAPPING_TYPES", refused["code"]!.ToString());
        Assert.Contains("Id", refused["message"]!.ToString());
        Assert.True(refused["patch"] is JsonArray, refused.ToJsonString());
        var written = Run(dir, "fv-mand-patched", Patched(job, new JsonArray(refused.DeepClone())), basePath);
        Assert.True(written["accepted"]!.GetValue<bool>(), written["policyMessages"]?.ToJsonString() + written["details"]);
        Assert.Contains("assign Rec = SrcOne mapTo { Id: NullIdentifier(), Title: Code, Qty: 1 }", Read(dir, "fv-mand-patched", lane, "FaMand").Text);
        // The argument of a call to another action of the module, typed by that action's input (the 24.1 fixes: not judged).
        var save = Run(dir, "fv-save", JobOfTexts("server action FaSave\n  in Order: FaOrder\n  end\n"), basePath);
        Assert.True(save["accepted"]!.GetValue<bool>(), save["policyMessages"]?.ToJsonString() + save["details"]);
        var call = JobOfTexts("server action FaMandCall\n  in SrcOne: SrcRow\n  FaSave(Order=SrcOne mapTo { Title: Code, Qty: 1 })\n  end\n");
        var argument = Assert.Single(Refused(dir, "fv-call", call, Path.Combine(dir, "fv-save.oml")))!;
        Assert.Equal("FLOW_MAPPING_TYPES", argument["code"]!.ToString());
        Assert.True(argument["patch"] is JsonArray, argument.ToJsonString());
        var called = Run(dir, "fv-call-patched", Patched(call, new JsonArray(argument.DeepClone())), Path.Combine(dir, "fv-save.oml"));
        Assert.True(called["accepted"]!.GetValue<bool>(), called["policyMessages"]?.ToJsonString() + called["details"]);
        Assert.Contains("FaSave(Order=SrcOne mapTo { Id: NullIdentifier(), Title: Code, Qty: 1 })", Read(dir, "fv-call-patched", lane, "FaMandCall").Text);
    }

    // The JSON form of the logic op is judged by the owner's rules on what it writes new (reviews r1 and r2: gs-a1-json-js-screen,
    // gs-b1-json-foreach-t1, ev-b1-json-foreach-t1 were accepted): a For Each that only filters into a list is FLOW_FOREACH_LIST_ACTION
    // with the List action's lines, a new JavaScript in a client action that does more is FLOW_JAVASCRIPT_NOT_ISOLATED, each with the
    // pointer of its action; a loop the op keeps with allowForEach {why} is accepted and listed (high), never silent.
    public static void TheJsonFormOfTheLogicOpIsJudgedByTheOwnersRules(string dir, string fixture, string lane)
    {
        Run(dir, "fj-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}}]}""");
        var basePath = Path.Combine(dir, "fj-base.oml");
        const string Loop = """
            {"op":"logic","data":{"actions":[{"name":"FaPick","inputs":[{"name":"Rows","type":"FaOrder List"}],"outputs":[{"name":"Picked","type":"FaOrder List"}],
              "steps":[{"foreach":"Rows","as":"EachRow","do":[{"if":"Rows.Current.Qty > 1","then":[{"call":"ListAppend","as":"Keep","args":{"List":"Picked","Element":"Rows.Current"}}]}]}]}]}}
            """;
        var loop = Assert.Single(Refused(dir, "fj-loop", "{\"ops\":[" + Loop + "]}", basePath), p => p!["code"]!.ToString() == "FLOW_FOREACH_LIST_ACTION")!;
        Assert.StartsWith("/ops/0/data/actions/0", loop["pointer"]!.ToString());
        Assert.Contains("ListAppendAll(List=Picked, SourceList=FilterPicked.FilteredList)", loop["text"]!.ToString());
        const string Script = """
            {"op":"logic","data":{"actions":[{"name":"FaRun","kind":"client","vars":[{"name":"Seen","type":"Integer"}],
              "steps":[{"assign":{"Seen":"1"}},{"node":"IJavaScriptNode","as":"Run","properties":{"JavaScript":"console.log(1);"}}]}]}}
            """;
        var script = Assert.Single(Refused(dir, "fj-script", "{\"ops\":[" + Script + "]}", basePath), p => p!["code"]!.ToString() == "FLOW_JAVASCRIPT_NOT_ISOLATED")!;
        Assert.StartsWith("/ops/0/data/actions/0", script["pointer"]!.ToString());
        // The escape of the JSON form: kept and listed.
        var kept = Run(dir, "fj-allowed", "{\"ops\":[" + Loop.Replace("{\"op\":\"logic\",", "{\"op\":\"logic\",\"allowForEach\":{\"why\":\"the paging loop a proof job keeps\"},") + "]}", basePath);
        Assert.True(kept["accepted"]!.GetValue<bool>(), kept["policyMessages"]?.ToJsonString() + kept["details"]);
        Assert.Contains(kept["highWarnings"] as JsonArray ?? new JsonArray(), w => w!["id"]?.ToString() == ForEachEscape.AllowedCode || w!["code"]?.ToString() == ForEachEscape.AllowedCode);
    }

    // The re-check of the 24.1 fixes (three high findings): the owner's rules on the JSON form followed the declared name (a rename
    // or a move of a later op left the JavaScript or the T1 loop unjudged: a2, a3, d3), one node of the read exempted every node
    // of a replace with the same list and label (a6), and a raw create, duplicate or move was never judged (a7b). Now every form is
    // judged on what it wrote, where it is at the end of the apply; each node of the read is the action's own for one node only; a
    // loop of the read the replace rewrote into T1 is kept and listed (as the text form keeps an edited loop); allowForEach holds
    // on a raw op as on the JSON form.
    public static void TheOwnersRulesJudgeWhatEveryFormWroteWhereItIsAtTheEnd(string dir, string fixture, string lane)
    {
        static string Page(string name) => "<screen name=\"" + name + "\">\n<var name=\"Qty\" type=\"Integer\"/>\n<Block name=\"LayoutTopMenu\"><slot name=\"Title\">Mark</slot>"
            + "<slot name=\"MainContent\">\n<div class=\"box\"><span class=\"one\">{{ Qty }}</span></div>\n</slot></Block>\n</screen>";
        const string Actions = """
            {"op":"logic","data":{"actions":[
              {"name":"FaBusy","kind":"client","vars":[{"name":"Seen","type":"Integer"}],"steps":[{"assign":{"Seen":"1"}}]},
              {"name":"FaSum","inputs":[{"name":"Rows","type":"FaOrder List"}],"outputs":[{"name":"Total","type":"Integer"}],
               "steps":[{"foreach":"Rows","as":"EachRow","do":[{"assign":{"Total":"Total + Rows.Current.Qty"}}]}]}]}}
            """;
        const string Kept = """
            {"op":"logic","allowForEach":{"why":"a legacy filter loop the scenario keeps"},"data":{"actions":[
              {"name":"FaKeep","inputs":[{"name":"Rows","type":"FaOrder List"}],"outputs":[{"name":"Picked","type":"FaOrder List"}],
               "steps":[{"foreach":"Rows","as":"EachKept","do":[{"if":"Rows.Current.Qty > 1","then":[{"call":"ListAppend","as":"Keep","args":{"List":"Picked","Element":"Rows.Current"}}]}]}]}]}}
            """;
        var created = Run(dir, "fo-base", $$$"""{"base":"{{{fixture}}}",{{{NoRole(lane)}}},"ops":[{{{Spec}}},{{{Html(Page("FaMoveA"))}}},{{{Html(Page("FaMoveB"))}}},{{{Actions}}},{{{Kept}}}]}""");
        Assert.True(created["accepted"]!.GetValue<bool>(), created["policyMessages"]?.ToJsonString() + created["details"]);
        var basePath = Path.Combine(dir, "fo-base.oml");
        JsonArray No(string name, string ops) => Refused(dir, name, "{\"ops\":[" + ops + "]}", basePath);
        JsonNode Yes(string name, string ops)
        {
            var result = Run(dir, name, "{\"ops\":[" + ops + "]}", basePath);
            Assert.True(result["accepted"]!.GetValue<bool>(), name + ": " + result["policyMessages"]?.ToJsonString() + result["details"]);
            return result;
        }
        static JsonArray High(JsonNode result) => result["highWarnings"] as JsonArray ?? new JsonArray();
        const string Script = """{"op":"logic","data":{"actions":[{"name":"FaRunJs","kind":"client","vars":[{"name":"Seen","type":"Integer"}],"steps":[{"assign":{"Seen":"1"}},{"node":"IJavaScriptNode","as":"Run","properties":{"JavaScript":"console.log(1);"}}]}]}}""";
        const string Filter = """{"op":"logic","data":{"actions":[{"name":"FaPickT1","inputs":[{"name":"Rows","type":"FaOrder List"}],"outputs":[{"name":"Picked","type":"FaOrder List"}],"steps":[{"foreach":"Rows","as":"EachRow","do":[{"if":"Rows.Current.Qty > 1","then":[{"call":"ListAppend","as":"Keep","args":{"List":"Picked","Element":"Rows.Current"}}]}]}]}]}}""";
        // (1) A rename after the JSON op: judged under its new name, with the pointer of the declared action.
        var renamed = Assert.Single(No("fo-rename-js", Script + """,{"op":"rename","target":"IClientAction:FaRunJs","name":"FaRunLater"}"""), p => p!["code"]!.ToString() == "FLOW_JAVASCRIPT_NOT_ISOLATED")!;
        Assert.StartsWith("/ops/0/data/actions/0", renamed["pointer"]!.ToString());
        Assert.Contains("FaRunLater", renamed["message"]!.ToString());
        var loop = Assert.Single(No("fo-rename-t1", Filter + """,{"op":"rename","target":"IServerAction:FaPickT1","name":"FaPickLater"}"""), p => p!["code"]!.ToString() == "FLOW_FOREACH_LIST_ACTION")!;
        Assert.Contains("FaPickLater", loop["message"]!.ToString());
        Assert.Contains("ListAppendAll(List=Picked", loop["text"]!.ToString());
        // (2) A move after the JSON op (a screen action into another screen: the platform recreates it with new keys): the move runs
        // and the JavaScript is judged where it landed.
        var moved = No("fo-move-js", """{"op":"logic","data":{"actions":[{"name":"FaBlink","kind":"screen","owner":"IMobileScreen:FaMoveA","vars":[{"name":"Seen","type":"Integer"}],"steps":[{"assign":{"Seen":"1"}},{"node":"IJavaScriptNode","as":"Run","properties":{"JavaScript":"console.log(1);"}}]}]}},{"op":"move","target":"IMobileScreen:FaMoveA/FaBlink","into":"IMobileScreen:FaMoveB"}""");
        Assert.Contains(moved, p => p!["code"]!.ToString() == "FLOW_JAVASCRIPT_NOT_ISOLATED" && p["pointer"]!.ToString().StartsWith("/ops/0/data/actions/0", StringComparison.Ordinal));
        Assert.DoesNotContain(moved, p => p!["op"]?.ToString() == "1");
        // (3) A raw create of a JavaScript node in an existing client action that does more than run it: refused at the create; in a
        // new client action of its own, accepted.
        var raw = Assert.Single(No("fo-raw-js", """{"op":"create","parent":"IClientAction:FaBusy","type":"IJavaScriptNode","name":"RunRaw","as":"js1"},{"op":"set","target":"$js1","prop":"JavaScript","value":"console.log(1);"},{"op":"link","from":"$js1","to":"IClientAction:FaBusy/#IAssignNode","connector":"Target"},{"op":"link","from":"IClientAction:FaBusy/#IStartNode","to":"$js1","connector":"Target"}"""), p => p!["code"]!.ToString() == "FLOW_JAVASCRIPT_NOT_ISOLATED")!;
        Assert.Equal("/ops/0", raw["pointer"]!.ToString());
        Assert.Contains("create op #0", raw["message"]!.ToString());
        Yes("fo-raw-js-isolated", """{"op":"create","parent":"@espace","type":"IClientAction","name":"FaIsoRaw","as":"ca"},{"op":"create","parent":"$ca","type":"IStartNode","as":"s0"},{"op":"create","parent":"$ca","type":"IJavaScriptNode","name":"RunIso","as":"js1"},{"op":"set","target":"$js1","prop":"JavaScript","value":"console.log(1);"},{"op":"create","parent":"$ca","type":"IEndNode","as":"s9"},{"op":"link","from":"$s0","to":"$js1"},{"op":"link","from":"$js1","to":"$s9","connector":"Target"}""");
        // (4) A duplicate of an action with a T1 loop writes a new loop: refused at the duplicate; kept and listed with allowForEach.
        var copy = Assert.Single(No("fo-duplicate-t1", """{"op":"duplicate","target":"IServerAction:FaKeep","as":"copy"}"""), p => p!["code"]!.ToString() == "FLOW_FOREACH_LIST_ACTION")!;
        Assert.Equal("/ops/0", copy["pointer"]!.ToString());
        Assert.Contains("duplicate op #0", copy["message"]!.ToString());
        var allowed = Yes("fo-duplicate-t1-allowed", """{"op":"duplicate","target":"IServerAction:FaKeep","as":"copy","allowForEach":{"why":"a copy of the legacy filter loop the scenario keeps"}}""");
        Assert.Contains(High(allowed), w => w!["code"]?.ToString() == ForEachEscape.AllowedCode && w["op"]?.ToString() == "0");
        // (5) A replace: the loop of the read is the action's own for one loop only (a second one with its list and label is new and
        // judged); the same loop again is kept without a word; the only loop rewritten into T1 is kept and listed.
        Assert.Contains(No("fo-replace-second-loop", """{"op":"logic","data":{"actions":[{"name":"FaSum","replace":true,"inputs":[{"name":"Rows","type":"FaOrder List"}],"outputs":[{"name":"Total","type":"Integer"}],"vars":[{"name":"Picked","type":"FaOrder List"}],"steps":[{"foreach":"Rows","as":"EachRow","do":[{"assign":{"Total":"Total + Rows.Current.Qty"}}]},{"foreach":"Rows","as":"EachOther","label":"EachRow","do":[{"if":"Rows.Current.Qty > 1","then":[{"call":"ListAppend","as":"Keep","args":{"List":"Picked","Element":"Rows.Current"}}]}]},{"assign":{"Total":"Total + Picked.Length"}}]}]}}"""),
            p => p!["code"]!.ToString() == "FLOW_FOREACH_LIST_ACTION" && p["pointer"]!.ToString() == "/ops/0/data/actions/0");
        var same = Yes("fo-replace-same-loop", """{"op":"logic","data":{"actions":[{"name":"FaSum","replace":true,"inputs":[{"name":"Rows","type":"FaOrder List"}],"outputs":[{"name":"Total","type":"Integer"}],"steps":[{"assign":{"Total":"0"}},{"foreach":"Rows","as":"EachRow","do":[{"assign":{"Total":"Total + Rows.Current.Qty"}}]}]}]}}""");
        Assert.DoesNotContain(High(same), w => w!["code"]?.ToString() == ModelSession.ForEachEditedKeptCode);
        var edited = Yes("fo-replace-edited-loop", """{"op":"logic","data":{"actions":[{"name":"FaSum","replace":true,"inputs":[{"name":"Rows","type":"FaOrder List"}],"outputs":[{"name":"Total","type":"Integer"}],"vars":[{"name":"Picked","type":"FaOrder List"}],"steps":[{"foreach":"Rows","as":"EachRow","do":[{"if":"Rows.Current.Qty > 1","then":[{"call":"ListAppend","as":"Keep","args":{"List":"Picked","Element":"Rows.Current"}}]}]},{"assign":{"Total":"Picked.Length"}}]}]}}""");
        Assert.Contains(High(edited), w => w!["code"]?.ToString() == ModelSession.ForEachEditedKeptCode);
    }

    public static void ScreenJavaScriptExceptionIsScopedAndAudited(string dir, string fixture, string lane)
    {
        const string Page = "<screen name=\"FaClick\"><var name=\"Qty\" type=\"Integer\"/><Block name=\"LayoutTopMenu\"><slot name=\"Title\">Clicks</slot><slot name=\"MainContent\"><span>{{ Qty }}</span></slot></Block></screen>";
        var created = Run(dir, "js-base", "{\"base\":\"" + fixture + "\"," + NoRole(lane) + ",\"ops\":[{\"op\":\"rename\",\"target\":\"@espace\",\"name\":\"JsExceptionFixture\"}," + Html(Page) + "," + Texts("action FaClick.Save\n  in Amount: Integer\n  assign Qty = Amount\n  end\n") + "]}");
        Assert.True(created["accepted"]!.GetValue<bool>(), created.ToJsonString());
        var basePath = Path.Combine(dir, "js-base.oml");
        const string Text = "action FaClick.JS_Save\n  in Amount: Integer\n  InvokeSave = javascript\n    in Amount: Integer = Amount\n    | $actions.Save($parameters.Amount);\n  end\n";
        var op = JsonNode.Parse(Texts(Text))!.AsObject();
        Assert.Contains(Refused(dir, "js-default", new JsonObject { ["ops"] = new JsonArray(op.DeepClone()) }.ToJsonString(), basePath), p => p!["code"]?.ToString() == "FLOW_JAVASCRIPT_NOT_ISOLATED");
        op["allowScreenJavaScript"] = new JsonObject { ["module"] = "JsExceptionFixture", ["screen"] = "FaClick", ["actions"] = new JsonArray("JS_Save"), ["why"] = "User explicitly requested JavaScript click routing" };
        var accepted = Run(dir, "js-allowed", new JsonObject { ["ops"] = new JsonArray(op.DeepClone()) }.ToJsonString(), basePath);
        Assert.True(accepted["accepted"]!.GetValue<bool>(), accepted.ToJsonString());
        Assert.Contains(accepted["highWarnings"]!.AsArray(), w => w!["code"]?.ToString() == ScreenJavaScriptException.AllowedCode);
        var saved = File.ReadAllBytes(Path.Combine(dir, "js-allowed.oml"));
        var read = new ModelHost(Path.Combine(dir, "work")).BuildFlow(saved, Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(saved)).ToLowerInvariant(), lane)
            .Actions.Single(a => a.Name.EndsWith("/FaClick/JS_Save", StringComparison.Ordinal));
        Assert.True(read.FixedPoint, string.Join("\n", read.Problems));
        Assert.Contains("$actions.Save($parameters.Amount);", read.Text);
        var rawOps = JsonNode.Parse("""
            [{"op":"create","parent":"IMobileScreen:FaClick/Save","type":"IJavaScriptNode","name":"RawScript","as":"js"},
             {"op":"set","target":"$js","prop":"JavaScript","value":"console.log('explicit exception');"},
             {"op":"link","from":"$js","to":"IMobileScreen:FaClick/Save/#IAssignNode","connector":"Target"},
             {"op":"link","from":"IMobileScreen:FaClick/Save/#IStartNode","to":"$js","connector":"Target"}]
            """)!.AsArray();
        rawOps[0]!["allowScreenJavaScript"] = op["allowScreenJavaScript"]!.DeepClone();
        rawOps[0]!["allowScreenJavaScript"]!["actions"] = new JsonArray("Save");
        var raw = Run(dir, "js-raw", new JsonObject { ["ops"] = rawOps.DeepClone() }.ToJsonString(), basePath);
        Assert.True(raw["accepted"]!.GetValue<bool>(), raw.ToJsonString());
        Assert.Contains(raw["highWarnings"]!.AsArray(), w => w!["code"]?.ToString() == ScreenJavaScriptException.AllowedCode);
        rawOps[0]!["allowScreenJavaScript"]!["screen"] = "WrongScreen";
        Assert.Contains(Refused(dir, "js-raw-scope", new JsonObject { ["ops"] = rawOps }.ToJsonString(), basePath), p => p!["code"]?.ToString() == "FLOW_JAVASCRIPT_NOT_ISOLATED");
        op["allowScreenJavaScript"]!["module"] = "OtherModule";
        Assert.Contains(Refused(dir, "js-wrong-module", new JsonObject { ["ops"] = new JsonArray(op.DeepClone()) }.ToJsonString(), basePath), p => p!["code"]?.ToString() == "FLOW_JAVASCRIPT_NOT_ISOLATED");
    }

    // CX3: pagination, typed SQL inputs and both handler flag forms remain one text throughout apply/save/read.
    public static void PaginationSqlAndExceptionHandlersReadBackExactly(string dir, string fixture, string lane)
    {
        const string Data = """
            {"op":"spec","data":{"entities":[
              {"name":"CxCustomer","attributes":[{"name":"Name","type":"Text","length":80}]},
              {"name":"CxEntry","attributes":[{"name":"CustomerId","type":"CxCustomer Identifier"},{"name":"Title","type":"Text","length":80},{"name":"Amount","type":"Decimal"}]}],
              "structures":[{"name":"CxRow","attributes":[{"name":"Title","type":"Text","length":80},{"name":"Customer","type":"Text","length":80}]},
              {"name":"CxTotal","attributes":[{"name":"Count","type":"Integer"},{"name":"Amount","type":"Decimal"}]}]}}
            """;
        const string Text = """
            /// Reads one page and its total, with typed SQL parameters and exception handlers.
            server action CxReadPage
              in CustomerId: CxCustomer Identifier
              in StartIndex?: Integer = 0
              in PageSize?: Integer = 50
              out Rows: CxRow List
              out Total: Integer
              out LatestTitle: Text
              Page = sql -> CxEntry, CxCustomer max If(PageSize <= 0, 50, PageSize)
                in Customer: CxCustomer Identifier = CustomerId
                in Skip: Integer = Max(0, StartIndex)
                in Take: Integer = If(PageSize <= 0, 50, PageSize)
                | SELECT {CxEntry}.*, {CxCustomer}.* FROM {CxEntry} INNER JOIN {CxCustomer} ON {CxCustomer}.[Id] = {CxEntry}.[CustomerId] WHERE {CxEntry}.[CustomerId] = @Customer ORDER BY {CxEntry}.[Id] DESC OFFSET @Skip ROWS FETCH NEXT @Take ROWS ONLY
              (System).ListAppendAll(List=Rows, SourceList=Page.List mapTo { Title: List.Title, Customer: List_2.Name })
              Latest = aggregate FROM CxCustomer, CxEntry JOIN Inner CxEntry~CxCustomer ON CxEntry.CustomerId = CxCustomer.Id WHERE (CxEntry.CustomerId = CustomerId) SORT CxEntry.Id desc MAX 1
              assign LatestTitle = If(Latest.List.Empty, "", Latest.List.Current.CxEntry.Title)
              Totals = sql -> CxTotal max 1
                in Customer: CxCustomer Identifier = CustomerId
                in Minimum: Decimal = 0
                | SELECT COUNT(*), SUM({CxEntry}.[Amount]) FROM {CxEntry} WHERE {CxEntry}.[CustomerId] = @Customer AND {CxEntry}.[Amount] >= @Minimum
              assign Total = Totals.List.Current.CxTotal.Count
              end
              on exception All Exceptions:
                raise CxQueryFailed("Unable to read the page")
              on exception CxQueryFailed abort log:
                raise CxQueryFailed("Unable to read the total")
            """;
        var authored = Text.Replace("\r\n", "\n") + "\n";
        // The reader prints native handler names; ODC also prints its derived join root. Declare those properties too;
        // MasterSource is asserted by the writer against the tree, not set through a non-existent native setter.
        authored = authored
            .Replace("on exception All Exceptions:\n", "on exception All Exceptions:\n    @{Name=\"AllExceptions\"}\n")
            .Replace("on exception CxQueryFailed abort log:\n", "on exception CxQueryFailed abort log:\n    @{Name=\"CxQueryFailed\"}\n");
        // T3: a server action pages by SQL OFFSET/FETCH (START on its aggregate is refused, LOGIC_START_SERVER_IGNORED); the
        // two-source aggregate stays for the join and, on ODC, its derived join root.
        if (lane == "odc") authored = authored.Replace("SORT CxEntry.Id desc MAX 1\n", "SORT CxEntry.Id desc MAX 1\n    @{MasterSource=&\"CxCustomer\"}\n");
        const string Legacy = "server action CxLegacySql\n  out Total: Integer\n  Totals = sql -> CxTotal max 1\n    | SELECT COUNT(*), SUM({CxEntry}.[Amount]) FROM {CxEntry}\n  assign Total = Totals.List.Current.List.Count\n  end\n";
        const string TypedMapping = "server action CxSqlMappedRows\n  out Rows: CxRow List\n  Totals = sql -> CxTotal max 1\n    | SELECT 1, 2\n  assign Rows = Totals.List mapTo { Title: IntegerToText(CxTotal.Count), Customer: IntegerToText(CxTotal.Count) }\n  Wrapped = sql -> CxTotal max 1\n    | SELECT 3, 4\n  (System).ListAppendAll(List=Rows, SourceList=((Wrapped.List)) mapTo { Title: IntegerToText(CxTotal.Count), Customer: IntegerToText(CxTotal.Count) })\n  end\n";
        const string LegacyMapping = "server action CxSqlLegacyMappedRows\n  out Rows: CxRow List\n  Totals = sql -> CxTotal max 1\n    | SELECT 1, 2\n  assign Rows = Totals.List mapTo { Title: IntegerToText(List.Count), Customer: \"CxTotal.Count\" }\n  end\n";
        var result = Run(dir, "cx-page", $$$"""{"base":"{{{fixture}}}","ops":[{{{Data}}},{"op":"create","parent":"@espace","type":"IUserException","name":"CxQueryFailed"},{{{Texts(authored, Legacy, TypedMapping, LegacyMapping)}}}]}""");
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        Assert.True(result["isValid"]!.GetValue<bool>(), result.ToJsonString());
        var read = Read(dir, "cx-page", lane, "CxReadPage");
        Assert.Equal(authored, Bare(read.Text));
        Assert.Equal(Legacy, Bare(Read(dir, "cx-page", lane, "CxLegacySql").Text));
        Assert.Equal(TypedMapping, Bare(Read(dir, "cx-page", lane, "CxSqlMappedRows").Text));
        Assert.Equal(LegacyMapping, Bare(Read(dir, "cx-page", lane, "CxSqlLegacyMappedRows").Text));
        var edited = Run(dir, "cx-page-again", "{\"ops\":[" + Flow((read.Text, read.TextSha)) + "]}", Path.Combine(dir, "cx-page.oml"));
        Assert.True(edited["accepted"]!.GetValue<bool>(), edited.ToJsonString());
        Assert.Equal(read.Text, Read(dir, "cx-page-again", lane, "CxReadPage").Text);
        if (lane == "odc") {
            var wrong = read.Text.Replace("MasterSource=&\"CxCustomer\"", "MasterSource=&\"CxEntry\"");
            Assert.Contains(Refused(dir, "cx-page-wrong-master", "{\"ops\":[" + Flow((wrong, read.TextSha)) + "]}", Path.Combine(dir, "cx-page.oml")),
                p => p!["code"]?.ToString() == "FLOW_AGGREGATE_MASTER_SOURCE");
        }
    }

    // Two texts of one op that trade the names of their actions (the 24.1 fixes, o-c2: the second rename clashed with the first,
    // APPLY_FAILED uncoded): each action goes through a free name first (renamedThrough), and both read back as their texts.
    public static void TwoTextsOfOneOpTradeTheNamesOfTheirActions(string dir, string fixture, string lane)
    {
        var created = Run(dir, "fs-base", $$$"""{"base":"{{{fixture}}}","ops":[{{{Texts("server action FaSwapA\n  out R: Integer\n  assign R = 1\n  end\n", "server action FaSwapB\n  out R: Integer\n  assign R = 2\n  end\n")}}}]}""");
        Assert.True(created["accepted"]!.GetValue<bool>(), created["policyMessages"]?.ToJsonString() + created["details"]);
        var a = Read(dir, "fs-base", lane, "FaSwapA"); var b = Read(dir, "fs-base", lane, "FaSwapB");
        var job = $$$"""{"ops":[{{{Flow((a.Text.Replace("server action FaSwapA ", "server action FaSwapB "), a.TextSha), (b.Text.Replace("server action FaSwapB ", "server action FaSwapA "), b.TextSha))}}}]}""";
        var swapped = Run(dir, "fs-swap", job, Path.Combine(dir, "fs-base.oml"));
        Assert.True(swapped["accepted"]!.GetValue<bool>(), swapped["policyMessages"]?.ToJsonString() + swapped["details"]);
        Assert.Equal(2, swapped["results"]![0]!["result"]!["renamedThrough"]!.AsArray().Count);
        var nowA = Read(dir, "fs-swap", lane, "FaSwapA"); var nowB = Read(dir, "fs-swap", lane, "FaSwapB");
        Assert.Contains("assign R = 2", nowA.Text);
        Assert.Contains("assign R = 1", nowB.Text);
        Assert.Equal(b.Key, nowA.Key);
        Assert.Equal(a.Key, nowB.Key);
    }

    // An html edit of a screen written on the job's capture, after a logic op of the same job that added an action to that screen
    // (the review of rounds 1 and 2: o1 was HTML_BASE_CHANGED with no patch, and in a mixed job it came only in the second
    // refusal): the edit is merged three ways with the screen as the capture had it, so the new action stays listed and the edit is
    // written.
    public static void AnHtmlEditAfterALogicOpOfTheSameScreenIsMergedWithIt(string dir, string fixture, string lane)
    {
        var page = "<screen name=\"FaMark\">\n<var name=\"Qty\" type=\"Integer\"/>\n<Block name=\"LayoutTopMenu\"><slot name=\"Title\">Mark</slot><slot name=\"MainContent\">\n"
            + "<div class=\"box\"><span class=\"one\">{{ Qty }}</span></div>\n</slot></Block>\n</screen>";
        var created = Run(dir, "fm-base", $$$"""{"base":"{{{fixture}}}",{{{NoRole(lane)}}},"ops":[{{{Html(page)}}}]}""");
        Assert.True(created["accepted"]!.GetValue<bool>(), created["policyMessages"]?.ToJsonString() + created["details"]);
        var basePath = Path.Combine(dir, "fm-base.oml");
        var reading = new ModelHost(Path.Combine(dir, "work")).HtmlRead(File.ReadAllBytes(basePath), "MobileScreen:FaMark")["documents"]![0]!;
        var span = Line(reading["html"]!.ToString(), "class=\"one\"").Trim().Replace("class=\"one\"", "class=\"two\"");
        var edit = new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "FaMark",
            ["basedOn"] = new JsonObject { ["capture"] = Sha(basePath), ["html"] = reading["htmlSha256"]!.ToString() }, ["edit"] = new JsonArray(span) } }.ToJsonString();
        var job = $$$"""{{{{NoRole(lane)}}},"ops":[{{{Texts("action FaMark.FaTouch\n  assign Qty = Qty + 1\n  end\n")}}},{{{edit}}}]}""";
        var result = Run(dir, "fm-both", job, basePath);
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString() + result["details"]);
        var after = new ModelHost(Path.Combine(dir, "work")).HtmlRead(File.ReadAllBytes(Path.Combine(dir, "fm-both.oml")), "MobileScreen:FaMark", withKeys: false)["documents"]![0]!["html"]!.ToString();
        Assert.Contains("class=\"two\"", after);
        Assert.Contains("FaTouch", after.Split('\n')[0]);
        // Two edits where the later writes again the element around the earlier one (its new Visible would be lost in the merge
        // of the edits with that reading too): refused, HTML_EDIT_OVERLAP, never merged in silence.
        string K(string line) => System.Text.RegularExpressions.Regex.Match(line, "k=\"([^\"]+)\"").Groups[1].Value;
        var html = reading["html"]!.ToString();
        var (box, one) = (K(Line(html, "class=\"box\"")), K(Line(html, "class=\"one\"")));
        var visible = "<span k=\"" + one + "\" class=\"one\" os-Visible=\"Qty > 0\">{{ Qty }}</span>";
        var outer = "<div k=\"" + box + "\" class=\"box\"><span k=\"" + one + "\" class=\"one\">{{ Qty }}</span></div>";
        var overlap = new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "FaMark",
            ["basedOn"] = new JsonObject { ["capture"] = Sha(basePath), ["html"] = reading["htmlSha256"]!.ToString() }, ["edit"] = new JsonArray(visible, outer) } }.ToJsonString();
        var refused = Refused(dir, "fm-overlap", $$$"""{{{{NoRole(lane)}}},"ops":[{{{Texts("action FaMark.FaTouch\n  assign Qty = Qty + 1\n  end\n")}}},{{{overlap}}}]}""", basePath);
        Assert.Contains(refused, p => p!["code"]!.ToString() == ScreenHtmlEdit.Overlap);
    }

    // The merge never puts one side's value under the other side's name (review r2, E1/E3/E2, end to end): an assignment the
    // Studio moved to another variable and the delivery changed keeps both (listed); a call the Studio pointed elsewhere and the
    // delivery changed is the delivery's whole call (listed); a filter the Studio changed survives when it removed another one the
    // delivery changed.
    public static void AMergeNeverPutsOneSidesValueUnderTheOthersName(string dir, string fixture, string lane)
    {
        var store = ModuleIndexStore.Default();
        if (store == null) return;
        FlowEntry Base(string name, string ops, string? basePath = null)
        {
            var result = Run(dir, name, ops, basePath);
            Assert.True(result["accepted"]!.GetValue<bool>(), name + ": " + result["policyMessages"]?.ToJsonString() + result["details"]);
            var read = Read(dir, name, lane, "FaCount");
            store.SaveFlowReading(FlowReading.Of(read, lane, Sha(Path.Combine(dir, name + ".oml"))));
            return read;
        }
        JsonNode Step(string name, string text, string basedOn, string on)
        {
            var result = Run(dir, name, $$$"""{"ops":[{{{Flow((text, basedOn))}}}]}""", Path.Combine(dir, on + ".oml"));
            Assert.True(result["accepted"]!.GetValue<bool>(), name + ": " + result["policyMessages"]?.ToJsonString() + result["details"]);
            return result;
        }
        // E1: the reset assigns Seen = 7 in the Studio, Total = 9 in the delivery.
        var e1 = Base("mx-e1", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{Action}}}]}""");
        Step("mx-e1-studio", e1.Text.Replace("assign Total = 0", "assign Seen = 7"), e1.TextSha, "mx-e1");
        var merged1 = Step("mx-e1-merge", e1.Text.Replace("assign Total = 0", "assign Total = 9"), e1.TextSha, "mx-e1-studio");
        var after1 = Read(dir, "mx-e1-merge", lane, "FaCount").Text;
        Assert.DoesNotContain("Seen = 9", after1);
        Assert.Contains("Total = 9", after1);
        Assert.Contains("Seen = 7", after1);
        Assert.Contains(merged1["results"]![0]!["result"]!["flow"]![0]!["merged"]!["conflicts"]!.AsArray(), c => c!["what"]!.ToString().Contains("removed in the Studio", StringComparison.Ordinal));
        // E3: FaPick(Code=Limit) pointed at FaOther(Id=Limit) in the Studio; the delivery changes FaPick's argument.
        const string Helpers = """
            {"op":"logic","data":{"actions":[
              {"name":"FaPick","inputs":[{"name":"Code","type":"Integer"}],"outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"Code"},"as":"Copy"}]},
              {"name":"FaOther","inputs":[{"name":"Id","type":"Integer"}],"outputs":[{"name":"Out","type":"Integer"}],"steps":[{"assign":{"Out":"Id"},"as":"Copy"}]}]}}
            """;
        var e3a = Base("mx-e3a", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{Helpers}}},{{{Action}}}]}""");
        var reset = e3a.Text.Split('\n').Single(l => l.Contains("assign Total = 0", StringComparison.Ordinal));
        var e3 = Base("mx-e3", $$$"""{"ops":[{{{Flow((e3a.Text.Replace(reset + "\n", reset + "\n  Pick = FaPick(Code=Limit)\n"), e3a.TextSha))}}}]}""", Path.Combine(dir, "mx-e3a.oml"));
        Assert.Contains("Pick = FaPick(Code=Limit)", e3.Text);
        Step("mx-e3-studio", e3.Text.Replace("Pick = FaPick(Code=Limit)", "Pick = FaOther(Id=Limit)"), e3.TextSha, "mx-e3");
        var merged3 = Step("mx-e3-merge", e3.Text.Replace("Pick = FaPick(Code=Limit)", "Pick = FaPick(Code=Limit + 1)"), e3.TextSha, "mx-e3-studio");
        var after3 = Read(dir, "mx-e3-merge", lane, "FaCount").Text;
        Assert.DoesNotContain("FaOther(Id=Limit + 1)", after3);
        Assert.Contains("Pick = FaPick(Code=Limit + 1)", after3);
        Assert.Contains(merged3["results"]![0]!["result"]!["flow"]![0]!["merged"]!["conflicts"]!.AsArray(), c => c!["what"]!.ToString() == "call");
        // E2: WHERE (FaOrder.Qty < 100) AND (FaOrder.Qty > 0); the Studio removes the first and changes the second, the delivery
        // changes the first.
        var e2a = Base("mx-e2a", $$$"""{"base":"{{{fixture}}}","ops":[{{{Spec}}},{{{Action}}}]}""");
        var e2 = Base("mx-e2", $$$"""{"ops":[{{{Flow((e2a.Text.Replace("WHERE (FaOrder.Qty > 0)", "WHERE (FaOrder.Qty < 100) AND (FaOrder.Qty > 0)"), e2a.TextSha))}}}]}""", Path.Combine(dir, "mx-e2a.oml"));
        Assert.Contains("(FaOrder.Qty < 100) AND (FaOrder.Qty > 0)", e2.Text);
        Step("mx-e2-studio", e2.Text.Replace("(FaOrder.Qty < 100) AND (FaOrder.Qty > 0)", "(FaOrder.Qty > 1)"), e2.TextSha, "mx-e2");
        Step("mx-e2-merge", e2.Text.Replace("(FaOrder.Qty < 100)", "(FaOrder.Qty < 200)"), e2.TextSha, "mx-e2-studio");
        var after2 = Read(dir, "mx-e2-merge", lane, "FaCount").Text;
        Assert.Contains("FaOrder.Qty > 1", after2);
        Assert.Contains("FaOrder.Qty < 200", after2);
    }
}
