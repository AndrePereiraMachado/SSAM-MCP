using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Anvil.Core.Delivery;

/// <summary>Controller-side runtime acquisition. The installation registration is
/// maintained with the runtime package; authored C# supplies no producer bindings.</summary>
public sealed class CSharpRuntimeDelivery(DeliveryRequest request,string registrationPath,Action<string>? log=null):IDeliveryCompilationRuntime
{
    public FrozenFrameworkDependencies? Acquire(DeliveryDependencyContext context)
    {
        var compilation=context.Compilation;
        if(compilation?.RequiredIntrinsics is not {Count:>0} requirements)return null;
        if(!File.Exists(registrationPath))throw new InvalidOperationException(
            "The Hybrid runtime package is not registered for this controller; required: "+string.Join(", ",requirements.Select(r=>r.Reference)));
        var registration=JsonSerializer.Deserialize<Registration>(File.ReadAllText(registrationPath),Options)
            ?? throw new ArgumentException("Empty runtime registration");
        if(registration.FormatVersion!=1 || registration.Package==null || registration.Producer==null || registration.Intrinsics==null)
            throw new ArgumentException("Incomplete or unsupported runtime registration");
        if(!string.Equals(registration.Environment,context.Environment,StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Registered runtime belongs to another environment");
        if(registration.Intrinsics.Select(i=>i.Reference).Distinct(StringComparer.Ordinal).Count()!=registration.Intrinsics.Length)
            throw new ArgumentException("Ambiguous registered runtime capabilities");
        var selected=requirements.Select(requirement=>(Requirement:requirement,Binding:registration.Intrinsics.SingleOrDefault(i=>i.Reference==requirement.Reference)
            ?? throw new InvalidOperationException("Installed runtime lacks "+requirement.Reference))).ToArray();
        var credentials=HeadlessCredentials.FromJsonFile(registration.Credentials);
        if(!credentials.Host.Equals(context.Environment,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Runtime credential host differs from the accepted target");
        var directory=Path.Combine(context.TaskDirectory,"runtime-acquisition");Directory.CreateDirectory(directory);
        // The signature REST client shares native settings initialized by the model host.
        _=new ModelHost(Path.Combine(directory,"model"));
        using var session=HeadlessSession.Connect(credentials);session.MarkReadOnly();
        var producer=registration.Producer;
        var before=FindActive();
        var bytes=session.DownloadExtension(before.Key,before.VersionId);
        if(bytes is not {Length:>0})throw new InvalidOperationException("Registered runtime extension download returned no artifact");
        var artifact=Path.Combine(directory,"runtime.xif");File.WriteAllBytes(artifact,bytes);
        if(!DeliveryReceipt.Hash(artifact).Equals(registration.Package.ArtifactSha256,StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Active runtime package bytes differ from the registered artifact");
        var signature=session.GetReferenceSignature(before.Key,"Extension")??throw new InvalidOperationException("Published runtime signature is unavailable");
        if(!Keys.Parse(signature.Key).Equals(Keys.Parse(before.Key)) || signature.Name!=before.Name
            || !signature.Kind.Equals("Extension",StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Runtime signature belongs to another producer");
        if(!Guid.TryParse(producer.SignatureHash,out var approvedSignature) || approvedSignature==Guid.Empty || signature.SignatureHash!=approvedSignature)
            throw new InvalidOperationException("Runtime public signature differs from the registered package revision");
        var after=FindActive();
        if(before.VersionId!=after.VersionId)throw new InvalidOperationException("Runtime version changed while acquiring dependencies");
        var snapshot=NativeReferenceCapture.Capture(signature,context.Environment,
            selected.Select(s=>new NativeReferenceElement("action",s.Binding.ElementName,s.Binding.OriginalElementKey)));
        var signaturePath=Path.Combine(directory,"runtime.avsig");snapshot.Write(signaturePath);
        log?.Invoke("runtime: acquired registered package "+registration.Package.Id+" revision "+registration.Package.Revision+" (extension version "+before.VersionId+")");
        return FrozenFrameworkDependencies.Create(compilation.SourceHash,requirements,context.Environment,context.ModuleKey,
            registration.Package with {ArtifactPath=artifact},
            [new("CSharpRuntime",signaturePath,DeliveryReceipt.Hash(signaturePath),snapshot.ModuleKey,snapshot.SignatureHash.ToString("D"))],
            selected.Select(s=>new FrameworkIntrinsicBinding(s.Requirement.Reference,"CSharpRuntime",s.Binding.ElementName,s.Binding.OriginalElementKey,s.Requirement.Inputs,s.Requirement.Output)));

        ModuleSummary FindActive()
        {
            var found=session.ListExtensions().SingleOrDefault(e=>Keys.Parse(e.Key).Equals(Keys.Parse(producer.Key)));
            if(found==null || !found.IsActive || found.VersionId<=0 || found.VersionId!=producer.VersionId || found.Name!=producer.Name)
                throw new InvalidOperationException("Registered runtime extension/version is not advertised as active by the target environment");
            return found;
        }
    }

    public JsonObject Apply(string basePath,string jobPath,string outputPath,FrozenFrameworkDependencies dependencies)
    {
        var specification=request.Specification??throw new InvalidOperationException("Missing original C# source contract");
        var host=new ModelHost(Path.Combine(Path.GetDirectoryName(outputPath)!,"model"));
        var candidate=new JsonObject{["ops"]=host.PlanModuleSpecification(basePath,specification,dependencies),
            ["expectedMessages"]=ModuleSpecification.SourceDocument(request.JobPath)["expectedMessages"]?.DeepClone()??new JsonArray()};
        var generated=Path.Combine(Path.GetDirectoryName(outputPath)!,"generated.json");
        DurableJson.WriteBytes(generated,System.Text.Encoding.UTF8.GetBytes(candidate.ToJsonString()));
        return JsonSerializer.SerializeToNode(JobRunner.Run(host,basePath,generated,outputPath,log,dependencies.ProducerBindings()))!.AsObject();
    }
    public JsonObject Inspect(string snapshot,JsonObject specification,JsonObject? expectedTypes,FrozenFrameworkDependencies dependencies)
        =>new ModelHost(Path.Combine(Path.GetDirectoryName(snapshot)!,"proof-model")).CheckModuleSpecification(snapshot,specification,expectedTypes,dependencies);

    public JsonObject ApplyCompilation(string basePath, string jobPath, string outputPath, FrozenCSharpCompilation compilation, FrozenFrameworkDependencies? dependencies)
    {
        var source = request.Specification ?? throw new InvalidOperationException("Missing original C# source");
        var host = new ModelHost(Path.Combine(Path.GetDirectoryName(outputPath)!, "model"));
        var candidate = new JsonObject { ["ops"] = host.PlanFrozenCSharp(basePath, source, compilation, dependencies),
            ["expectedMessages"] = ModuleSpecification.SourceDocument(jobPath)["expectedMessages"]?.DeepClone() ?? new JsonArray() };
        var generated = Path.Combine(Path.GetDirectoryName(outputPath)!, "generated.json");
        DurableJson.WriteBytes(generated, System.Text.Encoding.UTF8.GetBytes(candidate.ToJsonString()));
        return JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, generated, outputPath, log, dependencies?.ProducerBindings()))!.AsObject();
    }
    public JsonObject InspectCompilation(string snapshot, JsonObject specification, JsonObject? expectedTypes, FrozenCSharpCompilation compilation, FrozenFrameworkDependencies? dependencies)
        => new ModelHost(Path.Combine(Path.GetDirectoryName(snapshot)!, "proof-model")).CheckFrozenCSharp(snapshot, specification, expectedTypes, compilation, dependencies);

    private static readonly JsonSerializerOptions Options=new(){PropertyNamingPolicy=JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling=JsonUnmappedMemberHandling.Disallow};
    private sealed record Registration(int FormatVersion,string Environment,string Credentials,FrameworkRuntimePackage Package,
        ProducerRegistration Producer,IntrinsicRegistration[] Intrinsics);
    private sealed record ProducerRegistration(string Name,string Key,int VersionId,string SignatureHash);
    private sealed record IntrinsicRegistration(string Reference,string ElementName,string OriginalElementKey);
}
