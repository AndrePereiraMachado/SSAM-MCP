using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

/// <summary>Cold source and independent .NET oracles are consumed without adaptation.
/// The graph probe checks the emitted control flow with typed BCL primitives; it is not
/// evidence of native server execution or faithful HTTP transport of isolated surrogates.</summary>
public sealed class ColdUnicodeTextTests
{
    private static readonly Lazy<CompilationResult> Compiled = new(() => CSharpCompiler.Compile(
        new Dictionary<string,string> { ["Utf16TextRules.cs"] = Verified("Utf16TextRules.cs.txt", "933d61367b61eec0ad77321eb7c433af26c743c6d8d7e30df5e80f5c8d9c369f") }));
    private static readonly IReadOnlyDictionary<string,string> Hashes = new Dictionary<string,string>
    {
        ["inputs.json"]="42acabc501b4706187ef8f89f4673c5e67ad9c3b9a68f4c29419bcaf7cce361b",
        ["expected.json"]="003e653aae858ca5a10dbcaf9609eedab41519485d80fc669b21a0e1c6a8ecd9",
        ["discriminator-inputs.json"]="63f49d96d42d11e0fbef1f1efe2899deb7bb7a29617440fd6f1d086f29c16369",
        ["discriminator-expected.json"]="022276765fcc0e4e04cc14d8e908aca3024bbd693d2fa6bed921896fd158a465",
        ["inprocess-surrogates.json"]="feff358737c6948cc1083ba38310cc9fbdd842c26ecea8e87dcde40f357088d0",
    };
    private static JsonNode Oracle(string name) => JsonNode.Parse(Verified("oracles/Utf16TextRules/"+name,Hashes[name]))!;
    private static string Verified(string relative,string hash)
    {
        var bytes=File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory,"Cases",relative));
        Assert.Equal(hash,Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
        return Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF');
    }
    public static IEnumerable<object[]> PublicCases()
    {
        foreach(var prefix in new[]{"","discriminator-"})
        {
            var inputs=Oracle(prefix+"inputs.json")["cases"]!.AsArray();
            var expected=Oracle(prefix+"expected.json")["cases"]!.AsArray().ToDictionary(c=>c!["id"]!.ToString());
            Assert.Equal(prefix.Length==0 ? 46 : 8,inputs.Count);
            Assert.Equal(inputs.Count,expected.Count);
            foreach(var input in inputs)
                yield return [input!["id"]!.ToString(),input.ToJsonString(),expected[input["id"]!.ToString()]!.ToJsonString()];
        }
    }
    [Theory]
    [MemberData(nameof(PublicCases))]
    public void OriginalUnicodeCodeMatchesIndependentExpectedResults(string id,string inputJson,string expectedJson)
    {
        Assert.False(string.IsNullOrWhiteSpace(id));
        var input=JsonNode.Parse(inputJson)!;var expected=JsonNode.Parse(expectedJson)!;
        Assert.Null(expected["error"]);
        var method=input["method"]!.ToString();Assert.Equal(method,expected["method"]!.ToString());
        var actual=Run(method,input["arguments"]![0]?.GetValue<string>());
        if(method=="Measure") Assert.Equal(expected["result"]!.GetValue<decimal>(),actual);
        else Assert.Equal(expected["result"]!.GetValue<string>(),actual);
    }
    public static IEnumerable<object[]> SurrogateCases()
    {
        var cases=Oracle("inprocess-surrogates.json")["cases"]!.AsArray();Assert.Equal(8,cases.Count);
        return cases.Select(c=>new object[]{c!["id"]!.ToString(),c.ToJsonString()});
    }
    [Theory]
    [MemberData(nameof(SurrogateCases))]
    public void IsolatedSurrogatesKeepCodeUnitsInProcessOnly(string id,string json)
    {
        Assert.False(string.IsNullOrWhiteSpace(id));
        var test=JsonNode.Parse(json)!;Assert.Null(test["error"]);
        var text=new string(test["inputUtf16CodeUnits"]!.AsArray().Select(c=>(char)c!.GetValue<int>()).ToArray());
        var method=test["method"]!.ToString();var actual=Run(method,text);
        if(method=="Measure") Assert.Equal(test["resultInteger"]!.GetValue<decimal>(),actual);
        else Assert.Equal(test["resultUtf16CodeUnits"]!.AsArray().Select(c=>c!.GetValue<int>()),Assert.IsType<string>(actual).Select(c=>(int)c));
    }
    private static object Run(string method,string? value)
    {
        var compiled=Compiled.Value;
        var name=compiled.SourceMap.OfType<JsonObject>().Single(m=>m["source"]?.ToString().StartsWith("Utf16TextRules."+method+"(",StringComparison.Ordinal)==true)["native"]!.ToString();
        var argument=new Dictionary<string,object> { ["HasValue"]=value!=null,["Value"]=value??"" };
        return new ReferenceGraphProbe(compiled.Specification).Run(name,new Dictionary<string,object>{["Arg_value"]=argument})["AvResult"];
    }
}
