using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects; no Studio. The way back of the data text compares the module's value and the text's in the
// form the module stores them (DdlValues): a value written in another form the set verb stores the same compiles to no op (or
// the edit never converges: DDL_NOT_CONVERGED), and a really different value is still one set naming the element and property.
public sealed class DdlValuesTests
{
    private const string Header = "-- ssam-ddl/1 module=Probe lane=o11 key=@m sourceSha256=00 elements=3\n\n";

    private enum Priority { Low, Normal, High }

    private static DdlCompilation Compile(string module, string edit, Func<DdlElement, string, Type?>? stored = null) =>
        DdlCompiler.Compile(DdlParser.Parse(edit, "o11"), DdlParser.Parse(Header + module), "o11", "$ddl", edit, null, stored);

    private static string Timer(string clauses) => "timer Tick action Run" + clauses + " -- @t1";

    // The native types of the probe's properties (what ModelSession gives by key in a job).
    private static Type? Types(DdlElement element, string property) => (element.Kind, property) switch {
        ("Timer", "Priority") => typeof(Priority), ("Timer", "TimeoutInMinutes") => typeof(int), ("Timer", "Schedule") => typeof(string),
        ("SiteProperty", "IsSecret") => typeof(bool), ("SiteProperty", "IsReadOnly") => typeof(bool), _ => null };

    // ---- the schedule: every form the set verb stores the same, generated from the grammar of TimerScheduleValue ----------

    private static readonly string[] Schedules = ["WhenPublished", "", "03:00", "00:00 12:00", "08:00 Mon Fri", "06:30 1 15", "09:00 1st Mon", "23:55 last Fri"];

    // The other ways of writing a schedule the set verb stores as `stored`: spaces around and between its parts, and the
    // Studio's words for WhenPublished.
    private static IEnumerable<string> Forms(string stored)
    {
        if (stored == "WhenPublished") { yield return "When Published"; yield return " When Published "; }
        if (stored.Length == 0) { yield return " "; yield break; }
        yield return " " + stored + " ";
        if (stored.Contains(' ')) yield return stored.Replace(" ", "   ");
    }

    public static IEnumerable<object[]> ScheduleForms() => Schedules.SelectMany(s => Forms(s).Select(f => new object[] { s, f }));

    [Theory]
    [MemberData(nameof(ScheduleForms))]
    public void EachFormOfASchedulePlatformStoresTheSameIsNoChange(string stored, string written)
    {
        Assert.Equal(stored, DdlValues.Canonical("Timer", "Schedule", written, typeof(string)));
        var compiled = Compile(Timer(" schedule \"" + stored + "\""), Timer(" schedule \"" + written + "\""));
        Assert.Empty(compiled.Problems);
        Assert.Equal(0, compiled.Count);
    }

    [Fact]
    public void EveryTwoDifferentSchedulesAreStillOneSetOfTheTimersSchedule()
    {
        foreach (var from in Schedules)
            foreach (var to in Schedules.Where(s => s != from).SelectMany(s => Forms(s).Prepend(s))) {
                var compiled = Compile(Timer(" schedule \"" + from + "\""), Timer(" schedule \"" + to + "\""));
                var set = Assert.Single(compiled.Ops());
                Assert.Equal("set", set.Op["op"]!.ToString());
                Assert.Equal("@t1", set.Op["target"]!.ToString());
                Assert.Equal("Schedule", set.Op["prop"]!.ToString());
                Assert.Equal("Tick", set.What);
            }
    }

    // ---- enums, flags and numbers, by the property's native type -------------------------------------------------------------

    [Theory]
    [InlineData(" priority High", " priority high")]
    [InlineData(" priority High", " priority HIGH")]
    [InlineData(" priority Low", " os:Priority=low")]
    [InlineData(" timeout 5", " timeout 05")]
    [InlineData(" timeout 5", " timeout 005")]
    [InlineData(" timeout 45", " timeout 0045")]
    [InlineData("", " priority normal")]
    [InlineData("", " timeout 020")]
    public void ATimerValueWrittenInAnotherFormOfItsTypeIsNoChange(string module, string edit)
    {
        Assert.Equal(0, Compile(Timer(module), Timer(edit), Types).Count);
        // Without the type the text cannot tell: the set is emitted (the session always gives the type).
        Assert.Equal(1, Compile(Timer(module), Timer(edit)).Count);
    }

    [Theory]
    [InlineData("site property Flag: Boolean secret -- @s1", "site property Flag: Boolean os:IsSecret=true -- @s1")]
    [InlineData("site property Flag: Boolean secret -- @s1", "site property Flag: Boolean os:IsSecret=TRUE -- @s1")]
    [InlineData("site property Flag: Boolean -- @s1", "site property Flag: Boolean os:IsSecret=false -- @s1")]
    [InlineData("site property Flag: Boolean read-only -- @s1", "site property Flag: Boolean os:IsReadOnly=true -- @s1")]
    public void AFlagInAnyCaseIsNoChange(string module, string edit) => Assert.Equal(0, Compile(module, edit, Types).Count);

    [Theory]
    [InlineData("", " os:UpdateBehavior=\"Changed Attributes\"")]
    [InlineData(" update full", " os:UpdateBehavior=full")]
    [InlineData(" update full", " os:UpdateBehavior=FULL")]
    public void TheStudiosNameOfAnEnumValueIsNoChange(string module, string edit)
    {
        static string Entity(string clauses) => "create entity Item" + clauses + " ( -- @e1\n  Id Long Integer identifier auto required -- @a1\n);";
        Assert.Equal(0, Compile(Entity(module), Entity(edit), (e, p) => p == "UpdateBehavior" ? typeof(UpdateBehaviorProbe) : null).Count);
    }

    private enum UpdateBehaviorProbe { Optimized, Full }

    // ---- negatives: a really different value is one set, named; a value the type does not take is never called equal ---------

    [Theory]
    [InlineData(" priority High", " priority low", "Priority")]
    [InlineData(" timeout 5", " timeout 06", "TimeoutInMinutes")]
    [InlineData(" priority High", " priority Urgent", "Priority")]
    [InlineData(" timeout 5", " timeout 5.0", "TimeoutInMinutes")]
    public void AReallyDifferentValueIsStillOneSetNamingTheTimerAndTheProperty(string module, string edit, string property)
    {
        var set = Assert.Single(Compile(Timer(module), Timer(edit), Types).Ops());
        Assert.Equal("@t1", set.Op["target"]!.ToString());
        Assert.Equal(property, set.Op["prop"]!.ToString());
        Assert.Equal("Tick", set.What);
    }

    [Fact]
    public void ADifferentFlagIsOneSet()
    {
        var set = Assert.Single(Compile("site property Flag: Boolean secret -- @s1", "site property Flag: Boolean os:IsSecret=false -- @s1", Types).Ops());
        Assert.Equal("IsSecret", set.Op["prop"]!.ToString());
    }

    private enum AutoNumberProbe { No, Yes, YesIfEmpty }

    [Theory]
    [InlineData("true", typeof(bool), true)]
    [InlineData("FALSE", typeof(bool), false)]
    [InlineData("yes", typeof(bool), null)]
    [InlineData("Yes", typeof(bool), null)]
    [InlineData("no", typeof(bool), null)]
    [InlineData("Yes", typeof(AutoNumberProbe), true)]
    [InlineData("yesifempty", typeof(AutoNumberProbe), true)]
    [InlineData("no", typeof(AutoNumberProbe), false)]
    [InlineData("true", typeof(AutoNumberProbe), null)]
    [InlineData("True", null, true)]
    [InlineData("Yes", null, true)]
    [InlineData("No", null, false)]
    [InlineData("yes", null, null)]
    public void AFlagIsReadAsTheSetVerbReadsItsType(string value, Type? type, bool? expected)
    {
        Assert.Equal(expected, DdlValues.Flag(value, type));
        // What a rule fills is written in the type's own form.
        Assert.Equal(type == typeof(bool) ? "True" : type == null ? "True" : "Yes", DdlValues.FlagText(true, type, type == null ? "True" : "Yes"));
    }

    [Fact]
    public void ANativeValueParsesOnlyAsTheSetVerbParsesIt()
    {
        Assert.Null(DdlValues.Native("yes", typeof(bool)));
        Assert.Null(DdlValues.Native("5.0", typeof(int)));
        Assert.Null(DdlValues.Native("Urgent", typeof(Priority)));
        Assert.Null(DdlValues.Native("1", typeof(Priority)));
        Assert.Equal("High", DdlValues.Native("hIgH", typeof(Priority)));
        Assert.Equal("True", DdlValues.Native(" true ", typeof(bool)));
        Assert.Equal("7", DdlValues.Native("007", typeof(long)));
        Assert.Null(DdlValues.Canonical("Timer", "Schedule", null, typeof(string)));
        // A text property keeps its case: "True" and "true" of a label are two texts.
        Assert.Equal("true", DdlValues.Canonical("EntityAttribute", "Label", "true", typeof(string)));
        Assert.False(DdlValues.Same("EntityAttribute", "Label", "True", "true", typeof(string)));
    }
}
