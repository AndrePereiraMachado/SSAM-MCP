using System.Text.Json.Nodes;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects: the way back of the logic text (stage LG2, FlowDiff). The read of an action, edited as
// text, becomes the raw verbs that make the action say exactly that text, keeping the key of every element the text kept;
// what the rules refuse comes in one answer with every problem. The synthetic module is TextRoundTripTests'; the corpus
// battery (FlowBatteryCorpus) proves the same on real modules through the model.
public sealed class FlowEditTests
{
    private sealed record Read(TextRoundTripTests.Node Root, TextRoundTripTests.Node Action, FlowItem Item, FlowDocument Document)
    {
        public string Id(TextRoundTripTests.Node node) => Document.Keys.First(p => p.Value == node.Key).Key;
        public TextRoundTripTests.Node Of(string kind, int nth = 0) => Action.Children.Where(c => c.Kind == kind).ElementAt(nth);
        public string Line(string contains) => Document.Text.Split('\n').Single(l => l.Contains(contains, StringComparison.Ordinal));
    }

    private static Read ReadModule(Action<TextRoundTripTests.Node, TextRoundTripTests.Node>? change = null)
    {
        var (root, action) = TextRoundTripTests.Module();
        change?.Invoke(root, action);
        var item = ModuleFlow.Extract(root, new TextRoundTripTests.Reader(), action, out var problems);
        Assert.Empty(problems);
        return new(root, action, item, ModuleFlow.Print(item));
    }

    private static FlowDiff Diff(Read read, string text) => FlowDiff.Compute(read.Item, read.Document.Keys, ModuleFlow.Read(text), read.Document.Text);

    private static string Ops(FlowDiff diff) => string.Join("\n", diff.Ops.Select(o => o.ToJsonString()));
    private static bool Has(FlowDiff diff, string verb, string field, string value) =>
        diff.Ops.Any(o => o["op"]!.ToString() == verb && o[field]?.ToString() == value);

    [Fact]
    public void TheTextAsReadWritesNothing()
    {
        var read = ReadModule();
        var diff = Diff(read, read.Document.Text);
        Assert.Empty(diff.Problems);
        Assert.Empty(diff.Ops);
        Assert.Equal(read.Item.Canon(), diff.Expected.Canon());
    }

    [Fact]
    public void AnExpressionIsOneSetOfThatValue()
    {
        var read = ReadModule();
        var diff = Diff(read, read.Document.Text.Replace("assign Total = Total + 1 ", "assign Total = Total + 2 "));
        Assert.Empty(diff.Problems);
        var op = Assert.Single(diff.Ops);
        var assignment = read.Of("AssignNode").Children.Single(c => c.Kind == "Assignment");
        Assert.Equal("set", op["op"]!.ToString());
        Assert.Equal("@" + assignment.Key, op["target"]!.ToString());
        Assert.Equal("Value", op["prop"]!.ToString());
        Assert.Equal("Total + 2", op["value"]!.ToString());
    }

    [Fact]
    public void ANewLineIsCreatedFilledAndLinkedWhereTheTextPutsIt()
    {
        var read = ReadModule();
        var one = read.Of("AssignNode"); var choose = read.Of("SwitchNode");
        var line = read.Line("assign Total = Total + 1 ");
        var diff = Diff(read, read.Document.Text.Replace(line + "\n", line + "\n    assign OrderId = 0\n"));
        Assert.Empty(diff.Problems);
        var alias = Assert.Single(diff.Created).Value;
        Assert.True(Has(diff, "create", "as", alias), Ops(diff));
        Assert.Equal("IAssignNode", diff.Ops.Single(o => o["as"]?.ToString() == alias)["type"]!.ToString());
        Assert.Contains(diff.Ops, o => o["op"]!.ToString() == "create" && o["parent"]?.ToString() == alias && o["type"]!.ToString() == "IAssignment");
        Assert.Contains(diff.Ops, o => o["op"]!.ToString() == "set" && o["prop"]!.ToString() == "Variable" && o["value"]!.ToString() == "OrderId");
        Assert.Contains(diff.Ops, o => o["op"]!.ToString() == "link" && o["from"]!.ToString() == "@" + one.Key && o["to"]!.ToString() == alias);
        Assert.Contains(diff.Ops, o => o["op"]!.ToString() == "link" && o["from"]!.ToString() == alias && o["to"]!.ToString() == "@" + choose.Key);
        // Nothing else of the action is written.
        Assert.DoesNotContain(diff.Ops, o => o["op"]!.ToString() is "delete" or "rename" or "move");
        Assert.Equal(new[] { one.Key, alias }.Order(), diff.Touched.Order());
    }

    [Fact]
    public void ARemovedLineIsDeletedAfterTheFlowLeavesIt()
    {
        var read = ReadModule();
        var message = read.Of("MessageNode"); var parse = read.Of("JSONDeserializeNode"); var refresh = read.Of("RefreshDataNode");
        var diff = Diff(read, read.Document.Text.Replace(read.Line("message Info:") + "\n", ""));
        Assert.Empty(diff.Problems);
        var link = diff.Ops.FindIndex(o => o["op"]!.ToString() == "link" && o["from"]!.ToString() == "@" + parse.Key && o["to"]!.ToString() == "@" + refresh.Key);
        var delete = diff.Ops.FindIndex(o => o["op"]!.ToString() == "delete" && o["target"]!.ToString() == "@" + message.Key);
        Assert.True(link >= 0 && delete > link, Ops(diff));
        Assert.Equal(2, diff.Ops.Count);
        Assert.Equal([message.Key], diff.Deleted);
    }

    [Fact]
    public void ARenamedLocalIsTheRenameVerbThenItsExpressions()
    {
        var read = ReadModule();
        var total = read.Action.Children.Single(c => c.Kind == "LocalVariable");
        var text = System.Text.RegularExpressions.Regex.Replace(read.Document.Text, @"\bTotal\b", "Sum");
        var diff = Diff(read, text);
        Assert.Empty(diff.Problems);
        Assert.Equal("rename", diff.Ops[0]["op"]!.ToString());
        Assert.Equal("@" + total.Key, diff.Ops[0]["target"]!.ToString());
        Assert.Equal("Sum", diff.Ops[0]["name"]!.ToString());
        Assert.Contains(diff.Renamed, r => r.From == "Total" && r.To == "Sum");
        // The verb rewrites every expression that names it (Total + 1, the switch case, the SQL and trigger arguments): none
        // is written again, nothing is created or deleted, and the elements it rewrites count as touched.
        Assert.Single(diff.Ops);
        Assert.Contains(read.Of("AssignNode").Key, diff.Touched);
        Assert.Equal(System.Text.RegularExpressions.Regex.Replace(read.Item.Canon(), @"\bTotal\b", "Sum"), diff.Expected.Canon());
        // An expression the text changes beyond the rename is written as the text has it.
        var more = Diff(read, text.Replace("assign Sum = Sum + 1 ", "assign Sum = Sum + 2 "));
        Assert.Contains(more.Ops, o => o["op"]!.ToString() == "set" && o["value"]?.ToString() == "Sum + 2");
        Assert.Equal(2, more.Ops.Count);
    }

    [Fact]
    public void TheRenameRewriteKeepsLiteralsAttributesAndOtherNames()
    {
        Assert.Equal("sum + X.Total + \"Total\" + Subtotal + sum.Id", FlowEdits.Renamed("Total + X.Total + \"Total\" + Subtotal + total.Id", "Total", "sum"));
        Assert.Equal("If(Sum > 0, \"a\"\"Total\", Sum)", FlowEdits.Renamed("If(Total > 0, \"a\"\"Total\", total)", "Total", "Sum"));
        Assert.Equal("a$1b", FlowEdits.Renamed("Total", "Total", "a$1b"));
    }

    [Fact]
    public void SwappedLinesAreOnlyRelinked()
    {
        var read = ReadModule();
        var refresh = read.Line("refresh GetLines"); var trigger = read.Line("trigger Changed");
        var diff = Diff(read, read.Document.Text.Replace(refresh + "\n" + trigger + "\n", trigger + "\n" + refresh + "\n"));
        Assert.Empty(diff.Problems);
        Assert.All(diff.Ops, o => Assert.Equal("link", o["op"]!.ToString()));
        Assert.Equal(3, diff.Ops.Count);
    }

    [Fact]
    public void AnotherKindOnTheSameIdIsANewNodeInItsPlace()
    {
        var read = ReadModule();
        var message = read.Of("MessageNode");
        var line = read.Line("message Info:");
        var diff = Diff(read, read.Document.Text.Replace(line, "  Customers_CS.GetCustomer(Code=\"z\") @" + read.Id(message)));
        Assert.Empty(diff.Problems);
        var (id, old, alias) = Assert.Single(diff.Recreated);
        Assert.Equal(message.Key, old);
        Assert.Contains(diff.Ops, o => o["op"]!.ToString() == "create" && o["as"]?.ToString() == alias && o["_execute"] != null);
        Assert.Contains(message.Key, diff.Deleted);
    }

    [Fact]
    public void TheRulesRefuseOnceWithEveryProblem()
    {
        var read = ReadModule();
        var one = read.Of("AssignNode");
        var text = read.Document.Text
            .Replace("  Bump = sql", "  assign OrderId = 1 @n99\n  Bump = sql")                         // an id the read never gave
            .Replace("assign Total = Total + 1 @" + read.Id(one), "assign Total = Total + 1 @p2")          // a parameter's id on a node
            .Replace("      case Total > 3:\n        next", "      case Total > 3:\n        -> @zz");  // a jump to no element
        var diff = Diff(read, text);
        Assert.Empty(diff.Ops);
        var codes = diff.Problems.Select(p => p.Code).ToList();
        Assert.Contains("FLOW_KEY_FOREIGN", codes);
        Assert.Contains("FLOW_KEY_ROLE", codes);
        Assert.Contains("FLOW_JUMP_UNKNOWN", codes);
        Assert.Contains(diff.Problems, p => p.Code == "FLOW_KEY_FOREIGN" && p.Id == "n99" && p.Fix!.Contains("without an id"));
    }

    [Fact]
    public void ABranchToItselfAndAnIfWhoseBranchesMeetAreRefused()
    {
        var read = ReadModule();
        var check = read.Of("IfNode");
        var loop = read.Line("raise Invalid(");
        var self = Diff(read, read.Document.Text.Replace(loop, "    -> @" + read.Id(check)));
        Assert.Contains(self.Problems, p => p.Code == "FLOW_SELF_LOOP" && p.Id == read.Id(check));
        // Both branches of the If straight to the aggregate that follows it.
        var lines = read.Document.Text.Replace(loop, "    -> @" + read.Id(read.Of("AggregateNode")));
        var meet = Diff(read, lines);
        Assert.Contains(meet.Problems, p => p.Code == "FLOW_BRANCHES_MEET" && p.Id == read.Id(check));
        Assert.Empty(meet.Ops);
    }

    [Fact]
    public void AnOpaqueNodeStaysAsItWasRead()
    {
        var read = ReadModule((_, action) => action.Children.Single(c => c.Kind == "WaitNode").Add(TextRoundTripTests.N("Mystery", "Unknown")));
        var wait = read.Of("WaitNode");
        var line = read.Line("opaque WaitNode");
        Assert.Equal("  opaque WaitNode @" + read.Id(wait), line);
        // An edit elsewhere writes around it.
        var around = Diff(read, read.Document.Text.Replace("assign Total = Total + 1 ", "assign Total = Total + 2 "));
        Assert.Empty(around.Problems);
        Assert.DoesNotContain(around.Ops, o => o.ToJsonString().Contains(wait.Key, StringComparison.Ordinal));
        // Removed, changed or written new: refused, with the line as it was read.
        var removed = Diff(read, read.Document.Text.Replace(line + "\n", ""));
        var problem = Assert.Single(removed.Problems, p => p.Code == "FLOW_OPAQUE_TOUCHED");
        Assert.Equal(line, problem.Patch);
        var changed = Diff(read, read.Document.Text.Replace(line + "\n", line + "\n    @{Timeout=`31`}\n"));
        Assert.Contains(changed.Problems, p => p.Code == "FLOW_OPAQUE_TOUCHED" && p.Patch == line);
        var written = Diff(read, read.Document.Text.Replace(line + "\n", line + "\n  opaque WaitNode\n"));
        Assert.Contains(written.Problems, p => p.Code == "FLOW_OPAQUE_TOUCHED" && p.Message.Contains("new opaque"));
    }

    [Fact]
    public void ANewForEachThatOnlyFiltersOrCopiesIsRefusedWithTheListAction()
    {
        var read = ReadModule();
        var filter = Diff(read, read.Document.Text.Replace("  Bump = sql", """
              foreach Lines.List:
                if Lines.List.Current.Order.Code = Code:
                  (System).ListAppend(Element=Lines.List.Current, List=Picked)
                  next
                next
              Bump = sql
            """.TrimEnd('\n', ' ')));
        var problem = Assert.Single(filter.Problems);
        Assert.Equal("FLOW_FOREACH_LIST_ACTION", problem.Code);
        Assert.Contains("T1", problem.Message);
        Assert.Equal("FilterPicked = (System).ListFilter(Condition=Lines.List.Current.Order.Code = Code, SourceList=Lines.List)\n"
            + "(System).ListAppendAll(List=Picked, SourceList=FilterPicked.FilteredList)", problem.Patch);
        var copy = Diff(read, read.Document.Text.Replace("  Bump = sql", """
              foreach Lines.List:
                (System).ListAppend(Element=Lines.List.Current, List=Picked)
                next
              Bump = sql
            """.TrimEnd('\n', ' ')));
        Assert.Equal("(System).ListAppendAll(List=Picked, SourceList=Lines.List)", Assert.Single(copy.Problems).Patch);
        // A For Each of the read is kept as it is, whatever it does; a new one with an effect per item is a For Each.
        Assert.Empty(Diff(read, read.Document.Text).Problems);
        var effect = Diff(read, read.Document.Text.Replace("  Bump = sql", """
              foreach Lines.List:
                Customers_CS.GetCustomer(Code=Lines.List.Current.Order.Code)
                next
              Bump = sql
            """.TrimEnd('\n', ' ')));
        Assert.Empty(effect.Problems);
    }

    // A ListInsert at the end of the list (Position = List.Length) is the append of T1/T2, written another way (the reviews of
    // rounds 1 and 2: t1-listinsert, t2-listinsert-copy were accepted); at another position it is not an append.
    [Fact]
    public void AListInsertAtTheEndOfTheListIsTheAppendOfT1AndT2()
    {
        var read = ReadModule();
        string Loop(string body) => read.Document.Text.Replace("  Bump = sql", body.TrimEnd('\n', ' ') + "\n  Bump = sql");
        var filter = Diff(read, Loop("  foreach Lines.List:\n    if Lines.List.Current.Order.Code = Code:\n      (System).ListInsert(Element=Lines.List.Current, List=Picked, Position=Picked.Length)\n      next\n    next\n"));
        var problem = Assert.Single(filter.Problems);
        Assert.Equal("FLOW_FOREACH_LIST_ACTION", problem.Code);
        Assert.Contains("T1", problem.Message);
        Assert.Equal("FilterPicked = (System).ListFilter(Condition=Lines.List.Current.Order.Code = Code, SourceList=Lines.List)\n"
            + "(System).ListAppendAll(List=Picked, SourceList=FilterPicked.FilteredList)", problem.Patch);
        var copy = Diff(read, Loop("  foreach Lines.List:\n    (System).ListInsert(Element=Lines.List.Current, List=Picked, Position=Picked.Length )\n    next\n"));
        Assert.Equal("(System).ListAppendAll(List=Picked, SourceList=Lines.List)", Assert.Single(copy.Problems).Patch);
        // At the start of the list (a reversed copy) it is no append: a loop the team allows.
        Assert.Empty(Diff(read, Loop("  foreach Lines.List:\n    (System).ListInsert(Element=Lines.List.Current, List=Picked, Position=0)\n    next\n")).Problems);
    }

    // The JSON form of the logic op skipped decision 6 and T1/T2 (reviews r1 and r2): the same rules judge the nodes it wrote new
    // in the action as the model reads it (FlowDiff.NewElementRules), and the action's own nodes stay as they are.
    [Fact]
    public void TheNodesAnotherFormWroteNewAreJudgedByTheSameRules()
    {
        var text = "server action JsonPick\n  in Rows: Line List\n  out Picked: Line List\n  foreach Rows:\n    if Rows.Current.Qty > 1:\n"
            + "      (System).ListAppend(Element=Rows.Current, List=Picked)\n      next\n    next\n  Run = javascript\n    | console.log(1);\n  end\n";
        var action = ModuleFlow.Read(text);
        var all = FlowDiff.NewElementRules(action, _ => true, null);
        Assert.Contains(all, p => p.Code == "FLOW_FOREACH_LIST_ACTION" && p.Patch == "FilterPicked = (System).ListFilter(Condition=Rows.Current.Qty > 1, SourceList=Rows)\n"
            + "(System).ListAppendAll(List=Picked, SourceList=FilterPicked.FilteredList)");
        Assert.Contains(all, p => p.Code == "FLOW_JAVASCRIPT_NOT_ISOLATED" && p.Id == "Run");
        // The action's own nodes (not written new by the op): nothing to say.
        Assert.Empty(FlowDiff.NewElementRules(action, _ => false, null));
        // A client action that only runs its new script is isolated: nothing to say either.
        var isolated = ModuleFlow.Read("client action Beep\n  Run = javascript\n    | console.log(1);\n  end\n");
        Assert.Empty(FlowDiff.NewElementRules(isolated, _ => true, null));
    }

    [Fact]
    public void AForEachThatAlsoTotalsIsAllowedAndAnAppendOnTheFalseBranchFiltersByTheNegation()
    {
        var read = ReadModule();
        // The item is built and appended, and a total is kept: more than a map (T3 allows the For Each).
        var totals = Diff(read, read.Document.Text.Replace("  Bump = sql", """
              foreach Lines.List:
                assign
                  Line = Lines.List.Current
                  Total = Total + 1
                (System).ListAppend(Element=Line, List=Picked)
                next
              Bump = sql
            """.TrimEnd('\n', ' ')));
        Assert.Empty(totals.Problems);
        // The append on the false branch: the filter keeps the items the condition rejects.
        var negated = Diff(read, read.Document.Text.Replace("  Bump = sql", """
              foreach Lines.List:
                if Lines.List.Current.Order.Code = Code:
                  next
                (System).ListAppend(Element=Lines.List.Current, List=Picked)
                next
              Bump = sql
            """.TrimEnd('\n', ' ')));
        var problem = Assert.Single(negated.Problems);
        Assert.Contains("ListFilter(Condition=not (Lines.List.Current.Order.Code = Code), SourceList=Lines.List)", problem.Patch);
        // Appended from both branches of the first If: no single filter, so no certain patch; still a loop that only filters
        // into a list, refused (decision 5: a new For Each of T1/T2 is always refused, the fix in words when it is not certain).
        var both = Diff(read, read.Document.Text.Replace("  Bump = sql", """
              foreach Lines.List:
                if Lines.List.Current.Order.Code = Code:
                  (System).ListAppend(Element=Lines.List.Current, List=Picked) @x1
                  next
                if Count > 1:
                  -> @x1
                next
              Bump = sql
            """.TrimEnd('\n', ' ')));
        var unsure = Assert.Single(both.Problems);
        Assert.Equal("FLOW_FOREACH_LIST_ACTION", unsure.Code);
        Assert.Null(unsure.Patch);
        Assert.Contains("no patch: an If whose branches both reach the append", unsure.Fix);
    }

    // What the apply's module says that a text does not (FlowDiff's IFlowTypes), for the model-free tests.
    private sealed class Types(Dictionary<string, string>? types = null, Dictionary<string, (string, string)[]>? sources = null, Dictionary<string, string[]>? attributes = null,
        Dictionary<string, (string Attribute, string? Value)[]>? mandatory = null, Dictionary<string, string>? inputs = null) : IFlowTypes
    {
        public string? TypeOf(string name) => types?.GetValueOrDefault(name);
        public IReadOnlyList<(string Alias, string Record)>? SourcesOf(string aggregate) => sources?.GetValueOrDefault(aggregate);
        public IReadOnlyList<string>? AttributesOf(string record) => attributes?.GetValueOrDefault(record);
        public IReadOnlyList<(string Attribute, string? Value)>? MandatoryOf(string record) => mandatory?.GetValueOrDefault(record);
        // "Callee.Parameter" -> the type of that input.
        public string? InputTypeOf(string callee, string? callKind, string parameter) => inputs?.GetValueOrDefault(callee + "." + parameter);
    }

    private static FlowDiff NewText(string text, IFlowTypes types) =>
        FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(text), null, FlowDiff.AliasPrefix + ".", text, _ => false, types: types);

    [Fact]
    public void ANewForEachOverAnAggregatesRowsThatAppendsItsEntityIsT1WithTheListActionOfTheLane()
    {
        // The review of 2026-10-12 (p4, e2, e3): foreach GetX.List with ListAppend(Element=GetX.List.Current.Entity) was accepted on
        // both lanes: the element is the row's record, not the row. Now it is T1 (with an If) or T2 (without), patched per lane: O11
        // converts a row of one entity to that entity; ODC writes the conversion, mapTo {  }, when the list is of that entity.
        var text = "server action Longs\n  in Limit: Integer\n  out Longs: Shift List\n  GetShifts = aggregate FROM Shift\n  foreach GetShifts.List:\n"
            + "    if GetShifts.List.Current.Shift.Minutes > Limit:\n      (System).ListAppend(Element=GetShifts.List.Current.Shift, List=Longs)\n      next\n    next\n  end\n";
        var problem = Assert.Single(NewText(text).Problems);
        Assert.Equal("FLOW_FOREACH_LIST_ACTION", problem.Code);
        Assert.Contains("T1: the loop only filters GetShifts.List into Longs", problem.Message);
        var odc = Anvil.Core.MessageExpectations.Lane == "odc";
        Assert.Equal("FilterLongs = (System).ListFilter(Condition=GetShifts.List.Current.Shift.Minutes > Limit, SourceList=GetShifts.List)\n"
            + "(System).ListAppendAll(List=Longs, SourceList=FilterLongs.FilteredList" + (odc ? " mapTo {  }" : "") + ")", problem.Patch);
        Assert.NotNull(problem.Corrected);
        Assert.Empty(NewText(problem.Corrected!).Problems);
        // Without the If: T2, the aggregate's list as it is.
        var copy = text.Replace("    if GetShifts.List.Current.Shift.Minutes > Limit:\n      (System).ListAppend(Element=GetShifts.List.Current.Shift, List=Longs)\n      next\n",
            "    (System).ListAppend(Element=GetShifts.List.Current.Shift, List=Longs)\n");
        var copied = Assert.Single(NewText(copy).Problems);
        Assert.Contains("T2: the loop only copies GetShifts.List into Longs", copied.Message);
        Assert.Equal("(System).ListAppendAll(List=Longs, SourceList=GetShifts.List" + (odc ? " mapTo {  }" : "") + ")", copied.Patch);
        // A screen action over a screen aggregate and a list of the screen (e2): the text declares neither; the module says them.
        var screen = "client action CarregarTipos\n  foreach GetTipos.List:\n    if GetTipos.List.Current.TipoTurno.IsActive:\n"
            + "      (System).ListAppend(Element=GetTipos.List.Current.TipoTurno, List=Tipos)\n      next\n    next\n  end\n";
        var unknown = Assert.Single(NewText(screen).Problems);
        Assert.Equal("FLOW_FOREACH_LIST_ACTION", unknown.Code);
        Assert.Null(unknown.Patch);
        Assert.Contains("the sources of GetTipos are not known", unknown.Fix);
        var known = Assert.Single(NewText(screen, new Types(new() { ["Tipos"] = "TipoTurno List" }, new() { ["GetTipos"] = [("TipoTurno", "TipoTurno")] })).Problems);
        Assert.Equal("FilterTipos = (System).ListFilter(Condition=TipoTurno.IsActive, SourceList=GetTipos.List)\n"
            + "(System).ListAppendAll(List=Tipos, SourceList=FilterTipos.FilteredList" + (odc ? " mapTo {  }" : "") + ")", known.Patch);
        // ODC converts only into the entity's own list: into a list of another type, no certain patch.
        if (odc) Assert.Null(Assert.Single(NewText(screen, new Types(new() { ["Tipos"] = "Outro List" }, new() { ["GetTipos"] = [("TipoTurno", "TipoTurno")] })).Problems).Patch);
    }

    [Fact]
    public void ANewForEachThatAppendsAValueOfEachItemIsAMappingInBothLanes()
    {
        // The review of 2026-10-12 (e6, p8, p5): ODC offered a mapping with no field (mapTo {  }, "Mapping cannot be empty"); O11
        // accepted the loop. Both lanes now map into a list of values with { Value: ... } (the native O11 conversion too).
        var text = "server action Nomes\n  in Lista: Colaborador List\n  out Nomes: Text List\n  foreach Lista:\n"
            + "    (System).ListAppend(Element=Lista.Current.Nome, List=Nomes)\n    next\n  end\n";
        var problem = Assert.Single(NewText(text).Problems);
        Assert.Equal("FLOW_FOREACH_LIST_ACTION", problem.Code);
        Assert.Contains("T2: the loop only maps Lista into Nomes", problem.Message);
        Assert.Equal("(System).ListAppendAll(List=Nomes, SourceList=Lista mapTo { Value: Nome })", problem.Patch);
        Assert.Empty(NewText(problem.Corrected!).Problems);
        // A list whose type the text does not say: no certain patch.
        Assert.Null(Assert.Single(NewText(text.Replace("  out Nomes: Text List\n", "")).Problems).Patch);
    }

    [Fact]
    public void ANewForEachThatMapsFieldByFieldIsRefusedOnBothLanesWithTheFieldsInTheRecordsOrder()
    {
        // The review of 2026-10-12 (e7, p9): ODC wrote the fields in the order of the assignments, which the platform read back as a
        // second mapping (FLOW_NOT_EXACT); O11 accepted the loop. The fields go in the order of the record (the module says it), the
        // local the loop built goes with the loop; without that order the fix is in words. O11 writes the same mapping (the
        // argument's TypeConversion, from the junction with the O11 record mapping) once the module says which attributes are
        // mandatory: the identifier the loop leaves empty is mapped from NullIdentifier(), another mandatory one is the fix in words.
        var text = "server action Mapear\n  in Lista: Colaborador List\n  out Saida: TurnoEdicao List\n  local T: TurnoEdicao\n  foreach Lista:\n    assign\n"
            + "      T.ColaboradorId = Lista.Current.Id\n      T.TempId = Lista.Current.Nome\n    (System).ListAppend(Element=T, List=Saida)\n    next\n  end\n";
        string[] attributes = ["TurnoId", "TempId", "ColaboradorId", "Data"];
        var order = new Types(attributes: new() { ["TurnoEdicao"] = attributes }, mandatory: new() { ["TurnoEdicao"] = [] });
        var unordered = Assert.Single(NewText(text).Problems);
        Assert.Equal("FLOW_FOREACH_LIST_ACTION", unordered.Code);
        Assert.Null(unordered.Patch);
        var problem = Assert.Single(NewText(text, order).Problems);
        Assert.Equal("(System).ListAppendAll(List=Saida, SourceList=Lista mapTo { TempId: Nome, ColaboradorId: Id })", problem.Patch);
        Assert.Equal("server action Mapear\n  in Lista: Colaborador List\n  out Saida: TurnoEdicao List\n"
            + "  (System).ListAppendAll(List=Saida, SourceList=Lista mapTo { TempId: Nome, ColaboradorId: Id })\n  end\n", problem.Corrected);
        if (Anvil.Core.MessageExpectations.Lane != "odc") {
            // O11 refuses a mapping that leaves a mandatory attribute empty: without knowing them, no certain patch.
            Assert.Null(Assert.Single(NewText(text, new Types(attributes: new() { ["TurnoEdicao"] = attributes })).Problems).Patch);
            // The identifier the loop leaves empty: NullIdentifier(), in the order of the record.
            var id = new Types(attributes: new() { ["TurnoEdicao"] = attributes }, mandatory: new() { ["TurnoEdicao"] = [("TurnoId", "NullIdentifier()")] });
            Assert.Equal("(System).ListAppendAll(List=Saida, SourceList=Lista mapTo { TurnoId: NullIdentifier(), TempId: Nome, ColaboradorId: Id })",
                Assert.Single(NewText(text, id).Problems).Patch);
            // Another mandatory attribute the loop leaves as the local had it: the fix in words.
            var data = new Types(attributes: new() { ["TurnoEdicao"] = attributes }, mandatory: new() { ["TurnoEdicao"] = [("Data", null)] });
            var words = Assert.Single(NewText(text, data).Problems);
            Assert.Null(words.Patch);
            Assert.Contains("Data is mandatory in TurnoEdicao", words.Fix);
        }
        // The element read after the loop (the last item stays in it): refused, no certain patch on either lane.
        var after = text.Replace("    next\n  end\n", "    next\n  assign T.Data = CurrentDate()\n  end\n");
        Assert.Null(Assert.Single(NewText(after, order).Problems, p => p.Code == "FLOW_FOREACH_LIST_ACTION").Patch);
    }

    [Fact]
    public void ANewForEachThatMapsFieldByFieldIsAMappingInBothLanes()
    {
        var read = ReadModule();
        var local = read.Line("local Total");
        var text = read.Document.Text.Replace(local + "\n", local + "\n  local Line: Line\n").Replace("  Bump = sql", """
              foreach Lines.List:
                assign
                  Line.Code = Lines.List.Current.Order.Code
                  Line.Doubled = Lines.List.Current.Order.Id * 2
                (System).ListAppend(Element=Line, List=Picked)
                next
              Bump = sql
            """.TrimEnd('\n', ' '));
        // The same patch in both lanes, the fields in the order of the record: ODC writes the mapping in the expression, O11 in the
        // argument's TypeConversion (its mandatory attributes known: none here).
        var types = new Types(attributes: new() { ["Line"] = ["Doubled", "Qty", "Code"] }, mandatory: new() { ["Line"] = [] });
        var problem = Assert.Single(FlowDiff.Compute(read.Item, read.Document.Keys, ModuleFlow.Read(text), read.Document.Text, FlowDiff.AliasPrefix + ".", text, _ => false, types: types).Problems);
        Assert.Equal("FLOW_FOREACH_LIST_ACTION", problem.Code);
        Assert.Equal("(System).ListAppendAll(List=Picked, SourceList=Lines.List mapTo { Doubled: Order.Id * 2, Code: Order.Code })", problem.Patch);
        // The local the loop built goes with it: the corrected text is the read's with the List action alone.
        Assert.DoesNotContain("local Line", problem.Corrected);
    }

    // The map patch (T2) is offered only where it says what the loop says: the element is another type than the source's item
    // (a copy of some fields into the same type is no mapping: the patch would be refused), no value reads the element it
    // builds (the patch would read the source's item instead), and the element gets nothing outside the loop (the patch would
    // lose it). Such a loop is still refused (decision 5: a new loop that only builds and appends is never written), with the
    // fix in words and the reason there is no patch; a plain map is refused with its patch.
    [Fact]
    public void TheMapRuleIsOfferedOnlyWhereThePatchKeepsTheLoopsMeaning()
    {
        var types = new Types(attributes: new() { ["DstRow"] = ["Key", "Total", "Label"], ["SrcRow"] = ["Code", "Amount"] },
            mandatory: new() { ["DstRow"] = [], ["SrcRow"] = [] });
        List<FlowProblem> Rules(string body, string element = "Tmp: DstRow") => NewText(
            "server action T2Loop\n  in Src: SrcRow List\n  local " + element + "\n  local Out: " + element[(element.IndexOf(':') + 2)..] + " List\n" + body + "  end\n", types).Problems;
        const string Loop = "  foreach Src:\n{0}    (System).ListAppend(List=Out, Element=Tmp)\n    next\n";
        var map = Rules(string.Format(Loop, "    assign\n      Tmp.Key = Src.Current.Code\n      Tmp.Total = Src.Current.Amount\n"));
        var problem = Assert.Single(map);
        Assert.Equal("FLOW_FOREACH_LIST_ACTION", problem.Code);
        Assert.Equal("(System).ListAppendAll(List=Out, SourceList=Src mapTo { Key: Code, Total: Amount })", problem.Patch);
        // T20: some fields copied into the same type.
        Assert.Contains("the type of the item", Unpatched(Rules(string.Format(Loop, "    assign Tmp.Code = Src.Current.Code\n"), "Tmp: SrcRow")).Fix);
        // T23: a value reads the element it builds.
        Assert.Contains("a value reads Tmp", Unpatched(Rules(string.Format(Loop, "    assign\n      Tmp.Key = Src.Current.Code\n      Tmp.Label = Tmp.Key + \"x\"\n"))).Fix);
        // T24: the element gets a value before the loop.
        Assert.Contains("only the loop uses", Unpatched(Rules("  assign Tmp.Label = \"fixed\"\n" + string.Format(Loop, "    assign Tmp.Key = Src.Current.Code\n"))).Fix);

        static FlowProblem Unpatched(List<FlowProblem> problems)
        {
            var refused = Assert.Single(problems);
            Assert.Equal("FLOW_FOREACH_LIST_ACTION", refused.Code);
            Assert.Null(refused.Patch);
            Assert.Null(refused.Corrected);
            return refused;
        }
    }

    [Fact]
    public void AMappingSplitsAtTheCommasOfItsFieldsOnly()
    {
        // The ODC mapping text the platform prints, whose own reader splits at every comma: split as the grammar scans.
        var mapping = FlowMapping.Split("R.Response mapTo { A: A, Map.Suffix: If(S <> \"\", S, T), Price: Replace(P, \",\", \"\") }");
        Assert.NotNull(mapping);
        Assert.Equal("R.Response", mapping.Value.Source);
        Assert.Equal([("A", "A"), ("Map.Suffix", "If(S <> \"\", S, T)"), ("Price", "Replace(P, \",\", \"\")")], mapping.Value.Fields);
        Assert.Null(FlowMapping.Split("If(a, b, c)"));
        Assert.Null(FlowMapping.Split("X mapTo { A: B } + Y"));
        Assert.Null(FlowMapping.Split("X mapTo { A B }"));
    }

    [Fact]
    public void TheMappingPrefixComesOffOutsideLiterals()
    {
        Assert.Equal("Order.Code + \"Lines.List.Current.x\"", FlowEdits.WithoutPrefix("Lines.List.Current.Order.Code + \"Lines.List.Current.x\"", "Lines.List.Current."));
        Assert.Equal("Other.Lines.List.Current.A", FlowEdits.WithoutPrefix("Other.Lines.List.Current.A", "Lines.List.Current."));
    }

    [Fact]
    public void ANewNodeOnATakenNameGetsTheStudiosNameAndAKeptOneIsRefused()
    {
        var read = ReadModule();
        var call = read.Line("Customer = Customers_CS.GetCustomer(Code)");
        var diff = Diff(read, read.Document.Text.Replace(call + "\n", call + "\n  Customer = Customers_CS.GetCustomer(Code)\n"));
        Assert.Empty(diff.Problems);
        var (_, asked, given) = Assert.Single(diff.NodeNames);
        Assert.Equal(("Customer", "Customer2"), (asked, given));
        Assert.Contains(diff.Ops, o => o["op"]!.ToString() == "create" && o["name"]?.ToString() == "Customer2");
        // A node the read has, renamed onto a name another node keeps: refused with the next free name.
        var taken = Diff(read, read.Document.Text.Replace("Bump = sql", "Customer = sql"));
        var problem = Assert.Single(taken.Problems);
        Assert.Equal("FLOW_NODE_NAME_TAKEN", problem.Code);
        Assert.Contains("Customer2", problem.Fix);
    }

    [Fact]
    public void ATextWithoutKeyIsANewActionWrittenWhole()
    {
        var text = "server action Fresh\n  in A: Text\n  assign A = \"x\"\n  end\n";
        var diff = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(text));
        Assert.Empty(diff.Problems);
        var action = diff.Ops[0];
        Assert.Equal(("create", "@espace", "IServerAction", "Fresh"), (action["op"]!.ToString(), action["parent"]!.ToString(), action["type"]!.ToString(), action["name"]!.ToString()));
        foreach (var type in new[] { "IStartNode", "IAssignNode", "IEndNode", "IInputParameter" })
            Assert.Contains(diff.Ops, o => o["op"]!.ToString() == "create" && o["type"]!.ToString() == type && o["parent"]!.ToString() == action["as"]!.ToString());
        Assert.Equal(2, diff.Ops.Count(o => o["op"]!.ToString() == "link"));
        // A header naming a key the module does not have, or another kind of the read's action, is refused.
        var read = ReadModule();
        var foreign = Diff(read, read.Document.Text.Replace("server action PlaceOrder public @" + read.Action.Key, "server action PlaceOrder public @Other"));
        Assert.Contains(foreign.Problems, p => p.Code == "FLOW_KEY_FOREIGN");
        var kind = Diff(read, read.Document.Text.Replace("server action PlaceOrder", "client action PlaceOrder"));
        Assert.Contains(kind.Problems, p => p.Code == "FLOW_ACTION_KIND");
    }

    // A screen, block or data action names its owner in the header (action Home.Save, data action Home.GetOrders): the read
    // prints it, the text reads it back (the fixed point), and an owner name two screens share is written by its path.
    private static (TextRoundTripTests.Node Root, TextRoundTripTests.Node Save, TextRoundTripTests.Node Fetch) OwnedModule(bool twoHomes = false)
    {
        var root = TextRoundTripTests.N("ESpace", "Shop");
        var integer = root.Add(TextRoundTripTests.N("BasicType", "Integer"));
        var main = root.Add(TextRoundTripTests.N("MobileFlow", "MainFlow"));
        var home = main.Add(TextRoundTripTests.N("MobileScreen", "Home"));
        if (twoHomes) root.Add(TextRoundTripTests.N("MobileFlow", "Other")).Add(TextRoundTripTests.N("MobileScreen", "Home"));
        TextRoundTripTests.Node Action(string kind, string name)
        {
            var action = home.Add(TextRoundTripTests.N(kind, name));
            var start = action.Add(TextRoundTripTests.N("StartNode")); var end = action.Add(TextRoundTripTests.N("EndNode"));
            start.Set("Target", end);
            return action;
        }
        var save = Action("ScreenAction", "Save");
        save.Set("InputParameters", new List<TextRoundTripTests.Node> { save.Add(TextRoundTripTests.N("InputParameter", "Id")).Set("DataType", integer).Set("IsMandatory", true) });
        var fetch = Action("DataAction", "GetTotal");
        fetch.Set("OutputParameters", new List<TextRoundTripTests.Node> { fetch.Add(TextRoundTripTests.N("OutputParameter", "Total")).Set("DataType", integer) });
        return (root, save, fetch);
    }

    [Fact]
    public void AScreenOrDataActionHeaderNamesItsOwnerAndIsAFixedPoint()
    {
        var (root, save, fetch) = OwnedModule();
        foreach (var (action, header) in new[] { (save, "action Home.Save @"), (fetch, "data action Home.GetTotal @") }) {
            var item = ModuleFlow.Extract(root, new TextRoundTripTests.Reader(), action, out var problems);
            Assert.Empty(problems);
            Assert.Equal("Home", item.Owner);
            var document = ModuleFlow.Print(item);
            Assert.StartsWith(header + action.Key + "\n", document.Text);
            Assert.Null(ModuleFlow.Check(item, document));
            Assert.Equal("Home", ModuleFlow.Read(document.Text, document.Keys).Owner);
        }
        // Two screens named Home (two UI flows): the owner is written by its path, and still reads back the same.
        var (twice, other, _) = OwnedModule(twoHomes: true);
        var path = ModuleFlow.Extract(twice, new TextRoundTripTests.Reader(), other, out _);
        var printed = ModuleFlow.Print(path);
        Assert.StartsWith("action MainFlow/Home.Save @", printed.Text);
        Assert.Null(ModuleFlow.Check(path, printed));
        // A module action has no owner: a header that names one does not read.
        Assert.ThrowsAny<FormatException>(() => ModuleFlow.Read("server action Home.Fresh\n  end\n"));
        Assert.ThrowsAny<FormatException>(() => ModuleFlow.Read("action Ho me.Fresh\n  end\n"));
    }

    [Fact]
    public void ANewScreenBlockOrDataActionIsCreatedUnderItsOwner()
    {
        var screen = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read("action Home.Fresh\n  in Id: Integer\n  assign Total = Id\n  end\n"));
        Assert.Empty(screen.Problems);
        Assert.Equal(("create", "Home", "OutSystems.Model.UI.Mobile.IScreenAction", "Fresh"),
            (screen.Ops[0]["op"]!.ToString(), screen.Ops[0]["parent"]!.ToString(), screen.Ops[0]["type"]!.ToString(), screen.Ops[0]["name"]!.ToString()));
        Assert.Equal("Home", screen.Expected.Owner);
        // The session resolves the owner: the create goes under its key; a Traditional owner takes the Web screen action.
        var resolved = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read("action Home.Fresh\n  end\n"), owner: new FlowOwnerRef("@K9", true));
        Assert.Equal(("@K9", "OutSystems.Model.UI.Web.IScreenAction"), (resolved.Ops[0]["parent"]!.ToString(), resolved.Ops[0]["type"]!.ToString()));
        var data = FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read("data action Home.GetTotal fetch=OnDemand\n  out Total: Integer\n  assign Total = 1\n  end\n"),
            owner: new FlowOwnerRef("@K9", false));
        Assert.Empty(data.Problems);
        Assert.Equal(("@K9", "IDataAction"), (data.Ops[0]["parent"]!.ToString(), data.Ops[0]["type"]!.ToString()));
        Assert.Contains(data.Ops, o => o["op"]!.ToString() == "set" && o["prop"]?.ToString() == "Fetch" && o["value"]?.ToString() == "OnDemand");
        Assert.Contains(data.Ops, o => o["op"]!.ToString() == "create" && o["type"]!.ToString() == "IOutputParameter" && o["name"]!.ToString() == "Total");
    }

    [Fact]
    public void TheOwnerRulesRefuseOnceWithEveryProblem()
    {
        string[] Codes(string text) => FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(text)).Problems.Select(p => p.Code).ToArray();
        Assert.Equal(["FLOW_NEW_ACTION_OWNER"], Codes("action Fresh\n  end\n"));
        Assert.Equal(["FLOW_NEW_ACTION_OWNER"], Codes("data action Fresh\n  end\n"));
        Assert.Equal(["FLOW_ACTION_FLAG", "FLOW_SCREEN_ACTION_OUTPUT"], Codes("action Home.Fresh public\n  out R: Integer\n  end\n"));
        // An edit keeps the owner it was read with: leaving it out keeps it, another one is refused (a text moves nothing).
        var (root, save, _) = OwnedModule();
        var item = ModuleFlow.Extract(root, new TextRoundTripTests.Reader(), save, out _);
        var document = ModuleFlow.Print(item);
        var same = FlowDiff.Compute(item, document.Keys, ModuleFlow.Read(document.Text.Replace("action Home.Save", "action Save")), document.Text);
        Assert.Empty(same.Problems); Assert.Empty(same.Ops);
        Assert.Equal("Home", same.Expected.Owner);
        var moved = FlowDiff.Compute(item, document.Keys, ModuleFlow.Read(document.Text.Replace("action Home.Save", "action Detail.Save")), document.Text);
        Assert.Equal("FLOW_ACTION_OWNER", Assert.Single(moved.Problems).Code);
        // An output added to a screen action that exists is refused too; its inputs are free.
        var inLine = document.Text.Split('\n').Single(l => l.StartsWith("  in Id: Integer", StringComparison.Ordinal));
        var output = FlowDiff.Compute(item, document.Keys, ModuleFlow.Read(document.Text.Replace(inLine + "\n", inLine + "\n  out R: Integer\n")), document.Text);
        Assert.Equal("FLOW_SCREEN_ACTION_OUTPUT", Assert.Single(output.Problems).Code);
    }

    // The diff with the text it was parsed from: the problems whose fix is certain carry the corrected text, checked.
    private static FlowDiff DiffText(Read read, string text, Func<string, bool>? taken = null) =>
        FlowDiff.Compute(read.Item, read.Document.Keys, ModuleFlow.Read(text), read.Document.Text, FlowDiff.AliasPrefix + ".", text, taken ?? (_ => false));
    private static FlowDiff NewText(string text, Func<string, bool>? taken = null) =>
        FlowDiff.Compute(null, new Dictionary<string, string>(), ModuleFlow.Read(text), null, FlowDiff.AliasPrefix + ".", text, taken ?? (_ => false));

    [Fact]
    public void ANewForEachThatOnlyFiltersCarriesTheTextWithTheListActionAsItsCheckedPatch()
    {
        // B2 (conferência of 2026-10-12): the refusal of T1 came with patch null and the List action only as a line of text.
        var read = ReadModule();
        var loop = "  foreach Lines.List:\n    if Lines.List.Current.Order.Code = Code:\n      (System).ListAppend(Element=Lines.List.Current, List=Picked)\n      next\n    next\n";
        var text = read.Document.Text.Replace("  Bump = sql", loop + "  Bump = sql");
        var problem = Assert.Single(DiffText(read, text).Problems);
        Assert.Equal("FLOW_FOREACH_LIST_ACTION", problem.Code);
        Assert.Equal(text.Replace(loop, "  FilterPicked = (System).ListFilter(Condition=Lines.List.Current.Order.Code = Code, SourceList=Lines.List)\n"
            + "  (System).ListAppendAll(List=Picked, SourceList=FilterPicked.FilteredList)\n"), problem.Corrected);
        Assert.Empty(problem.Added!);
        // The corrected text is the one the check read: nothing refused, every element of the read kept.
        var again = DiffText(read, problem.Corrected!);
        Assert.Empty(again.Problems);
        Assert.Empty(again.Deleted);
        // Two loops filtering into the same list: two filters with their own names, both in the one corrected text.
        var two = read.Document.Text.Replace("  Bump = sql", loop + loop + "  Bump = sql");
        var both = DiffText(read, two).Problems;
        Assert.Equal(2, both.Count);
        Assert.All(both, p => Assert.Equal(both[0].Corrected, p.Corrected));
        Assert.Contains("FilterPicked2 = (System).ListFilter(", both[0].Corrected);
        Assert.Contains("SourceList=FilterPicked2.FilteredList)", both[0].Corrected);
        Assert.Empty(DiffText(read, both[0].Corrected!).Problems);
        // Without the text (the battery, a caller that only diffs): the rule as before, no corrected text.
        Assert.Null(Assert.Single(Diff(read, text).Problems).Corrected);
    }

    [Fact]
    public void ANewForEachOfAClientFlowFiltersWithTheItemsAttributesInTheLambda()
    {
        // A client ListFilter never advances Source.Current (the team rule): the condition reads the item's attributes directly.
        var text = "client action Pick\n  in Rows: Line List\n  out Picked: Line List\n  foreach Rows:\n    if Rows.Current.Qty > 1:\n"
            + "      (System).ListAppend(Element=Rows.Current, List=Picked)\n      next\n    next\n  end\n";
        var problem = Assert.Single(NewText(text).Problems);
        Assert.Equal("FilterPicked = (System).ListFilter(Condition=Qty > 1, SourceList=Rows)\n(System).ListAppendAll(List=Picked, SourceList=FilterPicked.FilteredList)", problem.Patch);
        Assert.Contains("  FilterPicked = (System).ListFilter(Condition=Qty > 1, SourceList=Rows)\n", problem.Corrected);
        // A condition that reads the item whole has no such form: no certain patch.
        var whole = NewText(text.Replace("Rows.Current.Qty > 1", "Rows.Current = Picked.Current")).Problems.Single();
        Assert.Null(whole.Corrected);
    }

    [Fact]
    public void ANewJavaScriptOutsideAnIsolatedClientActionMovesIntoItsOwnClientAction()
    {
        // B1 (decision 6): a new JavaScript node in an action that does more than run it was accepted on both lanes.
        const string script = "  Paint = javascript\n    in Value: Text = Code\n    out Done: Boolean\n    | $parameters.Done = !!document.getElementById($parameters.Value);\n";
        var text = "client action Highlight\n  in Code: Text\n  local Count: Integer\n  assign Count = Length(Code)\n" + script + "  assign Count = If(Paint.Done, 1, 0)\n  end\n";
        var problem = Assert.Single(NewText(text).Problems);
        Assert.Equal("FLOW_JAVASCRIPT_NOT_ISOLATED", problem.Code);
        Assert.Equal(text.Replace(script, "  Paint(Value=Code)\n"), problem.Corrected);
        var added = Assert.Single(problem.Added!);
        Assert.EndsWith("client action Paint\n  in Value: Text\n  out Done: Boolean\n  Paint = javascript\n    in Value: Text = Value\n    out Done: Boolean\n"
            + "    | $parameters.Done = !!document.getElementById($parameters.Value);\n  assign Done = Paint.Done\n  end\n", added);
        // The new client action is isolated and named: written as it is; the corrected caller has no JavaScript left.
        Assert.True(FlowDiff.Isolated(ModuleFlow.Read(added)));
        Assert.Empty(NewText(added).Problems);
        Assert.Empty(NewText(problem.Corrected!).Problems);
        // The module already has an action named Paint: the next free name.
        Assert.Contains("client action Paint2\n", Assert.Single(NewText(text, name => name == "Paint").Problems).Added![0]);
        // A server flow runs no JavaScript: refused, nothing to move.
        var server = Assert.Single(NewText(text.Replace("client action Highlight", "server action Highlight")).Problems);
        Assert.Equal("FLOW_JAVASCRIPT_NOT_ISOLATED", server.Code);
        Assert.Null(server.Corrected);
        // A client action with a default name is not a named one.
        Assert.False(FlowDiff.Isolated(ModuleFlow.Read(added.Replace("client action Paint", "client action ClientAction1"))));
    }

    [Fact]
    public void AJavaScriptNodeOfTheReadStaysEditable()
    {
        // Existing JavaScript (364 nodes in the corpus) is read whole and editable: only a new node is judged.
        var read = ReadModule();
        var text = read.Document.Text.Replace("    | $parameters.B = $parameters.A;\n", "    | $parameters.B = $parameters.A + \"!\";\n");
        Assert.NotEqual(read.Document.Text, text);
        Assert.Empty(DiffText(read, text).Problems);
        // A new one beside it, in this server action: refused, with nothing to move (a server flow runs no JavaScript).
        var script = read.Line("Script = javascript");
        var added = DiffText(read, read.Document.Text.Replace(script + "\n", "  Other = javascript\n    | console.log(1);\n" + script + "\n"));
        var problem = Assert.Single(added.Problems);
        Assert.Equal("FLOW_JAVASCRIPT_NOT_ISOLATED", problem.Code);
        Assert.Null(problem.Corrected);
    }

    [Fact]
    public void AnAggregateANewLoopRunsPerItemIsReadOnceBeforeItWithAListFilterInside()
    {
        // B2/T3: QUERY_IN_LOOP came with no patch. In a server flow (ListFilter reads Source.Current there) the fix is certain.
        var read = ReadModule();
        var loop = "  foreach Lines.List:\n    GetOrder = aggregate FROM Order WHERE (Order.Code = \"A\") AND (Order.Id = Lines.List.Current.Order.Id) MAX 1\n"
            + "    assign Total = Total + GetOrder.List.Current.Order.Id\n    next\n";
        var text = read.Document.Text.Replace("  Bump = sql", loop + "  Bump = sql");
        var problem = Assert.Single(DiffText(read, text).Problems);
        Assert.Equal("QUERY_IN_LOOP", problem.Code);
        Assert.Equal("GetOrder", problem.Fields!["query"]!.ToString());
        Assert.Equal(text.Replace(loop, "  GetOrder = aggregate FROM Order WHERE (Order.Code = \"A\")\n  foreach Lines.List:\n"
            + "    FilterGetOrder = (System).ListFilter(Condition=GetOrder.List.Current.Order.Id = Lines.List.Current.Order.Id, SourceList=GetOrder.List)\n"
            + "    assign Total = Total + FilterGetOrder.FilteredList.Current.Order.Id\n    next\n"), problem.Corrected);
        Assert.Empty(DiffText(read, problem.Corrected!).Problems);
        // Named after the loop (the read before it would have every row): not certain, left to the candidate's QUERY_IN_LOOP.
        var after = text.Replace("  Bump = sql", "  assign Total = GetOrder.Count\n  Bump = sql");
        Assert.Empty(DiffText(read, after).Problems);
        // The escape on the op: not judged here.
        Assert.Empty(FlowDiff.Compute(read.Item, read.Document.Keys, ModuleFlow.Read(text), read.Document.Text, FlowDiff.AliasPrefix + ".", text, _ => false, allowQueryInLoop: true).Problems);
    }

    [Fact]
    public void TheBatteryEditsAreTheSameForTheSameSeedAndKeepWhatTheyDoNotTouch()
    {
        var read = ReadModule();
        foreach (var kind in FlowEdits.Kinds) {
            var first = FlowEdits.Make(read.Item, kind, 7); var again = FlowEdits.Make(read.Item, kind, 7);
            if (first == null) { Assert.Null(again); continue; }
            Assert.Equal(first.Model.Canon(), again!.Model.Canon());
            // The edit read back through the diff: every element it did not touch keeps its key and nothing is refused.
            var keyToId = read.Document.Keys.ToDictionary(p => p.Value, p => p.Key);
            var diff = Diff(read, ModuleFlow.Print(first.Model, keyToId).Text);
            Assert.True(diff.Problems.Count == 0, kind + ": " + string.Join(" | ", diff.Problems.Select(p => p.Message)));
            var kept = read.Item.Items.Where(i => i.Role == "node").Select(i => i.Key).Where(k => !diff.Deleted.Contains(k));
            Assert.All(kept, key => Assert.Contains(diff.Expected.Items, i => i.Key == key));
        }
    }

    // A parameter of a SQL or JavaScript node renamed by the text (its code naming the new name) is the rename verb: the node's
    // argument stays bound under the new name, never written empty under the old one (an argument the node no longer has: the
    // apply failed with KeyNotFoundException).
    [Fact]
    public void ANodeParameterRenamedByTheTextKeepsItsArgument()
    {
        var read = ReadModule();
        Assert.Contains("    in P: ", read.Document.Text);
        Assert.Contains("    | \tSET [Code] = @P\n", read.Document.Text);
        var sql = Diff(read, read.Document.Text.Replace("    in P: ", "    in Price: ").Replace("    | \tSET [Code] = @P\n", "    | \tSET [Code] = @Price\n"));
        Assert.Empty(sql.Problems);
        var parameter = read.Of("SQLNode").Children.Single(c => c.Kind == "SQLInputParameter" && c.Name == "P");
        Assert.True(Has(sql, "rename", "target", "@" + parameter.Key), Ops(sql));
        Assert.DoesNotContain(sql.Ops, o => o["target"]?.ToString().Contains("/arg:", StringComparison.Ordinal) == true);
        Assert.Contains(sql.Renamed, r => r.From == "P" && r.To == "Price");
        Assert.Contains("    in A: ", read.Document.Text);
        var js = Diff(read, read.Document.Text.Replace("    in A: ", "    in Given: ").Replace("$parameters.B = $parameters.A;", "$parameters.B = $parameters.Given;"));
        Assert.Empty(js.Problems);
        Assert.DoesNotContain(js.Ops, o => o["target"]?.ToString().Contains("/arg:", StringComparison.Ordinal) == true);
        Assert.Contains(js.Renamed, r => r.From == "A" && r.To == "Given");
        // A changed value under the new name is one write of that argument, by its new name.
        var changed = Diff(read, read.Document.Text.Replace("    in P: ", "    in Price: ").Replace("    | \tSET [Code] = @P\n", "    | \tSET [Code] = @Price\n").Replace("= \"x\"", "= \"y\""));
        Assert.Empty(changed.Problems);
        var argument = Assert.Single(changed.Ops, o => o["target"]?.ToString().Contains("/arg:", StringComparison.Ordinal) == true);
        Assert.EndsWith("/arg:Price", argument["target"]!.ToString());
        Assert.Equal("\"y\"", argument["value"]!.ToString());
    }

    // The battery kinds asked by name for the corrections of the third junction: noderename (an input of a SQL or JavaScript
    // node renamed with the code that names it) and mapedit (a field value of a mapping the action has, in parentheses). Both
    // are texts the way back writes as the rename verb and one Value, with nothing refused.
    [Fact]
    public void TheBatteryKindsByNameRenameANodeParameterAndEditAMapping()
    {
        var read = ReadModule((_, action) => action.Children.Where(c => c.Kind == "AssignNode").ElementAt(1).Children.Where(c => c.Kind == "Assignment").ElementAt(1)
            .Set("Value", new TextRoundTripTests.Code("Customer mapTo { Total: Amount }")));
        var ids = read.Document.Keys.ToDictionary(p => p.Value, p => p.Key, StringComparer.Ordinal);
        var renamed = new HashSet<string>(StringComparer.Ordinal);
        for (var seed = 1; seed <= 8; seed++) {
            var edit = FlowEdits.Make(read.Item, "noderename", seed);
            Assert.NotNull(edit);
            var diff = Diff(read, ModuleFlow.Print(edit!.Model, ids).Text);
            Assert.Empty(diff.Problems);
            var rename = Assert.Single(diff.Ops, o => o["op"]!.ToString() == "rename");
            renamed.Add(rename["target"]!.ToString());
            Assert.DoesNotContain(diff.Ops, o => o["target"]?.ToString().Contains("/arg:", StringComparison.Ordinal) == true);
        }
        Assert.True(renamed.Count >= 2, string.Join(", ", renamed));
        var map = FlowEdits.Make(read.Item, "mapedit", 1);
        Assert.NotNull(map);
        var mapped = Diff(read, ModuleFlow.Print(map!.Model, ids).Text);
        Assert.Empty(mapped.Problems);
        var value = Assert.Single(mapped.Ops);
        Assert.Equal("Customer mapTo { Total: (Amount) }", value["value"]!.ToString());
    }

    // ---- corrections of the third junction (Corrigir 2) -------------------------------------------------------------------

    // Two loops of one text, each patched into ListAppendAll: a call without a name is named after its action and a node name is
    // unique, so the second is named as the Studio names a copy in the patch itself, and the corrected text reads back as written
    // (the creation battery: DCIPS_Staff_Reports' second ListAppendAll read as ListAppendAll2). A loop with a limit (max) or a
    // first item (start) takes part of the list: no certain patch (a List action takes every item).
    [Fact]
    public void TwoLoopsArePatchedWithANameEachAndALoopWithALimitHasNoPatch()
    {
        var text = "server action TwoLoops\n  in A: Line List\n  in B: Line List\n  out X: Line List\n  out Y: Line List\n"
            + "  foreach A:\n    (System).ListAppend(Element=A.Current, List=X)\n    next\n"
            + "  foreach B:\n    (System).ListAppend(Element=B.Current, List=Y)\n    next\n  end\n";
        var problems = NewText(text).Problems;
        Assert.Equal(2, problems.Count);
        Assert.All(problems, p => Assert.Equal("FLOW_FOREACH_LIST_ACTION", p.Code));
        Assert.Equal("(System).ListAppendAll(List=X, SourceList=A)", problems[0].Patch);
        Assert.Equal("ListAppendAll2 = (System).ListAppendAll(List=Y, SourceList=B)", problems[1].Patch);
        var corrected = problems[0].Corrected!;
        Assert.Contains("  (System).ListAppendAll(List=X, SourceList=A)\n  ListAppendAll2 = (System).ListAppendAll(List=Y, SourceList=B)\n", corrected);
        var again = NewText(corrected);
        Assert.Empty(again.Problems);
        Assert.Empty(again.NodeNames);
        // A ListAppendAll the action already has: the patch takes the next name.
        var had = text.Replace("  foreach B:", "  (System).ListAppendAll(List=Y, SourceList=A)\n  foreach B:");
        var next = NewText(had).Problems;
        Assert.Contains(next, p => p.Patch == "ListAppendAll2 = (System).ListAppendAll(List=X, SourceList=A)");
        Assert.Contains(next, p => p.Patch == "ListAppendAll3 = (System).ListAppendAll(List=Y, SourceList=B)");
        foreach (var limit in new[] { " max 8", " start 2" }) {
            var limited = NewText(text.Replace("  foreach A:", "  foreach A" + limit + ":")).Problems;
            var first = Assert.Single(limited, p => p.Message.Contains(" over A ", StringComparison.Ordinal));
            Assert.Equal("FLOW_FOREACH_LIST_ACTION", first.Code);
            Assert.Null(first.Patch);
            Assert.Contains(limit.Trim().Split(' ')[0] == "max" ? "(max)" : "(start)", first.Fix);
            // The other loop is still patched, alone.
            Assert.Equal("(System).ListAppendAll(List=Y, SourceList=B)", Assert.Single(limited, p => p != first).Patch);
        }
    }

    // An alias of a source written new or renamed onto the name of an element of the action that the read's expressions of that
    // aggregate name (the input Code in `Order.Code = Code`): inside the aggregate the aliases come first, so that Code would read
    // the source. Refused with a free name (review r2, e3).
    [Fact]
    public void AnAliasOnTheNameOfAnElementTheAggregateReadsIsRefused()
    {
        var read = ReadModule();
        var captured = Diff(read, System.Text.RegularExpressions.Regex.Replace(read.Document.Text, @"\bL\b", "Code"));
        var problem = Assert.Single(captured.Problems);
        Assert.Equal("FLOW_RENAME_CAPTURED", problem.Code);
        Assert.Contains("alias Code", problem.Message);
        Assert.Contains("Code2", problem.Fix);
        Assert.Empty(captured.Ops);
        // A free alias is a rename of the source.
        var free = Diff(read, System.Text.RegularExpressions.Regex.Replace(read.Document.Text, @"\bL\b", "Ln"));
        Assert.Empty(free.Problems);
        Assert.Contains(free.Ops, o => o["prop"]?.ToString() == "Name" && o["value"]?.ToString() == "Ln");
    }

    // O11 reads no record literal in an expression: a text that writes one (an argument too) is refused in the plan with the fix,
    // instead of being kept as text that reads back exact and only the Verify refuses (review r2, o-l1). ODC takes it as an
    // argument (and refuses it as an assignment's value, FLOW_VALUE_RECORD_LITERAL).
    [Fact]
    public void ARecordLiteralIsRefusedInTheO11PlanAndTakenAsAnODCArgument()
    {
        var text = "server action LitB\n  local L: Line List\n  (System).ListAppend(List=L, Element={ Key: \"k\", Total: 2, Label: \"c\" })\n  end\n";
        var problems = NewText(text).Problems;
        if (Anvil.Core.MessageExpectations.Lane == "odc") { Assert.Empty(problems); return; }
        var problem = Assert.Single(problems);
        Assert.Equal("FLOW_VALUE_RECORD_LITERAL", problem.Code);
        Assert.Contains("O11 reads no record literal", problem.Message);
        Assert.Contains("<Local>.Key = \"k\"", problem.Fix);
    }

    // Parameters whose names trade places, or one removed and another renamed onto its name, are written through a free name:
    // no rename ever takes a name another local still has (the verb refuses that clash: review r2, k2/k3). Every expression is
    // read with all the renames at once.
    [Fact]
    public void NamesThatTradePlacesAreRenamedThroughAFreeName()
    {
        TextRoundTripTests.Node? alpha = null, beta = null;
        var read = ReadModule((root, action) => {
            var integer = root.Children.Single(c => c.Name == "Integer");
            alpha = action.Add(TextRoundTripTests.N("LocalVariable", "Alpha")).Set("DataType", integer);
            beta = action.Add(TextRoundTripTests.N("LocalVariable", "Beta")).Set("DataType", integer);
            action.Set("LocalVariables", new List<TextRoundTripTests.Node>((List<TextRoundTripTests.Node>)action.Props["LocalVariables"]!) { alpha, beta });
            action.Children.Where(c => c.Kind == "AssignNode").First().Children.Single(c => c.Kind == "Assignment").Set("Value", new TextRoundTripTests.Code("Alpha - Beta"));
        });
        var alphaLine = read.Line("local Alpha:"); var betaLine = read.Line("local Beta:");
        Assert.Contains("assign Total = Alpha - Beta ", read.Document.Text);
        // Swapped: Alpha is Beta and Beta is Alpha, the expression as the renames make it (no value written).
        var swapped = read.Document.Text.Replace(alphaLine, "\u0001").Replace(betaLine, betaLine.Replace("local Beta:", "local Alpha:")).Replace("\u0001", alphaLine.Replace("local Alpha:", "local Beta:"))
            .Replace("assign Total = Alpha - Beta ", "assign Total = Beta - Alpha ");
        var swap = Diff(read, swapped);
        Assert.Empty(swap.Problems);
        Clashless(read, swap);
        Assert.Contains(swap.Renamed, r => r.From == "Alpha" && r.To == "Beta");
        Assert.Contains(swap.Renamed, r => r.From == "Beta" && r.To == "Alpha");
        Assert.DoesNotContain(swap.Ops, o => o["op"]!.ToString() == "set" && o["prop"]?.ToString() == "Value");
        // Alpha removed and Beta renamed Alpha: the removed one goes out of the way first, and is deleted at the end.
        var replaced = read.Document.Text.Replace(alphaLine + "\n", "").Replace(betaLine, betaLine.Replace("local Beta:", "local Alpha:"))
            .Replace("assign Total = Alpha - Beta ", "assign Total = Alpha * 2 ");
        var diff = Diff(read, replaced);
        Assert.Empty(diff.Problems);
        Clashless(read, diff);
        Assert.Contains(diff.Ops, o => o["op"]!.ToString() == "delete" && o["target"]!.ToString() == "@" + alpha!.Key);
        Assert.Contains(diff.Ops, o => o["op"]!.ToString() == "set" && o["value"]?.ToString() == "Alpha * 2");

        // Simulated on the names of the locals: no rename takes a name another one has at that moment.
        static void Clashless(Read read, FlowDiff diff)
        {
            var names = read.Item.Items.Where(i => i.Role is "in" or "out" or "local").ToDictionary(i => "@" + i.Key, i => i.Name, StringComparer.Ordinal);
            foreach (var op in diff.Ops.Where(o => o["op"]!.ToString() == "rename" && names.ContainsKey(o["target"]!.ToString()))) {
                var target = op["target"]!.ToString(); var name = op["name"]!.ToString();
                Assert.False(names.Any(n => n.Key != target && string.Equals(n.Value, name, StringComparison.OrdinalIgnoreCase)), "rename " + target + " to " + name + " clashes: " + Ops(diff));
                names[target] = name;
            }
        }
    }

    // A mapping (or, on ODC, a record literal) the text writes, into a record whose mandatory attributes it leaves empty, is refused
    // in the plan (the Verify refused it with two errors and no code): with the patch when each value is certain (an identifier:
    // NullIdentifier()), else in words (review r2, d-p8/d-p9/d-l4). The 24.1 fixes: O11 too (it refused only when it wrote the
    // mapping, with no patch), and the argument of a call to another action, typed by that action's input.
    [Fact]
    public void AMappingThatLeavesAMandatoryAttributeEmptyIsRefusedInThePlanOfBothLanes()
    {
        var types = new Types(attributes: new() { ["MapOrder"] = ["Id", "Title", "Qty"], ["MandRow"] = ["Code", "Must"] },
            mandatory: new() { ["MapOrder"] = [("Id", "NullIdentifier()")], ["MandRow"] = [("Must", null)] }, inputs: new() { ["SaveOrder.Order"] = "MapOrder" });
        var mapped = "server action MandA\n  in SrcOne: SrcRow\n  local Rec: MapOrder\n  assign Rec = SrcOne mapTo { Title: Code, Qty: 1 }\n  end\n";
        var literal = "server action MandL\n  local Rows: MandRow List\n  (System).ListAppend(List=Rows, Element={ Code: \"a\" })\n  end\n";
        var odc = Anvil.Core.MessageExpectations.Lane == "odc";
        var first = NewText(mapped, types).Problems;
        var second = NewText(literal, types).Problems;
        // The argument of a call: the input of the action called says the record (SaveOrder's Order is a MapOrder).
        var argument = "server action MandC\n  in SrcOne: SrcRow\n  SaveOrder(Order=SrcOne mapTo { Title: Code, Qty: 1 })\n  end\n";
        var call = Assert.Single(NewText(argument, types).Problems);
        Assert.Equal("FLOW_MAPPING_TYPES", call.Code);
        Assert.Equal("SrcOne mapTo { Id: NullIdentifier(), Title: Code, Qty: 1 }", call.Patch);
        Assert.Empty(NewText(call.Corrected!, types).Problems);
        // An action the module does not type is not judged here (the Verify says it).
        Assert.Empty(NewText(argument.Replace("SaveOrder(", "OtherAction("), types).Problems);
        var problem = Assert.Single(first);
        Assert.Equal("FLOW_MAPPING_TYPES", problem.Code);
        Assert.Contains("Id", problem.Message);
        Assert.Equal("SrcOne mapTo { Id: NullIdentifier(), Title: Code, Qty: 1 }", problem.Patch);
        Assert.Contains("  assign Rec = SrcOne mapTo { Id: NullIdentifier(), Title: Code, Qty: 1 }\n", problem.Corrected);
        Assert.Empty(NewText(problem.Corrected!, types).Problems);
        if (!odc) {
            // O11 reads no record literal: that one is FLOW_VALUE_RECORD_LITERAL, never judged for its attributes.
            Assert.Equal("FLOW_VALUE_RECORD_LITERAL", Assert.Single(second).Code);
            Assert.Empty(NewText(mapped.Replace("{ Title: Code", "{ Id: NullIdentifier(), Title: Code"), types).Problems);
            return;
        }
        var must = Assert.Single(second);
        Assert.Equal("FLOW_MAPPING_TYPES", must.Code);
        Assert.Contains("Must", must.Message);
        Assert.Null(must.Patch);
        Assert.Null(must.Corrected);
        // Every mandatory attribute named: nothing to say.
        Assert.Empty(NewText(mapped.Replace("{ Title: Code", "{ Id: NullIdentifier(), Title: Code"), types).Problems);
    }
}
