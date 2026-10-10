using System.Collections;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Avalonia.Threading;
using ServiceStudio.Model;
using ServiceStudio.Presenter;

namespace Anvil.Bridge;

/// <summary>
/// integration_import (capabilities integration_import:wsdl and integration_import:openapi): the Service Studio's own
/// importer runs on a DETACHED copy of the delivery's snapshot (ESpace.Load, as merge_from_oml loads its foreign module),
/// with the PluginWorkspace of the target tab borrowed for the plugin; the open module is never touched. The candidate is
/// saved to out_path once and the delivery applies the job to it and merges it (one native merge, Ctrl+Z, TrueChange).
/// Arguments are checked first by Anvil.Core.IntegrationImport.Validate (absolute paths, sha256): anything wrong is
/// NotExecuted. The plugin members are found by name in the loaded plugins (install-agnostic); a member this Studio does
/// not have answers INTEGRATION_IMPORTER_NOT_FOUND naming it and the Studio version, nothing written.
/// WSDL: WSDLFetcher.ConsumeWsdl on the pinned file (the full WSDL, so an incremental import keeps every type), the port
/// selected by name, ToImport only on the requested methods that the client does not have yet (or listed in refresh),
/// then SOAPClientDescriptor.ImportFromWSDLDefinition. OpenAPI: IRestPluginService.CreateRestClientFromSwagger on the
/// document reduced to the chosen operations, the bundled dependencies passed in, no network.
/// </summary>
internal static class IntegrationImportHandler
{
    private const BindingFlags Any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

    public static async Task<string> Handle(JsonObject? p)
    {
        var problems = IntegrationImport.Validate(p);
        if (problems.Count > 0) return Server.NotExecuted(string.Join("; ", problems));
        IAggregatorPresenter aggregator; ESpace live;
        try
        {
            (aggregator, live) = await Ui.Run(() =>
            {
                var (a, e) = Studio.Target(p);
                Studio.RequireTarget(a, e, p);
                return (a, e);
            }, UiGate.Read, "integration_import: find the module");
        }
        catch (Exception ex) { return Server.NotExecuted(Server.Unwrap(ex)); }
        var sw = Stopwatch.StartNew();
        var kind = p!["kind"]!.ToString();
        var outPath = p["out_path"]!.ToString();
        try
        {
            // Under the client's default 120 s for this verb (o11-bridge.mjs timeoutFor).
            return await Ui.Run(() =>
            {
                var copy = ESpace.Load(File.ReadAllBytes(p["base_path"]!.ToString()), productKey: null, informationForUpgrader: null);
                try
                {
                    SnapshotRegistry.RequireForeignIdentity(live.Key.ToString(), copy.Key.ToString());
                    var workspace = BorrowWorkspace(aggregator);
                    var outcome = kind == "wsdl" ? ImportWsdl(copy, workspace, p) : ImportOpenApi(copy, p);
                    if (outcome["errors"] is JsonArray { Count: > 0 }) { outcome["elapsedMs"] = sw.ElapsedMilliseconds; return Server.Ok(outcome); }
                    using var ms = copy.SaveToMemoryStream();
                    var bytes = ms.ToArray();
                    using (var file = new FileStream(outPath, FileMode.CreateNew, FileAccess.Write)) file.Write(bytes);
                    outcome["candidate_path"] = outPath;
                    outcome["candidate_sha256"] = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
                    outcome["elapsedMs"] = sw.ElapsedMilliseconds;
                    return Server.Ok(outcome);
                }
                finally { try { copy.Close(); } catch { } }
            }, TimeSpan.FromSeconds(110), "integration_import: import on the copy");
        }
        catch (Exception ex) { return Server.Fail("integration_import: " + Server.Unwrap(ex) + "; nothing was written to the open module"); }
    }

    private static JsonObject Outcome(string client) => new()
    {
        ["client"] = new JsonObject { ["name"] = client, ["key"] = null, ["created"] = false },
        ["imported"] = new JsonArray(), ["skipped"] = new JsonArray(), ["warnings"] = new JsonArray(), ["errors"] = new JsonArray(),
    };

    private static JsonObject Refuse(JsonObject outcome, string code, string error)
    {
        outcome["code"] = code;
        ((JsonArray)outcome["errors"]!).Add(error);
        return outcome;
    }

    private static string StudioVersion => typeof(ESpace).Assembly.GetName().Version?.ToString() ?? "?";

    // ---- WSDL -----------------------------------------------------------------------------------------------------------

    private static JsonObject ImportWsdl(ESpace copy, object? workspace, JsonObject p)
    {
        var clientName = p["client"]!.ToString();
        var outcome = Outcome(clientName);
        var selection = p["selection"]!.AsObject();
        var refresh = Strings(selection["refresh"]).ToHashSet(StringComparer.Ordinal);
        var wanted = Strings(selection["methods"]).ToList();
        var fetcherType = FindType("ServiceStudio.Plugin.SOAP.WSDLFetcher");
        var clientInterface = FindType("ServiceStudio.Plugin.SOAP.ISOAPClient");
        var missing = new List<string>();
        if (fetcherType == null) missing.Add("ServiceStudio.Plugin.SOAP.WSDLFetcher");
        if (clientInterface == null) missing.Add("ServiceStudio.Plugin.SOAP.ISOAPClient");
        var consume = fetcherType?.GetMethod("ConsumeWsdl", Any, null, [typeof(string)], null);
        if (fetcherType != null && consume == null) missing.Add("WSDLFetcher.ConsumeWsdl(string)");
        if (missing.Count > 0)
            return Refuse(outcome, IntegrationImport.ImporterNotFound, $"the SOAP importer of this Service Studio ({StudioVersion}) has no {string.Join(", ", missing)}");
        var es = (OutSystems.Model.IESpace)copy;
        var client = ((OutSystems.Model.IObjectSignature)copy).Children.OfType<OutSystems.Model.IObjectSignature>()
            .FirstOrDefault(c => clientInterface!.IsInstanceOfType(c) && string.Equals(TypeResolver.Name(c), clientName, StringComparison.OrdinalIgnoreCase));
        var present = Actions(client);
        var toImport = wanted.Where(m => !present.Contains(m) || refresh.Contains(m)).ToList();
        foreach (var skipped in wanted.Except(toImport)) ((JsonArray)outcome["skipped"]!).Add(skipped);
        if (toImport.Count == 0) { outcome["client"]!["key"] = client?.ObjectKey?.ToString(); return outcome; }
        var fileUri = new Uri(p["document_path"]!.ToString()).AbsoluteUri;
        object? imported;
        try { imported = Worker(() => consume!.Invoke(CreateFetcher(fetcherType!, workspace), [fileUri]), "WSDL fetch"); }
        catch (Exception ex) { return Refuse(outcome, IntegrationImport.ImportFailed, "the Studio could not read the pinned WSDL: " + Server.Unwrap(ex)); }
        if (imported == null) return Refuse(outcome, IntegrationImport.ImportFailed, "the Studio's WSDL reader returned nothing for the pinned WSDL");
        ChoosePort(imported, selection["port"]?.ToString() ?? "", selection["service"]?.ToString() ?? "");
        var methods = MethodsToChoose(imported);
        if (methods.Count == 0) return Refuse(outcome, IntegrationImport.ImporterNotFound, $"the SOAP importer of this Service Studio ({StudioVersion}) exposes no selectable methods (GetMethodsToChoose)");
        var byName = methods.GroupBy(m => Studio.Prop(m, "Name")?.ToString() ?? "", StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        foreach (var name in toImport.Where(n => !byName.ContainsKey(n)))
            Refuse(outcome, "SOAP_METHOD_NOT_FOUND", $"the selected port has no operation '{name}' (available: {string.Join(", ", byName.Keys)})");
        if (outcome["errors"] is JsonArray { Count: > 0 }) return outcome;
        foreach (var (name, method) in byName) SetBool(method, "ToImport", toImport.Contains(name, StringComparer.Ordinal));
        var chosen = toImport.Select(n => byName[n]).ToList();
        var created = false;
        string? error = null;
        StudioAdapter.Runtime.Mutate(copy, "Anvil: SOAP import " + clientName, _ =>
        {
            if (client == null)
            {
                var create = typeof(OutSystems.Model.IESpace).GetMethods().FirstOrDefault(m => m.Name == "CreateIntegration" && m.IsGenericMethodDefinition && m.GetParameters().Length >= 1);
                client = create?.MakeGenericMethod(clientInterface!).Invoke(es, create.GetParameters().Select((pp, i) => i == 0 ? (object?)clientName : pp.HasDefaultValue ? pp.DefaultValue : null).ToArray()) as OutSystems.Model.IObjectSignature;
                if (client == null) { error = "IESpace.CreateIntegration<ISOAPClient> is not available in this Studio"; return; }
                created = true;
                SetString(client, "WSDLLocation", p["source"]?.ToString() is { Length: > 0 } source && source.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? source : fileUri);
            }
            var descriptor = client.GetType().GetMethod("GetCustomObjectDescriptor", Any, Type.EmptyTypes)?.Invoke(client, null) ?? Studio.Prop(client, "Descriptor");
            var import = descriptor?.GetType().GetMethods(Any).FirstOrDefault(m => m.Name == "ImportFromWSDLDefinition" && m.GetParameters().Length == 3)
                ?? FindType("ServiceStudio.Plugin.SOAP.SOAPClientDescriptor")?.GetMethods(Any).FirstOrDefault(m => m.Name == "ImportFromWSDLDefinition" && m.GetParameters().Length == 3);
            if (import == null) { error = $"the SOAP importer of this Service Studio ({StudioVersion}) has no SOAPClientDescriptor.ImportFromWSDLDefinition(client, wsdl, methods)"; return; }
            var owner = import.IsStatic ? null : descriptor ?? Activator.CreateInstance(import.DeclaringType!, nonPublic: true);
            Worker<object?>(() => import.Invoke(owner, [client, imported, TypedList(chosen, import.GetParameters()[2].ParameterType)]), "SOAP import");
        });
        if (error != null) return Refuse(outcome, IntegrationImport.ImporterNotFound, error);
        var after = Actions(client);
        foreach (var name in toImport)
            if (after.Contains(name)) ((JsonArray)outcome["imported"]!).Add(name);
            else Refuse(outcome, IntegrationImport.ImportFailed, $"the Studio's importer did not create method '{name}'");
        outcome["client"] = new JsonObject { ["name"] = clientName, ["key"] = client?.ObjectKey?.ToString(), ["created"] = created };
        return outcome;
    }

    private static HashSet<string> Actions(OutSystems.Model.IObjectSignature? client) => client?.Children.OfType<OutSystems.Model.IObjectSignature>()
        .Where(c => c.GetType().GetInterfaces().Any(i => i.Name == "ISOAPAction")).Select(c => TypeResolver.Name(c) ?? "").ToHashSet(StringComparer.Ordinal) ?? new HashSet<string>(StringComparer.Ordinal);

    private static object? CreateFetcher(Type fetcherType, object? workspace)
    {
        if (workspace != null)
            foreach (var ctor in fetcherType.GetConstructors(Any))
                if (ctor.GetParameters() is [{ } only] && only.ParameterType.IsInstanceOfType(workspace)) return ctor.Invoke([workspace]);
        return fetcherType.GetConstructor(Any, Type.EmptyTypes)?.Invoke(null) ?? Activator.CreateInstance(fetcherType, nonPublic: true);
    }

    /// <summary>The port the plan selected: SetContract(service, port) by port name when the WSDL asks to choose.</summary>
    private static void ChoosePort(object imported, string port, string service)
    {
        var type = imported.GetType();
        var needs = type.GetMethod("NeedChooseBindings", Any, Type.EmptyTypes)?.Invoke(imported, null) is true;
        var setContract = type.GetMethod("SetContract", Any);
        if (!needs) { try { setContract?.Invoke(imported, [null, null]); } catch { } return; }
        foreach (var s in Enumerate(type.GetMethod("GetServices", Any, Type.EmptyTypes)?.Invoke(imported, null)))
        {
            if (service.Length > 0 && !string.Equals(Studio.Prop(s, "Name")?.ToString(), service, StringComparison.Ordinal)) continue;
            foreach (var candidate in Enumerate(Studio.Prop(s, "Ports") ?? Studio.Prop(s, "ServicePorts")))
                if (string.Equals(Studio.Prop(candidate, "Name")?.ToString(), port, StringComparison.Ordinal)) { setContract?.Invoke(imported, [s, candidate]); return; }
        }
    }

    private static List<object> MethodsToChoose(object imported)
    {
        var list = new List<object>();
        var get = imported.GetType().GetMethod("GetMethodsToChoose", Any, Type.EmptyTypes);
        if (get != null) list.AddRange(Enumerate(get.Invoke(imported, null)));
        if (list.Count == 0) list.AddRange(Enumerate(Studio.Prop(imported, "Methods")));
        return list.Where(m => m.GetType().GetProperty("ToImport", Any) != null).Distinct(ReferenceEqualityComparer.Instance).ToList();
    }

    // ---- OpenAPI --------------------------------------------------------------------------------------------------------

    private static JsonObject ImportOpenApi(ESpace copy, JsonObject p)
    {
        var clientName = p["client"]!.ToString();
        var outcome = Outcome(clientName);
        var serviceType = FindType("ServiceStudio.Plugin.REST.IRestPluginService");
        var services = typeof(OutSystems.Model.IESpace).Assembly.GetType("OutSystems.Model.Services")?.GetProperty("ModelServices")?.GetValue(null);
        var getService = services?.GetType().GetInterfaces().Append(services.GetType()).Select(t => t.GetMethod("GetPluginService")).FirstOrDefault(m => m != null);
        var service = serviceType != null && getService != null ? getService.MakeGenericMethod(serviceType).Invoke(services, null) : null;
        var create = serviceType?.GetMethods().Where(m => m.Name == "CreateRestClientFromSwagger").OrderByDescending(m => m.GetParameters().Length).FirstOrDefault();
        if (service == null || create == null)
            return Refuse(outcome, IntegrationImport.ImporterNotFound, $"the REST plugin of this Service Studio ({StudioVersion}) has no IRestPluginService.CreateRestClientFromSwagger reachable through ModelServices.GetPluginService");
        var existing = ((OutSystems.Model.IObjectSignature)copy).Children.OfType<OutSystems.Model.IObjectSignature>()
            .FirstOrDefault(c => string.Equals(TypeResolver.Name(c), clientName, StringComparison.OrdinalIgnoreCase));
        var operations = p["selection"]!["operations"]!.AsArray().OfType<JsonObject>().Select(o => new RestOpenApi.Operation(o["id"]?.ToString() ?? "", o["verb"]!.ToString(), o["path"]!.ToString())).ToList();
        if (existing != null)
        {
            var have = existing.Children.OfType<OutSystems.Model.IObjectSignature>().Select(c => TypeResolver.Name(c) ?? "").ToHashSet(StringComparer.OrdinalIgnoreCase);
            var all = operations.Select(o => (Operation: o, Name: OperationName(o))).ToList();
            foreach (var (operation, _) in all.Where(x => have.Contains(x.Name))) ((JsonArray)outcome["skipped"]!).Add(operation.Label);
            if (all.All(x => have.Contains(x.Name))) { outcome["client"]!["key"] = existing.ObjectKey?.ToString(); return outcome; }
            return Refuse(outcome, IntegrationImport.ImportFailed, $"client '{clientName}' already exists: the O11 OpenAPI import creates a new client; import the new operations into another client name, or declare them as methods (op rest)");
        }
        var text = File.ReadAllText(p["document_path"]!.ToString());
        var plan = new RestOpenApi.OpenApiPlan(p["document_path"]!.ToString(), p["document_sha256"]!.ToString(), text, null, operations, operations, []);
        var dependencies = new Dictionary<Uri, string>();
        foreach (var d in p["dependencies"]?.AsArray().OfType<JsonObject>() ?? [])
            if (Uri.TryCreate(d["uri"]!.ToString(), UriKind.RelativeOrAbsolute, out var uri)) dependencies[uri] = File.ReadAllText(d["path"]!.ToString());
        string? error = null;
        OutSystems.Model.IObjectSignature? client = null;
        StudioAdapter.Runtime.Mutate(copy, "Anvil: OpenAPI import " + clientName, _ =>
        {
            var arguments = create.GetParameters().Select(parameter => parameter.Name switch
            {
                "eSpace" => (object?)copy, "swaggerJson" => RestOpenApi.Filtered(plan), "swaggerUri" => new Uri(p["document_path"]!.ToString()),
                "dependencies" => dependencies, _ => parameter.HasDefaultValue ? parameter.DefaultValue : null,
            }).ToArray();
            try { client = create.Invoke(service, arguments) as OutSystems.Model.IObjectSignature; }
            catch (Exception ex) { error = "the REST plugin refused the document: " + Server.Unwrap(ex); return; }
            if (client != null && TypeResolver.Name(client) != clientName) SetString(client, "Name", clientName);
        });
        if (error != null) return Refuse(outcome, "OPENAPI_INVALID", error);
        if (client == null) return Refuse(outcome, IntegrationImport.ImportFailed, "the REST plugin created no client");
        foreach (var operation in operations) ((JsonArray)outcome["imported"]!).Add(operation.Label);
        outcome["client"] = new JsonObject { ["name"] = clientName, ["key"] = client.ObjectKey?.ToString(), ["created"] = true };
        return outcome;
    }

    private static string OperationName(RestOpenApi.Operation operation)
    {
        var source = operation.Id.Length > 0 ? operation.Id : operation.Verb + operation.Path;
        var name = new string(source.Select(c => char.IsLetterOrDigit(c) || c == '_' ? c : '_').ToArray()).Trim('_');
        return name.Length > 0 && char.IsLetter(name[0]) ? char.ToUpperInvariant(name[0]) + name[1..] : "M" + name;
    }

    // ---- shared ---------------------------------------------------------------------------------------------------------

    /// <summary>The PluginWorkspace of the target tab (ServiceStudio.Presenter.PluginWorkspace(aggregator)), or null.</summary>
    private static object? BorrowWorkspace(IAggregatorPresenter aggregator)
    {
        var type = FindType("ServiceStudio.Presenter.PluginWorkspace");
        foreach (var ctor in type?.GetConstructors(Any) ?? [])
            if (ctor.GetParameters() is [{ } only] && only.ParameterType.IsInstanceOfType(aggregator))
                try { return ctor.Invoke([aggregator]); } catch { }
        return null;
    }

    /// <summary>A plugin call that may block on the UI thread: run on a worker while this (UI) thread pumps its jobs.</summary>
    private static T? Worker<T>(Func<T?> action, string what, int timeoutMs = 120000)
    {
        T? result = default; Exception? error = null;
        var task = Task.Run(() => { try { result = action(); } catch (Exception ex) { error = ex; } });
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!task.IsCompleted)
        {
            if (Dispatcher.UIThread.CheckAccess()) Dispatcher.UIThread.RunJobs(DispatcherPriority.Background);
            if (DateTime.UtcNow > deadline) throw new TimeoutException($"{what} did not finish in {timeoutMs / 1000} s");
            Thread.Sleep(25);
        }
        if (error != null) throw error is TargetInvocationException { InnerException: { } inner } ? inner : error;
        return result;
    }

    private static Type? FindType(string fullName) => AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic)
        .Select(a => { try { return a.GetType(fullName); } catch { return null; } }).FirstOrDefault(t => t != null);

    private static IEnumerable<object> Enumerate(object? value) => value is IEnumerable e and not string ? e.Cast<object?>().Where(x => x != null).Cast<object>() : [];
    private static IEnumerable<string> Strings(JsonNode? node) => node is JsonArray a ? a.Select(x => x?.ToString() ?? "").Where(x => x.Length > 0) : [];

    private static object TypedList(List<object> items, Type parameterType)
    {
        var element = parameterType.IsGenericType ? parameterType.GetGenericArguments()[0] : parameterType.GetElementType() ?? typeof(object);
        var list = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(element))!;
        foreach (var item in items) list.Add(item);
        return parameterType.IsArray ? list.GetType().GetMethod("ToArray")!.Invoke(list, null)! : list;
    }

    private static void SetBool(object target, string name, bool value)
    {
        var property = target.GetType().GetProperty(name, Any);
        if (property?.CanWrite == true) property.SetValue(target, value);
    }

    private static void SetString(object target, string name, string value)
    {
        var property = target.GetType().GetProperty(name, Any) ?? target.GetType().GetInterfaces().Select(i => i.GetProperty(name)).FirstOrDefault(x => x != null);
        if (property?.CanWrite == true) property.SetValue(target, value);
    }
}
