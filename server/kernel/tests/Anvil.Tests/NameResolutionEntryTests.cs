using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R2-A (2026-10-29): one name, one element, before the Studio and at apply. The cases of the parity table
/// (NameResolutionParityTests) through the entry points a job goes through: the scope phase of the base check (its
/// normalizations and its problems, over a module index built in memory), the static check of a document (S3) and the plan of
/// an html edit over the same module read as a page. Synthetic names; pure (no Studio).
/// <list type="bullet">
/// <item>A producer's action written without its producer, the only one of that name: written Producer.Action (a
/// normalization the answer lists), never refused at apply.</item>
/// <item>The same action in the module and in a producer: the short form is the module's, the qualified form the producer's.</item>
/// <item>A screen named like a nearer parameter: the event opens the screen, and the answer says how the reading writes it.</item>
/// <item>A name two producers have: refused once, with each one's form and its patch.</item>
/// <item>A name nothing has: refused with the nearest names, each with its patch.</item>
/// </list>
/// </summary>
public sealed class NameResolutionEntryTests
{
    private const string Lane = "o11";
    private static int shas;

    internal static IndexBaseFacts Facts(JsonArray ops)
    {
        var index = ModuleIndex.Build(NameResolutionFixture.Module(), new NameResolutionFixture.Reader(), "App_UI", Lane, "kernel", new string('e', 63) + (++shas % 10), 1000);
        return new IndexBaseFacts(new StaticBasis { Lane = Lane, Module = index, Fresh = true }, ops);
    }

    internal static JsonArray Ops(params string[] texts) => new(texts.Select(t => (JsonNode)new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(t) } }).ToArray());
    internal static string Server(string body) => "server action Probe\n" + body + "  end\n";
    private static string TextOf(JsonArray ops) => ops[0]!["data"]!["flow"]![0]!.ToString();

    // The base check of a job: its normalizations (JobNormalizer.WithBase runs ScopePhase.Normalize) and the scope phase's problems.
    internal static (List<JsonObject> Normalized, List<JsonObject> Problems) Check(JsonArray ops)
    {
        var facts = Facts(ops);
        var normalized = ScopePhase.Normalize(ops, "/ops", Lane, facts);
        var problems = ScopePhase.Run(ops, "/ops", Lane, facts, new JsonObject { ["problems"] = new JsonArray() }).Problems;
        return (normalized, problems.Where(p => p["code"]?.ToString() is "CALL_UNKNOWN" or "CALL_AMBIGUOUS").ToList());
    }

    [Fact]
    public void AProducersActionWrittenWithoutItsProducerIsWrittenWithItAndListed()
    {
        var ops = Ops(Server("  Charge()\n"));
        var (normalized, problems) = Check(ops);
        Assert.Empty(problems);
        var note = Assert.Single(normalized, n => n["rule"]?.ToString() == "REFERENCE_CANONICAL");
        Assert.Equal("/ops/0/data/flow/0", note["path"]!.ToString());
        Assert.Equal("Billing_CS.Charge(", note["to"]!.ToString());
        Assert.Contains("Billing_CS.Charge()", TextOf(ops));
        Assert.DoesNotContain("\n  Charge()", TextOf(ops));
    }

    [Fact]
    public void ANameOnlyAProducersActionCallsIsThatActionWhateverElseTheModuleNamesSo()
    {
        // The module has a screen Invoice, which no call executes: the call is the producer's action of that name.
        var ops = Ops(Server("  Invoice()\n"));
        var (normalized, problems) = Check(ops);
        Assert.Empty(problems);
        Assert.Equal("Billing_CS.Invoice(", Assert.Single(normalized, n => n["rule"]?.ToString() == "REFERENCE_CANONICAL")["to"]!.ToString());
        Assert.Contains("Billing_CS.Invoice()", TextOf(ops));
    }

    [Fact]
    public void TheModulesOwnActionIsTheShortFormAndTheProducersTheQualifiedOne()
    {
        var text = Server("  First = Pay()\n  Second = Billing_CS.Pay()\n");
        var ops = Ops(text);
        var (normalized, problems) = Check(ops);
        Assert.Empty(problems);
        Assert.DoesNotContain(normalized, n => n["rule"]?.ToString() == "REFERENCE_CANONICAL");
        Assert.Equal(text, TextOf(ops));
    }

    [Fact]
    public void ANameTwoProducersHaveIsRefusedOnceWithEachOnesFormAndPatch()
    {
        var ops = Ops(Server("  Refund()\n"));
        var (normalized, problems) = Check(ops);
        Assert.DoesNotContain(normalized, n => n["rule"]?.ToString() == "REFERENCE_CANONICAL");
        var problem = Assert.Single(problems);
        Assert.Equal("CALL_AMBIGUOUS", problem["code"]!.ToString());
        Assert.Equal("FLOW_NAME_AMBIGUOUS", problem["predicts"]!.ToString());
        Assert.Null(problem["patch"]);
        var candidates = problem["candidates"]!.AsArray().Select(c => c!["name"]!.ToString()).ToList();
        Assert.Equal(new[] { "Billing_CS.Refund", "Ledger_CS.Refund" }, candidates.Order(StringComparer.Ordinal));
        foreach (var candidate in problem["candidates"]!.AsArray())
        {
            var patch = Assert.Single(candidate!["patch"]!.AsArray())!;
            Assert.Equal("/ops/0/data/flow/0", patch["path"]!.ToString());
            Assert.Equal(Server("  " + candidate["name"] + "()\n"), patch["value"]!.ToString());
        }
    }

    [Fact]
    public void ANameNothingHasIsRefusedWithTheNearestFormsAndTheirPatches()
    {
        var ops = Ops(Server("  Chargee()\n"));
        var (_, problems) = Check(ops);
        var problem = Assert.Single(problems);
        Assert.Equal("CALL_UNKNOWN", problem["code"]!.ToString());
        var candidates = problem["candidates"]!.AsArray();
        Assert.Contains(candidates, c => c!["name"]!.ToString() == "Billing_CS.Charge"
            && c["patch"]![0]!["value"]!.ToString() == Server("  Billing_CS.Charge()\n"));
        // The one it can mean (one letter apart) is the certain patch, written as the reading writes it.
        Assert.Equal(Server("  Billing_CS.Charge()\n"), problem["patch"]![0]!["value"]!.ToString());
    }

    [Fact]
    public void AQualifiedNameOfAnElementOfAnotherKindIsNoCall()
    {
        // Ledger_CS has a structure Charge and no action Charge.
        var (_, problems) = Check(Ops(Server("  Ledger_CS.Charge()\n")));
        var problem = Assert.Single(problems);
        Assert.Equal("CALL_UNKNOWN", problem["code"]!.ToString());
        Assert.Contains("is no action", problem["message"]!.ToString());
    }

    [Fact]
    public void ANavigateGoesToAScreenNeverToAnActionOfThatName()
    {
        var refused = Check(Ops("action Home.Refresh\n  navigate Report()\n")).Problems;
        Assert.Contains("a navigate goes to a screen", Assert.Single(refused)["message"]!.ToString());
        Assert.Empty(Check(Ops("action Home.Refresh\n  navigate Dashboard()\n")).Problems);
    }

    // ---- the event of a page: the static check (S3) and the apply's plan --------------------------------------------------

    private static StaticChecks.Result Static(string html) => StaticChecks.Run(new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }),
        "/ops", Lane, new StaticBasis { Lane = Lane, Module = ModuleIndex.Build(NameResolutionFixture.Module(), new NameResolutionFixture.Reader(), "App_UI", Lane, "kernel", new string('f', 63) + (++shas % 10), 1000), Fresh = true });

    private static List<JsonObject> Named(StaticChecks.Result r) => r.Problems.Concat(r.Warnings).Where(p => p["code"]?.ToString() is "HTML_NAME_UNKNOWN" or "HTML_NAME_AMBIGUOUS").ToList();

    [Fact]
    public void TheStaticCheckTakesAScreenNamedLikeANearerParameterAndRefusesAScreenOfTwoProducers()
    {
        Assert.Empty(Named(Static("<screen name=\"Overview\"><a onclick=\"Dashboard\">x</a></screen>")));
        var problem = Assert.Single(Named(Static("<screen name=\"Overview\"><a onclick=\"Statement\">x</a></screen>")));
        Assert.Equal("HTML_NAME_AMBIGUOUS", problem["code"]!.ToString());
        Assert.Equal(new[] { "MobileScreenSignature:Billing_CS.Statement", "MobileScreenSignature:Ledger_CS.Statement" },
            problem["candidates"]!.AsArray().Select(c => c!.ToString()).Order(StringComparer.Ordinal));
    }

    // The edit of a page whose link goes to the screen action Save now names Dashboard: a screen of the module, and the name of
    // an output parameter of a producer's action (nearer by scope).
    internal static (ScreenHtmlEditResult Result, string After, NameResolutionFixture.Node Module) Edit(string from, string to, Action<NameResolutionFixture.Node>? change = null)
    {
        var module = NameResolutionFixture.Module();
        change?.Invoke(module);
        var reading = ScreenHtml.Module(module, new NameResolutionFixture.Reader());
        var document = reading.Read("Home");
        Assert.Contains(from, document.Html);
        var plan = reading.Edit(document, [document.Html.Replace(from, to, StringComparison.Ordinal)]);
        if (!plan.Refused) plan.Apply(new NameResolutionFixture.Writer());
        if (!plan.Refused) plan.Verify(reading.Refresh(document.RootKey).Read("Home"));
        return (plan.Result, ScreenHtml.Module(module, new NameResolutionFixture.Reader()).Read("Home").Html, module);
    }

    private static string Problems(ScreenHtmlEditResult result) => string.Join(" | ", result.Problems.Select(p => "[" + p["code"] + "] " + p["message"]));

    [Fact]
    public void AnEventOpensTheScreenOfItsNameBesideANearerParameterAndTheAnswerSaysHowTheReadingWritesIt()
    {
        var (result, after, module) = Edit("onclick=\"Save\"", "onclick=\"Dashboard\"");
        Assert.True(result.Problems.Count == 0, Problems(result));
        var note = Assert.Single(result.Normalized, n => n["code"]?.ToString() == "REFERENCE_CANONICAL");
        Assert.Equal("Dashboard", note["from"]!.ToString());
        Assert.Equal("MobileScreen:Dashboard", note["to"]!.ToString());
        Assert.Contains("onclick=\"MobileScreen:Dashboard\"", after);
        var link = NameResolutionFixture.Find(module, "GoLink");
        Assert.Equal("Dashboard", ((NameResolutionFixture.Node)((NameResolutionFixture.Node)link.Props["OnClick"]!).Props["Destination"]!).Name);
    }

    [Fact]
    public void AnEventNamingAScreenOfTwoProducersIsRefusedWithEachOnesForm()
    {
        var (result, _, _) = Edit("onclick=\"Save\"", "onclick=\"Statement\"");
        var problem = Assert.Single(result.Problems);
        Assert.Equal("HTML_NAME_AMBIGUOUS", problem["code"]!.ToString());
        Assert.Equal(new[] { "MobileScreenSignature:Billing_CS.Statement", "MobileScreenSignature:Ledger_CS.Statement" },
            problem["candidates"]!.AsArray().Select(c => c!["value"]!.ToString()).Order(StringComparer.Ordinal));
        // Each form is a destination that applies.
        foreach (var form in new[] { "MobileScreenSignature:Billing_CS.Statement", "MobileScreenSignature:Ledger_CS.Statement" })
            Assert.True(Edit("onclick=\"Save\"", "onclick=\"" + form + "\"").Result.Problems.Count == 0, form);
    }

    [Fact]
    public void AnEventNamingWhatNoEventRunsIsStillRefusedBeforeTheBuild()
    {
        // Report is a server action and nothing an event runs or opens is named so.
        var (result, _, _) = Edit("onclick=\"Save\"", "onclick=\"Report\"");
        var problem = Assert.Single(result.Problems);
        Assert.Equal("HTML_NAME_UNKNOWN", problem["code"]!.ToString());
        Assert.Contains("'Report' is the ServerAction Report, which an event cannot run", problem["message"]!.ToString());
    }

    // ---- the correction round (review of 990dce2c) ------------------------------------------------------------------------

    // Item 2: one element of a producer is one candidate, whatever lists it: the index (MobileScreenSignature), the digest
    // (MobileScreen) and a reference op (IMobileScreen).
    [Fact]
    public void AProducersScreenListedByTheIndexTheDigestAndAReferenceOpIsOneCandidate()
    {
        var module = NameResolutionFixture.Module();
        NameResolutionFixture.Find(module, "Billing_CS").Add(NameResolutionFixture.Make("MobileScreenSignature", "Receipt"));
        var index = ModuleIndex.Build(module, new NameResolutionFixture.Reader(), "App_UI", Lane, "kernel", new string('b', 63) + (++shas % 10), 1000);
        var digest = JsonNode.Parse("""
            {"sections":[{"id":"module","blocks":[
              {"kind":"Reference","text":"reference Billing_CS @k1\n  MobileScreen: Receipt, Statement\n  ServerAction: Charge, GetDashboard, Invoice, Pay, Refund"},
              {"kind":"Reference","text":"reference Ledger_CS @k2\n  MobileScreen: Statement\n  ServerAction: Refund\n  Structure: Charge"}]}]}
            """)!.AsObject();
        var html = new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"Overview\"><a onclick=\"Receipt\">x</a></screen>" } };
        var basis = new StaticBasis { Lane = Lane, Module = index, Digest = digest, Fresh = true };
        Assert.Empty(Named(StaticChecks.Run(new JsonArray(html.DeepClone()), "/ops", Lane, basis)));
        var reference = JsonNode.Parse("""{"op":"reference","producer":"Billing_CS","elements":["IMobileScreen:Receipt"]}""")!;
        Assert.Empty(Named(StaticChecks.Run(new JsonArray(reference, html.DeepClone()), "/ops", Lane, basis)));
    }

    // Item 3: an event's destination follows the order of a call: the module's screen comes before a reference's of its name.
    [Fact]
    public void AnEventOpensTheModulesScreenBeforeAReferencesScreenOfItsName()
    {
        static void Receipts(NameResolutionFixture.Node module)
        {
            NameResolutionFixture.Find(module, "Billing_CS").Add(NameResolutionFixture.Make("MobileScreenSignature", "Receipt"));
            NameResolutionFixture.Find(module, "MainFlow").Add(NameResolutionFixture.Make("MobileScreen", "Receipt"));
        }
        var (result, after, module) = Edit("onclick=\"Save\"", "onclick=\"Receipt\"", Receipts);
        Assert.True(result.Problems.Count == 0, Problems(result));
        var bound = (NameResolutionFixture.Node)((NameResolutionFixture.Node)NameResolutionFixture.Find(module, "GoLink").Props["OnClick"]!).Props["Destination"]!;
        Assert.Equal(("MobileScreen", "MainFlow"), (bound.Kind, bound.Parent!.Name));
        // A link the reading has to the reference's screen is written in a form that names it, and reads back as itself.
        var other = NameResolutionFixture.Module();
        Receipts(other);
        var theirs = NameResolutionFixture.Walk(other).First(n => n.Kind == "MobileScreenSignature" && n.Name == "Receipt");
        ((NameResolutionFixture.Node)NameResolutionFixture.Find(other, "GoLink").Props["OnClick"]!).Set("Destination", theirs);
        var reading = ScreenHtml.Module(other, new NameResolutionFixture.Reader());
        var document = reading.Read("Home");
        Assert.Contains("onclick=\"MobileScreenSignature:Receipt\"", document.Html);
        var plan = reading.Edit(document, [document.Html]);
        Assert.False(plan.Refused, Problems(plan.Result));
        var writer = new NameResolutionFixture.Writer();
        plan.Apply(writer);
        Assert.Empty(plan.Result.Ops);
        // The static check answers with the same order: the module's screen, no ambiguity.
        var index = ModuleIndex.Build(other, new NameResolutionFixture.Reader(), "App_UI", Lane, "kernel", new string('9', 63) + (++shas % 10), 1000);
        Assert.Empty(Named(StaticChecks.Run(new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"Overview\"><a onclick=\"Receipt\">x</a></screen>" } }),
            "/ops", Lane, new StaticBasis { Lane = Lane, Module = index, Fresh = true })));
    }

    // Item 4: the canonical form of a call changes only the callee of its call line, never a literal, a comment or an expression.
    [Fact]
    public void TheCanonicalFormOfACallChangesOnlyTheCallee()
    {
        var text = "server action Probe\n  out Msg: Text\n  Charge()\n  assign Msg = \"Charge() failed\"\n  end\n";
        var ops = Ops(text);
        var (normalized, problems) = Check(ops);
        Assert.Empty(problems);
        Assert.Single(normalized, n => n["rule"]?.ToString() == "REFERENCE_CANONICAL");
        Assert.Equal("server action Probe\n  out Msg: Text\n  Billing_CS.Charge()\n  assign Msg = \"Charge() failed\"\n  end\n", TextOf(ops));
    }

    // Item 5: the canonical form is the element's name: a call written in another case is written as the element is named.
    [Fact]
    public void ACallWrittenInAnotherCaseIsWrittenAsItsElementIsNamed()
    {
        var ops = Ops(Server("  charge()\n  pay()\n"));
        var (normalized, problems) = Check(ops);
        Assert.Empty(problems);
        Assert.Equal(Server("  Billing_CS.Charge()\n  Pay()\n"), TextOf(ops));
        var notes = normalized.Where(n => n["rule"]?.ToString() == "REFERENCE_CANONICAL").ToList();
        Assert.Contains(notes, n => n["from"]!.ToString() == "charge(" && n["to"]!.ToString() == "Billing_CS.Charge(");
        Assert.Contains(notes, n => n["from"]!.ToString() == "pay(" && n["to"]!.ToString() == "Pay(" && n["message"]!.ToString().Contains("no case"));
    }

    // Item 6: the JSON form passes through the same rule: a name two producers have is refused with each one's form and patch.
    [Fact]
    public void TheJsonFormRefusesANameOfTwoProducersWithEachOnesFormAndPatch()
    {
        var ops = new JsonArray(JsonNode.Parse("""{"op":"logic","data":{"actions":[{"name":"Probe","kind":"server","steps":[{"call":"Refund"}]}]}}""")!);
        var (_, problems) = Check(ops);
        var problem = Assert.Single(problems);
        Assert.Equal("CALL_AMBIGUOUS", problem["code"]!.ToString());
        Assert.Equal("LOGIC_INVALID", problem["predicts"]!.ToString());
        Assert.Equal(new[] { "Billing_CS.Refund", "Ledger_CS.Refund" }, problem["candidates"]!.AsArray().Select(c => c!["name"]!.ToString()).Order(StringComparer.Ordinal));
        foreach (var candidate in problem["candidates"]!.AsArray())
        {
            var patch = Assert.Single(candidate!["patch"]!.AsArray())!;
            Assert.Equal("/ops/0/data/actions/0/steps/0/call", patch["path"]!.ToString());
            Assert.Equal(candidate["name"]!.ToString(), patch["value"]!.ToString());
        }
        // Producer.Action is a call of the JSON form too (LogicOrder.CallCandidates names the reference's own signature).
        Assert.Contains(LogicOrder.CallCandidates("Ledger_CS.Refund", new JsonObject { ["name"] = "Probe", ["kind"] = "server" }),
            c => c.Reference == "IReference:Ledger_CS/IServerActionSignature:Refund");
    }

    // Item 7: a client action is no event's destination: refused before the set, with its exact wrapping, in the edit form and
    // in the static check.
    [Fact]
    public void AnEventNamingAClientActionIsRefusedWithItsWrapping()
    {
        var (result, _, _) = Edit("onclick=\"Save\"", "onclick=\"Notify\"");
        var problem = Assert.Single(result.Problems);
        Assert.Equal("HTML_NAME_UNKNOWN", problem["code"]!.ToString());
        Assert.Contains("is the ClientAction Notify, which an event cannot run", problem["message"]!.ToString());
        var wrap = Assert.Single(problem["candidates"]!.AsArray(), c => c!["logic"] != null)!;
        Assert.Equal("NotifyClick", wrap["value"]!.ToString());
        Assert.Equal("action Home.NotifyClick\n  Notify()\n  end\n", wrap["logic"]!.ToString());
        var found = Static("<screen name=\"Overview\"><a onclick=\"Notify\">x</a></screen>");
        var refused = Assert.Single(Named(found));
        Assert.Equal("HTML_NAME_UNKNOWN", refused["code"]!.ToString());
        Assert.Equal("action Overview.NotifyClick\n  Notify()\n  end\n", refused["wrap"]!["logic"]!.ToString());
    }

    // Item 8: a destination nothing an event runs has is refused with the nearest destinations, each with its exact attribute.
    [Fact]
    public void AnEventNamingWhatNoEventRunsListsTheNearestDestinationsEachWithItsAttribute()
    {
        var (result, _, _) = Edit("onclick=\"Save\"", "onclick=\"Report\"");
        var problem = Assert.Single(result.Problems);
        var candidates = problem["candidates"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.Contains(candidates, c => c["attribute"]!.ToString() == "onclick" && c["value"]!.ToString() == "MobileScreen:Dashboard");
        // Each one is a destination that applies.
        foreach (var value in candidates.Select(c => c["value"]!.ToString()))
            Assert.True(Edit("onclick=\"Save\"", "onclick=\"" + value + "\"").Result.Problems.Count == 0, value);
    }
}

/// <summary>The module of R2-A's cases (synthetic names): a screen Home (a screen action Save and a link GoLink to it), the
/// screens Dashboard and Invoice, the module's server actions Report and Pay and client action Notify, and two producers: Billing_CS (server actions
/// Charge, Pay, Refund, Invoice, GetDashboard with an output Dashboard; a screen Statement) and Ledger_CS (a server action
/// Refund, a structure Charge, a screen Statement). One model read as an index (the preflight), as a page (the html edit) and
/// as the apply's callables.</summary>
internal static class NameResolutionFixture
{
    internal sealed class Node(string key, string kind, string name = "", params string[] kinds)
    {
        public string Key = key, Kind = kind, Name = name;
        public readonly HashSet<string> Kinds = [.. kinds.Append(kind).SelectMany(k => new[] { k, "I" + k })];
        public Node? Parent;
        public List<Node> Children = [];
        public Dictionary<string, object?> Props = [];
        public Node Add(Node child) { child.Parent = this; Children.Add(child); return child; }
        public Node Set(string property, object? value) { Props[property] = value; if (property == "Name" && value is string s) Name = s; return this; }
    }
    internal sealed record Code(string Text);
    internal sealed class Reader : ModelReader<Node>
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
        var node = new Node("R" + (++keys).ToString("D4"), kind, name, kinds);
        if (name.Length > 0) node.Props["Name"] = name;
        return node;
    }
    private static Node W(string kind, string name = "") => N(kind, name, "Widget");
    internal static Node Make(string kind, string name) => N(kind, name);

    internal static Node Module()
    {
        keys = 0;
        var module = N("ESpace", "App_UI");
        var flow = module.Add(N("MobileFlow", "MainFlow"));
        var home = flow.Add(N("MobileScreen", "Home"));
        var save = home.Add(N("ScreenAction", "Save"));
        var link = home.Add(W("Link", "GoLink"));
        link.Add(W("TextWidget")).Set("Text", "Go");
        var click = link.Add(N("UILifeCycleEvent"));
        link.Set("OnClick", click);
        click.Set("Destination", save);
        flow.Add(N("MobileScreen", "Dashboard"));
        flow.Add(N("MobileScreen", "Invoice"));
        module.Add(N("ServerAction", "Report"));
        module.Add(N("ServerAction", "Pay"));
        module.Add(N("ClientAction", "Notify"));
        var billing = module.Add(N("Reference", "Billing_CS"));
        billing.Add(N("ServerActionSignature", "Charge"));
        billing.Add(N("ServerActionSignature", "Pay"));
        billing.Add(N("ServerActionSignature", "Refund"));
        billing.Add(N("ServerActionSignature", "Invoice"));
        billing.Add(N("ServerActionSignature", "GetDashboard")).Add(N("OutputParameterSignature", "Dashboard"));
        billing.Add(N("MobileScreenSignature", "Statement"));
        var ledger = module.Add(N("Reference", "Ledger_CS"));
        ledger.Add(N("ServerActionSignature", "Refund"));
        ledger.Add(N("StructureSignature", "Charge"));
        ledger.Add(N("MobileScreenSignature", "Statement"));
        return module;
    }

    internal static Node Find(Node root, string name) => Walk(root).First(n => n.Name == name);
    internal static IEnumerable<Node> Walk(Node root) { yield return root; foreach (var c in root.Children) foreach (var d in Walk(c)) yield return d; }

    // The writer of this model: what the kernel's writer does over the Model API, on these nodes (a set of a reference writes
    // the node it names).
    internal sealed class Writer : IScreenHtmlWriter<Node>
    {
        public Node Create(Node parent, string kind, Node? block, string? name = null)
        {
            var node = kind is "ExtendedProperty" or "Event" or "LocalVariable" or "InputParameter" or "Argument" ? N(kind, name ?? "") : W(kind, name ?? "");
            parent.Add(node);
            if (kind is "Link" or "Button") { var e = node.Add(N("UILifeCycleEvent")); node.Set("OnClick", e); }
            return node;
        }
        public void Set(Node node, string property, ScreenHtmlValue<Node> value)
        {
            object? written = value.Type switch {
                'e' => new Code(value.Text), 'b' => value.Text == "True", '?' => null, 'r' => value.Target ?? (object)new Node("~", "Outside", value.Name ?? ""),
                'l' => value.Targets?.ToList(), _ => value.Text };
            if (written == null) node.Props.Remove(property); else node.Set(property, written);
        }
        public void Rename(Node node, string name) => node.Set("Name", name);
        public void Delete(Node node) => node.Parent!.Children.Remove(node);
        public Node Move(Node node, Node parent) { node.Parent!.Children.Remove(node); parent.Add(node); return node; }
        public void Place(Node node, Node? after)
        {
            var siblings = node.Parent!.Children;
            siblings.Remove(node);
            siblings.Insert(after == null ? 0 : siblings.IndexOf(after) + 1, node);
        }
        public Node? Replacement(Node node) => null;
    }
}
