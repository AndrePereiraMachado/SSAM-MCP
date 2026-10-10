using System.Text.Json.Nodes;

namespace Anvil.CSharp;

public sealed record IntrinsicParameter(string Name,string Type);

/// <summary>A compiler-owned semantic requirement, never an authored runtime program.</summary>
public sealed record FrameworkIntrinsic(string Id,int Version,IReadOnlyList<IntrinsicParameter> Inputs,IntrinsicParameter Output)
{
    public string Reference=>"IFrameworkIntrinsic:"+Id+"/"+Version;
    public static FrameworkIntrinsic CompareOrdinal {get;}=new("System.String.CompareOrdinal",1,
        Array.AsReadOnly(new[]{new IntrinsicParameter("Left","Text"),new IntrinsicParameter("Right","Text")}),new("Result","Integer"));

    public static FrameworkIntrinsic Utf16Length {get;}=new("System.String.Length",1,
        Array.AsReadOnly(new[]{new IntrinsicParameter("Value","Text")}),new("Result","Integer"));

    public static FrameworkIntrinsic Trim {get;}=new("System.String.Trim",1,
        Array.AsReadOnly(new[]{new IntrinsicParameter("Value","Text"),new IntrinsicParameter("Leading","Boolean"),
            new IntrinsicParameter("Trailing","Boolean")}),new("Result","Text"));

    /// <summary>Resolve compiler tokens in call steps only. Source literals and the
    /// unbound compilation remain unchanged; the controller owns the supplied targets.</summary>
    public static CompilationResult Bind(CompilationResult compilation,IReadOnlyDictionary<string,string> targets)
    {
        var requirements=compilation.RequiredIntrinsics ?? [];
        var expected=requirements.ToDictionary(r=>r.Reference,StringComparer.Ordinal);
        if(targets.Keys.Any(key=>!expected.ContainsKey(key)))throw new ArgumentException("Binding supplied for an undeclared framework intrinsic");
        foreach(var requirement in requirements)
            if(!targets.TryGetValue(requirement.Reference,out var target) || string.IsNullOrWhiteSpace(target))
                throw new ArgumentException("Missing runtime binding for "+requirement.Reference);
        var result=compilation.Specification.DeepClone().AsObject();
        foreach(var action in result["logic"]?["actions"]?.AsArray().OfType<JsonObject>() ?? [])
        {
            Walk(action["steps"]);
            foreach(var handler in action["handlers"]?.AsArray().OfType<JsonObject>() ?? [])Walk(handler["steps"]);
        }
        return compilation with {Specification=result};
        void Walk(JsonNode? node)
        {
            if(node is JsonArray array){foreach(var item in array)Walk(item);return;}
            if(node is not JsonObject step)return;
            if(step["call"] is JsonValue call && call.TryGetValue<string>(out var reference) && reference.StartsWith("IFrameworkIntrinsic:",StringComparison.Ordinal))
            {
                if(!expected.ContainsKey(reference))throw new ArgumentException("Undeclared intrinsic call in compiled contract: "+reference);
                step["call"]=targets[reference];
            }
            // Walk control-flow bodies, never arbitrary user objects with a 'call' property.
            foreach(var key in new[]{"then","else","do","next","steps","otherwise"})Walk(step[key]);
            foreach(var arm in step["switch"]?.AsArray().OfType<JsonObject>() ?? [])Walk(arm["steps"]);
        }
    }
}
