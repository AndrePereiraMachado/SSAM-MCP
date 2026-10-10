// Shared by Anvil.Xif (net8, tests) and Anvil.Xif.Engine (net472, x86): plain C# that both runtimes compile.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace Anvil.Xif;

/// <summary>
/// What the headless engine needs from the installed Integration Studio, by type and member name (the surface the
/// Integration Studio host of the 2026-09-05 investigation used, read again from the installed 11.14 assemblies). Missing
/// lists every type or member the installation lacks, so XIF_ENGINE_UNAVAILABLE names all of them at once. Pure: the types
/// come through resolve, so the tests pass fake types and never touch a real installation.
/// </summary>
public static class XifEngineProbe
{
    public const string Core = "OutSystems.IntegrationStudio.Core";
    public const string ModelNs = "OutSystems.IntegrationStudio.Core.Common.Model";

    /// <summary>Type full name -> members it must expose. ".ctor(A, B)" = a public constructor with exactly these parameter
    /// types (short names): the engine calls that one, so a constructor of another shape is reported as missing.</summary>
    public static readonly KeyValuePair<string, string[]>[] Expected =
    {
        Entry("OutSystems.IntegrationStudio.Core.Aggregator.Aggregator", ".ctor(Boolean)", "AddPlugin", "ProjectName", "ProjectCreateBlank", "ProjectLoad", "ProjectVerify", "ProjectSave", "ProjectClose", "IProject"),
        Entry(ModelNs + ".Project.IProject", "Name", "Key", "Hash", "Description", "ITechnologies", "AddITechnology", "UnpackLocation", "IResources", "AddIResource", "RemoveIResource", "XifActivationCode"),
        Entry(ModelNs + ".XIF.Upgrader", ".ctor(String)", "XmlDocument"),
        Entry(ModelNs + ".Report", "Type", "Id", "Detail"),
        Entry("OutSystems.IntegrationStudio.Core.Common.IPlugin", "Key", "CreateITechnology", "IsThisYours"),
        Entry(ModelNs + ".Project.Technology.ITechnology", "PluginKey", "IActions", "CreateIAction", "AddIAction", "RemoveIAction", "IStructures", "CreateIStructure", "AddIStructure", "RemoveIStructure"),
        Entry(ModelNs + ".Project.Technology.Action.IAction", "Name", "Key", "Description", "Function", "Body", "IParameters", "CreateIParameter", "AddIParameter", "RemoveIParameter", "MoveIParameter"),
        Entry(ModelNs + ".Project.Technology.Action.IParameter", "Name", "Key", "Input", "DataType", "IRecordType", "Mandatory", "DefaultValue", "Description"),
        Entry(ModelNs + ".Project.Technology.Structure.IStructure", "Name", "Key", "Description", "IAttributes", "CreateIAttribute", "AddIAttribute", "RemoveIAttribute"),
        Entry(ModelNs + ".Project.Technology.Structure.IAttribute", "Name", "Key", "DataType", "IRecordType", "Mandatory", "Length", "Decimals", "DefaultValue", "Description"),
        Entry(ModelNs + ".Project.Technology.Type.RecordType.RecordType", ".ctor()", "AddRecord"),
        Entry(ModelNs + ".Project.Resource.Resource", ".ctor()", "Name", "Path", "Data", "CompileAction", "CodeReference", "LastModified", "FullPath", "Unpack"),
        Entry(ModelNs + ".Project.Resource.ResourceCompileAction"),
        Entry("OutSystems.IntegrationStudio.Core.Preferences.Preferences", "RunningTests"),
        // The two versions of the Handshake: ProductVersion, then LastUpgradeVersion (WebServicesFacade.Handshake).
        Entry("OutSystems.IntegrationStudio.Core.Config", "ProductVersion", "LastUpgradeVersion"),
        Entry("OutSystems.IntegrationStudio.Plugin.UserDefined.Core.Plugin", ".ctor(IAggregator)"),
        Entry("OutSystems.IntegrationStudio.Plugin.Net.Core.Plugin", ".ctor(IAggregator)"),
    };

    /// <summary>The constructor every data type needs: the engine creates one per parameter or attribute.</summary>
    public const string DataTypeConstructor = ".ctor()";

    /// <summary>The data types an extension parameter or attribute can have (namespace Technology.Type.DataType).</summary>
    public static readonly string[] DataTypes =
        { "Text", "Integer", "LongInteger", "Decimal", "Boolean", "Date", "DateTime", "Time", "Currency", "Email", "PhoneNumber", "BinaryData", "Object", "Record", "RecordList" };

    public static string DataType(string name) => ModelNs + ".Project.Technology.Type.DataType." + name;

    private static KeyValuePair<string, string[]> Entry(string type, params string[] members) => new KeyValuePair<string, string[]>(type, members);

    /// <summary>Every missing type or member, as "Type" or "Type.Member" (short type names), in a stable order.</summary>
    public static List<string> Missing(Func<string, Type?> resolve)
    {
        var missing = new List<string>();
        foreach (var entry in Expected)
        {
            var type = Safe(() => resolve(entry.Key));
            var shortName = entry.Key.Substring(entry.Key.LastIndexOf('.') + 1);
            if (entry.Key.EndsWith(".Plugin", StringComparison.Ordinal)) shortName = entry.Key;
            if (type == null) { missing.Add(shortName); continue; }
            foreach (var member in entry.Value)
                if (!Has(type, member)) missing.Add(shortName + (IsConstructor(member) ? member : "." + member));
        }
        foreach (var name in DataTypes)
        {
            var type = Safe(() => resolve(DataType(name)));
            if (type == null) missing.Add("DataType." + name);
            else if (!Has(type, DataTypeConstructor)) missing.Add("DataType." + name + DataTypeConstructor);
        }
        return missing;
    }

    private static bool IsConstructor(string member) => member.StartsWith(".ctor(", StringComparison.Ordinal);

    /// <summary>The parameter types of ".ctor(A, B)" as short names (empty for ".ctor()").</summary>
    public static string[] ConstructorParameters(string member) =>
        member.Substring(6, member.Length - 7).Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries).Select(p => p.Trim()).ToArray();

    private static Type? Safe(Func<Type?> resolve)
    {
        try { return resolve(); }
        catch (Exception) { return null; }
    }

    private static bool Has(Type type, string member)
    {
        const BindingFlags flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy;
        try
        {
            if (IsConstructor(member))
            {
                var wanted = ConstructorParameters(member);
                return type.GetConstructors().Any(c => c.GetParameters().Select(p => p.ParameterType.Name).SequenceEqual(wanted, StringComparer.Ordinal));
            }
            if (type.GetMember(member, flags).Length > 0) return true;
            // Interface members are declared on the base interfaces.
            return type.IsInterface && type.GetInterfaces().Any(i => i.GetMember(member, flags).Length > 0);
        }
        catch (Exception) { return false; }
    }
}
