using System.Text.Json.Nodes;
using Anvil.CSharp;
using Anvil.Core;
using Anvil.Core.Delivery;

namespace Anvil.Tests;

/// <summary>Offline controller fixture; never a production package registration.</summary>
internal static class FrameworkRuntimeFixture
{
    internal static FrozenFrameworkDependencies? For(ModelHost host,string basis,JsonObject source,string root)
        =>For(host,basis,CSharpCompiler.Compile(SourceBundle.From(source["csharpSource"]!)),root);
    /// <summary>The same fixture for a compilation already made (the reference-graph compilation of a source, for one).</summary>
    internal static FrozenFrameworkDependencies? For(ModelHost host,string basis,CompilationResult compiled,string root)
    {
        if(compiled.RequiredIntrinsics is not {Count:>0})return null;
        var fixture=compiled.RequiredIntrinsics.Any(r=>r.Reference==FrameworkIntrinsic.Trim.Reference)
            ? "unicode-text-primitives.avsig"
            : compiled.RequiredIntrinsics.Any(r=>r.Reference==FrameworkIntrinsic.Utf16Length.Reference)
                ? "text-primitives.avsig" : "ordinal-primitive.avsig";
        var signature=Path.GetFullPath(Path.Combine(root,"tests/contracts/native-reference",fixture));
        var snapshot=JsonNode.Parse(File.ReadAllText(signature))!;
        var bindings=compiled.RequiredIntrinsics.Select(requirement=>
        {
            var name=requirement.Reference==FrameworkIntrinsic.CompareOrdinal.Reference ? "CSharpTextCompareOrdinal"
                : requirement.Reference==FrameworkIntrinsic.Utf16Length.Reference ? "CSharpTextUtf16Length"
                : requirement.Reference==FrameworkIntrinsic.Trim.Reference ? "CSharpTextTrim"
                : throw new InvalidOperationException("Missing offline primitive fixture: "+requirement.Reference);
            var element=snapshot["Elements"]!.AsArray().Single(e=>e!["Name"]!.ToString()==name)!;
            return new FrameworkIntrinsicBinding(requirement.Reference,"Runtime",element["Name"]!.ToString(),element["Key"]!.ToString(),requirement.Inputs,requirement.Output);
        });
        return FrozenFrameworkDependencies.Create(compiled.SourceHash,compiled.RequiredIntrinsics,"fixture.invalid",host.Inspect(basis).Key,
            new("FixtureOnly","interface-test",new string('a',64)),
            [new("Runtime",signature,DeliveryReceipt.Hash(signature),snapshot["ModuleKey"]!.ToString(),snapshot["SignatureHash"]!.ToString())],bindings);
    }
}
