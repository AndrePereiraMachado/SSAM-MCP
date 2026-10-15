using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked in both lanes: standalone statements are ordered by their owner, not by their position in the text.
public sealed class DdlStatementOrderTests(ITestOutputHelper output)
{
    private const string Entity = """
        create entity Product ( -- @entity
          Id Long Integer identifier auto required, -- @id
          Name Text(50) -- @name
        );
        """;

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void StatementsBeforeTheirOwnerKeepTheirIdentityAndDescription(string lane)
    {
        const string statements = """
            /// Unique product name.
            create unique index ByName on Product (Name); -- @index
            /// Creation hook.
            on create Product -> Created(Value = 1); -- @event
            /// Preview data.
            sample Product (Name = "Preview"); -- @sample
            """;
        var before = DdlParser.Parse(statements + "\n" + Entity, lane);
        var after = DdlParser.Parse(Entity + "\n" + statements, lane);
        Assert.Empty(before.Detached);
        Assert.Equal(Signature(after), Signature(before));
        Assert.All(before.Elements.Single().Children.Where(e => e.Of != null), e => Assert.Same(before.Elements.Single(), e.Parent));
    }

    [Fact]
    public void UnknownOwnersAreDeferredUntilTheModuleIsKnown()
    {
        var edit = DdlParser.Parse("create index ByName on NoSuchEntityProbe (Name);", "o11");
        Assert.Empty(edit.Elements);
        Assert.Empty(edit.All());
        Assert.Equal("NoSuchEntityProbe", Assert.Single(edit.Detached).Of);
        Assert.Empty(DdlCompiler.Compile(edit, null, "o11").Problems);
        var problem = Assert.Single(DdlCompiler.Compile(edit, DdlParser.Parse(Entity, "o11"), "o11").Problems);
        Assert.Equal("DDL_OWNER_UNKNOWN", problem.Code);
        Assert.Contains("NoSuchEntityProbe", problem.Message);
    }

    [Fact]
    public void UnknownOwnerFixNamesNearbyEntities()
    {
        var compiled = DdlCompiler.Compile(DdlParser.Parse("create index ByName on Produc (Name);", "o11"), DdlParser.Parse(Entity, "o11"), "o11");
        Assert.Contains("Product", Assert.Single(compiled.Problems).Fix);
    }

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void StandaloneIndexTargetsTheExistingEntityAndAttribute(string lane)
    {
        var edit = DdlParser.Parse("create unique index ByName on Product (Name);", lane);
        var compiled = DdlCompiler.Compile(edit, DdlParser.Parse(Entity, lane), lane);
        Assert.Empty(compiled.Problems);
        var op = Assert.Single(compiled.Ops()).Op;
        Assert.Equal("create", op["op"]!.ToString());
        Assert.Equal("EntityIndex", op["type"]!.ToString());
        Assert.Equal("@entity", op["parent"]!.ToString());
        Assert.Equal("@name", op["args"]!["attributes"]![0]!.ToString());
        Assert.Equal("entity", Assert.Single(edit.Detached).Parent!.Key);
    }

    [Fact]
    public void StandaloneEventsAndSamplesUseTheModuleOwnerWithoutChangingItsMembers()
    {
        var edit = DdlParser.Parse("on create Product -> Created(Value = 1);\nsample Product (Name = \"Preview\");", "odc");
        var compiled = DdlCompiler.Compile(edit, DdlParser.Parse(Entity, "odc"), "odc");
        Assert.Empty(compiled.Problems);
        Assert.Equal(3, compiled.Ops().Count);
        Assert.All(compiled.Ops(), o => Assert.Equal("set", o.Op["op"]!.ToString()));
        Assert.Contains(compiled.Ops(), o => o.Op["target"]!.ToString() == "@entity/OnCreate");
        Assert.Contains(compiled.Ops(), o => o.Op["target"]!.ToString() == "@entity/SampleRecord/Name");
    }

    [Fact]
    public void ThreeWayMergeKeepsStandaloneStatementsAndFollowsOwnerRenames()
    {
        var before = DdlParser.Parse(Entity, "o11");
        var current = DdlParser.Parse(Entity.Replace("Product", "CatalogItem"), "o11");
        var ours = DdlParser.Parse("create index ByName on Product (Name);", "o11");
        var merged = DdlMerge.ThreeWay(before, current, ours, "o11");
        Assert.Empty(merged.Problems);
        Assert.Equal("CatalogItem", Assert.Single(merged.Edit.Detached).Of);
        var compiled = DdlCompiler.Compile(merged.Edit, current, "o11");
        Assert.Empty(compiled.Problems);
        Assert.Equal("@entity", Assert.Single(compiled.Ops()).Op["parent"]!.ToString());
    }

    [Fact]
    public void StandaloneKeyedStatementNeedsItsReadWhenItChanges()
    {
        const string index = "create index ByName on Product (Name); -- @index";
        var current = DdlParser.Parse(Entity + "\n" + index, "o11");
        Assert.Empty(DdlMerge.WithoutRead(current, DdlParser.Parse(index, "o11"), "missing-read", "o11"));
        var changed = DdlParser.Parse(index.Replace("create index", "create unique index"), "o11");
        Assert.Equal("DDL_BASE_UNKNOWN", Assert.Single(DdlMerge.WithoutRead(current, changed, "missing-read", "o11")).Code);
        var wrongOwner = DdlParser.Parse(index.Replace("on Product", "on Missing"), "o11");
        Assert.Equal("DDL_BASE_UNKNOWN", Assert.Single(DdlMerge.WithoutRead(current, wrongOwner, "missing-read", "o11")).Code);
    }

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void DetachedKeyedIndexMergesIndependentChangesInsteadOfRestoringOldColumns(string lane)
    {
        var entity = Entity.Replace("Name Text(50) -- @name", "Name Text(50), -- @name\n  Code Text(10) -- @code");
        const string index = "create index ByName on Product (Name); -- @index";
        var before = DdlParser.Parse(entity + "\n" + index, lane);
        var current = DdlParser.Parse(entity + "\n" + index.Replace("(Name)", "(Code)"), lane);
        var ours = DdlParser.Parse(index.Replace("create index", "create unique index"), lane);
        var merged = DdlMerge.ThreeWay(before, current, ours, lane);
        Assert.Empty(merged.Problems);
        Assert.Empty(merged.Conflicts);
        var statement = Assert.Single(merged.Edit.Detached);
        Assert.Equal(new[] { "Code" }, statement.Columns);
        Assert.Equal("True", statement.Props["Unique"]);
        var compiled = DdlCompiler.Compile(merged.Edit, current, lane);
        Assert.Empty(compiled.Problems);
        var operation = Assert.Single(compiled.Ops()).Op;
        Assert.Equal("set", operation["op"]!.ToString());
        Assert.Equal("Unique", operation["prop"]!.ToString());
    }

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void DetachedKeyedIndexReportsAConflictWhenBothSidesChangeItsColumns(string lane)
    {
        var entity = Entity.Replace("Name Text(50) -- @name", "Name Text(50), -- @name\n  Code Text(10) -- @code");
        const string index = "create index ByName on Product (Name); -- @index";
        var before = DdlParser.Parse(entity + "\n" + index, lane);
        var current = DdlParser.Parse(entity + "\n" + index.Replace("(Name)", "(Code)"), lane);
        var ours = DdlParser.Parse(index.Replace("(Name)", "(Id)"), lane);
        var merged = DdlMerge.ThreeWay(before, current, ours, lane);
        Assert.Empty(merged.Problems);
        Assert.Contains("columns", Assert.Single(merged.Conflicts).ToJsonString());
        Assert.Equal(new[] { "Id" }, Assert.Single(merged.Edit.Detached).Columns);
    }

    [Theory]
    [InlineData("o11")]
    [InlineData("odc")]
    public void ADetachedKeyedStatementRemovedSinceTheReadIsKeptRemovedUnlessTheEditChangedIt(string lane)
    {
        const string index = "create index ByName on Product (Name); -- @index";
        var before = DdlParser.Parse(Entity + "\n" + index, lane);
        var current = DdlParser.Parse(Entity, lane);
        var unchanged = DdlMerge.ThreeWay(before, current, DdlParser.Parse(index, lane), lane);
        Assert.Empty(unchanged.Edit.Detached);
        Assert.Single(unchanged.Notes);
        var changed = DdlMerge.ThreeWay(DdlParser.Parse(Entity + "\n" + index, lane), DdlParser.Parse(Entity, lane),
            DdlParser.Parse(index.Replace("create index", "create unique index"), lane), lane);
        Assert.Empty(changed.Problems);
        Assert.Single(changed.Conflicts);
        Assert.Equal("", Assert.Single(changed.Edit.Detached).Key);
        Assert.Equal("create", Assert.Single(DdlCompiler.Compile(changed.Edit, DdlParser.Parse(Entity, lane), lane).Ops()).Op["op"]!.ToString());
    }

    [Fact]
    public void NativeCorpusStatementsCanMoveBeforeTheirOwnersAndUseModuleOwners()
    {
        var assembly = typeof(ModelHost).Assembly;
        var odc = assembly.GetType("Anvil.Core.StudioAssembliesOdc");
        var lane = odc == null ? "o11" : "odc";
        var root = TextRoundTripCorpus.Root() ?? throw new InvalidOperationException("text-roundtrip corpus root not found");
        var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "kernel", "tests", "fixtures", "text-roundtrip", "corpus.json")))!.AsArray();
        var modules = manifest.Where(m => m!["lane"]!.ToString() == lane).ToList();
        var present = modules.Where(m => File.Exists(m!["oml"]!.ToString())).ToList();
        if (present.Count == 0) { output.WriteLine("SKIPPED: no " + lane + " corpus captures are present"); return; }
        var binder = odc ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var bind = binder.GetMethods().First(m => m.Name == "Bind");
        bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        var statements = 0;
        var indexes = 0;
        foreach (var module in present) {
            var text = ReadText(module!["oml"]!.ToString(), lane, Path.Combine(root, "kernel", ".local", "ddl-order-" + lane));
            var original = DdlParser.Parse(text);
            var count = original.All().Count(e => e.Of != null);
            var reordered = DdlParser.Parse(MoveStatementsFirst(text, original));
            Assert.Empty(reordered.Detached);
            Assert.Equal(Signature(original), Signature(reordered));
            statements += count;
            var sampled = 0;
            foreach (var entity in original.Elements.Where(e => e.Kind == "ServerEntity" && e.Children.Any(a => a.Kind == "EntityAttribute")).Take(5)) {
                var attribute = entity.Children.First(a => a.Kind == "EntityAttribute");
                var standalone = DdlParser.Parse($"create index ProbeIndex on {DdlRules.Name(entity.Name)} ({DdlRules.Name(attribute.Name)});", lane);
                var compiled = DdlCompiler.Compile(standalone, original, lane);
                Assert.Empty(compiled.Problems);
                var created = Assert.Single(compiled.Ops()).Op;
                Assert.Equal("create", created["op"]!.ToString());
                Assert.Equal("EntityIndex", created["type"]!.ToString());
                Assert.Equal("@" + entity.Key, created["parent"]!.ToString());
                sampled++;
            }
            var unknown = DdlCompiler.Compile(DdlParser.Parse("create index ProbeIndex on NoSuchEntityProbe (A);", lane), original, lane);
            Assert.Equal("DDL_OWNER_UNKNOWN", Assert.Single(unknown.Problems).Code);
            indexes += sampled;
            output.WriteLine(module["label"] + ": " + count + " statements reordered, " + sampled + " standalone indexes, unknown owner refused");
        }
        output.WriteLine(lane + ": " + present.Count + "/" + modules.Count + " captures, " + statements + " reordered statements, " + indexes + " standalone indexes");
        Assert.True(statements > 0, "the corpus must exercise standalone statements");
        Assert.True(indexes > 0, "the corpus must exercise database entities");
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static string ReadText(string file, string lane, string work)
    {
        var host = new ModelHost(work);
        var loaded = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [file])!;
        try {
            var signature = typeof(KernelModelReader).BaseType!.GetGenericArguments()[0];
            return ((DataDdl)typeof(DataDdl).GetMethod("Build")!.MakeGenericMethod(signature)
                .Invoke(null, [loaded, new KernelModelReader(), lane, "", 0L])!).Text;
        } finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [loaded]); }
    }

    private static string MoveStatementsFirst(string text, DdlDocument document)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var moved = new SortedSet<int>();
        foreach (var statement in document.All().Where(e => e.Of != null)) {
            var at = statement.Line - 1;
            moved.Add(at);
            while (at > 0 && lines[at - 1].StartsWith("///", StringComparison.Ordinal)) moved.Add(--at);
        }
        return string.Join('\n', lines.Take(1).Concat(moved.Select(i => lines[i])).Concat(lines.Skip(1).Where((_, i) => !moved.Contains(i + 1))));
    }

    private static string[] Signature(DdlDocument document) => document.All().Select(e => JsonSerializer.Serialize(new {
        e.Kind, e.Name, e.Key, e.Of, Parent = e.Parent?.Key, e.Drop, e.HasValues,
        e.References, Properties = e.Props, e.Values, e.Columns, e.Arguments
    }, new JsonSerializerOptions { IncludeFields = true })).Order(StringComparer.Ordinal).ToArray();
}
