using System.Text.Json.Nodes;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects: C2 of the plan "Texto do SSAM" (ScreenHtmlEdit) over a module through the reader contract
// and a writer of the same model. An edit of the reading (the changed elements with their k) is merged into the text, checked
// at once (every refusal in one answer, with its patch when there is one), written with the few native moves it needs and read
// back: the module reads the edited text, every element the edit kept keeps its key.
public sealed class ScreenHtmlEditTests
{
    private sealed class Node(string key, string kind, string name = "", params string[] kinds)
    {
        public string Key = key, Kind = kind, Name = name;
        public readonly HashSet<string> Kinds = [.. kinds.Append(kind).SelectMany(k => new[] { k, "I" + k })];
        public Node? Parent;
        public List<Node> Children = [];
        public Dictionary<string, object?> Props = [];
        public Node Add(Node child) { child.Parent = this; Children.Add(child); return child; }
        public Node Set(string property, object? value) { Props[property] = value; if (property == "Name" && value is string s) Name = s; return this; }
    }
    private sealed record Code(string Text);
    private sealed class Reader : ModelReader<Node>
    {
        protected override IEnumerable<Node> Referrers(Node n) => [];
        protected override IEnumerable<Node> Children(Node n) => n.Children;
        protected override Node? Parent(Node n) => n.Parent;
        protected override string Key(Node n) => n.Key;
        protected override string Kind(Node n) => n.Kind;
        protected override string Name(Node n) => n.Name;
        protected override string? Label(Node n) => null;
        protected override IReadOnlySet<string> KindNames(Node n) => n.Kinds;
        protected override string? Expression(object value) => (value as Code)?.Text;
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Node n) => n.Props.ToList().Select(p => (p.Key, (Func<object?>)(() => p.Value)));
    }

    private static int keys;
    private static Node N(string kind, string name = "", params string[] kinds)
    {
        var node = new Node("K" + (++keys).ToString("D4"), kind, name, kinds);
        if (name.Length > 0) node.Props["Name"] = name;
        return node;
    }
    private static Node W(string kind, string name = "") => N(kind, name, "Widget");
    private static Node Event(Node widget, string property)
    {
        var e = widget.Add(N("UILifeCycleEvent"));
        widget.Set(property, e);
        return e;
    }

    // The writer of this model: what the kernel's writer does over the Model API (ModelSession), on these nodes.
    private sealed class Writer : IScreenHtmlWriter<Node>
    {
        public readonly List<string> Log = [];
        public Node Create(Node parent, string kind, Node? block)
        {
            Log.Add("create " + kind);
            var node = kind is "ExtendedProperty" or "Event" or "LocalVariable" or "InputParameter" or "Argument" ? N(kind) : W(kind);
            parent.Add(node);
            switch (kind) {
                case "IfWidget": node.Set("TrueBranch", node.Add(W("IfBranchWidget"))).Set("FalseBranch", node.Add(W("IfBranchWidget"))); break;
                case "Link" or "Button": Event(node, "OnClick"); break;
                case "Input": Event(node, "OnChange"); break;
                case "ExtendedProperty":
                    node.Set("Property", "").Set("Value", new Code(""));
                    if (parent.Props.GetValueOrDefault("ExtendedProperties") is not List<Node> list) parent.Set("ExtendedProperties", list = []);
                    list.Add(node);
                    break;
                case "MobileBlockInstanceWidget":
                    node.Set("SourceBlock", block);
                    foreach (var holder in Descendants(block!).Where(d => d.Kind == "PlaceholderWidget")) node.Add(W("PlaceholderContentWidget")).Set("Placeholder", holder);
                    break;
            }
            return node;
        }
        public void Set(Node node, string property, ScreenHtmlValue<Node> value)
        {
            Log.Add("set " + property);
            object? written = value.Type switch {
                'e' => new Code(value.Text), 'b' => value.Text == "True", '?' => null, 'r' => value.Target ?? (object)new Node("~", "Outside", value.Name ?? ""),
                'l' => value.Targets?.ToList(), _ => value.Text };
            if (written == null) node.Props.Remove(property); else node.Set(property, written);
            // An event that gets a destination gets one argument per input of it (the platform's own).
            if (property == "Destination" && written is Node target)
                foreach (var input in target.Children.Where(c => c.Kind == "InputParameter"))
                    if (!node.Children.Any(a => a.Props.GetValueOrDefault("Parameter") == input)) node.Add(N("Argument")).Set("Parameter", input);
        }
        public void Rename(Node node, string name) { Log.Add("rename"); node.Set("Name", name); }
        public void Delete(Node node)
        {
            Log.Add("delete " + node.Kind);
            node.Parent!.Children.Remove(node);
            if (node.Parent.Props.GetValueOrDefault("ExtendedProperties") is List<Node> list) list.Remove(node);
        }
        public Node Move(Node node, Node parent) { Log.Add("move"); node.Parent!.Children.Remove(node); parent.Add(node); return node; }
        public void Place(Node node, Node? after)
        {
            Log.Add("place");
            var siblings = node.Parent!.Children;
            siblings.Remove(node);
            siblings.Insert(after == null ? 0 : siblings.IndexOf(after) + 1, node);
        }
        public Node? Replacement(Node node) => null;
        private static IEnumerable<Node> Descendants(Node node) { foreach (var c in node.Children) { yield return c; foreach (var d in Descendants(c)) yield return d; } }
    }

    // A module with a block and a screen: the constructions of the page (data, a container with an input and its event, an If
    // with a list and a link with an argument, an HTML element with extended properties, a block instance with its slot, a
    // Visible that is not True, a table).
    private static Node Module()
    {
        keys = 0;
        var module = N("ESpace", "Shop");
        var text = new Node("T-Text", "BasicType", "Text"); var id = new Node("T-Id", "BasicType", "Long Integer");
        var flow = module.Add(N("MobileFlow", "MainFlow"));
        var block = flow.Add(N("MobileBlock", "Card"));
        var title = block.Add(N("InputParameter", "Title")).Set("DataType", text);
        block.Set("InputParameters", new List<Node> { title });
        block.Add(W("PlaceholderWidget", "Content"));
        var screen = flow.Add(N("MobileScreen", "Orders"));
        var search = screen.Add(N("LocalVariable", "Search")).Set("DataType", text);
        var page = screen.Add(N("LocalVariable", "Page")).Set("DataType", id);
        screen.Set("LocalVariables", new List<Node> { search, page });
        var refresh = screen.Add(N("ScreenAction", "Refresh"));
        var open = screen.Add(N("ScreenAction", "Open"));
        var openId = open.Add(N("InputParameter", "Id")).Set("DataType", id);
        screen.Add(N("ScreenAction", "Clear"));
        var toolbar = screen.Add(W("Container", "Toolbar")).Set("Style", new Code("\"toolbar\""));
        var input = toolbar.Add(W("Input")).Set("Variable", new Code("Search"));
        Event(input, "OnChange").Set("Destination", refresh);
        toolbar.Add(W("TextWidget")).Set("Text", "Find");
        toolbar.Add(W("Expression")).Set("Value", new Code("Search"));
        var empty = screen.Add(W("IfWidget")).Set("Condition", new Code("Page = 0"));
        var yes = empty.Add(W("IfBranchWidget")); var no = empty.Add(W("IfBranchWidget"));
        empty.Set("TrueBranch", yes).Set("FalseBranch", no);
        yes.Add(W("TextWidget")).Set("Text", "No orders.");
        var list = no.Add(W("List", "Rows")).Set("Source", new Code("GetOrders.List"));
        var link = list.Add(W("Link")).Set("Style", new Code("\"row\""));
        Event(link, "OnClick").Set("Destination", open).Add(N("Argument")).Set("Parameter", openId).Set("Value", new Code("Page"));
        link.Add(W("Expression")).Set("Value", new Code("Search"));
        var section = screen.Add(W("AdvancedHtml")).Set("Tag", "section");
        var role = section.Add(N("ExtendedProperty")).Set("Property", "role").Set("Value", new Code("\"region\""));
        section.Set("ExtendedProperties", new List<Node> { role });
        section.Add(W("Container")).Set("Style", new Code("\"a\""));
        section.Add(W("Container")).Set("Style", new Code("\"b\""));
        var card = screen.Add(W("MobileBlockInstanceWidget")).Set("SourceBlock", block);
        card.Add(N("Argument")).Set("Parameter", title).Set("Value", new Code("\"Total\""));
        card.Add(W("PlaceholderContentWidget")).Set("Placeholder", block.Children.Last()).Add(W("TextWidget")).Set("Text", "Body");
        screen.Add(W("Container", "Hidden")).Set("Visible", new Code("Page > 0"));
        screen.Add(W("TableRecords", "Grid")).Add(W("HeaderCell")).Add(W("TextWidget")).Set("Text", "Header");
        return module;
    }

    private static (ScreenHtmlModule<Node> Reading, ScreenHtmlDocument Document) Read(Node module, string target = "Orders")
    {
        var reading = ScreenHtml.Module(module, new Reader());
        return (reading, reading.Read(target));
    }

    // Plan, apply and read back; the answer of the edit and the text read after it.
    private static (ScreenHtmlEditResult Result, string After, Writer Writer) Apply(Node module, IReadOnlyList<string> edits, string target = "Orders")
    {
        var (reading, document) = Read(module, target);
        var plan = reading.Edit(document, edits);
        var writer = new Writer();
        if (!plan.Refused) plan.Apply(writer);
        if (!plan.Refused) plan.Verify(reading.Refresh(document.RootKey).Read(target));
        return (plan.Result, ScreenHtml.Module(module, new Reader()).Read(target).Html, writer);
    }

    private static string Line(string html, string k) => html.Split('\n').First(l => l.Contains(" k=\"" + k + "\"", StringComparison.Ordinal)).Trim();
    private static string Codes(ScreenHtmlEditResult result) => string.Join(", ", result.Problems.Select(p => p["code"]!.ToString()));

    [Fact]
    public void EverySyntheticEditOfTheScreenAndTheBlockReadsBackAsTheEditedText()
    {
        var count = 0;
        foreach (var target in new[] { "Orders", "Card" })
            foreach (var seed in Enumerable.Range(1, 4)) {
                var (_, document) = Read(Module(), target);
                foreach (var edit in ScreenHtmlEditBattery.Generate(document, seed, perKind: 2)) {
                    var module = Module();
                    var (result, after, _) = Apply(module, edit.Edits, target);
                    Assert.False(result.Refused, edit.Kind + " " + edit.Note + ": " + string.Join(" | ", result.Problems.Select(p => p["message"])));
                    Assert.Equal(edit.Expected, ScreenHtmlText.WithoutKeys(after));
                    count++;
                }
            }
        Assert.True(count >= 20, "edits " + count);
    }

    [Fact]
    public void AClassChangeIsOneSetAndEveryKeyStays()
    {
        var module = Module();
        var (_, before) = Read(module);
        var edited = Line(before.Html, "w3").Replace("class=\"toolbar\"", "class=\"toolbar compact\"");
        var toolbar = before.Html.Split('\n').SkipWhile(l => !l.Contains("k=\"w3\"")).TakeWhile(l => !l.StartsWith("</div>")).ToList();
        var edit = string.Join("\n", toolbar.Skip(1).Prepend(edited)) + "\n</div>\n";
        var (result, after, writer) = Apply(module, [edit]);
        Assert.False(result.Refused, Codes(result));
        Assert.Equal(["set Style"], writer.Log);
        Assert.Equal(before.Html.Replace("class=\"toolbar\"", "class=\"toolbar compact\""), after);
        Assert.Equal(before.Keys, ScreenHtml.Module(module, new Reader()).Read("Orders").Keys);
    }

    [Fact]
    public void ANewChildARemovalASwapAndAnEventAreTheirOwnMoves()
    {
        var module = Module();
        var (_, before) = Read(module);
        // The section: a new paragraph between its two containers, swapped, its role removed.
        var section = "<section k=\"w8\">\n <div k=\"w10\" class=\"b\"/>\n <p class=\"new\">{{ \"x\" }}</p>\n <div k=\"w9\" class=\"a\"/>\n</section>\n";
        // The link: another destination (no argument).
        var link = Line(before.Html, "w7").Replace("onclick=\"Open(Id = Page)\"", "onclick=\"Clear\"");
        var (result, after, writer) = Apply(module, [section, link + "\n"]);
        Assert.False(result.Refused, Codes(result) + " " + string.Join(" | ", result.Problems.Select(p => p["message"])));
        Assert.Contains("<section k=\"w8\">\n <div k=\"w9\" class=\"b\"/>\n <p k=\"w10\" class=\"new\">{{ \"x\" }}</p>\n <div k=\"w11\" class=\"a\"/>\n</section>\n", after);
        Assert.Contains("onclick=\"Clear\"", after);
        Assert.Contains("delete ExtendedProperty", writer.Log);
        Assert.Contains("create AdvancedHtml", writer.Log);
        Assert.Contains("place", writer.Log);
        Assert.DoesNotContain(writer.Log, l => l.StartsWith("delete Container", StringComparison.Ordinal));
    }

    [Fact]
    public void AnElementWrappedInANewIfMovesIntoItsBranch()
    {
        var module = Module();
        var (_, before) = Read(module);
        var section = "<section k=\"w8\" role=\"region\">\n <div if=\"Page > 1\">\n  <div k=\"w9\" class=\"a\"/>\n </div>\n <div k=\"w10\" class=\"b\"/>\n</section>\n";
        var (result, after, writer) = Apply(module, [section]);
        Assert.False(result.Refused, Codes(result));
        Assert.Contains("<section k=\"w8\" role=\"region\">\n <div k=\"w9\" if=\"Page > 1\">\n  <div k=\"w10\" class=\"a\"/>\n </div>\n <div k=\"w11\" class=\"b\"/>\n</section>\n", after);
        Assert.Equal(["create IfWidget", "move"], writer.Log.Where(l => l is "create IfWidget" or "move"));
    }

    [Fact]
    public void AnIfIsEditedWithItsElseAndTheStyleIsTheStyleSheet()
    {
        var module = Module();
        var (_, before) = Read(module);
        var lines = before.Html.Split('\n');
        var start = Array.FindIndex(lines, l => l.Contains("k=\"w5\""));
        var end = Array.FindIndex(lines, Array.FindIndex(lines, start, l => l == "<div else>"), l => l == "</div>");
        var ifElse = string.Join("\n", lines[start..(end + 1)]).Replace("No orders.", "Nothing yet.") + "\n";
        var (result, after, _) = Apply(module, [ifElse, "<style>.x { color: red; }</style>"]);
        Assert.False(result.Refused, Codes(result) + " " + string.Join(" | ", result.Problems.Select(p => p["message"])));
        Assert.Contains("Nothing yet.", after);
        Assert.Contains("<style>.x { color: red; }</style>", after);
    }

    [Fact]
    public void EveryProblemOfAnEditComesInOneAnswerWithItsFix()
    {
        var module = Module();
        var (reading, document) = Read(module);
        var html = document.Html;
        var plan = reading.Edit(document, [
            "<div class=\"no-key\"/>",                                                           // no k
            "<div k=\"w99\"/>",                                                                   // a k the reading never wrote
            Line(html, "w13").Replace("kind=\"TableRecords\"", "kind=\"Container\"") + "</os-opaque>\n",  // an opaque node changed
            Line(html, "w7").Replace("onclick=\"Open(Id = Page)\"", "onclick=\"Refrsh\"") + "\n",  // a name that names nothing
            Line(html, "w9").Replace("/>", " os-Visible=\"Page = 1\"/>", StringComparison.Ordinal) + "\n",
        ]);
        Assert.True(plan.Refused);
        var codes = plan.Result.Problems.Select(p => p["code"]!.ToString()).ToList();
        foreach (var code in new[] { ScreenHtmlEdit.NoKey, ScreenHtmlEdit.KeyForeign }) Assert.Contains(code, codes);
        // The merge stops at its own problems; the rest come once the edits merge.
        var second = reading.Edit(document, [
            Line(html, "w13").Replace("kind=\"TableRecords\"", "kind=\"Container\"").Replace("\">", "\"/>") + "\n",
            Line(html, "w7").Replace("onclick=\"Open(Id = Page)\"", "onclick=\"Refrsh\"") + "\n",
            Line(html, "w9").Replace("/>", " os-Visible=\"Page = 1\"/>") + "\n",
            Line(html, "w10").Replace("/>", " data-x='{{ JSONSerialize(Page) }}'/>") + "\n",
        ]);
        var problems = second.Result.Problems.GroupBy(p => p["code"]!.ToString()).ToDictionary(g => g.Key, g => g.First());
        Assert.Contains(ScreenHtmlEdit.OpaqueTouched, problems.Keys);
        Assert.Equal("write 'Refresh'", problems[ScreenHtmlEdit.NameUnknown]["fix"]!.ToString());
        Assert.Contains(ScreenHtmlEdit.Json, problems.Keys);
        // Visible is never written new: the patch is the edit with an If around the element, and it plans clean.
        var visible = problems[ScreenHtmlEdit.Visible];
        var patched = visible["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
        Assert.Contains(patched, e => e.Contains("<div if=\"Page = 1\">", StringComparison.Ordinal) && !e.Contains("os-Visible", StringComparison.Ordinal));
    }

    [Fact]
    public void AVisibleTheReadingHadIsKeptAndListed()
    {
        var module = Module();
        var (_, before) = Read(module);
        var hidden = Line(before.Html, "w12").Replace("os-Visible", "class=\"kept\" os-Visible") + "\n";
        var (result, after, _) = Apply(module, [hidden]);
        Assert.False(result.Refused, Codes(result));
        Assert.Equal("w12", result.VisiblePreserved.Single()["k"]!.ToString());
        Assert.Contains("class=\"kept\" os-Visible=\"Page > 0\"", after);
    }

    [Fact]
    public void TheActionsAndAScriptAreRefusedAndTheParserSaysWhere()
    {
        var module = Module();
        var (reading, document) = Read(module);
        var first = document.Html.Split('\n')[0];
        var whole = document.Html.Replace(first, first.Replace("actions=\"Clear, Open, Refresh\"", "actions=\"Clear, Open, Refresh, Save\""));
        Assert.Contains(ScreenHtmlEdit.ActionsListed, Codes(reading.Edit(document, [whole]).Result));
        var script = reading.Edit(document, [Line(document.Html, "w9").Replace("/>", " onclick=\"alert('x'); return false\"/>") + "\n"]);
        Assert.Contains(ScreenHtmlEdit.Script, Codes(script.Result));
        var broken = reading.Edit(document, ["<div k=\"w9\" class=\"a\">"]);
        Assert.Contains("unclosed <div>", broken.Result.Problems.Single()["message"]!.ToString());
        // Without the module: the shape and the text of the op, every problem at once.
        var error = Assert.ThrowsAny<Exception>(() => ScreenHtmlEdit.Preflight(new JsonObject { ["edit"] = new JsonArray("<div class=\"x\"/>", "<p>") }));
        var preflight = (JsonArray)error.GetType().GetProperty("Problems")!.GetValue(error)!;
        Assert.Equal(["/screen", "/basedOn", "/edit/0", "/edit/1"], preflight.Select(p => p!["pointer"]!.ToString()).ToArray());
    }

    [Fact]
    public void TheScriptsAndAForeignIterationOfAnEditComeOnceWithOneCheckedPatch()
    {
        // B3 (conferência of 2026-10-12): HTML_SCRIPT had no patch and v-for passed as an attribute. A <script> goes, a javascript:
        // event goes back to the reading's, an event that is no call goes, a v-for over a list of the page becomes the List; one
        // corrected edit list on each of them, and it plans clean.
        var module = Module();
        var screen = module.Children[0].Children.First(c => c.Kind == "MobileScreen");
        var tags = screen.Add(N("LocalVariable", "Tags")).Set("DataType", new Node("T-TextList", "ListType", "Text List"));
        ((List<Node>)screen.Props["LocalVariables"]!).Add(tags);
        var (reading, document) = Read(module);
        var html = document.Html;
        Assert.Contains("<var k=\"w3\" name=\"Tags\" type=\"Text List\"/>", html);
        var edited = html.Replace("onclick=\"Open(Id = Page)\"", "onclick=\"javascript:go()\"")
            .Replace("</screen>", "<ul class=\"tags\"><li v-for=\"t in Tags\">{{ t }}</li></ul>\n<span onclick=\"this.x = 1; go()\">y</span>\n<script>alert(1)</script>\n</screen>");
        var plan = reading.Edit(document, [edited]);
        Assert.True(plan.Refused);
        var problems = plan.Result.Problems;
        Assert.Equal(3, problems.Count(p => p["code"]!.ToString() == ScreenHtmlEdit.Script));
        Assert.Single(problems, p => p["code"]!.ToString() == ScreenHtmlEdit.ForEach);
        Assert.DoesNotContain(problems, p => p["code"]!.ToString() == ScreenHtmlEdit.Invalid);   // the javascript: event said once, as a script
        Assert.All(problems, p => Assert.NotNull(p["patch"]));
        Assert.Single(problems.Select(p => p["patch"]!.ToJsonString()).Distinct());
        var corrected = problems[0]["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
        var text = string.Join("\n", corrected);
        Assert.Contains("onclick=\"Open(Id = Page)\"", text);
        Assert.Contains("<li list=\"Tags\">{{ Tags.Current }}</li>", text);
        Assert.DoesNotContain("<script", text);
        Assert.DoesNotContain("javascript:", text);
        Assert.DoesNotContain("this.x", text);
        Assert.False(reading.Edit(document, corrected).Refused, Codes(reading.Edit(document, corrected).Result));
        // A v-for over a name the page does not have: no certain List; the scripts keep their patch.
        var unknown = reading.Edit(document, [edited.Replace("v-for=\"t in Tags\"", "v-for=\"t in Labels\"")]).Result.Problems;
        Assert.Null(unknown.Single(p => p["code"]!.ToString() == ScreenHtmlEdit.ForEach)["patch"]);
        Assert.All(unknown.Where(p => p["code"]!.ToString() == ScreenHtmlEdit.Script), p => Assert.NotNull(p["patch"]));
        // Without the module (the preflight of the job): a new element's iteration and script event are said with the <script>.
        var error = Assert.ThrowsAny<Exception>(() => ScreenHtmlEdit.Preflight(new JsonObject { ["screen"] = "Orders",
            ["basedOn"] = new JsonObject { ["capture"] = "a", ["html"] = "b" }, ["edit"] = new JsonArray(edited) }));
        var preflight = ((JsonArray)error.GetType().GetProperty("Problems")!.GetValue(error)!).Select(p => p!["code"]!.ToString()).ToList();
        Assert.Equal([ScreenHtmlEdit.ForEach, ScreenHtmlEdit.Script, ScreenHtmlEdit.Script], preflight.Order());
    }

    // The review of rounds 1 and 2 (k1, k2): an edit inside the element a later edit writes again was lost with the old subtree
    // (the new Visible of w9 gone, the job accepted); in the other order it was already HTML_EDIT_OVERLAP. Now both orders.
    [Fact]
    public void AnEditInsideAnElementALaterEditWritesAgainIsRefusedInEitherOrder()
    {
        var module = Module();
        var (reading, document) = Read(module);
        var visible = Line(document.Html, "w9").Replace("/>", " os-Visible=\"Page = 1\"/>") + "\n";
        var section = "<section k=\"w8\" role=\"region\">\n <div k=\"w9\" class=\"a\"/>\n <div k=\"w10\" class=\"b\"/>\n</section>\n";
        foreach (var edits in new[] { new[] { visible, section }, new[] { section, visible } }) {
            var plan = reading.Edit(document, edits);
            Assert.True(plan.Refused);
            var problem = Assert.Single(plan.Result.Problems);
            Assert.Equal(ScreenHtmlEdit.Overlap, problem["code"]!.ToString());
            Assert.Equal("w9", problem["k"]!.ToString());
        }
        // Made inside the outer edit, the change goes with it: the new Visible is refused with its If patch, never lost.
        var together = reading.Edit(document, [section.Replace("<div k=\"w9\" class=\"a\"/>", "<div k=\"w9\" class=\"a\" os-Visible=\"Page = 1\"/>")]);
        Assert.Contains(ScreenHtmlEdit.Visible, Codes(together.Result));
    }

    // L5 judged on what an attribute is in the browser (reviews r1 and r2): ext:onmouseover, OnMouseOver, an iframe src written
    // as a constant {{ "javascript:..." }} and srcdoc went in. Each is HTML_SCRIPT with the patch that removes it, in the edit, in
    // the preflight of a new element and in the document form; the corrected edit list plans clean.
    [Fact]
    public void AScriptByExtAnotherCaseAnExpressionUrlOrSrcdocIsRefusedWithItsPatch()
    {
        var module = Module();
        var (reading, document) = Read(module);
        var w9 = Line(document.Html, "w9");
        var section = "<section k=\"w8\" role=\"region\">\n <div k=\"w9\" class=\"a\"/>\n <div k=\"w10\" class=\"b\"/>\n"
            + " <iframe src='{{ \"javascript:alert(1)\" }}'/>\n <iframe srcdoc=\"&lt;script&gt;alert(1)&lt;/script&gt;\"/>\n</section>\n";
        foreach (var attribute in new[] { "ext:onmouseover=\"alert(1)\"", "OnMouseOver=\"alert(1)\"", "ONMOUSEOVER=\"alert(1)\"" }) {
            var plan = reading.Edit(document, [w9.Replace("/>", " " + attribute + "/>") + "\n"]);
            var problem = Assert.Single(plan.Result.Problems);
            Assert.Equal(ScreenHtmlEdit.Script, problem["code"]!.ToString());
            var corrected = problem["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
            Assert.DoesNotContain("alert", string.Join("\n", corrected));
            Assert.False(reading.Edit(document, corrected).Refused);
        }
        var page = reading.Edit(document, [section]);
        var scripts = page.Result.Problems.Where(p => p["code"]!.ToString() == ScreenHtmlEdit.Script).ToList();
        Assert.Equal(2, scripts.Count);
        Assert.All(scripts, p => Assert.NotNull(p["patch"]));
        var fixedPage = scripts[0]["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
        Assert.DoesNotContain("javascript:", string.Join("\n", fixedPage));
        Assert.DoesNotContain("srcdoc", string.Join("\n", fixedPage));
        // Without the module: the new elements of the edit (the preflight of the job).
        var error = Assert.ThrowsAny<Exception>(() => ScreenHtmlEdit.Preflight(new JsonObject { ["screen"] = "Orders",
            ["basedOn"] = new JsonObject { ["capture"] = "a", ["html"] = "b" }, ["edit"] = new JsonArray(section) }));
        Assert.Equal(2, ((JsonArray)error.GetType().GetProperty("Problems")!.GetValue(error)!).Count(p => p!["code"]!.ToString() == ScreenHtmlEdit.Script));
        // The document form: the same four, each with the correction that removes it.
        var doc = DocumentProblems("<screen name=\"VerifScripts\">\n <span ext:onmouseover=\"alert(1)\">a</span>\n <span OnMouseOver=\"alert(1)\">b</span>\n"
            + " <iframe src='{{ \"javascript:alert(1)\" }}'/>\n <iframe srcdoc=\"&lt;script&gt;x&lt;/script&gt;\"/>\n</screen>\n");
        Assert.Equal(4, doc.Count(p => p!["code"]!.ToString() == "HTML_SCRIPT"));
    }

    // os-Visible in another case (review r2: he1, he2, he9, hd1, hd8): OS-VISIBLE and Os-Visible were kept as inert attributes (the
    // condition lost), os-visible failed at the setter with no patch and held back the other patches. Each is the new Visible it
    // means: HTML_VISIBLE with the If patch, with the patches of the other problems.
    [Fact]
    public void AVisibleInAnotherCaseIsTheNewVisibleWithItsIfPatch()
    {
        var module = Module();
        var (reading, document) = Read(module);
        foreach (var attribute in new[] { "OS-VISIBLE", "Os-Visible", "os-visible" }) {
            var plan = reading.Edit(document, [Line(document.Html, "w9").Replace("/>", " " + attribute + "=\"Page = 1\"/>") + "\n",
                Line(document.Html, "w10").Replace("/>", " onclick=\"this.x = 1; go()\"/>") + "\n"]);
            var problems = plan.Result.Problems;
            Assert.Contains(problems, p => p["code"]!.ToString() == ScreenHtmlEdit.Visible && p["message"]!.ToString().Contains(attribute, StringComparison.Ordinal));
            Assert.Contains(problems, p => p["code"]!.ToString() == ScreenHtmlEdit.Script);
            Assert.All(problems, p => Assert.NotNull(p["patch"]));
            var corrected = problems[0]["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
            var text = string.Join("\n", corrected);
            Assert.Contains("<div if=\"Page = 1\">", text);
            Assert.DoesNotContain(attribute + "=", text);
            Assert.False(reading.Edit(document, corrected).Refused, Codes(reading.Edit(document, corrected).Result));
        }
        var doc = DocumentProblems("<screen name=\"VerifCase\">\n <div OS-VISIBLE=\"1 = 1\">a</div>\n <div os-visible=\"2 = 2\">b</div>\n</screen>\n");
        Assert.Equal(2, doc.Count(p => p!["code"]!.ToString() == "HTML_VISIBLE"));
    }

    // The document form without a module (check-job): the problems of its refusal.
    private static JsonArray DocumentProblems(string html)
    {
        var error = Assert.ThrowsAny<Exception>(() => Anvil.Core.ScreenDocument.Preflight(html, "/html"));
        return (JsonArray)error.GetType().GetProperty("Problems")!.GetValue(error)!;
    }

    private static Node Find(Node node, Func<Node, bool> match) =>
        match(node) ? node : node.Children.Select(c => FindOrNull(c, match)).FirstOrDefault(n => n != null) ?? throw new InvalidOperationException("not found");
    private static Node? FindOrNull(Node node, Func<Node, bool> match) =>
        match(node) ? node : node.Children.Select(c => FindOrNull(c, match)).FirstOrDefault(n => n != null);
    private static Dictionary<string, string> Keys(ScreenHtmlDocument document) => document.Keys.GroupBy(k => k.Key).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);

    // Plan 3.4: an edit written on an older reading, after the Studio changed the screen. Base = that reading, local = the
    // screen now, foreign = the base with the edit: what only the Studio changed stays (the toolbar's class, a new container),
    // what only the edit changed is written (the input's event), the same attribute changed on both sides keeps the edit's and is
    // listed; an element the Studio removed and the edit changed is Missing (HTML_KEY_FOREIGN).
    [Fact]
    public void AnEditOfAnOlderReadingMergesThreeWaysAndKeepsWhatOnlyTheStudioChanged()
    {
        var module = Module();
        var (_, older) = Read(module);
        // The Studio, after that reading: the toolbar's class, the section's role, a new container at the end of the section.
        Find(module, n => n.Name == "Toolbar").Set("Style", new Code("\"toolbar dark\""));
        var section = Find(module, n => n.Kind == "AdvancedHtml");
        section.Children.First(c => c.Kind == "ExtendedProperty").Set("Value", new Code("\"complementary\""));
        section.Add(W("Container")).Set("Style", new Code("\"c\""));
        var (reading, current) = Read(module);
        Assert.NotEqual(older.HtmlSha256, current.HtmlSha256);
        // The edit, written on the older text: the toolbar whole (its old class) with another event on the input; the role.
        var toolbar = string.Join("\n", older.Html.Split('\n').SkipWhile(l => !l.Contains("k=\"w3\"")).TakeWhile(l => l != "</div>")) + "\n</div>\n";
        var edits = new[] { toolbar.Replace("onchange=\"Refresh\"", "onchange=\"Clear\""), "<section k=\"w8\" role=\"main\">\n <div k=\"w9\" class=\"a\"/>\n <div k=\"w10\" class=\"b\"/>\n</section>\n" };
        var merged = ScreenHtmlMerge.ThreeWay(older.Html, Keys(older), current.Html, Keys(current), edits);
        Assert.Empty(merged.Missing);
        Assert.NotNull(merged.Document);
        var conflict = Assert.Single(merged.Conflicts);
        Assert.Equal("role", conflict["what"]!.ToString());
        var plan = reading.Edit(current, [merged.Document!]);
        Assert.False(plan.Refused, Codes(plan.Result) + " " + string.Join(" | ", plan.Result.Problems.Select(p => p["message"])));
        var writer = new Writer();
        plan.Apply(writer);
        plan.Verify(reading.Refresh(current.RootKey).Read("Orders"));
        Assert.False(plan.Refused, string.Join(" | ", plan.Result.Problems.Select(p => p["message"])));
        var after = ScreenHtml.Module(module, new Reader()).Read("Orders").Html;
        Assert.Contains("<div k=\"w3\" id=\"Toolbar\" class=\"toolbar dark\">", after);
        Assert.Contains("onchange=\"Clear\"", after);
        Assert.Contains("<section k=\"w8\" role=\"main\">\n <div k=\"w9\" class=\"a\"/>\n <div k=\"w10\" class=\"b\"/>\n <div k=\"w11\" class=\"c\"/>\n</section>\n", after);
        // Only what the edit changed was written: the event's destination and the role, nothing recreated.
        Assert.Equal(["set Destination", "set Value"], writer.Log);

        // The Studio removed the hidden container; the older edit changed it: it cannot come back with its key.
        var hidden = Find(module, n => n.Name == "Hidden");
        hidden.Parent!.Children.Remove(hidden);
        var (_, now) = Read(module);
        var lost = ScreenHtmlMerge.ThreeWay(older.Html, Keys(older), now.Html, Keys(now), [Line(older.Html, "w12").Replace("os-Visible", "class=\"x\" os-Visible") + "\n"]);
        Assert.Equal(["w12"], lost.Missing);
        // An edit of an element the Studio did not touch, after another change elsewhere: a plain merge, no conflict.
        var plain = ScreenHtmlMerge.ThreeWay(older.Html, Keys(older), now.Html, Keys(now), [Line(older.Html, "w7").Replace("class=\"row\"", "class=\"row wide\"") + "\n"]);
        Assert.Empty(plain.Conflicts); Assert.Empty(plain.Missing);
        Assert.Contains("class=\"row wide\"", plain.Document);
        Assert.Contains("class=\"toolbar dark\"", plain.Document);
        Assert.DoesNotContain("id=\"Hidden\"", plain.Document);
    }

    [Fact]
    public void TheCanonicalWriterGivesTheTextItParsed()
    {
        foreach (var target in new[] { "Orders", "Card" }) {
            var (_, document) = Read(Module(), target);
            Assert.Equal(document.Html, ScreenHtmlText.Write(ScreenHtml.Parse(document.Html)));
        }
    }

    // The re-check of the 24.1 fixes (w1-nel-document): the space before a document and after its tag is the .NET \s (\t \n \v \f
    // \r, U+0085 and the separators), which the facade writes out as the same class (text-routes.mjs KERNEL_SPACE; its test pins
    // the facade to this table): a route set to false holds what the kernel runs as a document.
    [Fact]
    public void TheSpaceOfADocumentIsTheClassTheFacadeWritesOut()
    {
        static bool Space(char c) => "\t\n\v\f\r\u0085".Contains(c) || char.GetUnicodeCategory(c) is System.Globalization.UnicodeCategory.SpaceSeparator
            or System.Globalization.UnicodeCategory.LineSeparator or System.Globalization.UnicodeCategory.ParagraphSeparator;
        var wrong = new List<string>();
        for (var code = 0; code <= 0xFFFF; code++) {
            var c = (char)code;
            if (char.IsSurrogate(c)) continue;
            if (Anvil.Core.ScreenDocument.IsDocument(c + "<screen name=\"A\"></screen>") != Space(c)) wrong.Add("before U+" + code.ToString("X4"));
            if (Anvil.Core.ScreenDocument.IsDocument("<screen" + c + "name=\"A\"></screen>") != (Space(c) || c is '/' or '>')) wrong.Add("after U+" + code.ToString("X4"));
        }
        Assert.True(wrong.Count == 0, string.Join(", ", wrong.Take(20)));
        Assert.True(Anvil.Core.ScreenDocument.IsDocument("\u0085<screen name=\"A\"></screen>"));
        Assert.False(Anvil.Core.ScreenDocument.IsDocument("﻿<screen name=\"A\"></screen>"));
    }
}
