using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class LogicGeneratedCallTests
{
    [Fact]
    public void GeneratedEntityActionKeepsItsExactIdentityAfterDataDeclarationsWarmTheIndex()
    {
        StudioAssemblies.Bind(); Run();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run()
    {
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(LogicGeneratedCallTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local/data-logic-translator/generated-call-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); var host = new ModelHost(work);
        // Keep vendor assemblies out of the test project's compile-time references.
        var module = typeof(ModelHost).GetMethod("Load", [typeof(byte[])])!.Invoke(host,
            [File.ReadAllBytes(Path.Combine(root, "tests/fixtures/blank-service.oml"))])!;
        var contract = JsonNode.Parse("""
            {"data":{"entities":[{"name":"FreshRow","public":true,"readOnly":true,
                "attributes":[{"name":"Code","type":"Text","length":40}]}]},
             "logic":{"actions":[{"name":"LockFreshRow","public":false,
                "inputs":[{"name":"Id","type":"FreshRow Identifier"}],
                "steps":[{"call":"GetFreshRowForUpdate","as":"LockRow","args":{"Id":"Id"}}]}]}}
            """)!.AsObject();
        string output;
        try
        {
            var session = (ModelSession)Activator.CreateInstance(typeof(ModelSession), [module])!;
            session.Apply(new JsonArray(new JsonObject { ["op"] = "spec", ["data"] = contract["data"]!.DeepClone() }));
            // Data proof indexes the new entity before the native identifier setter
            // synthesizes Get...ForUpdate. Keep the same session, as a compound job does.
            Assert.NotNull(typeof(ModelSession).GetField("_byKey", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(session));
            var original = session.Resolve("IEntityActionSignature:GetFreshRowForUpdate");
            var originalKey = session.Get(original)["key"]!.ToString();
            Assert.Contains(".#GetEntityForUpdate", originalKey);
            session.Apply(new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = contract["logic"]!.DeepClone() }));
            var actual = ModelHost.Prop(session.Resolve("$LockFreshRow.LockRow"), "Action")!;
            Assert.Equal(originalKey, session.Get(actual)["key"]!.ToString());
            Assert.Same(original, session.Resolve("@" + originalKey));
            var argument = ModelHost.Prop(session.Resolve("$LockFreshRow.LockRow/arg:Id"), "Value")!;
            Assert.Equal(true, ModelHost.Prop(argument, "IsValid"));
            Assert.NotNull(ModelHost.Prop(ModelHost.Prop(argument, "Type")!, "Type"));
            // The independent contract inspection below checks the caller Id's exact
            // entity-identifier type and the expression's binding to that input.
            var messages = (IReadOnlyList<MessageInfo>)typeof(ModelHost).GetMethod("Messages")!.Invoke(null, [module])!;
            Assert.DoesNotContain(messages, message => message.IsError);
            output = Path.Combine(work, "bound.oml");
            File.WriteAllBytes(output, (byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host, [module])!);
            File.WriteAllText(Path.Combine(work, "binding.json"), session.Get(actual).ToJsonString());
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
        var roundtrip = host.RoundTrip(File.ReadAllBytes(output));
        Assert.True(roundtrip.SameKey && roundtrip.SameObjectCount && roundtrip.SameValidation && roundtrip.Reloaded.IsValid);
        var proof = host.CheckModuleSpecification(output, contract);
        File.WriteAllText(Path.Combine(work, "proof.json"), proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(), proof["differences"]!.ToJsonString());
        File.WriteAllText(Path.Combine(work, "summary.json"), new JsonObject { ["passed"] = true,
            ["scope"] = "Generated native entity action identity and typed Id after a warm key index; Verify/reload/independent contract proof, no server execution or publication." }.ToJsonString());
    }
}
