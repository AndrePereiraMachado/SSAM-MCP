using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects: the logic text (ssam-flow/1, ModuleFlow) is a fixed point of the read. An action read
// from the module, printed, parsed back and printed again gives the same canonical model and the same text, with every
// node, parameter and part, every description and text whole. These tests prove the grammar on a synthetic module; the
// corpus (TextRoundTripCorpus, run by TextRoundTripCorpusTests in each project) proves it on the real modules of the plan.
public sealed class TextRoundTripTests
{
    internal sealed class Node(string key, string kind, string name = "")
    {
        public string Key = key, Kind = kind, Name = name;
        public Node? Parent;
        public readonly List<Node> Children = [];
        public readonly Dictionary<string, object?> Props = [];
        public Node Add(Node child) { child.Parent = this; Children.Add(child); return child; }
        public Node Set(string property, object? value) { Props[property] = value; return this; }
    }
    internal sealed record Code(string Text);
    // Enumerated values, as the Model API gives them (a value, never a text).
    internal enum Native { None, Inner, Descending, ISO, Info, Fade }
    internal sealed class Reader : ModelReader<Node>
    {
        protected override IEnumerable<Node> Referrers(Node n) => [];
        protected override IEnumerable<Node> Children(Node n) => n.Children;
        protected override Node? Parent(Node n) => n.Parent;
        protected override string Key(Node n) => n.Key;
        protected override string Kind(Node n) => n.Kind;
        protected override string Name(Node n) => n.Name;
        protected override string? Label(Node n) => n.Props.GetValueOrDefault("Label") as string;
        protected override IReadOnlySet<string> KindNames(Node n) => new HashSet<string> { n.Kind, "I" + n.Kind };
        protected override string? Expression(object value) => (value as Code)?.Text ?? (value as Node is { Kind: "Expression" } e ? (e.Props.GetValueOrDefault("Text") as Code)?.Text : null);
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Node n) => n.Props.Select(p => (p.Key, (Func<object?>)(() => p.Value is Exception e ? throw e : p.Value)));
    }

    private static int keys;
    internal static Node N(string kind, string name = "") => new("K" + (++keys).ToString("D4"), kind, name);

    // A server action with every node kind and the texts the grammar must carry whole: multi-line descriptions and
    // comments, code with tabs, expressions with a newline or a space at an end, a description with a carriage return,
    // shared ends, a foreach with next, a switch, an aggregate with every clause, SQL and JavaScript with their own
    // parameters, a handler, an unreached island and a node kind the printer has no word for.
    internal static (Node Root, Node Action) Module()
    {
        keys = 0;
        var root = N("ESpace", "Orders");
        var invalid = root.Add(N("UserException", "Invalid"));
        var all = root.Add(N("SystemException", "All Exceptions"));
        var text = root.Add(N("BasicType", "Text")); var integer = root.Add(N("BasicType", "Integer"));
        var reference = root.Add(N("Reference", "Customers_CS"));
        var getCustomer = reference.Add(N("ServerActionSignature", "GetCustomer"));
        var codeParameter = getCustomer.Add(N("InputParameter", "Code")); var extraParameter = getCustomer.Add(N("InputParameter", "Extra"));
        var order = root.Add(N("ServerEntity", "Order")); var line = root.Add(N("ServerEntity", "Line"));
        var lineList = root.Add(N("ListType", "Line List"));
        var screenAggregate = root.Add(N("ScreenAggregate", "GetLines"));
        var changed = root.Add(N("BlockEvent", "Changed")); var changedParameter = changed.Add(N("InputParameter", "Value"));
        var home = root.Add(N("MobileScreen", "Home"));
        var action = root.Add(N("ServerAction", "PlaceOrder")).Set("Public", true).Set("Description", "Places an order.\nTwo lines, the second  with two spaces.")
            .Set("Folder", root.Add(N("Folder", "Orders and lines")));
        var code = action.Add(N("InputParameter", "Code")).Set("DataType", text).Set("IsMandatory", false).Set("Description", "the code").Set("DefaultValue", new Code("\"A\""));
        var count = action.Add(N("InputParameter", "Count")).Set("DataType", integer).Set("IsMandatory", true).Set("Type", "Integer");
        var result = action.Add(N("OutputParameter", "OrderId")).Set("DataType", integer);
        var total = action.Add(N("LocalVariable", "Total")).Set("DataType", integer).Set("DefaultValue", new Code("0"));
        action.Set("InputParameters", new List<Node> { code, count }).Set("OutputParameters", new List<Node> { result }).Set("LocalVariables", new List<Node> { total });
        Node Step(string kind, string name = "") => action.Add(N(kind, name));
        var start = Step("StartNode"); var call = Step("ExecuteServerActionNode", "Customer"); var check = Step("IfNode");
        var raise = Step("RaiseExceptionNode"); var read = Step("AggregateNode", "Lines"); var loop = Step("ForEachNode");
        var one = Step("AssignNode"); var choose = Step("SwitchNode"); var many = Step("AssignNode");
        var sql = Step("SQLNode", "Bump"); var js = Step("JavaScriptNode", "Script"); var serialize = Step("JSONSerializeNode", "Json");
        var parse = Step("JSONDeserializeNode", "Parsed"); var message = Step("MessageNode"); var refresh = Step("RefreshDataNode");
        var trigger = Step("TriggerNode"); var wait = Step("WaitNode"); var end = Step("EndNode");
        var handler = Step("ExceptionHandlerNode"); var comment = Step("CommentNode");
        var island = Step("ExecuteServerActionNode", ""); var navigate = Step("DestinationNode"); var otherEnd = Step("EndNode");
        start.Set("Target", call);
        call.Set("Action", getCustomer).Set("Target", check).Set("AnimationEffect", Native.None);
        call.Add(N("Argument")).Set("Parameter", codeParameter).Set("Value", new Code("Code"));
        call.Add(N("Argument")).Set("Parameter", extraParameter).Set("Value", new Code(""));
        check.Set("Condition", new Code("Code = \"a:b\"")).Set("Label", "Empty?").Set("TrueTarget", raise).Set("FalseTarget", read);
        raise.Set("Exception", invalid).Set("ExceptionMessage", new Code("\"empty\""));
        var combine = read.Add(N("CombineSourcesOperation"));
        var add = read.Add(N("AddSourceOperation")).Set("Source", order); var addLine = read.Add(N("AddSourceOperation")).Set("Source", line);
        var orderSource = combine.Add(N("AliasedSource", "Order")).Set("Source", order).Set("SourceOperation", add);
        var lineSource = combine.Add(N("AliasedSource", "L")).Set("Source", line).Set("SourceOperation", addLine);
        combine.Add(N("Join")).Set("JoinType", Native.Inner).Set("LeftSource", orderSource).Set("RightSource", lineSource).Set("Condition", new Code("Order.Id = L.OrderId"));
        combine.Add(N("Filter")).Set("Condition", new Code("Order.Code = Code"));
        var sort = combine.Add(N("Sort")).Set("Attribute", new Code("Order.Id")).Set("SortDirection", Native.Descending);
        combine.Add(N("CalculatedAttribute", "Doubled")).Set("Value", new Code("L.Qty * 2")).Set("DataType", integer);
        read.Set("Sorts", new List<Node> { sort }).Set("MaxRecords", new Code("10")).Set("StartIndex", new Code("Start")).Set("MasterSource", orderSource)
            .Set("RootOperation", combine).Set("Type", lineList).Set("Target", loop);
        loop.Set("RecordList", new Code("Lines.List")).Set("MaximumIterations", new Code("5")).Set("Label", "Each line").Set("CycleTarget", one).Set("Target", sql)
            .Set("NodesWithinCycle", new List<Node> { one, choose, many });
        one.Add(N("Assignment")).Set("Variable", new Code("Total")).Set("Value", new Code("Total + 1"));
        one.Set("Target", choose);
        var bigger = choose.Add(N("SwitchCondition")).Set("Value", new Code("Total > 3")).Set("Target", loop);
        choose.Set("Conditions", new List<Node> { bigger }).Set("OtherwiseTarget", many).Set("Label", "How many?");
        many.Add(N("Assignment")).Set("Variable", new Code("Total")).Set("Value", new Code("Total +\n1"));
        many.Add(N("Assignment")).Set("Variable", new Code("OrderId")).Set("Value", new Code(" Lines.List.Current.Order.Id"));
        many.Set("Target", loop);
        var p = sql.Add(N("SQLInputParameter", "P")).Set("DataType", text).Set("IsMandatory", true).Set("ExpandInline", true);
        var q = sql.Add(N("SQLInputParameter", "Q")).Set("DataType", integer).Set("IsMandatory", true);
        sql.Add(N("Argument")).Set("Parameter", p).Set("Value", new Code("\"x\""));
        sql.Add(N("Argument")).Set("Parameter", q).Set("Value", new Code("Total"));
        sql.Add(N("SQLOutput")).Set("EntityOrStructure", order);
        sql.Set("Parameters", new List<Node> { p, q }).Set("Statement", "UPDATE {Order}\n\tSET [Code] = @P\n\nWHERE [Id] = @Q   ").Set("MaxRecords", new Code("1")).Set("Target", js);
        var jsIn = js.Add(N("InputParameter", "A")).Set("DataType", text).Set("IsMandatory", true);
        var jsOut = js.Add(N("OutputParameter", "B")).Set("DataType", text);
        js.Add(N("Argument")).Set("Parameter", jsIn).Set("Value", new Code("Code"));
        js.Set("InputParameters", new List<Node> { jsIn }).Set("OutputParameters", new List<Node> { jsOut })
            .Set("JavaScript", "$parameters.B = $parameters.A;\n\tconsole.log('done'); // @n9").Set("Target", serialize);
        serialize.Set("Data", new Code("Lines.List")).Set("SerializeDefaultValues", true).Set("DateFormat", Native.ISO).Set("Description", "with a\r\ncarriage return").Set("Target", parse);
        parse.Set("JSONString", new Code("Json.JSON")).Set("DataType", lineList).Set("Target", message);
        message.Set("Type", Native.Info).Set("Message", new Code(" \"ok\"")).Set("Label", "Tell").Set("Target", refresh);
        refresh.Set("DataSource", screenAggregate).Set("MaxRecords", new Code("50")).Set("Target", trigger);
        trigger.Add(N("Argument")).Set("Parameter", changedParameter).Set("Value", new Code("Total"));
        trigger.Set("Event", changed).Set("Target", wait);
        wait.Set("Timeout", new Code("30")).Set("Target", end);
        handler.Set("Exception", all).Set("AbortTransaction", false).Set("LogError", true).Set("Target", end);
        comment.Set("Text", "First line\n\nthird line @n4");
        comment.Add(N("CommentConnector")).Set("Target", check);
        island.Set("Action", getCustomer).Set("Target", navigate);
        navigate.Set("Destination", home).Set("Transition", Native.Fade);
        _ = otherEnd;
        return (root, action);
    }

    private static FlowEntry Entry(Node root, Node action)
    {
        var item = ModuleFlow.Extract(root, new Reader(), action, out var problems);
        return ModuleFlow.Entry(item, item.Name, problems, 0);
    }

    [Fact]
    public void EveryNodeKindIsAFixedPointWithItsTextsWhole()
    {
        var (root, action) = Module();
        var entry = Entry(root, action);
        Assert.True(entry.FixedPoint, string.Join("\n", entry.Problems) + "\n" + entry.Text);
        var text = entry.Text;
        var id = entry.Ids.ToDictionary(p => p.Value, p => p.Key);
        string At(Node node) => "@" + id[node.Key];
        Node Of(string kind, int nth = 0) => action.Children.Where(c => c.Kind == kind).ElementAt(nth);
        var (start, call, check, raise, read, loop) = (Of("StartNode"), Of("ExecuteServerActionNode"), Of("IfNode"), Of("RaiseExceptionNode"), Of("AggregateNode"), Of("ForEachNode"));
        var (one, choose, many, sql, js, serialize) = (Of("AssignNode"), Of("SwitchNode"), Of("AssignNode", 1), Of("SQLNode"), Of("JavaScriptNode"), Of("JSONSerializeNode"));
        var (parse, message, refresh, trigger, wait, end) = (Of("JSONDeserializeNode"), Of("MessageNode"), Of("RefreshDataNode"), Of("TriggerNode"), Of("WaitNode"), Of("EndNode"));
        var (handler, comment, island, navigate, otherEnd) = (Of("ExceptionHandlerNode"), Of("CommentNode"), Of("ExecuteServerActionNode", 1), Of("DestinationNode"), Of("EndNode", 1));
        foreach (var expected in new[] {
            "/// Places an order.\n/// Two lines, the second  with two spaces.\nserver action PlaceOrder public @" + action.Key + "\n  @{Folder=&\"Orders and lines\"}\n",
            "  /// the code\n  in Code?: Text = \"A\" @p1\n  in Count: Integer @p2\n  out OrderId: Integer @p3\n  local Total: Integer = 0 @l1\n",
            "  //-> " + At(check) + " First line " + At(comment) + "\n    |\n    | third line @n4\n",
            "  Customer = Customers_CS.GetCustomer(Code) " + At(call) + "\n",
            "  if Code = \"a:b\":  # Empty? " + At(check) + "\n    raise Invalid(\"empty\") " + At(raise) + "\n",
            "  Lines = aggregate FROM L=Line, Order JOIN Inner Order~L ON Order.Id = L.OrderId WHERE (Order.Code = Code) CALC Doubled=L.Qty * 2 SORT Order.Id desc MAX 10 START Start " + At(read) + "\n    @{MasterSource=&\"Order\"}\n",
            "  foreach Lines.List max 5:  # Each line " + At(loop) + "\n    assign Total = Total + 1 " + At(one) + "\n    switch:  # How many? " + At(choose) + "\n      case Total > 3:\n        next\n      otherwise:\n        assign " + At(many) + "\n          Total = `Total +\\n1`\n          OrderId = ` Lines.List.Current.Order.Id`\n        next\n",
            "  Bump = sql -> Order max 1 " + At(sql) + "\n    in P: Text inline = \"x\" @p4\n    in Q: Integer = Total @p5\n    | UPDATE {Order}\n    | \tSET [Code] = @P\n    |\n    | WHERE [Id] = @Q   \n",
            "  Script = javascript " + At(js) + "\n    in A: Text = Code @p6\n    out B: Text @p7\n    | $parameters.B = $parameters.A;\n    | \tconsole.log('done'); // @n9\n",
            "  Json = JSONSerialize(Lines.List) " + At(serialize) + "\n    @{Description=\"with a\\r\\ncarriage return\" SerializeDefaultValues=True}\n",
            "  Parsed = JSONDeserialize(Json.JSON) as Line List " + At(parse) + "\n",
            "  message Info: ` \"ok\"`  # Tell " + At(message) + "\n",
            "  refresh GetLines max 50 " + At(refresh) + "\n  trigger Changed(Value=Total) " + At(trigger) + "\n",
            "  node WaitNode() " + At(wait) + "\n    @{Timeout=`30`}\n  end " + At(end) + "\n",
            "  on exception All Exceptions log: " + At(handler) + "\n    end " + At(end) + "\n",
            "  unreached:\n",
            "    Customers_CS.GetCustomer() " + At(island) + "\n      @{Name=\"\"}\n    navigate Home() " + At(navigate) + "\n      @{Transition=Fade}\n",
            "    end " + At(otherEnd) + "\n" })
            Assert.Contains(expected, text);
        // The ids name the model keys; the Start node is "start" (one per action, never written).
        Assert.Equal(start.Key, entry.Ids["start"]);
        // Derived and default values are not written: the parameter Type, the aggregate's operation tree and output type,
        // the calculated column's type, NodesWithinCycle, the default AnimationEffect and DateFormat, the empty argument.
        foreach (var absent in new[] { "Type=", "RootOperation", "NodesWithinCycle", "AnimationEffect", "DateFormat", "Extra", "SourceOperation" })
            Assert.DoesNotContain(absent, text);
    }

    [Fact]
    public void TheParsedTextIsTheSameActionAndAnyEditIsSeen()
    {
        var (root, action) = Module();
        var item = ModuleFlow.Extract(root, new Reader(), action, out var problems);
        Assert.Empty(problems);
        var document = ModuleFlow.Print(item);
        var parsed = ModuleFlow.Read(document.Text, document.Keys);
        Assert.Equal(item.Canon(), parsed.Canon());
        Assert.Equal(document.Text, ModuleFlow.Print(parsed).Text);
        // Without the id table the text still reads: the ids stay as written (a text the model wrote has new elements).
        var bare = ModuleFlow.Read(document.Text);
        Assert.Equal(item.Items.Count(i => i.Role == "node"), bare.Items.Count(i => i.Role == "node"));
        // Every kind of edit changes the model the text reads to: an expression, a label, a connector, a description,
        // an argument, a parameter's type, a part of an aggregate.
        foreach (var (from, to) in new[] { ("Total + 1", "Total + 2"), ("# Each line", "# Every line"), ("case Total > 3:\n        next", "case Total > 3:\n        -> @n1"),
            ("/// the code", "/// the order code"), ("GetCustomer(Code)", "GetCustomer(Code=Code + \"\")"), ("in Q: Integer", "in Q: Long Integer"), ("WHERE (Order.Code = Code)", "WHERE (Order.Code <> Code)") }) {
            Assert.Contains(from, document.Text);
            var edited = ModuleFlow.Read(document.Text.Replace(from, to), document.Keys);
            Assert.NotEqual(item.Canon(), edited.Canon());
        }
    }

    // The example of docs/TEXTO-LOGICA.md is what the printer writes: read without an id table and printed again, it is
    // the same text.
    [Fact]
    public void TheDocumentedExampleIsTheGrammar()
    {
        var root = TextRoundTripCorpus.Root();
        Assert.NotNull(root);
        var doc = File.ReadAllText(Path.Combine(root!, "docs", "TEXTO-LOGICA.md")).Replace("\r\n", "\n");
        var start = doc.IndexOf("```\n", doc.IndexOf("## Forma", StringComparison.Ordinal), StringComparison.Ordinal) + 4;
        var example = doc[start..doc.IndexOf("```", start, StringComparison.Ordinal)];
        var action = ModuleFlow.Read(example);
        Assert.Equal(example, ModuleFlow.Print(action).Text);
        Assert.Equal(11, action.Items.Count(i => i.Role == "node" && i.Kind != "StartNode"));
    }

    [Fact]
    public void TextTheGrammarDoesNotAcceptIsRefusedWithItsLine()
    {
        var head = "server action A @Akey\n";
        foreach (var (body, line, words) in new[] {
            ("  if X = 1 @n1\n", 2, "expected ':'"),
            ("   end @n1\n", 2, "multiple of two"),
            ("  next\n", 2, "next outside a foreach"),
            ("  assign X = 1 @n1\n  assign Y = 2 @n1\n", 3, "written twice"),
            ("  Foo(A=1 @n1\n", 2, "expected ')' to close the arguments"),
            ("  Foo(A=(1 @n1\n", 2, "unbalanced"),
            ("  end @n1\n  extra\n", 3, "unexpected line"),
            ("  /// lost\n  -> @n2\n", 3, "description belongs"),
            ("  X = aggregate FROM Order WHERE Order.Id = 1 @n1\n", 2, "use: aggregate FROM Order WHERE (Order.Id = 1)") }) {
            // Every error of the text comes in the exception (FlowSyntaxException.Errors); the first is its message.
            var error = Assert.IsType<FlowSyntaxException>(Assert.ThrowsAny<FormatException>(() => ModuleFlow.Read(head + body)));
            Assert.Equal(error.Errors[0], error.Message);
            Assert.StartsWith("line " + line + ":", error.Message);
            Assert.Contains(words, error.Message);
        }
        Assert.Contains("unknown action flag", Assert.ThrowsAny<FormatException>(() => ModuleFlow.Read("server action A shared @Akey\n  end @n1\n")).Message);
    }

    [Fact]
    public void WhatTheReaderCannotCarryIsAProblemNeverASilentLoss()
    {
        var (root, action) = Module();
        var wait = action.Children.Single(c => c.Kind == "WaitNode");
        // A part of a kind the reader does not know, a value carrier whose text is not in its owner and a property that
        // fails to read: each one makes its node opaque ("opaque <Kind>": its name, key and connector only, never written
        // back), named with the reason; the rest of the action is still its text and a fixed point (LG2).
        wait.Add(N("Mystery", "Unknown"));
        action.Children.Single(c => c.Kind == "RaiseExceptionNode").Add(N("Expression")).Set("Text", new Code("\"another message\""));
        action.Children.Single(c => c.Kind == "TriggerNode").Set("Broken", new InvalidOperationException("no value"));
        var entry = Entry(root, action);
        Assert.True(entry.FixedPoint, string.Join("\n", entry.Problems) + "\n" + entry.Text);
        Assert.Contains("\n  opaque WaitNode @", entry.Text);
        Assert.Contains("\n    opaque RaiseExceptionNode end @", entry.Text);
        Assert.Contains("\n  opaque TriggerNode @", entry.Text);
        Assert.DoesNotContain("Timeout", entry.Text);
        Assert.Contains(entry.Opaque!, p => p.Contains("WaitNode: part Mystery of WaitNode is not read"));
        Assert.Contains(entry.Opaque!, p => p.Contains("RaiseExceptionNode: value Expression is not in the text of its RaiseExceptionNode"));
        Assert.Contains(entry.Opaque!, p => p.Contains("TriggerNode: read error TriggerNode.Broken"));
        // An opaque node with branches has no place in the text: the action is not a fixed point.
        var (root3, action3) = Module();
        action3.Children.Single(c => c.Kind == "IfNode").Add(N("Mystery", "Unknown"));
        Assert.Contains(Entry(root3, action3).Problems, p => p.Contains("opaque IfNode with connectors"));
        // A connector to a node of another action cannot be written.
        var (root2, action2) = Module();
        var foreign = root2.Add(N("ServerAction", "Other")).Add(N("EndNode"));
        action2.Children.Single(c => c.Kind == "WaitNode").Set("Target", foreign);
        Assert.Contains(Entry(root2, action2).Problems, p => p.Contains("points outside the action"));
    }

    // Defaults are what a new element has (measured in both Studios): a boolean is False when new, so its False is left
    // out; a new service action is public and shareable, so its False is authored and written, and its True is "public".
    [Fact]
    public void AFalseWhereANewElementIsTrueIsWrittenNeverLeftOutAsADefault()
    {
        keys = 0;
        var root = N("ESpace", "Quotes");
        Node Action(string kind, string name, bool shared)
        {
            var action = root.Add(N(kind, name)).Set("Public", shared).Set("Shareable", shared);
            var start = action.Add(N("StartNode")); var end = action.Add(N("EndNode"));
            start.Set("Target", end);
            return action;
        }
        var hidden = Action("ServiceAction", "Hidden", false); var open = Action("ServiceAction", "Open", true); var local = Action("ServerAction", "Local", false);
        var (hiddenEntry, openEntry, localEntry) = (Entry(root, hidden), Entry(root, open), Entry(root, local));
        foreach (var entry in new[] { hiddenEntry, openEntry, localEntry }) Assert.True(entry.FixedPoint, string.Join("\n", entry.Problems) + "\n" + entry.Text);
        Assert.StartsWith("service action Hidden @" + hidden.Key + "\n  @{Public=False}\n", hiddenEntry.Text);
        Assert.StartsWith("service action Open public @" + open.Key + "\n  end @n1\n", openEntry.Text);
        Assert.StartsWith("server action Local @" + local.Key + "\n  end @n1\n", localEntry.Text);
        Assert.Equal("False", ModuleFlow.Read(hiddenEntry.Text, hiddenEntry.Ids).Prop("Public"));
    }

    [Fact]
    public void TheTextDoesNotDependOnTheOrderTheModelListsChildren()
    {
        var (root, action) = Module();
        var first = Entry(root, action).Text;
        foreach (var node in new[] { action }.Concat(action.Children)) node.Children.Reverse();
        Assert.Equal(first, Entry(root, action).Text);
    }

    [Fact]
    public void StoredFlowIsTheSameFlowAndAnotherCaptureIsAMiss()
    {
        var (root, _) = Module();
        var flow = ModuleFlow.Build(root, new Reader(), "o11", "AB12", 100);
        Assert.Single(flow.Actions);
        var parsed = ModuleFlow.Parse(flow.ToJson("kernel"), "o11", "kernel", "ab12");
        Assert.Equal(flow.Actions.Select(a => (a.Key, a.Name, a.Text, a.FixedPoint, string.Join(",", a.Ids))),
            parsed.Actions.Select(a => (a.Key, a.Name, a.Text, a.FixedPoint, string.Join(",", a.Ids))));
        Assert.Equal(flow.NotWritten, parsed.NotWritten);
        Assert.Equal(flow.Summary().ToJsonString(), parsed.Summary().ToJsonString());
        Assert.Throws<InvalidDataException>(() => ModuleFlow.Parse(flow.ToJson("kernel"), "o11", "kernel", "cd34"));
        Assert.Throws<InvalidDataException>(() => ModuleFlow.Parse(flow.ToJson("kernel"), "odc", "kernel", "ab12"));
        // What the rules leave out is counted by rule.
        Assert.Equal(1, flow.NotWritten["InputParameter.Type (derived from DataType)"]);
        Assert.Equal(1, flow.NotWritten["CalculatedAttribute.DataType (derived column type)"]);
        Assert.Equal(1, flow.NotWritten["ForEachNode.NodesWithinCycle (derived from the connectors)"]);
    }
}

// The fixed point over the corpus of the plan (C:\Users\andre\SSAM-analises\html-do-ssam\PLANO.md 6.5 and 8, stage LG1):
// the 34 unique modules of tests/fixtures/text-roundtrip/corpus.json, each lane in its own test project. Every action is a
// fixed point with no problem; actions, nodes, node kinds and the authored values the digest of 16d95076 lost are counted
// against tests/fixtures/text-roundtrip/logic-expected.json (the plan's numbers, split by lane); the structure of the text
// is at most 25% above the digest and the median size per action stays within the lane's ceiling (descriptions and texts
// are whole, the digest cut them); one module is read twice and gives the same texts. The captures are read only and
// never copied into the repository: without them the test says so and returns.
public static class TextRoundTripCorpus
{
    // The authored values the plan's table 6.5 lists as lost by the digest: (kind, property, rule).
    // rule "present": the value is set; "long": the text does not fit one line of 160 characters (the digest clipped it).
    public static readonly (string Kind, string Property, string Rule)[] Counted = [
        ("AggregateNode", "Description", "present"), ("AggregateNode", "CacheInMinutes", "present"), ("AggregateNode", "StartIndex", "present"),
        ("ForEachNode", "StartIndex", "present"), ("CommentNode", "Text", "long"), ("RefreshDataNode", "MaxRecords", "present"),
        ("RefreshDataNode", "StartIndex", "present"), ("DestinationNode", "Transition", "present"), ("JavaScriptNode", "JavaScript", "long"),
        ("JavaScriptNode", "Description", "present"), ("JavaScriptNode", "IsAsynchronous", "present"), ("TriggerNode", "Description", "present"),
        ("JSONDeserializeNode", "Description", "present"), ("MessageNode", "Label", "present"), ("JSONSerializeNode", "SerializeDefaultValues", "present"),
        ("JSONSerializeNode", "Description", "present"), ("SQLNode", "Description", "present"), ("ExcelToRecordListNode", "Description", "present"),
        ("AjaxRefreshNode", "AnimationEffect", "present"), ("ServerAction", "Description", "long"), ("ScreenAction", "Description", "long"),
        ("ClientAction", "Description", "long"), ("DataAction", "Description", "long"), ("InputParameter", "Description", "present"),
        ("InputParameter", "DefaultValue", "present"), ("OutputParameter", "Description", "present"), ("LocalVariable", "Description", "present"),
        ("SQLInputParameter", "DataType", "present")];

    private static bool FitsLine(string text) => text.Length <= 160 && !text.Contains('\r') && !text.Contains('\n') && !System.Text.RegularExpressions.Regex.IsMatch(text, @"\s{2,}");

    public static string? Root()
    {
        var dir = Path.GetDirectoryName(typeof(TextRoundTripCorpus).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "kernel", "tests", "fixtures", "text-roundtrip", "corpus.json"))) dir = Path.GetDirectoryName(dir);
        return dir;
    }

    // build: the lane's ModelHost.BuildFlow over the capture bytes, with the visitor of every action's model.
    public static void Run(string lane, Func<byte[], string, Action<FlowItem>, ModuleFlow> build, ITestOutputHelper output)
    {
        var root = Root() ?? throw new InvalidOperationException("tests/fixtures/text-roundtrip not found above " + typeof(TextRoundTripCorpus).Assembly.Location);
        var fixtures = Path.Combine(root, "kernel", "tests", "fixtures", "text-roundtrip");
        var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(fixtures, "corpus.json")))!.AsArray();
        var expected = JsonNode.Parse(File.ReadAllText(Path.Combine(fixtures, "logic-expected.json")))!["lanes"]![lane]!.AsObject();
        var modules = manifest.Select(m => m!.AsObject()).Where(m => m["lane"]!.GetValue<string>() == lane).ToList();
        var missing = modules.Where(m => !File.Exists(m["oml"]!.GetValue<string>())).Select(m => m["oml"]!.GetValue<string>()).ToList();
        if (missing.Count > 0) {
            output.WriteLine("WARNING: the corpus of the plan is not on this machine (" + missing.Count + " of " + modules.Count + " captures missing, first "
                + missing[0] + "); the corpus fixed point was not checked.");
            return;
        }
        var nodeKinds = new SortedDictionary<string, int>(StringComparer.Ordinal);
        var counted = new SortedDictionary<string, int>(StringComparer.Ordinal);
        var notWritten = new SortedDictionary<string, int>(StringComparer.Ordinal);
        int actions = 0, nodes = 0, fixedPoints = 0; long flowBytes = 0, digestBytes = 0, structureBytes = 0;
        var ratios = new List<double>(); var failures = new List<string>();
        // The structure of the text: every line but descriptions, comments and their continuation lines (the whole texts
        // the digest cut or never showed).
        static long Structure(string text) => text.Split('\n').Where(l => l.Length > 0 && !l.TrimStart().StartsWith("//", StringComparison.Ordinal)
            && !l.TrimStart().StartsWith('|')).Sum(l => (long)System.Text.Encoding.UTF8.GetByteCount(l) + 1);
        void Visit(FlowItem item)
        {
            void Count(FlowItem element)
            {
                foreach (var (kind, property, rule) in Counted)
                    if (element.Kind == kind && element.Prop(property) is { } value && (rule == "present" || !FitsLine(value)))
                        counted[kind + "." + property + (rule == "long" ? " (long)" : "")] = counted.GetValueOrDefault(kind + "." + property + (rule == "long" ? " (long)" : "")) + 1;
                foreach (var child in element.Items) Count(child);
            }
            Count(item);
            foreach (var node in item.Items.Where(i => i.Role == "node")) nodeKinds[node.Kind] = nodeKinds.GetValueOrDefault(node.Kind) + 1;
        }
        foreach (var module in modules) {
            var file = module["oml"]!.GetValue<string>();
            var bytes = File.ReadAllBytes(file);
            var sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
            Assert.Equal(module["sha"]!.GetValue<string>(), sha256);
            var started = DateTime.UtcNow;
            var flow = build(bytes, sha256, Visit);
            // The same bytes read again give the same texts and ids (the Model API may list children in another order).
            if (expected["twice"]?.GetValue<string>() == module["label"]!.GetValue<string>()) {
                var again = build(bytes, sha256, _ => { });
                Assert.Equal(flow.Actions.Select(a => a.Key + "\n" + a.Text + string.Join(",", a.Ids)), again.Actions.Select(a => a.Key + "\n" + a.Text + string.Join(",", a.Ids)));
            }
            foreach (var (rule, count) in flow.NotWritten) notWritten[rule] = notWritten.GetValueOrDefault(rule) + count;
            foreach (var action in flow.Actions) {
                actions++; nodes += action.Nodes; flowBytes += action.Bytes; digestBytes += action.DigestBytes; structureBytes += Structure(action.Text);
                if (action.DigestBytes > 0) ratios.Add((double)action.Bytes / action.DigestBytes);
                if (action.FixedPoint) fixedPoints++;
                else failures.Add(module["label"] + " " + action.Name + ": " + string.Join(" | ", action.Problems.Take(3)));
            }
            output.WriteLine(module["label"] + ": " + flow.Actions.Count + " actions, " + flow.Actions.Count(a => a.FixedPoint) + " fixed points, "
                + (DateTime.UtcNow - started).TotalSeconds.ToString("0.0") + " s");
        }
        ratios.Sort();
        var median = ratios.Count == 0 ? 0 : ratios[ratios.Count / 2];
        var summary = new JsonObject {
            ["lane"] = lane, ["modules"] = modules.Count, ["actions"] = actions, ["nodes"] = nodes, ["fixedPoints"] = fixedPoints,
            ["flowBytes"] = flowBytes, ["digestBytes"] = digestBytes, ["ratio"] = Math.Round((double)flowBytes / Math.Max(1, digestBytes), 4),
            ["structureBytes"] = structureBytes, ["structureRatio"] = Math.Round((double)structureBytes / Math.Max(1, digestBytes), 4),
            ["medianRatio"] = Math.Round(median, 4), ["p90Ratio"] = ratios.Count == 0 ? 0 : Math.Round(ratios[(int)(ratios.Count * 0.9)], 4),
            ["nodeKinds"] = new JsonObject(nodeKinds.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["counted"] = new JsonObject(counted.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))),
            ["notWritten"] = new JsonObject(notWritten.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value))) };
        output.WriteLine(summary.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Assert.True(failures.Count == 0, failures.Count + " actions are not a fixed point:\n" + string.Join("\n", failures.Take(20)));
        Assert.Equal(expected["actions"]!.GetValue<int>(), actions);
        Assert.Equal(expected["nodes"]!.GetValue<int>(), nodes);
        foreach (var (kind, count) in expected["nodeKinds"]!.AsObject()) Assert.True(nodeKinds.GetValueOrDefault(kind) == count!.GetValue<int>(), kind + ": " + nodeKinds.GetValueOrDefault(kind) + " nodes, expected " + count);
        foreach (var (key, count) in expected["counted"]!.AsObject()) Assert.True(counted.GetValueOrDefault(key) == count!.GetValue<int>(), key + ": " + counted.GetValueOrDefault(key) + ", expected " + count);
        var maxMedian = expected["maxMedianRatio"]!.GetValue<double>(); var maxStructure = expected["maxStructureRatio"]!.GetValue<double>();
        Assert.True(median <= maxMedian, "median size per action is " + median.ToString("0.000") + " times the digest's (at most " + maxMedian + ")");
        var structure = (double)structureBytes / Math.Max(1, digestBytes);
        Assert.True(structure <= maxStructure, "the structure of the texts is " + structure.ToString("0.000") + " times the digest (at most " + maxStructure + ")");
    }
}
