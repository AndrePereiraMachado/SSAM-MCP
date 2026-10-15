using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;
using Xunit;
using Node = Anvil.Tests.TextRoundTripTests.Node;

namespace Anvil.Tests;

// Linked into both test projects: the three-way merge of the logic text (FlowMerge). An edit written on an older read of an
// action (base: that read, kept by the store) is merged with the action as the Studio left it (theirs) by model key: what
// only one side changed stays, a change of the same element on both sides keeps the delivery's version and is listed, an
// element the Studio added is never deleted because the edit does not have it, an element the edit removed that the Studio
// changed is removed and listed, an element the Studio removed that the edit changed is written again with a new id and
// listed, renames are read in the final names, and steps both sides inserted after the same node are both kept. The merged
// text is in the ids of the current read: the way back (FlowDiff) then writes only what the edit changed. The synthetic module
// is TextRoundTripTests'; the corpus battery (MergeBatteryCorpus) proves the same through the model on real modules.
public sealed class FlowMergeTests
{
    private static int fresh;
    private static Node N(string kind, string name = "") => new("Z" + (++fresh).ToString("D4"), kind, name);

    private sealed record Side(FlowItem Item, FlowDocument Document)
    {
        public string Text => Document.Text;
        public string Line(string contains) => Text.Split('\n').Single(l => l.Contains(contains, StringComparison.Ordinal));
        public string Id(string key) => Document.Keys.First(p => p.Value == key).Key;
    }

    private static Side Read(Node root, Node action)
    {
        var item = ModuleFlow.Extract(root, new TextRoundTripTests.Reader(), action, out var problems);
        Assert.Empty(problems);
        return new(item, ModuleFlow.Print(item));
    }

    private static FlowReading Reading(Side read) => new("o11", "", read.Item.Key, read.Item.Kind, read.Item.Name, read.Text, read.Document.Keys);

    // The read, then the Studio's change on the module, then the action as it is now.
    private static (Side Base, Side Now, Node Root, Node Action) Module(Action<Node, Node> studio)
    {
        var (root, action) = TextRoundTripTests.Module();
        var @base = Read(root, action);
        studio(root, action);
        return (@base, Read(root, action), root, action);
    }

    private static Node Child(Node action, string kind, int nth = 0) => action.Children.Where(c => c.Kind == kind).ElementAt(nth);
    private static TextRoundTripTests.Code Code(string text) => new(text);

    private static FlowMerge.Result Merge(Side @base, Side now, string edited)
    {
        var merged = FlowMerge.ThreeWay(Reading(@base), now.Item, now.Document, edited);
        Assert.True(merged.Failure == null, merged.Failure);
        return merged;
    }

    // The merged text is read by the way back against the action now: it parses, and only what the edit changed is written.
    private static FlowDiff Back(Side now, string merged) => FlowDiff.Compute(now.Item, now.Document.Keys, ModuleFlow.Read(merged), now.Text);

    [Fact]
    public void WhatEachSideChangedStaysAndNothingIsListed()
    {
        var (@base, now, _, _) = Module((root, action) => {
            // The Studio: another value in the first assign, and a new step after the message.
            Child(Child(action, "AssignNode"), "Assignment").Set("Value", Code("Total + 5"));
            var message = Child(action, "MessageNode"); var refresh = Child(action, "RefreshDataNode");
            var added = action.Add(N("AssignNode"));
            added.Add(N("Assignment")).Set("Variable", Code("OrderId")).Set("Value", Code("0"));
            message.Set("Target", added); added.Set("Target", refresh);
        });
        // The model, on the read: the raise message and the If's label.
        Assert.Contains("\"empty\"", @base.Text); Assert.Contains("# Empty?", @base.Text);
        var edited = @base.Text.Replace("\"empty\"", "\"none\"").Replace("# Empty?", "# Nothing?");
        var merged = Merge(@base, now, edited);
        Assert.Empty(merged.Problems);
        Assert.Empty(merged.Conflicts);
        Assert.True(merged.Kept >= 2);
        // The action now with the model's two changes, in the ids of the current read.
        Assert.Equal(now.Text.Replace("\"empty\"", "\"none\"").Replace("# Empty?", "# Nothing?"), merged.Text);
        var diff = Back(now, merged.Text!);
        Assert.Empty(diff.Problems);
        Assert.Equal(2, diff.Ops.Count);
        Assert.All(diff.Ops, o => Assert.Equal("set", o["op"]!.ToString()));
    }

    [Fact]
    public void TheSameValueChangedOnBothSidesKeepsTheDeliverysAndIsListed()
    {
        var (@base, now, _, action) = Module((_, action) => Child(Child(action, "AssignNode"), "Assignment").Set("Value", Code("Total + 5")));
        var merged = Merge(@base, now, @base.Text.Replace("assign Total = Total + 1 ", "assign Total = Total + 7 "));
        Assert.Equal(now.Text.Replace("assign Total = Total + 5 ", "assign Total = Total + 7 "), merged.Text);
        var conflict = Assert.Single(merged.Conflicts);
        Assert.Equal(Child(action, "AssignNode").Key, conflict["key"]!.ToString());
        Assert.Equal(now.Id(Child(action, "AssignNode").Key), conflict["id"]!.ToString());
        Assert.Equal("assignment Total Value", conflict["what"]!.ToString());
        Assert.Contains("Total + 5", conflict["studio"]!.ToString());
        Assert.Contains("Total + 7", conflict["delivered"]!.ToString());
        Assert.Equal("delivery", conflict["kept"]!.ToString());
    }

    [Fact]
    public void AnElementTheStudioAddedIsNeverDeletedBecauseTheEditDoesNotHaveIt()
    {
        var (@base, now, _, _) = Module((root, action) => {
            // A local and a step that uses it, added after the read.
            var integer = root.Children.Single(c => c.Name == "Integer");
            var extra = action.Add(N("LocalVariable", "Extra")).Set("DataType", integer);
            var locals = (List<Node>)action.Props["LocalVariables"]!;
            action.Set("LocalVariables", new List<Node>(locals) { extra });
            var trigger = Child(action, "TriggerNode"); var refresh = Child(action, "RefreshDataNode");
            var added = action.Add(N("AssignNode"));
            added.Add(N("Assignment")).Set("Variable", Code("Extra")).Set("Value", Code("Total"));
            refresh.Set("Target", added); added.Set("Target", trigger);
        });
        // The edit, written on the read, has neither; it only changes the SQL's maximum.
        var edited = @base.Text.Replace("Bump = sql -> Order max 1", "Bump = sql -> Order max 2");
        Assert.NotEqual(@base.Text, edited);
        var merged = Merge(@base, now, edited);
        Assert.Empty(merged.Conflicts);
        Assert.Contains("local Extra: Integer", merged.Text);
        Assert.Contains("assign Extra = Total", merged.Text);
        Assert.Equal(now.Text.Replace("Bump = sql -> Order max 1", "Bump = sql -> Order max 2"), merged.Text);
        var diff = Back(now, merged.Text!);
        Assert.DoesNotContain(diff.Ops, o => o["op"]!.ToString() == "delete");
    }

    [Fact]
    public void ANodeTheEditRemovedThatTheStudioChangedIsRemovedAndListed()
    {
        var (@base, now, _, action) = Module((_, action) => Child(action, "MessageNode").Set("Message", Code("\"changed\"")));
        var message = Child(action, "MessageNode");
        var edited = @base.Text.Replace(@base.Line("message Info:") + "\n", "");
        var merged = Merge(@base, now, edited);
        Assert.DoesNotContain("message Info:", merged.Text);
        var conflict = Assert.Single(merged.Conflicts);
        Assert.Equal(message.Key, conflict["key"]!.ToString());
        Assert.Equal("removed by the delivery", conflict["what"]!.ToString());
        Assert.Contains("\"changed\"", conflict["studio"]!.ToString());
        Assert.Equal(now.Text.Replace(now.Line("message Info:") + "\n", ""), merged.Text);
        var diff = Back(now, merged.Text!);
        Assert.Equal([message.Key], diff.Deleted);
    }

    [Fact]
    public void ANodeTheStudioRemovedThatTheEditChangedIsWrittenAgainWithANewId()
    {
        var (@base, now, _, action) = Module((_, action) => {
            var parse = Child(action, "JSONDeserializeNode"); var message = Child(action, "MessageNode");
            parse.Set("Target", Child(action, "RefreshDataNode"));
            action.Children.Remove(message);
        });
        var line = @base.Line("message Info:");
        var edited = @base.Text.Replace(line, line.Replace("# Tell", "# Say"));
        Assert.NotEqual(@base.Text, edited);
        var merged = Merge(@base, now, edited);
        var conflict = Assert.Single(merged.Conflicts);
        Assert.Equal("removed in the Studio", conflict["what"]!.ToString());
        // Back between the deserialize and the refresh, with an id of its own (its key is gone).
        var lines = merged.Text!.Split('\n').ToList();
        var at = lines.FindIndex(l => l.Contains("message Info:", StringComparison.Ordinal));
        Assert.True(at > 0, merged.Text);
        Assert.EndsWith(" @+m1", lines[at]);
        Assert.Contains("Parsed = JSONDeserialize", lines[at - 1]);
        Assert.Contains("refresh GetLines", lines[at + 1]);
        var diff = Back(now, merged.Text!);
        Assert.Empty(diff.Problems);
        Assert.Single(diff.Created);
    }

    [Fact]
    public void StepsBothSidesInsertedAfterTheSameNodeAreBothKeptTheDeliverysFirst()
    {
        var (@base, now, _, action) = Module((_, action) => {
            var refresh = Child(action, "RefreshDataNode"); var trigger = Child(action, "TriggerNode");
            var added = action.Add(N("AssignNode"));
            added.Add(N("Assignment")).Set("Variable", Code("Total")).Set("Value", Code("1"));
            refresh.Set("Target", added); added.Set("Target", trigger);
        });
        var refreshLine = @base.Line("refresh GetLines");
        var edited = @base.Text.Replace(refreshLine + "\n", refreshLine + "\n  assign Total = 2\n");
        var merged = Merge(@base, now, edited);
        var conflict = Assert.Single(merged.Conflicts);
        Assert.Equal("both", conflict["kept"]!.ToString());
        Assert.Equal(Child(action, "RefreshDataNode").Key, conflict["key"]!.ToString());
        var lines = merged.Text!.Split('\n').ToList();
        var at = lines.FindIndex(l => l.Contains("refresh GetLines", StringComparison.Ordinal));
        Assert.StartsWith("  assign Total = 2 @+", lines[at + 1]);
        Assert.StartsWith("  assign Total = 1 @n", lines[at + 2]);
        Assert.Contains("trigger Changed", lines[at + 3]);
        var diff = Back(now, merged.Text!);
        Assert.Empty(diff.Problems);
        Assert.Single(diff.Created);
        Assert.Empty(diff.Deleted);
    }

    [Fact]
    public void ARenameOnOneSideIsReadInTheFinalNamesOnTheOther()
    {
        var (@base, now, _, action) = Module((_, action) => {
            // The Studio renames the input Code, and the Studio's rename rewrites every expression that names it.
            Child(action, "InputParameter").Name = "CustomerCode";
            void Rewrite(Node node)
            {
                foreach (var (name, value) in node.Props.ToList())
                    if (value is TextRoundTripTests.Code code) node.Props[name] = Code(FlowEdits.Renamed(code.Text, "Code", "CustomerCode"));
                foreach (var child in node.Children) Rewrite(child);
            }
            Rewrite(action);
            // ...and writes a new expression with the local Total.
            Child(action, "MessageNode").Set("Message", Code("Total"));
        });
        // The model, on the read: the If's condition (with Code), and the local Total renamed Sum everywhere it is named.
        var edited = Regex.Replace(@base.Text.Replace("if Code = \"a:b\":", "if Code = \"b:c\":"), @"\bTotal\b", "Sum");
        Assert.Contains("if Code = \"b:c\":", edited);
        var merged = Merge(@base, now, edited);
        Assert.Empty(merged.Conflicts);
        Assert.Contains("if CustomerCode = \"b:c\":", merged.Text);
        Assert.Contains("in CustomerCode", merged.Text);
        Assert.Contains("local Sum:", merged.Text);
        // The Studio's new expression names the local by its final name.
        Assert.Contains("message Info: Sum", merged.Text);
        Assert.DoesNotMatch(@"\bTotal\b", merged.Text!);
        var diff = Back(now, merged.Text!);
        Assert.Empty(diff.Problems);
        Assert.Contains(diff.Renamed, r => r.From == "Total" && r.To == "Sum");
    }

    [Fact]
    public void AnIdTheReadNeverGaveIsRefusedAgainstThatRead()
    {
        var (@base, now, _, _) = Module((_, action) => Child(Child(action, "AssignNode"), "Assignment").Set("Value", Code("Total + 5")));
        var merged = FlowMerge.ThreeWay(Reading(@base), now.Item, now.Document, @base.Text.Replace("  Bump = sql", "  assign OrderId = 1 @n99\n  Bump = sql"));
        Assert.Null(merged.Text);
        Assert.Contains(merged.Problems, p => p.Code == "FLOW_KEY_FOREIGN" && p.Id == "n99");
        // A header of another action is refused too.
        var other = FlowMerge.ThreeWay(Reading(@base) with { ActionKey = "Other" }, now.Item, now.Document, @base.Text);
        Assert.Contains(other.Problems, p => p.Code == "FLOW_KEY_FOREIGN");
    }

    [Fact]
    public void TheEditAsReadMergesIntoTheActionNowUnchanged()
    {
        var (@base, now, _, _) = Module((_, action) => Child(Child(action, "AssignNode"), "Assignment").Set("Value", Code("Total + 5")));
        var merged = Merge(@base, now, @base.Text);
        Assert.Empty(merged.Conflicts);
        Assert.Equal(now.Text, merged.Text);
        Assert.Empty(Back(now, merged.Text!).Ops);
    }

    [Fact]
    public void TheStoreKeepsAReadByItsTextShaAndRefusesAnotherText()
    {
        var folder = Path.Combine(Path.GetTempPath(), "flow-reading-" + Guid.NewGuid().ToString("N"));
        try {
            var store = new ModuleIndexStore(folder, "o11", "kernel");
            var (root, action) = TextRoundTripTests.Module();
            var item = ModuleFlow.Extract(root, new TextRoundTripTests.Reader(), action, out _);
            var entry = ModuleFlow.Entry(item, item.Name, [], 0);
            var sha256 = new string('a', 64);
            var file = store.SaveFlowReading(FlowReading.Of(entry, "o11", sha256));
            Assert.Equal(store.FlowReadingPathOf(sha256, entry.TextSha), file);
            var loaded = store.LoadFlowReading(entry.TextSha);
            Assert.NotNull(loaded);
            Assert.Equal(entry.Text, loaded!.Text);
            Assert.Equal(entry.Key, loaded.ActionKey);
            Assert.Equal(entry.Ids.OrderBy(p => p.Key), loaded.Ids.OrderBy(p => p.Key));
            Assert.Null(store.LoadFlowReading("0000000000000000"));
            Assert.Null(store.LoadFlowReading("../../x"));
            // Another lane's store, a file whose text is not its textSha, or of another extractor: not a read.
            Assert.Null(new ModuleIndexStore(folder, "odc", "kernel").LoadFlowReading(entry.TextSha));
            var json = JsonNode.Parse(File.ReadAllText(file))!.AsObject();
            json["text"] = entry.Text + "  end\n";
            File.WriteAllText(file, json.ToJsonString());
            Assert.Null(store.LoadFlowReading(entry.TextSha));
            json["text"] = entry.Text; json["extractor"] = ModuleFlow.Extractor - 1;
            File.WriteAllText(file, json.ToJsonString());
            Assert.Null(store.LoadFlowReading(entry.TextSha));
        } finally { if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true); }
    }

    // The owner a screen, block or data action header names (action Home.Save) is not edited by text: the merge writes the
    // action's owner now (the screen renamed in the Studio since the read), whether the delivery wrote the read's owner, its
    // path or none; another owner is a move, left to the way back, which refuses it (FLOW_ACTION_OWNER) as for a current read.
    [Fact]
    public void TheOwnerIsTheActionsOwnerNowAndAMoveIsLeftToTheWayBack()
    {
        var root = TextRoundTripTests.N("ESpace", "Shop");
        var flow = root.Add(TextRoundTripTests.N("MobileFlow", "MainFlow"));
        var home = flow.Add(TextRoundTripTests.N("MobileScreen", "Home"));
        flow.Add(TextRoundTripTests.N("MobileScreen", "Detail"));
        var save = home.Add(TextRoundTripTests.N("ScreenAction", "Save"));
        var start = save.Add(TextRoundTripTests.N("StartNode")); var assign = save.Add(TextRoundTripTests.N("AssignNode")); var end = save.Add(TextRoundTripTests.N("EndNode"));
        assign.Add(TextRoundTripTests.N("Assignment")).Set("Variable", Code("Total")).Set("Value", Code("1"));
        start.Set("Target", assign); assign.Set("Target", end);
        var @base = Read(root, save);
        Assert.StartsWith("action Home.Save @", @base.Text);
        home.Name = "Dashboard";
        var now = Read(root, save);
        Assert.StartsWith("action Dashboard.Save @", now.Text);
        foreach (var header in new[] { "action Home.Save", "action Save", "action MainFlow/Home.Save" }) {
            var merged = Merge(@base, now, @base.Text.Replace("action Home.Save", header).Replace("Total = 1", "Total = 2"));
            Assert.Empty(merged.Problems);
            Assert.Empty(merged.Conflicts);
            Assert.Equal(now.Text.Replace("Total = 1", "Total = 2"), merged.Text);
            var back = Back(now, merged.Text!);
            Assert.Empty(back.Problems);
            Assert.Equal("set", Assert.Single(back.Ops)["op"]!.ToString());
        }
        var moved = Merge(@base, now, @base.Text.Replace("action Home.Save", "action Detail.Save"));
        Assert.StartsWith("action Detail.Save @", moved.Text);
        Assert.Equal("FLOW_ACTION_OWNER", Assert.Single(Back(now, moved.Text!).Problems).Code);
    }

    // ---- the parts of a node, one by one (review of the junction feat/texto-ssam-2) ---------------------------------------

    // The module changed before the read (before), then the Studio's change since the read (studio).
    private static (Side Base, Side Now, Node Root, Node Action) Module(Action<Node, Node> before, Action<Node, Node> studio)
    {
        var (root, action) = TextRoundTripTests.Module();
        before(root, action);
        var @base = Read(root, action);
        studio(root, action);
        return (@base, Read(root, action), root, action);
    }

    private static Node AddLocal(Node root, Node action, string name, string type)
    {
        var local = action.Add(N("LocalVariable", name)).Set("DataType", root.Children.Single(c => c.Name == type));
        action.Set("LocalVariables", new List<Node>((List<Node>)action.Props["LocalVariables"]!) { local });
        return local;
    }

    private static void RemoveLocal(Node action, Node local)
    {
        action.Children.Remove(local);
        action.Set("LocalVariables", ((List<Node>)action.Props["LocalVariables"]!).Where(l => l != local).ToList());
    }

    private static void Renamed(Node action, string from, string to)
    {
        foreach (var child in action.Children.Where(c => c.Kind == "LocalVariable" && c.Name == from)) child.Name = to;
        void Rewrite(Node node)
        {
            foreach (var (name, value) in node.Props.ToList())
                if (value is TextRoundTripTests.Code code) node.Props[name] = Code(FlowEdits.Renamed(code.Text, from, to));
            foreach (var child in node.Children) Rewrite(child);
        }
        Rewrite(action);
    }

    // An assignment of one node changed on each side: both stay (the parts of a node are merged one by one, an assignment by
    // the variable it writes); one the Studio added stays beside the delivery's change; the same change on both sides with
    // one more of the Studio's is no conflict.
    [Fact]
    public void TheAssignmentsOfOneNodeAreMergedOneByOne()
    {
        var (@base, now, _, _) = Module((_, action) => Child(Child(action, "AssignNode", 1), "Assignment", 0).Set("Value", Code("Total + 9")));
        Assert.Contains("OrderId = ` Lines.List.Current.Order.Id`", @base.Text);
        var merged = Merge(@base, now, @base.Text.Replace("OrderId = ` Lines.List.Current.Order.Id`", "OrderId = 7"));
        Assert.Empty(merged.Conflicts);
        Assert.Equal(now.Text.Replace("OrderId = ` Lines.List.Current.Order.Id`", "OrderId = 7"), merged.Text);
        Assert.DoesNotContain(Back(now, merged.Text!).Ops, o => o["value"]?.ToString() == "Total +\n1");

        var (base2, now2, _, _) = Module((_, action) => Child(action, "AssignNode").Add(N("Assignment")).Set("Variable", Code("OrderId")).Set("Value", Code("5")));
        var merged2 = Merge(base2, now2, base2.Text.Replace("assign Total = Total + 1 ", "assign Total = Total + 2 "));
        Assert.Empty(merged2.Conflicts);
        Assert.Contains("Total = Total + 2\n", merged2.Text);
        Assert.Contains("OrderId = 5\n", merged2.Text);
        Assert.DoesNotContain(Back(now2, merged2.Text!).Ops, o => o["op"]!.ToString() == "delete");

        var (base3, now3, _, _) = Module((_, action) => {
            var many = Child(action, "AssignNode", 1);
            Child(many, "Assignment", 0).Set("Value", Code("Total + 9"));
            Child(many, "Assignment", 1).Set("Value", Code("7"));
        });
        var merged3 = Merge(base3, now3, base3.Text.Replace("OrderId = ` Lines.List.Current.Order.Id`", "OrderId = 7"));
        Assert.Empty(merged3.Conflicts);
        Assert.Equal(now3.Text, merged3.Text);
        Assert.Empty(Back(now3, merged3.Text!).Ops);
    }

    // A case the Studio added beside the case whose condition the delivery changed, and a filter the Studio added beside the
    // filter the delivery changed: both stay, no conflict.
    [Fact]
    public void TheCasesAndTheFiltersOfOneNodeAreMergedOneByOne()
    {
        var (@base, now, _, _) = Module((_, action) => {
            var choose = Child(action, "SwitchNode");
            var zero = choose.Add(N("SwitchCondition")).Set("Value", Code("Total = 0")).Set("Target", Child(action, "ForEachNode"));
            choose.Set("Conditions", new List<Node>((List<Node>)choose.Props["Conditions"]!) { zero });
            Child(action, "AggregateNode").Children.Single(c => c.Kind == "CombineSourcesOperation").Add(N("Filter")).Set("Condition", Code("L.Qty > 0"));
        });
        var edited = @base.Text.Replace("case Total > 3:", "case Total > 4:").Replace("WHERE (Order.Code = Code)", "WHERE (Order.Code <> Code)");
        Assert.NotEqual(@base.Text, edited);
        var merged = Merge(@base, now, edited);
        Assert.Empty(merged.Conflicts);
        Assert.Contains("case Total > 4:", merged.Text);
        Assert.Contains("case Total = 0:", merged.Text);
        Assert.Contains("(Order.Code <> Code)", merged.Text);
        Assert.Contains("(L.Qty > 0)", merged.Text);
        Assert.DoesNotContain("case Total > 3:", merged.Text);
        Assert.DoesNotContain("(Order.Code = Code)", merged.Text);
    }

    // A mapping is merged field by field, and a text of code line by line: what each side changed in another field or
    // another line stays; the same line changed on both sides keeps the delivery's line and is listed.
    [Fact]
    public void AMappingMergesFieldByFieldAndCodeLineByLine()
    {
        var (@base, now, _, _) = Module(
            (_, action) => Child(Child(action, "AssignNode", 1), "Assignment", 1).Set("Value", Code("Customer mapTo { Total: Amount * Factor, Label: Note + Suffix }")),
            (_, action) => Child(Child(action, "AssignNode", 1), "Assignment", 1).Set("Value", Code("Customer mapTo { Total: Amount * Factor * 2, Label: Note + Suffix }")));
        var merged = Merge(@base, now, @base.Text.Replace("Label: Note + Suffix }", "Label: Note + Suffix + \"!\" }"));
        Assert.Empty(merged.Conflicts);
        Assert.Contains("Customer mapTo { Total: Amount * Factor * 2, Label: Note + Suffix + \"!\" }", merged.Text);

        var (base2, now2, _, _) = Module((_, action) => Child(action, "SQLNode").Set("Statement", "/* studio */\nUPDATE {Order}\n\tSET [Code] = @P\n\nWHERE [Id] = @Q   "));
        Assert.Contains("    | WHERE [Id] = @Q   \n", base2.Text);
        var merged2 = Merge(base2, now2, base2.Text.Replace("    | WHERE [Id] = @Q   \n", "    | WHERE [Id] = @Q AND 1 = 1\n"));
        Assert.Empty(merged2.Conflicts);
        Assert.Contains("    | /* studio */\n    | UPDATE {Order}\n    | \tSET [Code] = @P\n    |\n    | WHERE [Id] = @Q AND 1 = 1\n", merged2.Text);

        var (base3, now3, _, action3) = Module((_, action) => Child(action, "SQLNode").Set("Statement", "/* studio */\nUPDATE {Order}\n\tSET [Code] = @P, [X] = 1\n\nWHERE [Id] = @Q   "));
        var merged3 = Merge(base3, now3, base3.Text.Replace("    | \tSET [Code] = @P\n", "    | \tSET [Code] = @P, [Y] = 2\n"));
        var conflict = Assert.Single(merged3.Conflicts);
        Assert.Equal(Child(action3, "SQLNode").Key, conflict["key"]!.ToString());
        Assert.Contains("[X] = 1", conflict["studio"]!.ToString());
        Assert.Contains("[Y] = 2", conflict["delivered"]!.ToString());
        Assert.Contains("    | /* studio */\n    | UPDATE {Order}\n    | \tSET [Code] = @P, [Y] = 2\n", merged3.Text);
    }

    // A step the Studio inserted right after a node the delivery removes goes where that node was: the delivery's
    // predecessor goes to it and it goes on where the delivery goes. A step the Studio inserted in a case branch stays when
    // the delivery changes that case's condition.
    [Fact]
    public void AStepTheStudioInsertedStaysInTheFlowWhenTheDeliveryRemovesWhatWasBeforeIt()
    {
        var (@base, now, _, _) = Module((_, action) => {
            var message = Child(action, "MessageNode"); var refresh = Child(action, "RefreshDataNode");
            var step = action.Add(N("AssignNode"));
            step.Add(N("Assignment")).Set("Variable", Code("OrderId")).Set("Value", Code("42"));
            message.Set("Target", step); step.Set("Target", refresh);
        });
        var merged = Merge(@base, now, @base.Text.Replace(@base.Line("message Info:") + "\n", ""));
        var lines = merged.Text!.Split('\n').ToList();
        var at = lines.FindIndex(l => l.Contains("assign OrderId = 42", StringComparison.Ordinal));
        Assert.True(at > 0, merged.Text);
        Assert.Contains("Parsed = JSONDeserialize", lines[at - 1]);
        Assert.Contains("refresh GetLines", lines[at + 1]);
        Assert.DoesNotContain("message Info:", merged.Text);
        Assert.Empty(Back(now, merged.Text!).Problems);

        var (base2, now2, _, _) = Module((_, action) => {
            var choose = Child(action, "SwitchNode"); var loop = Child(action, "ForEachNode");
            var step = action.Add(N("AssignNode"));
            step.Add(N("Assignment")).Set("Variable", Code("OrderId")).Set("Value", Code("42"));
            Child(choose, "SwitchCondition").Set("Target", step); step.Set("Target", loop);
            loop.Set("NodesWithinCycle", new List<Node>((List<Node>)loop.Props["NodesWithinCycle"]!) { step });
        });
        var merged2 = Merge(base2, now2, base2.Text.Replace("case Total > 3:", "case Total > 4:"));
        var lines2 = merged2.Text!.Split('\n').ToList();
        var case2 = lines2.FindIndex(l => l.Contains("case Total > 4:", StringComparison.Ordinal));
        Assert.True(case2 > 0, merged2.Text);
        Assert.Contains("assign OrderId = 42", lines2[case2 + 1]);
        Assert.DoesNotContain("unreached:", merged2.Text![..merged2.Text.IndexOf("on exception", StringComparison.Ordinal)]);
    }

    // When the Studio's steps cannot be put back in the flow (both sides inserted branching steps after the same node), the
    // merge is not written: the steps of the Studio would stop running.
    [Fact]
    public void StudioStepsTheMergeWouldLeaveOutOfTheFlowAreNotMerged()
    {
        var (@base, now, _, _) = Module((_, action) => {
            var refresh = Child(action, "RefreshDataNode"); var trigger = Child(action, "TriggerNode"); var wait = Child(action, "WaitNode");
            var decide = action.Add(N("IfNode")).Set("Condition", Code("Total > 9")).Set("TrueTarget", trigger).Set("FalseTarget", wait);
            refresh.Set("Target", decide);
        });
        var trigger = @base.Line("trigger Changed");
        var waitId = @base.Line("node WaitNode()")[(@base.Line("node WaitNode()").LastIndexOf('@') + 1)..];
        var edited = @base.Text.Replace(trigger + "\n", "  if Total > 0:\n    -> @" + waitId + "\n" + trigger + "\n");
        var merged = FlowMerge.ThreeWay(Reading(@base), now.Item, now.Document, edited);
        Assert.Null(merged.Text);
        Assert.Contains("flow", merged.Failure ?? "");
    }

    // A local the Studio removed that the delivery now uses is written again (listed); a local the delivery removed that the
    // Studio now uses is not merged (its use would be left without the local).
    [Fact]
    public void AnElementRemovedOnOneSideAndUsedOnTheOtherIsNeverLeftDangling()
    {
        Node? spare = null;
        var (@base, now, _, _) = Module((root, action) => spare = AddLocal(root, action, "Spare", "Integer"), (_, action) => RemoveLocal(action, spare!));
        var merged = Merge(@base, now, @base.Text.Replace("assign Total = Total + 1 ", "assign Total = Total + Spare "));
        Assert.Contains("local Spare: Integer", merged.Text);
        Assert.Contains("Total + Spare", merged.Text);
        Assert.Contains(merged.Conflicts, c => c["what"]!.ToString().Contains("removed in the Studio", StringComparison.Ordinal));
        Assert.Contains(Back(now, merged.Text!).Ops, o => o["op"]!.ToString() == "create" && o["name"]?.ToString() == "Spare");

        var (base2, now2, _, _) = Module((root, action) => AddLocal(root, action, "Spare", "Integer"),
            (_, action) => Child(Child(action, "AssignNode"), "Assignment").Set("Value", Code("Total + Spare")));
        var edited2 = base2.Text.Replace(base2.Line("local Spare:") + "\n", "");
        var merged2 = FlowMerge.ThreeWay(Reading(base2), now2.Item, now2.Document, edited2);
        Assert.Null(merged2.Text);
        Assert.Contains(merged2.Problems, p => p.Code == "FLOW_MERGE_REMOVED_USED" && p.Message.Contains("Spare", StringComparison.Ordinal));
    }

    // Two elements of one name from the two sides: one element when they are the same kind of element of the same type (the
    // delivery's values, listed); refused otherwise, and when a rename on one side lands on a name the other side added.
    [Fact]
    public void ANameBothSidesGiveIsOneElementOrRefused()
    {
        var (@base, now, _, _) = Module((_, _) => { }, (root, action) => AddLocal(root, action, "Extra", "Integer"));
        var local = @base.Line("local Total:");
        var other = FlowMerge.ThreeWay(Reading(@base), now.Item, now.Document, @base.Text.Replace(local + "\n", local + "\n  local Extra: Text\n"));
        Assert.Null(other.Text);
        Assert.Contains(other.Problems, p => p.Code == "FLOW_MERGE_NAME_TAKEN" && p.Message.Contains("Extra", StringComparison.Ordinal));

        var same = Merge(@base, now, @base.Text.Replace(local + "\n", local + "\n  local Extra: Integer\n"));
        Assert.Single(same.Text!.Split('\n'), l => l.Contains("local Extra", StringComparison.Ordinal));
        Assert.Contains(same.Conflicts, c => c["element"]!.ToString().Contains("Extra", StringComparison.Ordinal));
        Assert.DoesNotContain(Back(now, same.Text!).Ops, o => o["op"]!.ToString() == "create");

        var (base2, now2, _, _) = Module((_, _) => { }, (_, action) => Renamed(action, "Total", "Sum"));
        var local2 = base2.Line("local Total:");
        var renamed = FlowMerge.ThreeWay(Reading(base2), now2.Item, now2.Document, base2.Text.Replace(local2 + "\n", local2 + "\n  local Sum: Text\n"));
        Assert.Null(renamed.Text);
        Assert.Contains(renamed.Problems, p => p.Code == "FLOW_MERGE_NAME_TAKEN" && p.Message.Contains("Sum", StringComparison.Ordinal));
    }

    // A rename on one side is not read into the aliases of an aggregate's sources nor into the field names of a mapping: the
    // Studio's rename of a local named like a source leaves the source alone, and so does the merge.
    [Fact]
    public void ARenameIsNotReadIntoSourceAliasesNorFieldNames()
    {
        Node? order = null;
        var (@base, now, _, _) = Module((root, action) => order = AddLocal(root, action, "Order", "Order"), (_, _) => order!.Name = "TheOrder");
        var merged = Merge(@base, now, @base.Text.Replace("WHERE (Order.Code = Code)", "WHERE (Order.Code = Code + \"\")"));
        Assert.Empty(merged.Conflicts);
        Assert.Contains("WHERE (Order.Code = Code + \"\")", merged.Text);
        Assert.Contains("local TheOrder: Order", merged.Text);
        var back = Back(now, merged.Text!);
        Assert.Contains(back.Ops, o => o["value"]?.ToString() == "Order.Code = Code + \"\"");

        var (base2, now2, _, _) = Module(
            (_, action) => Child(Child(action, "AssignNode", 1), "Assignment", 1).Set("Value", Code("Customer mapTo { Total: Amount }")),
            (_, action) => {
                Child(action, "LocalVariable").Name = "Sum";
                foreach (var assignment in action.Children.Where(c => c.Kind == "AssignNode").SelectMany(n => n.Children))
                    foreach (var (name, value) in assignment.Props.ToList())
                        if (value is TextRoundTripTests.Code code && !code.Text.Contains("mapTo", StringComparison.Ordinal)) assignment.Props[name] = Code(FlowEdits.Renamed(code.Text, "Total", "Sum"));
            });
        var merged2 = Merge(base2, now2, base2.Text.Replace("Customer mapTo { Total: Amount }", "Customer mapTo { Total: Amount + 1 }"));
        Assert.Empty(merged2.Conflicts);
        Assert.Contains("Customer mapTo { Total: Amount + 1 }", merged2.Text);
        Assert.Contains("local Sum:", merged2.Text);
    }

    // ---- corrections of the third junction (Corrigir 1) -------------------------------------------------------------------

    // Two hunks that only lie next to each other (the Studio's line and the delivery's line beside it, or a line the Studio
    // appended after the line the delivery changed) are two changes: both are kept. In code (SQL, JavaScript) they are listed
    // as kept: both (Corrigir 2: the read back does not judge what the code means; nothing is listed for lines apart).
    [Fact]
    public void LinesNextToEachOtherChangedOneByEachSideAreBothKept()
    {
        var (@base, now, _, _) = Module((_, action) => Child(action, "SQLNode").Set("Statement", "UPDATE {Order} /* studio */\n\tSET [Code] = @P\n\nWHERE [Id] = @Q   "));
        Assert.Contains("    | \tSET [Code] = @P\n", @base.Text);
        var merged = Merge(@base, now, @base.Text.Replace("    | \tSET [Code] = @P\n", "    | \tSET [Code] = @P, [Y] = 2\n"));
        Assert.Contains("    | \tSET [Code] = @P, [Y] = 2\n", merged.Text);
        Assert.Contains("    | UPDATE {Order} /* studio */\n", merged.Text);
        Assert.Equal("both", Assert.Single(merged.Conflicts)["kept"]!.ToString());
        // Lines apart: nothing listed.
        var apart = Merge(@base, now, @base.Text.Replace("    | WHERE [Id] = @Q   \n", "    | WHERE [Id] = @Q AND 1 = 1\n"));
        Assert.Contains("    | UPDATE {Order} /* studio */\n", apart.Text);
        Assert.Empty(apart.Conflicts);

        var (base2, now2, _, _) = Module((_, action) => Child(action, "JavaScriptNode").Set("JavaScript", "$parameters.B = $parameters.A;\n\tconsole.log('done'); // @n9\n// studio"));
        Assert.Contains("    | \tconsole.log('done'); // @n9\n", base2.Text);
        var merged2 = Merge(base2, now2, base2.Text.Replace("    | \tconsole.log('done'); // @n9\n", "    | \tconsole.log('ok'); // @n9\n"));
        Assert.Contains("console.log('ok')", merged2.Text);
        Assert.Contains("    | // studio\n", merged2.Text);
        Assert.Equal("both", Assert.Single(merged2.Conflicts)["kept"]!.ToString());
        // The same line changed on both sides is still one conflict, the delivery's line.
        var (base3, now3, _, _) = Module((_, action) => Child(action, "SQLNode").Set("Statement", "UPDATE {Order}\n\tSET [Code] = @P /* studio */\n\nWHERE [Id] = @Q   "));
        var merged3 = Merge(base3, now3, base3.Text.Replace("    | \tSET [Code] = @P\n", "    | \tSET [Code] = @P /* model */\n"));
        Assert.Contains("/* model */", merged3.Text);
        Assert.DoesNotContain("/* studio */", merged3.Text);
        Assert.Single(merged3.Conflicts);
    }

    // A case of a switch the Studio only moved is the same case: the delivery's change of its condition lands on it, in the
    // Studio's order, and nothing is listed (it was neither removed nor added).
    [Fact]
    public void ACaseTheStudioMovedAndTheDeliveryChangedIsOneCase()
    {
        var (@base, now, _, _) = Module(
            (_, action) => {
                var choose = Child(action, "SwitchNode");
                var zero = choose.Add(N("SwitchCondition")).Set("Value", Code("Total = 0")).Set("Target", Child(action, "ForEachNode"));
                choose.Set("Conditions", new List<Node>((List<Node>)choose.Props["Conditions"]!) { zero });
            },
            (_, action) => {
                var choose = Child(action, "SwitchNode");
                var list = (List<Node>)choose.Props["Conditions"]!;
                choose.Set("Conditions", new List<Node> { list[1], list[0] });
            });
        Assert.NotEqual(@base.Text, now.Text);
        var merged = Merge(@base, now, @base.Text.Replace("case Total > 3:", "case Total > 4:"));
        Assert.Empty(merged.Conflicts);
        Assert.DoesNotContain("case Total > 3:", merged.Text);
        var lines = merged.Text!.Split('\n').ToList();
        var four = Assert.Single(lines, l => l.Contains("case Total > 4:", StringComparison.Ordinal));
        var zero = Assert.Single(lines, l => l.Contains("case Total = 0:", StringComparison.Ordinal));
        Assert.True(lines.IndexOf(zero) < lines.IndexOf(four), merged.Text);
    }

    // A field value of a mapping reads the attributes of its source first. A Studio rename is never read into a value that
    // names the source's attribute (without a scope no field value is rewritten at all); with the module's scope a value that
    // names the renamed element takes its final name, and one whose final name the source has is refused (FLOW_RENAME_CAPTURED).
    [Fact]
    public void ARenameIsReadIntoAMappingValueOnlyWhereItNamesTheRenamedElement()
    {
        static (Side Base, Side Now) Renaming(string from, string to)
        {
            var (b, n, _, _) = Module(
                (_, action) => Child(Child(action, "AssignNode", 1), "Assignment", 1).Set("Value", Code("Customer mapTo { Total: Amount }")),
                (_, action) => {
                    action.Children.Single(c => c.Kind == "InputParameter" && c.Name == from).Name = to;
                    foreach (var node in action.Children)
                        foreach (var part in node.Children.Prepend(node))
                            foreach (var (name, value) in part.Props.ToList())
                                if (value is TextRoundTripTests.Code code && !code.Text.Contains("mapTo", StringComparison.Ordinal)) part.Props[name] = Code(FlowEdits.Renamed(code.Text, from, to));
                });
            return (b, n);
        }
        var attributes = new HashSet<string>(["Amount", "Code", "Note"], StringComparer.OrdinalIgnoreCase);
        FlowMerge.MappingScope? Scope(string source, FlowItem side) => source == "Customer" ? new(attributes, true) : null;
        // No scope: the delivery's value stays as written (Code is the source's attribute).
        var (@base, now) = Renaming("Code", "CustomerCode");
        var edited = @base.Text.Replace("Customer mapTo { Total: Amount }", "Customer mapTo { Total: Amount, Label: Code }");
        Assert.Contains("Customer mapTo { Total: Amount, Label: Code }", Merge(@base, now, edited).Text);
        // The scope says Code is the source's attribute: left as it is.
        var typed = FlowMerge.ThreeWay(Reading(@base), now.Item, now.Document, edited, Scope);
        Assert.Contains("Customer mapTo { Total: Amount, Label: Code }", typed.Text);
        // Count is no attribute: the value names the input, which takes its final name.
        var (base2, now2) = Renaming("Count", "Tally");
        var counted = FlowMerge.ThreeWay(Reading(base2), now2.Item, now2.Document, base2.Text.Replace("Customer mapTo { Total: Amount }", "Customer mapTo { Total: Count }"), Scope);
        Assert.Contains("Customer mapTo { Total: Tally }", counted.Text);
        Assert.Empty(counted.Problems);
        // Count renamed Note, an attribute of the source: the delivered value would read Customer.Note. Refused, with the action now.
        var (base3, now3) = Renaming("Count", "Note");
        var captured = FlowMerge.ThreeWay(Reading(base3), now3.Item, now3.Document, base3.Text.Replace("Customer mapTo { Total: Amount }", "Customer mapTo { Total: Count }"), Scope);
        Assert.Null(captured.Text);
        var problem = Assert.Single(captured.Problems);
        Assert.Equal("FLOW_RENAME_CAPTURED", problem.Code);
        Assert.Contains("Note", problem.Message);
        Assert.Equal(now3.Text, problem.Patch);
    }

    // A node of the read the Studio removed and the delivery changed is written again with a new id (+m1): it is the action's
    // own node, not a new one. The merge lists it (Rewritten), and the rules of new elements (decision 6: a new JavaScript only
    // in an isolated client action) do not judge it: the delivery's version is kept, as the owner's rules say.
    [Fact]
    public void AJavaScriptTheStudioRemovedAndTheDeliveryChangedIsTheActionsOwn()
    {
        var (@base, now, _, _) = Module((_, action) => {
            var sql = Child(action, "SQLNode"); var script = Child(action, "JavaScriptNode");
            sql.Set("Target", Child(action, "JSONSerializeNode"));
            action.Children.Remove(script);
        });
        Assert.Contains("$parameters.B = $parameters.A;", @base.Text);
        var merged = Merge(@base, now, @base.Text.Replace("$parameters.B = $parameters.A;", "$parameters.B = $parameters.A + '!';"));
        Assert.Contains("removed in the Studio", merged.Conflicts.Select(c => c["what"]!.ToString()));
        var line = merged.Text!.Split('\n').Single(l => l.Contains("Script = javascript", StringComparison.Ordinal));
        Assert.EndsWith(" @+m1", line);
        Assert.Contains("+m1", merged.Rewritten);
        var edited = ModuleFlow.Read(merged.Text);
        var judged = FlowDiff.Compute(now.Item, now.Document.Keys, edited, now.Text, editedText: merged.Text, rewritten: merged.Rewritten);
        Assert.DoesNotContain(judged.Problems, p => p.Code == "FLOW_JAVASCRIPT_NOT_ISOLATED");
        Assert.Contains(judged.Ops, o => o["op"]!.ToString() == "create" && o["type"]!.ToString().EndsWith("IJavaScriptNode", StringComparison.Ordinal));
        // The same text without the merge's word is a new JavaScript in a server action: refused, as any new one.
        var asNew = FlowDiff.Compute(now.Item, now.Document.Keys, ModuleFlow.Read(merged.Text), now.Text, editedText: merged.Text);
        Assert.Contains(asNew.Problems, p => p.Code == "FLOW_JAVASCRIPT_NOT_ISOLATED");
    }

    // The review of round 2 (owner rules, high): the Studio removed a node (an assign, a message) and the delivery wrote a
    // JavaScript or a For Each that only copies on that id. The merge writes the delivery's element again (its key is gone), but it
    // is another kind of element than the read had there: a new one, judged by the rules of new elements (never exempt as the
    // action's own, as a JavaScript of the read the delivery changed is), and the conflict names what the read had.
    [Fact]
    public void AnotherKindOfElementOnTheIdOfANodeTheStudioRemovedIsJudgedAsNew()
    {
        var (@base, now, _, _) = Module((_, action) => {
            Child(action, "JSONDeserializeNode").Set("Target", Child(action, "RefreshDataNode"));
            action.Children.Remove(Child(action, "MessageNode"));
        });
        var line = @base.Line("message Info");
        var id = line[(line.LastIndexOf(" @", StringComparison.Ordinal) + 2)..];
        foreach (var (written, code) in new[] {
            ("  Rolar = javascript @" + id + "\n    | console.log('x');", "FLOW_JAVASCRIPT_NOT_ISOLATED"),
            ("  foreach Lines.List: @" + id + "\n    (System).ListAppend(Element=Lines.List.Current, List=Picked)\n    next", "FLOW_FOREACH_LIST_ACTION") }) {
            var merged = Merge(@base, now, @base.Text.Replace(line, written));
            Assert.Empty(merged.Problems);
            Assert.Empty(merged.Rewritten);
            Assert.Contains(merged.Conflicts, c => c["element"]!.ToString().StartsWith("MessageNode of the read", StringComparison.Ordinal));
            var judged = FlowDiff.Compute(now.Item, now.Document.Keys, ModuleFlow.Read(merged.Text!), now.Text, editedText: merged.Text, rewritten: merged.Rewritten);
            Assert.Contains(judged.Problems, p => p.Code == code);
        }
    }

    // ---- corrections of the third junction (Corrigir 2) -------------------------------------------------------------------

    private static Node Combine(Node action) => Child(action, "AggregateNode").Children.Single(c => c.Kind == "CombineSourcesOperation");
    private static bool IsFilter(Node node, string condition) => node.Kind == "Filter" && ((TextRoundTripTests.Code)node.Props["Condition"]!).Text == condition;

    // Two parts of different identities are never one part: the Studio replaced Total's assignment by one of OrderId, the
    // delivery changed Total's value. Both stay (the delivery's written again, listed), never the delivery's value under the
    // Studio's variable with the conflict saying "kept: delivery" (review r2, A1/A1b/A5).
    [Fact]
    public void AnAssignmentOfAnotherVariableIsNeverMergedIntoTheDeliverysValue()
    {
        foreach (var studioValue in new[] { "5", "Total + 1" }) {
            var (@base, now, _, _) = Module((_, action) => {
                var one = Child(action, "AssignNode");
                one.Children.Clear();
                one.Add(N("Assignment")).Set("Variable", Code("OrderId")).Set("Value", Code(studioValue));
            });
            Assert.Contains("assign Total = Total + 1 ", @base.Text);
            var merged = Merge(@base, now, @base.Text.Replace("assign Total = Total + 1 ", "assign Total = Total + 2 "));
            Assert.DoesNotContain("OrderId = Total + 2", merged.Text);
            Assert.Contains("Total = Total + 2", merged.Text);
            Assert.Contains("OrderId = " + studioValue, merged.Text);
            Assert.Contains(merged.Conflicts, c => c["what"]!.ToString().Contains("removed in the Studio", StringComparison.Ordinal));
            // No conflict says the delivery's value was kept under the Studio's variable.
            Assert.DoesNotContain(merged.Conflicts, c => c["studio"]!.ToString().Contains("OrderId", StringComparison.Ordinal) && c["delivered"]!.ToString().Contains("Total + 2", StringComparison.Ordinal));
            Assert.Empty(Back(now, merged.Text!).Problems);
        }
    }

    // A call the Studio pointed at another action while the delivery changed its argument: the arguments of one action are not
    // another's, so the call is the delivery's whole (action and arguments), listed; never GetCustomer's value under GetOther's
    // parameter (review r2, A6/E3). The Studio's retarget alone is kept.
    [Fact]
    public void ACallTheStudioPointedElsewhereAndTheDeliveryChangedIsTheDeliverysWholeCall()
    {
        void Retarget(Node root, Node action)
        {
            var reference = root.Children.First(c => c.Kind == "Reference");
            var other = reference.Add(N("ServerActionSignature", "GetOther"));
            var id = other.Add(N("InputParameter", "Id"));
            var call = Child(action, "ExecuteServerActionNode");
            call.Set("Action", other);
            call.Children.Clear();
            call.Add(N("Argument")).Set("Parameter", id).Set("Value", Code("Total"));
        }
        var (@base, now, _, _) = Module(Retarget);
        Assert.Contains("Customer = Customers_CS.GetCustomer(Code) ", @base.Text);
        Assert.Contains("Customer = Customers_CS.GetOther(Id=Total) ", now.Text);
        var merged = Merge(@base, now, @base.Text.Replace("Customer = Customers_CS.GetCustomer(Code) ", "Customer = Customers_CS.GetCustomer(Code=Code + 1) "));
        Assert.DoesNotContain("GetOther(Id=Code + 1)", merged.Text);
        Assert.DoesNotContain("GetOther(Code", merged.Text);
        Assert.Contains("Customers_CS.GetCustomer(Code=Code + 1)", merged.Text);
        var conflict = Assert.Single(merged.Conflicts, c => c["what"]!.ToString() == "call");
        Assert.Contains("GetOther", conflict["studio"]!.ToString());
        Assert.Equal("delivery", conflict["kept"]!.ToString());
        // The delivery changed something else: the Studio's call stays as the Studio left it.
        var other = Merge(@base, now, @base.Text.Replace("assign Total = Total + 1 ", "assign Total = Total + 2 "));
        Assert.Contains("Customer = Customers_CS.GetOther(Id=Total) ", other.Text);
        Assert.Empty(other.Conflicts);
    }

    // Leftover parts are paired by likeness, the closest pair first: a filter (or a case) the Studio changed is not lost when
    // the Studio removed another one the delivery changed (review r2, A2/A2b/A4/E2).
    [Fact]
    public void APartTheStudioChangedIsNotLostWhenItRemovedAnotherOne()
    {
        Node? low = null;
        var (@base, now, _, _) = Module(
            (_, action) => {
                var combine = Combine(action);
                combine.Children.Remove(combine.Children.First(c => c.Kind == "Filter"));
                combine.Add(N("Filter")).Set("Condition", Code("L.Qty < 100"));
                low = combine.Add(N("Filter")).Set("Condition", Code("L.Qty > 0"));
            },
            (_, action) => {
                var combine = Combine(action);
                combine.Children.Remove(combine.Children.First(c => IsFilter(c, "L.Qty < 100")));
                low!.Set("Condition", Code("L.Qty > 1"));
            });
        Assert.Contains("(L.Qty < 100) AND (L.Qty > 0)", @base.Text);
        var merged = Merge(@base, now, @base.Text.Replace("(L.Qty < 100)", "(L.Qty < 200)"));
        Assert.Contains("(L.Qty > 1)", merged.Text);
        Assert.Contains("(L.Qty < 200)", merged.Text);
        Assert.DoesNotContain("(L.Qty > 0)", merged.Text);

        Node? qty = null;
        var (base2, now2, _, _) = Module(
            (_, action) => qty = Combine(action).Add(N("Filter")).Set("Condition", Code("L.Qty > 0")),
            (_, action) => {
                var combine = Combine(action);
                combine.Children.Remove(combine.Children.First(c => IsFilter(c, "Order.Code = Code")));
                qty!.Set("Condition", Code("L.Qty > 10"));
            });
        var merged2 = Merge(base2, now2, base2.Text.Replace("(Order.Code = Code)", "(Order.Code <> Code)"));
        Assert.Contains("(L.Qty > 10)", merged2.Text);
        Assert.Contains("Order.Code <> Code", merged2.Text);

        Node? zero = null;
        var (base3, now3, _, _) = Module(
            (_, action) => {
                var choose = Child(action, "SwitchNode");
                zero = choose.Add(N("SwitchCondition")).Set("Value", Code("Total = 0")).Set("Target", Child(action, "ForEachNode"));
                choose.Set("Conditions", new List<Node>((List<Node>)choose.Props["Conditions"]!) { zero });
            },
            (_, action) => {
                var choose = Child(action, "SwitchNode");
                var list = (List<Node>)choose.Props["Conditions"]!;
                choose.Children.Remove(list[0]);
                choose.Set("Conditions", new List<Node> { zero! });
                zero!.Set("Value", Code("Total = 1"));
            });
        Assert.Contains("case Total > 3:", base3.Text);
        var merged3 = Merge(base3, now3, base3.Text.Replace("case Total > 3:", "case Total > 4:"));
        Assert.Contains("case Total = 1:", merged3.Text);
        Assert.Contains("case Total > 4:", merged3.Text);
    }

    // A filter the delivery changed a little and the Studio replaced by another (removed, and one of its own added): both stay,
    // the delivery's written again and listed, never the Studio's lost as a "conflict" (review r2, A3).
    [Fact]
    public void AFilterTheStudioReplacedStaysBesideTheOneTheDeliveryChanged()
    {
        var (@base, now, _, _) = Module(
            (_, action) => Combine(action).Add(N("Filter")).Set("Condition", Code("L.Qty > 0")),
            (_, action) => {
                var combine = Combine(action);
                combine.Children.Remove(combine.Children.First(c => IsFilter(c, "Order.Code = Code")));
                combine.Add(N("Filter")).Set("Condition", Code("L.Price > 5"));
            });
        var merged = Merge(@base, now, @base.Text.Replace("(Order.Code = Code)", "(Order.Code <> Code)"));
        Assert.Contains("(L.Price > 5)", merged.Text);
        Assert.Contains("(L.Qty > 0)", merged.Text);
        Assert.Contains("(Order.Code <> Code)", merged.Text);
        Assert.Contains(merged.Conflicts, c => c["what"]!.ToString().Contains("removed in the Studio", StringComparison.Ordinal));
    }

    // Lines: a true overlap takes only the lines both sides changed; the Studio's line that only touches it stays (review r2, A7).
    // Code changed next to each other by the two sides (no line of the read between) is kept from both and listed as kept: both,
    // since the read back does not judge what a script or a query means (review r2: a rename of x on one side, a new line
    // reading x on the other).
    [Fact]
    public void ATrueOverlapTakesOnlyItsLinesAndNeighbouringCodeIsListed()
    {
        var (@base, now, _, _) = Module((_, action) => Child(action, "SQLNode").Set("Statement", "UPDATE {Order} /* studio */\n\tSET [Code] = @P\n-- studio\nWHERE [Id] = @Q   "));
        Assert.Contains("    | UPDATE {Order}\n    | \tSET [Code] = @P\n    |\n", @base.Text);
        var merged = Merge(@base, now, @base.Text.Replace("    | \tSET [Code] = @P\n    |\n", "    | \tSET [Code] = @P, [Y] = 2\n    | -- delivery\n"));
        Assert.Contains("    | UPDATE {Order} /* studio */\n", merged.Text);
        Assert.Contains("    | \tSET [Code] = @P, [Y] = 2\n    | -- delivery\n", merged.Text);
        // The overlap is the read's lines 2-3 (the delivery's); line 1, the Studio's alone, is not in it.
        Assert.Contains(merged.Conflicts, c => c["kept"]!.ToString() == "delivery" && c["what"]!.ToString().Contains("lines 2-3", StringComparison.Ordinal));
        Assert.DoesNotContain(merged.Conflicts, c => c["kept"]!.ToString() == "delivery" && c["what"]!.ToString().Contains("lines 1-", StringComparison.Ordinal));

        var (base2, now2, _, _) = Module(
            (_, action) => Child(action, "JavaScriptNode").Set("JavaScript", "var x = $parameters.A;\n$parameters.B = x * 2;"),
            (_, action) => Child(action, "JavaScriptNode").Set("JavaScript", "var y = $parameters.A;\n$parameters.B = y * 2;"));
        var edited2 = base2.Text.Replace("    | $parameters.B = x * 2;\n", "    | $parameters.B = x * 2;\n    | if (x < 0) { $parameters.B = 0; }\n");
        Assert.NotEqual(base2.Text, edited2);
        var merged2 = Merge(base2, now2, edited2);
        Assert.Contains("var y = $parameters.A;", merged2.Text);
        Assert.Contains("if (x < 0)", merged2.Text);
        var both = Assert.Single(merged2.Conflicts);
        Assert.Equal("both", both["kept"]!.ToString());
        Assert.Contains("var y", both["studio"]!.ToString());
        Assert.Contains("if (x < 0)", both["delivered"]!.ToString());
    }

    // A mapping whose source one side changed while the other changed or added a field: a field value reads the source's
    // attributes first, so it is merged whole, the delivery's mapping, listed (review r2, A8 and the r1 proof sw2).
    [Fact]
    public void AMappingOneSidePointedAtAnotherSourceIsMergedWhole()
    {
        var (@base, now, _, _) = Module(
            (_, action) => Child(Child(action, "AssignNode", 1), "Assignment", 1).Set("Value", Code("Customer mapTo { Total: Amount }")),
            (_, action) => Child(Child(action, "AssignNode", 1), "Assignment", 1).Set("Value", Code("Parsed mapTo { Total: Price }")));
        var merged = Merge(@base, now, @base.Text.Replace("Customer mapTo { Total: Amount }", "Customer mapTo { Total: Amount, Label: Code }"));
        Assert.DoesNotContain("Parsed mapTo { Total: Price, Label: Code }", merged.Text);
        Assert.Contains("Customer mapTo { Total: Amount, Label: Code }", merged.Text);
        var conflict = Assert.Single(merged.Conflicts);
        Assert.Contains("Parsed mapTo", conflict["studio"]!.ToString());
        var changed = Merge(@base, now, @base.Text.Replace("Customer mapTo { Total: Amount }", "Customer mapTo { Total: Amount + 1 }"));
        Assert.Contains("Customer mapTo { Total: Amount + 1 }", changed.Text);
        Assert.Single(changed.Conflicts);
        // The source changed on one side only, nothing else: that side's source.
        var alone = Merge(@base, now, @base.Text.Replace("assign Total = Total + 1 ", "assign Total = Total + 2 "));
        Assert.Contains("Parsed mapTo { Total: Price }", alone.Text);
        Assert.Empty(alone.Conflicts);
    }
}
