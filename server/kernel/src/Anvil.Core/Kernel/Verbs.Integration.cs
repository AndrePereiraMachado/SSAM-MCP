using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The integration ops of the job language: `rest` (consumed REST), `rest-expose` (exposed REST) and `soap` (O11). Each one
/// checks its data (pure) and the module (names, keys, consumers) and refuses with every problem before its first raw op;
/// then it applies only raw verbs (ApplyOne), so the verb contract, the data contract and the coverage ledger see each
/// change. The result carries `integration`, the report the delivery answers (contract I7 of docs/INTEGRACOES-GITSSAM.md).
/// </summary>
public sealed partial class ModelSession
{
    private static string Lane => MessageExpectations.Lane;

    // ---- rest ---------------------------------------------------------------------------------------------------------

    private JsonNode RestOp(JsonObject data)
    {
        var problems = RestExpander.Validate(data, Lane);
        if (problems.Count > 0) throw new IntegrationRefusalException("rest", problems);
        var clientName = data["client"]!["name"]!.ToString();
        var clients = TopLevel(clientName).ToList();
        var client = clients.FirstOrDefault(c => Implements(c, "IRestClient"));
        var other = clients.FirstOrDefault(c => !Implements(c, "IRestClient") && (Implements(c, "IRestService") || Implements(c, "ISOAPClient") || Implements(c, "IIntegration")));
        if (other != null)
            problems.Add(new("REST_NAME_TAKEN", "/data/client/name", $"rest: '{clientName}' is already the name of {Describe(other)} in this module", "give the REST client another name"));
        var existing = client == null ? null : ReadRestClient(client);
        if (client == null && data["client"]!["baseUrl"] == null && data["openapi"] == null)
            problems.Add(new("REST_BASEURL_REQUIRED", "/data/client/baseUrl", $"rest: client '{clientName}' does not exist yet and needs baseUrl", "\"baseUrl\": \"https://host\""));
        if (client == null && data["methods"] is not JsonArray { Count: > 0 } && data["openapi"] == null)
            problems.Add(new("REST_CLIENT_NO_METHODS", "/data/methods", $"rest: a new client '{clientName}' needs at least one method (the platform refuses a REST API without methods)", "declare its methods, or an openapi document with the operations to import"));
        foreach (var target in RestExpander.Strings(data["remove"]))
        {
            var structure = target.StartsWith("IRestStructure:", StringComparison.Ordinal);
            var name = target.Split(':').Last();
            if (existing == null || !(structure ? existing.Structures.ContainsKey(name) : existing.Methods.ContainsKey(name)))
                problems.Add(new("REST_REMOVE_NOT_FOUND", "/data/remove", $"rest: '{target}' is not {(structure ? "a structure" : "a method")} of client '{clientName}'",
                    "use one of: " + string.Join(", ", (structure ? existing?.Structures.Keys : existing?.Methods.Keys)?.ToArray() ?? [])));
        }
        RestOpenApi.OpenApiPlan? openapi = data["openapi"] is JsonObject documentData ? RestOpenApi.Plan(documentData, problems) : null;
        if (problems.Count > 0) throw new IntegrationRefusalException("rest", problems);
        var report = Report("rest");
        report["client"] = new JsonObject { ["name"] = clientName, ["key"] = client?.ObjectKey?.ToString(), ["created"] = client == null };
        if (openapi != null)
        {
            report["document"] = new JsonObject { ["source"] = openapi.Source ?? openapi.DocumentPath, ["sha256"] = openapi.Sha256 };
            client = ImportOpenApi(clientName, client, openapi, data, report);
            existing = ReadRestClient(client);
            report["client"]!["key"] = client.ObjectKey?.ToString();
        }
        var expansion = RestExpander.Expand(data, existing);
        BreaksPerTarget(expansion.Ops, data["breaks"], "rest");
        var applied = ApplyExpanded("rest", expansion.Ops);
        report["consumersBroken"] = ConsumersBroken(applied);
        foreach (var sample in expansion.Samples)
        {
            var parameter = Resolve(sample.Alias);
            var owner = client ?? (IObjectSignature)Resolve("$rest." + clientName);
            var typed = RestSamples.Apply(owner, parameter, sample.StructureName, sample.Sample);
            Touch(parameter);
            foreach (var structureName in typed["created"]!.AsArray().Select(n => n!.ToString())) expansion.Created.Add("IRestStructure:" + structureName);
        }
        client ??= (IObjectSignature)Resolve("$rest." + clientName);
        report["client"]!["key"] = client.ObjectKey?.ToString();
        if (report["client"]!["created"]?.GetValue<bool>() == true) expansion.Updated.Remove("IRestClient:" + clientName);
        Fill(report, expansion.Created, expansion.Updated, expansion.Removed);
        return new JsonObject { ["expanded"] = expansion.Ops.Count, ["samples"] = expansion.Samples.Count, ["integration"] = report };
    }

    /// <summary>The OpenAPI import of the op: on ODC the headless importer of the lane (RestOpenApi.Importer); on O11 the
    /// bridge imports before the job runs (Delivery: integration_import), so the chosen operations already exist on the
    /// candidate; without them here the job runs outside a delivery and is refused with INTEGRATION_IMPORT_NEEDS_STUDIO.</summary>
    private IObjectSignature ImportOpenApi(string clientName, IObjectSignature? client, RestOpenApi.OpenApiPlan plan, JsonObject data, JsonObject report)
    {
        var present = client == null ? new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            : client.Children.OfType<IObjectSignature>().Where(c => Implements(c, "IRestAction")).Select(c => TypeResolver.Name(c) ?? "").ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (Lane == "o11" || RestOpenApi.Importer == null)
        {
            var missing = plan.Selected.Where(o => !present.Contains(OperationMethodName(o))).Select(o => o.Label).ToList();
            if (client == null || missing.Count > 0)
                throw new IntegrationRefusalException("rest", [new("INTEGRATION_IMPORT_NEEDS_STUDIO", "/data/openapi",
                    $"rest: the OpenAPI import of {string.Join(", ", missing.DefaultIfEmpty(clientName))} runs in the Service Studio (the O11 importer needs its workspace), and this job runs without it",
                    "deliver it with o11_deliver (the bridge imports on a copy of the module, then the job applies and merges once)")]);
            report["skipped"] =new JsonArray(plan.Selected.Select(o => (JsonNode)o.Label).ToArray());
            return client;
        }
        var result = RestOpenApi.Importer((ServiceStudio.Model.ESpace)_espace, new RestOpenApi.ImportRequest(clientName, plan, data["client"]?["baseUrl"]?.ToString()));
        if (result.Problems.Count > 0) throw new IntegrationRefusalException("rest", result.Problems);
        _byKey = null;
        report["imported"] = new JsonArray(result.Imported.Select(i => (JsonNode)i).ToArray());
        report["skipped"] = new JsonArray(result.Skipped.Select(i => (JsonNode)i).ToArray());
        foreach (var warning in result.Warnings) ((JsonArray)report["warnings"]!).Add(warning);
        report["client"]!["created"] = result.ClientCreated;
        var imported = (result.ClientKey != null ? Resolve("@" + result.ClientKey) as IObjectSignature : null)
            ?? TopLevel(clientName).FirstOrDefault(c => Implements(c, "IRestClient"))
            ?? throw new InvalidOperationException($"rest: the OpenAPI import answered but no IRestClient '{clientName}' exists afterwards");
        // The platform names the client after the document's title: the op's name is the one kept (a raw set, recorded).
        if (!string.Equals(TypeResolver.Name(imported), clientName, StringComparison.Ordinal))
            ApplyOne(new JsonObject { ["op"] = "set", ["target"] = "@" + imported.ObjectKey, ["prop"] = "Name", ["value"] = clientName });
        Touch(imported);
        return imported;
    }

    /// <summary>The method name the platform gives an OpenAPI operation: its operationId as an OutSystems name.</summary>
    internal static string OperationMethodName(RestOpenApi.Operation operation)
    {
        var source = operation.Id.Length > 0 ? operation.Id : operation.Verb + operation.Path;
        var name = new string(source.Select(c => char.IsLetterOrDigit(c) || c == '_' ? c : '_').ToArray()).Trim('_');
        return name.Length > 0 && char.IsLetter(name[0]) ? char.ToUpperInvariant(name[0]) + name[1..] : "M" + name;
    }

    private RestExpander.Existing ReadRestClient(IObjectSignature client)
    {
        IReadOnlyDictionary<string, string> Children(IObjectSignature owner, params string[] types) => owner.Children.OfType<IObjectSignature>()
            .Where(c => types.Any(t => Implements(c, t)) && TypeResolver.Name(c) is { Length: > 0 })
            .GroupBy(c => TypeResolver.Name(c)!, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First().ObjectKey!.ToString()!, StringComparer.Ordinal);
        var methods = client.Children.OfType<IObjectSignature>().Where(c => Implements(c, "IRestAction") && TypeResolver.Name(c) is { Length: > 0 })
            .GroupBy(c => TypeResolver.Name(c)!, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => new RestExpander.ExistingMethod(g.First().ObjectKey!.ToString()!, Children(g.First(), "IRestActionInput"), Children(g.First(), "IRestActionOutput")), StringComparer.Ordinal);
        var structures = client.Children.OfType<IObjectSignature>().Where(c => Implements(c, "IRestStructure") && TypeResolver.Name(c) is { Length: > 0 })
            .GroupBy(c => TypeResolver.Name(c)!, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => new RestExpander.ExistingStructure(g.First().ObjectKey!.ToString()!, Children(g.First(), "IRestStructureAttribute")), StringComparer.Ordinal);
        var headers = client.Children.OfType<IObjectSignature>().Where(c => Implements(c, "IExtendedProperty"))
            .Select(c => (Property: ModelHost.Prop(c, "Property")?.ToString(), Key: c.ObjectKey!.ToString()!)).Where(h => !string.IsNullOrEmpty(h.Property))
            .GroupBy(h => h.Property!, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First().Key, StringComparer.OrdinalIgnoreCase);
        return new(client.ObjectKey!.ToString()!, methods, structures, headers);
    }

    // ---- rest-expose --------------------------------------------------------------------------------------------------

    private JsonNode RestExposeOp(JsonObject data)
    {
        var problems = RestExposeExpander.Validate(data);
        if (problems.Count > 0) throw new IntegrationRefusalException("rest-expose", problems);
        var serviceName = data["service"]!["name"]!.ToString();
        var services = TopLevel(serviceName).ToList();
        var service = services.FirstOrDefault(c => Implements(c, "IRestService"));
        if (service == null && services.FirstOrDefault(c => Implements(c, "IRestClient") || Implements(c, "ISOAPClient")) is { } other)
            problems.Add(new("REST_EXPOSE_KEY_INVALID", "/data/service/name", $"rest-expose: '{serviceName}' is already the name of {Describe(other)}", "give the service another name"));
        var methods = service?.Children.OfType<IObjectSignature>().Where(c => Implements(c, "IRestServiceAction") && TypeResolver.Name(c) is { Length: > 0 })
            .GroupBy(c => TypeResolver.Name(c)!, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase)
            ?? new Dictionary<string, IObjectSignature>(StringComparer.OrdinalIgnoreCase);
        var routes = methods.Values.GroupBy(m => (ModelHost.Prop(m, "HTTPMethod")?.ToString() ?? "GET").ToUpperInvariant() + " " + RestExposeExpander.Route(ModelHost.Prop(m, "URLPath")?.ToString() ?? "/"), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => TypeResolver.Name(g.First())!, StringComparer.OrdinalIgnoreCase);
        foreach (var target in RestExpander.Strings(data["remove"]))
            if (!methods.ContainsKey(target.Split(':').Last()))
                problems.Add(new("REST_EXPOSE_KEY_INVALID", "/data/remove", $"rest-expose: '{target}' is not a method of service '{serviceName}'", "use one of: " + string.Join(", ", methods.Keys)));
        var signatures = new Dictionary<string, RestExposeExpander.ActionSignature?>(StringComparer.Ordinal);
        RestExposeExpander.ActionSignature? Signature(string reference) => signatures.TryGetValue(reference, out var known) ? known : signatures[reference] = ActionSignatureOf(reference);
        problems.AddRange(RestExposeExpander.CheckAgainstModule(data, Signature, routes));
        if (problems.Count > 0) throw new IntegrationRefusalException("rest-expose", problems);
        var expansion = RestExposeExpander.Expand(data, service?.ObjectKey?.ToString(), methods.ToDictionary(m => m.Key, m => m.Value.ObjectKey!.ToString()!, StringComparer.OrdinalIgnoreCase), Signature);
        BreaksPerTarget(expansion.Ops, data["breaks"], "rest-expose");
        var applied = ApplyExpanded("rest-expose", expansion.Ops);
        service ??= (IObjectSignature)Resolve("$restExpose." + serviceName);
        var report = Report("rest-expose");
        report["consumersBroken"] = ConsumersBroken(applied);
        report["service"] = new JsonObject { ["name"] = serviceName, ["key"] = service.ObjectKey?.ToString(), ["created"] = expansion.Created.Contains("IRestService:" + serviceName) };
        if (ModelHost.Prop(service, "URL")?.ToString() is { Length: > 0 } url) report["url"] = url;
        Fill(report, expansion.Created, expansion.Updated, expansion.Removed);
        return new JsonObject { ["expanded"] = expansion.Ops.Count, ["integration"] = report };
    }

    /// <summary>The signature of the action a rest-expose method calls: own server actions and referenced ones.</summary>
    private RestExposeExpander.ActionSignature? ActionSignatureOf(string reference)
    {
        var candidates = reference.Contains(':') ? [reference] : new[] { "IServerAction:" + reference, "IServerActionSignature:" + reference, "IServiceAction:" + reference, "IServiceActionSignature:" + reference };
        foreach (var candidate in candidates)
        {
            object resolved;
            try { resolved = Resolve(candidate); } catch (Exception) { continue; }
            if (resolved is not IObjectSignature action || !(Implements(action, "IServerAction") || Implements(action, "IServerActionSignature") || Implements(action, "IServiceAction") || Implements(action, "IServiceActionSignature"))) continue;
            var inputs = action.Children.OfType<IObjectSignature>().Where(p => Implements(p, "IInputParameter") || Implements(p, "IInputParameterSignature"))
                .Select(p => (TypeResolver.Name(p) ?? "", UiCatalog.TypeName(ModelHost.Prop(p, "DataType")), ModelHost.Prop(p, "IsMandatory") is not false)).ToList();
            var outputs = action.Children.OfType<IObjectSignature>().Where(p => Implements(p, "IOutputParameter") || Implements(p, "IOutputParameterSignature"))
                .Select(p => (TypeResolver.Name(p) ?? "", UiCatalog.TypeName(ModelHost.Prop(p, "DataType")))).ToList();
            var kind = candidate.Split(':')[0];
            var name = TypeResolver.Name(action) ?? reference.Split(':').Last();
            return new(kind.Length > 0 && kind.StartsWith('I') ? kind + ":" + name : "IServerAction:" + name, name, inputs, outputs);
        }
        return null;
    }

    // ---- soap ---------------------------------------------------------------------------------------------------------

    private JsonNode SoapOp(JsonObject data)
    {
        if (Lane == "odc")
            throw new IntegrationRefusalException("soap", [new("SOAP_LANE_UNSUPPORTED", "/data", "soap: SOAP is not available on ODC (the platform consumes REST only)",
                "consume the service through a REST facade (op rest), or an External Library that calls it")]);
        var plan = SoapPlan.Plan(data);
        if (plan.Problems.Count > 0) throw new IntegrationRefusalException("soap", plan.Problems.ToList());
        var selection = plan.Selection!;
        var problems = new List<IntegrationProblem>();
        var client = TopLevel(selection.Client).FirstOrDefault(c => Implements(c, "ISOAPClient"));
        if (client != null)
        {
            var binding = ModelHost.Prop(client, "Binding")?.ToString() ?? "";
            var contract = ModelHost.Prop(client, "Contract")?.ToString() ?? "";
            if (binding.Length > 0 && !Mentions(binding, selection.Port.Name) && !Mentions(binding, selection.Port.Binding)
                || contract.Length > 0 && selection.Port.PortType.Length > 0 && !Mentions(contract, selection.Port.PortType))
                problems.Add(new("SOAP_CLIENT_PORT_MISMATCH", "/data/client", $"soap: client '{selection.Client}' already imports binding '{binding}' (contract '{contract}'), not port {selection.Port.Name} ({selection.Port.Binding}, {selection.Port.PortType})",
                    $"name another client (\"client\": \"{selection.Client}2\") for this port, or select the client's own port (\"port\": \"{binding}\")"));
        }
        var methods = client?.Children.OfType<IObjectSignature>().Where(c => Implements(c, "ISOAPAction")).Select(c => TypeResolver.Name(c) ?? "").ToHashSet(StringComparer.Ordinal)
            ?? new HashSet<string>(StringComparer.Ordinal);
        var removing = RestExpander.Strings(data["remove"]).ToList();
        foreach (var target in removing.Where(r => !methods.Contains(r.Split(':').Last())))
            problems.Add(new("SOAP_METHOD_NOT_FOUND", "/data/remove", $"soap: '{target}' is not a method of client '{selection.Client}'", "use one of: " + string.Join(", ", methods)));
        var missing = selection.Methods.Where(m => !methods.Contains(m)).ToList();
        if (missing.Count > 0)
            problems.Add(new("INTEGRATION_IMPORT_NEEDS_STUDIO", "/data/methods", $"soap: {string.Join(", ", missing)} must be imported from the WSDL, which the Service Studio's own importer does, and this job runs without it",
                "deliver it with o11_deliver: the bridge imports on a copy of the module (integration_import), then the job applies and merges once"));
        if (problems.Count > 0) throw new IntegrationRefusalException("soap", problems);
        if (client != null && selection.Methods.Count > 0)
        {
            var (parameters, structures) = SoapContract.Read(client, selection.Methods);
            var contractProblems = SoapContract.Check(parameters, structures);
            if (contractProblems.Count > 0) throw new IntegrationRefusalException("soap", contractProblems);
        }
        var ops = removing.Select(r => RestExpander.Op("delete", ("target", "@" + client!.Children.OfType<IObjectSignature>()
            .First(c => Implements(c, "ISOAPAction") && TypeResolver.Name(c) == r.Split(':').Last()).ObjectKey))).ToList();
        if (data["breaks"] is JsonArray breaks) foreach (var op in ops) op["breaks"] = breaks.DeepClone();
        BreaksPerTarget(ops, data["breaks"], "soap");
        var structuresBefore = client?.Children.OfType<IObjectSignature>().Count(c => Implements(c, "ISOAPStructure")) ?? 0;
        var results = ApplyExpanded("soap", ops);
        var report = Report("soap");
        report["client"] = new JsonObject { ["name"] = selection.Client, ["key"] = client?.ObjectKey?.ToString(), ["created"] = false };
        report["skipped"] = new JsonArray(selection.Methods.Select(m => (JsonNode)m).ToArray());
        report["removed"] = new JsonArray(removing.Select(r => (JsonNode)("ISOAPAction:" + r.Split(':').Last())).Concat(results.OfType<JsonObject>()
            .SelectMany(r => r["removedStructures"]?.AsArray().Select(s => (JsonNode)("ISOAPStructure:" + s)) ?? [])).ToArray());
        report["document"] = new JsonObject { ["source"] = selection.Source ?? selection.DocumentPath, ["sha256"] = selection.DocumentSha256 };
        report["selection"] = selection.ToJson();
        report["consumersBroken"] = ConsumersBroken(results);
        return new JsonObject { ["expanded"] = ops.Count, ["integration"] = report };
    }

    private static bool Mentions(string value, string name) => name.Length > 0 && value.Split(':', '/', '#', '{', '}', ' ').Any(p => string.Equals(p, name, StringComparison.Ordinal));

    /// <summary>The structures of a SOAP client that nothing references any more, removed until none is left.</summary>
    private JsonArray RemoveUnusedSoapStructures(IObjectSignature client)
    {
        var removed = new JsonArray();
        // Unused = no authored consumer (the platform's own derived types, a list or record of the structure, do not count).
        while (client.Children.OfType<IObjectSignature>().FirstOrDefault(c => Implements(c, "ISOAPStructure") && c is ServiceStudio.Model.AbstractObject
                   && DeleteConsumers(c).Count == 0) is { } unused)
        {
            removed.Add(TypeResolver.Name(unused));
            EsquecerApagado(unused);
            unused.Delete();
        }
        return removed;
    }

    // ---- shared -------------------------------------------------------------------------------------------------------

    /// <summary>Top-level elements of the module with this name (the integrations live directly under the module).</summary>
    private IEnumerable<IObjectSignature> TopLevel(string name) => ((IObjectSignature)_es).Children.OfType<IObjectSignature>()
        .Where(c => string.Equals(TypeResolver.Name(c), name, StringComparison.OrdinalIgnoreCase));

    /// <summary>The breaks of a compact op cover all its deletes: each delete gets exactly the consumers it has, and their
    /// union must be the list (CONSUMERS_CHANGED otherwise), checked on the module before the first op is applied.</summary>
    private void BreaksPerTarget(List<JsonObject> ops, JsonNode? breaks, string op)
    {
        var wanted = RestExpander.Strings(breaks).ToHashSet(StringComparer.Ordinal);
        var deletes = ops.Where(o => o["op"]?.ToString() == "delete").ToList();
        if (wanted.Count == 0) { foreach (var d in deletes) d.Remove("breaks"); return; }
        var union = new HashSet<string>(StringComparer.Ordinal);
        foreach (var delete in deletes)
        {
            object target;
            try { target = Resolve(delete["target"]!.ToString()); } catch (Exception) { delete.Remove("breaks"); continue; }
            var consumers = target is ServiceStudio.Model.AbstractObject && target is IObjectSignature signature ? DeleteConsumers(signature).Select(c => c.Path).ToList() : [];
            union.UnionWith(consumers);
            if (consumers.Count == 0) delete.Remove("breaks");
            else delete["breaks"] = new JsonArray(consumers.Select(c => (JsonNode)c).ToArray());
        }
        if (!union.SetEquals(wanted))
            throw new KernelRefusalException("CONSUMERS_CHANGED", $"{op}: breaks names {wanted.Count} consumer(s) and the deletes of this op break {union.Count}: "
                + "now " + string.Join("; ", union) + (union.Count == 0 ? "none" : "") + ". Nothing was deleted",
                new JsonArray(union.Except(wanted).Select(p => (JsonNode)JobPreflight.PublicProblem(JobPreflight.Problem(null, null, "CONSUMERS_CHANGED", "error", $"{p} breaks and is not in breaks", "add it to breaks (and to the user's words), or delete/rewrite it earlier in this job")))
                    .Concat(wanted.Except(union).Select(p => (JsonNode)JobPreflight.PublicProblem(JobPreflight.Problem(null, null, "CONSUMERS_CHANGED", "error", $"{p} is in breaks and does not break", "remove it from breaks")))).ToArray()));
    }

    private JsonArray ApplyExpanded(string op, List<JsonObject> ops)
    {
        var results = new JsonArray();
        for (var k = 0; k < ops.Count; k++)
        {
            try { results.Add(ApplyOne(ops[k])?.DeepClone()); }
            catch (KernelRefusalException) { throw; }
            catch (Exception ex) { throw new InvalidOperationException($"{op} op #{k} ({ops[k]["op"]} {ops[k]["name"] ?? ops[k]["prop"]} on {ops[k]["parent"] ?? ops[k]["target"]}): {Unwrap(ex)}", ex); }
        }
        return results;
    }

    /// <summary>One problem per consumer (path, kind) of a refused delete, with the fix.</summary>
    private static JsonArray ConsumerProblems(string code, IObjectSignature target, List<(ServiceStudio.Model.AbstractObject Referer, string Path)> consumers, string fix)
        => new(consumers.Select(c => (JsonNode)JobPreflight.PublicProblem(JobPreflight.Problem(null, c.Path, code, "error",
            $"{c.Path} ({ShortType(c.Referer)}) uses {Describe(target)}", fix))).ToArray());

    private static JsonArray ConsumersBroken(JsonArray results) => new(results.OfType<JsonObject>()
        .SelectMany(r => r["breaks"]?.AsArray().Select(p => (JsonNode)new JsonObject { ["path"] = p!.ToString(), ["kind"] = p.ToString().Split('/').Last().Split(':')[0] }) ?? []).ToArray());

    private static JsonObject Report(string op) => new()
    {
        ["op"] = op, ["imported"] = new JsonArray(), ["skipped"] = new JsonArray(), ["updated"] = new JsonArray(), ["removed"] = new JsonArray(),
        ["consumersBroken"] = new JsonArray(), ["warnings"] = new JsonArray(),
    };

    private static void Fill(JsonObject report, List<string> created, List<string> updated, List<string> removed)
    {
        foreach (var c in created) ((JsonArray)report["imported"]!).Add(c);
        foreach (var u in updated) ((JsonArray)report["updated"]!).Add(u);
        foreach (var r in removed) ((JsonArray)report["removed"]!).Add(r);
    }
}
