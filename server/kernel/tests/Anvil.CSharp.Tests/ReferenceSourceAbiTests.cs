using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using Anvil.Authoring.Transport;
using Xunit;

namespace Anvil.CSharp.Tests;

public class ReferenceSourceAbiTests
{
    [Fact]
    public void DescriptorRoundtripBindsAConsumerWithoutSourceAnalysisOrAuthoredFields()
    {
        using var fixture = new Fixture();
        var schema = JsonNode.Parse(fixture.Abi.ToJsonString())!.AsObject();
        var binding = new ReferenceGraphBinding(schema, fixture.Assembly);
        var item = fixture.Assembly.CreateInstance("Item")!;
        item.GetType().GetField("Value")!.SetValue(item, 17);
        var session = binding.CreateSession(); var graph = session.Encode(binding.Inputs, [item]);
        Assert.Same(item, Assert.Single(session.Reconcile(graph, binding.Results)));
        Assert.Equal("Arg_value", Assert.Single(binding.InputNames));
        Assert.Equal("Value", Assert.Single(Assert.Single(binding.Definitions).Fields).Name);
    }

    [Theory]
    [InlineData("version")]
    [InlineData("storage")]
    [InlineData("primitive")]
    [InlineData("unknown")]
    [InlineData("root")]
    public void InvalidDescriptorIsRejectedBeforeAnyInvocation(string invalid)
    {
        using var fixture = new Fixture(); var schema = fixture.Abi.DeepClone().AsObject();
        var definition = schema["definitions"]![0]!;
        switch (invalid)
        {
            case "version": schema["version"] = 88; break;
            case "storage": definition["fields"]![0]!["storage"] = "MissingField"; break;
            case "primitive": definition["fields"]![0]!["shape"]!["type"]!["name"] = "System.IO.FileInfo"; break;
            case "unknown": schema["execute"] = "arbitrary-code"; break;
            case "root": schema["inputs"]![0]!["shape"]!["arena"] = "MissingArena"; break;
        }
        if (invalid == "root") Assert.Throws<ArgumentException>(() => new ReferenceGraphBinding(schema, fixture.Assembly));
        else Assert.Throws<InvalidDataException>(() => new ReferenceGraphBinding(schema, fixture.Assembly));
    }

    [Fact]
    public void PrivateBodiesDoNotAdvertisePublicCallerDescriptors()
    {
        using var fixture = new Fixture();
        var entry = Assert.Single(fixture.Compilation.SourceAbis!);
        Assert.Equal("Echo", entry!["native"]!.ToString());
        Assert.Equal("Rules.Echo(Item)", entry["source"]!.ToString());
        Assert.Equal("anvil.csharp.reference-graph", entry["abi"]!["id"]!.ToString());
    }

    private sealed class Fixture : IDisposable
    {
        private readonly AssemblyLoadContext context = new("abi-schema-" + Guid.NewGuid(), isCollectible: true);
        internal Assembly Assembly { get; }
        internal CompilationResult Compilation { get; }
        internal JsonObject Abi => Compilation.SourceAbis![0]!["abi"]!.AsObject();
        internal Fixture()
        {
            var files = new Dictionary<string, string> { ["Item.cs"] = """
                public sealed class Item { public int Value; }
                public static class Rules {
                    public static Item Echo(Item value) => Identity(value);
                    private static Item Identity(Item value) => value;
                }
                """ };
            Compilation = CSharpCompiler.CompileReferenceGraph(files);
            using var stream = new MemoryStream(); var compiled = SourceProgram.Parse(files).Compilation.Emit(stream);
            Assert.True(compiled.Success, string.Join(Environment.NewLine, compiled.Diagnostics));
            stream.Position = 0; Assembly = context.LoadFromStream(stream);
        }
        public void Dispose() => context.Unload();
    }
}
