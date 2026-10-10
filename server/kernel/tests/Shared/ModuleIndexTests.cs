using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects: the module index answers exactly what ModelReader.Read answers, in O11 and ODC.
public sealed class ModuleIndexTests
{
    private sealed class Node(string key, string kind, string name = "", string? label = null, bool nameProperty = true)
    {
        public string Key = key, Kind = kind, Name = name;
        public string? Label = label;
        public Node? Parent;
        public List<Node> Children = [];
        public Dictionary<string, object?> Props = nameProperty ? new() { ["Name"] = name } : [];
        public Node Add(Node child) { child.Parent = this; Children.Add(child); return child; }
    }
    private sealed class Reader : ModelReader<Node>
    {
        protected override IEnumerable<Node> Referrers(Node n) => [];
        protected override IEnumerable<Node> Children(Node n) => n.Children;
        protected override Node? Parent(Node n) => n.Parent;
        protected override string Key(Node n) => n.Key;
        protected override string Kind(Node n) => n.Kind;
        protected override string Name(Node n) => n.Name;
        protected override string? Label(Node n) => n.Label;
        // Like the Model API: a screen also answers to another interface, and every interface has a FullName.
        protected override IReadOnlySet<string> KindNames(Node n) => n.Kind == "MobileScreen"
            ? new HashSet<string> { "IMobileScreen", "IWebScreen", "Model.IMobileScreen" } : new HashSet<string> { "I" + n.Kind, "Model.I" + n.Kind };
        protected override string? Expression(object value) => null;
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Node n) => n.Props.Select(p => (p.Key, (Func<object?>)(() => p.Value)));
    }
    private static JsonNode Json(object value) => JsonSerializer.SerializeToNode(value)!;
    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    // Keys out of order, names that differ only in case, a clipped path and Name, nodes without a Name property,
    // and a parent outside Children (an O11 aggregate's DataTable).
    private static Node Module(string variant = "")
    {
        var root = new Node("root", "ESpace", "Module" + variant);
        var flow = root.Add(new("b/flow", "MobileFlow", "MainFlow"));
        var home = flow.Add(new("_home", "MobileScreen", "Home" + variant));
        home.Add(new("Box", "Container", "", "Box", nameProperty: false));
        home.Add(new("+text", "TextWidget", "", "Welcome", nameProperty: false));
        flow.Add(new("a", "MobileScreen", "home" + variant));
        var action = root.Add(new("A", "ServerAction", new string('L', 100)));
        action.Add(new("A.#Value", "Expression", nameProperty: false));
        var aggregate = action.Add(new("agg", "AggregateNode", "GetThings"));
        var table = new Node("table", "DataTable", nameProperty: false) { Parent = aggregate };
        aggregate.Children.Add(new("source", "AddSourceOperation", "Things") { Parent = table });
        root.Add(new("entity", "Entity", new string('E', 450)));
        return root;
    }

    private static readonly ReadingOptions[] Listings = [
        new(Kind: "*", Max: 3, Properties: "Name"), new(Kind: "*", Max: 3, Offset: 3, Properties: "Name"), new(Kind: "*", Max: 500, Offset: 9, Properties: "Name"),
        new(Kind: "MobileScreen", Properties: "Name"), new(Kind: "WebScreen", Properties: "Name"), new(Kind: "IMobileScreen", Properties: "Name"),
        new(Kind: "Model.IMobileScreen", Properties: "Name"), new(Kind: "NoSuchKind", Properties: "Name"), new(Name: "HOME", Properties: "Name"),
        new(Kind: "MobileScreen", Name: "home", Properties: " Name ,Name"), new(Kind: "Container", Properties: ""), new(Offset: 2, Properties: "Name"),
        new(Kind: "Entity", Properties: "Name"), new(Kind: "AddSourceOperation", Properties: "Name"), new(Kind: "Expression", Max: 1, Properties: "Name"),
        new(Name: "Welcome", Properties: "Name")];

    [Fact]
    public void IndexAnswersAreTheModelReaderAnswersAndSurviveTheirFile()
    {
        var root = Module(); var reader = new Reader();
        var index = ModuleIndex.Build(root, reader, "Module", "o11", "kernel", "AB", 10);
        Assert.True(index.Complete); Assert.Equal(11, index.Count);
        var parsed = ModuleIndex.Parse(index.ToJson(), "o11", "kernel", "ab");
        foreach (var options in Listings) {
            var expected = Json(reader.Read(root, "/", options)).ToJsonString();
            Assert.Equal(expected, index.Query("/", options)?.ToJsonString());
            Assert.Equal(expected, parsed.Query("/", options)?.ToJsonString());
        }
        Assert.Contains("DataTable:/AddSourceOperation:Things", index.Query("/", new(Kind: "AddSourceOperation", Properties: "Name"))!.ToJsonString());
        var file = JsonNode.Parse(index.ToJson())!;
        Assert.Equal("ssam-module-index/1", file["schema"]!.ToString());
        Assert.Equal(11, file["rows"]!.AsArray().Count); Assert.Single(file["ancestors"]!.AsArray());
        Assert.Equal(-2, file["rows"]!.AsArray().Single(r => r![0]!.ToString() == "source")![5]!.GetValue<int>());
        Assert.Contains("IWebScreen", file["types"]!.AsArray().First(t => t!["kind"]!.ToString() == "MobileScreen")!["answers"]!.AsArray().Select(a => a!.ToString()));
        Assert.Equal(2, file["counts"]!["byRole"]!["screen"]!.GetValue<int>());
        // Only listings: everything else stays with the model.
        foreach (var other in new ReadingOptions[] { new(Kind: "*"), new(Kind: "*", Properties: "Name,Label"), new(Kind: "*", Text: "x", Properties: "Name"),
            new(Kind: "*", Full: true, Properties: "Name"), new(Kind: "*", All: true, Properties: "Name"), new(Depth: 0, Properties: "Name") })
            Assert.Null(index.Query("/", other));
        Assert.False(ModuleIndex.Answerable("@_home", new(Kind: "*", Properties: "Name"), null));
        Assert.False(ModuleIndex.Answerable("/", new(Kind: "*", Properties: "Name"), ["@a"]));
        Assert.True(ModuleIndex.Answerable("", new(Kind: "*", Properties: "Name"), null));
        // A Name property that does not project to Name(node) is left to the model, only where it is listed.
        root.Children[2].Props["Name"] = "Different";
        var mixed = ModuleIndex.Build(root, reader, "Module", "o11", "kernel", "AB", 10);
        Assert.Null(mixed.Query("/", new(Kind: "Entity", Properties: "Name")));
        Assert.NotNull(mixed.Query("/", new(Kind: "Entity", Properties: "")));
        Assert.Equal(Json(reader.Read(root, "/", new(Kind: "MobileScreen", Properties: "Name"))).ToJsonString(),
            mixed.Query("/", new(Kind: "MobileScreen", Properties: "Name"))!.ToJsonString());
        Assert.Throws<InvalidDataException>(() => ModuleIndex.Parse(index.ToJson(), "odc", "kernel", "AB"));
        Assert.Throws<InvalidDataException>(() => ModuleIndex.Parse(index.ToJson(), "o11", "builder", "AB"));
        Assert.Throws<InvalidDataException>(() => ModuleIndex.Parse(index.ToJson(), "o11", "kernel", "CD"));
    }

    [Fact]
    public void ResidentReaderAnswersFromTheStoreWithoutLoadingAndNeverServesAnInvalidIndex()
    {
        var folder = Path.Combine(Path.GetTempPath(), "ssam-module-index-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try {
            var file = Path.Combine(folder, "capture.oml"); File.WriteAllText(file, "one");
            var store = new ModuleIndexStore(Path.Combine(folder, "store"), "o11", "kernel");
            var loads = 0;
            IReadSnapshot Load(byte[] bytes) { loads++; return new ReadSnapshot<Node>(Module(Encoding.UTF8.GetString(bytes)), new Reader(), "Module", () => { }); }
            IReadSnapshot Refuse(byte[] bytes) => throw new InvalidOperationException("the model was loaded");
            JsonObject Query(string target) => new() { ["file"] = target, ["options"] = new JsonObject { ["kind"] = "MobileScreen", ["properties"] = "Name" } };
            string Data(JsonObject answer) => answer["data"]!.ToJsonString();

            JsonObject first;
            using (var cache = new SnapshotReadCache(Load, store)) {
                first = cache.Read(Query(file));
                Assert.Equal("built", first["cache"]!["index"]!.ToString()); Assert.Equal(1, loads);
                Assert.True(File.Exists(store.PathOf(first["sourceSha256"]!.ToString())));
                Assert.EndsWith(".kernel.json", store.PathOf("AB")); Assert.Contains(Path.Combine("v1", "o11", "ab."), store.PathOf("AB"));
            }
            // A new process: the listing comes from the index, the model is never loaded.
            using (var cold = new SnapshotReadCache(Refuse, store)) {
                var hit = cold.Read(Query(file));
                Assert.Equal("hit", hit["cache"]!["index"]!.ToString()); Assert.False(hit["cache"]!["modelHit"]!.GetValue<bool>());
                Assert.Equal(Data(first), Data(hit));
                var copy = Path.Combine(folder, "elsewhere.oml"); File.Copy(file, copy);
                Assert.Equal(Data(first), Data(cold.Read(Query(copy))));
                Assert.Throws<InvalidOperationException>(() => cold.Read(new JsonObject { ["file"] = file, ["path"] = "/", ["options"] = new JsonObject { ["depth"] = 0 } }));
                File.WriteAllText(copy, "onE");
                Assert.Contains("model was loaded", Assert.Throws<InvalidOperationException>(() => cold.Read(Query(copy))).Message);
            }
            // An index hit for another capture leaves the loaded one in place.
            var other = Path.Combine(folder, "other.oml"); File.WriteAllText(other, "two");
            using (var cache = new SnapshotReadCache(Load, store)) {
                loads = 0;
                Assert.Equal("built", cache.Read(Query(other))["cache"]!["index"]!.ToString());
                Assert.Equal("hit", cache.Read(Query(file))["cache"]!["index"]!.ToString());
                var tree = cache.Read(new JsonObject { ["file"] = other, ["path"] = "/", ["options"] = new JsonObject { ["depth"] = 0 } });
                Assert.True(tree["cache"]!["modelHit"]!.GetValue<bool>()); Assert.Equal(1, loads);
            }
            // Corrupt, foreign-schema and foreign-capture files are misses: the model answers and the index is rebuilt.
            var stored = store.PathOf(first["sourceSha256"]!.ToString());
            var valid = File.ReadAllBytes(stored);
            var foreign = JsonNode.Parse(valid)!; foreign["schema"] = "ssam-module-index/0";
            foreach (var broken in new[] { valid[..(valid.Length / 2)], Encoding.UTF8.GetBytes(foreign.ToJsonString()), File.ReadAllBytes(store.PathOf(Sha(Encoding.UTF8.GetBytes("two")))) }) {
                File.WriteAllBytes(stored, broken);
                using var cache = new SnapshotReadCache(Load, store);
                loads = 0;
                var answer = cache.Read(Query(file));
                Assert.Equal(1, loads); Assert.Equal("built", answer["cache"]!["index"]!.ToString()); Assert.Equal(Data(first), Data(answer));
                Assert.NotNull(store.Load(first["sourceSha256"]!.ToString()));
            }
            // {"index":"ensure"} builds once, then reports the stored index.
            var third = Path.Combine(folder, "third.oml"); File.WriteAllText(third, "three");
            using (var cache = new SnapshotReadCache(Load, store)) {
                var ensured = cache.Read(new JsonObject { ["file"] = third, ["index"] = "ensure" });
                Assert.True(ensured["index"]!["built"]!.GetValue<bool>()); Assert.Equal(11, ensured["index"]!["counts"]!["elements"]!.GetValue<int>());
                Assert.Equal(store.PathOf(ensured["sourceSha256"]!.ToString()), ensured["index"]!["path"]!.ToString());
                Assert.False(cache.Read(new JsonObject { ["file"] = third, ["index"] = "ensure" })["index"]!["built"]!.GetValue<bool>());
                Assert.Throws<ArgumentException>(() => cache.Read(new JsonObject { ["file"] = third, ["index"] = "rebuild" }));
            }
            // The store is a cache: the oldest files go first when the lane folder exceeds its budget.
            var small = new ModuleIndexStore(Path.Combine(folder, "small"), "o11", "kernel", budget: 1);
            var older = ModuleIndex.Build(Module(), new Reader(), "Module", "o11", "kernel", "AA", 1);
            var newer = ModuleIndex.Build(Module(), new Reader(), "Module", "o11", "kernel", "BB", 1);
            small.Save(older); File.SetLastWriteTimeUtc(small.PathOf("AA"), DateTime.UtcNow.AddHours(-1)); small.Save(newer);
            Assert.Null(small.Load("AA")); Assert.NotNull(small.Load("BB"));
            Assert.Throws<ArgumentException>(() => small.Save(ModuleIndex.Build(Module(), new Reader(), "Module", "odc", "kernel", "CC", 1)));
        } finally { Directory.Delete(folder, true); }
    }

    [Fact]
    public void NativeIndexAnswersEqualModelAnswersOnTheLaneFixture()
    {
        // Reflection keeps the test source identical while binding the installed lane's assemblies.
        var assembly = typeof(ModelHost).Assembly;
        var odc = assembly.GetType("Anvil.Core.StudioAssembliesOdc");
        var binder = odc ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethods().First(m => m.Name == "Bind");
        bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        var kernel = Path.GetDirectoryName(typeof(ModuleIndexTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(kernel, "MANIFESTO.md"))) kernel = Directory.GetParent(kernel)!.FullName;
        var fixture = Path.Combine(kernel, "tests", "fixtures", odc != null ? "odc/insurance-reactive-r8.oml" : "hmisjha/HMISJHA_CS-v5578.oml");
        Assert.True(File.Exists(fixture), fixture);
        CompareOnFixture(fixture, odc != null ? "odc" : "o11", Path.Combine(kernel, ".local", odc != null ? "lane-odc" : "", "module-index-tests"));
    }

    // Separate and never inlined: KernelModelReader derives from a Studio type, bound only by the caller.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void CompareOnFixture(string fixture, string lane, string work)
    {
        var odc = lane == "odc";
        var folder = Path.Combine(work, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        var host = new ModelHost(work);
        var source = File.ReadAllBytes(fixture); var sourceSha256 = Sha(source);
        var reader = new KernelModelReader();
        var signature = typeof(KernelModelReader).BaseType!.GetGenericArguments()[0];
        var loaded = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [fixture])!;
        try {
            var index = (ModuleIndex)typeof(ModuleIndex).GetMethod("Build")!.MakeGenericMethod(signature)
                .Invoke(null, [loaded, reader, ModelHost.Prop(loaded, "Name")!.ToString()!, lane, "kernel", sourceSha256, source.LongLength])!;
            Assert.True(index.Complete); Assert.Equal(0, index.ReadErrors);
            var parsed = ModuleIndex.Parse(index.ToJson(), lane, "kernel", sourceSha256);
            JsonNode Model(ReadingOptions options) => Json(typeof(KernelModelReader).GetMethod("Read")!.Invoke(reader, [loaded, "/", options])!);
            var all = Model(new(Kind: "*", Max: 1, Properties: "Name"))["count"]!.GetValue<int>();
            Assert.Equal(all, index.Count);
            var serverAction = Model(new(Kind: "ServerAction", Max: 1, Properties: "Name"))["entries"]![0]!["name"]!.ToString();
            var fullName = JsonNode.Parse(index.ToJson())!["types"]!.AsArray().First(t => t!["kind"]!.ToString() == "ServerAction")!["answers"]!
                .AsArray().Select(a => a!.ToString()).First(a => a.Contains('.'));
            var listings = new List<ReadingOptions> {
                new(Kind: "*", Max: 500, Properties: "Name"), new(Kind: "*", Max: 500, Offset: all / 2, Properties: "Name"),
                new(Kind: "*", Max: 500, Offset: all - 7, Properties: ""), new(Name: serverAction.ToUpperInvariant(), Properties: "Name"),
                new(Kind: "IServerAction", Name: serverAction, Properties: "Name"), new(Kind: fullName, Max: 20, Properties: "Name") };
            foreach (var kind in new[] { "ServerAction", "MobileScreen", "WebScreen", "MobileBlock", "Entity", "StaticEntity", "Structure",
                "InputParameter", "LocalVariable", "AggregateNode", "AddSourceOperation", "Container", "Expression", "NoSuchKind" })
                listings.Add(new(Kind: kind, Max: 500, Properties: "Name"));
            var unanswered = new List<string>();
            foreach (var options in listings) {
                var expected = Model(options);
                var answer = index.Query("/", options);
                Assert.Equal(answer?.ToJsonString(), parsed.Query("/", options)?.ToJsonString());
                if (answer != null) { Assert.Equal(expected.ToJsonString(), answer.ToJsonString()); continue; }
                // Left to the model only when its page shows a Name property that is not the element's name
                // (measured in the ODC kernel adapter: ExtendedProperty reads "aria-label" with an empty Name(node),
                // MobileBlockSignature's Name property throws).
                unanswered.Add(options.Kind ?? options.Name ?? "");
                Assert.Contains(expected["entries"]!.AsArray(), e => e!["propertyReferences"]!.AsObject().Count > 0
                    || e["propertyErrors"]!.AsObject().Count > 0 || (e["properties"]!["Name"]?.ToString() ?? "") != e["modelName"]!.ToString());
            }
            Assert.True(odc || unanswered.Count == 0, string.Join(", ", unanswered));
            Assert.DoesNotContain(odc ? "MobileScreen" : "ServerAction", unanswered);
        } finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [loaded]); }
        try {
            // Cold path: the model read stores the index; the stored answer is the model answer, for any copy of the bytes.
            var store = new ModuleIndexStore(Path.Combine(folder, "store"), lane, "kernel");
            var listing = new ReadingOptions(Kind: odc ? "MobileScreen" : "ServerAction", Max: 50, Properties: "Name");
            Assert.Null(ModuleIndex.ReadStored(store, fixture, "/", listing));
            var modelAnswer = host.ReadModel(fixture, "/", listing, store);
            Assert.NotNull(store.Load(sourceSha256));
            Assert.Equal(modelAnswer.ToJsonString(), ModuleIndex.ReadStored(store, fixture, "/", listing)?.ToJsonString());
            var copy = Path.Combine(folder, "copy.oml"); File.Copy(fixture, copy);
            Assert.Equal(modelAnswer.ToJsonString(), ModuleIndex.ReadStored(store, copy, "/", listing)?.ToJsonString());
            var changed = File.ReadAllBytes(copy); changed[^1] ^= 1; File.WriteAllBytes(copy, changed);
            Assert.Null(ModuleIndex.ReadStored(store, copy, "/", listing));
            Assert.Null(ModuleIndex.ReadStored(store, fixture, "/", listing with { Properties = null }));
        } finally { Directory.Delete(folder, true); }
    }
}
