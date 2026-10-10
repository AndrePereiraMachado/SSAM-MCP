using System.Collections;
using System.Reflection;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>
/// A JSON sample becomes the body structures exactly as the Studio's own "Add REST API Method" dialog builds them: the REST
/// plugin's public JsonParser.TryParse(sample, dateFormats, out token) and new StructureHelper(client).SetObjectType(param,
/// "&lt;Method&gt;Request|Response", token), which create or reuse the IRestStructure(s), name the attributes and their
/// NameInJSON, and type the parameter (a root array becomes a List). Found by name in the assembly of the client's own type
/// (install-agnostic: no compile-time reference to a plugin of one Studio version). Runs inside the job transaction.
/// </summary>
public static class RestSamples
{
    private const BindingFlags Any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

    /// <summary>Types the parameter from the sample; returns the structures it created or reused (names).</summary>
    public static JsonObject Apply(object client, object parameter, string structureName, string sample)
    {
        var assembly = client.GetType().Assembly;
        var types = SafeTypes(assembly).Concat(AppDomain.CurrentDomain.GetAssemblies().Where(a => a.GetName().Name?.Contains("REST", StringComparison.OrdinalIgnoreCase) == true).SelectMany(SafeTypes)).ToArray();
        var parser = types.FirstOrDefault(t => t.Name == "JsonParser" && t.GetMethods(Any).Any(m => m.Name == "TryParse"))
            ?? throw Missing("JsonParser.TryParse", assembly);
        var helperType = types.FirstOrDefault(t => t.Name == "StructureHelper" && t.GetMethods(Any).Any(m => m.Name == "SetObjectType"))
            ?? throw Missing("StructureHelper.SetObjectType", assembly);
        var tryParse = parser.GetMethods(Any).Where(m => m.Name == "TryParse" && m.GetParameters() is { Length: 3 } p && p[0].ParameterType == typeof(string) && p[2].IsOut)
            .FirstOrDefault() ?? throw Missing("JsonParser.TryParse(string, HashSet<DateFormat>, out ParserToken)", assembly);
        var formatsType = tryParse.GetParameters()[1].ParameterType;
        var formats = Activator.CreateInstance(formatsType);
        var arguments = new object?[] { sample, formats, null };
        var parsed = tryParse.Invoke(tryParse.IsStatic ? null : Activator.CreateInstance(parser), arguments);
        if (parsed is false || arguments[2] == null)
            throw new IntegrationRefusalException("rest", [new IntegrationProblem("REST_SAMPLE_INVALID", "/data/methods", $"rest: the REST plugin could not read the sample of {structureName}", "give a JSON object or array with one example of each field")]);
        var constructor = helperType.GetConstructors(Any).FirstOrDefault(c => c.GetParameters() is [{ } only] && only.ParameterType.IsInstanceOfType(client))
            ?? throw Missing("StructureHelper(ICustomClient)", assembly);
        var helper = constructor.Invoke([client]);
        var setObjectType = helperType.GetMethods(Any).FirstOrDefault(m => m.Name == "SetObjectType" && m.GetParameters() is { Length: 3 } p
                && p[0].ParameterType.IsInstanceOfType(parameter) && p[1].ParameterType == typeof(string) && p[2].ParameterType.IsInstanceOfType(arguments[2]))
            ?? throw Missing("StructureHelper.SetObjectType(ICustomObjectWithType, string, ParserToken)", assembly);
        var before = Structures(client);
        setObjectType.Invoke(helper, [parameter, structureName, arguments[2]]);
        var after = Structures(client);
        return new JsonObject
        {
            ["parameter"] = TypeResolver.Name(parameter), ["structure"] = structureName,
            ["created"] = new JsonArray(after.Except(before, StringComparer.Ordinal).Select(n => (JsonNode)n).ToArray()),
            ["dataType"] = UiCatalog.TypeName(ModelHost.Prop(parameter, "DataType")),
        };
    }

    private static List<string> Structures(object client)
        => ((client as OutSystems.Model.IObjectSignature)?.Children ?? Enumerable.Empty<OutSystems.Model.IObjectSignature>())
            .Where(c => ModelSession.Implements(c, "IRestStructure")).Select(c => TypeResolver.Name(c) ?? "").ToList();

    private static IEnumerable<Type> SafeTypes(Assembly assembly)
    {
        try { return assembly.GetTypes(); }
        catch (ReflectionTypeLoadException ex) { return ex.Types.OfType<Type>(); }
        catch { return []; }
    }

    private static Exception Missing(string member, Assembly assembly)
        => new IntegrationRefusalException("rest", [new IntegrationProblem("INTEGRATION_IMPORTER_NOT_FOUND", "/data/methods",
            $"rest: the REST plugin of this Studio ({assembly.GetName().Name} {assembly.GetName().Version}) has no {member}, which turns a sample into structures",
            "declare the structures explicitly (\"structures\" and response {\"structure\": \"<Name>\"}) instead of a sample")]);
}
