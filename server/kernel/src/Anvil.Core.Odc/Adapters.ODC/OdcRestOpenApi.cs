using System.Collections;
using System.Reflection;
using System.Runtime.CompilerServices;
using OutSystems.Model;

namespace Anvil.Core;

/// <summary>
/// The ODC lane's headless OpenAPI import (op `rest` with `openapi`), registered as RestOpenApi.Importer by this file's
/// module initializer (only Anvil.Core.Odc compiles Adapters.ODC; no IStudioRuntime change). It is the platform's own
/// importer, found by name in the loaded REST plugin: ModelServices.GetPluginService&lt;IRestPluginService&gt;().
/// A new client: CreateRestClientFromSwagger on the document reduced to the chosen operations (RestOpenApi.Filtered), the
/// bundled external files passed as its dependencies, and a restServiceOverride (IPluginApiRestService) that refuses every
/// HTTP call: nothing ever leaves the machine; an attempt is OPENAPI_NETWORK_REFUSED naming the URI. An existing client:
/// GetSwaggerInfo, ToImport only on the chosen operations, then ISwaggerInfo.Create with the client (incremental), allowed
/// only for a document without external references (GetSwaggerInfo has no dependency or override parameter).
/// </summary>
internal static class OdcRestOpenApi
{
    private const BindingFlags Any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

#pragma warning disable CA2255 // the registration is the point: Kernel/ reaches the ODC importer without referencing ODC types
    [ModuleInitializer]
    internal static void Register() => RestOpenApi.Importer = Import;
#pragma warning restore CA2255

    internal static RestOpenApi.ImportResult Import(object espace, RestOpenApi.ImportRequest request)
    {
        var refused = new List<string>();
        var problems = new List<IntegrationProblem>();
        RestOpenApi.ImportResult Fail(string code, string message, string? fix) => new(null, false, [], [], [], [new(code, "/data/openapi", message, fix)], refused.Count);
        var serviceType = FindType("ServiceStudio.Plugin.REST.IRestPluginService");
        var services = typeof(IESpace).Assembly.GetType("OutSystems.Model.Services")?.GetProperty("ModelServices", Any)?.GetValue(null);
        var getService = services?.GetType().GetInterfaces().Append(services.GetType()).Select(t => t.GetMethod("GetPluginService")).FirstOrDefault(m => m is { IsGenericMethodDefinition: true });
        var service = serviceType != null && getService != null ? getService.MakeGenericMethod(serviceType).Invoke(services, null) : null;
        if (service == null)
            return Fail(IntegrationImport.ImporterNotFound, $"rest: the REST plugin of this ODC Studio ({StudioAdapter.Runtime.IdeVersion}) has no IRestPluginService reachable through ModelServices.GetPluginService",
                "declare the methods explicitly (op rest without openapi)");
        var es = (IESpace)espace;
        var existing = ((IObjectSignature)es).Children.OfType<IObjectSignature>()
            .FirstOrDefault(c => ModelSession.Implements(c, "IRestClient") && string.Equals(TypeResolver.Name(c), request.ClientName, StringComparison.OrdinalIgnoreCase));
        var filtered = RestOpenApi.Filtered(request.Plan);
        var uri = request.Plan.Source is { } source && Uri.TryCreate(source, UriKind.Absolute, out var sourceUri) ? sourceUri : new Uri(request.Plan.DocumentPath);
        var labels = request.Plan.Selected.Select(o => o.Label).ToList();
        try
        {
            if (existing == null)
            {
                var create = serviceType!.GetMethods().Where(m => m.Name == "CreateRestClientFromSwagger" && m.GetParameters().Any(p => p.Name == "dependencies") && m.GetParameters().Any(p => p.Name == "restServiceOverride")).FirstOrDefault();
                if (create == null) return Fail(IntegrationImport.ImporterNotFound, "rest: IRestPluginService.CreateRestClientFromSwagger(eSpace, swaggerJson, swaggerUri, dependencies, key, restServiceOverride) is not in this ODC Studio", "declare the methods explicitly (op rest without openapi)");
                var overrideType = create.GetParameters().First(p => p.Name == "restServiceOverride").ParameterType;
                var proxy = RefusingRestService.For(overrideType, refused);
                var dependencies = request.Plan.External.ToDictionary(d => Uri.TryCreate(d.Uri, UriKind.Absolute, out var absolute) ? absolute : new Uri(uri, d.Uri), d => File.ReadAllText(d.Path));
                var arguments = create.GetParameters().Select(p => p.Name switch
                {
                    "eSpace" => (object?)es, "swaggerJson" => filtered, "swaggerUri" => uri, "dependencies" => dependencies, "restServiceOverride" => proxy,
                    _ => p.HasDefaultValue ? p.DefaultValue : null,
                }).ToArray();
                var client = create.Invoke(service, arguments) as IObjectSignature
                    ?? throw new InvalidOperationException("CreateRestClientFromSwagger returned no client");
                if (refused.Count > 0) return Network();
                var icons = ((RefusingRestService)proxy).Icons.Distinct().Select(i => "the importer asked for the API icon " + i + "; answered 404 locally (no network)").ToList();
                return new(client.ObjectKey?.ToString(), true, labels, [], icons, [], refused.Count);
            }
            if (request.Plan.External.Count > 0 || RestOpenApi.ExternalReferences(System.Text.Json.Nodes.JsonNode.Parse(request.Plan.Text)).Any())
                return Fail("OPENAPI_NETWORK_REFUSED", $"rest: adding operations to the existing client '{request.ClientName}' reads the document with GetSwaggerInfo, which would resolve its external references over the network",
                    "import into a new client name (the bundled files are used there), or bundle the references into one document");
            var info = serviceType!.GetMethod("GetSwaggerInfo")!.Invoke(service, [es, filtered, uri])
                ?? throw new InvalidOperationException("GetSwaggerInfo returned nothing");
            if (Prop(info, "IsValid") is false)
                return Fail("OPENAPI_INVALID", "rest: the REST plugin refuses the document: " + Prop(info, "ErrorStatus"), "fix the document as the plugin says");
            var have = existing.Children.OfType<IObjectSignature>().Where(c => ModelSession.Implements(c, "IRestAction")).Select(c => TypeResolver.Name(c) ?? "").ToHashSet(StringComparer.OrdinalIgnoreCase);
            var skipped = new List<string>(); var imported = new List<string>();
            foreach (var method in ((IEnumerable?)Prop(info, "Methods"))?.Cast<object>() ?? [])
            {
                var id = Prop(method, "Id")?.ToString() ?? ""; var path = Prop(method, "Path")?.ToString() ?? ""; var verb = Prop(method, "HTTPMethod")?.ToString()?.ToLowerInvariant() ?? "";
                var chosen = request.Plan.Selected.FirstOrDefault(o => o.Id.Length > 0 && o.Id == id || o.Path == path && o.Verb == verb);
                var name = Prop(method, "Name")?.ToString() ?? "";
                var import = chosen != null && !have.Contains(name);
                method.GetType().GetProperty("ToImport", Any)?.SetValue(method, import);
                if (chosen != null) (import ? imported : skipped).Add(chosen.Label);
            }
            if (imported.Count > 0)
            {
                var createFunc = Prop(info, "Create") as Delegate ?? throw new InvalidOperationException("ISwaggerInfo.Create is not available");
                var parameters = createFunc.Method.GetParameters();
                var values = parameters.Select(p => p.ParameterType.IsInstanceOfType(es) ? es : p.ParameterType.IsInstanceOfType(info) ? info
                    : p.ParameterType == typeof(string) ? request.ClientName : p.ParameterType.IsInstanceOfType(existing) ? existing : (object?)null).ToArray();
                createFunc.DynamicInvoke(values);
            }
            if (refused.Count > 0) return Network();
            return new(existing.ObjectKey?.ToString(), false, imported, skipped, [], [], refused.Count);
        }
        catch (Exception ex) when (refused.Count > 0) { _ = ex; return Network(); }
        catch (TargetInvocationException ex) when (ex.InnerException != null)
        {
            return Fail("OPENAPI_INVALID", "rest: the REST plugin refused the document: " + ex.InnerException.GetType().Name + ": " + ex.InnerException.Message, "fix the document as the plugin says, or declare the methods explicitly");
        }

        RestOpenApi.ImportResult Network() => Fail("OPENAPI_NETWORK_REFUSED", "rest: the import tried to fetch " + string.Join(", ", refused.Distinct()) + " and SSAM refuses every network call of the import",
            "bundle those documents: \"external\": {\"<uri>\": {\"path\": \"<absolute>\", \"sha256\": \"<hex>\"}} (studio_deliver pins them)");
    }

    private static object? Prop(object o, string name) => ModelHost.Prop(o, name);

    private static Type? FindType(string fullName) => AppDomain.CurrentDomain.GetAssemblies().Where(a => !a.IsDynamic)
        .Select(a => { try { return a.GetType(fullName); } catch { return null; } }).FirstOrDefault(t => t != null);
}

/// <summary>An IPluginApiRestService whose every call is refused and recorded (the URI it asked for): the import's only
/// network path, closed.</summary>
public class RefusingRestService : DispatchProxy
{
    private List<string>? _refused;

    public static object For(Type serviceInterface, List<string> refused)
    {
        var create = typeof(DispatchProxy).GetMethods(BindingFlags.Public | BindingFlags.Static).First(m => m.Name == "Create" && m.IsGenericMethodDefinition && m.GetGenericArguments().Length == 2);
        var proxy = (RefusingRestService)create.MakeGenericMethod(serviceInterface, typeof(RefusingRestService)).Invoke(null, null)!;
        proxy._refused = refused;
        return proxy;
    }

    /// <summary>The icons the importer looks for at the API's host (cosmetic): answered 404 here, never fetched.</summary>
    public List<string> Icons { get; } = new();

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        var request = args?.FirstOrDefault();
        var uri = request == null ? "?" : (ModelHost.Prop(request, "Url") ?? ModelHost.Prop(request, "Uri") ?? ModelHost.Prop(request, "RequestUri") ?? request)?.ToString() ?? "?";
        // The plugin asks the API's host for its favicon to decorate the client: no network, a 404 answered locally.
        if (targetMethod?.ReturnType == typeof(HttpResponseMessage) && IsIcon(uri))
        {
            Icons.Add(uri);
            return new HttpResponseMessage(System.Net.HttpStatusCode.NotFound);
        }
        _refused?.Add(uri);
        throw new HttpRequestException($"SSAM refuses network calls of the OpenAPI import ({targetMethod?.Name} {uri})");
    }

    private static bool IsIcon(string uri)
    {
        var path = Uri.TryCreate(uri, UriKind.Absolute, out var absolute) ? absolute.AbsolutePath : uri;
        return path.Contains("favicon", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".ico", StringComparison.OrdinalIgnoreCase);
    }
}
