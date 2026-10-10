using System.Runtime.CompilerServices;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Anvil.Core;
using OutSystems.ObjectKeys;
using Xunit;

namespace Anvil.Tests;

public sealed class NativeDependencyReaderTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeDependencyReaderTests).Assembly.Location)!)!;
    private static string Work() { var path = Path.Combine(Root, ".local/native-dependency-reader-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(path); return path; }

    [Theory]
    [InlineData("aliases-and-order")]
    [InlineData("native-index-order")]
    [InlineData("block-flow-event-placeholder")]
    [InlineData("nested-list-and-identifier")]
    [InlineData("cross-producer-closure")]
    [InlineData("missing-cross-producer")]
    [InlineData("wrong-signature-hash")]
    [InlineData("wrong-native-payload")]
    [InlineData("wrong-element-hash")]
    [InlineData("omitted-element-hash")]
    [InlineData("unknown-native-system-type")]
    [InlineData("hidden-export")]
    [InlineData("wrong-kind")]
    [InlineData("wrong-path")]
    [InlineData("consumer-alias-is-not-original")]
    public void PrivateSyntheticPayloadExtractionIsStructuralOnlyAndPublicReadRejectsIt(string scenario)
    { StudioAssemblies.Bind(); SignatureCase(scenario); }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void SignatureCase(string scenario)
    {
        // Deliberately synthetic XML assembled using the native binary writer/hash implementation.
        // These cases test only the private structural parser; they do not attest producer identity.
        // The public reader must reject these same bytes, even when all envelope fields agree.
        var fixture = new SignatureFixture(); var request = fixture.Request;
        if (scenario == "block-flow-event-placeholder") request = new("page.html::Page::card", NativeDependencyKind.Block, "Producer", "OriginalFlow/Card");
        if (scenario == "nested-list-and-identifier") request = new("page.html::Page::data", NativeDependencyKind.Type, "Producer", "Envelope");
        if (scenario == "cross-producer-closure" || scenario == "missing-cross-producer") request = new("page.html::Page::foreign", NativeDependencyKind.ServerAction, "Producer", "Foreign");
        if (scenario == "wrong-kind") request = request with { Kind = NativeDependencyKind.ClientAction };
        if (scenario == "wrong-path") request = request with { OriginalElementPath = "Flow/Search" };
        if (scenario == "consumer-alias-is-not-original") request = request with { OriginalElementPath = "ConsumerSearch" };
        if (scenario == "native-index-order")
        {
            var parameters = fixture.Search.Element("InputParameters")!; var items = parameters.Elements().ToArray();
            items[0].SetAttributeValue("Index", 0); items[1].SetAttributeValue("Index", 1);
            parameters.ReplaceNodes(items.Reverse());
        }
        if (scenario == "hidden-export") fixture.Wrappers[0].SetAttributeValue("Hidden", NativeTrue());
        if (scenario == "unknown-native-system-type") fixture.Search.Descendants("Variables.ReferenceGenericInputParameter").First().SetAttributeValue("Type", SystemType(ObjectKey.NewKey()));
        if (scenario == "wrong-native-payload") fixture.Search.SetAttributeValue("OriginalName", "ChangedAfterFreeze");
        if (scenario == "wrong-element-hash") fixture.Wrappers[0].SetAttributeValue("FullSignatureHash", Guid.NewGuid());
        if (scenario == "omitted-element-hash") fixture.Wrappers[0].SetAttributeValue("FullSignatureHash", null);
        if (scenario == "hidden-export" || scenario == "unknown-native-system-type" || scenario == "native-index-order") fixture.RefreshElementHashes();
        var frozen = fixture.Freeze(scenario != "missing-cross-producer", keepOldSignatureHash: scenario == "wrong-native-payload");
        var producers = frozen.Producers.ToArray();
        if (scenario == "wrong-signature-hash") producers[0] = producers[0] with { SignatureHash = Guid.NewGuid().ToString() };
        var before = frozen.Paths.ToDictionary(p => p.Key, p => Hash(File.ReadAllBytes(p.Value)));
        Assert.Contains("missing-native-producer-evidence", Assert.Throws<ArgumentException>(() => NativeDependencyReader.Read([request], producers, frozen.Paths)).Message);
        var failure = scenario switch {
            "missing-cross-producer" => "Missing native dependency", "wrong-signature-hash" => "payload hash",
            "wrong-native-payload" => "payload hash", "wrong-element-hash" => "element payload hash",
            "omitted-element-hash" => "element payload hash omitted",
            "unknown-native-system-type" => "Unsupported native system type", "hidden-export" or "wrong-kind" or "wrong-path" or "consumer-alias-is-not-original" => "resolve exactly once", _ => null
        };
        if (failure != null)
        {
            Assert.Contains(failure, Assert.ThrowsAny<Exception>(() => ReadSyntheticPayloadForStructuralTests([request], producers, frozen.Paths)).Message);
        }
        else
        {
            var alias = request with { SourceSymbol = "nested.html::Child::otherAlias" };
            var catalog = ReadSyntheticPayloadForStructuralTests([request, alias], producers, frozen.Paths);
            var binding = catalog.Resolve(request);
            Assert.Equal(binding.NativeReference, catalog.Resolve(alias).NativeReference);
            Assert.Equal(catalog.Fingerprint, NativeDependencyCatalog.FromJson(catalog.ToJson()).Fingerprint);
            Assert.Null(binding.SourceAbi);
            if (scenario is "aliases-and-order" or "native-index-order")
            {
                Assert.Equal(new[] { "Second", "First" }, binding.OrderedInputs.Select(p => p.Name));
                Assert.True(binding.OrderedInputs[0].Mandatory); Assert.False(binding.OrderedInputs[1].Mandatory);
                Assert.Equal("\"default text\"", binding.OrderedInputs[1].DefaultExpression);
                Assert.Equal("IServerActionSignature:@" + fixture.ProducerKey + "/" + fixture.ActionKey, binding.NativeReference);
            }
            else if (scenario == "block-flow-event-placeholder")
            {
                Assert.StartsWith("IMobileBlockSignature:@", binding.NativeReference);
                var ev = Assert.Single(binding.Events); Assert.Equal("Changed", ev.Name); Assert.True(ev.Mandatory);
                Assert.Equal("Value", Assert.Single(ev.OrderedInputs).Name);
                Assert.Equal(new[] { "Body", "Footer" }, binding.Placeholders.Select(p => p.Name));
            }
            else if (scenario == "nested-list-and-identifier")
            {
                var record = binding.ReachableTypes.Values.Single(r => r.Name == "Envelope");
                var nested = Assert.IsType<NativeList>(record.OrderedFields[0].Type);
                Assert.Equal(new NativePrimitive("Text"), Assert.IsType<NativeList>(nested.Element).Element);
                var id = Assert.IsType<NativeIdentifier>(record.OrderedFields[1].Type);
                Assert.Equal("Long Integer", id.StoragePrimitive);
                var entity = binding.ReachableTypes[id.TargetGlobalKey];
                Assert.Equal(NativeRecordKind.Entity, entity.NativeKind); Assert.Contains(fixture.ProducerKey.ToString(), entity.NativeReference);
            }
            else
            {
                var type = Assert.Single(binding.ReachableTypes.Values);
                Assert.Contains(fixture.OtherProducerKey.ToString(), type.NativeReference);
                Assert.Equal("RemoteRecord", type.Name);
            }
        }
        foreach (var pair in frozen.Paths) Assert.Equal(before[pair.Key], Hash(File.ReadAllBytes(pair.Value)));
    }

    [Theory]
    [InlineData("valid-with-unrelated-invalid")]
    [InlineData("invalid-selected")]
    [InlineData("tampered-selected")]
    [InlineData("missing-selected-hash")]
    [InlineData("invalid-type")]
    [InlineData("invalid-transitive-type")]
    [InlineData("invalid-external")]
    [InlineData("invalid-list")]
    [InlineData("invalid-list-dependency")]
    [InlineData("invalid-parent")]
    [InlineData("invalid-parent-dependency")]
    [InlineData("duplicate-unrelated")]
    [InlineData("duplicate-export-list")]
    [InlineData("duplicate-lists")]
    [InlineData("missing-list")]
    [InlineData("malformed-type")]
    [InlineData("no-selection-invalid")]
    public void ServerSignatureValidatesTheEntireEffectiveSelectionWithoutImportingUnrelatedInvalidExports(string scenario)
    { StudioAssemblies.Bind(); SelectionCase(scenario); }

    [Fact]
    public void HiddenExistingAbiCanBeValidatedByOriginalKeyButCannotBecomeANewExport()
    { StudioAssemblies.Bind(); HiddenExistingCase(); }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void HiddenExistingCase()
    {
        var fixture=new SignatureFixture();fixture.Wrappers[0].SetAttributeValue("Hidden",NativeTrue());
        var binary=(byte[])NativeStatic("Oml.Oml","SerializeSignature",Document(fixture.Wrappers));
        var selected=new[]{"IServerActionSignature:@"+fixture.ActionKey};
        // A25: a new request for an element the payload has only hidden is PRODUCER_SIGNATURE_MISSING with cause private.
        var hidden=Assert.Throws<KernelRefusalException>(()=>NativeDependencyReader.ResolveServerSignature(fixture.ProducerKey.ToString(),"Producer",binary,selected));
        Assert.Equal("PRODUCER_SIGNATURE_MISSING",hidden.Code);
        var problem=Assert.Single(hidden.Problems!)!;
        Assert.Equal("private",problem["cause"]!.GetValue<string>());
        Assert.Contains("Public",problem["fix"]!.GetValue<string>());
        var validate=typeof(NativeDependencyReader).GetMethod("ValidateExistingServerImports",BindingFlags.Static|BindingFlags.NonPublic)!;
        var result=(NativeSignatureResolution)validate.Invoke(null,[fixture.ProducerKey.ToString(),"Producer",binary,selected])!;
        Assert.True(Assert.Single(result.Elements).Hidden);Assert.Empty(result.Unresolved);
        fixture.Wrappers[0].SetAttributeValue("FullSignatureHash",fixture.Wrappers[1].Attribute("FullSignatureHash")!.Value);
        binary=(byte[])NativeStatic("Oml.Oml","SerializeSignature",Document(fixture.Wrappers));
        var error=Assert.Throws<TargetInvocationException>(()=>validate.Invoke(null,[fixture.ProducerKey.ToString(),"Producer",binary,selected]));
        Assert.IsType<ArgumentException>(error.InnerException);Assert.Contains("Native element payload hash differs",error.InnerException!.Message);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void SelectionCase(string scenario)
    {
        var fixture = new SignatureFixture();
        XElement Named(string name) => fixture.Wrappers.Single(w => (string?)w.Elements().Single().Attribute("OriginalName") == name);
        var envelope = Named("Envelope"); var foreign = Named("Foreign"); var parent = Named("OriginalFlow");
        if (scenario is "invalid-type" or "invalid-transitive-type" or "invalid-list" or "invalid-list-dependency")
            fixture.Search.Element("InputParameters")!.Elements().First().SetAttributeValue("Type",
                "ReferenceStructure:" + fixture.ProducerKey + "/ReferenceStructures." + envelope.Attribute("OriginalKey")!.Value);
        if (scenario == "invalid-external") fixture.Wrappers[0].SetAttributeValue("ExternalDependencies",
            new GlobalObjectKey(fixture.ProducerKey, Keys.Parse(foreign.Attribute("OriginalKey")!.Value)));
        if (scenario == "invalid-parent-dependency") parent.SetAttributeValue("ExternalDependencies",
            new GlobalObjectKey(fixture.ProducerKey, Keys.Parse(foreign.Attribute("OriginalKey")!.Value)));
        var firstList = fixture.Wrappers.First(w => w.Elements().Single().Name == "ListType");
        if (scenario == "invalid-list-dependency") firstList.SetAttributeValue("ExternalDependencies",
            new GlobalObjectKey(fixture.ProducerKey, Keys.Parse(foreign.Attribute("OriginalKey")!.Value)));
        if (scenario == "missing-list") fixture.Search.Element("InputParameters")!.Elements().First().SetAttributeValue("Type", "ListType:ListTypes." + ObjectKey.NewKey());
        if (scenario == "malformed-type") fixture.Search.Element("InputParameters")!.Elements().First().SetAttributeValue("Type", "not-a-native-reference");
        fixture.RefreshElementHashes();
        XElement invalid = scenario switch {
            "invalid-selected" or "tampered-selected" or "missing-selected-hash" => Named("Search"),
            "invalid-type" => Named("Envelope"), "invalid-transitive-type" => Named("Product"),
            "invalid-list" => fixture.Wrappers.First(w => w.Elements().Single().Name == "ListType"),
            "invalid-parent" => Named("OriginalFlow"), _ => Named("Foreign")
        };
        if (scenario == "tampered-selected") invalid.Elements().Single().Descendants("Variables.ReferenceGenericInputParameter").First().SetAttributeValue("Name", "ChangedAfterHash");
        else if (scenario == "missing-selected-hash") invalid.SetAttributeValue("FullSignatureHash", null);
        else if (scenario is not ("missing-list" or "malformed-type" or "duplicate-export-list" or "duplicate-lists"))
            invalid.SetAttributeValue("FullSignatureHash",fixture.Wrappers.First(w=>w!=invalid && w.Attribute("FullSignatureHash")!.Value!=invalid.Attribute("FullSignatureHash")!.Value).Attribute("FullSignatureHash")!.Value);
        if (scenario == "duplicate-unrelated") fixture.Wrappers.Add(new XElement(invalid));
        if (scenario == "duplicate-export-list") fixture.Wrappers.First(w => w.Elements().Single().Name == "ListType").SetAttributeValue("OriginalKey", fixture.ActionKey);
        if (scenario == "duplicate-lists") fixture.Wrappers.Last(w => w.Elements().Single().Name == "ListType").SetAttributeValue("OriginalKey", fixture.Wrappers.First(w => w.Elements().Single().Name == "ListType").Attribute("OriginalKey")!.Value);
        var binary = (byte[])NativeStatic("Oml.Oml", "SerializeSignature", Document(fixture.Wrappers));
        var selected = scenario == "no-selection-invalid" ? Array.Empty<string>()
            : new[] { scenario is "invalid-parent" or "invalid-parent-dependency" ? "IMobileBlockSignature:OriginalFlow/Card" : "IServerActionSignature:Search" };
        if (scenario == "valid-with-unrelated-invalid") {
            var result = NativeDependencyReader.ResolveServerSignature(fixture.ProducerKey.ToString(), "Producer", binary, selected);
            Assert.Equal("Search", Assert.Single(result.Elements).Name); Assert.Empty(result.Closure);
            Assert.Empty(result.Foreign); Assert.Empty(result.Unresolved);
            Assert.Throws<ArgumentException>(() => NativeDependencyReader.ListServerSignature(fixture.ProducerKey.ToString(), "Producer", binary));
        } else {
            Exception error = scenario == "malformed-type"
                ? Assert.ThrowsAny<Exception>(() => NativeDependencyReader.ResolveServerSignature(fixture.ProducerKey.ToString(), "Producer", binary, selected))
                : Assert.Throws<ArgumentException>(() => NativeDependencyReader.ResolveServerSignature(fixture.ProducerKey.ToString(), "Producer", binary, selected));
            if (scenario.StartsWith("duplicate-")) Assert.Contains("Duplicate native element identity", error.Message);
            else if (scenario == "missing-list") Assert.Contains("Missing native list signature", error.Message);
            else if (scenario != "malformed-type") Assert.Contains("Native element payload hash", error.Message);
        }
    }

    // Shapes of real producer signatures (Horsie_CS and OutSystemsUI captures, 2026-10-04): a Text List cites the platform
    // Text type under the native anonymous root, and an export kept in a model folder cites that folder. The first three
    // are accepted exactly as Service Studio accepts them; the rest prove the hardened refusals and reports still hold.
    [Theory]
    [InlineData("platform-type")]
    [InlineData("list-cited-by-another-key")]
    [InlineData("model-folder")]
    [InlineData("missing-list")]
    [InlineData("tampered-list")]
    [InlineData("tampered-folder")]
    [InlineData("foreign-producer")]
    [InlineData("unresolved-same-producer")]
    public void AnonymousRootPlatformTypesAndModelFoldersAreValidatedButNeverImported(string scenario)
    { StudioAssemblies.Bind(); NativeShapeCase(scenario); }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void NativeShapeCase(string scenario)
    {
        var fixture = new SignatureFixture(); var anonymous = FixedKey("Key_AnonymousTypesRootESpace"); var text = FixedKey("TextType");
        var withList = scenario is "platform-type" or "list-cited-by-another-key" or "missing-list" or "tampered-list";
        // Native list identity is NewKey(UniqueId). Captured lists always agree with their wrapper key; one variant names the
        // wrapper, and its anonymous citation, by another key: tolerated, the list being resolved through the type that uses it.
        var listKey = ObjectKey.NewKey(); var listWrapperKey = scenario == "list-cited-by-another-key" ? ObjectKey.NewKey() : listKey;
        var typedList = scenario == "missing-list" ? ObjectKey.NewKey() : listKey;
        var list = Wrap(listWrapperKey, new XElement("ListType", new XAttribute("UniqueId", listKey.ToString("DB")), new XAttribute("ElementType", SystemType(text))));
        var folderKey = ObjectKey.NewKey();
        var folder = Wrap(folderKey, new XElement("ReferenceModelFolder", new XAttribute("Name", "Grouped"), new XAttribute("ESpaceTreeFolder", "Structures"),
            new XAttribute("OriginalKey", folderKey), new XAttribute("OriginalName", "Grouped")));
        fixture.Wrappers.AddRange([list, folder]);
        var dependencies = new List<GlobalObjectKey>();
        if (scenario is "platform-type" or "missing-list") dependencies.Add(new(anonymous, text));
        if (withList) dependencies.Add(new(anonymous, scenario == "list-cited-by-another-key" ? listWrapperKey : typedList));
        if (scenario is "model-folder" or "tampered-folder") dependencies.Add(new(fixture.ProducerKey, folderKey));
        var foreignKey = new GlobalObjectKey(fixture.OtherProducerKey, ObjectKey.NewKey()); var missingKey = new GlobalObjectKey(fixture.ProducerKey, ObjectKey.NewKey());
        if (scenario == "foreign-producer") dependencies.Add(foreignKey);
        if (scenario == "unresolved-same-producer") dependencies.Add(missingKey);
        var profileKey = ObjectKey.NewKey(); var listType = "ListType:ListTypes." + typedList;
        var fields = new XElement("Attributes", Field("Name", SystemType(text)));
        if (withList) fields.Add(Field("Tags", listType));
        fixture.Wrappers.Add(Wrap(profileKey, new XElement("ReferenceStructure", new XAttribute("OriginalName", "Profile"), fields), dependencies: dependencies.ToArray()));
        var outputs = new XElement("OutputParameters", Parameter("Profile", "ReferenceStructure:" + fixture.ProducerKey + "/ReferenceStructures." + profileKey, false, output: true));
        if (withList) outputs.Add(Parameter("Tags", listType, false, output: true));
        var actionKey = ObjectKey.NewKey();
        fixture.Wrappers.Add(Wrap(actionKey, new XElement("ReferenceAction", new XAttribute("OriginalName", "Profile_Get"), outputs),
            dependencies: dependencies.Where(d => d.OwnerKey == anonymous).Append(new(fixture.ProducerKey, profileKey)).ToArray()));
        var tampered = scenario switch { "tampered-list" => list, "tampered-folder" => folder, _ => null };
        tampered?.SetAttributeValue("FullSignatureHash", fixture.Wrappers.First(w => w != tampered).Attribute("FullSignatureHash")!.Value);
        var binary = (byte[])NativeStatic("Oml.Oml", "SerializeSignature", Document(fixture.Wrappers));
        var producer = fixture.ProducerKey.ToString(); var selected = new[] { "IStructureSignature:Profile", "IServerActionSignature:Profile_Get" };
        if (scenario is "missing-list" or "tampered-list" or "tampered-folder")
        {
            var error = Assert.Throws<ArgumentException>(() => NativeDependencyReader.ResolveServerSignature(producer, "Producer", binary, selected));
            Assert.Contains(scenario == "missing-list" ? "Missing native list signature" : "Native element payload hash differs", error.Message);
            return;
        }
        var resolution = NativeDependencyReader.ResolveServerSignature(producer, "Producer", binary, selected);
        // Lists, platform types and folders are validated with the closure but are never importable closure elements.
        Assert.Empty(resolution.Closure); Assert.Empty(resolution.Requires[profileKey.ToString()]);
        Assert.Equal(new[] { profileKey.ToString() }, resolution.Requires[actionKey.ToString()]);
        Assert.Equal(scenario == "foreign-producer" ? new[] { foreignKey.ToString() } : Array.Empty<string>(), resolution.Foreign);
        Assert.Equal(scenario == "unresolved-same-producer" ? new[] { missingKey.ToString() } : Array.Empty<string>(), resolution.Unresolved);
        if (scenario is "foreign-producer" or "unresolved-same-producer") return;
        var validate = typeof(NativeDependencyReader).GetMethod("ValidateExistingServerImports", BindingFlags.Static | BindingFlags.NonPublic)!;
        var existing = (NativeSignatureResolution)validate.Invoke(null, [producer, "Producer", binary, new[] { "IStructureSignature:@" + profileKey, "IServerActionSignature:@" + actionKey }])!;
        Assert.Empty(existing.Unresolved); Assert.Empty(existing.Closure);
        Assert.Empty(NativeDependencyReader.ResolveServerSignature(producer, "Producer", binary, []).Unresolved);
        // The frozen-catalog path (debugger and native UI imports) binds the same export to its exact native types.
        var request = new NativeDependencyRequirement("page.html::Page::profile", NativeDependencyKind.ServerAction, "Producer", "Profile_Get");
        var frozen = fixture.Freeze(includeOther: true, keepOldSignatureHash: false);
        var binding = ReadSyntheticPayloadForStructuralTests([request], frozen.Producers, frozen.Paths).Resolve(request);
        var profile = Assert.Single(binding.ReachableTypes.Values); Assert.Equal("Profile", profile.Name);
        var expected = new List<NativeType> { new NativeRecord(profile.GlobalKey) };
        if (withList) expected.Add(new NativeList(new NativePrimitive("Text")));
        Assert.Equal(expected, binding.OrderedOutputs.Select(p => p.Type));
    }

    // More real producer shapes (audit of 861 O11 payloads, 2026-10-04): an action typed with an anonymous structure
    // (extension HMISPdfText, Users User_Create), a Traditional Web block with an Edit Record (Users ChangePassword), a
    // payload published under an older ElementsOrderVersion (Users, OutSystems UI) and an existing export the producer no
    // longer publishes. Each is accepted as Service Studio accepts it; the tampered and missing variants prove the hash
    // gate and the strict type positions still hold.
    [Theory]
    [InlineData("anonymous-structure")]
    [InlineData("tampered-anonymous-structure")]
    [InlineData("missing-anonymous-structure")]
    [InlineData("edit-record-widget")]
    [InlineData("older-elements-order")]
    [InlineData("tampered-older-elements-order")]
    [InlineData("removed-existing-export")]
    public void ProducerShapesServiceStudioAcceptsAreValidatedButNotRefused(string scenario)
    { StudioAssemblies.Bind(); ProducerShapeCase(scenario); }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void ProducerShapeCase(string scenario)
    {
        var fixture = new SignatureFixture(); var producer = fixture.ProducerKey.ToString(); var text = SystemType(FixedKey("TextType"));
        var validate = typeof(NativeDependencyReader).GetMethod("ValidateExistingServerImports", BindingFlags.Static | BindingFlags.NonPublic)!;
        if (scenario.EndsWith("anonymous-structure", StringComparison.Ordinal))
        {
            // HMISPdfText.ExtractPdfText returns a list of an anonymous record holding a named structure; Users.IPAddress_GetBlockedStatus
            // returns such a record itself and cites it under the anonymous root, like a list.
            var anonymous = FixedKey("Key_AnonymousTypesRootESpace"); var pageKey = ObjectKey.NewKey(); var recordKey = ObjectKey.NewKey(); var listKey = ObjectKey.NewKey();
            fixture.Wrappers.Add(Wrap(pageKey, new XElement("ReferenceStructure", new XAttribute("OriginalName", "PageText"), new XElement("Attributes", Field("Text", text)))));
            var record = Wrap(recordKey, new XElement("AnonymousStructure", new XAttribute("UniqueId", recordKey.ToString("DB")),
                new XElement("Attributes", new XElement("AnonymousStructureAttribute", new XAttribute("Type", "ReferenceStructure:" + producer + "/ReferenceStructures." + pageKey)))),
                dependencies: [new GlobalObjectKey(fixture.ProducerKey, pageKey)]);
            if (scenario != "missing-anonymous-structure") fixture.Wrappers.Add(record);
            fixture.Wrappers.Add(Wrap(listKey, new XElement("ListType", new XAttribute("UniqueId", listKey.ToString("DB")), new XAttribute("ElementType", "AnonymousStructure:AnonymousStructures." + recordKey))));
            var actionKey = ObjectKey.NewKey();
            fixture.Wrappers.Add(Wrap(actionKey, new XElement("ReferenceAction", new XAttribute("OriginalName", "ExtractText"), new XElement("OutputParameters",
                Parameter("Pages", "ListType:ListTypes." + listKey, false, output: true), Parameter("First", "AnonymousStructure:AnonymousStructures." + recordKey, false, output: true))),
                dependencies: [new GlobalObjectKey(anonymous, recordKey), new GlobalObjectKey(anonymous, listKey), new GlobalObjectKey(fixture.ProducerKey, pageKey)]));
            if (scenario == "tampered-anonymous-structure") record.SetAttributeValue("FullSignatureHash", fixture.Wrappers[0].Attribute("FullSignatureHash")!.Value);
            var binary = (byte[])NativeStatic("Oml.Oml", "SerializeSignature", Document(fixture.Wrappers));
            string[] selected = ["IServerActionSignature:ExtractText"];
            if (scenario != "anonymous-structure")
            {
                var error = Assert.Throws<ArgumentException>(() => NativeDependencyReader.ResolveServerSignature(producer, "Producer", binary, selected));
                Assert.Contains(scenario == "missing-anonymous-structure" ? "Missing native anonymous structure signature" : "Native element payload hash differs", error.Message);
                return;
            }
            // The record is validated with the closure and its own types followed; only the named structure is imported.
            var resolution = NativeDependencyReader.ResolveServerSignature(producer, "Producer", binary, selected);
            Assert.Equal("PageText", Assert.Single(resolution.Closure).Name);
            Assert.Equal(new[] { pageKey.ToString() }, resolution.Requires[actionKey.ToString()]);
            Assert.Empty(resolution.Foreign); Assert.Empty(resolution.Unresolved);
            Assert.Empty(((NativeSignatureResolution)validate.Invoke(null, [producer, "Producer", binary, new[] { "IServerActionSignature:@" + actionKey }])!).Unresolved);
            Assert.Empty(NativeDependencyReader.ResolveServerSignature(producer, "Producer", binary, []).Unresolved);
            Assert.DoesNotContain(NativeDependencyReader.ListServerSignature(producer, "Producer", binary), e => e.OriginalKey == recordKey.ToString());
            return;
        }
        if (scenario == "edit-record-widget")
        {
            // Users ChangePassword: a Traditional Web block whose Edit Record cells carry Type="Caption", a widget property.
            var flowKey = ObjectKey.NewKey();
            fixture.Wrappers.Add(Wrap(flowKey, new XElement("ReferenceWebFlow", new XAttribute("OriginalName", "Accounts"))));
            var cells = new XElement("Cells", new XElement("WebWidgets.ReferenceEditRecordCell", new XAttribute("Type", "Caption")),
                new XElement("WebWidgets.ReferenceEditRecordCell", new XElement("Mandatory",
                    new XElement("ReferenceExpression", new XAttribute("Text", "True"), new XAttribute("Type", SystemType(FixedKey("BooleanType")))))));
            fixture.Wrappers.Add(Wrap(ObjectKey.NewKey(), new XElement("ReferenceWebBlock", new XAttribute("OriginalName", "ChangePassword"),
                new XElement("InputParameters", Parameter("Hint", text, false)),
                new XElement("ReferenceWidgets", new XElement("WebWidgets.ReferenceEditRecord", new XElement("Rows", new XElement("WebWidgets.ReferenceEditRecordRow", cells))))),
                parent: flowKey));
            var binary = (byte[])NativeStatic("Oml.Oml", "SerializeSignature", Document(fixture.Wrappers));
            var resolution = NativeDependencyReader.ResolveServerSignature(producer, "Producer", binary, ["IWebBlockSignature:Accounts/ChangePassword"]);
            Assert.Equal("ChangePassword", Assert.Single(resolution.Elements).Name);
            Assert.Equal("Accounts", Assert.Single(resolution.Closure).Name);
            Assert.Empty(NativeDependencyReader.ResolveServerSignature(producer, "Producer", binary, []).Unresolved);
            return;
        }
        if (scenario.EndsWith("older-elements-order", StringComparison.Ordinal))
        {
            // Hashes cover the producer's own child order; the Studio re-sorts an older ElementsOrderVersion when it reads one.
            fixture.Search.ReplaceNodes(fixture.Search.Elements().Reverse().ToArray());
            fixture.RefreshElementHashes();
            var search = fixture.Wrappers[0].Elements().Single();
            if (scenario == "tampered-older-elements-order") search.Descendants("Variables.ReferenceGenericInputParameter").First().SetAttributeValue("Name", "ChangedAfterHash");
            const string older = "fa53c5ad-1249-aec9-f6c4-645de330bd52"; // Users v5407 in the personal environment
            var binary = (byte[])NativeStatic("Oml.Oml", "SerializeSignature", Document(fixture.Wrappers, older));
            using (var reader = (IDisposable)NativeStatic("Oml.Oml", "GetSignatureReader", binary))
            {
                var sorted = ((XElement)NativeCall(reader, "ToXElement")).Element("ElementSignatures")!.Elements().First().Elements().Single();
                Assert.NotEqual(search.Elements().Select(e => e.Name.LocalName), sorted.Elements().Select(e => e.Name.LocalName));
            }
            string[] selected = ["IServerActionSignature:Search"];
            if (scenario == "tampered-older-elements-order")
            {
                Assert.Contains("Native element payload hash differs", Assert.Throws<ArgumentException>(() => NativeDependencyReader.ResolveServerSignature(producer, "Producer", binary, selected)).Message);
                return;
            }
            Assert.Equal("Search", Assert.Single(NativeDependencyReader.ResolveServerSignature(producer, "Producer", binary, selected).Elements).Name);
            Assert.Empty(NativeDependencyReader.ResolveServerSignature(producer, "Producer", binary, []).Unresolved);
            Assert.Contains(NativeDependencyReader.ListServerSignature(producer, "Producer", binary), e => e.Name == "Search");
            return;
        }
        // An existing export the producer removed, re-keyed or turned into another kind has nothing to validate: it is reported
        // and left to the native refresh. A new request for it is still refused.
        var current = (byte[])NativeStatic("Oml.Oml", "SerializeSignature", Document(fixture.Wrappers));
        var kept = "IServerActionSignature:@" + fixture.ActionKey; var removed = "IServerActionSignature:@" + ObjectKey.NewKey();
        var otherKind = "IClientActionSignature:@" + fixture.ActionKey;
        var existing = (NativeSignatureResolution)validate.Invoke(null, [producer, "Producer", current, new[] { kept, removed, otherKind }])!;
        Assert.Equal("Search", Assert.Single(existing.Elements).Name);
        Assert.Equal(new[] { removed, otherKind }, existing.Absent);
        Assert.Empty(existing.Unresolved);
        // A25: refused as PRODUCER_SIGNATURE_MISSING, the element with its cause.
        var missing = Assert.Throws<KernelRefusalException>(() => NativeDependencyReader.ResolveServerSignature(producer, "Producer", current, [removed]));
        Assert.Equal("PRODUCER_SIGNATURE_MISSING", missing.Code);
        Assert.Equal("absent", Assert.Single(missing.Problems!)!["cause"]!.GetValue<string>());
        Assert.Null(NativeDependencyReader.ResolveServerSignature(producer, "Producer", current, [kept]).Absent);
    }

    [Theory]
    [InlineData("unchanged-real-avsig")]
    [InlineData("self-consistent-forged-identity")]
    [InlineData("self-consistent-forged-environment")]
    [InlineData("invalid-native-payload")]
    [InlineData("unreleased-source-abi")]
    [InlineData("arbitrary-json")]
    [InlineData("non-json")]
    public void AvsigOrNonNativeBytesCannotAttestProducerIdentityEvenWithAMatchingFileHash(string scenario)
    { StudioAssemblies.Bind(); RejectSignatureOnlyInput(scenario); }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RejectSignatureOnlyInput(string scenario)
    {
        var originalPath = Path.Combine(Root, "tests/contracts/native-reference/ordinal-primitive.avsig");
        var original = File.ReadAllBytes(originalPath); var envelope = JsonNode.Parse(original)!.AsObject();
        if (scenario == "self-consistent-forged-identity")
        {
            envelope["ModuleKey"] = ObjectKey.NewKey().ToString(); envelope["Name"] = "ForgedProducer";
            envelope["ModuleKind"] = "eSpace"; envelope["ModuleType"] = "Mobile";
        }
        if (scenario == "self-consistent-forged-environment") envelope["Environment"] = "forged.invalid";
        if (scenario == "invalid-native-payload") envelope["SignatureBinary"] = "not even base64";
        if (scenario == "unreleased-source-abi")
            envelope["SourceAbi"] = new JsonObject { ["Id"] = "unreleased.csharp.graph", ["Version"] = 1, ["Payload"] = new JsonObject() };
        var bytes = scenario switch {
            "unchanged-real-avsig" => original, "arbitrary-json" => System.Text.Encoding.UTF8.GetBytes("{}"),
            "non-json" => System.Text.Encoding.UTF8.GetBytes("not an OML"),
            _ => System.Text.Encoding.UTF8.GetBytes(envelope.ToJsonString())
        };
        // Descriptor matches even the forged header and every actual byte. Neither agreement
        // nor an .oml filename turns a signature-only file into independently verified identity.
        var producer = new NativeDependencyProducer("Frozen", envelope["Environment"]!.ToString(), Keys.ToStudio(envelope["ModuleKey"]!.ToString()), envelope["Name"]!.ToString(),
            envelope["ModuleKind"]!.ToString(), envelope["ModuleType"]!.ToString(), 1, envelope["SignatureHash"]!.ToString(), Hash(bytes));
        var request = new NativeDependencyRequirement("page.html::Page::compare", NativeDependencyKind.ServerAction, producer.ProducerName, "CSharpTextCompareOrdinal");
        var path = Path.Combine(Work(), "untrusted-producer.oml"); File.WriteAllBytes(path, bytes);
        Assert.Contains("missing-native-producer-evidence", Assert.Throws<ArgumentException>(() =>
            NativeDependencyReader.Read([request], [producer], new Dictionary<string, string> { ["Frozen"] = path })).Message);
        Assert.Equal(bytes, File.ReadAllBytes(path)); Assert.Equal(original, File.ReadAllBytes(originalPath));
    }

    [Theory]
    [InlineData("producer-public", "server-and-type", false)]
    [InlineData("service-action", "service", false)]
    [InlineData("service-action", "service", true)]
    [InlineData("client-js-reactive", "client", false)]
    [InlineData("generated-block", "block", false)]
    public void ActualNativeProducerOmlSignaturesAreReadWithoutChangingProducerBytes(string fixtureName, string kind, bool publicStatic)
    { StudioAssemblies.Bind(); NativeOmlFixture(fixtureName, kind, publicStatic); }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void NativeOmlFixture(string fixtureName, string kind, bool publicStatic)
    {
        // Fixture creation is intentionally a native test for the exclusive root gate, never reader behavior.
        // PublishedVersion=1/environment=fixture.invalid are explicit fixture attestations, not live evidence.
        var work = Work(); var host = new ModelHost(work); JsonObject job; string basis;
        if (kind == "block")
        {
            basis = Path.Combine(Root, "tests/fixtures/reactive-ui.oml");
            var contract = HtmlComponents.Compile("""
                <component name="NativeReaderBlock" kind="block"><script type="module">
                export const inputs={title:"string"}; export const events={changed:{value:"string"}};
                function notify(){emit.changed({value:title});}
                </script><div><p>{{title}}</p><button onclick="notify()">Notify</button><slot name="Body"></slot></div></component>
                """);
            contract["screens"]![0]!["properties"]!["Public"] = true;
            job = new JsonObject { ["ops"] = host.PlanModuleSpecification(basis, contract) };
        }
        else
        {
            job = JsonNode.Parse(File.ReadAllText(Path.Combine(Root, "tests/jobs", fixtureName + ".json")))!.AsObject();
            basis = Path.Combine(Root, job["base"]!.ToString());
            if (kind == "client") job["ops"]!.AsArray().Add(new JsonObject { ["op"] = "set", ["target"] = "IClientAction:Slugify", ["prop"] = "Public", ["value"] = true });
            if (publicStatic)
            {
                Assert.Equal("service", kind);
                var data = job["ops"]!.AsArray().Single(op => op!["op"]?.ToString() == "spec")!["data"]!;
                var status = data["static"]!.AsArray().Single(entity => entity!["name"]!.ToString() == "OrderStatus")!.AsObject();
                Assert.False(status.ContainsKey("public")); // Preserve the original private fixture unchanged.
                status["public"] = true; // The public variant changes only this declaration in its copied job.
            }
        }
        var jobPath = Path.Combine(work, "fixture.json"); var path = Path.Combine(work, "unrelated-file-name.oml");
        File.WriteAllText(jobPath, job.ToJsonString());
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, jobPath, path))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        var bytes = File.ReadAllBytes(path); var header = NativeStatic("Oml.Oml", "GetOmlHeader", bytes);
        using var oml = (IDisposable)NativeStatic("Oml.Oml", "LoadWithoutUpgrades", bytes, "");
        var nativeSignature = (XElement)NativeCall(oml, "GetSignature");
        var signatureHash = SignatureHash(nativeSignature);
        var producerName = header.GetType().GetProperty("Name")!.GetValue(header)!.ToString()!;
        var producer = new NativeDependencyProducer("Frozen", "fixture.invalid", header.GetType().GetProperty("Key")!.GetValue(header)!.ToString()!, producerName,
            "eSpace", header.GetType().GetProperty("ESpaceType")!.GetValue(header)!.ToString()!, 1, signatureHash, Hash(bytes));
        var requests = kind switch {
            "server-and-type" => new[] { new NativeDependencyRequirement("page.html::Page::get", NativeDependencyKind.ServerAction, producerName, "Product_GetById"), new("page.html::Page::type", NativeDependencyKind.Type, producerName, "ProductSummary") },
            "service" => [new NativeDependencyRequirement("page.html::Page::get", NativeDependencyKind.ServiceAction, producerName, "Order_GetSummary")],
            "client" => [new NativeDependencyRequirement("page.html::Page::format", NativeDependencyKind.ClientAction, producerName, "Slugify")],
            _ => [new NativeDependencyRequirement("page.html::Page::card", NativeDependencyKind.Block, producerName, "MainFlow/NativeReaderBlock")]
        };
        var paths = new Dictionary<string, string> { ["Frozen"] = path };
        if (kind == "service") AssertOrderStatusVisibilityBeforeReader(host, path, result, nativeSignature, publicStatic, work);
        var catalog = NativeDependencyReader.Read(requests, [producer], paths);
        Assert.Equal(requests.Length, catalog.Bindings.Count);
        Assert.All(catalog.Bindings, binding => Assert.Null(binding.SourceAbi));
        AssertPublicFixtureSignature(kind, catalog.Bindings, producer, publicStatic);
        AssertFixtureOracleRejectsMutations(kind, catalog.Bindings, producer, publicStatic);
        if (kind == "service")
        {
            var direct = new NativeDependencyRequirement("page.html::Page::status", NativeDependencyKind.Type, producerName, "OrderStatus");
            if (publicStatic)
            {
                var imported = NativeDependencyReader.Read([direct], [producer], paths).Resolve(direct);
                var status = Assert.Single(imported.ReachableTypes.Values);
                Assert.Equal("OrderStatus", status.Name); Assert.Equal("Integer", status.IdentifierStoragePrimitive);
                Assert.Equal(new[] { "Id", "Label", "Order" }, status.OrderedFields.Select(field => field.Name));
                Assert.Equal(new NativeType[] { new NativePrimitive("Integer"), new NativePrimitive("Text"), new NativePrimitive("Integer") }, status.OrderedFields.Select(field => field.Type));
            }
            else Assert.Contains("resolve exactly once", Assert.Throws<ArgumentException>(() => NativeDependencyReader.Read([direct], [producer], paths)).Message);
        }
        var wrongExpectations = new[] {
            (Producer: producer with { ProducerKey = ObjectKey.NewKey().ToString() }, Diagnostic: "key/name"),
            (Producer: producer with { ProducerName = producerName + "_Wrong" }, Diagnostic: "key/name"),
            (Producer: producer with { ReferenceKind = "Extension" }, Diagnostic: "reference kind/module type"),
            (Producer: producer with { ModuleType = producer.ModuleType == "Mobile" ? "WebResponsive" : "Mobile" }, Diagnostic: "reference kind/module type"),
            (Producer: producer with { SignatureHash = Guid.NewGuid().ToString() }, Diagnostic: "payload hash"),
            (Producer: producer with { SignatureFileSha256 = new string('0', 64) }, Diagnostic: "SHA-256")
        };
        foreach (var wrong in wrongExpectations)
            Assert.Contains(wrong.Diagnostic, Assert.ThrowsAny<Exception>(() => NativeDependencyReader.Read(requests, [wrong.Producer], paths)).Message);
        var changedPath = Path.Combine(work, "changed-byte-copy.oml");
        File.WriteAllBytes(changedPath, bytes.Concat(new byte[] { 32 }).ToArray());
        var changedPaths = new Dictionary<string, string> { ["Frozen"] = changedPath };
        Assert.Contains("SHA-256", Assert.ThrowsAny<Exception>(() => NativeDependencyReader.Read(requests, [producer], changedPaths)).Message);
        Assert.Equal(bytes.Concat(new byte[] { 32 }), File.ReadAllBytes(changedPath));
        if (kind == "server-and-type")
        {
            // Catalog transport can preserve caller-supplied ABI metadata, but the reader
            // neither obtains nor attests it. Rejection by UiNativeActionImports.InputShape
            // is a separate Interface integration test and is not covered by this root gate.
            var unsupported = catalog.Resolve(requests[0]) with {
                SourceAbi = new NativeSourceAbi("unreleased.csharp.graph", 1, new JsonObject { ["format"] = "opaque" })
            };
            var opaque = NativeDependencyCatalog.FromJson(new NativeDependencyCatalog(catalog.Producers,
                catalog.Bindings.Select(binding => binding.Requirement == unsupported.Requirement ? unsupported : binding)).ToJson());
            var carried = opaque.Resolve(requests[0]).SourceAbi;
            Assert.NotNull(carried);
            Assert.Equal("unreleased.csharp.graph", carried.Id);
            Assert.Equal(1, carried.Version);
            Assert.Equal("opaque", carried.Payload["format"]!.ToString());
            Assert.Null(catalog.Resolve(requests[0]).SourceAbi);
        }
        Assert.Equal(bytes, File.ReadAllBytes(path));
    }

    private static void AssertOrderStatusVisibilityBeforeReader(ModelHost host, string path, JsonNode creation,
        XElement signature, bool publicStatic, string work)
    {
        // Independent observations: existing loaded-model data reader and native cached XML.
        // Neither path calls NativeDependencyReader or uses its catalog as expected data.
        var model = host.CheckDataContract(path, creation["dataContract"]!["assertions"]!.AsArray());
        Assert.True(model["accepted"]!.GetValue<bool>(), model.ToJsonString());
        var status = Assert.Single(model["dataSummary"]!.AsArray().Where(entity => entity!["name"]!.ToString() == "OrderStatus"))!;
        var wrapper = Assert.Single(signature.Element("ElementSignatures")!.Elements("ElementSignature")
            .Where(element => element.Elements().Any(payload => payload.Name.LocalName == "ReferenceEntity" && (string?)payload.Attribute("OriginalName") == "OrderStatus")));
        var payload = Assert.Single(wrapper.Elements());
        var attributes = payload.Element("Attributes")!.Elements().OrderBy(attribute =>
            int.Parse((string?)attribute.Attribute("Index") ?? "0", System.Globalization.CultureInfo.InvariantCulture)).ToArray();
        var hidden = (bool)NativeStatic("Oml.OmlAttrParser", "GetBoolean", (string?)wrapper.Attribute("Hidden") ?? "");
        var expectedNames = publicStatic ? new[] { "Id", "Label", "Order" } : new[] { "Id" };
        var expectedTypes = publicStatic ? new[] { SystemType(FixedKey("IntegerType")), SystemType(FixedKey("TextType")), SystemType(FixedKey("IntegerType")) }
            : new[] { SystemType(FixedKey("IntegerType")) };
        File.WriteAllText(Path.Combine(work, "order-status-visibility.json"), new JsonObject {
            ["publicStaticVariant"] = publicStatic, ["model"] = status.DeepClone(),
            ["nativeWrapperXml"] = wrapper.ToString(SaveOptions.DisableFormatting),
            ["nativeHidden"] = hidden, ["expectedSignatureFields"] = JsonSerializer.SerializeToNode(expectedNames),
            ["sourceOmlSha256"] = Hash(File.ReadAllBytes(path)), ["readerUsedForThisEvidence"] = false,
            ["browserExecuted"] = false, ["publishedExecution"] = false
        }.ToJsonString());
        Assert.Equal(publicStatic, status["public"]!.GetValue<bool>());
        Assert.Equal(new[] { "Id", "Label", "Order" }, status["attributes"]!.AsArray().Select(attribute => attribute!["name"]!.ToString()));
        Assert.Equal(new[] { "Integer", "Text", "Integer" }, status["attributes"]!.AsArray().Select(attribute => attribute!["type"]!.ToString()));
        Assert.Equal(expectedNames, attributes.Select(attribute => (string?)attribute.Attribute("Name")));
        Assert.Equal(expectedTypes, attributes.Select(attribute => (string?)attribute.Attribute("Type")));
        // Do not assert direct-import rejection from a guessed private marker. If the
        // native XML does not confirm Hidden, this gate fails before that assertion.
        Assert.Equal(!publicStatic, hidden);
    }

    // Expectations come from producer-public.json, service-action.json, client-js-reactive.json
    // and the block source above. They do not come from the reader's parsed signature payload.
    // Native original keys are runtime-created: assert presence/ownership/consistency rather
    // than inventing keys or deriving the expected fields from the catalog under test.
    private sealed record ExpectedRecord(string Name, NativeRecordKind Kind, string? IdentifierStorage,
        (string Name, string Type)[] Fields);
    private static void AssertPublicFixtureSignature(string kind, IReadOnlyList<NativeDependencyBinding> bindings, NativeDependencyProducer producer, bool publicStatic = false)
    {
        var paths = kind switch {
            "server-and-type" => new[] { "Product_GetById", "ProductSummary" },
            "service" => ["Order_GetSummary"], "client" => ["Slugify"], "block" => ["MainFlow/NativeReaderBlock"],
            _ => throw new ArgumentException("Unknown authored fixture kind: " + kind)
        };
        Assert.Equal(paths.Order(StringComparer.Ordinal), bindings.Select(b => b.Requirement.OriginalElementPath).Order(StringComparer.Ordinal));
        Assert.All(bindings, b => {
            Assert.Equal(producer.Binding, b.ProducerBinding); Assert.Equal(producer.ProducerName, b.Requirement.ProducerName);
            Assert.False(string.IsNullOrWhiteSpace(b.OriginalElementKey)); Assert.Null(b.SourceAbi);
            Assert.EndsWith(":@" + producer.ProducerKey + "/" + b.OriginalElementKey, b.NativeReference);
        });
        NativeDependencyBinding Export(string path, NativeDependencyKind expectedKind, string nativeInterface)
        {
            var result = Assert.Single(bindings.Where(b => b.Requirement.OriginalElementPath == path));
            Assert.Equal(expectedKind, result.Requirement.Kind);
            Assert.Equal(nativeInterface + ":@" + producer.ProducerKey + "/" + result.OriginalElementKey, result.NativeReference);
            return result;
        }
        void Type(NativeType actual, string expected, NativeDependencyBinding binding)
        {
            if (expected.StartsWith("record:", StringComparison.Ordinal))
            {
                var record = Assert.IsType<NativeRecord>(actual);
                Assert.True(binding.ReachableTypes.TryGetValue(record.GlobalKey, out var definition), "Missing expected record target " + expected);
                Assert.Equal(expected[7..], definition!.Name); Assert.Equal(NativeRecordKind.Structure, definition.NativeKind);
            }
            else if (expected.StartsWith("id:", StringComparison.Ordinal))
            {
                var parts = expected.Split(':'); var identifier = Assert.IsType<NativeIdentifier>(actual);
                Assert.True(binding.ReachableTypes.TryGetValue(identifier.TargetGlobalKey, out var definition), "Missing expected identifier target " + expected);
                Assert.Equal(parts[1], definition!.Name); Assert.Equal(NativeRecordKind.Entity, definition.NativeKind);
                Assert.Equal(parts[2], identifier.StoragePrimitive); Assert.Equal(parts[2], definition.IdentifierStoragePrimitive);
            }
            else Assert.Equal(new NativePrimitive(expected), Assert.IsType<NativePrimitive>(actual));
        }
        void Parameters(NativeDependencyBinding binding, IReadOnlyList<NativeParameter> actual, bool mandatory, params (string Name, string Type)[] expected)
        {
            Assert.Equal(expected.Select(p => p.Name), actual.Select(p => p.Name));
            Assert.Equal(actual.Count, actual.Select(p => p.OriginalKey).Distinct(StringComparer.Ordinal).Count());
            for (var index = 0; index < expected.Length; index++)
            {
                var parameter = actual[index]; Assert.False(string.IsNullOrWhiteSpace(parameter.OriginalKey));
                Assert.Equal(mandatory, parameter.Mandatory); Type(parameter.Type, expected[index].Type, binding);
                // These four fixtures author no parameter default expression. Native omission and
                // an empty expression are equivalent representations of that absence.
                Assert.True(string.IsNullOrEmpty(parameter.DefaultExpression), "Unexpected parameter default: " + parameter.Name);
            }
        }
        void Closure(NativeDependencyBinding binding, params ExpectedRecord[] expected)
        {
            Assert.Equal(expected.Select(r => r.Name).Order(StringComparer.Ordinal), binding.ReachableTypes.Values.Select(r => r.Name).Order(StringComparer.Ordinal));
            foreach (var record in expected)
            {
                var actual = Assert.Single(binding.ReachableTypes.Values.Where(r => r.Name == record.Name));
                Assert.Equal(record.Kind, actual.NativeKind); Assert.Equal(record.IdentifierStorage, actual.IdentifierStoragePrimitive);
                Assert.True(binding.ReachableTypes.TryGetValue(actual.GlobalKey, out var indexed)); Assert.Same(actual, indexed);
                var nativeInterface = record.Kind == NativeRecordKind.Structure ? "IStructureSignature" : "IEntitySignature";
                Assert.StartsWith(nativeInterface + ":@" + producer.ProducerKey + "/", actual.NativeReference);
                Assert.Equal(record.Fields.Select(f => f.Name), actual.OrderedFields.Select(f => f.Name));
                Assert.Equal(actual.OrderedFields.Count, actual.OrderedFields.Select(f => f.OriginalKey).Distinct(StringComparer.Ordinal).Count());
                for (var index = 0; index < record.Fields.Length; index++)
                {
                    Assert.False(string.IsNullOrWhiteSpace(actual.OrderedFields[index].OriginalKey));
                    Type(actual.OrderedFields[index].Type, record.Fields[index].Type, binding);
                }
            }
        }
        void Callable(NativeDependencyBinding binding)
        { Assert.Empty(binding.Events); Assert.Empty(binding.Placeholders); }
        var product = new ExpectedRecord("Product", NativeRecordKind.Entity, "Long Integer", [("Id", "Long Integer"), ("Name", "Text"), ("Price", "Currency")]);
        var productSummary = new ExpectedRecord("ProductSummary", NativeRecordKind.Structure, null, [("Name", "Text"), ("Price", "Currency")]);
        if (kind == "server-and-type")
        {
            var action = Export("Product_GetById", NativeDependencyKind.ServerAction, "IServerActionSignature"); Callable(action);
            Parameters(action, action.OrderedInputs, true, ("ProductId", "id:Product:Long Integer"));
            Parameters(action, action.OrderedOutputs, false, ("Summary", "record:ProductSummary")); Closure(action, product, productSummary);
            var type = Export("ProductSummary", NativeDependencyKind.Type, "IStructureSignature"); Callable(type);
            Parameters(type, type.OrderedInputs, false); Parameters(type, type.OrderedOutputs, false); Closure(type, productSummary);
            var output = Assert.IsType<NativeRecord>(Assert.Single(action.OrderedOutputs).Type);
            var imported = Assert.Single(type.ReachableTypes.Values);
            Assert.Equal(imported.GlobalKey, output.GlobalKey);
            Assert.Equal(type.NativeReference, action.ReachableTypes[output.GlobalKey].NativeReference);
        }
        else if (kind == "service")
        {
            var action = Export("Order_GetSummary", NativeDependencyKind.ServiceAction, "IServiceActionSignature"); Callable(action);
            Parameters(action, action.OrderedInputs, true, ("OrderId", "id:Order:Long Integer"));
            Parameters(action, action.OrderedOutputs, false, ("Summary", "record:OrderSummary"));
            // Both loaded models contain Id/Label/Order. The private FK target's cached
            // public signature is an identifier-only hidden dependency; the public variant
            // exports all three fields. Model and XML expectations were checked separately.
            Closure(action,
                new("Order", NativeRecordKind.Entity, "Long Integer", [("Id", "Long Integer"), ("Customer", "Text"), ("Total", "Currency"), ("StatusId", "id:OrderStatus:Integer")]),
                new("OrderStatus", NativeRecordKind.Entity, "Integer", publicStatic
                    ? [("Id", "Integer"), ("Label", "Text"), ("Order", "Integer")]
                    : [("Id", "Integer")]),
                new("OrderSummary", NativeRecordKind.Structure, null, [("Customer", "Text"), ("Total", "Currency"), ("Status", "Text")]));
        }
        else if (kind == "client")
        {
            var action = Export("Slugify", NativeDependencyKind.ClientAction, "IClientActionSignature"); Callable(action);
            Parameters(action, action.OrderedInputs, true, ("Text", "Text")); Parameters(action, action.OrderedOutputs, false, ("Slug", "Text")); Closure(action);
        }
        else
        {
            var block = Export("MainFlow/NativeReaderBlock", NativeDependencyKind.Block, "IMobileBlockSignature");
            Parameters(block, block.OrderedInputs, true, ("title", "Text")); Parameters(block, block.OrderedOutputs, false); Closure(block);
            var changed = Assert.Single(block.Events); Assert.Equal("changed", changed.Name); Assert.True(changed.Mandatory);
            Assert.False(string.IsNullOrWhiteSpace(changed.OriginalKey)); Parameters(block, changed.OrderedInputs, true, ("value", "Text"));
            var body = Assert.Single(block.Placeholders); Assert.Equal("Body", body.Name); Assert.False(string.IsNullOrWhiteSpace(body.OriginalKey));
        }
    }

    private static void AssertFixtureOracleRejectsMutations(string kind, IReadOnlyList<NativeDependencyBinding> original, NativeDependencyProducer producer, bool publicStatic = false)
    {
        // Mutate only DTO copies, after the public OML read passed. Do not construct another
        // catalog here: its own consistency validator must not substitute for this oracle.
        var target = original.First(b => b.Requirement.Kind != NativeDependencyKind.Type);
        void Reject(NativeDependencyBinding replacement)
        {
            var changed = original.Select(b => ReferenceEquals(b, target) ? replacement : b).ToArray();
            Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertPublicFixtureSignature(kind, changed, producer, publicStatic));
        }
        Reject(target with { OrderedInputs = [] });
        Reject(target with { OrderedInputs = [target.OrderedInputs[0] with { Type = new NativePrimitive("Boolean") }] });
        Reject(target with { OrderedInputs = [target.OrderedInputs[0] with { Mandatory = false }] });
        if (target.OrderedOutputs.Count > 0)
        {
            Reject(target with { OrderedOutputs = [] });
            Reject(target with { OrderedOutputs = [target.OrderedOutputs[0] with { Type = new NativePrimitive("Boolean") }] });
        }
        if (target.ReachableTypes.Count > 0)
        {
            var definition = target.ReachableTypes.Values.First(d => d.NativeKind == NativeRecordKind.Structure);
            var types = target.ReachableTypes.ToDictionary(p => p.Key, p => p.Value, StringComparer.Ordinal);
            types[definition.GlobalKey] = definition with { OrderedFields = definition.OrderedFields.Skip(1).ToArray() };
            Reject(target with { ReachableTypes = types });
            types = target.ReachableTypes.ToDictionary(p => p.Key, p => p.Value, StringComparer.Ordinal);
            types[definition.GlobalKey] = definition with { OrderedFields = definition.OrderedFields.Select((field, index) => index == 0 ? field with { Type = new NativePrimitive("Boolean") } : field).ToArray() };
            Reject(target with { ReachableTypes = types });
            types = target.ReachableTypes.ToDictionary(p => p.Key, p => p.Value, StringComparer.Ordinal); types.Remove(definition.GlobalKey);
            Reject(target with { ReachableTypes = types });
        }
        if (kind == "block")
        {
            var changed = Assert.Single(target.Events);
            Reject(target with { Events = [changed with { OrderedInputs = [] }] });
            Reject(target with { Events = [changed with { OrderedInputs = [changed.OrderedInputs[0] with { Type = new NativePrimitive("Integer") }] }] });
            Reject(target with { Events = [changed with { Mandatory = false }] });
            Reject(target with { Placeholders = [] });
        }
        // The original objects are still independently required to satisfy the authored schema.
        if (kind == "service")
        {
            var status = target.ReachableTypes.Values.Single(type => type.Name == "OrderStatus");
            var changedTypes = target.ReachableTypes.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
            changedTypes[status.GlobalKey] = status with { OrderedFields = publicStatic
                ? status.OrderedFields.Where(field => field.Name != "Label").ToArray()
                : status.OrderedFields.Concat([status.OrderedFields[0] with { Name = "Label", Type = new NativePrimitive("Text") }]).ToArray() };
            Reject(target with { ReachableTypes = changedTypes });
        }
        AssertPublicFixtureSignature(kind, original, producer, publicStatic);
    }

    // No production entry point can reach this path. Reflection isolates decoder/closure unit
    // coverage from the mandatory native-OML evidence gate; this is never identity attestation.
    private static NativeDependencyCatalog ReadSyntheticPayloadForStructuralTests(
        IReadOnlyList<NativeDependencyRequirement> requirements, IReadOnlyList<NativeDependencyProducer> producers,
        IReadOnlyDictionary<string, string> paths)
    {
        try
        {
            const System.Reflection.BindingFlags hidden = System.Reflection.BindingFlags.NonPublic;
            var type = typeof(NativeDependencyReader);
            var fileType = type.GetNestedType("ProducerFile", hidden)!;
            var files = Array.CreateInstance(fileType, producers.Count);
            var validate = type.GetMethod("ValidateSignature", hidden | System.Reflection.BindingFlags.Static)!;
            for (var index = 0; index < producers.Count; index++)
            {
                var producer = producers[index]; var bytes = File.ReadAllBytes(paths[producer.Binding]);
                Assert.Equal(producer.SignatureFileSha256, Hash(bytes));
                var envelope = JsonNode.Parse(bytes)!; var binary = Convert.FromBase64String(envelope["SignatureBinary"]!.ToString());
                using var stream = new MemoryStream(binary, writable: false);
                // The overload consumes Stream; avoid concrete MemoryStream method resolution.
                var createReader = NativeType("Oml.Oml").GetMethod("CreateXmlReader", [typeof(Stream)])!;
                using var reader = (System.Xml.XmlReader)createReader.Invoke(null, [stream])!;
                var signature = XElement.Load(reader);
                files.SetValue(validate.Invoke(null, [producer, paths[producer.Binding], signature]), index);
            }
            var indexType = type.GetNestedType("Index", hidden)!;
            var nativeIndex = Activator.CreateInstance(indexType, System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | hidden,
                null, new object[] { files }, null)!;
            var bind = indexType.GetMethod("Bind", [typeof(NativeDependencyRequirement)])!;
            var bindings = requirements.Select(requirement => (NativeDependencyBinding)bind.Invoke(nativeIndex, [requirement])!).ToArray();
            return new NativeDependencyCatalog(producers, bindings);
        }
        catch (System.Reflection.TargetInvocationException error) when (error.InnerException != null)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw();
            throw;
        }
    }

    private sealed class SignatureFixture
    {
        public readonly ObjectKey ProducerKey = ObjectKey.NewKey(), OtherProducerKey = ObjectKey.NewKey(), ActionKey = ObjectKey.NewKey();
        private readonly ObjectKey remoteKey = ObjectKey.NewKey();
        public readonly List<XElement> Wrappers = [];
        public readonly XElement Search;
        private readonly XElement remote;
        private readonly string originalHash;
        public NativeDependencyRequirement Request => new("page.html::Page::search", NativeDependencyKind.ServerAction, "Producer", "Search");
        public SignatureFixture()
        {
            Search = new XElement("ReferenceAction", new XAttribute("OriginalName", "Search"), new XAttribute("Name", "ConsumerSearch"),
                new XElement("InputParameters", Parameter("Second", SystemType(FixedKey("TextType")), true), Parameter("First", SystemType(FixedKey("TextType")), false, "\"default text\"")),
                new XElement("OutputParameters", Parameter("Result", SystemType(FixedKey("TextType")), false, output: true)));
            Add(ActionKey, Search);
            var flow = ObjectKey.NewKey(); Add(flow, new XElement("NewRuntime.ReferenceWebFlow", new XAttribute("OriginalName", "OriginalFlow")));
            var ev = new XElement("ReferenceWebBlockCustomEvent", new XAttribute("Name", "Changed"), new XAttribute("OriginalKey", ObjectKey.NewKey()),
                new XElement("InputParameters", Parameter("Value", SystemType(FixedKey("TextType")), true)));
            SetBoolean(ev, "IsMandatory", true);
            Add(ObjectKey.NewKey(), new XElement("NewRuntime.ReferenceWebBlock", new XAttribute("OriginalName", "Card"),
                new XElement("InputParameters", Parameter("Title", SystemType(FixedKey("TextType")), true)), new XElement("CustomEvents", ev),
                new XElement("ReferenceWidgets", Placeholder("Body"), Placeholder("Footer"))), parent: flow);
            var entity = ObjectKey.NewKey(); var entityId = ObjectKey.NewKey();
            Add(entity, new XElement("ReferenceEntity", new XAttribute("OriginalName", "Product"),
                new XAttribute("Identifier", "ReferenceEntityAttribute:" + ProducerKey + "/ReferenceEntities." + entity + "/Attributes." + entityId),
                new XElement("Attributes", new XElement("ReferenceEntityAttribute", new XAttribute("Name", "Id"), new XAttribute("OriginalKey", entityId), new XAttribute("Type", SystemType(FixedKey("LongIntegerType")))))));
            var list1 = ObjectKey.NewKey(); var list2 = ObjectKey.NewKey();
            Add(list1, new XElement("ListType", new XAttribute("UniqueId", list1.ToString("DB")), new XAttribute("ElementType", SystemType(FixedKey("TextType")))));
            Add(list2, new XElement("ListType", new XAttribute("UniqueId", list2.ToString("DB")), new XAttribute("ElementType", "ListType:ListTypes." + list1)));
            Add(ObjectKey.NewKey(), new XElement("ReferenceStructure", new XAttribute("OriginalName", "Envelope"),
                new XElement("Attributes", Field("Rows", "ListType:ListTypes." + list2), Field("ProductId", "EntityIdentifierType:" + ProducerKey + "/ReferenceEntities." + entity + "/IdentifierType." + ObjectKey.NewKey()))));
            Add(ObjectKey.NewKey(), new XElement("ReferenceAction", new XAttribute("OriginalName", "Foreign"),
                new XElement("OutputParameters", Parameter("Data", "ReferenceStructure:" + OtherProducerKey + "/ReferenceStructures." + remoteKey, false, output: true))), dependencies: [new GlobalObjectKey(OtherProducerKey, remoteKey)]);
            remote = Wrap(remoteKey, new XElement("ReferenceStructure", new XAttribute("OriginalName", "RemoteRecord"), new XElement("Attributes", Field("Label", SystemType(FixedKey("TextType"))))));
            originalHash = SignatureHash(Document(Wrappers));
        }
        private void Add(ObjectKey key, XElement xml, ObjectKey? parent = null, GlobalObjectKey[]? dependencies = null) => Wrappers.Add(Wrap(key, xml, parent, dependencies));
        public void RefreshElementHashes()
        {
            for (var i = 0; i < Wrappers.Count; i++)
            {
                var wrapper = Wrappers[i]; var key = Keys.Parse((string)wrapper.Attribute("OriginalKey")!);
                var parent = (string?)wrapper.Attribute("ParentOriginalKey");
                var dependencies = ((string?)wrapper.Attribute("ExternalDependencies") ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(GlobalObjectKey.Parse).ToArray();
                Wrappers[i] = Wrap(key, new XElement(wrapper.Elements().Single()), parent == null ? null : Keys.Parse(parent), dependencies,
                    (string?)wrapper.Attribute("Hidden") == NativeTrue());
            }
        }
        public (NativeDependencyProducer[] Producers, Dictionary<string, string> Paths) Freeze(bool includeOther, bool keepOldSignatureHash)
        {
            var work = Work(); var producers = new List<NativeDependencyProducer>(); var paths = new Dictionary<string, string>();
            void Save(string binding, string name, ObjectKey key, XElement xml, string? expectedHash = null)
            {
                var path = Path.Combine(work, binding + ".avsig"); var hash = expectedHash ?? SignatureHash(xml);
                var snapshot = new JsonObject { ["FormatVersion"] = 1, ["Environment"] = "fixture.invalid", ["ModuleKey"] = key.ToString(), ["ApplicationKey"] = "", ["Name"] = name,
                    ["ModuleKind"] = "eSpace", ["ModuleType"] = "Mobile", ["SignatureHash"] = hash,
                    ["SignatureBinary"] = Convert.ToBase64String((byte[])NativeStatic("Oml.Oml", "SerializeSignature", xml)), ["Elements"] = new JsonArray() };
                // Synthetic unsigned payload transport used only by the private-parser unit helper.
                // Public Read rejects it: this header never attests producer identity.
                File.WriteAllText(path, snapshot.ToJsonString());
                paths.Add(binding, path); producers.Add(new(binding, "fixture.invalid", key.ToString(), name, "eSpace", "Mobile", 1, hash, Hash(File.ReadAllBytes(path))));
            }
            Save("Frozen", "Producer", ProducerKey, Document(Wrappers), keepOldSignatureHash ? originalHash : null);
            if (includeOther) Save("Other", "OtherProducer", OtherProducerKey, Document([remote]));
            return (producers.ToArray(), paths);
        }
    }

    private static XElement Wrap(ObjectKey key, XElement xml, ObjectKey? parent = null, GlobalObjectKey[]? dependencies = null, bool hidden = false)
    {
        var native = Activator.CreateInstance(NativeType("Oml.Signatures.FullElementSignature"), key, new XElement(xml), dependencies ?? [], xml, hidden, parent)!;
        return (XElement)NativeCall(native, "Save");
    }
    private static XElement Document(IEnumerable<XElement> wrappers, string? elementsOrderVersion = null) => new("Signature", new XAttribute("ESpaceType", "Mobile"),
        new XAttribute("ElementsOrderVersion", elementsOrderVersion ?? NativeType("ModelConstants").GetProperty("CurrentElementsOrderVersion")!.GetValue(null)!),
        new XElement("AnonymousTypesNames"), new XElement("ElementSignatures", wrappers));
    private static string SignatureHash(XElement xml) => NativeStatic("Oml.OmlAttrParser", "GetGuid", NativeStatic("Oml.Signatures.SignatureHasher", "CalculateHash", xml)).ToString()!;
    private static XElement Parameter(string name, string type, bool mandatory, string? value = null, bool output = false)
    {
        var p = new XElement(output ? "Variables.ReferenceGenericOutputParameter" : "Variables.ReferenceGenericInputParameter",
            new XAttribute("Name", name), new XAttribute("OriginalKey", ObjectKey.NewKey()), new XAttribute("Type", type));
        SetBoolean(p, "IsMandatory", mandatory);
        p.Add(new XElement("DefaultValue", value == null ? null : new XElement("ReferenceExpression", new XAttribute("Text", value)))); return p;
    }
    private static XElement Field(string name, string type) => new("ReferenceStructureAttribute", new XAttribute("Name", name), new XAttribute("OriginalKey", ObjectKey.NewKey()), new XAttribute("Type", type));
    private static XElement Placeholder(string name) => new("NRWebWidgets.ReferencePlaceholder", new XAttribute("Name", name), new XAttribute("OriginalKey", ObjectKey.NewKey()));
    private static void SetBoolean(XElement element, string name, bool value)
    {
        Action<string, string> attribute = (n, v) => element.SetAttributeValue(n, v);
        Action<string, string> child = (n, v) => element.Add(new XElement(n, v));
        var serializer = Activator.CreateInstance(NativeType("Oml.Signatures.SignatureAttributeSerializer`1").MakeGenericType(typeof(string)), attribute, child)!;
        NativeCall(serializer, "AddAttribute", name, value);
    }
    private static string NativeTrue() { var element = new XElement("x"); SetBoolean(element, "v", true); return (string)element.Attribute("v")!; }
    private static string SystemType(ObjectKey key)
    {
        var type = Type.GetType("OutSystems.MetaModel.CompoundKeys.SystemCompoundKey, OutSystems.MetaModel", throwOnError: true)!;
        return NativeCall(Activator.CreateInstance(type, key)!, "SerializeToString").ToString()!;
    }
    private static ObjectKey FixedKey(string name) => (ObjectKey)NativeType("FixedKeys").GetField(name)!.GetValue(null)!;
    // Tests intentionally keep vendor implementation/model assemblies out of the test project's
    // references. Bind first, then invoke the exact statically inspected native APIs by reflection.
    private static Type NativeType(string name) => Type.GetType("OutSystems.Model.Implementation." + name + ", OutSystems.Model.Implementation", throwOnError: true)!;
    private static object NativeStatic(string type, string name, params object[] arguments)
        => NativeType(type).GetMethod(name, arguments.Select(a => a.GetType()).ToArray())!.Invoke(null, arguments)!;
    private static object NativeCall(object instance, string name, params object[] arguments)
        => instance.GetType().GetMethod(name, arguments.Select(a => a.GetType()).ToArray())!.Invoke(instance, arguments)!;
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
