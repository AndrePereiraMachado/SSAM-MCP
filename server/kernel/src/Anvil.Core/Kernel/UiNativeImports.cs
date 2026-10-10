using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>A source-level import names a producer and flow, never an operational object key.</summary>
public sealed record UiNativeImport(string Module,string Flow,string Block)
{
    public string Reference=>"IReference:"+Module+"/"+Flow+"/"+Block;
    public static bool IsNative(string path)=>path.StartsWith("outsystems:",StringComparison.Ordinal);
    public static UiNativeImport Parse(UiImport import)
    {
        if(!IsNative(import.Path))throw new ArgumentException("Native UI imports require the outsystems: prefix");
        var parts=import.Path["outsystems:".Length..].Split('/');
        if(parts.Length!=(import.Export==null?3:2)||parts.Any(p=>!Regex.IsMatch(p,"^[A-Za-z][A-Za-z0-9_]*$")) || import.Export!=null&&!Regex.IsMatch(import.Export,"^[A-Za-z][A-Za-z0-9_]*$"))
            throw new ArgumentException("Use import { Block } from 'outsystems:Module/Flow' or import Alias from 'outsystems:Module/Flow/Block'");
        return new(parts[0],parts[1],import.Export??parts[2]);
    }
}

public sealed partial class ModelSession
{
    // Native reference import may rename a flow/block to avoid a clash in the consumer.
    // OriginalName is the public signature's authored name, not a suffix guessed by the frontend.
    private static string? UiProducerName(IObjectSignature element)
        =>ModelHost.Prop(element,"OriginalName") is string {Length:>0} original?original:TypeResolver.Name(element);
    private IObjectSignature NativeBlock(UiNativeImport import)
    {
        var modules=_es.References.Cast<IObjectSignature>().Where(r=>TypeResolver.Name(r)==import.Module).ToArray();
        if(modules.Length!=1)throw new ArgumentException($"Native UI import {import.Reference}: expected one registered producer reference; found {modules.Length}. The target snapshot must contain this dependency.");
        var flows=modules[0].Children.OfType<IObjectSignature>().Where(f=>UiProducerName(f)==import.Flow&&(Implements(f,"IMobileFlowSignature")||Implements(f,"IMobileFlow"))).ToArray();
        if(flows.Length!=1)throw new ArgumentException($"Native UI import {import.Reference}: expected one Reactive/Mobile flow; found {flows.Length}");
        var blocks=flows[0].Children.OfType<IObjectSignature>().Where(b=>UiProducerName(b)==import.Block&&(Implements(b,"IMobileBlockSignature")||Implements(b,"IMobileBlock"))).ToArray();
        if(blocks.Length!=1)throw new ArgumentException($"Native UI import {import.Reference}: expected one referenced block; found {blocks.Length}");
        return blocks[0];
    }
    private ScreenContract BindNativeBlock(UiNativeImport import,JsonObject identities)
    {
        var block=NativeBlock(import);
        var signature=ScreenContracts.Read(block,import.Reference);
        var reference=_es.References.Cast<IObjectSignature>().Single(r=>TypeResolver.Name(r)==import.Module);
        identities[import.Reference]=new JsonObject {
            ["blockKey"]=block.GlobalKey?.ToString(),
            ["producerKey"]=ModelHost.Prop(reference,"ReferenceKey")?.ToString(),
            ["referenceHash"]=ModelHost.Prop(reference,"ReferenceHash")?.ToString(),
            ["signature"]=JsonSerializer.SerializeToNode(signature)
        };
        return signature;
    }
}
