using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>The type of a variable an html edit writes (receipts 092b8162, 645face7 and 82bf05af of 18-22/10, "p:DataType is ...,
/// the edit says ..."). The type is written as the object the plan resolved, never by its name; and a new variable goes after
/// the variables the screen has, where the platform creates it (the variable of those receipts was written before them, and the
/// conference compared it with the first one). A local structure and a producer's of the same name (the platform imports the
/// producer's as Summary2, so a module never holds two of one name), each the type of a new variable written before an existing
/// one, read back as itself. Needs the Service Studio.</summary>
public class ScreenHtmlEditTypeTests(ITestOutputHelper output)
{
    [Fact]
    public void ALocalStructureAndAProducersOfTheSameNameAreEachTheTypeTheEditNames()
    {
        StudioAssemblies.Bind();
        Homonyms(output);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Homonyms(ITestOutputHelper output)
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenHtmlEditTypeTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "screen-html-edit-types", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var basis = Path.Combine(root, "tests", "fixtures", "reactive-ui.oml");
        // The producer: a clone of the fixture with a module identity of its own and a public structure Summary.
        var clone = System.Reflection.Assembly.Load("ServiceStudio.Framework").GetType("ServiceStudio.Model.ESpace")!.GetMethods()
            .Single(m => m.Name == "Clone" && m.IsStatic && m.GetParameters().Length == 9);
        Action<object> rename = m => m.GetType().GetMethod("SetName", [typeof(string)])!.Invoke(m, ["TypesProducer"]);
        var callback = Delegate.CreateDelegate(clone.GetParameters()[5].ParameterType, rename.Target, rename.Method);
        using var bytes = new MemoryStream(File.ReadAllBytes(basis));
        _ = host.Inspect(basis);
        var module = clone.Invoke(null, [bytes, null, null, null, false, callback, null, false, false])!;
        var producerBase = Path.Combine(work, "producer-base.oml");
        try { File.WriteAllBytes(producerBase, (byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host, [module])!); }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
        var producer = Run(host, work, "producer", producerBase, """
            [{"op":"create","parent":"@espace","type":"IStructure","name":"Summary","as":"$s"},
             {"op":"set","target":"$s","prop":"Public","value":true},
             {"op":"create","parent":"$s","type":"IStructureAttribute","name":"Code","as":"$code"},
             {"op":"set","target":"$code","prop":"DataType","value":"Integer"}]
            """, null);
        var capture = SignatureFixtures.FromProducerOml(producer, ["IStructure:Summary"]);
        var avsig = Path.Combine(work, "producer.avsig"); capture.Snapshot.Write(avsig);
        var bindings = new Dictionary<string, string> { ["TypesProducer"] = avsig };
        // The consumer: its own structure Summary and a variable of the screen; then (another delivery) the producer's Summary.
        var local = Run(host, work, "local", basis, """
            [{"op":"create","parent":"@espace","type":"IStructure","name":"Summary","as":"$s"},
             {"op":"create","parent":"$s","type":"IStructureAttribute","name":"Label","as":"$label"},
             {"op":"set","target":"$label","prop":"DataType","value":"Text"},
             {"op":"create","parent":"IMobileScreen:InvalidPermissions","type":"ILocalVariable","name":"Existing","as":"$v"},
             {"op":"set","target":"$v","prop":"DataType","value":"Text"}]
            """, null);
        var consumer = Run(host, work, "consumer", local, """[{"op":"reference","producer":"TypesProducer","elements":["IStructure:Summary"]}]""", bindings);
        // The edit: a new variable of each type, written before the variable the screen has.
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(consumer))).ToLowerInvariant();
        var reading = host.HtmlRead(File.ReadAllBytes(consumer), "InvalidPermissions");
        Assert.Contains("<var k=\"w1\" name=\"Existing\" type=\"Text\"/>", reading["documents"]![0]!["html"]!.ToString());
        var edit = new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "InvalidPermissions",
            ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = reading["documents"]![0]!["htmlSha256"]!.DeepClone() },
            ["edits"] = new JsonArray(new JsonObject { ["before"] = "w1", ["insert"] = "<var name=\"Mine\" type=\"Summary\"/><var name=\"Theirs\" type=\"Summary2\"/>" }) } };
        var edited = Run(host, work, "edited", consumer, new JsonArray(edit).ToJsonString(), bindings);
        var after = Html(host, edited);
        output.WriteLine(after);
        Assert.Matches("<var k=\"w1\" name=\"Existing\" type=\"Text\"/>\\s*<var k=\"w2\" name=\"Mine\" type=\"Summary\"/>\\s*<var k=\"w3\" name=\"Theirs\" type=\"Summary2\"/>", after);
        // Each variable has its own structure: the local one or the producer's.
        string TypeOf(string name) => host.ReadModel(edited, "/", new Anvil.Reading.ReadingOptions(Kind: "LocalVariable", Name: name, Properties: "DataType", Max: 2))
            ["entries"]!.AsArray().Single()!["properties"]!["DataType"]!.ToString();
        output.WriteLine(TypeOf("Mine") + " | " + TypeOf("Theirs"));
        Assert.StartsWith("Structure:", TypeOf("Mine"));
        Assert.NotEqual(TypeOf("Mine"), TypeOf("Theirs"));
    }

    private static string Html(ModelHost host, string oml) => host.HtmlRead(File.ReadAllBytes(oml), "InvalidPermissions")["documents"]![0]!["html"]!.ToString();

    private static string Run(ModelHost host, string work, string name, string from, string ops, Dictionary<string, string>? bindings)
    {
        var job = Path.Combine(work, name + ".json"); var output = Path.Combine(work, name + ".oml");
        File.WriteAllText(job, new JsonObject { ["ops"] = JsonNode.Parse(ops) }.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, from, job, output, bindings: bindings))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        return output;
    }
}
