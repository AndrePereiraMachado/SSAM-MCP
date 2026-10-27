using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects. The session of 2026-10-18 (AgentOps, screen Audit, a second paginator for the chain table):
// an html edit of an existing screen was refused "the platform refused set Name: Widget does not support name changing" twice,
// with and without the ids of the elements it kept, and the fragment form refused the paginator's event as the reading writes
// it. The fixture is that screen in small: widgets with the names the html op generated (Div16, Span5), the Pagination block of
// OutSystems UI (StartIndex, MaxRecords, TotalCount; OnNavigate(NewStartIndex); Previous, Next) on the audit list, and a writer
// that does what the Studio does with names: a block instance is born with one slot per placeholder, named after it, and one
// handler per event; the name of a slot, an If branch or a Content is the Studio's ("Widget does not support name changing",
// the coverage matrix of fase2 in both lanes). The rule under test: an element with k keeps the name it has, a name the Studio
// does not let change is never written, and the text read back and written again is a fixed point (0 ops).
public sealed class ScreenHtmlEditNamesTests
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
        var node = new Node("N" + (++keys).ToString("D4"), kind, name, kinds);
        if (name.Length > 0) node.Props["Name"] = name;
        return node;
    }
    private static Node W(string kind, string name = "") => N(kind, name, "Widget");
    private static readonly HashSet<string> FixedNames = new(StringComparer.Ordinal) { "PlaceholderContentWidget", "IfBranchWidget", "Content" };

    // The Studio, where names are concerned (round 3: a lane whose slots are born with a null Name, and the uniqueness of a widget
    // name in its screen, which the Studio keeps by renaming a duplicate: refused here, so a name taken before it is let go shows).
    private sealed class Writer(bool nullSlotNames = false, bool uniqueNames = false) : IScreenHtmlWriter<Node>
    {
        public readonly List<string> Log = [];
        public Node Create(Node parent, string kind, Node? block, string? name = null)
        {
            Log.Add("create " + kind);
            var node = kind is "ExtendedProperty" or "Event" or "LocalVariable" or "InputParameter" or "Argument" ? N(kind, name ?? "") : W(kind, name ?? "");
            parent.Add(node);
            switch (kind) {
                case "IfWidget": node.Set("TrueBranch", node.Add(W("IfBranchWidget", "True"))).Set("FalseBranch", node.Add(W("IfBranchWidget", "False"))); break;
                case "MobileBlockInstanceWidget":
                    node.Set("SourceBlock", block);
                    foreach (var input in block!.Children.Where(c => c.Kind == "InputParameter")) node.Add(N("Argument")).Set("Parameter", input);
                    foreach (var evt in block.Children.Where(c => c.Kind == "BlockEvent")) node.Add(N("EventHandler")).Set("Event", evt);
                    foreach (var holder in block.Children.Where(c => c.Kind == "PlaceholderWidget")) node.Add(W("PlaceholderContentWidget", nullSlotNames ? "" : holder.Name)).Set("Placeholder", holder);
                    break;
            }
            return node;
        }
        public void Set(Node node, string property, ScreenHtmlValue<Node> value)
        {
            Log.Add("set " + property);
            if (property == "Name" && FixedNames.Contains(node.Kind)) throw new InvalidOperationException("Widget does not support name changing");
            if (uniqueNames && property == "Name" && value.Text.Length > 0 && ScreenOf(node) is { } screen && Widgets(screen).Any(w => w != node && w.Name == value.Text))
                throw new InvalidOperationException("Duplicated name " + value.Text + " in the screen");
            object? written = value.Type switch {
                'e' => new Code(value.Text), 'b' => value.Text == "True", '?' => null, 'r' => value.Target ?? (object)new Node("~", "Outside", value.Name ?? ""),
                'l' => value.Targets?.ToList(), _ => value.Text };
            if (written == null) node.Props.Remove(property); else node.Set(property, written);
            // An event or a handler that gets a destination gets one argument per input of it (the platform's own).
            if (property is "Destination" or "Handler" && written is Node target) {
                var inputs = target.Children.Where(c => c.Kind == "InputParameter").ToList();
                node.Children.RemoveAll(a => a.Kind == "Argument" && !inputs.Contains(a.Props.GetValueOrDefault("Parameter")));
                foreach (var input in inputs)
                    if (!node.Children.Any(a => a.Props.GetValueOrDefault("Parameter") == input)) node.Add(N("Argument")).Set("Parameter", input);
            }
        }
        public void Rename(Node node, string name)
        {
            Log.Add("rename");
            if (FixedNames.Contains(node.Kind)) throw new InvalidOperationException("Widget does not support name changing");
            node.Set("Name", name);
        }
        public void Delete(Node node) { Log.Add("delete " + node.Kind); node.Parent!.Children.Remove(node); }
        public Node Move(Node node, Node parent) { Log.Add("move"); node.Parent!.Children.Remove(node); parent.Add(node); return node; }
        public void Place(Node node, Node? after)
        {
            Log.Add("place");
            var siblings = node.Parent!.Children;
            siblings.Remove(node);
            siblings.Insert(after == null ? 0 : siblings.IndexOf(after) + 1, node);
        }
        public Node? Replacement(Node node) => null;
    }

    private static Node? ScreenOf(Node node) { for (var up = node.Parent; up != null; up = up.Parent) if (up.Kind == "MobileScreen") return up; return null; }
    private static IEnumerable<Node> Widgets(Node root) => root.Children.SelectMany(c => (c.Kinds.Contains("Widget") ? new[] { c } : Array.Empty<Node>()).Concat(Widgets(c)));

    // The screen Audit in small.
    private static Node Module(bool nullSlotNames = false)
    {
        keys = 0;
        var module = N("ESpace", "AgentOps");
        var integer = new Node("T-Integer", "BasicType", "Integer");
        var flow = module.Add(N("MobileFlow", "MainFlow"));
        var pagination = flow.Add(N("MobileBlock", "Pagination"));
        var start = pagination.Add(N("InputParameter", "StartIndex")).Set("DataType", integer);
        var max = pagination.Add(N("InputParameter", "MaxRecords")).Set("DataType", integer);
        var total = pagination.Add(N("InputParameter", "TotalCount")).Set("DataType", integer);
        pagination.Set("InputParameters", new List<Node> { start, max, total });
        var navigate = pagination.Add(N("BlockEvent", "OnNavigate"));
        navigate.Add(N("InputParameter", "NewStartIndex")).Set("DataType", integer);
        var previous = pagination.Add(W("PlaceholderWidget", "Previous"));
        var next = pagination.Add(W("PlaceholderWidget", "Next"));
        var screen = flow.Add(N("MobileScreen", "Audit"));
        var auditStart = screen.Add(N("LocalVariable", "AuditStartIndex")).Set("DataType", integer);
        var chainStart = screen.Add(N("LocalVariable", "ChainStartIndex")).Set("DataType", integer);
        screen.Set("LocalVariables", new List<Node> { auditStart, chainStart });
        var showAudit = screen.Add(N("ScreenAction", "ShowAuditPage"));
        var auditInput = showAudit.Add(N("InputParameter", "NewStartIndex")).Set("DataType", integer);
        var showChain = screen.Add(N("ScreenAction", "ShowChainPage"));
        showChain.Add(N("InputParameter", "NewStartIndex")).Set("DataType", integer);
        var chains = screen.Add(W("AdvancedHtml", "AuChainsCard")).Set("Tag", "section");
        var glass = chains.Add(W("Container", "AuGlassChains")).Set("Style", new Code("\"aox-g\""));
        var number = glass.Add(W("Container", "Div16")).Set("Style", new Code("\"aox-g-n\""));
        number.Add(W("Expression")).Set("Value", new Code("IntegerToText(ChainStartIndex)"));
        glass.Add(W("AdvancedHtml", "Span5")).Set("Tag", "span").Add(W("TextWidget")).Set("Text", "chains");
        var footer = chains.Add(W("AdvancedHtml", "Footer1")).Set("Tag", "footer");
        var pager = footer.Add(W("MobileBlockInstanceWidget", "AuditPagination")).Set("SourceBlock", pagination);
        pager.Add(N("Argument")).Set("Parameter", start).Set("Value", new Code("AuditStartIndex"));
        pager.Add(N("Argument")).Set("Parameter", max).Set("Value", new Code("10"));
        pager.Add(N("Argument")).Set("Parameter", total).Set("Value", new Code("100"));
        var handler = pager.Add(N("EventHandler")).Set("Event", navigate).Set("Handler", showAudit);
        handler.Add(N("Argument")).Set("Parameter", auditInput).Set("Value", new Code("NewStartIndex"));
        // The arrows of the paginator, as the Studio has them: an icon with its class; the ODC icon has a Weight (an icon without
        // one is "Non Existing Icon" there), O11's has none.
        var odc = ElementWidgetMap.CurrentPlatform == ElementWidgetMap.Odc;
        var back = pager.Add(W("PlaceholderContentWidget", nullSlotNames ? "" : "Previous")).Set("Placeholder", previous).Add(W("Icon")).Set("Icon", "angle-left").Set("Style", new Code("\"icon\""));
        var forward = pager.Add(W("PlaceholderContentWidget", nullSlotNames ? "" : "Next")).Set("Placeholder", next).Add(W("Icon")).Set("Icon", "angle-right").Set("Style", new Code("\"icon\""));
        if (odc) { back.Set("Weight", "regular"); forward.Set("Weight", "regular"); }
        // An If inside the else of another (an else-if chain), as the chain table's states.
        var none = chains.Add(W("IfWidget", "IfAuNoChains")).Set("Condition", new Code("ChainStartIndex = 0"));
        var noneYes = none.Add(W("IfBranchWidget")); var noneNo = none.Add(W("IfBranchWidget"));
        none.Set("TrueBranch", noneYes).Set("FalseBranch", noneNo);
        noneYes.Add(W("TextWidget")).Set("Text", "No chains yet.");
        var one = noneNo.Add(W("IfWidget", "IfAuOneChain")).Set("Condition", new Code("ChainStartIndex = 1"));
        var oneYes = one.Add(W("IfBranchWidget")); var oneNo = one.Add(W("IfBranchWidget"));
        one.Set("TrueBranch", oneYes).Set("FalseBranch", oneNo);
        oneYes.Add(W("TextWidget")).Set("Text", "One chain.");
        oneNo.Add(W("TextWidget")).Set("Text", "Several chains.");
        return module;
    }

    private static (ScreenHtmlModule<Node> Reading, ScreenHtmlDocument Document) Read(Node module)
    {
        var reading = ScreenHtml.Module(module, new Reader());
        return (reading, reading.Read("Audit"));
    }

    private static (ScreenHtmlModule<Node>.EditPlan Plan, ScreenHtmlDocument After, Writer Writer) Apply(Node module, IReadOnlyList<string> edits)
    {
        var (reading, document) = Read(module);
        var plan = reading.Edit(document, edits);
        var writer = new Writer();
        if (!plan.Refused) plan.Apply(writer);
        if (!plan.Refused) plan.Verify(reading.Refresh(document.RootKey).Read("Audit"));
        return (plan, ScreenHtml.Module(module, new Reader()).Read("Audit"), writer);
    }

    // The element of the reading with that k, whole (children included).
    private static string Element(ScreenHtmlDocument document, string k) => HtmlElementEdits.ElementText(document.Html, k) ?? throw new InvalidOperationException("no k=" + k + " in\n" + document.Html);
    private static string KOf(ScreenHtmlDocument document, string fragment) =>
        document.Html.Split('\n').First(l => l.Contains(fragment, StringComparison.Ordinal)).Trim().Split('"')[1];
    private static string Problems(ScreenHtmlEditResult result) => string.Join(" | ", result.Problems.Select(p => "[" + p["code"] + "] " + p["message"]));

    // The edit planned on the text it reads back changes nothing: the reading is a fixed point of the page form.
    private static void AssertFixedPoint(Node module)
    {
        var (reading, document) = Read(module);
        var plan = reading.Edit(document, [document.Html]);
        Assert.False(plan.Refused, Problems(plan.Result));
        var writer = new Writer();
        plan.Apply(writer);
        Assert.False(plan.Refused, Problems(plan.Result));
        Assert.Empty(writer.Log);
        Assert.Empty(plan.Result.Ops);
    }

    // The reproduction of the session: a second paginator written as the reading writes the first one, before the chain table's
    // footer (the element edits form, as the job sent it). The platform names the slots of the new instance after their
    // placeholders; the edit wrote no name on them, so none is written (it was "set Name" on each slot, which the Studio refuses).
    [Fact]
    public void ANewPaginatorIsWrittenWithoutANameOnItsSlotsAndReadsBackAsAFixedPoint()
    {
        var module = Module();
        var (_, document) = Read(module);
        Assert.Contains("@OnNavigate=\"ShowAuditPage(NewStartIndex = NewStartIndex)\"", document.Html);
        var footer = KOf(document, "id=\"Footer1\"");
        var edits = new JsonArray(new JsonObject {
            ["before"] = footer,
            ["insert"] = "<footer id=\"ChainPageFooter\">\n <Block name=\"Pagination\" id=\"ChainPagination\" @OnNavigate=\"ShowChainPage(NewStartIndex = NewStartIndex)\" :MaxRecords=\"10\" :StartIndex=\"ChainStartIndex\" :TotalCount=\"100\">\n"
                + "  <slot name=\"Previous\">Back</slot>\n  <slot name=\"Next\">Forward</slot>\n </Block>\n</footer>",
        });
        var keyTable = document.Keys.GroupBy(k => k.Key).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);
        var applied = HtmlElementEdits.Apply(document.Html, edits, keyTable);
        Assert.Empty(applied.Problems);
        var (plan, after, writer) = Apply(module, [applied.Document]);
        Assert.False(plan.Refused, Problems(plan.Result) + "\n" + string.Join(", ", writer.Log));
        // The only names written are the ids the edit wrote on its new footer and its new paginator.
        Assert.DoesNotContain(writer.Log, l => l == "rename");
        // A new widget is named at its creation (the proto line, 20/10: a block instance refuses a later set Name): the names the
        // plan writes are those of its creates and its sets.
        Assert.Equal(["ChainPageFooter", "ChainPagination"], plan.Result.Ops.Where(o => o["op"]?.ToString() == "set" && o["property"]?.ToString() == "Name").Select(o => o["value"]!.ToString())
            .Concat(plan.Result.Ops.Where(o => o["op"]?.ToString() == "create" && o["name"] != null).Select(o => o["name"]!.ToString())).Order(StringComparer.Ordinal));
        Assert.Contains("<Block k=", after.Html);
        Assert.Contains("id=\"ChainPagination\" @OnNavigate=\"ShowChainPage(NewStartIndex = NewStartIndex)\"", after.Html);
        Assert.DoesNotContain("os-Name", after.Html);
        AssertFixedPoint(module);
    }

    // An element with k whose edit leaves its id out keeps the name it has (Div16, the name the html op generated): the edit
    // changed its class only, so the class is the one write; the name read back is said in normalized, never cleared.
    [Fact]
    public void AnElementWithKKeepsItsNameWhenTheEditLeavesTheIdOut()
    {
        var module = Module();
        var (_, document) = Read(module);
        var k = KOf(document, "id=\"Div16\"");
        var element = Element(document, k);
        var edit = element.Replace(" id=\"Div16\"", "").Replace("class=\"aox-g-n\"", "class=\"aox-g-n wide\"");
        var (plan, after, writer) = Apply(module, [edit]);
        Assert.False(plan.Refused, Problems(plan.Result));
        Assert.Equal(["set Style"], writer.Log);
        Assert.Contains("id=\"Div16\" class=\"aox-g-n wide\"", after.Html);
        var kept = Assert.Single(plan.Result.Normalized, n => n["property"]?.ToString() == "Name");
        Assert.Equal(k, kept["k"]!.ToString());
        Assert.Equal("Div16", kept["value"]!.ToString());
        // Written with its id, the same element is the same single write.
        var (again, _, second) = Apply(Module(), [Element(Read(Module()).Document, k).Replace("class=\"aox-g-n\"", "class=\"aox-g-n wide\"")]);
        Assert.False(again.Refused, Problems(again.Result));
        Assert.Equal(["set Style"], second.Log);
    }

    // A text that asks to change a name the Studio does not let change (the name of a slot is its placeholder's) is one refusal,
    // before anything is written, naming that slot and its block, with the patch that writes the slot as read; the patch plans
    // clean. A new paginator's slot is judged the same way.
    [Fact]
    public void ANameTheStudioDoesNotLetChangeIsOneRefusalWithItsPatch()
    {
        var module = Module();
        var (reading, document) = Read(module);
        var k = KOf(document, "id=\"AuditPagination\"");
        var pager = Element(document, k);
        var edit = pager.Replace("<slot name=\"Previous\">", "<slot name=\"Previous\" os-Name=\"PreviousArrow\">");
        Assert.NotEqual(pager, edit);
        var plan = reading.Edit(document, [edit]);
        Assert.True(plan.Refused);
        var problem = Assert.Single(plan.Result.Problems);
        Assert.Equal(NameFixed, problem["code"]!.ToString());
        Assert.Equal(k, problem["k"]!.ToString());
        Assert.Contains("<slot name=\"Previous\">", problem["message"]!.ToString());
        Assert.Contains("PreviousArrow", problem["message"]!.ToString());
        var corrected = problem["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
        Assert.DoesNotContain("os-Name", string.Join("\n", corrected));
        var patched = reading.Edit(document, corrected);
        Assert.False(patched.Refused, Problems(patched.Result));

        var footer = KOf(document, "id=\"Footer1\"");
        var fresh = Element(document, footer).Replace("</footer>", " <Block name=\"Pagination\" @OnNavigate=\"ShowChainPage(NewStartIndex = NewStartIndex)\" :MaxRecords=\"10\" :StartIndex=\"ChainStartIndex\" :TotalCount=\"100\">\n  <slot name=\"Next\" os-Name=\"Onward\">Forward</slot>\n </Block>\n</footer>");
        var newSlot = reading.Edit(document, [fresh]);
        Assert.True(newSlot.Refused);
        Assert.Equal(NameFixed, Assert.Single(newSlot.Result.Problems)["code"]!.ToString());
    }

    // The paginator's event as the reading writes it, Handler(Input = expression), is the same event in the page form and in the
    // fragment form (the html op with a parent): the handler and the value of its input, whether the handler's signature is known
    // or not (an action the same job creates).
    [Fact]
    public void ThePaginatorsEventReadsAndWritesTheSameInThePageAndTheFragmentForms()
    {
        var module = Module();
        var (_, document) = Read(module);
        AssertFixedPoint(module);
        var line = document.Html.Split('\n').First(l => l.Contains("id=\"AuditPagination\"", StringComparison.Ordinal)).Trim();
        var block = System.Text.RegularExpressions.Regex.Replace(line, " k=\"[^\"]*\"", "").Replace(">", "></Block>");
        Assert.Contains("@OnNavigate=\"ShowAuditPage(NewStartIndex = NewStartIndex)\"", block);
        foreach (var signature in new[] { true, false }) {
            var scope = new HtmlVisualScope(["AuditStartIndex", "ChainStartIndex"],
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["ShowAuditPage"] = "@show-audit" },
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Pagination"] = "IMobileBlock:Pagination" },
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
                reference => reference switch {
                    "IMobileBlock:Pagination" => new ScreenContract(reference, [Param("StartIndex"), Param("MaxRecords"), Param("TotalCount")], [], [],
                        [new UiEvent("OnNavigate", false, null, [Param("NewStartIndex")])], [new UiPlaceholder("Previous", null, "Previous", []), new UiPlaceholder("Next", null, "Next", [])],
                        new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>()),
                    "@show-audit" when signature => new ScreenContract(reference, [Param("NewStartIndex")], [], [], [], [], new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>()),
                    _ => null,
                });
            var ops = HtmlVisual.Expand(block, "$screen", scope).Ops;
            var alias = Assert.Single(ops, o => o["type"]?.ToString() == "IMobileBlockInstanceWidget")["as"]!.ToString();
            Assert.Contains(ops, o => o["target"]?.ToString() == alias + "/OnNavigate" && o["prop"]?.ToString() == "Handler" && o["value"]?.ToString() == "@show-audit");
            Assert.Single(ops, o => o["target"]?.ToString() == alias + "/OnNavigate/NewStartIndex" && o["prop"]?.ToString() == "Value" && o["value"]?.ToString() == "NewStartIndex");
        }
    }

    // The same call form on a click (onclick="Destination(Input = expression)", as the reading writes w104's Verify): the fragment
    // names the input, never passes the comparison "NewStartIndex = AuditStartIndex + 10" to the first one; positional arguments
    // keep their order.
    [Fact]
    public void AClickWrittenAsTheReadingWritesItNamesItsInputsInTheFragmentForm()
    {
        var scope = new HtmlVisualScope(["AuditStartIndex"],
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["ShowAuditPage"] = "@show-audit" },
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase), new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
            reference => reference == "@show-audit" ? new ScreenContract(reference, [Param("NewStartIndex")], [], [], [], [], new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>()) : null);
        var named = HtmlVisual.Expand("<button onclick=\"ShowAuditPage(NewStartIndex = AuditStartIndex + 10)\">Next</button>", "$screen", scope).Ops;
        Assert.Contains(named, o => o["target"]?.ToString()?.EndsWith("/OnClick/NewStartIndex", StringComparison.Ordinal) == true && o["value"]?.ToString() == "AuditStartIndex + 10");
        var positional = HtmlVisual.Expand("<button onclick=\"ShowAuditPage(AuditStartIndex + 10)\">Next</button>", "$screen", scope).Ops;
        Assert.Contains(positional, o => o["target"]?.ToString()?.EndsWith("/OnClick/NewStartIndex", StringComparison.Ordinal) == true && o["value"]?.ToString() == "AuditStartIndex + 10");
    }

    // ---- round 2: what the reading writes is accepted as it is, and one refusal never contradicts another ---------------------

    // The session's job 16182cfb: its logic op created ShowChainPage before its html op, whose element edits were written on the
    // reading before that op. The edits make a whole document on that reading; it is merged three ways with the screen now
    // (ScreenHtmlMerge), which could not index a screen with an If inside an else (the Audit screen has several): the merge gave
    // nothing, the document replaced the screen with the reading's actions= and the plan refused HTML_ACTIONS_LISTED, "leave
    // actions as read", which is what the edit did. Now the merge keeps the action the earlier op created, and only the edited
    // element is written.
    [Fact]
    public void AnEditWrittenBeforeAnEarlierOpOfTheJobAddedAnActionMergesAndKeepsTheActions()
    {
        var module = Module();
        var (_, before) = Read(module);
        Assert.Matches("<div else>\n\\s*<div k=\"[^\"]*\" id=\"IfAuOneChain\" if=", before.Html);
        // The logic op of the same job, before the html op: a new screen action.
        Find(module, n => n.Kind == "MobileScreen").Add(N("ScreenAction", "ShowStoryPage"));
        var (reading, now) = Read(module);
        Assert.Contains("ShowStoryPage", now.Html.Split('\n')[0]);
        var keysBefore = before.Keys.GroupBy(k => k.Key).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);
        var keysNow = now.Keys.GroupBy(k => k.Key).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);
        var k = KOf(before, "id=\"Div16\"");
        var edits = new JsonArray(new JsonObject { ["replace"] = k, ["with"] = Element(before, k).Replace("class=\"aox-g-n\"", "class=\"aox-g-n wide\"") });
        var applied = HtmlElementEdits.Apply(before.Html, edits, keysBefore);
        Assert.Empty(applied.Problems);
        var merged = ScreenHtmlMerge.ThreeWay(before.Html, keysBefore, now.Html, keysNow, [applied.Document]);
        Assert.NotNull(merged.Document);
        Assert.Contains("ShowStoryPage", merged.Document!.Split('\n')[0]);
        var plan = reading.Edit(now, [merged.Document]);
        Assert.False(plan.Refused, Problems(plan.Result));
        var writer = new Writer();
        plan.Apply(writer);
        plan.Verify(reading.Refresh(now.RootKey).Read("Audit"));
        Assert.False(plan.Refused, Problems(plan.Result));
        Assert.Equal(["set Style"], writer.Log);
    }

    // The same edit when no merge is possible (a store without the reading's text: each k by its ObjectKey, the document as
    // written): actions= is the list the reading wrote. An action the module has now and the text does not list (created by an
    // earlier op of the job, or in the Studio since) stays, said in normalized; the page never removes one. A name the module does
    // not have is the one refusal, and its fix is the logic op, never "leave actions as read".
    [Fact]
    public void TheActionsTheReadingListedAreAcceptedAndOnlyAnActionTheModuleLacksIsRefused()
    {
        var module = Module();
        var (_, before) = Read(module);
        Find(module, n => n.Kind == "MobileScreen").Add(N("ScreenAction", "ShowStoryPage"));
        var (reading, now) = Read(module);
        var k = KOf(before, "id=\"Div16\"");
        var keysBefore = before.Keys.GroupBy(x => x.Key).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);
        var document = HtmlElementEdits.Apply(before.Html, new JsonArray(new JsonObject { ["replace"] = k, ["with"] = Element(before, k).Replace("class=\"aox-g-n\"", "class=\"aox-g-n wide\"") }), keysBefore).Document;
        var plan = reading.Edit(now, [document]);
        Assert.False(plan.Refused, Problems(plan.Result));
        Assert.Contains(plan.Result.Normalized, n => n["property"]?.ToString() == "actions" && n.ToJsonString().Contains("ShowStoryPage", StringComparison.Ordinal));
        var writer = new Writer();
        plan.Apply(writer);
        plan.Verify(reading.Refresh(now.RootKey).Read("Audit"));
        Assert.False(plan.Refused, Problems(plan.Result));
        Assert.Equal(["set Style"], writer.Log);

        var first = now.Html.Split('\n')[0];
        var ghost = reading.Edit(now, [now.Html.Replace(first, first.Replace("ShowChainPage, ", "ShowChainPage, ShowGhostPage, "))]);
        Assert.True(ghost.Refused);
        var problem = Assert.Single(ghost.Result.Problems);
        Assert.Equal(ScreenHtmlEdit.ActionsListed, problem["code"]!.ToString());
        Assert.Contains("ShowGhostPage", problem["message"]!.ToString());
        Assert.DoesNotContain("as read", problem["fix"]!.ToString());
        Assert.Contains("logic", problem["fix"]!.ToString());
    }

    // The arrows the reading writes for the paginator compile in the fragment of their lane as written: O11's icon has no
    // Weight, so the reading never writes one and the fragment asked for one it then dropped; the ODC reading writes the weight
    // its icon has. Where the icon has a Weight (ODC), an <i> without one is still refused ("Non Existing Icon" in the Studio).
    [Fact]
    public void TheIconsTheReadingWritesCompileInTheFragmentOfTheirLane()
    {
        var (_, document) = Read(Module());
        var line = document.Html.Split('\n').Select(l => l.Trim()).First(l => l.StartsWith("<i ", StringComparison.Ordinal) && l.Contains("angle-left", StringComparison.Ordinal));
        var icon = System.Text.RegularExpressions.Regex.Replace(line, " k=\"[^\"]*\"", "");
        var odc = ElementWidgetMap.CurrentPlatform == ElementWidgetMap.Odc;
        Assert.True(odc == icon.Contains("weight=", StringComparison.Ordinal), icon);
        // The scope of the lane as a job has it without a module (the preflight) and with one (the loaded Studio's icon).
        foreach (var scope in new[] { HtmlVisualScope.Empty, HtmlVisualScope.Empty with { Supports = (type, property) => type != "IIcon" || property != "Weight" || odc } }) {
            var ops = HtmlVisual.Expand(icon, "$screen", scope).Ops;
            var alias = Assert.Single(ops, o => o["type"]?.ToString() == "IIcon")["as"]!.ToString();
            Assert.Contains(ops, o => o["target"]?.ToString() == alias && o["prop"]?.ToString() == "Icon" && o["value"]?.ToString() == "angle-left");
            Assert.Equal(odc, ops.Any(o => o["target"]?.ToString() == alias && o["prop"]?.ToString() == "Weight"));
        }
        var weighted = HtmlVisualScope.Empty with { Supports = (type, property) => true };
        Assert.Contains("needs weight=", Assert.Throws<InvalidOperationException>(() => HtmlVisual.Expand("<i icon=\"angle-left\" class=\"icon\"/>", "$screen", weighted)).Message);
        var light = HtmlVisualScope.Empty with { Supports = (type, property) => type != "IIcon" || property != "Weight" };
        Assert.Single(HtmlVisual.Expand("<i icon=\"angle-left\" class=\"icon\"/>", "$screen", light).Ops, o => o["type"]?.ToString() == "IIcon");
    }

    // ---- round 3: the review of round 2 (A2-A8), each family with its own rule -------------------------------------------------

    private static (ScreenHtmlModule<Node>.EditPlan Plan, Writer Writer) Run(Node module, IReadOnlyList<string> edits, Writer writer)
    {
        var (reading, document) = Read(module);
        var plan = reading.Edit(document, edits);
        if (!plan.Refused) plan.Apply(writer);
        if (!plan.Refused) plan.Verify(reading.Refresh(document.RootKey).Read("Audit"));
        return (plan, writer);
    }
    private static Dictionary<string, string> KeysOf(ScreenHtmlDocument document) => document.Keys.GroupBy(k => k.Key).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);

    // A2: a name moved from one element to another (Div16 written without its id, Span5 with the name Div16). A text that leaves
    // an id out keeps the name (the session of 2026-10-18 left every id out of what it edited), so that alone never lets the name
    // go: one HTML_NAME_TAKEN that says why Div16 still has it, with the checked patch that writes id="" on it; the patch moves the
    // name, whichever element comes first in the text (the name let go is cleared before any is taken).
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ANameMovedToAnotherElementIsOneRefusalThatSaysWhyWithThePatchThatLetsItGo(bool backwards)
    {
        var module = Module();
        var (reading, document) = Read(module);
        var glass = KOf(document, "id=\"AuGlassChains\"");
        var (from, to) = backwards ? ("Span5", "Div16") : ("Div16", "Span5");
        var edit = Element(document, glass).Replace(" id=\"" + from + "\"", "").Replace("id=\"" + to + "\"", "id=\"" + from + "\"");
        var plan = reading.Edit(document, [edit]);
        Assert.True(plan.Refused);
        var problem = Assert.Single(plan.Result.Problems);
        Assert.Equal(ScreenHtmlEdit.NameTaken, problem["code"]!.ToString());
        var owner = KOf(document, "id=\"" + from + "\"");
        Assert.Contains("k=\"" + owner + "\" keeps", problem["message"]!.ToString());
        Assert.Contains("writes no id", problem["message"]!.ToString());
        Assert.Contains("id=\"\" on k=\"" + owner + "\"", problem["fix"]!.ToString());
        var corrected = problem["patch"]![0]!["value"]!.AsArray().Select(e => e!.ToString()).ToList();
        Assert.Contains("id=\"\"", string.Join("\n", corrected));
        var (patched, writer) = Run(module, corrected, new Writer(uniqueNames: true));
        Assert.False(patched.Refused, Problems(patched.Result) + "\n" + string.Join(", ", writer.Log));
        Assert.Equal(2, writer.Log.Count(l => l == "set Name"));
        var after = Read(module).Document.Html;
        Assert.Single(after.Split('\n'), l => l.Contains("id=\"" + from + "\"", StringComparison.Ordinal));
        Assert.DoesNotContain("id=\"" + to + "\"", after);
    }

    // A2 (b): {"set": k, "attributes": {"id": null}} removes the name, as the contract of set says ("null removes it"): it writes
    // id="" (an element whose text only leaves its id out keeps its name).
    [Fact]
    public void ASetWithIdNullRemovesTheName()
    {
        var module = Module();
        var (_, document) = Read(module);
        var k = KOf(document, "id=\"Div16\"");
        var applied = HtmlElementEdits.Apply(document.Html, new JsonArray(JsonNode.Parse("{\"set\":\"" + k + "\",\"attributes\":{\"id\":null}}")), KeysOf(document));
        Assert.Empty(applied.Problems);
        Assert.Contains("<div k=\"" + k + "\" id=\"\" class=\"aox-g-n\">", applied.Document);
        var (plan, writer) = Run(module, [applied.Document], new Writer());
        Assert.False(plan.Refused, Problems(plan.Result));
        Assert.Equal(["set Name"], writer.Log);
        Assert.DoesNotContain("id=\"Div16\"", Read(module).Document.Html);
    }

    // A3: a slot written with os-Name equal to its own name (its placeholder's) is the slot as it is: accepted by the plan and by
    // the Verify (it passed the plan and was HTML_EDIT_NOT_APPLIED "fault of the engine"), nothing written.
    [Fact]
    public void ASlotWrittenWithItsOwnNameIsTheSlotAsItIs()
    {
        var module = Module();
        var (_, document) = Read(module);
        var k = KOf(document, "id=\"AuditPagination\"");
        var edit = Element(document, k).Replace("<slot name=\"Previous\">", "<slot name=\"Previous\" os-Name=\"Previous\">");
        Assert.Contains("os-Name=\"Previous\"", edit);
        var (plan, writer) = Run(module, [edit], new Writer());
        Assert.False(plan.Refused, Problems(plan.Result));
        Assert.Empty(writer.Log);
    }

    // A4: a lane whose slots have a null Name (the reading writes os-Name=""): a second paginator copied from the first as the
    // reading writes it is accepted (2 HTML_NAME_FIXED and 2 HTML_NAME_TAKEN id="" before: the name of a slot is no widget name
    // of the screen, and os-Name="" is the slot as it is born). In a lane whose slots are named after their placeholder, the same
    // copy is accepted too and the Studio's name is said in normalized.
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ACopyOfABlockAsTheReadingWritesItIsAccepted(bool nullSlotNames)
    {
        var module = Module(nullSlotNames: true);
        var (_, document) = Read(module);
        var pager = Element(document, KOf(document, "id=\"AuditPagination\""));
        Assert.Contains("os-Name=\"\"", pager);
        var copy = System.Text.RegularExpressions.Regex.Replace(pager, " k=\"[^\"]*\"", "").Replace("id=\"AuditPagination\"", "id=\"ChainPagination\"").Replace("ShowAuditPage(", "ShowChainPage(");
        var target = nullSlotNames ? module : Module();
        var (_, now) = Read(target);
        var footer = KOf(now, "id=\"Footer1\"");
        var applied = HtmlElementEdits.Apply(now.Html, new JsonArray(new JsonObject { ["before"] = footer, ["insert"] = "<footer id=\"ChainPageFooter\">\n" + copy + "\n</footer>" }), KeysOf(now));
        Assert.Empty(applied.Problems);
        var (plan, writer) = Run(target, [applied.Document], new Writer(nullSlotNames));
        Assert.False(plan.Refused, Problems(plan.Result) + "\n" + string.Join(", ", writer.Log));
        Assert.DoesNotContain(writer.Log, l => l == "rename");
        // A new widget is named at its creation (the proto line, 20/10: a block instance refuses a later set Name): the names the
        // plan writes are those of its creates and its sets.
        Assert.Equal(["ChainPageFooter", "ChainPagination"], plan.Result.Ops.Where(o => o["op"]?.ToString() == "set" && o["property"]?.ToString() == "Name").Select(o => o["value"]!.ToString())
            .Concat(plan.Result.Ops.Where(o => o["op"]?.ToString() == "create" && o["name"] != null).Select(o => o["name"]!.ToString())).Order(StringComparer.Ordinal));
        if (!nullSlotNames) Assert.Contains(plan.Result.Normalized, n => n["property"]?.ToString() == "Name" && n["note"]!.ToString().Contains("the name of a slot is the Studio's", StringComparison.Ordinal));
    }

    // A5: @Event.Input is an argument of the handler of @Event. Without @Event it is the argument of no handler, and the same input
    // given in the call and as @Event.Input is given twice: each refused (the first was dropped in silence, the second kept the
    // last value). @Event="Action" with @Event.Input beside it, the fallback form, still compiles.
    [Fact]
    public void AnArgumentOfNoHandlerAndAnInputGivenTwiceAreRefused()
    {
        var scope = PaginatorScope();
        var orphan = Assert.ThrowsAny<InvalidOperationException>(() => HtmlVisual.Expand("<Block name=\"Pagination\" :StartIndex=\"AuditStartIndex\" @OnNavigate.NewStartIndex=\"NewStartIndex\"></Block>", "$screen", scope));
        Assert.Contains("names no handler", orphan.Message);
        var twice = Assert.ThrowsAny<InvalidOperationException>(() => HtmlVisual.Expand("<Block name=\"Pagination\" :StartIndex=\"AuditStartIndex\" @OnNavigate=\"ShowAuditPage(NewStartIndex = 1)\" @OnNavigate.NewStartIndex=\"2\"></Block>", "$screen", scope));
        Assert.Contains("2 times", twice.Message);
        // Without a module (the preflight) the argument of no handler is refused too.
        var preflight = new JsonObject { ["op"] = "html", ["parent"] = "$screen", ["html"] = "<Block name=\"Pagination\" @OnNavigate.NewStartIndex=\"1\"></Block>" };
        Assert.Contains("names no handler", Assert.ThrowsAny<InvalidOperationException>(() => HtmlVisual.PreflightOp(preflight)).Message);
        var ops = HtmlVisual.Expand("<Block name=\"Pagination\" :StartIndex=\"AuditStartIndex\" @OnNavigate=\"ShowAuditPage\" @OnNavigate.NewStartIndex=\"AuditStartIndex + 10\"></Block>", "$screen", scope).Ops;
        Assert.Single(ops, o => o["target"]?.ToString()?.EndsWith("/OnNavigate/NewStartIndex", StringComparison.Ordinal) == true && o["value"]?.ToString() == "AuditStartIndex + 10");
    }

    // A6: the call of the text forms (spaces around '=' optional) is the same call in the page form: the handler written
    // ShowChainPage(NewStartIndex=NewStartIndex) is the one the reading writes with spaces (it was HTML_EDIT_INVALID in the edit
    // and compiled in the fragment); arguments by position are refused with the named form in the message.
    [Fact]
    public void TheHandlerWithoutSpacesIsTheSameCallInThePageForm()
    {
        var module = Module();
        var (_, document) = Read(module);
        var k = KOf(document, "id=\"AuditPagination\"");
        var edit = Element(document, k).Replace("ShowAuditPage(NewStartIndex = NewStartIndex)", "ShowChainPage(NewStartIndex=NewStartIndex)");
        Assert.Contains("NewStartIndex=NewStartIndex", edit);
        var (plan, writer) = Run(module, [edit], new Writer());
        Assert.False(plan.Refused, Problems(plan.Result));
        Assert.Contains("set Handler", writer.Log);
        Assert.Contains("@OnNavigate=\"ShowChainPage(NewStartIndex = NewStartIndex)\"", Read(module).Document.Html);
        var (reading, again) = Read(Module());
        var positional = reading.Edit(again, [Element(again, k).Replace("ShowAuditPage(NewStartIndex = NewStartIndex)", "ShowChainPage(NewStartIndex)")]);
        Assert.True(positional.Refused);
        Assert.Contains(positional.Result.Problems, p => p["message"]!.ToString().Contains("ShowChainPage(NewStartIndex = NewStartIndex)", StringComparison.Ordinal) || p["message"]!.ToString().Contains("by position", StringComparison.Ordinal));
    }

    // A7: a click whose argument is a comparison of a variable in scope that is no input of the callee (Filter(ShowAll = True),
    // input OnlyActive) passes the comparison by position, as before; a name that is neither (a typo of an input) stays named
    // and is ARGUMENT_UNKNOWN with the inputs.
    [Fact]
    public void APositionalComparisonInAClickIsNoNamedArgument()
    {
        var scope = new HtmlVisualScope(["ShowAll"],
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Filter"] = "@filter" },
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase), new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
            reference => reference == "@filter" ? new ScreenContract(reference, [new UiParam("OnlyActive", "Boolean", false, null, null)], [], [], [], [], new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>()) : null);
        var ops = HtmlVisual.Expand("<button onclick=\"Filter(ShowAll = True)\">Go</button>", "$screen", scope).Ops;
        Assert.Contains(ops, o => o["target"]?.ToString()?.EndsWith("/OnClick/OnlyActive", StringComparison.Ordinal) == true && o["value"]?.ToString() == "ShowAll = True");
        var typo = Assert.ThrowsAny<InvalidOperationException>(() => HtmlVisual.Expand("<button onclick=\"Filter(OnlyActiv = True)\">Go</button>", "$screen", scope));
        Assert.Contains("has no input 'OnlyActiv'", typo.Message);
        var named = HtmlVisual.Expand("<button onclick=\"Filter(OnlyActive = ShowAll)\">Go</button>", "$screen", scope).Ops;
        Assert.Contains(named, o => o["target"]?.ToString()?.EndsWith("/OnClick/OnlyActive", StringComparison.Ordinal) == true && o["value"]?.ToString() == "ShowAll");
    }

    // A8: a text that leaves an action out of actions= (not created after the reading) is accepted, the action stays, and the note
    // says no more than that.
    [Fact]
    public void AnActionTheTextLeavesOutStaysAndTheNoteSaysNoMore()
    {
        var module = Module();
        var (_, document) = Read(module);
        var first = document.Html.Split('\n')[0];
        Assert.Contains("ShowChainPage", first);
        var text = document.Html.Replace(first, first.Replace(", ShowChainPage", "").Replace("ShowChainPage, ", ""));
        var (plan, writer) = Run(module, [text], new Writer());
        Assert.False(plan.Refused, Problems(plan.Result));
        Assert.Empty(writer.Log);
        var note = Assert.Single(plan.Result.Normalized, n => n["property"]?.ToString() == "actions")["note"]!.ToString();
        Assert.Contains("ShowChainPage", note);
        Assert.DoesNotContain("created after the reading", note);
        Assert.Contains("stays", note);
    }

    private static HtmlVisualScope PaginatorScope() => new(["AuditStartIndex"],
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["ShowAuditPage"] = "@show-audit" },
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Pagination"] = "IMobileBlock:Pagination" },
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
        reference => reference switch {
            "IMobileBlock:Pagination" => new ScreenContract(reference, [Param("StartIndex"), Param("MaxRecords"), Param("TotalCount")], [], [],
                [new UiEvent("OnNavigate", false, null, [Param("NewStartIndex")])], [new UiPlaceholder("Previous", null, "Previous", []), new UiPlaceholder("Next", null, "Next", [])],
                new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>()),
            "@show-audit" => new ScreenContract(reference, [Param("NewStartIndex")], [], [], [], [], new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>()),
            _ => null,
        });

    private static Node Find(Node node, Func<Node, bool> match) =>
        match(node) ? node : node.Children.Select(c => FindOrNull(c, match)).FirstOrDefault(n => n != null) ?? throw new InvalidOperationException("not found");
    private static Node? FindOrNull(Node node, Func<Node, bool> match) =>
        match(node) ? node : node.Children.Select(c => FindOrNull(c, match)).FirstOrDefault(n => n != null);

    // The refusal of a name the Studio does not let change.
    private const string NameFixed = "HTML_NAME_FIXED";
    private static UiParam Param(string name) => new(name, "Integer", false, null, null);
}
