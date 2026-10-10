using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
namespace Anvil.Tests;
public sealed class ScreenSpecTests
{
    private static UiParam Param(string name, string type, bool required = false) => new(name,type,required,null,null);
    private static readonly UiParam[] Fields = [Param("Id","Item Identifier"),Param("Title","Text",true),Param("Description","Text"),Param("Price","Currency"),Param("Rating","Decimal"),Param("CategoryId","Category Identifier")];
    private static ScreenContract Contract(string reference)
    {
        var name = reference.Split(':')[1];
        string[] placeholders = name switch { "LayoutTopMenu" => ["Title","MainContent"], "Layout" => ["Title","Content"], "Gallery" => ["Content"], "Carousel" => ["CarouselItems"], "Search" => ["Input"], "CardSectioned" => ["Title","Content","Footer","Image"], "Tabs" => ["Header","Content"], "TabsHeaderItem" => ["Title"], "TabsContentItem" or "Counter" => ["Content"], _ => [] };
        UiParam[] inputs = name switch { "Pagination" => [Param("StartIndex","Integer",true),Param("MaxRecords","Integer",true),Param("TotalCount","Long Integer",true)], "Rating" => [Param("RatingValue","Decimal",true)], "Save" => [Param("Record","Item",true)], _ => [] };
        UiEvent[] events = name == "Pagination" ? [new("OnNavigate",true,null,[Param("NewStartIndex","Integer")])] : [];
        var listChildren = new Dictionary<string,IReadOnlyList<string>>();
        if (name is "Gallery" or "Carousel") listChildren[placeholders[0]] = ["ServiceStudio.Plugin.NRWidgets.IImage"];
        return new(reference,inputs,name=="Load" ? [Param("Items","Item List")] : [],Fields,events,
            placeholders.Select(p=>new UiPlaceholder(p,null,p,[])).ToArray(),new Dictionary<string,IReadOnlyList<UiParam>> { ["Items"]=Fields },listChildren);
    }
    private static string? Resolve(string[] references) => references.FirstOrDefault(r => !r.StartsWith("IMobileScreen:") && !r.EndsWith(":Missing"));
    private static JsonObject Spec(string kind="cards") => JsonNode.Parse("""{"screens":[{"name":"Catalog","kind":"cards","title":"Items","source":{"entity":"Item","as":"GetItems"},"card":{"title":"Title","rating":"Rating"}}]}""")!.AsObject();
    private static List<JsonObject> Expand(JsonObject spec, Func<string,ScreenContract?>? contract = null) => ScreenExpander.Expand(spec, Resolve, contract ?? Contract, "Reactive");

    [Fact] public void SameSpecAndContractsProduceTheSameOpsAndReuseDefaultList()
    {
        var first = Expand(Spec()); var second = Expand(Spec());
        Assert.Equal(string.Join("\n",first.Select(o=>o.ToJsonString())),string.Join("\n",second.Select(o=>o.ToJsonString())));
        Assert.DoesNotContain(first,o=>o["op"]?.ToString()=="create" && o["type"]?.ToString()=="IList");
        Assert.Contains(first,o=>o["prop"]?.ToString()=="Source" && o["target"]!.ToString().EndsWith("/#IList") && o["value"]?.ToString()=="GetItems.List");
        Assert.Contains(first,o=>o["prop"]?.ToString()=="Value" && o["value"]?.ToString()=="GetItems.List.Current.Item.Title");
        Assert.Contains(first,o=>o["target"]?.ToString().EndsWith("/TotalCount")==true && o["value"]?.ToString()=="GetItems.Count");
    }
    [Fact] public void AllScreensAreDeclaredBeforeTheirNavigationLinks()
    {
        var spec=Spec(); spec["screens"]![0]!["card"]!["destination"]="Detail";
        spec["screens"]![0]!["card"]!["args"]=new JsonObject { ["Id"]="GetItems.List.Current.Item.Id" };
        spec["screens"]!.AsArray().Add(JsonNode.Parse("""{"name":"Detail","kind":"detail","inputs":[{"name":"Id","type":"Item Identifier","mandatory":true}],"source":{"entity":"Item","as":"GetItem","where":"Item.Id = Id"},"fields":[{"field":"Title"}]}"""));
        var ops=Expand(spec); var declaration=ops.FindIndex(o=>o["type"]?.ToString()=="IMobileScreen" && o["name"]?.ToString()=="Detail");
        var destination=ops.FindIndex(o=>o["prop"]?.ToString()=="Destination" && o["value"]?.ToString()=="$screen.Detail");
        Assert.True(declaration>=0 && destination>declaration);
    }
    [Fact] public void DataActionUsesTheListElementFieldsWithoutAggregateWrapper()
    {
        var spec=JsonNode.Parse("""{"screens":[{"name":"Featured","kind":"detail","source":{"action":"Load","as":"Read","output":"Items"},"fields":[{"field":"Title"}]}]}""")!.AsObject();
        var ops=Expand(spec);
        Assert.Contains(ops,o=>o["type"]?.ToString()=="IDataAction");
        Assert.Contains(ops,o=>o["value"]?.ToString()=="Read.Items.Current.Title");
        Assert.DoesNotContain(ops,o=>o["value"]?.ToString()=="Read.Items.Current.Item.Title");
    }
    [Theory]
    [InlineData("root","unknown data keys")]
    [InlineData("card","unknown card keys")]
    [InlineData("kind","unknown kind")]
    [InlineData("field","does not exist")]
    [InlineData("unused","declared and never used")]
    [InlineData("irrelevant","cards does not use")]
    [InlineData("static","reference not found")]
    [InlineData("search-type","search must be an object")]
    [InlineData("sort-type","source.sort must be an array")]
    public void InvalidSpecsFailBeforeReturningOperations(string error, string message)
    {
        var spec=Spec(); var screen=spec["screens"]![0]!;
        switch(error)
        {
            case "root": spec["screenz"]=new JsonArray(); break;
            case "card": screen["card"]!["colour"]="red"; break;
            case "kind": screen["kind"]="kanban"; break;
            case "field": screen["card"]!["title"]="Missing"; break;
            case "unused": screen["inputs"]=JsonNode.Parse("""[{"name":"Unused","type":"Text"}]"""); screen["source"]!["where"]="Item.Title = \"Unused\""; break;
            case "irrelevant": screen["columns"]=new JsonArray(); break;
            case "search-type": screen["search"]="Title"; break;
            case "sort-type": screen["source"]!["sort"]="Title"; break;
            case "static": screen["filters"]=JsonNode.Parse("""[{"field":"CategoryId","from":"Missing"}]"""); break;
        }
        Assert.Contains(message,Assert.Throws<InvalidOperationException>(()=>Expand(spec)).Message);
    }
    [Fact] public void MandatoryEventsCannotBeSilentlyDropped()
    {
        ScreenContract Changed(string reference)
        {
            var c=Contract(reference);
            return reference.EndsWith(":Gallery") ? c with { Events = [new UiEvent("NewRequiredEvent",true,null,[])] } : c;
        }
        Assert.Contains("requires handler 'NewRequiredEvent'",Assert.Throws<InvalidOperationException>(()=>Expand(Spec(),Changed)).Message);
    }
    [Fact] public void FormLabelsAndValidationGuardTheSaveCall()
    {
        var spec=JsonNode.Parse("""{"screens":[{"name":"Editor","kind":"form","source":{"entity":"Item","as":"GetItem"},"fields":[{"field":"Title"}],"actions":[{"name":"Save","call":"Save","args":{"Record":"GetItem.List.Current.Item"}}]}]}""")!.AsObject();
        var ops=Expand(spec);
        Assert.Contains(ops,o=>o["prop"]?.ToString()=="TargetWidget");
        Assert.Contains(ops,o=>o["prop"]?.ToString()=="Mandatory" && o["value"]?.ToString()=="True");
        Assert.Contains(ops,o=>o["prop"]?.ToString()=="Condition" && o["value"]?.ToString()=="Form1.Valid");
        Assert.Contains(ops,o=>o["prop"]?.ToString()=="BuiltInValidations" && o["value"]?.ToString()=="ValidateAndContinue");
    }
}
