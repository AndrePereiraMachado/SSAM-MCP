using System.Reflection;
using System.Text.Json.Nodes;
using System.Runtime.Loader;
using Anvil.Authoring.Transport;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Anvil.CSharp.Tests;

public class ReferenceCallerBindingTests
{
    [Fact]
    public void CompilerDerivesJointRecordAndListStorageFromSourceWithoutAuthoredBindings()
    {
        using var source = new Source("""
            public sealed record Product(string Id, int Price);
            public sealed record Page(List<Product> Items, int Total);
            public static class Rules { public static Page Echo(Page request) => request; }
            """);
        var product = source.New("Product", "9223372036854775808", 42);
        var listType = typeof(List<>).MakeGenericType(product.GetType());
        var list = (System.Collections.IList)Activator.CreateInstance(listType)!; list.Add(product); list.Add(product);
        var page = source.New("Page", list, 2); var binding = source.Binding(); var session = binding.CreateSession();
        var request = session.Encode(binding.Inputs, [page]);
        Assert.Equal(3, request.Arenas.Sum(a => a.Value.Count));
        var wire = new ReferenceGraphWire(binding.Definitions);
        var encoded = wire.EncodeArenas(request);
        var roots = wire.EncodeRoots(request, binding.Inputs);
        // Real JSON serialization boundary, not passing CLR graph objects through a fake wire.
        var decoded = wire.Decode(JsonNode.Parse(encoded.ToJsonString())!.AsObject(),
            roots.Select(root => root == null ? null : JsonNode.Parse(root.ToJsonString())).ToArray(), binding.Results);
        var result = Assert.Single(session.Reconcile(decoded, binding.Results));
        Assert.Same(page, result); Assert.Same(product, list[0]); Assert.Same(list[0], list[1]);
        Assert.Equal("9223372036854775808", product.GetType().GetProperty("Id")!.GetValue(product));
    }

    [Fact]
    public void RecursivePrivateStorageUsesFiniteArenaAndNoSourceInitializersOnReply()
    {
        using var source = new Source("""
            public sealed class Node {
                public Node? Next;
                private int secret = 5;
                public int Read() => secret;
            }
            public static class Rules { public static Node Echo(Node request) => request; }
            """);
        var node = source.New("Node"); node.GetType().GetField("Next")!.SetValue(node, node);
        var binding = source.Binding(); var session = binding.CreateSession(); var graph = session.Encode(binding.Inputs, [node]);
        Assert.Single(graph.Arenas); var cell = Assert.IsType<GraphRecord>(Assert.Single(graph.Arenas.Single().Value));
        Assert.Contains(5, cell.Fields.Values); Assert.Contains(graph.Roots[0], cell.Fields.Values);
        var wire = new ReferenceGraphWire(binding.Definitions);
        var encoded = wire.EncodeArenas(graph);
        var roots = wire.EncodeRoots(graph, binding.Inputs);
        var decoded = wire.Decode(JsonNode.Parse(encoded.ToJsonString())!.AsObject(), roots, binding.Results);
        Assert.Same(node, Assert.Single(session.Reconcile(decoded, binding.Results)));
    }

    [Fact]
    public void SourceInlineValueAndNullReferenceAnnotationsDoNotLoseListIdentity()
    {
        using var source = new Source("""
            public struct Page { public List<int> Items; public int Total; }
            public static class Rules { public static Page Echo(Page request) => request; }
            """);
        var page = source.New("Page"); var list = new List<int> { 1, 2 };
        page.GetType().GetField("Items")!.SetValue(page, list); page.GetType().GetField("Total")!.SetValue(page, 2);
        var binding = source.Binding(); var session = binding.CreateSession(); var request = session.Encode(binding.Inputs, [page]);
        var result = Assert.Single(session.Reconcile(request, binding.Results))!;
        Assert.Same(list, result.GetType().GetField("Items")!.GetValue(result));
        Assert.Equal(2, result.GetType().GetField("Total")!.GetValue(result));
    }

    private sealed class Source : IDisposable
    {
        private readonly AssemblyLoadContext context = new("caller-binding-" + Guid.NewGuid(), isCollectible: true);
        private readonly SourceProgram program;
        private readonly Assembly assembly;
        internal Source(string source)
        {
            program = SourceProgram.Parse(new Dictionary<string, string> { ["Caller.cs"] = source });
            using var stream = new MemoryStream(); var result = program.Compilation.Emit(stream);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
            stream.Position = 0; assembly = context.LoadFromStream(stream);
        }
        internal object New(string name, params object?[] args) => Activator.CreateInstance(assembly.GetType(name)!, args)!;
        internal ReferenceCallerBinding Binding()
        {
            var method = program.Types.Single(t => t.Name == "Rules").GetMembers("Echo").OfType<IMethodSymbol>().Single();
            return new(ReferenceBoundary.Analyze(method), new DataModel(program), assembly);
        }
        public void Dispose() => context.Unload();
    }
}
