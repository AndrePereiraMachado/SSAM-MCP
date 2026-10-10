using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class NativeDependencyCatalogTests
{
    [Fact]
    public void AliasesKeepQualifiedSourceSymbolsAndResolveTheWholeRequirement()
    {
        var fixture = new Fixture();
        var first = fixture.Binding;
        var alias = first with { Requirement = first.Requirement with { SourceSymbol = "other.html::Page::search" } };
        var catalog = new NativeDependencyCatalog(fixture.Producers, [first, alias]);
        Assert.Equal(first.NativeReference, catalog.Resolve(alias.Requirement).NativeReference);
        Assert.NotSame(first, catalog.Resolve(first.Requirement));
        Assert.Throws<ArgumentException>(() => catalog.Resolve(first.Requirement with { Kind = NativeDependencyKind.ClientAction }));
        Assert.Throws<ArgumentException>(() => catalog.Resolve(first.Requirement with { ProducerName = "AnotherProducer" }));
        Assert.Throws<ArgumentException>(() => catalog.Resolve(first.Requirement with { OriginalElementPath = "anotherAction" }));
        Assert.Throws<KeyNotFoundException>(() => catalog.Resolve(first.Requirement with { SourceSymbol = "missing.html::search" }));
    }

    [Fact]
    public void CyclesAndIdentifiersPreserveOpaqueNativeIdentities()
    {
        var fixture = new Fixture();
        var catalog = fixture.Create();
        var binding = Assert.Single(catalog.Bindings);
        var product = binding.ReachableTypes[Fixture.ProductKey];
        Assert.Equal("opaque-native-producer*product", product.GlobalKey);
        Assert.IsType<NativeRecord>(Assert.IsType<NativeList>(product.OrderedFields[1].Type).Element);
        var id = Assert.IsType<NativeIdentifier>(product.OrderedFields[2].Type);
        Assert.Equal(Fixture.EntityKey, id.TargetGlobalKey); Assert.Equal("Long Integer", id.StoragePrimitive);
        Assert.Equal("Entity", binding.ReachableTypes[id.TargetGlobalKey].NativeKind.ToString());
        Assert.Equal(catalog.Fingerprint, NativeDependencyCatalog.FromJson(catalog.ToJson()).Fingerprint);
    }

    [Fact]
    public void HomonymousTypesFromDifferentProducersRemainDistinct()
    {
        var fixture = new Fixture();
        var otherKey = "another-opaque-global-key";
        var original = fixture.Binding.ReachableTypes[Fixture.ProductKey];
        var other = original with { GlobalKey = otherKey, NativeReference = "IStructureSignature:@producer-one/other-product",
            OrderedFields = [new("Label", new NativePrimitive("Text"), "other-label")] };
        var types = fixture.Binding.ReachableTypes.ToDictionary(p => p.Key, p => p.Value);
        types.Add(otherKey, other);
        var binding = fixture.Binding with { ReachableTypes = types,
            OrderedOutputs = [new("First", new NativeList(new NativeRecord(Fixture.ProductKey))), new("Second", new NativeList(new NativeRecord(otherKey)))] };
        var catalog = new NativeDependencyCatalog(fixture.Producers, [binding]);
        var outputs = catalog.Bindings[0].OrderedOutputs;
        Assert.Equal(original.Name, other.Name);
        Assert.NotEqual(Assert.IsType<NativeRecord>(Assert.IsType<NativeList>(outputs[0].Type).Element).GlobalKey,
            Assert.IsType<NativeRecord>(Assert.IsType<NativeList>(outputs[1].Type).Element).GlobalKey);
    }

    [Fact]
    public void TypeImportRootsItsGraphByNativeReferenceWithoutGuessingGlobalKeySyntax()
    {
        var fixture = new Fixture();
        var binding = fixture.Binding with { Requirement = new("types.html::Product", NativeDependencyKind.Type, "Types", "Product"),
            ProducerBinding = "Types", OriginalElementKey = "product", NativeReference = "IStructureSignature:@producer-two/product",
            OrderedInputs = [], OrderedOutputs = [] };
        var catalog = new NativeDependencyCatalog(fixture.Producers, [binding]);
        Assert.Equal(2, Assert.Single(catalog.Bindings).ReachableTypes.Count);
        Assert.Equal(catalog.Fingerprint, NativeDependencyCatalog.FromJson(catalog.ToJson()).Fingerprint);
    }

    [Fact]
    public void EventsContributeTheirParameterTypesToClosureAndPreservePlaceholders()
    {
        var fixture = new Fixture();
        var binding = fixture.Block();
        var catalog = new NativeDependencyCatalog(fixture.Producers, [binding]);
        Assert.True(catalog.Bindings[0].Events[0].Mandatory);
        Assert.Equal("event-selected", catalog.Bindings[0].Events[0].OriginalKey);
        Assert.Equal(new[] { "Body", "Footer" }, catalog.Bindings[0].Placeholders.Select(p => p.Name));
        Assert.Equal(catalog.Fingerprint, NativeDependencyCatalog.FromJson(catalog.ToJson()).Fingerprint);
    }

    [Theory]
    [InlineData("missing-root")]
    [InlineData("missing-nested")]
    [InlineData("wrong-dictionary-key")]
    [InlineData("identifier-to-structure")]
    [InlineData("identifier-storage")]
    [InlineData("unknown-type-producer")]
    [InlineData("unreachable")]
    [InlineData("wrong-type-kind")]
    public void InvalidTypeGraphsCannotBecomeACatalog(string fault)
    {
        var fixture = new Fixture(); var binding = fixture.Binding;
        var types = binding.ReachableTypes.ToDictionary(p => p.Key, p => p.Value);
        switch (fault)
        {
            case "missing-root": types.Remove(Fixture.ProductKey); break;
            case "missing-nested": types.Remove(Fixture.EntityKey); break;
            case "wrong-dictionary-key": var type = types[Fixture.ProductKey]; types.Remove(Fixture.ProductKey); types.Add("wrong", type); break;
            case "identifier-to-structure": binding = binding with { OrderedInputs = [new("Id", new NativeIdentifier(Fixture.ProductKey, "Long Integer"))] }; break;
            case "identifier-storage": binding = binding with { OrderedInputs = [new("Id", new NativeIdentifier(Fixture.EntityKey, "Integer"))] }; break;
            case "unknown-type-producer": types[Fixture.EntityKey] = types[Fixture.EntityKey] with { NativeReference = "IEntitySignature:@absent/entity" }; break;
            case "unreachable": types.Add("extra", new("extra", "Extra", NativeRecordKind.Structure, "IStructureSignature:@producer-two/extra", [])); break;
            case "wrong-type-kind": types[Fixture.EntityKey] = types[Fixture.EntityKey] with { NativeReference = "IStructureSignature:@producer-two/entity" }; break;
        }
        Assert.Throws<ArgumentException>(() => new NativeDependencyCatalog(fixture.Producers, [binding with { ReachableTypes = types }]));
    }

    [Theory]
    [InlineData("unqualified-symbol")]
    [InlineData("wrong-producer")]
    [InlineData("unknown-producer-binding")]
    [InlineData("wrong-key")]
    [InlineData("wrong-kind")]
    [InlineData("wrong-path")]
    [InlineData("duplicate-parameter")]
    [InlineData("duplicate-field")]
    [InlineData("events-on-action")]
    [InlineData("undefined-kind")]
    [InlineData("unknown-primitive")]
    public void InvalidRequirementsAndSignaturesAreRejected(string fault)
    {
        var fixture = new Fixture(); var binding = fixture.Binding;
        switch (fault)
        {
            case "unqualified-symbol": binding = binding with { Requirement = binding.Requirement with { SourceSymbol = "search" } }; break;
            case "wrong-producer": binding = binding with { Requirement = binding.Requirement with { ProducerName = "Types" } }; break;
            case "unknown-producer-binding": binding = binding with { ProducerBinding = "Missing" }; break;
            case "wrong-key": binding = binding with { OriginalElementKey = "another" }; break;
            case "wrong-kind": binding = binding with { NativeReference = "IClientActionSignature:@producer-one/search" }; break;
            case "wrong-path": binding = binding with { Requirement = binding.Requirement with { OriginalElementPath = "Flow/search" } }; break;
            case "duplicate-parameter": binding = binding with { OrderedInputs = [new("Query", new NativePrimitive("Text")), new("query", new NativePrimitive("Text"))] }; break;
            case "duplicate-field": var types = binding.ReachableTypes.ToDictionary(p => p.Key, p => p.Value); var product = types[Fixture.ProductKey];
                types[Fixture.ProductKey] = product with { OrderedFields = product.OrderedFields.Concat([product.OrderedFields[0]]).ToArray() }; binding = binding with { ReachableTypes = types }; break;
            case "events-on-action": binding = binding with { Events = [new("Changed", "changed", false, [])] }; break;
            case "undefined-kind": binding = binding with { Requirement = binding.Requirement with { Kind = (NativeDependencyKind)123 } }; break;
            case "unknown-primitive": binding = binding with { OrderedInputs = [new("Query", new NativePrimitive("number"))] }; break;
        }
        Assert.Throws<ArgumentException>(() => new NativeDependencyCatalog(fixture.Producers, [binding]));
    }

    [Theory]
    [InlineData("duplicate-source")]
    [InlineData("same-export-different-key")]
    [InlineData("same-key-different-path")]
    [InlineData("same-target-different-abi")]
    [InlineData("same-global-different-schema")]
    [InlineData("same-native-different-global")]
    public void ConflictingAliasesAndIdentitiesAreRejected(string fault)
    {
        var fixture = new Fixture(); var first = fixture.Binding;
        var other = first with { Requirement = first.Requirement with { SourceSymbol = "second.html::search" } };
        switch (fault)
        {
            case "duplicate-source": other = first; break;
            case "same-export-different-key": other = other with { OriginalElementKey = "different", NativeReference = "IServerActionSignature:@producer-one/different" }; break;
            case "same-key-different-path": other = other with { Requirement = other.Requirement with { OriginalElementPath = "different" } }; break;
            case "same-target-different-abi": other = other with { OrderedInputs = [new("Query", new NativePrimitive("Long Integer"))] }; break;
            case "same-global-different-schema":
            case "same-native-different-global":
                other = other with { OriginalElementKey = "other", NativeReference = "IServerActionSignature:@producer-one/other",
                    Requirement = other.Requirement with { OriginalElementPath = "other" } };
                var types = first.ReachableTypes.ToDictionary(p => p.Key, p => p.Value);
                if (fault == "same-global-different-schema") types[Fixture.ProductKey] = types[Fixture.ProductKey] with { Name = "Different" };
                else { types.Remove(Fixture.ProductKey); types.Add("different-global", first.ReachableTypes[Fixture.ProductKey] with { GlobalKey = "different-global" }); }
                other = other with { ReachableTypes = types }; break;
        }
        Assert.Throws<ArgumentException>(() => new NativeDependencyCatalog(fixture.Producers, [first, other]));
    }

    [Theory]
    [InlineData("environment")]
    [InlineData("duplicate-identity")]
    [InlineData("duplicate-name")]
    [InlineData("version")]
    [InlineData("signature-hash")]
    [InlineData("signature-file-hash")]
    [InlineData("reference-kind")]
    [InlineData("module-kind")]
    public void InvalidProvenanceIsRejectedWithoutAcquisition(string fault)
    {
        var fixture = new Fixture(); var producer = fixture.Producers[1];
        producer = fault switch {
            "environment" => producer with { Environment = "another.invalid" },
            "duplicate-identity" => producer with { ProducerKey = fixture.Producers[0].ProducerKey },
            "duplicate-name" => producer with { ProducerName = fixture.Producers[0].ProducerName.ToUpperInvariant() },
            "version" => producer with { PublishedVersion = 0 },
            "signature-hash" => producer with { SignatureHash = "wrong" },
            "signature-file-hash" => producer with { SignatureFileSha256 = "wrong" },
            "reference-kind" => producer with { ReferenceKind = "Service" },
            "module-kind" => producer with { ModuleType = "Unknown" },
            _ => producer
        };
        Assert.Throws<ArgumentException>(() => new NativeDependencyCatalog([fixture.Producers[0], producer], [fixture.Binding]));
    }

    [Fact]
    public void AuxiliarySignatureProducersAreAllowedAndTextIdentifiersRemainText()
    {
        var fixture = new Fixture();
        var auxiliary = fixture.Producers[0] with { Binding = "System", ProducerKey = "system", ProducerName = "(System)", ReferenceKind = "Extension", ModuleType = "Unknown" };
        var types = fixture.Binding.ReachableTypes.ToDictionary(p => p.Key, p => p.Value);
        types[Fixture.EntityKey] = types[Fixture.EntityKey] with { IdentifierStoragePrimitive = "Text" };
        var product = types[Fixture.ProductKey];
        types[Fixture.ProductKey] = product with { OrderedFields = product.OrderedFields.Select(f => f.Type is NativeIdentifier
            ? f with { Type = new NativeIdentifier(Fixture.EntityKey, "Text") } : f).ToArray() };
        var catalog = new NativeDependencyCatalog(fixture.Producers.Append(auxiliary), [fixture.Binding with { ReachableTypes = types }]);
        Assert.Equal(3, catalog.Producers.Count);
        Assert.Equal("Text", Assert.IsType<NativeIdentifier>(catalog.Bindings[0].ReachableTypes[Fixture.ProductKey].OrderedFields[2].Type).StoragePrimitive);
    }

    [Fact]
    public void CatalogOwnsAllNestedInputsAndReturnsDefensiveAbiAndJsonCopies()
    {
        var fixture = new Fixture(); var binding = fixture.Block();
        var fields = binding.ReachableTypes[Fixture.ProductKey].OrderedFields.ToList();
        var types = binding.ReachableTypes.ToDictionary(p => p.Key, p => p.Value);
        types[Fixture.ProductKey] = types[Fixture.ProductKey] with { OrderedFields = fields };
        var eventInputs = binding.Events[0].OrderedInputs.ToList(); var events = binding.Events.ToList();
        events[0] = events[0] with { OrderedInputs = eventInputs }; var placeholders = binding.Placeholders.ToList();
        var payload = new JsonObject { ["nested"] = new JsonObject { ["version"] = 3 }, ["arbitrary-key"] = new JsonArray(1, 2) };
        var abi = new NativeSourceAbi("csharp.presence", 1, payload);
        binding = binding with { ReachableTypes = types, Events = events, Placeholders = placeholders, SourceAbi = abi };
        var producers = fixture.Producers.ToList(); var bindings = new List<NativeDependencyBinding> { binding };
        var catalog = new NativeDependencyCatalog(producers, bindings); var fingerprint = catalog.Fingerprint;
        producers.Clear(); bindings.Clear(); fields.Clear(); types.Clear(); eventInputs.Clear(); events.Clear(); placeholders.Clear();
        payload["nested"]!["version"] = 99; abi.Payload["nested"]!["version"] = 100;
        var frozen = Assert.Single(catalog.Bindings);
        frozen.SourceAbi!.Payload["nested"]!["version"] = 101;
        catalog.ToJson()["bindings"]![0]!["events"]!.AsArray().Clear();
        Assert.Equal(fingerprint, catalog.Fingerprint);
        Assert.Throws<NotSupportedException>(() => ((IList<NativeDependencyBinding>)catalog.Bindings).Clear());
        Assert.Throws<NotSupportedException>(() => ((IDictionary<string, NativeRecordDefinition>)frozen.ReachableTypes).Clear());
        Assert.Throws<NotSupportedException>(() => ((IList<NativeField>)frozen.ReachableTypes[Fixture.ProductKey].OrderedFields).Clear());
        Assert.Throws<NotSupportedException>(() => ((IList<NativeParameter>)frozen.Events[0].OrderedInputs).Clear());
        Assert.Equal(fingerprint, NativeDependencyCatalog.FromJson(catalog.ToJson()).Fingerprint);
    }

    [Fact]
    public void CanonicalSetsAndAbiObjectsPreserveOrderedSignatureArraysAndDefaults()
    {
        var fixture = new Fixture(); var binding = fixture.Block();
        binding = binding with { OrderedInputs = [new("Required", new NativePrimitive("Text"), true, null), new("Defaulted", new NativePrimitive("Text"), false, "\"a\\b\"")],
            SourceAbi = new("opaque", 1, new JsonObject { ["z"] = 1, ["a"] = 2 }) };
        var first = new NativeDependencyCatalog(fixture.Producers, [binding]);
        var reordered = binding with { ReachableTypes = binding.ReachableTypes.Reverse().ToDictionary(p => p.Key, p => p.Value),
            SourceAbi = new("opaque", 1, new JsonObject { ["a"] = 2, ["z"] = 1 }) };
        Assert.Equal(first.Fingerprint, new NativeDependencyCatalog(fixture.Producers.Reverse(), [reordered]).Fingerprint);
        Assert.NotEqual(first.Fingerprint, new NativeDependencyCatalog(fixture.Producers, [binding with { OrderedInputs = binding.OrderedInputs.Reverse().ToArray() }]).Fingerprint);
        Assert.NotEqual(first.Fingerprint, new NativeDependencyCatalog(fixture.Producers, [binding with { Placeholders = binding.Placeholders.Reverse().ToArray() }]).Fingerprint);
        var copy = NativeDependencyCatalog.FromJson(first.ToJson()).Bindings[0];
        Assert.Null(copy.OrderedInputs[0].DefaultExpression); Assert.Equal("\"a\\b\"", copy.OrderedInputs[1].DefaultExpression);
        Assert.NotEqual(first.Fingerprint, new NativeDependencyCatalog(fixture.Producers, [binding with {
            OrderedInputs = [binding.OrderedInputs[0] with { DefaultExpression = "" }, binding.OrderedInputs[1]] }]).Fingerprint);
    }

    [Theory]
    [InlineData("root")]
    [InlineData("binding")]
    [InlineData("parameter")]
    [InlineData("type")]
    [InlineData("producer")]
    [InlineData("version")]
    [InlineData("numeric-kind")]
    public void JsonRejectsUnknownContractFieldsAndFormats(string fault)
    {
        var json = new Fixture().Create().ToJson();
        switch (fault)
        {
            case "root": json["allowLatest"] = true; break;
            case "binding": json["bindings"]![0]!["ignoreIdentity"] = true; break;
            case "parameter": json["bindings"]![0]!["orderedInputs"]![0]!["extra"] = 1; break;
            case "type": json["bindings"]![0]!["orderedInputs"]![0]!["type"]!["extra"] = 1; break;
            case "producer": json["producers"]![0]!["credentials"] = "forbidden"; break;
            case "version": json["formatVersion"] = 99; break;
            case "numeric-kind": json["bindings"]![0]!["requirement"]!["kind"] = 0; break;
        }
        Assert.ThrowsAny<Exception>(() => NativeDependencyCatalog.FromJson(json));
    }

    [Fact]
    public void SourceAbiIsOpaqueVersionedAndNeverInferredFromNames()
    {
        var fixture = new Fixture(); Assert.Null(fixture.Create().Bindings[0].SourceAbi);
        var payload = new JsonObject { ["unrecognized-but-opaque"] = new JsonObject { ["anything"] = true } };
        var catalog = new NativeDependencyCatalog(fixture.Producers, [fixture.Binding with { SourceAbi = new("future.codec", 27, payload) }]);
        var loaded = NativeDependencyCatalog.FromJson(catalog.ToJson());
        Assert.Equal(27, loaded.Bindings[0].SourceAbi!.Version);
        Assert.True(loaded.Bindings[0].SourceAbi!.Payload["unrecognized-but-opaque"]!["anything"]!.GetValue<bool>());
        Assert.Throws<ArgumentException>(() => new NativeSourceAbi("future.codec", 0, payload));
    }

    private sealed class Fixture
    {
        public const string ProductKey = "opaque-native-producer*product";
        public const string EntityKey = "opaque-native-producer*entity";
        public NativeDependencyProducer[] Producers { get; } = [
            new("Catalog", "fixture.invalid", "producer-one", "Catalog", "eSpace", "Service", 34, "d6a8d924-ea44-4ce2-9b5d-4ea13c067792", new string('a', 64)),
            new("Types", "fixture.invalid", "producer-two", "Types", "eSpace", "Service", 12, "049ba372-9d67-429d-bb66-cc08563033ee", new string('b', 64))
        ];
        public NativeDependencyBinding Binding { get; } = new(new("catalog.html::Page::search", NativeDependencyKind.ServerAction, "Catalog", "search"),
            "Catalog", "search", "IServerActionSignature:@producer-one/search",
            [new("Query", new NativePrimitive("Text"), true, null, "query")], [new("Items", new NativeList(new NativeRecord(ProductKey)), OriginalKey: "items")],
            new Dictionary<string, NativeRecordDefinition> {
                [ProductKey] = new(ProductKey, "Product", NativeRecordKind.Structure, "IStructureSignature:@producer-two/product", [
                    new("Label", new NativePrimitive("Text"), "label"),
                    new("Children", new NativeList(new NativeRecord(ProductKey)), "children"),
                    new("OwnerId", new NativeIdentifier(EntityKey, "Long Integer"), "owner-id")]),
                [EntityKey] = new(EntityKey, "Owner", NativeRecordKind.Entity, "IEntitySignature:@producer-two/entity", [
                    new("Id", new NativePrimitive("Long Integer"), "id")], "Long Integer")
            }, [], []);
        public NativeDependencyCatalog Create() => new(Producers, [Binding]);
        public NativeDependencyBinding Block() => Binding with {
            Requirement = new("block.html::Card", NativeDependencyKind.Block, "Catalog", "Content/Card"),
            OriginalElementKey = "card", NativeReference = "IMobileBlockSignature:@producer-one/card",
            OrderedInputs = [], OrderedOutputs = [],
            Events = [new("Selected", "event-selected", true, [new("Item", new NativeRecord(ProductKey), true)])],
            Placeholders = [new("Body", "slot-body"), new("Footer", "slot-footer")]
        };
    }
}
