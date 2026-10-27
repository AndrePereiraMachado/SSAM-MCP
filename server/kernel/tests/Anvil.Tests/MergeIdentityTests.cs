using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using ServiceStudio.Model;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// The content proof's identity rule (MergeContentProof, ssam-merge-identity/2) on a representative set of element kinds:
/// action, aggregate, entity attribute, screen widget, structure, static record, SOAP and REST metadata, producer reference,
/// extended property, site property, role and exception. Each module is built twice, independently, from the same base, so
/// every element the job creates has a new local key in the second build (asserted), as after a native merge that recreates
/// unchanged elements (the three false MERGE_CONTENT_LOSS refusals of 2026-10-21/22: a producer reference, a WSDL metadata,
/// and before them each kind of the old per-kind list). The two builds are accepted. Then each real change, made over the
/// second build, refuses and names its element: a removed element, a changed value, a retargeted reference, a renamed
/// element and reordered ordered children.
/// </summary>
public class MergeIdentityTests
{
    [Fact]
    public void TheSameContentUnderRegeneratedKeysIsAcceptedAndEachRealChangeRefusesNamingTheElement()
    {
        if (!StudioAvailable()) return;
        Run();
    }

    private sealed record Change(string What, string Kind, string Name, Func<Func<string, string, string>, JsonArray> Ops, string Names, string? Property = null);

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run()
    {
        var root = MergeIdentitySweep.Root;
        var work = Path.Combine(root, ".local", "merge-identity-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);

        // 1. A service module: data, logic, integrations and security (single-job-actions plus a role, a static entity, a REST
        // client and a SOAP client with its WSDL metadata).
        var service = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "tests", "jobs", "single-job-actions.json")))!.AsObject();
        service["base"] = Path.Combine(root, "tests", "fixtures", "blank-service.oml");
        var ops = service["ops"]!.AsArray();
        foreach (var op in JsonNode.Parse($$$"""
            [{"op":"create","parent":"@espace","type":"IRole","name":"MiReviewer","as":"$role"},
             {"op":"set","target":"$role","prop":"Description","value":"Reviews the agenda"},
             {"op":"spec","data":{"static":[{"name":"MiStatus","records":[{"name":"Open","label":"Open"},{"name":"Closed","label":"Closed"}]}]}},
             {"op":"create","parent":"@espace","type":"IRestClient","name":"MiApi","as":"$api"},
             {"op":"set","target":"$api","prop":"BaseURL","value":"https://example.com"},
             {"op":"create","parent":"$api","type":"IRestStructure","name":"MiBody","as":"$body"},
             {"op":"create","parent":"$body","type":"IRestStructureAttribute","name":"Title","as":"$bt"},
             {"op":"set","target":"$bt","prop":"DataType","value":"Text"},
             {"op":"create","parent":"$body","type":"IRestStructureAttribute","name":"Total","as":"$bc"},
             {"op":"set","target":"$bc","prop":"DataType","value":"Integer"},
             {"op":"create","parent":"$api","type":"IRestAction","name":"MiGet","as":"$get"},
             {"op":"set","target":"$get","prop":"HTTPMethod","value":"GET"},
             {"op":"set","target":"$get","prop":"URLPath","value":"/items"},
             {"op":"set","target":"$get","prop":"ResponseFormat","value":"JSON"},
             {"op":"create","parent":"$get","type":"IRestActionOutput","name":"Response","as":"$out"},
             {"op":"set","target":"$out","prop":"DataType","value":"MiBody"},
             {"op":"set","target":"$out","prop":"OutputPlacement","value":"BodyPlacement"},
             {"op":"create","parent":"@espace","type":"ISOAPClient","name":"MiSoap","as":"$soap",
              "allowSoapWithoutImport":{"why":"the owner of a WSDL metadata record for the content-proof identity test"}},
             {"op":"create","parent":"$soap","type":"IBinaryMetadata","name":"WsdlServiceMetadata;MiSoap_wsdl","as":"$wsdl","args":{"managedBy":"SOAP"}},
             {"op":"set","target":"$wsdl","prop":"Value","value":"{{{Convert.ToBase64String("<definitions name=\"MiSoap\"/>"u8.ToArray())}}}"}]
            """)!.AsArray().ToArray()) ops.Add(op!.DeepClone());
        var serviceJob = Path.Combine(work, "service.json"); File.WriteAllText(serviceJob, service.ToJsonString());

        // 2. A reactive module: screen, widget, extended property, static records, aggregate, unnamed flow nodes, switch.
        var reactive = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "tests", "jobs", "rename-name-property.json")))!.AsObject();
        reactive["base"] = Path.Combine(root, "tests", "fixtures", "reactive-ui.oml");
        var reactiveJob = Path.Combine(work, "reactive.json"); File.WriteAllText(reactiveJob, reactive.ToJsonString());

        // 3. A consumer of a producer: the producer is built once and bound by name, so both consumer builds reference the
        // same producer elements, each with its own new reference record and local copies.
        var producer = MergeIdentitySweep.Build(Path.Combine(root, "tests", "jobs", "producer-public.json"), Path.Combine(work, "producer.oml"), null);
        Assert.True(producer.Error == null, producer.Error);
        var consumer = JsonNode.Parse(File.ReadAllText(Path.Combine(root, "tests", "jobs", "consume-reference.json")))!.AsObject();
        consumer["base"] = Path.Combine(root, "tests", "fixtures", "reactive-ui.oml");
        consumer["ops"]![0]!["producer"] = "MiProducer";
        var consumerJob = Path.Combine(work, "consumer.json"); File.WriteAllText(consumerJob, consumer.ToJsonString());
        var bindings = new Dictionary<string, string> { ["MiProducer"] = producer.Path! };

        static JsonArray Set(string key, string prop, JsonNode value) => new(new JsonObject { ["op"] = "set", ["target"] = "@" + key, ["prop"] = prop, ["value"] = value });
        static JsonArray Delete(string key) => new(new JsonObject { ["op"] = "delete", ["target"] = "@" + key, ["force"] = true });
        static JsonArray Rename(string key, string name) => new(new JsonObject { ["op"] = "rename", ["target"] = "@" + key, ["name"] = name });
        static JsonArray Move(string key, string before) => new(new JsonObject { ["op"] = "move", ["target"] = "@" + key, ["before"] = "@" + before });

        var cases = new (string Job, IReadOnlyDictionary<string, string>? Bindings, (string Kind, string Name)[] Regenerated, Change[] Changes)[]
        {
            (serviceJob, null,
                [("IServerAction", "Agenda_Marcar"), ("IAggregateNode", "GetDoDia"), ("IEntityAttribute", "Titulo"), ("IStructure", "ResumoDoDia"),
                 ("IStaticEntity", "MiStatus"), ("IBinaryMetadata", "WsdlServiceMetadata;MiSoap_wsdl"), ("IRestAction", "MiGet"),
                 ("ISiteProperty", "FusoHorarioMinutos"), ("IRole", "MiReviewer"), ("IUserException", "AgendaInvalida")],
                [
                    new("removed action", "IServerAction", "Agenda_Marcar", k => Delete(k("IServerAction", "Agenda_Marcar")), "ServerAction:Agenda_Marcar", "$kind"),
                    new("changed action value", "IServerAction", "Agenda_Marcar", k => Set(k("IServerAction", "Agenda_Marcar"), "Description", "Another description"), "ServerAction:Agenda_Marcar", "api:Description"),
                    new("renamed action", "IServerAction", "Agenda_Marcar", k => Rename(k("IServerAction", "Agenda_Marcar"), "Agenda_Reservar"), "ServerAction:Agenda_Marcar"),
                    new("retargeted call", "IExecuteServerActionNode", "DoDia", k => Set(k("IExecuteServerActionNode", "DoDia"), "Action", "IServerAction:Agenda_TemConflito"), "ExecuteServerActionNode:DoDia", "api:Action"),
                    new("changed aggregate value", "IAggregateNode", "GetDoDia", k => Set(k("IAggregateNode", "GetDoDia"), "MaxRecords", "100"), "AggregateNode:GetDoDia"),
                    new("reordered aggregate sorts", "IAggregateNode", "GetDoDia", k => Move(k("ISort", "GetDoDia.Sorts[1]"), k("ISort", "GetDoDia.Sorts[0]")), "AggregateNode:GetDoDia", "$expression"),
                    new("changed entity attribute", "IEntityAttribute", "Titulo", k => Set(k("IEntityAttribute", "Titulo"), "Length", "100"), "EntityAttribute:Titulo", "api:Length"),
                    new("reordered entity attributes", "IEntityAttribute", "DuracaoMinutos", k => Move(k("IEntityAttribute", "DuracaoMinutos"), k("IEntityAttribute", "Titulo")), "Entity:Compromisso", "ordered:Attributes"),
                    new("retargeted attribute type", "IStructureAttribute", "Quantidade", k => Set(k("IStructureAttribute", "Quantidade"), "DataType", "Text"), "StructureAttribute:Quantidade", "api:DataType"),
                    new("renamed structure attribute", "IStructureAttribute", "Quantidade", k => Rename(k("IStructureAttribute", "Quantidade"), "Contagem"), "StructureAttribute:Quantidade"),
                    new("reordered structure attributes", "IStructureAttribute", "MinutosOcupados", k => Move(k("IStructureAttribute", "MinutosOcupados"), k("IStructureAttribute", "Data")), "Structure:ResumoDoDia", "ordered:Attributes"),
                    new("changed static record", "IRecord", "Closed", k => Set(k("IRecord", "Closed"), "Identifier", "Finished"), "MiStatus"),
                    new("removed static record", "IRecord", "Closed", k => Delete(k("IRecord", "Closed")), "MiStatus"),
                    new("changed SOAP metadata payload", "IBinaryMetadata", "WsdlServiceMetadata;MiSoap_wsdl",
                        k => Set(k("IBinaryMetadata", "WsdlServiceMetadata;MiSoap_wsdl"), "Value", Convert.ToBase64String("<definitions name=\"Other\"/>"u8.ToArray())), "WsdlServiceMetadata;MiSoap_wsdl"),
                    new("removed SOAP metadata", "IBinaryMetadata", "WsdlServiceMetadata;MiSoap_wsdl", k => Delete(k("IBinaryMetadata", "WsdlServiceMetadata;MiSoap_wsdl")), "WsdlServiceMetadata;MiSoap_wsdl", "$kind"),
                    new("changed REST action", "IRestAction", "MiGet", k => Set(k("IRestAction", "MiGet"), "URLPath", "/other"), "RestAction:MiGet", "api:URLPath"),
                    new("reordered REST structure", "IRestStructureAttribute", "Total", k => Move(k("IRestStructureAttribute", "Total"), k("IRestStructureAttribute", "Title")), "RestStructure:MiBody", "ordered:Attributes"),
                    new("changed site property", "ISiteProperty", "FusoHorarioMinutos", k => Set(k("ISiteProperty", "FusoHorarioMinutos"), "DefaultValue", "-120"), "SiteProperty:FusoHorarioMinutos"),
                    new("retargeted site property type", "ISiteProperty", "FusoHorarioMinutos", k => Set(k("ISiteProperty", "FusoHorarioMinutos"), "DataType", "Text"), "SiteProperty:FusoHorarioMinutos", "api:DataType"),
                    new("renamed role", "IRole", "MiReviewer", k => Rename(k("IRole", "MiReviewer"), "MiAuditor"), "Role:MiReviewer"),
                    new("removed role", "IRole", "MiReviewer", k => Delete(k("IRole", "MiReviewer")), "Role:MiReviewer", "$kind"),
                    new("renamed exception", "IUserException", "AgendaInvalida", k => Rename(k("IUserException", "AgendaInvalida"), "AgendaRecusada"), "UserException:AgendaInvalida"),
                ]),
            (reactiveJob, null,
                [("IMobileScreen", "RnScreen"), ("IContainer", "RnBox"), ("IServerAction", "RnClassify"), ("IStaticEntity", "RnStatus")],
                [
                    new("changed screen widget", "IContainer", "RnBox", k => Set(k("IContainer", "RnBox"), "Style", "\"card\""), "Container:RnBox"),
                    new("removed screen widget", "IContainer", "RnBox", k => Delete(k("IContainer", "RnBox")), "Container:RnBox", "$kind"),
                    new("changed extended property", "IExtendedProperty", "data-kind", k => Set(k("IExtendedProperty", "data-kind"), "Value", "\"detail\""), "ExtendedProperty"),
                    new("removed extended property", "IExtendedProperty", "data-kind", k => Delete(k("IExtendedProperty", "data-kind")), "ExtendedProperty", "$kind"),
                    new("removed unnamed end node", "IEndNode", "#2", k => Delete(k("IEndNode", "#2")), "EndNode", "$kind"),
                    new("changed switch branch label", "ISwitchCondition", "JustOne", k => Set(k("ISwitchCondition", "JustOne"), "Label", "OnlyOne"), "SwitchNode", "ordered:Conditions"),
                    new("changed static record of the reactive module", "IRecord", "Inactive", k => Set(k("IRecord", "Inactive"), "Identifier", "Off"), "RnStatus"),
                ]),
            (consumerJob, bindings,
                [("IMobileScreen", "Products"), ("IScreenAction", "LoadSummary"), ("IExecuteServerActionNode", "Product_GetById")],
                [
                    new("changed argument of a producer call", "IExecuteServerActionNode", "Product_GetById",
                        k => Set(k("IArgument", "Product_GetById.Arguments[0]"), "Value", "NullIdentifier()"), "ExecuteServerActionNode:Product_GetById"),
                    new("removed producer call", "IExecuteServerActionNode", "Product_GetById", k => Delete(k("IExecuteServerActionNode", "Product_GetById")), "ExecuteServerActionNode:Product_GetById", "$kind"),
                ]),
        };

        foreach (var (job, jobBindings, regenerated, changes) in cases)
        {
            var dir = Path.Combine(work, Path.GetFileNameWithoutExtension(job)); Directory.CreateDirectory(dir);
            var first = MergeIdentitySweep.Build(job, Path.Combine(dir, "first.oml"), jobBindings);
            Assert.True(first.Error == null, job + ": " + first.Error);
            var second = MergeIdentitySweep.Build(job, Path.Combine(dir, "second.oml"), jobBindings);
            Assert.True(second.Error == null, job + ": " + second.Error);
            var host = new ModelHost(Path.Combine(dir, "proof-model"));

            // The precondition: the second build gave each element keys of its own.
            foreach (var (kind, name) in regenerated)
                Assert.True(Key(host, first.Path!, kind, name) != Key(host, second.Path!, kind, name), job + ": " + kind + ":" + name + " kept its key");

            var same = MergeContentProof.Check(host, first.Path!, second.Path!);
            Assert.True(same["accepted"]!.GetValue<bool>(), job + ": " + MergeIdentitySweep.Summary(same["differences"]!.AsArray()).ToJsonString());

            var expectedLabels = new Dictionary<string, string>(StringComparer.Ordinal);
            var expectedModel = host.Load(File.ReadAllBytes(first.Path!));
            Dictionary<(string Key, string Property), string> expected;
            try { expected = MergeContentProof.Read(expectedModel, null, expectedLabels); }
            finally { ModelHost.Release(expectedModel); }

            foreach (var change in changes)
            {
                var model = host.Load(File.ReadAllBytes(second.Path!));
                try
                {
                    string KeyOf(string kind, string name) => Find(model, kind, name).ObjectKey!.ToString()!;
                    new ModelSession(model).Apply(change.Ops(KeyOf));
                    var labels = new Dictionary<string, string>(StringComparer.Ordinal);
                    var proof = MergeContentProof.Compare(expected, MergeContentProof.Read(model, null, labels), expectedLabels, labels);
                    var differences = proof["differences"]!.AsArray().OfType<JsonObject>().ToList();
                    Assert.False(proof["accepted"]!.GetValue<bool>(), job + ": " + change.What + " was accepted");
                    Assert.True(differences.Any(d => d["element"]!.ToString().Contains(change.Names, StringComparison.Ordinal)
                            && (change.Property == null || d["property"]!.ToString() == change.Property)),
                        job + ": " + change.What + " does not name " + change.Names + " " + change.Property + ": " + MergeIdentitySweep.Summary(proof["differences"]!.AsArray()).ToJsonString());
                }
                finally { ModelHost.Release(model); }
            }
        }
    }

    /// <summary>An element by kind and name (a flow node by its label, a static record by its identifier); "#n" is the n-th
    /// element of that kind (the order of the walk), for unnamed ones.</summary>
    private static IObjectSignature Find(ESpace model, string kind, string name)
    {
        // "Owner.Collection[i]": the i-th element of the owner's ordered collection (an aggregate's sorts, a call's arguments).
        if (name.IndexOf('[') is var open and > 0 && name.IndexOf('.') is var dot and > 0 && dot < open)
        {
            var owners = MergeIdentitySweep.Walk(model).Where(n => ModelHost.Prop(n, "Name")?.ToString() == name[..dot]).ToList();
            if (owners.Count != 1) throw new InvalidOperationException(owners.Count + " owners named " + name[..dot]);
            var items = ((System.Collections.IEnumerable)ModelHost.Prop(owners[0], name[(dot + 1)..open])!).OfType<IObjectSignature>().ToList();
            return items[int.Parse(name[(open + 1)..^1])];
        }
        var all = MergeIdentitySweep.Walk(model).Where(n => MergeIdentitySweep.Kind(n) == kind).ToList();
        if (name.StartsWith('#')) return all.OrderBy(n => n.ObjectKey?.ToString(), StringComparer.Ordinal).ElementAt(int.Parse(name[1..]));
        var found = all.Where(n => new[] { "Name", "Label", "Identifier", "Property" }.Any(p => ModelHost.Prop(n, p)?.ToString() == name)).ToList();
        return found.Count == 1 ? found[0] : throw new InvalidOperationException(found.Count + " " + kind + " named " + name);
    }

    private static string? Key(ModelHost host, string path, string kind, string name)
    {
        var model = host.Load(File.ReadAllBytes(path));
        try { return Find(model, kind, name).ObjectKey?.ToString(); }
        finally { ModelHost.Release(model); }
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }
}
