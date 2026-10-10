using System.Collections;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Anvil.Core.Delivery;
using OutSystems.Model;
using OutSystems.Model.Types;

namespace Anvil.Core;

public sealed partial class ModelSession
{
    private CompilationResult? PrepareCSharpCompilation(JsonObject source,FrozenFrameworkDependencies? runtime, FrozenCSharpCompilation? frozen = null)
    {
        if (frozen != null)
        {
            if (source["csharpSource"] is not { } authored) throw new ArgumentException("Frozen compilation requires the original C# source");
            if (!Keys.Parse(frozen.ModuleKey).Equals(_espace.Key)) throw new InvalidOperationException("Frozen C# compilation belongs to another module identity");
            frozen.ValidateReuse(authored, frozen.Environment, frozen.ModuleKey, runtime);
            return frozen.Bind(runtime);
        }
        var compiled=ModuleSpecification.CompileCSharpSource(source);
        if(compiled==null)
        {
            if(runtime!=null)throw new ArgumentException("Framework dependencies require the original C# source contract");
            return null;
        }
        if(runtime==null)
        {
            if(compiled.RequiredIntrinsics is {Count:>0})throw new InvalidOperationException(
                "The controller must resolve the C# runtime requirements before planning: "+string.Join(", ",compiled.RequiredIntrinsics.Select(r=>r.Reference)));
            return compiled;
        }
        runtime.ValidateRequirements(compiled.SourceHash,compiled.RequiredIntrinsics??[]);
        if(!Keys.Parse(runtime.ModuleKey).Equals(_espace.Key))throw new InvalidOperationException("Frozen runtime dependencies belong to another module identity");
        return FrameworkIntrinsic.Bind(compiled,runtime.CallBindings());
    }

    /// <summary>Expected identities/hashes/ABI come from the frozen controller lock,
    /// not from the first observed model. Public signature hash does not attest code.</summary>
    private JsonObject CheckFrameworkDependencies(FrozenFrameworkDependencies runtime)
    {
        var assertions=new JsonArray();var differences=new JsonArray();
        void Equal(string element,string property,JsonNode? expected,JsonNode? actual)
        {
            var item=new JsonObject{["element"]=element,["property"]=property,["expected"]=expected?.DeepClone()};assertions.Add(item);
            if(!JsonNode.DeepEquals(expected,actual))
            {
                var difference=item.DeepClone().AsObject();difference["actual"]=actual?.DeepClone();differences.Add(difference);
            }
        }
        var targets=runtime.CallBindings();
        foreach(var producer in runtime.Producers)
        {
            var path="runtime/producer/"+producer.Binding;
            var references=_espace.References.Where(r=>r.ReferenceKey.Equals(Keys.Parse(producer.ProducerKey))).ToArray();
            Equal(path,"count",JsonValue.Create(1),JsonValue.Create(references.Length));
            if(references.Length==1)Equal(path,"signatureHash",JsonValue.Create(producer.SignatureHash),JsonValue.Create(references[0].ReferenceHash.ToString("D")));
        }
        foreach(var binding in runtime.Bindings)
        {
            var path="runtime/intrinsic/"+binding.Reference;IObjectSignature? action=null;
            try{action=Resolve(targets[binding.Reference]) as IObjectSignature;}catch(KeyNotFoundException){}
            Equal(path,"exists",JsonValue.Create(true),JsonValue.Create(action!=null));
            if(action==null)continue;
            Parameters("InputParameters",binding.Inputs);
            Parameters("OutputParameters",[binding.Output]);
            void Parameters(string property,IReadOnlyList<IntrinsicParameter> expected)
            {
                var actual=(ModelHost.Prop(action,property) as IEnumerable)?.Cast<object>().ToArray()??[];
                Equal(path,property+".count",JsonValue.Create(expected.Count),JsonValue.Create(actual.Length));
                for(var index=0;index<expected.Count;index++)
                {
                    var parameter=expected[index];var at=path+"/"+property+"/"+index;
                    var found=actual.ElementAtOrDefault(index);
                    Equal(at,"name",JsonValue.Create(parameter.Name),JsonValue.Create(found==null?null:TypeResolver.Name(found)));
                    var expectedType=SemanticTypes.Describe(_es,TypeResolver.Resolve(_es,parameter.Type));
                    var actualType=found!=null&&ModelHost.Prop(found,"DataType") is ITypeSignature type?SemanticTypes.Describe(_es,type):null;
                    Equal(at,"type",expectedType,actualType);
                }
            }
        }
        return new JsonObject{["accepted"]=differences.Count==0,["count"]=assertions.Count,["assertions"]=assertions,["differences"]=differences,
            ["lockFingerprint"]=runtime.Fingerprint,["scope"]="Frozen producer identities, public signature hashes and typed callee ABI. Executable package attestation and runtime semantics require separate evidence."};
    }
}
