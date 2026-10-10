using System.Text.Json;
using System.Text.Json.Nodes;
using System.Collections;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects: exactly the same reading contract in ODC and O11.
public sealed class ModelReadingTests
{
    private sealed class Node(string key, string kind, string name = "", string? label = null)
    {
        public string Key = key, Kind = kind, Name = name;
        public string? Label = label;
        public Node? Parent;
        public List<Node> Children = [];
        public List<Node> Referrers = [];
        public bool BrokenReferrers;
        public Dictionary<string, object?> Props = [];
        public Node Add(Node child) { child.Parent = this; Children.Add(child); return child; }
    }
    private sealed class Reader : ModelReader<Node>
    {
        protected override IEnumerable<Node> Referrers(Node n) => n.BrokenReferrers ? throw new InvalidOperationException("broken index") : n.Referrers;
        protected override IEnumerable<Node> Children(Node n) => n.Children;
        protected override Node? Parent(Node n) => n.Parent;
        protected override string Key(Node n) => n.Key;
        protected override string Kind(Node n) => n.Kind;
        protected override string Name(Node n) => n.Name;
        protected override string? Label(Node n) => n.Label;
        protected override IReadOnlySet<string> KindNames(Node n) => new HashSet<string> { n.Kind, "I" + n.Kind };
        protected override string? Expression(object value) => null;
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Node n) => n.Props.Select(p => (p.Key, (Func<object?>)(() => p.Value is Exception error ? throw error : p.Value)));
    }
    private static JsonNode Json(object value) => JsonSerializer.SerializeToNode(value)!;

    [Fact]
    public void ResidentReadsHashTheBytesEvenWhenPathLengthAndTimestampAreUnchanged()
    {
        var file = Path.GetTempFileName(); var closed = 0;
        try {
            File.WriteAllText(file, "One"); var timestamp = File.GetLastWriteTimeUtc(file);
            using var cache = new SnapshotReadCache(bytes => {
                var root = new Node("root", "Module", System.Text.Encoding.UTF8.GetString(bytes));
                return new ReadSnapshot<Node>(root, new Reader(), root.Name, () => closed++);
            });
            var query = new JsonObject { ["file"] = file, ["path"] = "/", ["options"] = new JsonObject { ["depth"] = 0 } };
            var first = cache.Read(query); Assert.False(first["cache"]!["modelHit"]!.GetValue<bool>());
            first["data"]!["tree"]!["modelName"] = "caller-tampering";
            var second = cache.Read(query); Assert.True(second["cache"]!["queryHit"]!.GetValue<bool>());
            Assert.Equal("One", second["data"]!["tree"]!["modelName"]!.GetValue<string>());
            File.WriteAllText(file, "Two"); File.SetLastWriteTimeUtc(file, timestamp);
            var changed = cache.Read(query); Assert.False(changed["cache"]!["modelHit"]!.GetValue<bool>());
            Assert.Equal("Two", changed["data"]!["tree"]!["modelName"]!.GetValue<string>());
            Assert.Equal(1, closed); Assert.Equal(2, changed["cache"]!["loads"]!.GetValue<int>());
            query["expectedSourceSha256"] = first["sourceSha256"]!.DeepClone();
            Assert.Contains("content changed", Assert.Throws<InvalidOperationException>(() => cache.Read(query)).Message);
            query.Remove("expectedSourceSha256"); query["cold"] = true;
            Assert.False(cache.Read(query)["cache"]!["modelHit"]!.GetValue<bool>()); Assert.Equal(2, closed);
        } finally { File.Delete(file); }
    }

    [Fact]
    public void BatchReadingResolvesEverySelectorAndPreservesPerSelectionFailures()
    {
        var root = new Node("root", "Module"); var scope = root.Add(new("scope", "Block", "Address"));
        scope.Add(new("one/a", "Action", "Pin")); scope.Add(new("two", "Action", "Pin"));
        using var snapshot = new ReadSnapshot<Node>(root, new Reader(), "module", () => { });
        var result = snapshot.Read("@scope", new(Depth: 0), ["@one/a", "Action:Pin", "Action:Missing"], "unused");
        Assert.False(result["complete"]!.GetValue<bool>());
        Assert.Equal("one/a", result["entries"]![0]!["data"]!["tree"]!["key"]!.GetValue<string>());
        Assert.Contains("Ambiguous", result["entries"]![1]!["error"]!.GetValue<string>());
        Assert.Contains("Unresolved", result["entries"]![2]!["error"]!.GetValue<string>());
        Assert.Throws<ArgumentException>(() => snapshot.Read("/", new(), [], "unused"));
    }

    [Fact]
    public void TransientPropertyFailuresAreNeverMemoizedAsSuccessfulAnswers()
    {
        var file = Path.GetTempFileName();
        try {
            var root = new Node("root", "Module"); root.Props["Value"] = new IOException("temporarily unavailable");
            using var cache = new SnapshotReadCache(_ => new ReadSnapshot<Node>(root, new Reader(), "module", () => { }));
            var query = new JsonObject { ["file"] = file, ["path"] = "/" };
            var failed = cache.Read(query); Assert.Equal(1, failed["data"]!["tree"]!["propertyErrors"]!.AsObject().Count);
            root.Props["Value"] = "recovered";
            var recovered = cache.Read(query); Assert.False(recovered["cache"]!["queryHit"]!.GetValue<bool>());
            Assert.Equal("recovered", recovered["data"]!["tree"]!["properties"]!["Value"]!.GetValue<string>());
            Assert.True(cache.Read(query)["cache"]!["queryHit"]!.GetValue<bool>());
        } finally { File.Delete(file); }
    }

    [Fact]
    public void FailedReplacementLoadCannotReturnAnEarlierSnapshot()
    {
        var file = Path.GetTempFileName(); var closed = 0;
        try {
            File.WriteAllText(file, "good");
            using var cache = new SnapshotReadCache(bytes => {
                if (System.Text.Encoding.UTF8.GetString(bytes) == "bad") throw new InvalidDataException("bad model");
                return new ReadSnapshot<Node>(new("root", "Module", "Good"), new Reader(), "Good", () => closed++);
            });
            var query = new JsonObject { ["file"] = file, ["path"] = "/" };
            Assert.True(cache.Read(query)["ok"]!.GetValue<bool>());
            File.WriteAllText(file, "bad"); Assert.Throws<InvalidDataException>(() => cache.Read(query)); Assert.Equal(1, closed);
            File.WriteAllText(file, "good"); Assert.False(cache.Read(query)["cache"]!["modelHit"]!.GetValue<bool>());
        } finally { File.Delete(file); }
    }

    [Fact]
    public void UsageEdgesExposeChildTargetsWithoutConfusingThemWithParentReferences()
    {
        var root = new Node("root", "Module"); var entity = root.Add(new("entity", "Entity", "Project"));
        var id = entity.Add(new("id/a", "IdentifierType")); var internalNode = entity.Add(new("internal", "Record"));
        var fk = root.Add(new("fk", "EntityAttribute", "ProjectId"));
        entity.Referrers.Add(internalNode); id.Referrers.AddRange([fk, fk, internalNode]);
        var reader = new Reader();
        var direct = Json(reader.Read(root, "@entity", new(Usages: true, Scope: "direct")));
        Assert.Equal(0, direct["count"]!.GetValue<int>());
        var usages = Json(reader.Read(root, "@entity", new(Usages: true)));
        Assert.True(usages["complete"]!.GetValue<bool>());
        Assert.Equal(1, usages["count"]!.GetValue<int>());
        Assert.Equal(2, usages["excludedInternal"]!.GetValue<int>());
        Assert.Equal("fk", usages["entries"]![0]!["consumer"]!["key"]!.ToString());
        Assert.Equal("id/a", usages["entries"]![0]!["target"]!["key"]!.ToString());
        Assert.Equal("descendant", usages["entries"]![0]!["relation"]!.ToString());
        var first = Json(reader.Read(root, "@entity", new(Usages: true, IncludeInternal: true, Max: 1)));
        entity.Children.Reverse(); id.Referrers.Reverse();
        var second = Json(reader.Read(root, "@entity", new(Usages: true, IncludeInternal: true, Max: 1, Offset: 1)));
        Assert.Equal(3, first["count"]!.GetValue<int>()); Assert.Equal(2, first["consumers"]!.GetValue<int>());
        Assert.NotEqual(first["entries"]![0]!.ToJsonString(), second["entries"]![0]!.ToJsonString());
        Assert.Throws<ArgumentException>(() => reader.Read(root, "/", new(Usages: true, Kind: "Entity")));
        id.BrokenReferrers = true;
        var broken = Json(reader.Read(root, "@entity", new(Usages: true)));
        Assert.False(broken["complete"]!.GetValue<bool>()); Assert.Equal(1, broken["referenceReadErrors"]!.GetValue<int>());
    }

    [Fact]
    public void NativeReplaceProvesTheSavedReferenceSetsAndRejectsAnIncorrectContract()
    {
        var assembly = typeof(ModelHost).Assembly;
        var odc = assembly.GetType("Anvil.Core.StudioAssembliesOdc");
        var binder = odc ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethods().First(m => m.Name == "Bind");
        bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        var root = Path.GetDirectoryName(typeof(ModelReadingTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(root, "MANIFESTO.md"))) root = Directory.GetParent(root)!.FullName;
        var work = Path.Combine(root, ".local", odc != null ? "lane-odc" : "", "reading-tests");
        Directory.CreateDirectory(work); var host = new ModelHost(work);
        var job = Path.Combine(root, "tests", odc != null ? "jobs-odc" : "jobs", "refactor-replace-action.json");
        var output = Path.Combine(work, "replace-proof.oml");
        var result = Json(JobRunner.Run(host, null, job, output));
        File.WriteAllText(Path.Combine(work, "replace-proof.json"), result.ToJsonString());
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]!.ToJsonString());
        Assert.True(result["refactorProof"]!["accepted"]!.GetValue<bool>());
        var replacement = result["results"]!.AsArray().Single(r => r!["op"]!.ToString() == "replace")!["result"]!;
        Assert.Equal(replacement["consumers"]!.ToString(), replacement["rewired"]!.ToString());
        Assert.Equal(0, replacement["stillPointingAtFrom"]!.GetValue<int>());
        var calls = host.ReadModel(output, "/", new(Kind: "ExecuteServerActionNode", Properties: "Action", Max: 500));
        Assert.Contains(calls["entries"]!.AsArray(), c => c!["propertyReferences"]?["Action"]?["name"]?.ToString()
            == (odc != null ? "WfProof_New" : "Contact_Store"));
        if (odc != null) {
            var call = calls["entries"]!.AsArray().Single(c => c!["propertyReferences"]?["Action"]?["name"]?.ToString() == "WfProof_New")!;
            var arguments = host.ReadModel(output, call["reference"]!.ToString(), new(Kind: "Argument", Properties: "Value"));
            Assert.Contains(arguments["entries"]!.AsArray(), a => a!["properties"]?["Value"]?.ToString() == "\"proof\""
                && a["propertyErrors"]!.AsObject().Count == 0);
        }
        var loaded = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [output])!;
        try {
            var assertions = result["refactorProof"]!["assertions"]!.DeepClone().AsArray();
            assertions.Add(new JsonObject { ["key"] = "deliberately-absent-target", ["exists"] = true, ["consumers"] = new JsonArray() });
            var type = assembly.GetType("Anvil.Core.ModelSession")!;
            var session = Activator.CreateInstance(type, [loaded])!;
            var rejected = (JsonNode)type.GetMethod("CheckRefactorContract")!.Invoke(session, [assertions])!;
            Assert.False(rejected["accepted"]!.GetValue<bool>()); Assert.Single(rejected["differences"]!.AsArray());
        } finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [loaded]); }
    }

    [Fact]
    public void NativeForeignKeyUsageSurvivesRetargetSaveAndReload()
    {
        var assembly = typeof(ModelHost).Assembly;
        var odc = assembly.GetType("Anvil.Core.StudioAssembliesOdc");
        var binder = odc ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethods().First(m => m.Name == "Bind");
        bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        var root = Path.GetDirectoryName(typeof(ModelReadingTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(root, "MANIFESTO.md"))) root = Directory.GetParent(root)!.FullName;
        var fixture = Path.Combine(root, "tests", "fixtures", odc != null ? "odc/insurance-reactive-r8.oml" : "reactive-ui.oml");
        var work = Path.Combine(root, ".local", odc != null ? "lane-odc" : "", "reading-tests");
        Directory.CreateDirectory(work); var host = new ModelHost(work);
        var loaded = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [fixture])!;
        var type = assembly.GetType("Anvil.Core.ModelSession")!;
        var session = Activator.CreateInstance(type, [loaded])!;
        JsonNode Apply(string json) => (JsonNode)type.GetMethod("Apply")!.Invoke(session, [JsonNode.Parse(json)!.AsArray(), null])!;
        JsonNode Read(object model, string path, ReadingOptions options) => Json(typeof(KernelModelReader).GetMethod("Read")!.Invoke(new KernelModelReader(), [model, path, options])!);
        var output = Path.Combine(work, "usages-retarget.oml");
        try {
            Apply("""[{"op":"spec","data":{"entities":[{"name":"UsageProofOld"},{"name":"UsageProofNew"},{"name":"UsageProofConsumer","attributes":[{"name":"SelectedId","type":"UsageProofOld Identifier"},{"name":"UntouchedId","type":"UsageProofNew Identifier"}]}]}}]""");
            var fk = Read(loaded, "Entity:UsageProofConsumer/EntityAttribute:SelectedId", new(Depth: 0, Properties: "DataType"))["tree"]!;
            var other = Read(loaded, "Entity:UsageProofConsumer/EntityAttribute:UntouchedId", new(Depth: 0, Properties: "DataType"))["tree"]!;
            var oldId = fk["propertyReferences"]!["DataType"]!["reference"]!.ToString();
            var newId = other["propertyReferences"]!["DataType"]!["reference"]!.ToString();
            var before = Read(loaded, "Entity:UsageProofOld", new(Usages: true, Max: 500));
            Assert.True(before["complete"]!.GetValue<bool>());
            Assert.Contains(before["entries"]!.AsArray(), e => e!["consumer"]!["key"]!.ToString() == fk["key"]!.ToString()
                && e["target"]!["reference"]!.ToString() == oldId && e["relation"]!.ToString() == "descendant");
            var direct = Read(loaded, "Entity:UsageProofOld", new(Usages: true, Scope: "direct", Max: 500));
            Assert.DoesNotContain(direct["entries"]!.AsArray(), e => e!["consumer"]!["key"]!.ToString() == fk["key"]!.ToString());
            // Retarget only the declared FK. Native property identity is an independent oracle for the reverse index.
            Apply(new JsonArray(new JsonObject { ["op"] = "set", ["target"] = "@" + fk["key"], ["prop"] = "DataType", ["value"] = newId }).ToJsonString());
            var saved = (byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host, [loaded])!;
            File.WriteAllBytes(output, saved);
            File.WriteAllText(Path.Combine(work, "usages-before.json"), before.ToJsonString());
        } finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [loaded]); }
        var reloaded = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [output])!;
        try {
            var old = Read(reloaded, "Entity:UsageProofOld", new(Usages: true, Max: 500));
            var changed = Read(reloaded, "Entity:UsageProofNew", new(Usages: true, Max: 500));
            var fk = Read(reloaded, "Entity:UsageProofConsumer/EntityAttribute:SelectedId", new(Depth: 0, Properties: "DataType"))["tree"]!;
            var other = Read(reloaded, "Entity:UsageProofConsumer/EntityAttribute:UntouchedId", new(Depth: 0, Properties: "DataType"))["tree"]!;
            Assert.Equal(other["propertyReferences"]!["DataType"]!["key"]!.ToString(), fk["propertyReferences"]!["DataType"]!["key"]!.ToString());
            Assert.DoesNotContain(old["entries"]!.AsArray(), e => e!["consumer"]!["key"]!.ToString() == fk["key"]!.ToString());
            Assert.Contains(changed["entries"]!.AsArray(), e => e!["consumer"]!["key"]!.ToString() == fk["key"]!.ToString());
            Assert.Contains(changed["entries"]!.AsArray(), e => e!["consumer"]!["key"]!.ToString() == other["key"]!.ToString());
            File.WriteAllText(Path.Combine(work, "usages-after.json"), changed.ToJsonString());
        } finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [reloaded]); }
    }

    [Fact]
    public void AmbiguityNamesBothKeysAndOpaqueKeySelectsTheExactNode()
    {
        var root = new Node("root", "Module"); var flow = root.Add(new("flow", "MobileFlow", "Main"));
        var screen = flow.Add(new("screen", "MobileScreen", "Home"));
        var first = screen.Add(new("a/b+", "AssignNode", label: "Assign"));
        var second = screen.Add(new("other", "AssignNode", label: "Assign"));
        var reader = new Reader();
        Assert.Same(screen, reader.Resolve(root, "IMobileFlow:Main/IMobileScreen:Home"));
        var error = Assert.Throws<InvalidOperationException>(() => reader.Resolve(root, "MobileScreen:Home/AssignNode:Assign"));
        Assert.Contains("@a/b+", error.Message); Assert.Contains("@other", error.Message);
        Assert.Same(first, reader.Resolve(root, "@a/b+"));
        Assert.Same(second, reader.Resolve(root, "@other"));
        // A fresh capture with different keys must be located anew, while the readable path still works.
        screen.Key = "new-screen";
        Assert.Throws<InvalidOperationException>(() => reader.Resolve(root, "@screen"));
        Assert.Same(screen, reader.Resolve(root, "MobileFlow:Main/MobileScreen:Home"));
    }

    [Fact]
    public void SearchUsesUnclippedTextAndPagesTheCompleteMatchCount()
    {
        var root = new Node("root", "Module");
        for (var i = 0; i < 5; i++) root.Add(new("key" + i, "Script", "Script" + i)).Props["Code"] = new string('x', 600) + "needle";
        var reader = new Reader();
        var options = new ReadingOptions(Max: 2, Text: "needle", Properties: "Code");
        var first = Json(reader.Read(root, "/", options));
        Assert.Equal(5, first["count"]!.GetValue<int>()); Assert.Equal(2, first["nextOffset"]!.GetValue<int>());
        Assert.True(first["truncated"]!.GetValue<bool>());
        root.Children.Reverse(); // Simulate a different native enumeration order after reopening.
        var middle = Json(reader.Read(root, "/", options with { Offset = 2 }));
        Assert.Equal("key2", middle["entries"]![0]!["key"]!.ToString());
        Assert.Equal(606, first["entries"]![0]!["propertiesOmitted"]!["Code:text"]!["total"]!.GetValue<int>());
        var last = Json(reader.Read(root, "/", options with { Offset = 4, Full = true }));
        Assert.Single(last["entries"]!.AsArray()); Assert.Null(last["nextOffset"]);
        Assert.EndsWith("needle", last["entries"]![0]!["properties"]!["Code"]!.ToString());
        var empty = Json(reader.Read(root, "/", options with { Offset = 9 }));
        Assert.Empty(empty["entries"]!.AsArray()); Assert.Equal(5, empty["count"]!.GetValue<int>());
    }

    [Fact]
    public void ReferencesKeepIdentityAndCollectionsAndChildrenReportOmissions()
    {
        var root = new Node("root", "Module"); var target = root.Add(new("key", "Action", "Run"));
        root.Props["Destination"] = target; root.Props["Items"] = Enumerable.Range(1, 25).ToArray();
        var reader = new Reader(); var tree = Json(reader.Read(root, "/", new(Depth: 0)))["tree"]!;
        Assert.Equal("@key", tree["propertyReferences"]!["Destination"]!["reference"]!.ToString());
        Assert.Equal(25, tree["propertiesOmitted"]!["Items"]!["total"]!.GetValue<int>());
        Assert.Equal(1, tree["childrenOmitted"]!.GetValue<int>());
        var full = Json(reader.Read(root, "/", new(Full: true)))["tree"]!;
        Assert.Empty(full["propertiesOmitted"]!.AsObject()); Assert.Single(full["children"]!.AsArray());
        Assert.Throws<ArgumentException>(() => reader.Read(root, "/", new(Max: 0)));
        Assert.Throws<ArgumentException>(() => ReadingOptions.Parse(["--max", "bad"]));
    }

    [Fact]
    public void UnknownKindIsNotAnUnqualifiedEmptySuccess()
    {
        var root = new Node("root", "Module"); root.Add(new("screen", "MobileScreen", "Home"));
        var reader = new Reader();
        var typo = Json(reader.Read(root, "/", new(Kind: "MobileScreeen")));
        Assert.Equal(0, typo["count"]!.GetValue<int>());
        Assert.False(typo["kindObserved"]!.GetValue<bool>());
        Assert.Single(typo["notices"]!.AsArray());
        var absentName = Json(reader.Read(root, "/", new(Kind: "MobileScreen", Name: "Missing")));
        Assert.Equal(0, absentName["count"]!.GetValue<int>());
        Assert.True(absentName["kindObserved"]!.GetValue<bool>());
        Assert.Empty(absentName["notices"]!.AsArray());
    }

    [Fact]
    public void FailedPropertyReadsCannotMasqueradeAsACompleteSearch()
    {
        var root = new Node("root", "Module"); root.Props["Broken"] = new InvalidOperationException("unreadable");
        var reader = new Reader();
        var query = Json(reader.Read(root, "/", new(Text: "needle")));
        Assert.False(query["searchComplete"]!.GetValue<bool>());
        Assert.Equal(1, query["propertyReadErrors"]!.GetValue<int>());
        var tree = Json(reader.Read(root, "/", new(Properties: "Broken,Missing")))["tree"]!;
        Assert.Equal("unreadable", tree["propertyErrors"]!["Broken"]!.ToString());
        Assert.Equal("Missing", tree["propertiesMissing"]![0]!.ToString());
    }

    [Fact]
    public void NativeSnapshotPathsResolveAfterIndependentLoadsAndSaveReload()
    {
        // Reflection keeps the test source identical while binding the installed lane's assemblies.
        var assembly = typeof(ModelHost).Assembly;
        var odc = assembly.GetType("Anvil.Core.StudioAssembliesOdc");
        var binder = odc ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethods().First(m => m.Name == "Bind");
        bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        var root = Path.GetDirectoryName(typeof(ModelReadingTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(root, "MANIFESTO.md"))) root = Directory.GetParent(root)?.FullName ?? throw new Exception("kernel root missing");
        var fixture = Path.Combine(root, "tests", "fixtures", odc != null ? "odc/insurance-reactive-r8.oml" : "reactive-ui.oml");
        Assert.True(File.Exists(fixture), fixture);
        var work = Path.Combine(root, ".local", odc != null ? "lane-odc" : "", "reading-tests");
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var inspected = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [fixture])!;
        try {
            var sessionType = assembly.GetType("Anvil.Core.ModelSession")!;
            var session = Activator.CreateInstance(sessionType, [inspected])!;
            JsonNode Apply(JsonObject op) => (JsonNode)sessionType.GetMethod("ApplyOne")!.Invoke(session, [op])!;
            var candidates = new[] { "IEntitySignature", "IMobileBlockSignature", "IStructureSignature" }.SelectMany(kind =>
                Apply(new JsonObject { ["op"] = "find", ["type"] = kind, ["max"] = 500 }).AsArray());
            JsonNode? page = null; string? target = null;
            foreach (var candidate in candidates) {
                target = "@" + candidate!["key"]!.ToString();
                page = Apply(new JsonObject { ["op"] = "usages", ["target"] = target, ["max"] = 1 });
                if (page!["count"]!.GetValue<int>() > 1) break;
            }
            Assert.NotNull(page); Assert.True(page!["count"]!.GetValue<int>() > 1);
            Assert.Equal(1, page["returned"]!.GetValue<int>()); Assert.True(page["truncated"]!.GetValue<bool>());
            var next = Apply(new JsonObject { ["op"] = "usages", ["target"] = target, ["max"] = 1, ["offset"] = 1 })!;
            Assert.Equal(page["count"]!.ToString(), next["count"]!.ToString());
            // Paging is judged against the whole list: `find` does not keep one order between loads, and usages lists one
            // entry per mention, so two neighbours can share the key of the same expression (ODC fixture: 66 of 431
            // targets; flaky in INT-T2-001). Offset k returns entry k of the full page.
            var whole = Apply(new JsonObject { ["op"] = "usages", ["target"] = target, ["max"] = 2 })!;
            Assert.Equal(whole["entries"]![0]!.ToJsonString(), page["entries"]![0]!.ToJsonString());
            Assert.Equal(whole["entries"]![1]!.ToJsonString(), next["entries"]![0]!.ToJsonString());
        } finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [inspected]); }
        var options = new ReadingOptions(Kind: "MobileScreen", Max: 500, Properties: "Name");
        var before = host.ReadModel(fixture, "/", options);
        Assert.NotEmpty(before["entries"]!.AsArray());
        var first = before["entries"]![0]!; var path = first["path"]!.ToString();
        var reloaded = host.ReadModel(fixture, path, new(Depth: 0, Properties: "Name"));
        Assert.Equal(first["name"]!.ToString(), reloaded["tree"]!["name"]!.ToString());
        Assert.Equal(before["sourceSha256"]!.ToString(), reloaded["sourceSha256"]!.ToString());
        var output = Path.Combine(work, "roundtrip.oml"); host.RoundTrip(File.ReadAllBytes(fixture), output);
        var after = host.ReadModel(output, path, new(Depth: 0, Properties: "Name"));
        Assert.Equal(first["name"]!.ToString(), after["tree"]!["name"]!.ToString());
        HashSet<string> Keys(string file) {
            var loaded = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [file])!;
            try {
                var nodes = (IEnumerable)typeof(KernelModelReader).GetMethod("Walk")!.Invoke(new KernelModelReader(), [loaded])!;
                return nodes.Cast<object>().Select(n => ModelHost.Prop(n, "ObjectKey")?.ToString()).Where(k => !string.IsNullOrEmpty(k)).Select(k => k!).ToHashSet();
            } finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [loaded]); }
        }
        var originalKeys = Keys(fixture); var reopenedKeys = Keys(fixture); var savedKeys = Keys(output);
        Assert.NotEmpty(originalKeys);
        File.WriteAllText(Path.Combine(work, "identity-proof.json"), Json(new {
            platform = odc != null ? "odc" : "o11", path,
            originalKey = first["key"]!.ToString(), reopenedKey = reloaded["tree"]!["key"]!.ToString(),
            savedReloadedKey = after["tree"]!["key"]!.ToString(),
            originalHash = before["sourceSha256"]!.ToString(), savedHash = after["sourceSha256"]!.ToString(),
            keyCounts = new { original = originalKeys.Count, reopened = reopenedKeys.Count, savedReloaded = savedKeys.Count,
                retainedOnReopen = originalKeys.Intersect(reopenedKeys).Count(), retainedAfterSaveReload = originalKeys.Intersect(savedKeys).Count(),
                removedAfterSaveReload = originalKeys.Except(savedKeys).Count(), addedAfterSaveReload = savedKeys.Except(originalKeys).Count() },
            scope = "Headless load/save/reload. Does not assert live Studio restart, merge or publish behavior."
        }).ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }
}
