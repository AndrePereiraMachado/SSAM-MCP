using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects: the rich module index (ssam-rich-index/1) holds every value, expression text, call
// argument and reference of a capture (other modules' elements by their GlobalKey), is deterministic, is stored beside the
// module index only on request and is a miss when invalid, in O11 and ODC.
public sealed class ModuleRichIndexTests
{
    private sealed class Node(string key, string kind, string name = "", params string[] kinds)
    {
        public string Key = key, Kind = kind, Name = name;
        public readonly HashSet<string> Kinds = [.. kinds.Append(kind).SelectMany(k => new[] { k, "I" + k })];
        public Node? Parent;
        public List<Node> Children = [];
        public Dictionary<string, object?> Props = [];
        public List<Node> Referrers = [];
        public Node Add(Node child) { child.Parent = this; Children.Add(child); return child; }
        public Node Set(string property, object? value) { Props[property] = value; return this; }
    }
    private sealed record Code(string Text);
    private sealed class Reader : ModelReader<Node>
    {
        protected override IEnumerable<Node> Referrers(Node n) => n.Referrers;
        protected override IEnumerable<Node> Children(Node n) => n.Children;
        protected override Node? Parent(Node n) => n.Parent;
        protected override string Key(Node n) => n.Key;
        protected override string Kind(Node n) => n.Kind;
        protected override string Name(Node n) => n.Name;
        protected override string? Label(Node n) => n.Props.GetValueOrDefault("Label") as string;
        protected override IReadOnlySet<string> KindNames(Node n) => n.Kinds;
        protected override string? Expression(object value) => (value as Code)?.Text;
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Node n) =>
            n.Props.Select(p => (p.Key, (Func<object?>)(() => p.Value is Exception error ? throw error : p.Value)));
    }

    // One element of each kind of value: literal, True and False, enum, expression, reference, a list of references that
    // are not children, a list of children, binary, a property that fails; a call with an argument to an action of
    // another module (a signature under a Reference, with the producer's GlobalKey); an expression element whose consumer
    // is the If that holds its text; a site property the native graph says the expression uses.
    private static Node Module(bool reversed = false)
    {
        var root = new Node("M1", "ESpace", "Orders").Set("GlobalKey", "M1*M1");
        var text = new Node("T1", "BasicType", "Text");
        var site = new Node("SP1", "SiteProperty", "MaxLines").Set("DefaultValue", new Code("10")).Set("GlobalKey", "M1*SP1");
        var reference = new Node("R1", "Reference", "Customers_CS").Set("ModuleKey", "PK").Set("GlobalKey", "M1*R1");
        var signature = reference.Add(new Node("S1", "ServerActionSignature", "GetCustomer", "Action")).Set("GlobalKey", "PK*A9");
        var signatureInput = signature.Add(new Node("S1.Id", "InputParameterSignature", "Id")).Set("GlobalKey", "PK*A9.Id");
        var manager = new Node("RO1", "Role", "Manager"); var guest = new Node("RO2", "Role", "Guest");
        var action = new Node("A1", "ServerAction", "PlaceOrder", "Action").Set("Public", true).Set("Function", false)
            .Set("Description", "Places an order.").Set("Kind", DayOfWeek.Monday).Set("Content", new byte[] { 1, 2 })
            .Set("Broken", new InvalidOperationException("not implemented")).Set("GlobalKey", "M1*A1");
        var code = action.Add(new Node("P1", "InputParameter", "Code")).Set("DataType", text).Set("IsMandatory", false);
        action.Set("InputParameters", new List<Node> { code }).Set("Roles", reversed ? new List<Node> { manager, guest } : [guest, manager]);
        var check = action.Add(new Node("N1", "IfNode", "", "FlowNode")).Set("Condition", new Code("Code = Site.MaxLines"));
        var condition = check.Add(new Node("N1.#Condition", "Expression", "", "Expression")).Set("Text", "Code = Site.MaxLines");
        site.Referrers.Add(condition);
        var call = action.Add(new Node("N2", "ExecuteServerActionNode", "Customer", "FlowNode")).Set("Action", signature);
        check.Set("TrueTarget", call);
        var argument = call.Add(new Node("N2.A", "Argument")).Set("Parameter", signatureInput).Set("Value", new Code("Code"));
        argument.Add(new Node("N2.A.#Value", "Expression", "", "Expression")).Set("Text", "Code");
        code.Referrers.Add(argument.Children[0]);
        IEnumerable<Node> top = [text, site, reference, manager, guest, action];
        foreach (var child in reversed ? top.Reverse() : top) root.Add(child);
        if (reversed) { action.Children.Reverse(); }
        return root;
    }

    private static JsonObject Json(ModuleRichIndex rich) => JsonNode.Parse(rich.ToJson("kernel"))!.AsObject();
    private static JsonArray Row(JsonObject json, string key) => json["rows"]!.AsArray().Select(r => r!.AsArray()).Single(r => r[0]!.ToString() == key);
    private static int RowAt(JsonObject json, string key) => json["rows"]!.AsArray().Select((r, i) => (r, i)).Single(x => x.r![0]!.ToString() == key).i;
    private static List<(string Name, string Type, string Text)> Props(JsonObject json, string key) =>
        Row(json, key)[5]!.AsArray().Select(p => (json["names"]![p![0]!.GetValue<int>()]!.ToString(), p[1]!.ToString(), p[2]!.ToString())).ToList();
    private static List<(string Target, string? Via)> Refs(JsonObject json, string key) =>
        Row(json, key)[6]!.AsArray().Select(r => (json["rows"]![r![0]!.GetValue<int>()]![0]!.ToString(),
            r[1]!.GetValue<int>() < 0 ? null : json["names"]![r[1]!.GetValue<int>()]!.ToString())).ToList();

    [Fact]
    public void RichIndexHoldsValuesExpressionTextsArgumentsAndReferences()
    {
        var rich = ModuleRichIndex.Build(Module(), new Reader(), "o11", "AB12", 100);
        var json = Json(rich);
        Assert.Equal(("ssam-rich-index/1", ModuleRichIndex.Extractor, "o11", "kernel", "ab12"),
            (json["schema"]!.ToString(), json["extractor"]!.GetValue<int>(), json["lane"]!.ToString(), json["adapter"]!.ToString(), json["sourceSha256"]!.ToString()));
        Assert.True(rich.Complete);
        // Values: literal text, True, enum (invariant text), expression, reference, a set of references ordered by text.
        // Left out: False, binary content, the list of the element's own children, the property that failed (a read error).
        var place = Props(json, "A1");
        Assert.Contains(("Description", "t", "Places an order."), place);
        Assert.Contains(("Public", "v", "True"), place);
        Assert.Contains(("Kind", "v", "Monday"), place);
        Assert.Contains(("Roles", "r", "[Role:Guest, Role:Manager]"), place);
        Assert.DoesNotContain(place, p => p.Name is "Function" or "Content" or "InputParameters" or "Broken" or "GlobalKey");
        Assert.Equal(1, rich.ReadErrors);
        Assert.Contains(("DataType", "r", "BasicType:Text"), Props(json, "P1"));
        Assert.Contains(("DefaultValue", "e", "10"), Props(json, "SP1"));
        // The text of every expression, on the property of the element that holds it.
        Assert.Contains(("Condition", "e", "Code = Site.MaxLines"), Props(json, "N1"));
        // The arguments of a call: parameter -> expression, on the call; the argument and its expression carry no copy.
        Assert.Contains(("Id", "a", "Code"), Props(json, "N2"));
        Assert.Empty(Props(json, "N2.A")); Assert.Empty(Props(json, "N2.A.#Value")); Assert.Empty(Props(json, "N1.#Condition"));
        // References: by property, by the argument (arg:<parameter>), and by the native graph through the expression
        // element, lifted to its owner with the property that holds the text.
        Assert.Contains(("S1", "Action"), Refs(json, "N2"));
        Assert.Contains(("S1.Id", "arg:Id"), Refs(json, "N2"));
        Assert.Contains(("P1", "arg:Id"), Refs(json, "N2"));
        Assert.Contains(("SP1", "Condition"), Refs(json, "N1"));
        Assert.Contains(("N2", "TrueTarget"), Refs(json, "N1"));
        Assert.Contains(("RO1", "Roles"), Refs(json, "A1"));
        Assert.Empty(Refs(json, "N1.#Condition")); Assert.Empty(Refs(json, "N2.A"));
        // Another module's element: the signature carries the producer's GlobalKey; this module's rows carry none.
        Assert.Equal("PK*A9", Row(json, "S1")[7]!.ToString());
        Assert.Null(Row(json, "A1")[7]); Assert.Null(Row(json, "SP1")[7]);
        var references = json["references"]!.AsArray().Single()!.AsArray();
        Assert.Equal((RowAt(json, "R1"), "Customers_CS", "PK"), (references[0]!.GetValue<int>(), references[1]!.ToString(), references[2]!.ToString()));
        // Rows by key; parent is the walk parent (a row); role as the module index.
        Assert.Equal(json["rows"]!.AsArray().Select(r => r![0]!.ToString()).Order(StringComparer.Ordinal), json["rows"]!.AsArray().Select(r => r![0]!.ToString()));
        Assert.Equal(RowAt(json, "A1"), Row(json, "N1")[3]!.GetValue<int>());
        Assert.Equal("action", ModuleIndex.Roles[Row(json, "A1")[4]!.GetValue<int>()]);
        var counts = rich.Counts();
        Assert.Equal((15, 1, 1), (counts["elements"]!.GetValue<int>(), counts["arguments"]!.GetValue<int>(), counts["moduleReferences"]!.GetValue<int>()));
        Assert.Equal(2, counts["expressions"]!.GetValue<int>());
    }

    [Fact]
    public void RichIndexIsTheSameFileForTheSameModelWhateverTheChildOrder()
    {
        static string Stable(ModuleRichIndex rich) { var json = Json(rich); json.Remove("createdAt"); return json.ToJsonString(); }
        var first = Stable(ModuleRichIndex.Build(Module(), new Reader(), "odc", "CD", 1));
        Assert.Equal(first, Stable(ModuleRichIndex.Build(Module(), new Reader(), "odc", "CD", 1)));
        Assert.Equal(first, Stable(ModuleRichIndex.Build(Module(reversed: true), new Reader(), "odc", "CD", 1)));
    }

    [Fact]
    public void StoredRichIndexIsTheSameAndAnyOtherFileIsAMiss()
    {
        var rich = ModuleRichIndex.Build(Module(), new Reader(), "o11", "AB12", 100);
        var parsed = ModuleRichIndex.Parse(rich.ToJson("kernel"), "o11", "kernel", "ab12");
        Assert.Equal(System.Text.Encoding.UTF8.GetString(rich.ToJson("kernel")), System.Text.Encoding.UTF8.GetString(parsed.ToJson("kernel")));
        Assert.Throws<InvalidDataException>(() => ModuleRichIndex.Parse(rich.ToJson("kernel"), "odc", "kernel", "AB12"));
        Assert.Throws<InvalidDataException>(() => ModuleRichIndex.Parse(rich.ToJson("kernel"), "o11", "builder", "AB12"));
        Assert.Throws<InvalidDataException>(() => ModuleRichIndex.Parse(rich.ToJson("kernel"), "o11", "kernel", "CD"));
        var older = Json(rich); older["extractor"] = ModuleRichIndex.Extractor - 1;
        Assert.Throws<InvalidDataException>(() => ModuleRichIndex.Parse(System.Text.Encoding.UTF8.GetBytes(older.ToJsonString()), "o11", "kernel", "AB12"));
        var outOfRange = Json(rich); outOfRange["rows"]![0]![6] = new JsonArray(new JsonArray(999, -1));
        Assert.Throws<InvalidDataException>(() => ModuleRichIndex.Parse(System.Text.Encoding.UTF8.GetBytes(outOfRange.ToJsonString()), "o11", "kernel", "AB12"));
    }

    [Fact]
    public void ResidentReaderBuildsTheRichIndexOnlyOnRequestStoresItOnceAndRebuildsAnInvalidOne()
    {
        var folder = Path.Combine(Path.GetTempPath(), "ssam-rich-index-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try {
            var capture = Path.Combine(folder, "capture.oml"); File.WriteAllText(capture, "one");
            var store = new ModuleIndexStore(Path.Combine(folder, "store"), "o11", "kernel");
            var loads = 0;
            IReadSnapshot Load(byte[] bytes) { loads++; return new ReadSnapshot<Node>(Module(), new Reader(), "Orders", () => { }); }
            IReadSnapshot Refuse(byte[] bytes) => throw new InvalidOperationException("the model was loaded");
            JsonObject Ensure() => new() { ["file"] = capture, ["rich"] = "ensure" };
            JsonObject first;
            using (var cache = new SnapshotReadCache(Load, store)) {
                // A plain read, an index ensure and a digest ensure never write the rich index: it is built only on request.
                cache.Read(new JsonObject { ["file"] = capture, ["index"] = "ensure" });
                cache.Read(new JsonObject { ["file"] = capture, ["digest"] = "ensure" });
                var sha = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(capture)));
                Assert.False(File.Exists(store.RichPathOf(sha)));
                first = cache.Read(Ensure());
                Assert.True(first["rich"]!["built"]!.GetValue<bool>()); Assert.Equal(1, loads);
                Assert.Equal(store.RichPathOf(sha), first["rich"]!["path"]!.ToString());
                Assert.EndsWith(".kernel.rich.json", store.RichPathOf(sha)); Assert.Contains(Path.Combine(ModuleIndexStore.Generation, "o11", sha.ToLowerInvariant() + "."), store.RichPathOf(sha));
                Assert.True(first["rich"]!["bytes"]!.GetValue<long>() > 0);
                Assert.Equal(15, first["rich"]!["counts"]!["elements"]!.GetValue<int>());
                Assert.True(first["timings"]!["richMs"]!.GetValue<double>() >= 0);
                Assert.Throws<ArgumentException>(() => cache.Read(new JsonObject { ["file"] = capture, ["rich"] = "rebuild" }));
            }
            // Another process: the stored rich index answers without loading the model; another capture's hash is refused.
            using (var cold = new SnapshotReadCache(Refuse, store)) {
                Assert.False(cold.Read(Ensure())["rich"]!["built"]!.GetValue<bool>());
                var wrong = Ensure(); wrong["expectedSourceSha256"] = new string('0', 64);
                Assert.Contains("Snapshot content changed", Assert.Throws<InvalidOperationException>(() => cold.Read(wrong)).Message);
            }
            // A corrupt or foreign-version file is a miss: built again from the model.
            var stored = store.RichPathOf(first["sourceSha256"]!.ToString());
            var valid = File.ReadAllBytes(stored);
            var older = JsonNode.Parse(valid)!; older["extractor"] = ModuleRichIndex.Extractor - 1;
            foreach (var broken in new[] { valid[..(valid.Length / 2)], System.Text.Encoding.UTF8.GetBytes(older.ToJsonString()) }) {
                File.WriteAllBytes(stored, broken);
                using var cache = new SnapshotReadCache(Load, store);
                loads = 0;
                Assert.True(cache.Read(Ensure())["rich"]!["built"]!.GetValue<bool>()); Assert.Equal(1, loads);
                Assert.NotNull(store.LoadRich(first["sourceSha256"]!.ToString()));
            }
            // The cold CLI path (ModuleRichIndex.Ensure): the stored file answers, load runs only on a miss.
            Assert.False(ModuleRichIndex.Ensure(store, capture, (_, _) => throw new InvalidOperationException("loaded"))["built"]!.GetValue<bool>());
            var other = Path.Combine(folder, "other.oml"); File.WriteAllText(other, "two");
            var built = ModuleRichIndex.Ensure(store, other, (bytes, sha) => ModuleRichIndex.Build(Module(), new Reader(), "o11", sha, bytes.Length));
            Assert.True(built["built"]!.GetValue<bool>()); Assert.True(File.Exists(built["path"]!.ToString()));
            Assert.Throws<ArgumentException>(() => store.SaveRich(ModuleRichIndex.Build(Module(), new Reader(), "odc", "EE", 1)));
        } finally { Directory.Delete(folder, true); }
    }

    // The lane's fixtures through the kernel reader: values, expression texts and arguments present; references inside the
    // module and to other modules; deterministic; sizes written for the measurement (kernel/.local/rich-report/<lane>).
    // O11: HMISJHA_CS consumes AgentOps_Core_CS (both fixtures): its signatures of the Core resolve to the Core's own rows by
    // GlobalKey. ODC: insurance-reactive-r8 consumes OutSystemsUI: its signatures carry the producer's module key.
    [Fact]
    public void NativeRichIndexCoversTheLaneFixturesAndResolvesOtherModulesByGlobalKey()
    {
        var assembly = typeof(ModelHost).Assembly;
        var odc = assembly.GetType("Anvil.Core.StudioAssembliesOdc");
        var binder = odc ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethods().First(m => m.Name == "Bind");
        bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        var kernel = Path.GetDirectoryName(typeof(ModuleRichIndexTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(kernel, "MANIFESTO.md"))) kernel = Directory.GetParent(kernel)!.FullName;
        var fixtures = Path.Combine(kernel, "tests", "fixtures");
        var lane = odc != null ? "odc" : "o11";
        var work = Path.Combine(kernel, ".local", odc != null ? "lane-odc" : "", "rich-index-tests");
        var report = Path.Combine(kernel, ".local", "rich-report", lane);
        Directory.CreateDirectory(report);
        var sizes = new JsonArray();
        JsonObject Indexed(string file, bool twice) {
            var (rich, again, ms) = RichOf(file, lane, work, twice);
            var json = Json(rich);
            if (again != null) { json.Remove("createdAt"); var second = JsonNode.Parse(again)!.AsObject(); second.Remove("createdAt"); Assert.Equal(json.ToJsonString(), second.ToJsonString()); }
            Assert.True(rich.Complete, file);
            var counts = rich.Counts();
            foreach (var count in new[] { "elements", "properties", "expressions", "arguments", "references", "moduleReferences" })
                Assert.True(counts[count]!.GetValue<int>() > 0, Path.GetFileName(file) + " " + count);
            sizes.Add(new JsonObject { ["fixture"] = Path.GetRelativePath(fixtures, file).Replace('\\', '/'), ["sourceBytes"] = new FileInfo(file).Length,
                ["bytes"] = rich.ToJson("kernel").Length, ["buildMs"] = ms, ["readErrors"] = rich.ReadErrors, ["counts"] = counts });
            return JsonNode.Parse(rich.ToJson("kernel"))!.AsObject();
        }
        static string Global(JsonObject index, JsonArray row) => row[7]?.ToString() ?? index["module"]!["key"] + "*" + row[0];
        static List<JsonArray> Rows(JsonObject index) => index["rows"]!.AsArray().Select(r => r!.AsArray()).ToList();
        static List<(string Name, string Type, string Text)> P(JsonObject index, JsonArray row) =>
            row[5]!.AsArray().Select(p => (index["names"]![p![0]!.GetValue<int>()]!.ToString(), p[1]!.ToString(), p[2]!.ToString())).ToList();
        if (odc == null) {
            var consumer = Indexed(Path.Combine(fixtures, "hmisjha", "HMISJHA_CS-v5578.oml"), twice: true);
            var producer = Indexed(Path.Combine(fixtures, "hmisjha", "AgentOps_Core_CS-v5585.oml"), twice: false);
            var produced = Rows(producer).Select(r => Global(producer, r)).ToHashSet(StringComparer.Ordinal);
            var core = consumer["references"]!.AsArray().Single(r => r![1]!.ToString() == "AgentOps_Core_CS")!.AsArray();
            Assert.Equal(producer["module"]!["key"]!.ToString(), core[2]!.ToString());
            var rows = Rows(consumer);
            var signatures = rows.Select((r, i) => (r, i)).Where(x => x.r[7]?.ToString().StartsWith(core[2] + "*", StringComparison.Ordinal) == true).ToList();
            Assert.NotEmpty(signatures);
            // Every signature of the Core resolves to a Core row by GlobalKey, except the hidden Id attributes the Studio
            // derives for referenced entities (".#HiddenReferenceEntity_Id": no producer row exists).
            Assert.All(signatures.Where(s => !s.r[7]!.ToString().Contains(".#Hidden", StringComparison.Ordinal)), s => Assert.Contains(s.r[7]!.ToString(), produced));
            // Consumers in HMISJHA_CS call Core actions: an Execute node refers to a Core action signature.
            var signatureRows = signatures.Select(s => s.i).ToHashSet();
            var calls = rows.Where(r => consumer["types"]![r[1]!.GetValue<int>()]!["kind"]!.ToString() == "ExecuteServerActionNode"
                && r[6]!.AsArray().Any(x => signatureRows.Contains(x![0]!.GetValue<int>()) && x[1]!.GetValue<int>() >= 0 && consumer["names"]![x[1]!.GetValue<int>()]?.ToString() == "Action")).ToList();
            Assert.NotEmpty(calls);
            // Arguments of those calls: parameter -> expression on the call.
            Assert.Contains(calls, r => P(consumer, r).Any(p => p.Type == "a" && p.Text.Length > 0));
            // Expressions and values: an If condition, an aggregate filter, a description.
            Assert.Contains(rows, r => P(consumer, r).Any(p => p is { Name: "Condition", Type: "e" }));
            Assert.Contains(rows, r => P(consumer, r).Any(p => p is { Name: "Description", Type: "t" }));
        } else {
            var consumer = Indexed(Path.Combine(fixtures, "odc", "insurance-reactive-r8.oml"), twice: true);
            var ui = consumer["references"]!.AsArray().Single(r => r![1]!.ToString() == "OutSystemsUI")!.AsArray();
            var rows = Rows(consumer);
            var signatures = rows.Select((r, i) => (r, i)).Where(x => x.r[7]?.ToString().StartsWith(ui[2] + "*", StringComparison.Ordinal) == true).Select(x => x.i).ToHashSet();
            Assert.NotEmpty(signatures);
            // Screens use OutSystemsUI blocks: some row of this module refers to an OutSystemsUI signature.
            Assert.Contains(rows, r => r[7] == null && r[6]!.AsArray().Any(x => signatures.Contains(x![0]!.GetValue<int>())));
            Assert.Contains(rows, r => P(consumer, r).Any(p => p.Type == "e" && p.Text.Length > 0));
        }
        File.WriteAllText(Path.Combine(report, "sizes.json"), sizes.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
    }

    // Separate and never inlined: KernelModelReader derives from a Studio type, bound only by the caller.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static (ModuleRichIndex Rich, string? Again, long Ms) RichOf(string fixture, string lane, string work, bool twice)
    {
        var host = new ModelHost(work);
        var source = File.ReadAllBytes(fixture);
        var sha = Convert.ToHexString(SHA256.HashData(source));
        ModuleRichIndex Once() {
            var loaded = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [fixture])!;
            try {
                var signature = typeof(KernelModelReader).BaseType!.GetGenericArguments()[0];
                return (ModuleRichIndex)typeof(ModuleRichIndex).GetMethod("Build")!.MakeGenericMethod(signature)
                    .Invoke(null, [loaded, new KernelModelReader(), lane, sha, source.LongLength])!;
            } finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [loaded]); }
        }
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var rich = Once();
        var ms = watch.ElapsedMilliseconds;
        return (rich, twice ? System.Text.Encoding.UTF8.GetString(Once().ToJson("kernel")) : null, ms);
    }
}
