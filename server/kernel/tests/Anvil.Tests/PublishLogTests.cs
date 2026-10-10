using System.Text.Json.Nodes;
using Anvil.Bridge;
using Anvil.Core;
using OutSystems.RuntimeCommon;
using Xunit;

namespace Anvil.Tests;

// The rows are real OutSystems.RuntimeCommon.MessageDefinition objects, as the Studio puts them in its 1-Click Publish
// tab (ServerMessagesPanePresenter): step lines of ServerProcess.AddStep, then the server's messages.
public class PublishLogTests
{
    public PublishLogTests() => StudioAssemblies.Bind();

    private static readonly IReadOnlyDictionary<string, string> Steps = new Dictionary<string, string>
    {
        ["OneCP_Save"] = PublishLog.Save, ["OneCP_Upload"] = PublishLog.Upload, ["OneCP_Compile"] = PublishLog.Compile, ["OneCP_Publish"] = PublishLog.Deploy,
    };

    private static MessageDefinition Def(string id, MessageType type, string message, string detail = "", string extraInfo = "")
        => new(id, type, message, detail, "", "", "", extraInfo, 0, false, Array.Empty<MessageDefinition.Button>(), default, default);

    private static PublishLog.Row Row(MessageDefinition d, string at) => new(d, at);

    private static PublishLog.Operation Op(string? state, string? inner, params PublishLog.Row[] rows)
        => new(7, "Publish", state, inner, "Horsie_CS", "k-horsie", "personal-2qqw9srv.outsystemscloud.com", "2026-10-04T13:00:00", "studio", rows);

    private static PublishLog.Row[] FailedCompile() =>
    [
        Row(Def("OneCP_Save", MessageType.Info, "Saving Horsie_CS"), "13:00:01"),
        Row(Def("OneCP_Upload", MessageType.Info, "Uploading to personal-2qqw9srv.outsystemscloud.com"), "13:00:02"),
        Row(Def("OneCP_Compile", MessageType.Info, "Compiling Horsie_CS"), "13:00:05"),
        Row(Def("SQLInvalid", MessageType.Error, "Invalid SQL in 'GetInbox'", "Incorrect syntax near the keyword 'Match'."), "13:00:09"),
        Row(Def("Deprecated", MessageType.Warning, "Deprecated function used"), "13:00:09"),
    ];

    [Fact]
    public void FailedCompilationKeepsTheMessageWithItsStageAndTheStepsApart()
    {
        var log = PublishLog.Project(Op("CompletedWithFailure", "Compiling", FailedCompile()), Steps, 60);
        Assert.True(log["found"]!.GetValue<bool>());
        Assert.Equal("failed", log["status"]!.GetValue<string>());
        Assert.Equal("compile", log["failedStage"]!.GetValue<string>());
        Assert.Equal("compile", log["stage"]!.GetValue<string>());
        Assert.Equal(1, log["errors"]!.GetValue<int>());
        Assert.Equal(1, log["warnings"]!.GetValue<int>());
        Assert.Equal(new[] { "save", "upload", "compile" }, log["steps"]!.AsArray().Select(s => s!["stage"]!.GetValue<string>()));
        var error = log["messages"]!.AsArray()[0]!;
        Assert.Equal("Error", error["type"]!.GetValue<string>());
        Assert.Equal("compile", error["stage"]!.GetValue<string>());
        Assert.Equal("Invalid SQL in 'GetInbox'", error["text"]!.GetValue<string>());
        Assert.Equal("Incorrect syntax near the keyword 'Match'.", error["detail"]!.GetValue<string>());
        Assert.Equal("SQLInvalid", error["id"]!.GetValue<string>());
        Assert.Equal("13:00:09", error["shownAt"]!.GetValue<string>());
        Assert.Equal("13:00:01", log["startedAt"]!.GetValue<string>());
        Assert.Equal("13:00:09", log["endedAt"]!.GetValue<string>());
        Assert.Equal("studio", log["triggeredBy"]!.GetValue<string>());
        Assert.Equal("Horsie_CS", log["module"]!.GetValue<string>());
    }

    [Fact]
    public void TheElementComesFromTheModelForAQuotedNameAndNeverForAKeyword()
    {
        var asked = new List<string>();
        JsonObject? Resolve(string name)
        {
            asked.Add(name);
            return name == "GetInbox" ? new JsonObject { ["name"] = name, ["key"] = "act-1", ["kind"] = "ServerAction", ["path"] = "GetInbox (ServerAction)" } : null;
        }
        var log = PublishLog.Project(Op("CompletedWithFailure", "Compiling", FailedCompile()), Steps, 60, Resolve);
        var element = log["messages"]!.AsArray()[0]!["element"]!;
        Assert.Equal("act-1", element["key"]!.GetValue<string>());
        Assert.Equal("GetInbox", asked[0]);
        Assert.Null(log["messages"]!.AsArray()[1]!["element"]);
    }

    [Fact]
    public void ExtraInfoNameAndKeyIsTheElementAndOtherwiseItIsKeptAsText()
    {
        var log = PublishLog.Project(Op("CompletedWithFailure", "Deploying",
            Row(Def("OneCP_Publish", MessageType.Info, "Deploying"), "1"),
            Row(Def("Outdated", MessageType.Error, "Consumer is outdated", extraInfo: "Horsie;a1b2c3d4-e5f6-7788-99aa-bbccddeeff00"), "2"),
            Row(Def("Db", MessageType.Error, "Database upgrade error", extraInfo: "table OSUSR_ABC_MATCH"), "3")), Steps, 60);
        var messages = log["messages"]!.AsArray();
        Assert.Equal("Horsie", messages[0]!["element"]!["name"]!.GetValue<string>());
        Assert.Equal("a1b2c3d4-e5f6-7788-99aa-bbccddeeff00", messages[0]!["element"]!["key"]!.GetValue<string>());
        Assert.Null(messages[1]!["element"]);
        Assert.Equal("table OSUSR_ABC_MATCH", messages[1]!["extraInfo"]!.GetValue<string>());
        Assert.Equal("deploy", log["failedStage"]!.GetValue<string>());
    }

    [Fact]
    public void ErrorsAreNeverCutAndWarningsAndInfoFillUpToMax()
    {
        var rows = new List<PublishLog.Row> { Row(Def("OneCP_Compile", MessageType.Info, "Compiling"), "0") };
        for (var i = 0; i < 5; i++) rows.Add(Row(Def("W" + i, MessageType.Warning, "warning " + i), "1"));
        for (var i = 0; i < 3; i++) rows.Add(Row(Def("E" + i, MessageType.Error, "error " + i), "2"));
        rows.Add(Row(Def("I", MessageType.Info, "info"), "3"));
        var log = PublishLog.Project(Op("CompletedWithFailure", "Compiling", rows.ToArray()), Steps, 2);
        var messages = log["messages"]!.AsArray();
        Assert.Equal(3, messages.Count(m => m!["type"]!.GetValue<string>() == "Error"));
        Assert.Equal(3, messages.Count);
        Assert.Equal(6, log["omitted"]!.GetValue<int>());
        Assert.Equal(3, log["errors"]!.GetValue<int>());
    }

    [Theory]
    [InlineData("Running", false, "running")]
    [InlineData("CompletedWithSuccessNotOpenedInBrowser", false, "succeeded")]
    [InlineData("CompletedWithSuccessOpenedInBrowserOrClosed", false, "succeeded")]
    [InlineData("CompletedWithFailure", false, "failed")]
    [InlineData(null, true, "failed")]
    [InlineData(null, false, "unknown")]
    public void StatusFollowsTheNativeServerOperationState(string? state, bool hasErrors, string status)
        => Assert.Equal(status, PublishLog.Status(state, hasErrors));

    [Fact]
    public void ASuccessfulPublicationHasNoFailedStageAndARunningOneNoEnd()
    {
        var ok = PublishLog.Project(Op("CompletedWithSuccessNotOpenedInBrowser", "Deploying",
            Row(Def("OneCP_Publish", MessageType.Info, "Deploying"), "1"), Row(Def("Done", MessageType.Ok, "Horsie_CS published"), "2")), Steps, 60);
        Assert.Equal("succeeded", ok["status"]!.GetValue<string>());
        Assert.Null(ok["failedStage"]);
        Assert.Equal("Ok", ok["messages"]!.AsArray()[0]!["type"]!.GetValue<string>());
        var running = PublishLog.Project(Op("Running", "Uploading", Row(Def("OneCP_Upload", MessageType.Info, "Uploading"), "1")), Steps, 60);
        Assert.Equal("running", running["status"]!.GetValue<string>());
        Assert.Null(running["endedAt"]);
        Assert.Equal("upload", running["stage"]!.GetValue<string>());
    }

    [Fact]
    public void QuotedNamesAreIdentifiersInOrderWithoutRepeats()
    {
        Assert.Equal(new[] { "GetInbox", "Match", "Horse.Name" },
            PublishLog.QuotedNames("Invalid SQL in 'GetInbox' near 'Match'", "column \"Horse.Name\" and 'getinbox' and 'two words' and ''"));
        Assert.Empty(PublishLog.QuotedNames(null, ""));
    }

    [Fact]
    public void WithoutAPaneTheAnswerSaysWhy()
    {
        var log = PublishLog.NotFound("Horsie_CS", "k", "host", "no tab");
        Assert.False(log["found"]!.GetValue<bool>());
        Assert.Equal("no tab", log["reason"]!.GetValue<string>());
    }
}
