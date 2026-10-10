using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 3, lane kl, C28 and LF-09. K2: an argument of an event written before the Destination of its event runs right
/// after it (labs 03 and 04: "IBuiltinEvent 'OnClick' has no child 'Index'"). `**Type[n]` follows the order of the document
/// (v02e: `**IButton[1]` was the button after the board, not the first cell). A missing argument of a call or an event names
/// the inputs of what it calls, never only child kinds (DCIPS: ListFilter/String_Split "has no child").
/// </summary>
public sealed class Pa3KlEventTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    private static (JsonNode? Result, Exception? Error) Run(string name, string job)
    {
        var dir = Path.Combine(Root, ".local", "pa3-kl-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        try { return (JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, Path.Combine(dir, name + ".oml"))), null); }
        catch (Exception ex) { return (null, ex); }
    }

    [Fact]
    public void AnArgumentBeforeTheDestinationOfItsEventRunsRightAfterIt()
    {
        var ops = JsonNode.Parse("""
            [{"op":"create","parent":"$scr","type":"IButton","name":"Cell0","as":"$b"},
             {"op":"set","target":"$b/OnClick/Index","prop":"Value","value":"0"},
             {"op":"set","target":"$b","prop":"Style","value":"\"cell\""},
             {"op":"set","target":"b/OnClick","prop":"Destination","value":"IScreenAction:CellClick"}]
            """)!.AsArray();
        var moved = new List<(int, int)>();
        Assert.Equal([0, 2, 3, 1], ModelSession.ArgumentOrder(ops, (argument, destination) => moved.Add((argument, destination))));
        Assert.Equal([(1, 3)], moved);
        // Written in order already: the order of the job.
        Assert.Equal([0, 1], ModelSession.ArgumentOrder(JsonNode.Parse("""[{"op":"set","target":"$b/OnClick","prop":"Destination","value":"X"},{"op":"set","target":"$b/OnClick/Index","prop":"Value","value":"0"}]""")!.AsArray()));
    }

    private const string Board = """
        {"op":"create","parent":"IMobileFlow:MainFlow","type":"IMobileScreen","name":"Pa3Board","as":"$scr"},
        {"op":"set","target":"$scr/#IMobileBlockInstanceWidget","prop":"SourceBlock","value":"IMobileBlock:LayoutTopMenu"},
        {"op":"create","parent":"$scr","type":"ILocalVariable","name":"Last","as":"$last"},
        {"op":"set","target":"$last","prop":"DataType","value":"Integer"},
        {"op":"logic","data":{"actions":[{"name":"CellClick","kind":"screen","owner":"IMobileScreen:Pa3Board","inputs":[{"name":"Index","type":"Integer"}],"steps":[{"assign":{"Last":"Index"}}]},
          {"name":"Restart","kind":"screen","owner":"IMobileScreen:Pa3Board","steps":[{"assign":{"Last":"-1"}}]}]}},
        {"op":"create","parent":"$scr/#IMobileBlockInstanceWidget/MainContent","type":"IContainer","name":"Board","as":"$board"},
        {"op":"create","parent":"$scr/#IMobileBlockInstanceWidget/MainContent","type":"IButton","name":"BtnRestart","as":"$restart"},
        {"op":"set","target":"$restart/OnClick","prop":"Destination","value":"IMobileScreen:Pa3Board/Restart"},
        {"op":"create","parent":"$board","type":"IButton","name":"Cell0","as":"$c0"},
        {"op":"create","parent":"$board","type":"IButton","name":"Cell1","as":"$c1"}
        """;

    [Fact]
    public void AnArgumentWrittenBeforeTheDestinationApplies()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (result, error) = Run("k2", "{\"base\":\"reactive-ui.oml\",\"ops\":[" + Board + """
            ,{"op":"set","target":"$c0/OnClick/Index","prop":"Value","value":"0"}
            ,{"op":"set","target":"$c0/OnClick","prop":"Destination","value":"IMobileScreen:Pa3Board/CellClick"}
            ,{"op":"set","target":"$c1/OnClick","prop":"Destination","value":"IMobileScreen:Pa3Board/CellClick"}
            ,{"op":"set","target":"$c1/OnClick/Index","prop":"Value","value":"1"}]}
            """);
        Assert.True(error == null, error?.ToString());
        Assert.True(result!["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        Assert.Contains(result["reorderedArguments"]!.AsArray(), r => r!["op"]!.GetValue<int>() == 10 && r["after"]!.GetValue<int>() == 11);
    }

    [Fact]
    public void DoubleStarIndexFollowsTheDocumentOrder()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        // The restart button was created before the cells, but it comes after the board in the document.
        var (result, error) = Run("doc-order", "{\"base\":\"reactive-ui.oml\",\"ops\":[" + Board + """
            ,{"op":"set","target":"$c0/OnClick","prop":"Destination","value":"IMobileScreen:Pa3Board/CellClick"}
            ,{"op":"set","target":"$c1/OnClick","prop":"Destination","value":"IMobileScreen:Pa3Board/CellClick"}
            ,{"op":"set","target":"$c0/OnClick/Index","prop":"Value","value":"0"}
            ,{"op":"set","target":"$c1/OnClick/Index","prop":"Value","value":"1"}
            ,{"op":"get","target":"$scr/**IButton[1]"},{"op":"get","target":"$scr/**IButton[3]"}]}
            """);
        Assert.True(error == null, error?.ToString());
        var gets = result!["results"]!.AsArray().Where(r => r!["op"]!.GetValue<string>() == "get").Select(r => r!["result"]!["name"]!.GetValue<string>()).ToArray();
        Assert.Equal(["Cell0", "BtnRestart"], gets);
    }

    [Fact]
    public void AMissingArgumentOfACallNamesTheInputsOfTheCallee()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (_, error) = Run("lf09", """
            {"base":"blank-service.oml","ops":[
              {"op":"logic","data":{"actions":[{"name":"Pa3Target","inputs":[{"name":"Delimiter","type":"Text"},{"name":"Source","type":"Text"}],"outputs":[{"name":"R","type":"Text"}],"steps":[{"assign":{"R":"Source + Delimiter"}}]},
                {"name":"Pa3Caller","outputs":[{"name":"R","type":"Text"}],"steps":[{"call":"Pa3Target","as":"Split","args":{"Delimiter":"\",\"","Source":"\"a\""}},{"assign":{"R":"Split.R"}}]}]}},
              {"op":"set","target":"IServerAction:Pa3Caller/Split/Delimeter","prop":"Value","value":"\";\""}]}
            """);
        var text = Errors.Text(Assert.IsAssignableFrom<Exception>(error));
        Assert.Contains("has no child 'Delimeter'", text);
        Assert.Contains("inputs of IServerAction 'Pa3Target': Delimiter, Source", text);
        Assert.Contains("closest: Delimiter", text);
    }
}
