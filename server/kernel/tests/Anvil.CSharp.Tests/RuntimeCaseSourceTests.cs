using System.Reflection;
using System.Runtime.Loader;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Xunit;

namespace Anvil.CSharp.Tests;

/// <summary>Builds literal-input native test entry points from the independent C# case corpus.
/// No business graph or expected native expression is authored by this test adapter.</summary>
public class RuntimeCaseSourceTests
{
    [Fact]
    public void LiteralCaseEntryPointsCompileThroughThePublicSourceFrontend()
    {
        var root = FindRoot();
        var sources = new Dictionary<string,string>();
        var cases = new JsonArray();
        foreach (var (fixture,owner) in new[] { ("LogicBasics","Rules"), ("NullableMembers","NullableMembers"),
            ("TextSemantics","TextRules"), ("ColdStock","Estoque"), ("StockRuntime","StockRuntime"), ("ColdSwitch","SwitchRules"),
            ("PatternSemantics","PatternRules"), ("EnumRuntime","EnumRuntime"), ("ColdQueryProjection","ColdQueryProjection.ReceivablesQueries"), ("ColdGrouping","ColdGroupAuthoring.LedgerReports"),
            ("ColdAveragePipeline","ColdAveragePipeline.AverageLedgerReports") })
        {
            sources.Add(fixture+".cs",File.ReadAllText(Path.Combine(root,"tests/csharp/"+fixture+".cs.txt")));
            var casePath=Path.Combine(root,"tests/csharp/"+fixture+".cases.json");
            if (!File.Exists(casePath)) continue;
            foreach(var item in JsonNode.Parse(File.ReadAllText(casePath))!.AsArray())
            {var test=item!.DeepClone().AsObject();test["owner"]=owner;cases.Add(test);}
        }
        var program = SourceProgram.Parse(sources);
        using var assembly = new MemoryStream();
        var emitted = program.Compilation.Emit(assembly);
        Assert.True(emitted.Success,string.Join(Environment.NewLine,emitted.Diagnostics));
        assembly.Position=0;
        var context = new AssemblyLoadContext("CaseSource",isCollectible:true);
        try
        {
            var rules=context.LoadFromStream(assembly);
            var wrappers = new StringBuilder("\npublic static class RuntimeCases\n{\n");
            var manifest = new JsonArray();
            foreach (var (item,index) in cases.Select((value,index)=>(value!,index)))
            {
                var owner=item["owner"]!.ToString();
                var method=rules.GetType(owner)!.GetMethod(item["method"]!.ToString(),BindingFlags.Public|BindingFlags.Static)!;
                var argumentIndex=0;
                var dependency=method.GetParameters().Any(p=>p.ParameterType==typeof(Anvil.Authoring.IDataSession));
                var args=method.GetParameters().Select(p=>p.ParameterType==typeof(Anvil.Authoring.IDataSession)?"database":Literal(item["arguments"]![argumentIndex++],p.ParameterType));
                var invocation=owner+"."+method.Name+"("+string.Join(", ",args)+")";
                var name="Case"+index.ToString("D3");
                wrappers.Append("    public static bool ").Append(name).Append('(')
                    .Append(dependency?"Anvil.Authoring.IDataSession database":"").Append(") { ");
                if (item["exception"]!=null)
                    wrappers.Append(invocation).Append("; return false;");
                else
                    wrappers.Append("var actual = ").Append(invocation).Append("; return ")
                        .Append(Compare("actual",item["expected"],method.ReturnType)).Append(';');
                wrappers.AppendLine(" }");
                manifest.Add(new JsonObject {["case"]=name,["method"]=owner+"."+method.Name,["expectedException"]=item["exception"]?.DeepClone()});
            }
            wrappers.AppendLine("}");
            sources.Add("RuntimeCases.cs",wrappers.ToString());
            var compiled=CSharpCompiler.Compile(sources);
            Assert.Equal(cases.Count,compiled.Specification["logic"]!["actions"]!.AsArray().Count(a=>a!["name"]!.ToString().StartsWith("Case",StringComparison.Ordinal)));
            // Execute those same entry points as C# too; a generated wrapper must not change the oracle.
            var wrappedProgram=SourceProgram.Parse(sources);
            using var wrappedAssembly=new MemoryStream();
            Assert.True(wrappedProgram.Compilation.WithAssemblyName("RuntimeCaseWrappers").Emit(wrappedAssembly).Success);
            wrappedAssembly.Position=0;
            var entryPoints=context.LoadFromStream(wrappedAssembly).GetType("RuntimeCases")!;
            var database=new DataEffectsTests.MemorySession();
            foreach(var test in manifest)
            {
                var entry=entryPoints.GetMethod(test!["case"]!.ToString())!;
                object?[]? input=entry.GetParameters().Length==0?null:[database];
                if(test["expectedException"] is {} expected)
                    Assert.Equal(expected.ToString(),Assert.Throws<TargetInvocationException>(()=>entry.Invoke(null,input)).InnerException!.GetType().Name);
                else Assert.True((bool)entry.Invoke(null,input)!,test["case"]+": "+test["method"]);
            }
            // Test generation must never overwrite an in-flight delivery's frozen source.
            var output=Path.Combine(root,".local/data-logic-translator/runtime-generated");Directory.CreateDirectory(output);
            File.WriteAllText(Path.Combine(output,"RuntimeSource.json"),new JsonObject { ["csharpSource"]=new JsonObject {
                ["files"]=new JsonObject(sources.Select(p=>KeyValuePair.Create(p.Key,(JsonNode?)JsonValue.Create(p.Value)))) } }.ToJsonString());
            File.WriteAllText(Path.Combine(output,"cases.json"),manifest.ToJsonString(new JsonSerializerOptions {WriteIndented=true}));
            File.WriteAllText(Path.Combine(output,"contract.json"),compiled.Specification.ToJsonString());
        }
        finally {context.Unload();}
    }

    private static string Compare(string expression,JsonNode? value,Type type)
        => value is JsonObject record && Nullable.GetUnderlyingType(type)==null
            ? string.Join(" && ",record.Select(p=>Compare(expression+"."+p.Key,p.Value,type.GetProperty(p.Key)!.PropertyType)))
            : expression+" == "+Literal(value,type);

    private static string Literal(JsonNode? value,Type type)
    {
        if(value==null)return "("+Name(type)+")null";
        if(Nullable.GetUnderlyingType(type) is {} underlying)return "("+Name(type)+")("+Literal(value,underlying)+")";
        if(type.IsEnum)return "("+Name(type)+")("+Literal(value,Enum.GetUnderlyingType(type))+")";
        if(type.IsArray || type.IsGenericType && type.GetGenericTypeDefinition()==typeof(List<>))
        {
            var element=type.IsArray?type.GetElementType()!:type.GetGenericArguments()[0];
            return "new "+Name(type)+(type.IsArray?"":"()")+" { "+string.Join(", ",value.AsArray().Select(v=>Literal(v,element)))+" }";
        }
        if(type==typeof(string))return JsonSerializer.Serialize(value.GetValue<string>());
        if(type==typeof(bool))return value.GetValue<bool>()?"true":"false";
        if(value is JsonObject record)
        {
            var constructor=type.GetConstructors().Single(c=>c.GetParameters().All(p=>record.ContainsKey(p.Name!)));
            return "new "+Name(type)+"("+string.Join(", ",constructor.GetParameters().Select(p=>Literal(record[p.Name!],p.ParameterType)))+")";
        }
        var number=value.ToString();
        return type==typeof(decimal)?number+"m":type==typeof(long)?number+"L":type==typeof(uint)?number+"U":type==typeof(ulong)?number+"UL":
            type==typeof(byte)||type==typeof(short)||type==typeof(sbyte)||type==typeof(ushort)?"("+Name(type)+")"+number:number;
    }
    private static string Name(Type type)
        => Nullable.GetUnderlyingType(type) is {} underlying?Name(underlying)+"?":type.IsArray?Name(type.GetElementType()!)+"[]":
           type.IsGenericType?"System.Collections.Generic.List<"+Name(type.GetGenericArguments()[0])+">":type.FullName!;
    private static string FindRoot()
    {
        var directory=new DirectoryInfo(AppContext.BaseDirectory);
        while(directory!=null && !File.Exists(Path.Combine(directory.FullName,"MANIFESTO.md")))directory=directory.Parent;
        return directory?.FullName??throw new InvalidOperationException("Repository root not found");
    }
}
