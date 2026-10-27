using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class MigrationDataRegressionTests
{
    internal static JsonObject Page() => JsonNode.Parse("""
    {"screen":"MigratedCatalog","title":"Catalog","layout":"blank","html":"<button data-av='next'>Next</button>",
     "vars":[{"name":"Total","type":"Integer","default":"0"}],
     "source":{"as":"LoadItems","action":"ReadItems","paging":{"offset":"Offset","size":25,"total":"Total","offsetInput":"Skip","sizeInput":"Take"},"state":{"assign":{"Total":"Total"}}},
     "bindings":{"next":{"kind":"page","source":"LoadItems","direction":"next"}}}
    """)!.AsObject();

    private static HtmlCompilation Compile(JsonObject data, bool withRows = false) => HtmlExpander.Expand(data, names => names.FirstOrDefault(n => n.Contains("LayoutBlank") || n.Contains("ReadItems") || n.Contains("MainFlow")), reference =>
        reference.Contains("ReadItems") ? new ScreenContract(reference,
            [new UiParam("Skip", "Integer", true, null, null), new UiParam("Take", "Integer", true, null, null)],
            withRows ? [new UiParam("Total", "Integer", false, null, null), new UiParam("Rows", "Item List", false, null, null)] : [new UiParam("Total", "Integer", false, null, null)], [], [], [],
            new Dictionary<string, IReadOnlyList<UiParam>> { ["Rows"] = [new UiParam("Amount", "Integer", false, null, null)] }, new Dictionary<string, IReadOnlyList<string>>())
        : reference.Contains("LayoutBlank") ? new ScreenContract(reference, [], [], [], [], [new UiPlaceholder("Content", null, "Content", [])],
            new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>()) : null, "Reactive");
    private static bool Set(JsonObject op, string property, string value) => op["op"]?.ToString() == "set" && op["prop"]?.ToString() == property && op["value"]?.ToString() == value;

    [Fact]
    public void PageOffsetAndSizeReachTheTypedServerInputs()
    {
        var ops = Compile(Page()).Ops;
        Assert.Contains(ops, o => o["target"]?.ToString().EndsWith("/Skip") == true && Set(o, "Value", "Offset"));
        Assert.Contains(ops, o => o["target"]?.ToString().EndsWith("/Take") == true && Set(o, "Value", "25"));
        Assert.Contains(ops, o => Set(o, "Condition", "Offset + 25 < LoadItems.FetchedTotal"));
        Assert.Contains(ops, o => o["type"]?.ToString() == "IRefreshDataNode");
    }

    [Fact]
    public void PreparationStateIsAppliedByScreenActionAfterFetchAndDoesNotCollideWithDataOutputs()
    {
        var ops = Compile(Page()).Ops;
        Assert.Contains(ops, o => o["type"]?.ToString() == "IOutputParameter" && o["name"]?.ToString() == "FetchedTotal");
        Assert.Contains(ops, o => o["target"]?.ToString().EndsWith("/OnAfterFetch") == true && o["prop"]?.ToString() == "Destination");
        Assert.Contains(ops, o => Set(o, "Variable", "Total"));
        Assert.Contains(ops, o => Set(o, "Value", "LoadItems.FetchedTotal"));
        Assert.Contains(ops, o => Set(o, "Condition", "LoadItems.FetchSucceeded"));
    }

    [Fact]
    public void MissingPagingInputIsRejectedBeforeAFalseCounterCanBeGenerated()
    {
        var data = Page(); data["source"]!["paging"]!["offsetInput"] = "IgnoredOffset";
        Assert.ThrowsAny<InvalidOperationException>(() => Compile(data));
    }

    [Fact]
    public void DerivedValuesShareTheSuccessfulAfterFetchHandlerWithPreparationState()
    {
        var data = Page();
        data["derived"] = new JsonArray(new JsonObject { ["name"] = "Sum", ["source"] = "LoadItems", ["output"] = "Rows", ["sum"] = "Amount" });
        var ops = Compile(data, withRows: true).Ops;
        Assert.Single(ops.Where(o => o["target"]?.ToString().EndsWith("/OnAfterFetch") == true && o["prop"]?.ToString() == "Destination"));
        Assert.Contains(ops, o => Set(o, "Variable", "Total"));
        Assert.Contains(ops, o => Set(o, "Variable", "Sum"));
        Assert.DoesNotContain(ops, o => o["name"]?.ToString() == "DeriveSum");
    }

    [Fact]
    public void OutputRenamesReachBindingsWithoutChangingQuotedText()
    {
        var data = Page(); data["html"] = "<span data-av='total'></span>";
        data["bindings"] = new JsonObject { ["total"] = new JsonObject { ["kind"] = "text", ["value"] = "IntegerToText(LoadItems.Total) + \"LoadItems.Total\"" } };
        var ops = Compile(data).Ops;
        Assert.Contains(ops, o => Set(o, "Value", "IntegerToText(LoadItems.FetchedTotal) + \"LoadItems.Total\""));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(101)]
    public void InvalidPageSizeIsRejectedEvenWithoutModule(int size)
    {
        var data = Page(); data["source"]!["paging"]!["size"] = size;
        Assert.ThrowsAny<InvalidOperationException>(() => HtmlExpander.Preflight(data));
    }
}
