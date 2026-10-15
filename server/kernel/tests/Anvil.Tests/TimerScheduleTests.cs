using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class TimerScheduleTests
{
    public TimerScheduleTests()
    {
        var assembly = typeof(TimerScheduleValue).Assembly;
        var binder = assembly.GetType("Anvil.Core.StudioAssembliesOdc") ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
        binder.GetMethod("Bind")!.Invoke(null, new object?[] { null });
    }
    [Theory]
    [InlineData("every one minute")]
    [InlineData("every five minutes")]
    [InlineData("Every day at 03:00")]
    [InlineData("Every 1 minutes")]
    [InlineData("*/5 * * * *")]
    [InlineData("25:00")]
    [InlineData("12:60")]
    [InlineData("Mon")]
    [InlineData("12:30 nonsense")]
    public void InvalidLegacyTextIsRejected(string text) =>
        Assert.Contains("TIMER_SCHEDULE_INVALID", Assert.Throws<InvalidOperationException>(() => TimerScheduleValue.Prepare(JsonValue.Create(text), false)).Message);

    [Theory]
    [InlineData("")]
    [InlineData("WhenPublished")]
    [InlineData("07:45 12:30")]
    [InlineData("07:45 Mon Fri")]
    [InlineData("07:45 1 15 31")]
    [InlineData("07:45 last Fri")]
    public void NativeLegacyFormsArePreserved(string text) => Assert.Equal(text, TimerScheduleValue.Prepare(JsonValue.Create(text), false).Value);

    [Fact]
    public void PublishedDisplayLabelBecomesNativeToken() =>
        Assert.Equal("WhenPublished", TimerScheduleValue.Prepare(JsonValue.Create("When Published"), false).Value);

    [Theory]
    [InlineData("Every day at 03:00")]
    [InlineData("Every 1 minutes")]
    public void DdlRejectsInvalidScheduleBeforeCreatingTimer(string schedule)
    {
        var text = "-- ssam-ddl/1\ntimer InvalidTimer schedule \"" + schedule + "\"";
        var document = Anvil.Reading.DdlParser.Parse(text);
        var compiled = Anvil.Reading.DdlCompiler.Compile(document, null, "o11");
        Assert.Contains(compiled.Problems, p => p.Code == "TIMER_SCHEDULE_INVALID");
        Assert.Equal(0, compiled.Count);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(5)]
    [InlineData(10)]
    [InlineData(60)]
    public void IntervalSurvivesNativeSaveAndReload(int minutes)
    {
        var odc = StudioAdapter.Runtime.Platform == "odc";
        var root = FindRoot();
        var work = Path.Combine(root, ".local", "timer-schedule-tests", Guid.NewGuid().ToString("N"));
        var job = Seed(odc);
        job["ops"]![3]!["value"] = new JsonObject { ["everyMinutes"] = minutes };
        var first = Run(job, work, "first");
        Assert.True(first["accepted"]!.GetValue<bool>(), first.ToJsonString());
        var read = JsonNode.Parse("""{"ops":[{"op":"get","target":"ITimer:ScheduleProof"}]}""")!.AsObject();
        var after = Run(read, work, "reload", Path.Combine(work, "first.oml"));
        var props = after["results"]![0]!["result"]!["properties"]!;
        if (odc)
        {
            Assert.Equal(minutes == 60 ? "0 * * * *" : $"*/{minutes} * * * *", props["CronSchedule"]!.GetValue<string>());
        }
        else
        {
            var times = props["Schedule"]!.GetValue<string>().Split(' ');
            Assert.Equal(1440 / minutes, times.Length);
            Assert.Equal("00:00", times[0]);
            Assert.Equal(TimeSpan.FromMinutes(1440 - minutes).ToString(@"hh\:mm"), times[^1]);
            for (var i = 1; i < times.Length; i++)
                Assert.Equal(minutes, (TimeSpan.Parse(times[i]) - TimeSpan.Parse(times[i - 1])).TotalMinutes);
        }
    }

    [Theory]
    [InlineData("every one minute")]
    [InlineData("every five minutes")]
    public void PublicSetRefusesProseWithoutSavingCandidate(string prose)
    {
        var work = Path.Combine(FindRoot(), ".local", "timer-schedule-tests", Guid.NewGuid().ToString("N"));
        var job = Seed(StudioAdapter.Runtime.Platform == "odc");
        job["ops"]![3]!["value"] = prose;
        var ex = Assert.ThrowsAny<Exception>(() => Run(job, work, "invalid"));
        Assert.Contains("TIMER_SCHEDULE_INVALID", Errors.Text(ex));
        Assert.False(File.Exists(Path.Combine(work, "invalid.oml")));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(7)]
    [InlineData(61)]
    public void IntervalsThatCannotPreserveUniformCadenceAreRejected(int minutes) =>
        Assert.Throws<InvalidOperationException>(() => TimerScheduleValue.Prepare(new JsonObject { ["everyMinutes"] = minutes }, true));

    private static JsonObject Seed(bool odc)
    {
        var job = JsonNode.Parse("""
        {"expectValid":true,"expectedMessages":[],"ops":[
          {"op":"logic","data":{"actions":[{"name":"ScheduleProofAction","kind":"server","outputs":[{"name":"Result","type":"Integer"}],"steps":[{"assign":{"Result":"1 + 1"}}]}]}},
          {"op":"create","parent":"@espace","type":"ITimer","name":"ScheduleProof","as":"$timer"},
          {"op":"set","target":"$timer","prop":"Action","value":"IServerAction:ScheduleProofAction"},
          {"op":"set","target":"$timer","prop":"Schedule","value":""},
          {"op":"get","target":"$timer"}
        ]}
        """)!.AsObject();
        job["base"] = odc ? "tests/fixtures/odc/wrightflood-personal-r8.oml" : "tests/fixtures/blank-service.oml";
        return job;
    }

    private static JsonNode Run(JsonObject job, string work, string name, string? source = null)
    {
        Directory.CreateDirectory(work);
        var path = Path.Combine(work, name + ".json"); File.WriteAllText(path, job.ToJsonString());
        return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), source, path, Path.Combine(work, name + ".oml")))!;
    }
    private static string FindRoot()
    {
        var p = Path.GetDirectoryName(typeof(TimerScheduleTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(p, "MANIFESTO.md"))) p = Path.GetDirectoryName(p)!;
        return p;
    }
}
