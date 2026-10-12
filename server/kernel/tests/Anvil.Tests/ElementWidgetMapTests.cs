using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Anvil.Core;
using Xunit;
namespace Anvil.Tests;

/// <summary>
/// The one element-to-widget table (docs/PROTOTIPO-NATIVO.md 3.2, ElementWidgetMap): one case per row on both platforms, the
/// substitutions, the submit rule, the names and the attributes; the frozen tag lists equal to the lists re-extracted from the
/// validators of the installed Studios; the seam of the importer (PrototypeSeams.Element) is this table; every element of the
/// rendered FarmaVirtual prototype maps without a problem on both platforms.
/// </summary>
public sealed class ElementWidgetMapTests
{
    private const string O11 = ElementWidgetMap.O11, Odc = ElementWidgetMap.Odc;

    // ---- the frozen lists ----------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("o11", @"C:\Program Files\OutSystems\Service Studio 11\Service Studio\Plugins\ServiceStudio\ServiceStudio.Plugin.NRWidgets.dll", 103)]
    [InlineData("odc", @"C:\Program Files\OutSystems\ODC Studio\ODC Studio\OutSystems.Model.Plugin.NRWidgets.dll", 100)]
    public void TheFrozenTagListsAreTheOnesOfTheInstalledValidators(string platform, string defaultDll, int count)
    {
        Assert.Equal(count, ElementWidgetMap.Tags(platform).Count);
        var dll = Installed(platform, defaultDll);
        if (dll == null) return; // no Studio of that platform on this machine: the frozen list stands (like the other Studio tests)
        var extracted = ValidatorTags(dll);
        Assert.Equal(count, extracted.Count);
        Assert.Equal(extracted, ElementWidgetMap.Tags(platform));
    }

    [Fact] public void OdcIsTheO11ListWithoutDataMainAndPicture()
    {
        Assert.Equal(ElementWidgetMap.O11Tags.Except(ElementWidgetMap.OdcTags).Order(StringComparer.Ordinal), new[] { "data", "main", "picture" });
        Assert.Empty(ElementWidgetMap.OdcTags.Except(ElementWidgetMap.O11Tags));
        foreach (var never in new[] { "dialog", "svg", "path", "template", "slot", "br" }) { Assert.False(ElementWidgetMap.Accepts(O11, never)); Assert.False(ElementWidgetMap.Accepts(Odc, never)); }
    }

    // ---- one case per row of 3.2, both platforms ------------------------------------------------------------------------

    [Theory] [InlineData("o11")] [InlineData("odc")]
    public void ADivIsAContainerWithItsClassOnStyleAndItsAttributesAsExtendedProperties(string platform)
    {
        var map = Map(platform, "div", ("class", "product-grid"), ("data-x", "1"), ("role", "list"), ("style", "gap:4px"));
        Assert.Equal("IContainer", map.Widget);
        Assert.Contains(("Style", "\"product-grid\""), map.Properties);
        Assert.Contains(("CustomStyle", "gap:4px"), map.Properties);
        Assert.Contains(("data-x", "\"1\""), map.ExtendedProperties); Assert.Contains(("role", "\"list\""), map.ExtendedProperties);
        Assert.DoesNotContain(map.ExtendedProperties, e => e.Name is "class" or "style");
        Assert.Null(map.Problem);
    }

    [Theory] [InlineData("o11")] [InlineData("odc")]
    public void AClickableElementThatIsNotALinkOrAButtonKeepsItsTagWithAnOnclickEvent(string platform)
    {
        var map = Map(platform, "div", true, ("class", "product-image-wrap"), ("role", "button"), ("tabindex", "0"));
        Assert.Equal("IAdvancedHtml", map.Widget); Assert.Equal("div", map.Tag);
        Assert.Contains(("Event", "onclick"), map.Properties);
        Assert.Contains(("class", "\"product-image-wrap\""), map.ExtendedProperties);
        Assert.Contains(("role", "\"button\""), map.ExtendedProperties); Assert.Contains(("tabindex", "\"0\""), map.ExtendedProperties);
        var span = Map(platform, "span", true);
        Assert.Equal("IAdvancedHtml", span.Widget); Assert.Contains(("Event", "onclick"), span.Properties);
        // the fallback of 3.2 when the Verify refuses the event: a Link with ssam-tag-<tag> (ElementWidgetMap.ElementEvents false)
        Assert.True(ElementWidgetMap.ElementEvents);
        var fallback = ElementWidgetMap.Map(new ElementRequest(platform, "div", [("class", "product-image-wrap")], true, false, false, false), elementEvents: false);
        Assert.Equal("ILink", fallback.Widget);
        Assert.Equal(new[] { "product-image-wrap", "ssam-tag-div" }, fallback.Classes);
        Assert.DoesNotContain(("Event", "onclick"), fallback.Properties);
    }

    [Theory] [InlineData("o11")] [InlineData("odc")]
    public void AButtonIsAButtonDisabledIsEnabledFalseAndASubmitIsNeverTypeSubmit(string platform)
    {
        var plain = Map(platform, "button", ("class", "btn"), ("type", "button"), ("disabled", ""));
        Assert.Equal("IButton", plain.Widget);
        Assert.Contains(("Style", "\"btn\""), plain.Properties); Assert.Contains(("Enabled", "False"), plain.Properties);
        Assert.DoesNotContain(plain.ExtendedProperties, e => e.Name is "type" or "disabled");
        Assert.DoesNotContain(("IsDefault", "True"), plain.Properties);
        // empty with aria-label: a button like any other (H5)
        var empty = Map(platform, "button", ("class", "switch"), ("role", "switch"), ("aria-label", "Ativar"));
        Assert.Null(empty.Problem); Assert.Contains(("aria-label", "\"Ativar\""), empty.ExtendedProperties);
        Assert.True(ElementWidgetMap.Labelled([("aria-label", "Ativar")])); Assert.True(ElementWidgetMap.Labelled([("title", "Fechar")])); Assert.False(ElementWidgetMap.Labelled([("class", "x")]));
        foreach (var submit in new[] { Request(platform, "button", false, true, false, [("type", "submit"), ("class", "primary")]), Request(platform, "button", false, true, false, [("class", "primary")]) })
        {
            Assert.Contains(("IsDefault", "True"), submit.Properties);
            Assert.Contains("ssam-submit", submit.Classes);
            Assert.DoesNotContain(submit.ExtendedProperties, e => e.Name == "type");
        }
        // outside a form a submit has nothing to submit: IsDefault needs a Form (Verify), the class stays for the author's rules
        var loose = Map(platform, "button", ("type", "submit"), ("class", "primary"));
        Assert.DoesNotContain(("IsDefault", "True"), loose.Properties);
        Assert.Contains("ssam-submit", loose.Classes);
        Assert.DoesNotContain(loose.ExtendedProperties, e => e.Name == "type");
    }

    [Theory] [InlineData("o11")] [InlineData("odc")]
    public void ARouteLinkIsALinkAndAnExternalLinkKeepsItsHref(string platform)
    {
        var route = Map(platform, "a", ("class", "nav-link"), ("href", "#catalogo"));
        Assert.Equal("ILink", route.Widget); Assert.DoesNotContain(route.ExtendedProperties, e => e.Name == "href");
        var external = Map(platform, "a", ("href", "https://example.test/x"), ("target", "_blank"), ("rel", "noopener"));
        Assert.Equal("ILink", external.Widget);
        Assert.Contains(("href", "\"https://example.test/x\""), external.ExtendedProperties);
        Assert.Contains(("target", "\"_blank\""), external.ExtendedProperties); Assert.Contains(("rel", "\"noopener\""), external.ExtendedProperties);
    }

    [Theory] [InlineData("o11")] [InlineData("odc")]
    public void AFormIsAForm(string platform)
    {
        var form = Map(platform, "form", ("class", "checkout"), ("novalidate", ""));
        Assert.Equal("IForm", form.Widget); Assert.Contains(("Style", "\"checkout\""), form.Properties);
        Assert.Contains(("novalidate", "\"\""), form.ExtendedProperties);
    }

    [Theory]
    [InlineData("o11", "text", "Text")] [InlineData("odc", "search", "Search")] [InlineData("o11", "email", "Email")] [InlineData("odc", "number", "Number")]
    [InlineData("o11", "tel", "Phone")] [InlineData("odc", "password", "Password")] [InlineData("o11", "date", "Date")] [InlineData("odc", "time", "Time")]
    public void AnInputIsAnInputWithItsTypeItsPromptItsLimitsAndItsValueAsTheDefault(string platform, string type, string inputType)
    {
        var map = Map(platform, "input", ("type", type), ("name", "q"), ("placeholder", "Buscar"), ("maxlength", "120"), ("required", ""), ("value", "x"),
            ("min", "1"), ("max", "9"), ("step", "1"), ("minlength", "3"), ("autocomplete", "off"), ("id", "catalog-search"));
        Assert.Equal("IInput", map.Widget);
        Assert.Contains(("InputType", inputType), map.Properties);
        Assert.Contains(("Prompt", "\"Buscar\""), map.Properties); Assert.Contains(("MaxLength", "120"), map.Properties);
        Assert.Contains(("Mandatory", "True"), map.Properties); Assert.Contains(("DefaultValue", "\"x\""), map.Properties);
        foreach (var attribute in new[] { "name", "min", "max", "step", "minlength", "autocomplete" }) Assert.Contains(map.ExtendedProperties, e => e.Name == attribute);
        Assert.DoesNotContain(map.ExtendedProperties, e => e.Name is "type" or "placeholder" or "maxlength" or "required" or "value" or "id");
        Assert.Equal("catalog_search", map.Name);
    }

    [Theory] [InlineData("o11")] [InlineData("odc")]
    public void ACheckboxARadioASelectAndATextAreaAreTheirControls(string platform)
    {
        var checkbox = Map(platform, "input", ("type", "checkbox"), ("checked", ""), ("id", "available-filter"));
        Assert.Equal("ICheckbox", checkbox.Widget); Assert.Contains(("DefaultValue", "True"), checkbox.Properties);
        var radio = Map(platform, "input", ("type", "radio"), ("name", "status"), ("value", "2"));
        Assert.Equal("IRadioButton", radio.Widget); Assert.Contains(("RadioGroup", "status"), radio.Properties); Assert.Contains(("DefaultValue", "\"2\""), radio.Properties);
        var select = Map(platform, "select", ("id", "account-select"), ("aria-label", "Conta"));
        Assert.Equal("IDropdown", select.Widget); Assert.Equal("account_select", select.Name);
        var area = Map(platform, "textarea", ("name", "Observacao"), ("maxlength", "500"), ("placeholder", "Opcional"));
        Assert.Equal("ITextArea", area.Widget); Assert.Contains(("MaxLength", "500"), area.Properties); Assert.Contains(("Prompt", "\"Opcional\""), area.Properties);
        Assert.Contains(("name", "\"Observacao\""), area.ExtendedProperties);
        Assert.Equal("ICheckbox", Map(platform, "input", ("type", "checkbox"), ("disabled", "")).Widget);
        Assert.Contains(("Enabled", "False"), Map(platform, "input", ("type", "checkbox"), ("disabled", "")).Properties);
    }

    [Theory] [InlineData("o11")] [InlineData("odc")]
    public void ALabelAroundItsControlIsAnHtmlElementLabelAndALabelOfTextIsALabel(string platform)
    {
        var wrapper = Request(platform, "label", false, false, true, [("class", "input-search"), ("for", "x")]);
        Assert.Equal("IAdvancedHtml", wrapper.Widget); Assert.Equal("label", wrapper.Tag);
        Assert.Contains(("for", "\"x\""), wrapper.ExtendedProperties); Assert.Contains(("class", "\"input-search\""), wrapper.ExtendedProperties);
        var text = Map(platform, "label", ("for", "catalog-sort"), ("class", "lbl"));
        Assert.Equal("ILabel", text.Widget); Assert.Contains(("TargetWidget", "catalog-sort"), text.Properties); Assert.Contains(("Style", "\"lbl\""), text.Properties);
    }

    [Theory]
    [InlineData("o11", "table")] [InlineData("odc", "thead")] [InlineData("o11", "tbody")] [InlineData("odc", "tr")] [InlineData("o11", "th")] [InlineData("odc", "td")]
    [InlineData("o11", "caption")] [InlineData("odc", "ul")] [InlineData("o11", "li")] [InlineData("odc", "h1")] [InlineData("o11", "p")] [InlineData("odc", "span")]
    [InlineData("o11", "strong")] [InlineData("odc", "small")] [InlineData("o11", "section")] [InlineData("odc", "article")] [InlineData("o11", "nav")] [InlineData("odc", "aside")]
    [InlineData("o11", "hr")] [InlineData("odc", "i")] [InlineData("o11", "main")] [InlineData("o11", "header")] [InlineData("odc", "footer")]
    public void EveryOtherTagOfThePlatformIsAnHtmlElementOfThatTag(string platform, string tag)
    {
        var map = Map(platform, tag, ("class", "x"), ("colspan", "2"));
        Assert.Equal("IAdvancedHtml", map.Widget); Assert.Equal(tag, map.Tag); Assert.Contains(("Tag", tag), map.Properties);
        Assert.Contains(("class", "\"x\""), map.ExtendedProperties); Assert.Contains(("colspan", "\"2\""), map.ExtendedProperties);
        Assert.Null(map.SubstitutedFrom); Assert.Null(map.Problem);
    }

    [Theory] [InlineData("o11")] [InlineData("odc")]
    public void AnIconIsASpanWithItsClassesAndSsamIcon(string platform)
    {
        var map = ElementWidgetMap.Map(new ElementRequest(platform, "svg", [("class", "lucide lucide-plus icon"), ("aria-hidden", "true")], false, true, false, false));
        Assert.Equal("IAdvancedHtml", map.Widget); Assert.Equal("span", map.Tag);
        Assert.Equal(new[] { "lucide", "lucide-plus", "icon", "ssam-icon" }, map.Classes);
        Assert.Contains(("aria-hidden", "\"true\""), map.ExtendedProperties);
        Assert.Null(map.SubstitutedFrom);
    }

    [Theory] [InlineData("o11")] [InlineData("odc")]
    public void AnImageIsAStaticModuleImageOrAnExternalUrl(string platform)
    {
        var local = Map(platform, "img", ("src", "assets/products.png"), ("alt", "Produtos"), ("loading", "lazy"));
        Assert.Equal("IImage", local.Widget); Assert.Contains(("Type", "Static"), local.Properties);
        Assert.Contains(("alt", "\"Produtos\""), local.ExtendedProperties); Assert.Contains(("loading", "\"lazy\""), local.ExtendedProperties);
        Assert.DoesNotContain(local.ExtendedProperties, e => e.Name == "src");
        var remote = Map(platform, "img", ("src", "https://cdn.example.test/p.png"));
        Assert.Contains(("Type", "External"), remote.Properties); Assert.Contains(("Url", "\"https://cdn.example.test/p.png\""), remote.Properties);
    }

    [Theory] [InlineData("o11")] [InlineData("odc")]
    public void TheIdNamesTheWidgetAndInlineScriptNeverBecomesAnAttribute(string platform)
    {
        var map = Map(platform, "section", ("id", "header-search"), ("onclick", "go()"), ("onchange", "x()"), ("data-action", "add"), ("aria-live", "polite"));
        Assert.Equal("header_search", map.Name);
        Assert.DoesNotContain(map.ExtendedProperties, e => e.Name is "id" or "onclick" or "onchange");
        Assert.Contains(("data-action", "\"add\""), map.ExtendedProperties); Assert.Contains(("aria-live", "\"polite\""), map.ExtendedProperties);
        Assert.Equal("FvAvailable", ElementWidgetMap.NameFromId("FvAvailable"));
        Assert.Equal("Id_1tile", ElementWidgetMap.NameFromId("1tile"));
        Assert.Null(ElementWidgetMap.NameFromId(" "));
        Assert.Equal("ssam-id-app", ElementWidgetMap.IdClass("app"));
    }

    // ---- substitutions ----------------------------------------------------------------------------------------------------

    [Theory] [InlineData("o11")] [InlineData("odc")]
    public void ADialogIsADivWithSsamTagDialogKeepingItsOpenAttribute(string platform)
    {
        var map = Map(platform, "dialog", ("id", "modal"), ("class", "product-modal"), ("open", ""), ("aria-labelledby", "modal-title"));
        Assert.Equal("IContainer", map.Widget); Assert.Equal("dialog", map.SubstitutedFrom);
        Assert.Equal(new[] { "product-modal", "ssam-tag-dialog" }, map.Classes);
        Assert.Contains(("open", "\"\""), map.ExtendedProperties);
        Assert.Equal("modal", map.Name);
    }

    [Theory] [InlineData("o11")] [InlineData("odc")]
    public void ABreakIsAnEmptyContainer(string platform)
    {
        var map = Map(platform, "br");
        Assert.Equal("IContainer", map.Widget); Assert.Empty(map.Classes); Assert.Equal("br", map.SubstitutedFrom);
    }

    [Fact] public void MainIsAnHtmlElementInO11AndADivWithRoleMainInOdc()
    {
        var o11 = Map(O11, "main", ("class", "app-main"));
        Assert.Equal("IAdvancedHtml", o11.Widget); Assert.Equal("main", o11.Tag); Assert.Null(o11.SubstitutedFrom);
        var odc = Map(Odc, "main", ("class", "app-main"));
        Assert.Equal("IContainer", odc.Widget); Assert.Equal("main", odc.SubstitutedFrom);
        Assert.Equal(new[] { "app-main", "ssam-tag-main" }, odc.Classes); Assert.Contains(("role", "\"main\""), odc.ExtendedProperties);
        Assert.DoesNotContain(Map(Odc, "main", ("role", "region")).ExtendedProperties, e => e == ("role", "\"main\""));
    }

    [Theory] [InlineData("o11", "search")] [InlineData("odc", "menuitem")] [InlineData("o11", "my-card")] [InlineData("odc", "product-tile")]
    public void SearchMenuitemAndCustomElementsAreDivsWithTheirTagClass(string platform, string tag)
    {
        var map = Map(platform, tag, ("class", "x"));
        Assert.Equal("IContainer", map.Widget); Assert.Equal(tag, map.SubstitutedFrom);
        Assert.Equal(new[] { "x", "ssam-tag-" + tag }, map.Classes); Assert.Contains(("Style", "\"x ssam-tag-" + tag + "\""), map.Properties);
    }

    [Fact] public void DataAndPictureAreSpansInOdcAndThemselvesInO11()
    {
        foreach (var tag in new[] { "data", "picture" })
        {
            var odc = Map(Odc, tag, ("value", "42"));
            Assert.Equal("IAdvancedHtml", odc.Widget); Assert.Equal("span", odc.Tag); Assert.Equal(tag, odc.SubstitutedFrom);
            Assert.Contains("ssam-tag-" + tag, odc.Classes); Assert.Contains(("value", "\"42\""), odc.ExtendedProperties);
            var o11 = Map(O11, tag, ("value", "42"));
            Assert.Equal("IAdvancedHtml", o11.Widget); Assert.Equal(tag, o11.Tag); Assert.Null(o11.SubstitutedFrom);
        }
    }

    [Theory] [InlineData("o11")] [InlineData("odc")]
    public void ANonIconSvgIsAnImageOfItsMarkupAndTemplateSlotScriptStyleAreNoWidget(string platform)
    {
        var svg = Map(platform, "svg", ("viewBox", "0 0 24 24"), ("class", "chart"));
        Assert.Equal("IImage", svg.Widget); Assert.Contains(("ImageMarkup", "svg"), svg.Properties); Assert.Contains("ssam-tag-svg", svg.Classes);
        foreach (var tag in new[] { "template", "slot", "script", "style" }) Assert.Equal("", Map(platform, tag).Widget);
        var unknown = Map(platform, "marquee");
        Assert.NotNull(unknown.Problem); Assert.Contains("marquee", unknown.Problem);
    }

    // ---- the seam and the prototype ---------------------------------------------------------------------------------------

    [Fact] public void TheSeamOfTheImporterIsThisTable()
    {
        Assert.NotNull(PrototypeSeams.Element);
        var request = new ElementRequest(O11, "div", [("class", "a"), ("id", "app")], false, false, false, true);
        var viaSeam = PrototypeSeams.Element!(request); var direct = ElementWidgetMap.Map(request);
        Assert.Equal(direct.Widget, viaSeam.Widget); Assert.Equal(direct.Name, viaSeam.Name); Assert.Equal(direct.Properties, viaSeam.Properties);
    }

    [Theory] [InlineData("o11")] [InlineData("odc")]
    public void EveryElementOfTheRenderedFarmaVirtualMapsWithoutAProblem(string platform)
    {
        var elements = 0; var carried = 0;
        foreach (var (_, html) in HtmlPageFixtures.Views())
            foreach (var node in HtmlSource.Parse(html).Descendants().Where(n => !n.IsText))
            {
                var inForm = false; // the submit rule is proved above; here every element and attribute
                var map = ElementWidgetMap.Map(platform, node, clickable: node.Attribute("data-action") != null && node.Tag is not ("a" or "button"), inForm);
                Assert.True(map.Problem == null, $"<{node.Tag}>: {map.Problem}");
                Assert.NotEqual("", map.Widget);
                elements++;
                foreach (var (name, _) in node.Attributes.Where(a => !ElementWidgetMap.LegacyAttributes.Contains(a.Key) && !a.Key.StartsWith("aria-") && !a.Key.StartsWith("data-")))
                    if (map.ExtendedProperties.Any(e => e.Name == name) || map.Properties.Any(p => p.Property is "Enabled" or "DefaultValue" or "RadioGroup")) carried++;
            }
        Assert.True(elements > 922); // the shell repeats in every view
        Assert.True(carried >= 57);
        Assert.Equal(platform == Odc ? "IContainer" : "IAdvancedHtml", ElementWidgetMap.Map(platform, HtmlSource.Parse("<main class=\"x\"></main>").Elements.Single(), false).Widget);
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------------

    private static ElementMapping Map(string platform, string tag, params (string, string)[] attributes) => Request(platform, tag, false, false, false, attributes);
    private static ElementMapping Map(string platform, string tag, bool clickable, params (string, string)[] attributes) => Request(platform, tag, clickable, false, false, attributes);
    private static ElementMapping Request(string platform, string tag, bool clickable, bool insideForm, bool hasChildren, (string, string)[] attributes)
        => ElementWidgetMap.Map(new ElementRequest(platform, tag, attributes, clickable, false, insideForm, hasChildren));

    private static string? Installed(string platform, string fallback)
    {
        if (File.Exists(fallback)) return fallback;
        var dir = platform == O11 ? Environment.GetEnvironmentVariable("ANVIL_STUDIO_DIR") : Environment.GetEnvironmentVariable("ANVIL_ODC_STUDIO_DIR");
        if (dir == null) return null;
        var name = platform == O11 ? "ServiceStudio.Plugin.NRWidgets.dll" : "OutSystems.Model.Plugin.NRWidgets.dll";
        return Directory.Exists(dir) ? Directory.EnumerateFiles(dir, name, SearchOption.AllDirectories).FirstOrDefault() : null;
    }

    /// <summary>The tag list of the HtmlValidator of an installed NRWidgets DLL: the string loads of its static constructor right
    /// after the name regex ^[0-9a-z]+[0-9a-z-]* (the IL beside "' is not a valid HTML tag."), read without loading the DLL.</summary>
    private static List<string> ValidatorTags(string dll)
    {
        using var stream = File.OpenRead(dll);
        using var pe = new PEReader(stream);
        var md = pe.GetMetadataReader();
        foreach (var type in md.TypeDefinitions.Select(md.GetTypeDefinition))
        {
            if (md.GetString(type.Name) != "HtmlValidator") continue;
            foreach (var method in type.GetMethods().Select(md.GetMethodDefinition))
            {
                if (method.RelativeVirtualAddress == 0) continue;
                var strings = StringLoads(pe.GetMethodBody(method.RelativeVirtualAddress).GetILReader(), md);
                var regex = strings.FindIndex(s => s.StartsWith("^[0-9a-z]+[0-9a-z-]*", StringComparison.Ordinal));
                if (regex >= 0) return strings.Skip(regex + 1).TakeWhile(s => System.Text.RegularExpressions.Regex.IsMatch(s, "^[0-9a-z]+$")).ToList();
            }
        }
        throw new InvalidOperationException($"{dll}: no HtmlValidator with the tag list");
    }

    private static List<string> StringLoads(BlobReader il, MetadataReader md)
    {
        var list = new List<string>();
        while (il.RemainingBytes > 0)
        {
            int op = il.ReadByte();
            if (op == 0xFE) op = 0xFE00 | il.ReadByte();
            if (op == 0x72) { list.Add(md.GetUserString(MetadataTokens.UserStringHandle(il.ReadInt32() & 0xFFFFFF))); continue; }
            var size = op switch
            {
                0x0E or 0x0F or 0x10 or 0x11 or 0x12 or 0x13 or 0x1F or 0x2B or 0x2C or 0x2D or 0x2E or 0x2F or 0x30 or 0x31 or 0x32 or 0x33 or 0x34 or 0x35 or 0x36 or 0x37 or 0xDE => 1,
                0xFE09 or 0xFE0A or 0xFE0B or 0xFE0C or 0xFE0D or 0xFE0E => 2,
                0x20 or 0x22 or 0x28 or 0x29 or 0x27 or 0x38 or 0x39 or 0x3A or 0x3B or 0x3C or 0x3D or 0x3E or 0x3F or 0x40 or 0x41 or 0x42 or 0x43 or 0x44 or 0x6F or 0x70
                    or 0x71 or 0x73 or 0x74 or 0x75 or 0x79 or 0x7B or 0x7C or 0x7D or 0x7E or 0x7F or 0x80 or 0x81 or 0x8C or 0x8D or 0x8F or 0xA3 or 0xA4 or 0xA5 or 0xC2
                    or 0xC6 or 0xD0 or 0xDD or 0xFE06 or 0xFE07 or 0xFE15 or 0xFE16 or 0xFE19 or 0xFE1C or 0xFE1D => 4,
                0x21 or 0x23 => 8,
                0x45 => 4 * il.ReadInt32(),
                _ => 0,
            };
            for (var k = 0; k < size; k++) il.ReadByte();
        }
        return list;
    }
}
