using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Xunit;

namespace Anvil.CSharp.Tests;

/// <summary>Independent source oracle. Authored assemblies are emitted/executed in tests only, never by the product compiler.</summary>
public class SourceExecutionTests
{
    public static IEnumerable<object[]> Cases() => JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Cases","LogicBasics.cases.json")))!
        .AsArray().Select((item,index)=>new object[] {index,item!.ToJsonString()});
    private static readonly Lazy<Type> Rules = new(() =>
    {
        var source = File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Cases","LogicBasics.cs.txt"));
        var program = SourceProgram.Parse(new Dictionary<string,string> { ["Rules.cs"] = source });
        using var stream = new MemoryStream();
        var result = program.Compilation.Emit(stream);
        Assert.True(result.Success,string.Join(Environment.NewLine,result.Diagnostics));
        stream.Position=0;
        return AssemblyLoadContext.Default.LoadFromStream(stream).GetType("Rules")!;
    });
    [Theory, MemberData(nameof(Cases))]
    public void NormalCSharpMatchesBusinessAndBoundaryCases(int index,string serialized)
    {
        var test = JsonNode.Parse(serialized)!;
        var method = Rules.Value.GetMethod(test["method"]!.ToString(), BindingFlags.Public|BindingFlags.Static)!;
        var arguments = method.GetParameters().Select((parameter,position)=>
        {
            var json=test["arguments"]![position]!;
            if(json==null) return null;
            if(parameter.ParameterType.IsEnum) return Enum.ToObject(parameter.ParameterType,json.GetValue<int>());
            return JsonSerializer.Deserialize(json.ToJsonString(),parameter.ParameterType,new JsonSerializerOptions { NumberHandling=System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString });
        }).ToArray();
        object? output=null; Exception? thrown=null;
        try {output=method.Invoke(null,arguments);} catch(TargetInvocationException exception) {thrown=exception.InnerException;}
        if(test["exception"] is {} expected) Assert.Equal(expected.ToString(),thrown?.GetType().Name);
        else
        {
            Assert.Null(thrown);
            Assert.True(Equivalent(test["expected"],JsonSerializer.SerializeToNode(output)),"Case "+index+": "+serialized+"; actual "+JsonSerializer.Serialize(output));
        }
    }
    private static bool Equivalent(JsonNode? expected,JsonNode? actual)
    {
        if(expected is JsonObject a && actual is JsonObject b) return a.Count==b.Count && a.All(p=>b.ContainsKey(p.Key)&&Equivalent(p.Value,b[p.Key]));
        if(expected is JsonArray x && actual is JsonArray y) return x.Count==y.Count&&x.Select((item,i)=>Equivalent(item,y[i])).All(s=>s);
        if(expected is JsonValue n && actual is JsonValue m && n.GetValueKind()==JsonValueKind.Number && m.GetValueKind()==JsonValueKind.Number)
            return decimal.Parse(n.ToJsonString(),System.Globalization.CultureInfo.InvariantCulture)==decimal.Parse(m.ToJsonString(),System.Globalization.CultureInfo.InvariantCulture);
        return JsonNode.DeepEquals(expected,actual);
    }
}
