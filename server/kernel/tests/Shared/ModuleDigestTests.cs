using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects: the module digest (ssam-digest/1) renders every section, is deterministic and never
// drops an element silently, in O11 and ODC.
public sealed class ModuleDigestTests
{
    private sealed class Node(string key, string kind, string name = "", params string[] kinds)
    {
        public string Key = key, Kind = kind, Name = name;
        public readonly HashSet<string> Kinds = [.. kinds.Append(kind).SelectMany(k => new[] { k, "I" + k })];
        public Node? Parent;
        public List<Node> Children = [];
        public Dictionary<string, object?> Props = [];
        public Node Add(Node child) { child.Parent = this; Children.Add(child); return child; }
        public Node Set(string property, object? value) { Props[property] = value; return this; }
    }
    // An expression value, as the Model API gives it: Expression(value) answers its text.
    private sealed record Code(string Text);
    private sealed class Reader : ModelReader<Node>
    {
        protected override IEnumerable<Node> Referrers(Node n) => [];
        protected override IEnumerable<Node> Children(Node n) => n.Children;
        protected override Node? Parent(Node n) => n.Parent;
        protected override string Key(Node n) => n.Key;
        protected override string Kind(Node n) => n.Kind;
        protected override string Name(Node n) => n.Name;
        protected override string? Label(Node n) => n.Props.GetValueOrDefault("Label") as string;
        protected override IReadOnlySet<string> KindNames(Node n) => n.Kinds;
        protected override string? Expression(object value) => (value as Code)?.Text;
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Node n) => n.Props.Select(p => (p.Key, (Func<object?>)(() => p.Value)));
    }

    private static int keys;
    private static Node N(string kind, string name = "", params string[] kinds) => new("k" + ++keys, kind, name, kinds);

    // One element of each rendered family, plus a kind the digest does not render (Folder).
    private static Node Module(bool reversed = false)
    {
        keys = 0;
        var root = N("ESpace", "Orders").Set("ESpaceType", "Service").Set("Description", "Orders service.");
        var text = N("BasicType", "Text"); var integer = N("BasicType", "Integer");
        var reference = N("Reference", "Customers_CS").Set("ModuleType", "Service");
        var getCustomer = reference.Add(N("ServerActionSignature", "GetCustomer"));
        reference.Add(N("StructureSignature", "Address"));
        var customer = N("ServerEntity", "Customer", "Entity");
        var order = N("ServerEntity", "Order", "Entity").Set("Public", true).Set("Description", "An order. " + new string('x', 200));
        var id = order.Add(N("EntityAttribute", "Id")).Set("DataType", integer).Set("IsAutoNumber", "Yes");
        var customerId = N("IdentifierType", "Customer Identifier").Set("Entity", customer);
        order.Add(N("EntityAttribute", "CustomerId")).Set("DataType", customerId).Set("IsMandatory", true).Set("DeleteRule", "Protect");
        order.Add(N("EntityAttribute", "Code")).Set("DataType", text).Set("Length", "20").Set("DefaultValue", new Code("\"A\""));
        var status = N("StaticEntity", "Status", "Entity");
        status.Add(N("EntityAttribute", "Label")).Set("DataType", text).Set("Length", "50");
        var open = status.Add(N("Record", "", "Record")).Set("Identifier", "Open");
        open.Add(N("RecordAttributeValue")).Set("Attribute", status.Children[0]).Set("Value", new Code("\"Open\""));
        var structure = N("Structure", "Line"); structure.Add(N("StructureAttribute", "Qty")).Set("DataType", integer);
        var site = N("SiteProperty", "MaxLines").Set("DataType", integer).Set("DefaultValue", new Code("10"));
        var role = N("Role", "Manager", "Role").Set("Public", true);
        var exception = N("UserException", "Invalid");
        var action = N("ServerAction", "PlaceOrder", "Action").Set("Public", true);
        action.Add(N("InputParameter", "Code")).Set("DataType", text).Set("IsMandatory", "False");
        action.Add(N("OutputParameter", "OrderId")).Set("DataType", integer);
        action.Add(N("CommentNode")).Set("Text", "Places\n an order.");
        Node Step(string kind, string name = "") => action.Add(N(kind, name, kind == "AggregateNode" ? ["FlowNode", "Aggregate"] : []));
        var start = Step("StartNode"); var check = Step("IfNode"); var call = Step("ExecuteServerActionNode", "Customer");
        var read = Step("AggregateNode", "Lines"); var loop = Step("ForEachNode"); var sql = Step("SQLNode", "Bump");
        var assign = Step("AssignNode"); var end = Step("EndNode"); var lost = Step("AssignNode");
        var handler = Step("ExceptionHandlerNode"); var raise = Step("RaiseExceptionNode"); var skip = Step("IfNode");
        start.Set("Target", check);
        check.Set("Condition", new Code("Code = \"\"")).Set("TrueTarget", raise).Set("FalseTarget", call).Set("Label", "Empty?");
        raise.Set("Exception", exception).Set("ExceptionMessage", new Code("\"empty\""));
        call.Set("Action", getCustomer).Set("Target", read);
        call.Add(N("Argument")).Set("Parameter", N("InputParameter", "Code")).Set("Value", new Code("Code"));
        var source = read.Add(N("CombineSourcesOperation"));
        source.Add(N("AliasedSource", "Order")).Set("Source", order);
        source.Add(N("Filter")).Set("Condition", new Code("Order.Code = Code"));
        read.Set("MaxRecords", "1").Set("Target", loop);
        loop.Set("RecordList", new Code("Lines.List")).Set("CycleTarget", skip).Set("Target", assign);
        skip.Set("Condition", new Code("Lines.List.Current.Order.Code = \"\"")).Set("TrueTarget", loop).Set("FalseTarget", sql);
        sql.Set("Statement", "UPDATE {Order}\nSET [Code] = @Code").Set("Target", loop);
        sql.Add(N("SQLOutput")).Set("EntityOrStructure", order);
        assign.Set("Target", end);
        assign.Add(N("Assignment")).Set("Variable", new Code("OrderId")).Set("Value", new Code("Lines.List.Current.Order.Id"));
        lost.Set("Target", end);
        handler.Set("Exception", N("SystemException", "All Exceptions")).Set("Target", assign).Set("AbortTransaction", true);
        var timer = N("Timer", "Nightly").Set("Action", action).Set("Schedule", "Daily");
        var flow = N("MobileFlow", "MainFlow", "UIFlow");
        var screen = flow.Add(N("MobileScreen", "Home", "MobileScreen", "WebScreen"));
        screen.Add(N("LocalVariable", "Filter")).Set("DataType", text);
        var click = screen.Add(N("ScreenAction", "Search", "Action"));
        var clickStart = click.Add(N("StartNode")); var clickEnd = click.Add(N("EndNode"));
        clickStart.Set("Target", clickEnd);
        var container = screen.Add(N("Container", "", "Widget"));
        var condition = container.Add(N("IfWidget", "", "Widget")).Set("Condition", new Code("Filter <> \"\""));
        var yes = condition.Add(N("IfBranchWidget", "", "Widget")); condition.Set("TrueBranch", yes);
        condition.Add(N("IfBranchWidget", "", "Widget"));
        yes.Add(N("Input", "FilterInput", "Widget")).Set("Variable", new Code("Filter"));
        var button = yes.Add(N("Button", "", "Widget", "Button"));
        button.Add(N("TextWidget", "", "Widget")).Set("Text", "Search");
        button.Add(N("UILifeCycleEvent", "OnClick")).Set("Destination", click);
        button.Add(N("ExtendedProperty")).Set("Property", "class");
        container.Add(N("List", "Results", "Widget", "List")).Set("Source", new Code("GetLines.List"));
        var folder = N("Folder", "Misc");
        action.Set("Folder", folder);
        // A kind the digest does not know: counted and named, never dropped.
        var mystery = N("Mystery", "Unknown");
        // ODC shapes: a data action whose OnAfterFetch calls a handler; a call whose argument is a list literal with a
        // record literal (parts the Model API lists under the expression); a table's OnSort with the column parameter;
        // a label and a button whose text is an Expression widget holding a literal.
        var fetch = screen.Add(N("DataAction", "FetchLines", "Action"));
        var afterFetch = fetch.Add(N("UILifeCycleEvent")).Set("Destination", click);
        fetch.Set("OnAfterFetch", afterFetch);
        var fetchStart = fetch.Add(N("StartNode")); var fetchEnd = fetch.Add(N("EndNode"));
        var fetchCall = fetch.Add(N("ExecuteServerActionNode")).Set("Action", action).Set("Target", fetchEnd);
        fetchStart.Set("Target", fetchCall);
        var listArgument = fetchCall.Add(N("Argument")).Set("Parameter", N("InputParameter", "Code")).Set("Value", new Code("[\"A\"]"));
        var list = listArgument.Add(N("ListLiteralExpression")); var item = list.Add(N("ListLiteralItem"));
        item.Add(N("RecordLiteralExpression")).Add(N("RecordLiteralField"));
        var table = container.Add(N("TableRecords", "Grid", "Widget")).Set("Source", new Code("GetLines.List"));
        table.Add(N("BuiltinEvent", "OnSort")).Set("Destination", click).Add(N("InputParameter", "ClickedColumn"));
        var label = container.Add(N("Label", "", "Widget"));
        label.Add(N("Expression", "", "Widget")).Set("Value", new Code("\"Quotes\""));
        container.Add(N("Expression", "", "Widget")).Set("Value", new Code("\"Carriers\""));
        // An expression longer than the digest shows: clipped with the @key that holds it whole.
        container.Add(N("Expression", "", "Widget")).Set("Value", new Code("Long(\"" + new string('y', 2100) + "\")"));
        // Screen roles are a set: the Model API answers them in another order on each load.
        var guest = N("Role", "Guest", "Role");
        screen.Set("Roles", reversed ? new List<Node> { guest, role } : new List<Node> { role, guest });
        // Refresh Data names its source in DataSource (the Model API property the kernel writes).
        var reload = click.Add(N("RefreshDataNode")).Set("DataSource", N("ScreenAggregate", "GetLines")).Set("Target", clickEnd);
        clickStart.Set("Target", reload);
        IEnumerable<Node> top = [reference, order, customer, status, structure, site, role, guest, exception, action, timer, flow, folder, mystery, text, integer];
        foreach (var child in reversed ? top.Reverse() : top) root.Add(child);
        return root;
    }

    [Fact]
    public void DigestRendersEverySectionInPseudocodeAndNamesWhatItDoesNotRender()
    {
        var digest = ModuleDigest.Build(Module(), new Reader(), "o11", "AB12", 100);
        Assert.Equal(ModuleDigest.SectionIds, digest.Sections.Select(s => s.Id));
        var text = digest.Text;
        Assert.StartsWith("## module and references (1)\nssam-digest/1 module=Orders type=Service lane=o11 key=@k1 sourceSha256=ab12 sourceBytes=100", text);
        foreach (var expected in new[] {
            "reference Customers_CS @k4 (Service)\n  ServerAction: GetCustomer\n  Structure: Address",
            "entity Order @k8 public \"An order. xxxx", "…(+", "  CustomerId: Customer Identifier req ->Customer delete=Protect", "  Code: Text(20) =\"A\"",
            "static entity Status", "  record Open: Label=\"Open\"", "structure Line", "  Qty: Integer",
            "site property MaxLines", ": Integer =10", "role Manager", "public", "exception Invalid",
            "server action PlaceOrder", "  in Code?: Text\n  out OrderId: Integer\n  // Places an order.",
            "  if Code = \"\":  # Empty?\n    raise Invalid(\"empty\")\n  Customer = Customers_CS.GetCustomer(Code)",
            "  Lines = aggregate FROM Order WHERE (Order.Code = Code) MAX 1",
            "  foreach Lines.List:\n    if Lines.List.Current.Order.Code = \"\":\n      next\n    Bump = sql() -> Order\n    | UPDATE {Order}\n    | SET [Code] = @Code\n  [1] OrderId",
            "  [1] OrderId = Lines.List.Current.Order.Id\n  on exception All Exceptions abort:\n    -> [1]\n  unreached: AssignNode  @k",
            "timer Nightly", "action=PlaceOrder schedule=\"Daily\"",
            "screen MainFlow/Home", " roles=Guest,Manager", "  local Filter: Text", "  action Search", "    refresh GetLines\n",
            "  data action FetchLines @", "\n    on AfterFetch -> Search\n    PlaceOrder(Code=[\"A\"])",
            "    label \"Quotes\"\n    text \"Carriers\"\n",
            "folders (each block names its folder) 1", "not rendered 1: Mystery:1" })
            Assert.Contains(expected, text);
        // A named widget carries its @key (G13).
        Assert.Matches(@"  widgets:\n    if Filter <> """":\n      input FilterInput @k\d+ var=Filter\n      button ""Search"" on OnClick->Search\n    list Results @k\d+ source=GetLines\.List:", text);
        Assert.Matches(@"\n    list Grid @k\d+ source=GetLines\.List on OnSort->Search:", text);
        Assert.Equal(1, digest.NotRendered);
        Assert.True(digest.Clipped >= 1);
        // An expression clipped past 2000 characters names the @key that holds it whole.
        Assert.Matches(@"expr Long\(""y{1994}…\(\+108 @k\d+\)", text);
        // An unreached step says what it would do.
        Assert.Matches(@"  unreached: AssignNode  @k\d+ \{assign \(empty\)\}", text);
        // The action index: signature, calls (with the producer of a referenced action) and callers, by the scope it was
        // rendered in; the static entity's block says how many of its lines are records; an action names its folder.
        var place = digest.Actions.Single(a => a.Name == "PlaceOrder");
        Assert.Equal(("ServerAction", "actions", "Misc", true), (place.Kind, place.Section, place.Folder, place.Public));
        Assert.Equal(("Code?: Text", "OrderId: Integer"), (place.Inputs, place.Outputs));
        Assert.Equal(new[] { "Customers_CS.GetCustomer" }, place.Calls);
        Assert.Equal(new[] { "MainFlow/Home/FetchLines" }, place.CalledBy);
        Assert.Contains(digest.Actions, a => a.Name == "MainFlow/Home/Search" && a.Section == "ui");
        Assert.Equal(1, digest.Section("entities").Entries.Single(e => e.Name == "Status").Records);
        Assert.Equal(digest.Section("ui").Blocks.Count, digest.Section("ui").Entries.Count);
        var sizes = digest.Sizes();
        Assert.Equal(System.Text.Encoding.UTF8.GetByteCount(text), sizes["bytes"]!.GetValue<int>());
        Assert.Equal(ModuleDigest.SectionIds.Length, sizes["sections"]!.AsArray().Count);
        // Every element is counted exactly once: rendered, a value of a rendered owner, folded with a reason, or not rendered.
        var coverage = digest.Section("coverage").Blocks.Single();
        Assert.Contains("folded ", coverage); Assert.Contains("reference signatures 2", coverage);
        Assert.Contains("widget style and attributes 1", coverage); Assert.Contains("built-in and derived types", coverage);
    }

    // G13 (FarmaVirtual, 10/10/2026): after the merge the digest (calls 114-119) named the screen's widgets without their
    // @key, and the named containers the job had mounted (MountFvEditNome, Fv416, UiState4) not at all; ten ssam_map {name}
    // calls (120-128, 132) followed. Every named widget's @key is in the digest: on its line, or, for a named widget the tree
    // collapses, in the "named containers" lines of its screen; the tree itself stays as it was.
    [Fact]
    public void DigestGivesEveryNamedWidgetItsKeyAndKeepsTheTree()
    {
        keys = 0;
        var root = N("ESpace", "Shop");
        var flow = root.Add(N("MobileFlow", "MainFlow", "UIFlow"));
        var screen = flow.Add(N("MobileScreen", "Catalog", "MobileScreen"));
        screen.Add(N("LocalVariable", "Query")).Set("DataType", N("BasicType", "Text"));
        var go = screen.Add(N("ScreenAction", "Go", "Action"));
        var goStart = go.Add(N("StartNode")); var goEnd = go.Add(N("EndNode")); goStart.Set("Target", goEnd);
        var page = screen.Add(N("Container", "", "Widget"));
        var mount = page.Add(N("Container", "MountEditName", "Widget"));
        var input = mount.Add(N("Input", "EditNameInput", "Widget")).Set("Variable", new Code("Query"));
        var empty = page.Add(N("Container", "MountEmpty", "Widget"));
        var link = page.Add(N("Link", "Fv464", "Widget", "Link"));
        link.Add(N("TextWidget", "", "Widget")).Set("Text", "Orders");
        link.Add(N("UILifeCycleEvent", "OnClick")).Set("Destination", go);
        var state = page.Add(N("IfWidget", "IfUiState4", "Widget")).Set("Condition", new Code("Query = \"\""));
        var yes = state.Add(N("IfBranchWidget", "", "Widget")); state.Set("TrueBranch", yes);
        yes.Add(N("Container", "", "Widget")).Add(N("TextWidget", "", "Widget")).Set("Text", "Empty");
        // A line folds what is inside it (CoverTree): the named widgets there carry their keys on that line (review of G13:
        // IfFv41 in the button Fv14, Container Fv36 in its branch, Icon4 in an unnamed link had none).
        var save = page.Add(N("Button", "Fv14", "Widget", "Button")); save.Add(N("TextWidget", "", "Widget")).Set("Text", "Save");
        var guard = save.Add(N("IfWidget", "IfFv41", "Widget")).Set("Condition", new Code("Query <> \"\""));
        var guarded = guard.Add(N("IfBranchWidget", "", "Widget")); guard.Set("TrueBranch", guarded);
        var spinner = guarded.Add(N("Container", "Fv36", "Widget"));
        var back = page.Add(N("Link", "", "Widget", "Link")); var arrow = back.Add(N("Icon", "Icon4", "Widget"));
        // Two instances of one block, each with an empty placeholder: each key on the line of its own instance.
        var card = flow.Add(N("MobileBlock", "Card", "MobileBlock"));
        var first = page.Add(N("MobileBlockInstanceWidget", "", "Widget")).Set("SourceBlock", card);
        var firstHeader = first.Add(N("PlaceholderContentWidget", "Header", "Widget"));
        first.Add(N("PlaceholderContentWidget", "Content", "Widget")).Add(N("TextWidget", "", "Widget")).Set("Text", "Hi");
        var second = page.Add(N("MobileBlockInstanceWidget", "", "Widget")).Set("SourceBlock", card);
        var secondHeader = second.Add(N("PlaceholderContentWidget", "Header", "Widget"));
        var html = page.Add(N("AdvancedHtml", "Fv416", "Widget")); html.Add(N("TextWidget", "", "Widget")).Set("Text", "Price");
        var text = ModuleDigest.Build(root, new Reader(), "o11", "EF", 1).Text;
        foreach (var expected in new[] {
            "  widgets:\n    input EditNameInput @" + input.Key + " var=Query\n",
            "    link \"Orders\" on OnClick->Go  # Fv464 @" + link.Key + "\n",
            "    if Query = \"\":  # IfUiState4 @" + state.Key + "\n      text \"Empty\"\n",
            "    button \"Save\"  # Fv14 @" + save.Key + "; inside IfFv41 @" + guard.Key + ", Fv36 @" + spinner.Key + "\n",
            "    link \"\"  # inside Icon4 @" + arrow.Key + "\n",
            "    block Card()  # inside [Header] @" + firstHeader.Key + "\n      [Content] @", ":\n        text \"Hi\"\n",
            "    block Card()  # inside [Header] @" + secondHeader.Key + "\n",
            "    text \"Price\"\n  named containers:\n    MountEditName @" + mount.Key + ", MountEmpty @" + empty.Key + ", Fv416 @" + html.Key })
            Assert.Contains(expected, text);
        // The list holds the collapsed containers only: what a line folds in is on that line.
        Assert.Matches(@"\n  named containers:\n    MountEditName @k\d+, MountEmpty @k\d+, Fv416 @k\d+(\n|$)", text);
        // The collapsed containers stay collapsed, named or not: no line of their own, no indentation for their children.
        Assert.DoesNotMatch(@"\n +(container|advancedhtml)\b", text);
        // Every named widget's key is in the text (the placeholders' too).
        foreach (var named in new[] { mount, input, empty, link, state, save, guard, spinner, arrow, firstHeader, secondHeader, html })
            Assert.Contains("@" + named.Key, text);
    }

    [Fact]
    public void StoredDigestIsTheSameDigestAndAnyOtherFileIsAMiss()
    {
        var digest = ModuleDigest.Build(Module(), new Reader(), "o11", "AB12", 100);
        var parsed = ModuleDigest.Parse(digest.ToJson("kernel"), "o11", "kernel", "ab12");
        Assert.Equal(digest.Text, parsed.Text);
        Assert.Equal(digest.Sizes().ToJsonString(), parsed.Sizes().ToJsonString());
        Assert.Equal(digest.Actions.Select(a => (a.Key, a.Name, a.Inputs, string.Join(",", a.Calls), string.Join(",", a.CalledBy))),
            parsed.Actions.Select(a => (a.Key, a.Name, a.Inputs, string.Join(",", a.Calls), string.Join(",", a.CalledBy))));
        Assert.Equal(digest.Sections.SelectMany(s => s.Entries), parsed.Sections.SelectMany(s => s.Entries));
        var file = JsonNode.Parse(digest.ToJson("kernel"))!;
        Assert.Equal(("ssam-digest/1", ModuleDigest.Extractor, "kernel"), (file["schema"]!.ToString(), file["extractor"]!.GetValue<int>(), file["adapter"]!.ToString()));
        Assert.Throws<InvalidDataException>(() => ModuleDigest.Parse(digest.ToJson("kernel"), "odc", "kernel", "AB12"));
        Assert.Throws<InvalidDataException>(() => ModuleDigest.Parse(digest.ToJson("kernel"), "o11", "builder", "AB12"));
        Assert.Throws<InvalidDataException>(() => ModuleDigest.Parse(digest.ToJson("kernel"), "o11", "kernel", "CD"));
        file["extractor"] = ModuleDigest.Extractor - 1;
        Assert.Throws<InvalidDataException>(() => ModuleDigest.Parse(System.Text.Encoding.UTF8.GetBytes(file.ToJsonString()), "o11", "kernel", "AB12"));
    }

    [Fact]
    public void ResidentReaderStoresTheDigestBesideTheIndexOnceAndRebuildsAnInvalidOne()
    {
        var folder = Path.Combine(Path.GetTempPath(), "ssam-module-digest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try {
            var capture = Path.Combine(folder, "capture.oml"); File.WriteAllText(capture, "one");
            var store = new ModuleIndexStore(Path.Combine(folder, "store"), "o11", "kernel");
            var loads = 0;
            IReadSnapshot Load(byte[] bytes) { loads++; return new ReadSnapshot<Node>(Module(), new Reader(), "Orders", () => { }); }
            IReadSnapshot Refuse(byte[] bytes) => throw new InvalidOperationException("the model was loaded");
            JsonObject Ensure() => new() { ["file"] = capture, ["digest"] = "ensure" };
            JsonObject first;
            using (var cache = new SnapshotReadCache(Load, store)) {
                first = cache.Read(Ensure());
                Assert.True(first["digest"]!["built"]!.GetValue<bool>()); Assert.Equal(1, loads);
                var sha = first["sourceSha256"]!.ToString();
                Assert.Equal(store.DigestPathOf(sha), first["digest"]!["path"]!.ToString());
                Assert.EndsWith(".kernel.digest.json", store.DigestPathOf(sha)); Assert.Contains(Path.Combine("v1", "o11", sha.ToLowerInvariant() + "."), store.DigestPathOf(sha));
                Assert.Equal(ModuleDigest.Extractor, first["digest"]!["extractor"]!.GetValue<int>());
                Assert.True(first["digest"]!["bytes"]!.GetValue<int>() > 0);
                Assert.Throws<ArgumentException>(() => cache.Read(new JsonObject { ["file"] = capture, ["digest"] = "rebuild" }));
            }
            // Another process: the stored digest answers without loading the model; another capture's hash is refused.
            using (var cold = new SnapshotReadCache(Refuse, store)) {
                Assert.False(cold.Read(Ensure())["digest"]!["built"]!.GetValue<bool>());
                var wrong = Ensure(); wrong["expectedSourceSha256"] = new string('0', 64);
                Assert.Contains("Snapshot content changed", Assert.Throws<InvalidOperationException>(() => cold.Read(wrong)).Message);
            }
            // A corrupt or foreign-version file is a miss: built again from the model.
            var stored = store.DigestPathOf(first["sourceSha256"]!.ToString());
            var valid = File.ReadAllBytes(stored);
            var older = JsonNode.Parse(valid)!; older["extractor"] = ModuleDigest.Extractor - 1;
            foreach (var broken in new[] { valid[..(valid.Length / 2)], System.Text.Encoding.UTF8.GetBytes(older.ToJsonString()) }) {
                File.WriteAllBytes(stored, broken);
                using var cache = new SnapshotReadCache(Load, store);
                loads = 0;
                Assert.True(cache.Read(Ensure())["digest"]!["built"]!.GetValue<bool>()); Assert.Equal(1, loads);
                Assert.NotNull(store.LoadDigest(first["sourceSha256"]!.ToString()));
            }
            // The cold CLI path (ModuleDigest.Ensure): the stored digest answers, load runs only on a miss.
            Assert.False(ModuleDigest.Ensure(store, capture, (_, _) => throw new InvalidOperationException("loaded"))["built"]!.GetValue<bool>());
            var other = Path.Combine(folder, "other.oml"); File.WriteAllText(other, "two");
            var built = ModuleDigest.Ensure(store, other, (bytes, sha) => ModuleDigest.Build(Module(), new Reader(), "o11", sha, bytes.Length));
            Assert.True(built["built"]!.GetValue<bool>()); Assert.True(File.Exists(built["path"]!.ToString()));
            Assert.Throws<ArgumentException>(() => store.SaveDigest(ModuleDigest.Build(Module(), new Reader(), "odc", "EE", 1)));
        } finally { Directory.Delete(folder, true); }
    }

    [Fact]
    public void DigestIsTheSameTextForTheSameModelWhateverTheChildOrder()
    {
        var first = ModuleDigest.Build(Module(), new Reader(), "odc", "CD", 1).Text;
        Assert.Equal(first, ModuleDigest.Build(Module(), new Reader(), "odc", "CD", 1).Text);
        Assert.Equal(first, ModuleDigest.Build(Module(reversed: true), new Reader(), "odc", "CD", 1).Text);
    }

    [Fact]
    public void NativeDigestCoversTheLaneFixturesDeterministicallyAndReportsItsSize()
    {
        // Reflection keeps the test source identical while binding the installed lane's assemblies.
        var assembly = typeof(ModelHost).Assembly;
        var odc = assembly.GetType("Anvil.Core.StudioAssembliesOdc");
        var binder = odc ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethods().First(m => m.Name == "Bind");
        bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        var kernel = Path.GetDirectoryName(typeof(ModuleDigestTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(kernel, "MANIFESTO.md"))) kernel = Directory.GetParent(kernel)!.FullName;
        var fixtures = Path.Combine(kernel, "tests", "fixtures");
        var lane = odc != null ? "odc" : "o11";
        var files = odc != null ? [Path.Combine(fixtures, "odc", "insurance-reactive-r8.oml")]
            : Directory.GetFiles(fixtures, "*.oml").Concat(Directory.GetFiles(Path.Combine(fixtures, "hmisjha"), "*.oml")).Order(StringComparer.Ordinal).ToArray();
        Assert.All(files, f => Assert.True(File.Exists(f), f));
        var work = Path.Combine(kernel, ".local", odc != null ? "lane-odc" : "", "module-digest-tests");
        var report = Path.Combine(kernel, ".local", "digest-report", lane);
        Directory.CreateDirectory(report);
        var sizes = new JsonArray();
        foreach (var file in files) {
            var deterministic = file.EndsWith(odc != null ? "insurance-reactive-r8.oml" : "HMISJHA_CS-v5578.oml", StringComparison.Ordinal);
            var (digest, again) = DigestOf(file, lane, work, deterministic);
            if (again != null) Assert.Equal(digest.Text, again);
            Assert.Equal(ModuleDigest.SectionIds, digest.Sections.Select(s => s.Id));
            var coverage = digest.Section("coverage").Blocks.Single();
            Assert.Contains("property read errors " + digest.ReadErrors + (digest.ReadErrors > 0 ? " (" : "."), coverage);
            // rendered + values + folded + not rendered = elements, and every element kind left out is named.
            var counts = System.Text.RegularExpressions.Regex.Match(coverage, @"^elements (\d+): rendered (\d+), values (\d+) .*?, folded (\d+).*?, not rendered (\d+)");
            Assert.True(counts.Success, coverage);
            var numbers = Enumerable.Range(1, 5).Select(i => int.Parse(counts.Groups[i].Value)).ToArray();
            Assert.Equal(numbers[0], numbers[1] + numbers[2] + numbers[3] + numbers[4]);
            Assert.Equal(digest.Elements, numbers[0]);
            Assert.Equal(digest.NotRendered, numbers[4]);
            var size = digest.Sizes(); size["fixture"] = Path.GetRelativePath(fixtures, file).Replace('\\', '/');
            sizes.Add(size);
            File.WriteAllText(Path.Combine(report, Path.GetFileNameWithoutExtension(file) + ".digest.txt"), digest.Text);
        }
        File.WriteAllText(Path.Combine(report, "sizes.json"), sizes.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
    }

    // Separate and never inlined: KernelModelReader derives from a Studio type, bound only by the caller.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static (ModuleDigest Digest, string? Again) DigestOf(string fixture, string lane, string work, bool twice)
    {
        var host = new ModelHost(work);
        var source = File.ReadAllBytes(fixture);
        var sha = Convert.ToHexString(SHA256.HashData(source));
        ModuleDigest Once() {
            var loaded = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [fixture])!;
            try {
                var signature = typeof(KernelModelReader).BaseType!.GetGenericArguments()[0];
                return (ModuleDigest)typeof(ModuleDigest).GetMethod("Build")!.MakeGenericMethod(signature)
                    .Invoke(null, [loaded, new KernelModelReader(), lane, sha, source.LongLength])!;
            } finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [loaded]); }
        }
        var digest = Once();
        return (digest, twice ? Once().Text : null);
    }
}
