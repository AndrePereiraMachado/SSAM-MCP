using System.Globalization;
using System.Text.Json.Nodes;
using Anvil.CSharp;
using Xunit;

namespace Anvil.CSharp.Tests;

public class TemporalInstantCompilerTests
{
    private const string Source = """
        using System.Globalization;
        public static class Instants
        {
            public static TimeSpan Duration(long ticks)=>new(ticks);
            public static TimeSpan Sum(TimeSpan a,TimeSpan b)=>a+b;
            public static TimeSpan Difference(TimeSpan a,TimeSpan b)=>a-b;
            public static TimeSpan Negate(TimeSpan a)=>-a;
            public static TimeSpan Compound(TimeSpan a,TimeSpan b){a+=b;return a;}
            public static TimeSpan? Lifted(TimeSpan? a,TimeSpan? b)=>a+b;
            public static TimeSpan? LiftedNegate(TimeSpan? a)=>-a;
            public static TimeSpan? CompoundNullable(TimeSpan? a,TimeSpan? b){a+=b;return a;}
            public static long WrapProduct(long value)=>unchecked(value * -8589934591L);
            public static TimeSpan Days(int days)=>TimeSpan.FromDays(days);
            public static TimeSpan Minutes(int minutes)=>TimeSpan.FromMinutes(minutes);
            public static TimeSpan RoundedMinutes()=>TimeSpan.FromMinutes(7686143365d);
            public static TimeSpan PositiveLimit()=>TimeSpan.FromMinutes(15372286728.091293d);
            public static TimeSpan BadDuration()=>TimeSpan.FromDays(double.NaN);
            public static TimeSpan MinimumDuration()=>TimeSpan.MinValue;
            public static TimeSpan MaximumDuration()=>TimeSpan.MaxValue;
            public static long Product(int minutes)=>(long)minutes*TimeSpan.TicksPerMinute;
            public static DateTimeOffset Make(long ticks,long offsetTicks)=>new(ticks,new TimeSpan(offsetTicks));
            public static DateTimeOffset First()=>DateTimeOffset.MinValue;
            public static DateTimeOffset Last()=>DateTimeOffset.MaxValue;
            public static DateTimeOffset Shift(DateTimeOffset value,int minutes)=>value.AddMinutes(minutes);
            public static DateTimeOffset Fraction(DateTimeOffset value)=>value.AddMinutes(0.00000001);
            public static DateTimeOffset AddTicks(DateTimeOffset value,long ticks)=>value.AddTicks(ticks);
            public static DateTimeOffset AddDuration(DateTimeOffset value,TimeSpan duration)=>value+duration;
            public static DateTimeOffset SubtractDuration(DateTimeOffset value,TimeSpan duration)=>value-duration;
            public static DateTimeOffset AddDurationMethod(DateTimeOffset value,TimeSpan duration)=>value.Add(duration);
            public static DateTimeOffset? CompoundOffsetNullable(DateTimeOffset? value,TimeSpan? duration){value+=duration;return value;}
            public static TimeSpan Elapsed(DateTimeOffset a,DateTimeOffset b)=>a-b;
            public static long ClockTicks(DateTimeOffset value)=>value.Ticks;
            public static long UtcTicks(DateTimeOffset value)=>value.UtcTicks;
            public static TimeSpan Offset(DateTimeOffset value)=>value.Offset;
            public static bool Same(DateTimeOffset a,DateTimeOffset b)=>a==b;
            public static bool Exact(DateTimeOffset a,DateTimeOffset b)=>a.EqualsExact(b);
            public static bool? Before(DateTimeOffset? a,DateTimeOffset? b)=>a<b;
            public static DateOnly Date(DateTimeOffset value)=>DateOnly.FromDateTime(value.UtcDateTime);
            public static TimeOnly Time(DateTimeOffset value)=>TimeOnly.FromDateTime(value.UtcDateTime);
            public static int UtcKind(DateTimeOffset value)=>(int)value.UtcDateTime.Kind;
            public static int CivilKind(DateTimeOffset value)=>(int)value.DateTime.Kind;
            public static DateOnly CivilDate(DateTimeOffset value)=>DateOnly.FromDateTime(value.DateTime);
            public static DateOnly DateFromTicks(long ticks)=>DateOnly.FromDateTime(new DateTime(ticks));
            public static int KindFromTicks(long ticks,int kind)=>(int)new DateTime(ticks,(DateTimeKind)kind).Kind;
            public static string Stamp(DateTimeOffset value)=>value.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",CultureInfo.InvariantCulture);
            public static string Roundtrip(DateTimeOffset value)=>value.ToString("O",CultureInfo.InvariantCulture);
            public static TimeSpan ClockDuration(TimeOnly time)=>time.ToTimeSpan();
            public static TimeSpan ClockDifference(TimeOnly a,TimeOnly b)=>a-b;
        }
        """;
    private static CompilationResult Compile(string source = Source)=>CSharpCompiler.Compile(new Dictionary<string,string>{["Instants.cs"]=source});
    private static Dictionary<string,object> Span(long ticks)=>new(){["Ticks"]=(decimal)ticks};
    private static Dictionary<string,object> Dto(DateTimeOffset value)=>new(){["UtcTicks"]=(decimal)value.UtcTicks,["OffsetMinutes"]=(decimal)value.Offset.TotalMinutes};
    private static Dictionary<string,object> Option(object? value)=>value==null?new(){["HasValue"]=false}:new(){["HasValue"]=true,["Value"]=value};
    private static object Run(string method,params (string Name,object Value)[] args)=>Run(Compile(),method,args);
    private static object Run(CompilationResult compiled,string method,params (string Name,object Value)[] args)
        =>new TemporalGraphProbe(compiled.Specification["logic"]!["actions"]!.AsArray().Single(a=>a!["name"]!.ToString()==method)!.AsObject(),args.ToDictionary(p=>"Arg_"+p.Name,p=>p.Value)).Run();
    private static long Ticks(object result)=>(long)(decimal)((Dictionary<string,object>)result)["Ticks"];
    private static DateTimeOffset Timestamp(object result)
    {
        var fields=(Dictionary<string,object>)result;var utc=(long)(decimal)fields["UtcTicks"];var offset=TimeSpan.FromMinutes((double)(decimal)fields["OffsetMinutes"]);
        return new DateTimeOffset(utc,TimeSpan.Zero).ToOffset(offset);
    }
    private static void SameFailure(Action reference,Action lowered)
    {
        var expected=Record.Exception(reference);Assert.NotNull(expected);
        var actual=Assert.Throws<TemporalGraphProbe.Failure>(lowered);Assert.Equal(expected.GetType().Name,actual.Kind);Assert.Equal(expected.Message,actual.Message);
    }
    private static TimeSpan BoundIntegerFactory(string name, int value)
    {
        // The test assembly targets net8; authored sources bind against the running runtime's BCL.
        // Use that same overload as the oracle, including its distinct overflow exception.
        var parameter = name == "FromDays" ? typeof(int) : typeof(long);
        var method = typeof(TimeSpan).GetMethod(name, [parameter]);
        if (method == null) return name == "FromDays" ? TimeSpan.FromDays(value) : TimeSpan.FromMinutes(value);
        try { return (TimeSpan)method.Invoke(null, [parameter == typeof(int) ? (object)value : (long)value])!; }
        catch (System.Reflection.TargetInvocationException error) {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw;
        }
    }
    [Fact]
    public void TemporalShapesKeepSignedTicksOffsetsAndExactIntermediates()
    {
        var compiled=Compile();var shapes=compiled.Specification["data"]!["structures"]!.AsArray();
        Assert.Equal(new[]{"UtcTicks","OffsetMinutes"},shapes.Single(s=>s!["name"]!.ToString()=="AvTemporal_DateTimeOffset")!["attributes"]!.AsArray().Select(a=>a!["name"]!.ToString()));
        Assert.Equal(new[]{"Ticks","Kind"},shapes.Single(s=>s!["name"]!.ToString()=="AvTemporal_DateTime")!["attributes"]!.AsArray().Select(a=>a!["name"]!.ToString()));
        Assert.Equal(long.MinValue,Ticks(Run(compiled,"MinimumDuration")));Assert.Equal(long.MaxValue,Ticks(Run(compiled,"MaximumDuration")));
        Assert.Equal(DateTimeOffset.MinValue,Timestamp(Run(compiled,"First")));Assert.Equal(DateTimeOffset.MaxValue,Timestamp(Run(compiled,"Last")));
    }
    [Theory]
    [InlineData(0L,0L)] [InlineData(1L,-1L)] [InlineData(long.MaxValue,-1L)] [InlineData(long.MinValue,1L)]
    [InlineData(863999999999L,1L)] [InlineData(long.MaxValue,1L)] [InlineData(long.MinValue,-1L)]
    public void DurationArithmeticPreservesOverflowRegardlessOfCheckedContext(long a,long b)
    {
        var compiled=Compile();var x=TimeSpan.FromTicks(a);var y=TimeSpan.FromTicks(b);
        foreach(var method in new[]{"Sum","Compound","Difference"})
        {
            TimeSpan expected;
            try { expected=method=="Difference"?x-y:x+y; }
            catch(OverflowException)
            { SameFailure(()=>{_=method=="Difference"?x-y:x+y;},()=>Run(compiled,method,("a",Span(a)),("b",Span(b))));continue; }
            Assert.Equal(expected.Ticks,Ticks(Run(compiled,method,("a",Span(a)),("b",Span(b)))));
        }
    }
    [Theory] [InlineData(0L)] [InlineData(1L)] [InlineData(-1L)] [InlineData(long.MaxValue)] [InlineData(long.MinValue)]
    public void DurationNegationIncludesTheSignedMinimumGuard(long ticks)
    {
        if(ticks==long.MinValue) { SameFailure(()=>{_= -TimeSpan.FromTicks(ticks);},()=>Run("Negate",("a",Span(ticks))));return; }
        Assert.Equal((-TimeSpan.FromTicks(ticks)).Ticks,Ticks(Run("Negate",("a",Span(ticks)))));
    }
    [Fact]
    public void NullableDurationsDoNotEvaluateAbsentPayloads()
    {
        var compiled=Compile();var absent=Option(null);var present=Option(Span(long.MaxValue));
        Assert.Equal(false,((Dictionary<string,object>)Run(compiled,"Lifted",("a",absent),("b",present)))["HasValue"]);
        Assert.Equal(false,((Dictionary<string,object>)Run(compiled,"LiftedNegate",("a",absent)))["HasValue"]);
        var result=(Dictionary<string,object>)Run(compiled,"Lifted",("a",Option(Span(1))),("b",Option(Span(-1))));
        Assert.Equal(true,result["HasValue"]);Assert.Equal(0,Ticks(result["Value"]));
    }
    [Theory] [InlineData(0)] [InlineData(1)] [InlineData(-1)] [InlineData(10675199)] [InlineData(-10675199)] [InlineData(10675200)] [InlineData(int.MinValue)] [InlineData(int.MaxValue)]
    public void IntegralFactoriesUseOnlyProvenExactDomains(int value)
    {
        var compiled=Compile();
        if(Math.Abs((long)value)>10675199) SameFailure(()=>BoundIntegerFactory("FromDays",value),()=>Run(compiled,"Days",("days",(decimal)value)));
        else Assert.Equal(BoundIntegerFactory("FromDays",value).Ticks,Ticks(Run(compiled,"Days",("days",(decimal)value))));
        Assert.Equal(BoundIntegerFactory("FromMinutes",value).Ticks,Ticks(Run(compiled,"Minutes",("minutes",(decimal)value))));
        Assert.Equal((decimal)((long)value*TimeSpan.TicksPerMinute),Run(compiled,"Product",("minutes",(decimal)value)));
    }
    [Theory]
    [InlineData("FromHours",36000000000L)]
    [InlineData("FromMinutes",600000000L)]
    [InlineData("FromSeconds",10000000L)]
    [InlineData("FromMilliseconds",10000L)]
    [InlineData("FromMicroseconds",10L)]
    public void BoundLongFactoriesPreserveExactTicksAndOverflow(string factory,long factor)
    {
        var parameter = factory == "FromHours" ? typeof(int) : typeof(long);
        var source = "public static class R {public static TimeSpan Make(" + (parameter == typeof(int) ? "int" : "long") + " value)=>TimeSpan." + factory + "(value);}";
        var native = typeof(TimeSpan).GetMethod(factory, [parameter]);
        if (native == null) return; // Integer overloads are absent on net8; existing double tests cover that runtime.
        var compiled = Compile(source); var limit = long.MaxValue / factor;
        var cases = new[] { 0L, 1L, -1L, limit, -limit, limit + 1, -limit - 1,
            parameter == typeof(int) ? int.MaxValue : long.MaxValue, parameter == typeof(int) ? int.MinValue : long.MinValue };
        foreach (var value in cases) {
            TimeSpan expected = default;
            var failure = Record.Exception(() => expected = (TimeSpan)native.Invoke(null, [parameter == typeof(int) ? (object)(int)value : value])!);
            if (failure == null) Assert.Equal(expected.Ticks,Ticks(Run(compiled,"Make",("value",(decimal)value))));
            else {
                var inner = Assert.IsType<System.Reflection.TargetInvocationException>(failure).InnerException!;
                var actual = Assert.Throws<TemporalGraphProbe.Failure>(() => Run(compiled,"Make",("value",(decimal)value)));
                Assert.Equal(inner.GetType().Name,actual.Kind); Assert.Equal(inner.Message,actual.Message);
            }
        }
    }
    [Fact]
    public void ConstantFactoriesRetainIeeeRoundingAndPositiveLimitSaturation()
    {
        var compiled=Compile();
        Assert.Equal(TimeSpan.FromMinutes(7686143365d).Ticks,Ticks(Run(compiled,"RoundedMinutes")));
        Assert.Equal(4611686019000000512L,Ticks(Run(compiled,"RoundedMinutes")));
        Assert.Equal(TimeSpan.FromMinutes(15372286728.091293d).Ticks,Ticks(Run(compiled,"PositiveLimit")));
        SameFailure(()=>TimeSpan.FromDays(double.NaN),()=>Run(compiled,"BadDuration"));
    }
    [Theory]
    [InlineData(0L,0L)] [InlineData(3155378975999999999L,0L)] [InlineData(637134336001234567L,108000000000L)]
    [InlineData(0L,1L)] [InlineData(-1L,1L)] [InlineData(0L,504600000000L)] [InlineData(-1L,0L)]
    [InlineData(0L,600000000L)] [InlineData(3155378975999999999L,-600000000L)]
    public void OffsetConstructionPreservesValidationOrderAndBothRanges(long ticks,long offsetTicks)
    {
        DateTimeOffset expected;
        try { expected=new DateTimeOffset(ticks,TimeSpan.FromTicks(offsetTicks)); }
        catch(ArgumentException) { SameFailure(()=>new DateTimeOffset(ticks,TimeSpan.FromTicks(offsetTicks)),()=>Run("Make",("ticks",(decimal)ticks),("offsetTicks",(decimal)offsetTicks)));return; }
        Assert.True(expected.EqualsExact(Timestamp(Run("Make",("ticks",(decimal)ticks),("offsetTicks",(decimal)offsetTicks)))));
    }
    [Theory]
    [InlineData("0001-01-01T00:00:00+00:00",2147483647)] [InlineData("9999-12-31T23:59:59.9999999+00:00",-2147483648)]
    [InlineData("2026-09-07T23:59:59.1234567+00:00",15)] [InlineData("2024-03-01T00:00:00+03:00",-1)]
    [InlineData("0001-01-01T00:00:00+00:00",-1)] [InlineData("9999-12-31T23:59:59.9999999+00:00",1)]
    [InlineData("0001-01-01T01:00:00+01:00",-1)] [InlineData("9999-12-31T22:59:59.9999999-01:00",1)]
    public void MinuteShiftsPreserveTicksOffsetAndCivilThenUtcFailures(string text,int minutes)
    {
        var value=DateTimeOffset.Parse(text,CultureInfo.InvariantCulture);DateTimeOffset expected;
        try { expected=value.AddMinutes(minutes); }
        catch(ArgumentOutOfRangeException) {SameFailure(()=>value.AddMinutes(minutes),()=>Run("Shift",("value",Dto(value)),("minutes",(decimal)minutes)));return;}
        Assert.True(expected.EqualsExact(Timestamp(Run("Shift",("value",Dto(value)),("minutes",(decimal)minutes)))));
    }
    [Theory]
    [InlineData("0001-01-01T00:00:00+00:00")] [InlineData("9999-12-31T23:59:59.9999999+00:00")]
    [InlineData("2026-09-07T23:59:59.1234567+00:00")] [InlineData("2024-03-01T00:00:00.0000001+03:30")]
    public void ExactIntermediatesAndFormattingKeepUtcCivilAndFractionalComponents(string text)
    {
        var compiled=Compile();var value=DateTimeOffset.Parse(text,CultureInfo.InvariantCulture);var args=new[]{("value",(object)Dto(value))};
        Assert.Equal((decimal)value.Ticks,Run(compiled,"ClockTicks",args));Assert.Equal((decimal)value.UtcTicks,Run(compiled,"UtcTicks",args));
        Assert.Equal(value.Offset.Ticks,Ticks(Run(compiled,"Offset",args)));
        Assert.Equal((decimal)DateOnly.FromDateTime(value.UtcDateTime).DayNumber,((Dictionary<string,object>)Run(compiled,"Date",args))["DayNumber"]);
        Assert.Equal((decimal)DateOnly.FromDateTime(value.DateTime).DayNumber,((Dictionary<string,object>)Run(compiled,"CivilDate",args))["DayNumber"]);
        Assert.Equal(TimeOnly.FromDateTime(value.UtcDateTime).Ticks,Ticks(Run(compiled,"Time",args)));
        Assert.Equal(1m,Run(compiled,"UtcKind",args));Assert.Equal(0m,Run(compiled,"CivilKind",args));
        Assert.Equal(value.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",CultureInfo.InvariantCulture),Run(compiled,"Stamp",args));
        Assert.Equal(value.ToString("O",CultureInfo.InvariantCulture),Run(compiled,"Roundtrip",args));
    }
    [Fact]
    public void InstantIdentityIgnoresOffsetWhileEqualsExactPreservesIt()
    {
        var compiled=Compile();var a=new DateTimeOffset(2026,9,7,12,0,0,TimeSpan.Zero);var b=a.ToOffset(TimeSpan.FromHours(3));
        Assert.Equal(true,Run(compiled,"Same",("a",Dto(a)),("b",Dto(b))));Assert.Equal(false,Run(compiled,"Exact",("a",Dto(a)),("b",Dto(b))));
        Assert.Equal(0,Ticks(Run(compiled,"Elapsed",("a",Dto(a)),("b",Dto(b)))));
    }
    [Theory]
    [InlineData(0L,0)] [InlineData(3155378975999999999L,1)] [InlineData(1L,2)] [InlineData(-1L,3)] [InlineData(1L,3)]
    public void ExactDateTimeConstructionKeepsTicksKindAndValidationOrder(long ticks,int kind)
    {
        DateTime expected;
        try { expected=new DateTime(ticks,(DateTimeKind)kind); }
        catch(ArgumentException) { SameFailure(()=>new DateTime(ticks,(DateTimeKind)kind),()=>Run("KindFromTicks",("ticks",(decimal)ticks),("kind",(decimal)kind)));return; }
        var compiled=Compile();Assert.Equal((decimal)(int)expected.Kind,Run(compiled,"KindFromTicks",("ticks",(decimal)ticks),("kind",(decimal)kind)));
        Assert.Equal((decimal)DateOnly.FromDateTime(expected).DayNumber,((Dictionary<string,object>)Run(compiled,"DateFromTicks",("ticks",(decimal)ticks)))["DayNumber"]);
    }
    [Fact]
    public void ResidualTicksSurviveFractionalAdditionAndClockSubtractionHasItsOwnWrapRule()
    {
        var compiled=Compile();var timestamp=new DateTimeOffset(2026,9,7,0,0,0,TimeSpan.Zero).AddTicks(1);
        Assert.True(timestamp.AddMinutes(0.00000001).EqualsExact(Timestamp(Run(compiled,"Fraction",("value",Dto(timestamp))))));
        var a=new TimeOnly(0L);var b=TimeOnly.MaxValue;
        Assert.Equal((a-b).Ticks,Ticks(Run(compiled,"ClockDifference",("a",Span(a.Ticks)),("b",Span(b.Ticks)))));
        Assert.Equal(b.ToTimeSpan().Ticks,Ticks(Run(compiled,"ClockDuration",("time",Span(b.Ticks)))));
        var nullable=(Dictionary<string,object>)Run(compiled,"Before",("a",Option(null)),("b",Option(Dto(timestamp))));
        Assert.Equal(true,nullable["HasValue"]);Assert.Equal(false,nullable["Value"]);
    }
    [Theory]
    [InlineData("public static class R {public static DateTime Run(DateTimeOffset value)=>value.UtcDateTime;}")]
    [InlineData("public static class R {public static long Run(DateTimeOffset value){var utc=value.UtcDateTime;return utc.Ticks;}}")]
    [InlineData("public static class R {public static DateTimeOffset Run(DateTimeOffset value,double minutes)=>value.AddMinutes(minutes);}")]
    [InlineData("public static class R {public static TimeSpan Run(double minutes)=>TimeSpan.FromMinutes(minutes);}")]
    [InlineData("public static class R {public static TimeSpan Run(long minutes)=>TimeSpan.FromMinutes((double)minutes);}")]
    [InlineData("using Anvil.Authoring; [Entity] public class E {public long Id{get;set;} public DateTimeOffset At{get;set;}}")]
    public void UnimplementedPrecisionOrBoundarySemanticsRemainDiagnostics(string source)
        =>Assert.NotEmpty(Assert.Throws<SourceCompilationException>(()=>Compile(source)).Diagnostics);
    [Theory]
    [InlineData(long.MinValue)] [InlineData(long.MaxValue)] [InlineData(0L)] [InlineData(-1L)]
    public void WrappingNearTheDecimalLimitReducesBeforeAddingTheSignedOffset(long value)
        =>Assert.Equal((decimal)unchecked(value * -8589934591L),Run("WrapProduct",("value",(decimal)value)));
    [Fact]
    public void CompoundOptionalTemporalValuesReadOnlyPresentPayloads()
    {
        var compiled=Compile();
        var absent=(Dictionary<string,object>)Run(compiled,"CompoundNullable",("a",Option(null)),("b",Option(Span(long.MaxValue))));
        Assert.Equal(false,absent["HasValue"]);
        var present=(Dictionary<string,object>)Run(compiled,"CompoundNullable",("a",Option(Span(1))),("b",Option(Span(2))));
        Assert.Equal(true,present["HasValue"]);Assert.Equal(3,Ticks(present["Value"]));
        var offset=(Dictionary<string,object>)Run(compiled,"CompoundOffsetNullable",("value",Option(Dto(DateTimeOffset.MinValue))),("duration",Option(Span(1))));
        Assert.Equal(DateTimeOffset.MinValue.AddTicks(1),Timestamp(offset["Value"]));
        Assert.Equal(false,((Dictionary<string,object>)Run(compiled,"CompoundOffsetNullable",("value",Option(Dto(DateTimeOffset.MinValue))),("duration",Option(null))))["HasValue"]);
    }
    [Fact]
    public void DateOperatorsAndMethodsKeepTheirDistinctExceptionParameters()
    {
        var compiled=Compile();var low=DateTimeOffset.MinValue;var high=DateTimeOffset.MaxValue;var tick=TimeSpan.FromTicks(1);
        SameFailure(()=>{_=low-tick;},()=>Run(compiled,"SubtractDuration",("value",Dto(low)),("duration",Span(1))));
        SameFailure(()=>{_=high+tick;},()=>Run(compiled,"AddDuration",("value",Dto(high)),("duration",Span(1))));
        SameFailure(()=>high.Add(tick),()=>Run(compiled,"AddDurationMethod",("value",Dto(high)),("duration",Span(1))));
    }
    [Theory]
    [InlineData("public static class R {public static bool Run(DateTime value)=>value==DateTime.MinValue;}")]
    [InlineData("public static class R {public static bool Run(DateTime? value)=>value<DateTime.MaxValue;}")]
    [InlineData("public static class R {public static bool Run(DateTime value,DateTimeOffset other)=>value<other.UtcDateTime;}")]
    public void MixedLegacyAndExactDateTimeComparisonHasAnExplicitDiagnostic(string source)
        =>Assert.Contains(Assert.Throws<SourceCompilationException>(()=>Compile(source)).Diagnostics,d=>d.Message.Contains("DateTime")&&d.Message.Contains("codec"));
    [Fact]
    // Temporary no-partial-contract gate. Replace with full-source positive acceptance
    // when real reference presence lands; the unchanged cold corpus remains the target.
    public void OriginalColdSourceStillRequiresRealReferencePresence()
    {
        var source=File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Cases","ColdDateRules.cs.txt"));
        var errors=Assert.Throws<SourceCompilationException>(()=>Compile(source));
        Assert.Equal(3,errors.Diagnostics.Count);
        Assert.All(errors.Diagnostics,d=>Assert.Contains("ArgumentNullException.ThrowIfNull",d.Message));
    }
}
