using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects. The data part of TextRoundTripTests (E0 of the SSAM text plan, step DL1): the data text
// (ssam-ddl/1) reads back to the same model, element by element (the fixed point: printing, parsing and comparing gives
// no difference), every edit of the text is a difference, the grammar is closed, the stored text is the text, and the
// fixed point holds over the 34 real modules of the plan's corpus (kernel/tests/text-corpus/unique.json, absolute paths;
// skipped with a notice when the captures are not on this machine).
public sealed class TextRoundTripDataTests(ITestOutputHelper output)
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
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Node n) => n.Props.Select(p => (p.Key, (Func<object?>)(() => p.Value)));
    }

    private static int keys;
    private static Node N(string kind, string name = "", params string[] kinds) => new("k" + ++keys, kind, name, kinds);

    // One element of every kind the text writes, with the texts that need care: a description over several lines with
    // quotes and a comment mark, one with a carriage return, expressions with commas, quotes, parentheses and a ';' inside a
    // text literal, one that holds the comment mark outside a literal, a name that needs brackets, a property with no word
    // of its own, a custom label, an ODC event, sample record and settings.
    private static Node Module(string lane, bool reversed = false)
    {
        keys = 0;
        var root = N("ESpace", "Orders");
        var text = N("BasicType", "Text"); var integer = N("BasicType", "Integer"); var longInteger = N("BasicType", "Long Integer");
        var decimalType = N("BasicType", "Decimal"); var textList = N("ListType", "Text List");
        var sales = N("Folder", "Sales");
        var audit = N("ServerAction", "AuditCreate", "Action"); var place = N("ServerAction", "PlaceOrder", "Action");
        var customer = N("ServerEntity", "Customer", "Entity").Set("Public", true).Set("UpdateBehavior", "Full").Set("Folder", sales)
            .Set("Description", "Who buys.\n  \"Quoted\" -- not a comment\n\nLast line").Set("IsMultiTenant", "Inherited").Set("ExposeReadOnly", true)
            .Set("Label", "Customer").Set("LabelPlural", "Customers").Set("ArchivePolicy", "Keep 30 days");
        var id = customer.Add(N("EntityAttribute", "Id")).Set("DataType", longInteger).Set("IsAutoNumber", "Yes").Set("IsMandatory", true).Set("DeleteRule", "Protect").Set("Label", "Id");
        var name = customer.Add(N("EntityAttribute", "Name")).Set("DataType", text).Set("Length", "120").Set("IsMandatory", true).Set("DeleteRule", "Protect")
            .Set("Label", "Full name").Set("Description", "Shown on\r\nthe card").Set("IsAutoNumber", "No");
        var code = customer.Add(N("EntityAttribute", "Code")).Set("DataType", text).Set("Length", "20").Set("DeleteRule", "Protect").Set("Label", "Code")
            .Set("DefaultValue", new Code("\"A, B\" + If(True, \"\"\"q\"\"\", \"x\")")).Set("IsAutoNumber", "No");
        customer.Add(N("EntityAttribute", "Weird")).Set("DataType", integer).Set("DeleteRule", "Protect").Set("Label", "Weird").Set("DefaultValue", new Code("1 -- 2")).Set("IsAutoNumber", "No");
        var identifierType = N("IdentifierType", "Customer Identifier").Set("Entity", customer);
        customer.Add(N("EntityAttribute", "ParentId")).Set("DataType", identifierType).Set("DeleteRule", "Delete").Set("Label", "Parent").Set("IsAutoNumber", "No");
        customer.Add(N("EntityAttribute", "Price")).Set("DataType", decimalType).Set("Length", "37").Set("Decimals", "8").Set("DeleteRule", "Protect").Set("Label", "Price").Set("IsAutoNumber", "No");
        customer.Add(N("EntityAttribute", "none")).Set("DataType", text).Set("DeleteRule", "Protect").Set("Label", "none").Set("IsAutoNumber", "No");
        customer.Set("Identifier", id).Set("LabelAttribute", name);
        var unique = customer.Add(N("EntityIndex", "UX_Code")).Set("Unique", true);
        unique.Add(N("EntityIndexAttribute")).Set("Attribute", code); unique.Add(N("EntityIndexAttribute")).Set("Attribute", name);
        customer.Add(N("EntityIndex", "AutoIndex_ParentId")).Set("AutoGenerated", true).Add(N("EntityIndexAttribute")).Set("Attribute", id);
        var onCreate = customer.Add(N("OnCreateLifeCycleDatabaseEvent")).Set("Destination", audit);
        onCreate.Add(N("Argument")).Set("Parameter", N("InputParameter", "Id")).Set("Value", new Code("Id"));
        customer.Add(N("OnDeleteLifeCycleDatabaseEvent"));
        customer.Set("OnCreate", onCreate);
        var sample = customer.Add(N("Record"));
        sample.Add(N("RecordAttributeValue")).Set("Attribute", name).Set("Value", new Code("\"Sample\""));
        sample.Add(N("RecordAttributeValue")).Set("Attribute", code).Set("Value", new Code(""));
        customer.Set("SampleRecord", sample);
        customer.Add(N("EntityActionSignature", "CreateCustomer")); customer.Set("CreateAction", customer.Children[^1]);

        var status = N("StaticEntity", "Status", "Entity").Set("IsMultiTenant", "No").Set("Label", "Status").Set("LabelPlural", "Statuses").Set("UseTranslations", true)
            .Set("ExposeReadOnly", true);
        var sid = status.Add(N("EntityAttribute", "Id")).Set("DataType", integer).Set("IsMandatory", true).Set("DeleteRule", "Ignore").Set("Label", "Id").Set("IsAutoNumber", "No");
        var slabel = status.Add(N("EntityAttribute", "Label")).Set("DataType", text).Set("Length", "50").Set("DeleteRule", "Ignore").Set("Label", "Label").Set("IsAutoNumber", "No");
        var sorder = status.Add(N("EntityAttribute", "Order")).Set("DataType", integer).Set("DeleteRule", "Ignore").Set("Label", "Order").Set("IsAutoNumber", "No");
        status.Set("Identifier", sid).Set("LabelAttribute", slabel).Set("OrderByAttribute", sorder);
        var recordKind = lane == "odc" ? "StaticEntityRecord" : "Record";
        IEnumerable<Node> records = [N(recordKind, "", "Record").Set("Identifier", "Open"), N(recordKind, "", "Record").Set("Identifier", "Closed"), N(recordKind, "", "Record").Set("Identifier", "Empty")];
        foreach (var record in reversed ? records.Reverse() : records) status.Add(record);
        foreach (var record in status.Children.Where(c => c.Kind == recordKind)) {
            var (number, label) = record.Props["Identifier"] switch { "Open" => ("1", "\"Open, now\""), "Closed" => ("2", "\"Closed (done)\""), _ => ("3", "") };
            IEnumerable<Node> values = [N("RecordAttributeValue").Set("Attribute", sid).Set("Value", new Code(number)),
                N("RecordAttributeValue").Set("Attribute", slabel).Set("Value", new Code(label)), N("RecordAttributeValue").Set("Attribute", sorder).Set("Value", new Code(number))];
            foreach (var value in reversed ? values.Reverse() : values) record.Add(value);
        }

        var line = N("Structure", "Line").Set("Public", true).Set("Folder", sales).Set("Description", "One line.");
        line.Add(N("StructureAttribute", "Qty")).Set("DataType", integer).Set("IsMandatory", true).Set("Label", "Qty");
        line.Add(N("StructureAttribute", "Note")).Set("DataType", text).Set("Length", "10").Set("NameInJSON", "note \"x\"").Set("DefaultValue", new Code("\";\"")).Set("Label", "Note");
        line.Add(N("StructureAttribute", "Items")).Set("DataType", textList).Set("Label", "Items list");

        var maxLines = N("SiteProperty", "MaxLines").Set("DataType", integer).Set("DefaultValue", new Code("10")).Set("IsReadOnly", true).Set("Folder", sales)
            .Set("Description", "Limit.").Set("IsMultiTenant", "Inherited");
        var token = N("SiteProperty", "ApiToken").Set("DataType", text).Set("IsSecret", true).Set("IsMultiTenant", "Inherited");
        var cart = N("ClientVariable", "Cart").Set("DataType", integer).Set("DefaultValue", new Code("0"));
        var phone = N("SessionVariable", "Phone").Set("DataType", text);
        var nightly = N("Timer", "Nightly").Set("Action", place).Set("Schedule", "When Published").Set("Priority", "High").Set("TimeoutInMinutes", "5").Set("IsMultiTenant", "Inherited");
        nightly.Add(N("Argument")).Set("Parameter", N("InputParameter", "Force")).Set("Value", new Code("True"));
        nightly.Add(N("ActionSignature", "WakeNightly"));
        IEnumerable<Node> top = [customer, status, line, maxLines, token, cart, phone, nightly, audit, place, sales, text, integer, longInteger, decimalType];
        foreach (var child in reversed ? top.Reverse() : top) root.Add(child);
        return root;
    }

    private static string Details(DdlCheck check) =>
        (check.ParseError ?? "") + string.Join("\n", check.Mismatches.Take(20).Select(m => m.Kind + " " + m.Name + " @" + m.Key + " " + m.Property + ": " + m.Expected + " | " + m.Actual));

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void DataTextReadsBackToTheSameModel(string lane)
    {
        var check = DdlCheck.Run(Module(lane), new Reader(), lane);
        Assert.True(check.FixedPoint, Details(check));
        var recordKind = lane == "odc" ? "StaticEntityRecord" : "Record";
        var expected = new Dictionary<string, int> {
            ["ServerEntity"] = 1, ["EntityAttribute"] = 10, ["EntityIndex"] = 1, ["OnCreateLifeCycleDatabaseEvent"] = 1, ["Record"] = 1,
            ["StaticEntity"] = 1, [recordKind] = lane == "odc" ? 3 : 4, ["RecordAttributeValue"] = 11, ["Structure"] = 1, ["StructureAttribute"] = 3,
            ["SiteProperty"] = 2, ["ClientVariable"] = 1, ["SessionVariable"] = 1, ["Timer"] = 1 };
        if (lane == "odc") expected["Record"] = 1;
        Assert.Equal(expected.OrderBy(e => e.Key, StringComparer.Ordinal), check.Kinds.Select(k => KeyValuePair.Create(k.Key, k.Value.Total)).OrderBy(e => e.Key, StringComparer.Ordinal));
        Assert.All(check.Kinds, k => Assert.Equal(k.Value.Total, k.Value.Exact));
        // The empty ODC event and the generated index are written as nothing, and checked to hold nothing.
        Assert.Equal(1, check.Empty["entity event"]); Assert.Equal(1, check.Empty["EntityIndex (generated)"]);
        Assert.Contains(check.Computed.Keys, k => k.StartsWith("ServerEntity.CreateAction", StringComparison.Ordinal));
    }

    [Fact]
    public void DataTextIsTheTextTheContractShows()
    {
        var text = DataDdl.Build(Module("odc"), new Reader(), "odc", "AB12", 1).Text;
        foreach (var line in new[] {
            "-- ssam-ddl/1 module=Orders lane=odc key=@k1 sourceSha256=ab12 elements=",
            "/// Who buys.\n///   \"Quoted\" -- not a comment\n///\n/// Last line\ncreate entity Customer public label Name update full folder Sales os:ArchivePolicy=\"Keep 30 days\" ( -- @",
            "  Id Long Integer identifier auto required, -- @",
            "  ///$\"Shown on\\r\\nthe card\"\n  Name Text(120) required label \"Full name\", -- @",
            "  Code Text(20) default \"A, B\" + If(True, \"\"\"q\"\"\", \"x\"), -- @",
            "  Weird Integer default $\"1 -- 2\", -- @",
            "  ParentId Customer Identifier references Customer on delete Delete, -- @",
            "  Price Decimal(37,8), -- @",
            "  [none] Text -- @",
            ");\non create Customer -> AuditCreate(Id = Id); -- @",
            "\nsample Customer (Name = \"Sample\"); -- @",
            "\ncreate unique index UX_Code on Customer (Code, Name); -- @",
            "create static entity Status ( -- @",
            ")\nvalues\n  Closed (Id = 2, Label = \"Closed (done)\", Order = 2), -- @",
            "  Empty (Id = 3, Order = 3), -- @",
            "  Open (Id = 1, Label = \"Open, now\", Order = 1); -- @",
            "/// One line.\ntype Line public folder Sales = { -- @",
            "  Qty: Integer required; -- @",
            "  Note: Text(10) json \"note \"\"x\"\"\" default \";\"; -- @",
            "  Items: Text List label \"Items list\"; -- @",
            "/// Limit.\nsetting MaxLines: Integer read-only folder Sales = 10 -- @",
            "setting ApiToken: Text secret -- @",
            "client variable Cart: Integer = 0 -- @",
            "session variable Phone: Text -- @",
            "timer Nightly action PlaceOrder schedule \"When Published\" priority High timeout 5 with (Force = True) -- @" })
            Assert.Contains(line, text);
        Assert.DoesNotContain("AutoIndex_ParentId", text);
        Assert.DoesNotContain("OnDelete", text);
        Assert.Contains("site property MaxLines", DataDdl.Build(Module("o11"), new Reader(), "o11", "AB12", 1).Text);
    }

    [Fact]
    public void DataTextIsTheSameWhateverTheChildOrder()
    {
        foreach (var lane in new[] { "o11", "odc" })
            Assert.Equal(DataDdl.Build(Module(lane), new Reader(), lane, "CD", 1).Text, DataDdl.Build(Module(lane, reversed: true), new Reader(), lane, "CD", 1).Text);
    }

    // Each edit is one way back would carry: the text no longer reads back to the model, and the check names it.
    public static IEnumerable<object[]> Edits() => new (string Name, string From, string To)[] {
        ("description line", "/// Last line", "/// Last line!"),
        ("description removed", "/// One line.\n", ""),
        ("json description", "///$\"Shown on\\r\\nthe card\"", "///$\"Shown on\\nthe card\""),
        ("name", "  Price Decimal(37,8)", "  Prices Decimal(37,8)"),
        ("type", "  Price Decimal(37,8)", "  Price Integer(37,8)"),
        ("length", "Text(120)", "Text(121)"),
        ("decimals", "Decimal(37,8)", "Decimal(37,2)"),
        ("required added", "  Price Decimal(37,8),", "  Price Decimal(37,8) required,"),
        ("required removed", "  Qty: Integer required;", "  Qty: Integer;"),
        ("auto removed", "identifier auto required", "identifier required"),
        ("identifier moved", "  Id Long Integer identifier auto required,", "  Id Long Integer auto required,"),
        ("delete rule", "on delete Delete", "on delete Protect"),
        ("label", "label \"Full name\"", "label \"Name\""),
        ("label removed", " label \"Items list\"", ""),
        ("json", "json \"note \"\"x\"\"\"", "json \"note\""),
        ("default", "default \"A, B\" + If(True, \"\"\"q\"\"\", \"x\")", "default \"A, B\""),
        ("default removed", " default \";\"", ""),
        ("json expression", "default $\"1 -- 2\"", "default $\"1 - 2\""),
        ("os value", "os:ArchivePolicy=\"Keep 30 days\"", "os:ArchivePolicy=\"Keep 31 days\""),
        ("os removed", " os:ArchivePolicy=\"Keep 30 days\"", ""),
        ("os added", "create static entity Status (", "create static entity Status os:ExposeReadOnly=False ("),
        ("public removed", "create entity Customer public", "create entity Customer"),
        ("public added", "type Line public", "type Line"),
        ("label attribute", "label Name update", "label Code update"),
        ("update behavior", "update full", "update optimized"),
        ("folder", "folder Sales os:", "folder Other os:"),
        ("record value", "Label = \"Open, now\"", "Label = \"Open\""),
        ("record value removed", ", Label = \"Closed (done)\"", ""),
        ("record value added", "Empty (Id = 3, Order = 3)", "Empty (Id = 3, Label = \"E\", Order = 3)"),
        ("record name", "  Closed (Id = 2", "  Shut (Id = 2"),
        ("sample value", "sample Customer (Name = \"Sample\")", "sample Customer (Name = \"Other\")"),
        ("index unique", "create unique index UX_Code", "create index UX_Code"),
        ("index column order", "(Code, Name)", "(Name, Code)"),
        ("event handler", "-> AuditCreate(Id = Id)", "-> PlaceOrder(Id = Id)"),
        ("event argument", "AuditCreate(Id = Id)", "AuditCreate(Id = 1)"),
        ("variable default", "Cart: Integer = 0", "Cart: Integer = 1"),
        ("variable read-only", "Integer read-only folder", "Integer folder"),
        ("variable secret", "ApiToken: Text secret", "ApiToken: Text"),
        ("timer schedule", "schedule \"When Published\"", "schedule \"Daily\""),
        ("timer priority", "priority High", "priority Low"),
        ("timer timeout", "timeout 5", "timeout 6"),
        ("timer argument", "with (Force = True)", "with (Force = False)"),
        ("structure attribute order", "  Qty: Integer required; -- @{Qty}\n  Note:", "  Note:"),
        ("key", "-- @{Price}", "-- @{Price}x"),
        ("keys swapped", "-- @{Qty}", "-- @{Items}") }.Select(e => new object[] { e.Name, e.From, e.To });

    [Theory]
    [MemberData(nameof(Edits))]
    public void EveryEditOfTheTextIsADifference(string edit, string from, string to)
    {
        var model = Module("odc");
        var text = DataDdl.Build(model, new Reader(), "odc", "", 0).Text;
        // {Name} in an edit is the key of that element of the model.
        string Keys(string s) => System.Text.RegularExpressions.Regex.Replace(s, @"\{(\w+)\}", m => new Reader().Walk(model).First(n => n.Name == m.Groups[1].Value).Key);
        from = Keys(from); to = Keys(to);
        if (edit == "structure attribute order") {
            // Move Qty after Note: the same lines, another order.
            var qty = text[text.IndexOf("  Qty: ", StringComparison.Ordinal)..];
            qty = qty[..(qty.IndexOf('\n') + 1)];
            var note = text[text.IndexOf("  Note: ", StringComparison.Ordinal)..];
            note = note[..(note.IndexOf('\n') + 1)];
            Assert.Contains(qty + note, text);
            from = qty + note; to = note + qty;
        }
        Assert.Contains(from, text);
        var edited = text.Replace(from, to);
        Assert.NotEqual(text, edited);
        var check = DdlCheck.Run(model, new Reader(), "odc", edited);
        Assert.Null(check.ParseError);
        Assert.False(check.FixedPoint, edit + ": the check found no difference");
        Assert.NotEmpty(check.Mismatches);
    }

    [Theory]
    [InlineData("alter table Customer;", "unknown statement 'alter'")]
    [InlineData("create entity X shiny ( -- @a\n);", "unknown entity clause 'shiny'")]
    [InlineData("create entity X public public ( -- @a\n);", "Public is written twice")]
    [InlineData("create entity X ( -- @a\n  A Text required required -- @b\n);", "IsMandatory is written twice")]
    [InlineData("create entity X ( -- @a\n  A Text -- @b\n  B Text -- @c\n);", "attributes are separated by ','")]
    [InlineData("-- @a\ncreate entity X ( -- @b\n);", "a key comment with no element on its line")]
    [InlineData("/// lonely\n", "a description (///) with no element after it")]
    [InlineData("create entity X ( -- @a\n  /// orphan\n);", "a description (///) with no attribute after it")]
    [InlineData("type T = { -- @a\n  A: Text\n} ", "expected ';'")]
    [InlineData("timer T action A soon -- @a", "unknown timer clause 'soon'")]
    public void TheGrammarIsClosedAndEveryErrorNamesItsLine(string text, string message)
    {
        var error = Assert.ThrowsAny<FormatException>(() => DdlParser.Parse("-- ssam-ddl/1 module=M lane=odc\n" + text));
        Assert.Contains(message, error.Message);
        Assert.Matches(@"^line \d+: ", error.Message);
    }

    // Every problem of a text comes at once, each with its line: the parse goes on at the next statement.
    [Fact]
    public void EveryProblemOfATextComesAtOnce()
    {
        var text = "-- ssam-ddl/1 module=M lane=odc\ncreate entity X shiny ( -- @a\n  A Text -- @b\n)\nvalues\n  R (A = 1); -- @r\n"
            + "/// Y.\ncreate entity Y public public ( -- @c\n);\ntype T = { -- @d\n  B: Text -- @e\n}\ncreate entity Z ( -- @f\n);\n";
        var error = Assert.Throws<DdlParseException>(() => DdlParser.Parse(text));
        Assert.Equal(new[] { 2, 8, 11 }, error.Errors.Select(e => e.Line));
        Assert.Contains("line 2: unknown entity clause 'shiny'", error.Message);
        Assert.Contains("line 8: Public is written twice", error.Message);
        Assert.Contains("line 11: expected ';'", error.Message);
    }

    [Fact]
    public void StoredTextIsTheSameTextAndAnyOtherFileIsAMiss()
    {
        var ddl = DataDdl.Build(Module("o11"), new Reader(), "o11", "AB12", 100);
        var parsed = DataDdl.Parse(ddl.ToJson("kernel"), "o11", "kernel", "ab12");
        Assert.Equal(ddl.Text, parsed.Text);
        Assert.Equal(ddl.Sizes().ToJsonString(), parsed.Sizes().ToJsonString());
        Assert.Equal(ddl.Blocks, parsed.Blocks);
        Assert.Throws<InvalidDataException>(() => DataDdl.Parse(ddl.ToJson("kernel"), "odc", "kernel", "AB12"));
        Assert.Throws<InvalidDataException>(() => DataDdl.Parse(ddl.ToJson("kernel"), "o11", "builder", "AB12"));
        Assert.Throws<InvalidDataException>(() => DataDdl.Parse(ddl.ToJson("kernel"), "o11", "kernel", "CD"));
        var file = JsonNode.Parse(ddl.ToJson("kernel"))!;
        file["extractor"] = DataDdl.Extractor - 1;
        Assert.Throws<InvalidDataException>(() => DataDdl.Parse(System.Text.Encoding.UTF8.GetBytes(file.ToJsonString()), "o11", "kernel", "AB12"));
        var folder = Path.Combine(Path.GetTempPath(), "ssam-ddl-store-" + Guid.NewGuid().ToString("N"));
        try {
            var capture = Path.Combine(folder, "capture.oml"); Directory.CreateDirectory(folder); File.WriteAllText(capture, "one");
            var store = new ModuleIndexStore(Path.Combine(folder, "store"), "o11", "kernel");
            var built = DataDdl.Ensure(store, capture, (bytes, sha) => DataDdl.Build(Module("o11"), new Reader(), "o11", sha, bytes.Length));
            Assert.True(built["built"]!.GetValue<bool>()); Assert.EndsWith(".kernel.ddl.json", built["path"]!.ToString());
            Assert.False(DataDdl.Ensure(store, capture, (_, _) => throw new InvalidOperationException("loaded"))["built"]!.GetValue<bool>());
        } finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }

    // The plan's corpus: the data elements of every module of this lane read back exactly. The floors are the elements
    // measured on 2026-10-11 (the module's own elements; the platform's built-in types the module keeps a copy of, like
    // the System Attachment structure, are not its data and are counted apart).
    private static readonly Dictionary<string, Dictionary<string, int>> Floors = new() {
        ["o11"] = new() { ["ServerEntity"] = 122, ["StaticEntity"] = 144, ["EntityAttribute"] = 2244, ["EntityIndex"] = 180, ["Record"] = 4156,
            ["RecordAttributeValue"] = 42229, ["Structure"] = 792, ["StructureAttribute"] = 6829, ["SiteProperty"] = 86, ["ClientVariable"] = 167,
            ["SessionVariable"] = 3, ["Timer"] = 6 },
        ["odc"] = new() { ["ServerEntity"] = 26, ["StaticEntity"] = 37, ["EntityAttribute"] = 351, ["EntityIndex"] = 17, ["StaticEntityRecord"] = 279,
            ["RecordAttributeValue"] = 1403, ["Structure"] = 110, ["StructureAttribute"] = 869, ["SiteProperty"] = 55, ["ClientVariable"] = 91, ["Timer"] = 1 } };

    [Fact]
    public void NativeCorpusIsAFixedPoint()
    {
        var assembly = typeof(ModelHost).Assembly;
        var odc = assembly.GetType("Anvil.Core.StudioAssembliesOdc");
        var lane = odc != null ? "odc" : "o11";
        var kernel = Path.GetDirectoryName(typeof(TextRoundTripDataTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(kernel, "MANIFESTO.md"))) kernel = Directory.GetParent(kernel)!.FullName;
        var manifest = Path.Combine(kernel, "tests", "text-corpus", "unique.json");
        var entries = JsonNode.Parse(File.ReadAllText(manifest))!.AsArray().Where(e => e!["lane"]!.ToString() == lane).ToList();
        var present = entries.Where(e => File.Exists(e!["oml"]!.ToString())).ToList();
        if (present.Count == 0) { output.WriteLine("SKIPPED: the text corpus of the " + lane + " lane is not on this machine (" + manifest + ")"); return; }
        if (present.Count < entries.Count) output.WriteLine("NOTICE: " + (entries.Count - present.Count) + " capture(s) of the corpus are missing; the floors are not checked");
        var binder = odc ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethods().First(m => m.Name == "Bind");
        bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        var work = Path.Combine(kernel, ".local", odc != null ? "lane-odc" : "", "text-roundtrip-tests");
        var totals = new SortedDictionary<string, (int Total, int Exact)>(StringComparer.Ordinal);
        var failures = new List<string>();
        var edits = 0;
        foreach (var entry in present) {
            var file = entry!["oml"]!.ToString();
            var source = File.ReadAllBytes(file);
            Assert.Equal(entry["sha"]!.ToString(), Convert.ToHexString(SHA256.HashData(source)), StringComparer.OrdinalIgnoreCase);
            var (check, edited) = CheckOf(file, lane, work);
            output.WriteLine(entry["label"] + ": " + check.Exact + " of " + check.Elements + " exact" + (check.ParseError != null ? ", parse error " + check.ParseError : "")
                + "; " + edited.Count + " edits of its text, each a difference");
            if (!check.FixedPoint) failures.Add(entry["label"] + ": " + Details(check));
            // Every edit of the real text is a difference (the comparison is not blind to any of them).
            foreach (var (edit, result) in edited) {
                edits++;
                if (result.ParseError != null) failures.Add(entry["label"] + " edit " + edit + ": parse error " + result.ParseError);
                else if (result.FixedPoint) failures.Add(entry["label"] + " edit " + edit + ": no difference found");
            }
            foreach (var (kind, (total, exact)) in check.Kinds) { var (t, e) = totals.GetValueOrDefault(kind); totals[kind] = (t + total, e + exact); }
        }
        foreach (var (kind, (total, exact)) in totals) output.WriteLine(kind + " " + exact + "/" + total);
        Assert.True(failures.Count == 0, string.Join("\n", failures));
        Assert.True(edits > present.Count * 4, "edits " + edits);
        if (present.Count == entries.Count)
            foreach (var (kind, floor) in Floors[lane]) Assert.True(totals.GetValueOrDefault(kind).Total >= floor, kind + ": " + totals.GetValueOrDefault(kind).Total + " < " + floor);
    }

    // Separate and never inlined: KernelModelReader derives from a Studio type, bound only by the caller. The module's own
    // text, then each edit of it (RealEdits), read back against the same loaded model.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static (DdlCheck Check, List<(string Edit, DdlCheck Result)> Edited) CheckOf(string file, string lane, string work)
    {
        var host = new ModelHost(work);
        var loaded = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [file])!;
        try {
            var signature = typeof(KernelModelReader).BaseType!.GetGenericArguments()[0];
            var run = typeof(DdlCheck).GetMethod("Run")!.MakeGenericMethod(signature);
            var build = typeof(DataDdl).GetMethod("Build")!.MakeGenericMethod(signature);
            var check = (DdlCheck)run.Invoke(null, [loaded, new KernelModelReader(), lane, null])!;
            var text = ((DataDdl)build.Invoke(null, [loaded, new KernelModelReader(), lane, "", 0L])!).Text;
            var edited = RealEdits(text).Select(e => (e.Name, (DdlCheck)run.Invoke(null, [loaded, new KernelModelReader(), lane, e.Text])!)).ToList();
            return (check, edited);
        } finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [loaded]); }
    }

    // One edit of each kind the real text allows, at the occurrence in the middle of the text: a key, a description line,
    // a default, a record value, a length, required, a custom label, an os: clause, public, a type, two attributes swapped.
    private static IEnumerable<(string Name, string Text)> RealEdits(string text)
    {
        var lines = text.Split('\n');
        IEnumerable<(string, string)> At(string name, Func<string, bool> pick, Func<string, string> change)
        {
            var found = Enumerable.Range(0, lines.Length).Where(i => pick(lines[i])).ToList();
            if (found.Count == 0) yield break;
            var at = found[found.Count / 2];
            var copy = (string[])lines.Clone();
            copy[at] = change(lines[at]);
            if (copy[at] != lines[at]) yield return (name + " (line " + (at + 1) + ")", string.Join('\n', copy));
        }
        var record = new System.Text.RegularExpressions.Regex(@"^  \S+ \(\S+ = ");
        var length = new System.Text.RegularExpressions.Regex(@"Text\((\d+)\)");
        var os = new System.Text.RegularExpressions.Regex(@" os:\w+=(""(?:[^""]|"""")*""|\S+)");
        foreach (var edit in At("key", l => l.Contains(" -- @"), l => l + "x")
            .Concat(At("description", l => l.TrimStart().StartsWith("/// ", StringComparison.Ordinal), l => l + "!"))
            .Concat(At("default", l => l.Contains(" default ") && !l.Contains(" default $"), l => l.Replace(" default ", " default 1 + ")))
            .Concat(At("record value", l => record.IsMatch(l), l => record.Replace(l, m => m.Value + "0 + ", 1)))
            .Concat(At("length", l => length.IsMatch(l), l => length.Replace(l, m => "Text(" + (long.Parse(m.Groups[1].Value) + 1) + ")", 1)))
            .Concat(At("required", l => l.Contains(" required"), l => l.Replace(" required", "")))
            .Concat(At("label", l => l.Contains(" label \""), l => l.Replace(" label \"", " label \"!")))
            .Concat(At("os", l => os.IsMatch(l), l => os.Replace(l, "", 1)))
            .Concat(At("public", l => l.StartsWith("create entity ", StringComparison.Ordinal) && l.Contains(" public"), l => l.Replace(" public", "")))
            .Concat(At("type", l => l.StartsWith("  ", StringComparison.Ordinal) && l.Contains(" Boolean"), l => l.Replace(" Boolean", " Integer"))))
            yield return edit;
        // Two attributes of an entity swapped (both followed by a comma): the same lines in another order.
        var pairs = Enumerable.Range(0, lines.Length - 1).Where(i => lines[i].StartsWith("  ", StringComparison.Ordinal) && lines[i + 1].StartsWith("  ", StringComparison.Ordinal)
            && !lines[i].TrimStart().StartsWith("///", StringComparison.Ordinal) && !lines[i + 1].TrimStart().StartsWith("///", StringComparison.Ordinal)
            && System.Text.RegularExpressions.Regex.IsMatch(lines[i], @", -- @\S+$") && System.Text.RegularExpressions.Regex.IsMatch(lines[i + 1], @", -- @\S+$")
            && !record.IsMatch(lines[i]) && !record.IsMatch(lines[i + 1])).ToList();
        if (pairs.Count > 0) {
            var at = pairs[pairs.Count / 2];
            var copy = (string[])lines.Clone();
            (copy[at], copy[at + 1]) = (copy[at + 1], copy[at]);
            yield return ("attributes swapped (line " + (at + 1) + ")", string.Join('\n', copy));
        }
    }
}
