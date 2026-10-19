using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using OutSystems.Model.Data;
using OutSystems.Model.Enumerations;
using Xunit;

namespace Anvil.Tests.Odc;

public class DataIndexMetadataTests
{
    public class Stub : DispatchProxy
    {
        public Dictionary<string, object?> Values = [];
        protected override object? Invoke(MethodInfo? method, object?[]? args) => Values.TryGetValue(method!.Name, out var value) ? value : null;
    }
    private static T Proxy<T>(params (string Name, object? Value)[] values) where T : class
    {
        var result = DispatchProxy.Create<T, Stub>();
        ((Stub)(object)result).Values = values.ToDictionary(v => "get_" + v.Name, v => v.Value);
        return result;
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void UniqueIndexesNameTheirCompositeAttributesForOwnAndReferencedEntities(bool own)
    {
        var code = Proxy<IEntityAttributeSignature>(("DisplayName", "Code"));
        var region = Proxy<IEntityAttributeSignature>(("DisplayName", "Region"));
        var parts = new[] { Proxy<IEntityIndexAttributeSignature>(("Attribute", code)), Proxy<IEntityIndexAttributeSignature>(("Attribute", region)) };
        var unique = Proxy<IEntityIndexSignature>(("Name", "Code_Region"), ("Unique", true), ("IndexAttributes", parts));
        var ordinary = Proxy<IEntityIndexSignature>(("Name", "Ordinary"), ("Unique", false), ("IndexAttributes", parts));
        IEntitySignature entity = own ? Proxy<IServerEntity>(("Indexes", new[] { unique, ordinary })) : Proxy<IServerEntitySignature>(("Indexes", new[] { unique, ordinary }));
        var helper = typeof(DataIndexMetadataTests).Assembly.GetType("BridgeDataIndexes");
        Assert.NotNull(helper);
        var values = helper.GetMethod("Read", BindingFlags.Static | BindingFlags.Public)!.Invoke(null, [entity]);
        var array = JsonSerializer.SerializeToNode(values)!.AsArray();
        Assert.Single(array);
        Assert.Equal("Code_Region", array[0]!["name"]!.ToString());
        Assert.True(array[0]!["unique"]!.GetValue<bool>());
        Assert.Equal(new[] { "Code", "Region" }, array[0]!["attributes"]!.AsArray().Select(a => a!.ToString()));
    }

    // The identifier's auto-number flag comes from IEntityAttributeSignature.IsAutoNumber, which the own entity's
    // attribute (IEntityAttribute) and the producer signature of a referenced entity both expose.
    [Theory]
    [InlineData(true, AutoNumber.Yes, true)]
    [InlineData(true, AutoNumber.No, false)]
    [InlineData(true, AutoNumber.YesIfEmpty, true)]
    [InlineData(false, AutoNumber.Yes, true)]
    [InlineData(false, AutoNumber.No, false)]
    [InlineData(false, AutoNumber.YesIfEmpty, true)]
    public void IdentifierAutoNumberFollowsTheModelForOwnAndReferencedEntities(bool own, AutoNumber flag, bool expected)
    {
        IEntityAttributeSignature identifier = own
            ? Proxy<IEntityAttribute>(("Name", "Id"), ("IsAutoNumber", flag))
            : Proxy<IEntityAttributeSignature>(("DisplayName", "Id"), ("IsAutoNumber", flag));
        Assert.Equal(expected, IdentifierAutoNumber(Entity(own, identifier)));
    }

    // Unknown, never an exception: no identifier, or a flag the model cannot give (here the getter fails).
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void IdentifierAutoNumberIsUnknownWhenTheModelCannotSay(bool own)
    {
        Assert.Null(IdentifierAutoNumber(Entity(own, null)));
        Assert.Null(IdentifierAutoNumber(Entity(own, Proxy<IEntityAttributeSignature>(("DisplayName", "Id")))));
    }

    private static IEntitySignature Entity(bool own, IEntityAttributeSignature? identifier) => own
        ? Proxy<IServerEntity>(("IdentifierAttribute", identifier), ("Indexes", Array.Empty<IEntityIndexSignature>()))
        : Proxy<IServerEntitySignature>(("IdentifierAttribute", identifier), ("Indexes", Array.Empty<IEntityIndexSignature>()));

    private static bool? IdentifierAutoNumber(IEntitySignature entity)
    {
        var helper = typeof(DataIndexMetadataTests).Assembly.GetType("BridgeDataIndexes");
        Assert.NotNull(helper);
        var method = helper.GetMethod("IdentifierAutoNumber", BindingFlags.Static | BindingFlags.Public, [typeof(IEntitySignature)]);
        Assert.NotNull(method);
        Assert.Equal(typeof(bool?), method.ReturnType);
        return (bool?)method.Invoke(null, [entity]);
    }
}
