using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.CSharp;
using Xunit;

namespace Anvil.CSharp.Tests;

public class TemporalCompilerTests
{
    private const string Source = """
        using System.Globalization;
        public sealed record DateParts(int Year,int Month,int Day,int DayOfYear);
        public static class Calendar
        {
            public static DateOnly Make(int year,int month,int day)=>new(year,month,day);
            public static DateOnly FromNumber(int day)=>DateOnly.FromDayNumber(day);
            public static DateOnly Add(DateOnly date,int days)=>date.AddDays(days);
            public static DateOnly First()=>DateOnly.MinValue;
            public static DateOnly Last()=>DateOnly.MaxValue;
            public static DateOnly Zero()=>default;
            public static int Number(DateOnly date)=>date.DayNumber;
            public static DateParts Parts(DateOnly date)=>new(date.Year,date.Month,date.Day,date.DayOfYear);
            public static string Label(DateOnly date)=>date.ToString("yyyy-MM-dd",CultureInfo.InvariantCulture);
            public static string CustomLabel(DateOnly date)=>date.ToString("'Day:' d / MM / yyyy",CultureInfo.InvariantCulture);
            public static bool Before(DateOnly? left,DateOnly? right)=>left<right;
            public static bool Equal(DateOnly? left,DateOnly? right)=>left==right;
            public static int Compare(DateOnly left,DateOnly right)=>left.CompareTo(right);
            public static TimeOnly Clock(long ticks)=>new(ticks);
            public static TimeOnly At(int hour,int minute,int second,int millisecond,int microsecond)=>new(hour,minute,second,millisecond,microsecond);
            public static TimeOnly Shift(TimeOnly time,int minutes)=>time.AddMinutes(minutes);
            public static TimeOnly Fraction(TimeOnly time)=>time.AddHours(0.00000001);
            public static long LastTick()=>TimeOnly.MaxValue.Ticks;
            public static bool Between(TimeOnly clock,TimeOnly start,TimeOnly end)=>clock.IsBetween(start,end);
            public static bool SameClock(TimeOnly? left,TimeOnly? right)=>left==right;
            public static int Nanosecond(TimeOnly time)=>time.Nanosecond;
        }
        """;
    private static CompilationResult Compile(string source = Source) => CSharpCompiler.Compile(new Dictionary<string,string> { ["Temporal.cs"] = source });
    private static Dictionary<string,object> Date(DateOnly date) => new() { ["DayNumber"] = (decimal)date.DayNumber };
    private static Dictionary<string,object> Clock(long ticks) => new() { ["Ticks"] = (decimal)ticks };
    private static Dictionary<string,object> Optional(object? value) => value == null ? new() { ["HasValue"] = false }
        : new() { ["HasValue"] = true, ["Value"] = value };
    private static object Run(string name, params (string Name,object Value)[] inputs) => Run(Compile(), name, inputs);
    private static object Run(CompilationResult result,string name,params (string Name,object Value)[] inputs)
        => new TemporalGraphProbe(result.Specification["logic"]!["actions"]!.AsArray().Single(a=>a!["name"]!.ToString()==name)!.AsObject(),
            inputs.ToDictionary(p=>"Arg_"+p.Name,p=>p.Value)).Run();

    [Fact]
    public void ValueTransportIsTypedAndSeparateFromDateTimeStorage()
    {
        var result=Compile(); var structures=result.Specification["data"]!["structures"]!.AsArray();
        Assert.Equal("Integer",structures.Single(s=>s!["name"]!.ToString()=="AvTemporal_DateOnly")!["attributes"]![0]!["type"]!.ToString());
        Assert.Equal("Long Integer",structures.Single(s=>s!["name"]!.ToString()=="AvTemporal_TimeOnly")!["attributes"]![0]!["type"]!.ToString());
        Assert.Contains(structures,s=>s!["name"]!.ToString().StartsWith("AvOptional_")&&s["attributes"]![1]!["type"]!.ToString()=="AvTemporal_DateOnly");
        var error=Assert.Throws<SourceCompilationException>(()=>Compile("using Anvil.Authoring; [Entity] public class Stored {public long Id{get;set;} public DateOnly Day{get;set;}}"));
        Assert.Contains(error.Diagnostics,d=>d.Code=="AVCS229");
        Assert.Equal(result.Specification.ToJsonString(),Compile().Specification.ToJsonString());
    }
    [Fact]
    public void SourceTypesWithFrameworkNamesDoNotBecomeTemporalIntrinsics()
    {
        var result=Compile("namespace System { public sealed record DateOnly(int DayNumber); } public static class R {public static System.DateOnly Make(int n)=>new(n);}");
        Assert.DoesNotContain(result.Specification["data"]!["structures"]!.AsArray(),s=>s!["name"]!.ToString().StartsWith("AvTemporal_"));
        var collision=Compile("public sealed record AvTemporal_DateOnly(int Code); public static class R {public static DateOnly First()=>DateOnly.MinValue;}");
        Assert.Contains(collision.Specification["data"]!["structures"]!.AsArray(),s=>s!["name"]!.ToString()=="AvTemporal_DateOnly_");
    }
    [Theory]
    [InlineData(1,1,1)] [InlineData(9999,12,31)] [InlineData(2024,2,29)] [InlineData(2100,3,1)]
    [InlineData(1600,2,29)] [InlineData(1900,2,28)] [InlineData(99,12,31)] [InlineData(100,1,1)]
    public void GregorianPartsAndInvariantLabelsKeepFullCivilRange(int year,int month,int day)
    {
        var result=Compile(); var date=new DateOnly(year,month,day);
        Assert.Equal(date.DayNumber,(decimal)((Dictionary<string,object>)Run(result,"Make",("year",(decimal)year),("month",(decimal)month),("day",(decimal)day)))["DayNumber"]);
        var parts=(Dictionary<string,object>)Run(result,"Parts",("date",Date(date)));
        Assert.Equal((decimal)year,parts["Year"]); Assert.Equal((decimal)month,parts["Month"]); Assert.Equal((decimal)day,parts["Day"]); Assert.Equal((decimal)date.DayOfYear,parts["DayOfYear"]);
        Assert.Equal(date.ToString("yyyy-MM-dd",CultureInfo.InvariantCulture),Run(result,"Label",("date",Date(date))));
        Assert.Equal(date.ToString("'Day:' d / MM / yyyy",CultureInfo.InvariantCulture),Run(result,"CustomLabel",("date",Date(date))));
    }
    [Theory]
    [InlineData(2024,2,28,1)] [InlineData(2024,3,1,-1)] [InlineData(2100,2,28,1)] [InlineData(2023,12,31,1)]
    [InlineData(1,1,1,3652058)] [InlineData(9999,12,31,-3652058)]
    public void AddDaysUsesCheckedCivilRangeWithoutMachineTime(int year,int month,int day,int days)
    {
        var date=new DateOnly(year,month,day);
        Assert.Equal((decimal)date.AddDays(days).DayNumber,((Dictionary<string,object>)Run("Add",("date",Date(date)),("days",(decimal)days)))["DayNumber"]);
    }
    [Theory] [InlineData(0,-1)] [InlineData(3652058,1)] [InlineData(0,int.MinValue)] [InlineData(3652058,int.MaxValue)]
    public void AddDaysRejectsBothRangeEdgesBeforeNativeIntegerConversion(int dayNumber,int days)
    {
        var failure=Assert.Throws<TemporalGraphProbe.Failure>(()=>Run("Add",("date",Date(DateOnly.FromDayNumber(dayNumber))),("days",(decimal)days)));
        Assert.Equal("ArgumentOutOfRangeException",failure.Kind);
        Assert.Equal("Value to add was out of range. (Parameter 'value')",failure.Message);
    }
    [Fact]
    public void NullableComparisonsPreserveAbsenceAndTheMinimumCivilDate()
    {
        var result=Compile(); var none=Optional(null); var zero=Optional(Date(DateOnly.MinValue)); var later=Optional(Date(DateOnly.MinValue.AddDays(1)));
        Assert.Equal(true,Run(result,"Equal",("left",none),("right",none)));
        Assert.Equal(false,Run(result,"Equal",("left",none),("right",zero)));
        Assert.Equal(false,Run(result,"Before",("left",none),("right",later)));
        Assert.Equal(true,Run(result,"Before",("left",zero),("right",later)));
        Assert.Equal((decimal)3652058,((Dictionary<string,object>)Run(result,"Last"))["DayNumber"]);
        Assert.Equal(0m,((Dictionary<string,object>)Run(result,"Zero"))["DayNumber"]);
        Assert.Equal(0m,((Dictionary<string,object>)Run(result,"First"))["DayNumber"]);
    }
    [Theory]
    [InlineData(0L)] [InlineData(1L)] [InlineData(863999999999L)] [InlineData(432001234567L)]
    public void TimeOnlyRetainsEveryHundredNanosecondTick(long ticks)
    {
        var result=Compile(); Assert.Equal((decimal)ticks,((Dictionary<string,object>)Run(result,"Clock",("ticks",(decimal)ticks)))["Ticks"]);
        Assert.Equal((decimal)new TimeOnly(ticks).Nanosecond,Run(result,"Nanosecond",("time",Clock(ticks))));
        Assert.Equal(863999999999m,Run(result,"LastTick"));
        Assert.Equal(false,Run(result,"SameClock",("left",Optional(null)),("right",Optional(Clock(0)))));
    }
    [Theory]
    [InlineData(23,22,6,true)] [InlineData(0,22,6,true)] [InlineData(6,22,6,false)]
    [InlineData(8,8,8,false)] [InlineData(8,8,17,true)] [InlineData(17,8,17,false)]
    public void TimeOnlyIntervalsWrapAtMidnightWithAnExclusiveEnd(int hour,int starts,int ends,bool expected)
    {
        Assert.Equal(expected,Run("Between",("clock",Clock(new TimeOnly(hour,0).Ticks)),("start",Clock(new TimeOnly(starts,0).Ticks)),("end",Clock(new TimeOnly(ends,0).Ticks))));
    }
    [Theory]
    [InlineData(0L,-1)] [InlineData(863999999999L,1)] [InlineData(1L,int.MinValue)] [InlineData(863999999999L,int.MaxValue)]
    public void IntegralMinuteAdditionWrapsWithoutLosingTicks(long ticks,int minutes)
    {
        var clock=new TimeOnly(ticks); var result=Compile();
        Assert.Equal((decimal)clock.AddMinutes(minutes).Ticks,((Dictionary<string,object>)Run(result,"Shift",("time",Clock(ticks)),("minutes",(decimal)minutes)))["Ticks"]);
        Assert.Equal((decimal)clock.AddHours(0.00000001).Ticks,((Dictionary<string,object>)Run(result,"Fraction",("time",Clock(ticks))))["Ticks"]);
    }
    [Theory]
    [InlineData(-1)] [InlineData(3652059)] [InlineData(int.MinValue)] [InlineData(int.MaxValue)]
    public void FromDayNumberPreservesFrameworkRangeFailures(int day)
    {
        var expected=Assert.Throws<ArgumentOutOfRangeException>(()=>DateOnly.FromDayNumber(day));
        var actual=Assert.Throws<TemporalGraphProbe.Failure>(()=>Run("FromNumber",("day",(decimal)day)));
        Assert.Equal(expected.GetType().Name,actual.Kind); Assert.Equal(expected.Message,actual.Message);
    }
    [Theory]
    [InlineData(0,1,1)] [InlineData(2023,2,29)] [InlineData(2100,2,29)] [InlineData(2024,13,1)] [InlineData(10000,1,1)]
    public void CalendarConstructionRejectsInvalidComponents(int year,int month,int day)
    {
        var expected=Assert.Throws<ArgumentOutOfRangeException>(()=>new DateOnly(year,month,day));
        var actual=Assert.Throws<TemporalGraphProbe.Failure>(()=>Run("Make",("year",(decimal)year),("month",(decimal)month),("day",(decimal)day)));
        Assert.Equal(expected.GetType().Name,actual.Kind); Assert.Equal(expected.Message,actual.Message);
    }
    [Theory]
    [InlineData(-1L)] [InlineData(864000000000L)] [InlineData(long.MinValue)] [InlineData(long.MaxValue)]
    public void TimeOnlyConstructionRejectsValuesOutsideOneDay(long ticks)
    {
        var expected=Assert.Throws<ArgumentOutOfRangeException>(()=>new TimeOnly(ticks));
        var actual=Assert.Throws<TemporalGraphProbe.Failure>(()=>Run("Clock",("ticks",(decimal)ticks)));
        Assert.Equal(expected.GetType().Name,actual.Kind); Assert.Equal(expected.Message,actual.Message);
    }
    [Theory]
    [InlineData(0,0,0,0,0)] [InlineData(23,59,59,999,999)] [InlineData(24,0,0,0,0)] [InlineData(0,60,0,0,0)]
    [InlineData(0,0,60,0,0)] [InlineData(0,0,0,1000,0)] [InlineData(0,0,0,0,1000)]
    public void TimeComponentsUseTheOriginalConstructorContract(int hour,int minute,int second,int millisecond,int microsecond)
    {
        var args=new (string,object)[]{("hour",(decimal)hour),("minute",(decimal)minute),("second",(decimal)second),("millisecond",(decimal)millisecond),("microsecond",(decimal)microsecond)};
        TimeOnly expected;
        try { expected=new(hour,minute,second,millisecond,microsecond); }
        catch(ArgumentOutOfRangeException failure)
        {
            var actual=Assert.Throws<TemporalGraphProbe.Failure>(()=>Run("At",args));
            Assert.Equal(failure.GetType().Name,actual.Kind);Assert.Equal(failure.Message,actual.Message);return;
        }
        Assert.Equal((decimal)expected.Ticks,((Dictionary<string,object>)Run("At",args))["Ticks"]);
    }
    [Theory]
    [InlineData("public static class R { public static DateOnly Run(DateTime value)=>DateOnly.FromDateTime(value); }")]
    [InlineData("public static class R { public static TimeOnly Run(TimeOnly value,double minutes)=>value.AddMinutes(minutes); }")]
    [InlineData("public static class R { public static string Run(DateOnly value)=>value.ToString(); }")]
    [InlineData("public static class R { public static TimeOnly Run(TimeOnly value,int hours)=>value.AddHours(hours); }")]
    [InlineData("using Anvil.Authoring; [Entity] public class Item { public long Id{get;set;} } public static class R { public static DateOnly[] Run(IDataSession db,DateOnly value)=>db.Query<Item>().Select(i=>value).ToArray(); }")]
    public void UnimplementedTemporalSemanticsRemainSourceDiagnostics(string source)
        => Assert.NotEmpty(Assert.Throws<SourceCompilationException>(()=>Compile(source)).Diagnostics);
}

// Executes only the emitted control/decimal/text subset used by these compiler tests.
// It is an independent arithmetic check of lowering, not a substitute for O11 Verify/server execution.
internal sealed class TemporalGraphProbe(JsonObject action,Dictionary<string,object> values)
{
    internal sealed class Failure(string kind,string message) : Exception(message) { public string Kind=>kind; }
    internal object Run() { Steps(action["steps"]!.AsArray()); return Get("AvResult"); }
    private bool Steps(JsonArray steps)
    {
        foreach(var node in steps.Cast<JsonObject>())
        {
            if(node["assign"] is JsonObject assignment) foreach(var pair in assignment) Set(pair.Key,Eval(pair.Value!.ToString()));
            else if(node["if"] is {} condition) { var branch=node[Truth(Eval(condition.ToString()))?"then":"else"] as JsonArray; if(branch!=null&&!Steps(branch))return false; }
            else if(node["while"] is {} loop) { var count=0; while(Truth(Eval(loop.ToString()))) { if(++count>1000)throw new Exception("Unbounded emitted loop"); if(!Steps(node["do"]!.AsArray()))return false; } }
            else if(node["raise"] is {} raised) throw new Failure(raised.ToString(),(string)Eval(node["message"]!.ToString()));
            else if(node["return"] != null)return false;
            else throw new Exception("Unsupported emitted step: "+node);
        }
        return true;
    }
    private static object Copy(object value)=>value is Dictionary<string,object> fields?fields.ToDictionary(p=>p.Key,p=>Copy(p.Value)):value;
    private object Get(string path)
    {
        object value=values;
        foreach(var part in path.Split('.')) { if(value is not Dictionary<string,object> fields||!fields.TryGetValue(part,out value!))return 0m; }
        return value;
    }
    private void Set(string path,object value)
    {
        var parts=path.Split('.'); var fields=values;
        foreach(var part in parts.SkipLast(1)) { if(!fields.TryGetValue(part,out var child))fields[part]=child=new Dictionary<string,object>(); fields=(Dictionary<string,object>)child; }
        fields[parts[^1]]=Copy(value);
    }
    private static bool Truth(object value)=>value is bool b?b:(decimal)value!=0;
    private object Eval(string expression)
    {
        var tokens=Regex.Matches(expression,"\"(?:\"\"|[^\"])*\"|[A-Za-z_][A-Za-z_0-9.]*|[0-9]+(?:\\.[0-9]+)?|<>|<=|>=|[()+*/%,=<>-]").Select(m=>m.Value).ToArray(); var position=0;
        string Peek()=>position<tokens.Length?tokens[position]:"";
        void Expect(string token) { if(Peek()!=token)throw new Exception("Expected "+token+" in "+expression); position++; }
        static int Priority(string op)=>op switch {"or"=>1,"and"=>2,"=" or "<>" or "<" or ">" or "<=" or ">="=>3,"+" or "-"=>4,"*" or "/"=>5,_=>0};
        Func<object> Parse(int minimum=1)
        {
            var token=tokens[position++]; Func<object> left;
            if(token=="(") { left=Parse();Expect(")"); }
            else if(token is "-" or "not") {var operand=Parse(6);left=token=="-"?()=>-(decimal)operand():()=>!Truth(operand());}
            else if(token.StartsWith('"'))left=()=>token[1..^1].Replace("\"\"","\"");
            else if(decimal.TryParse(token,NumberStyles.Number,CultureInfo.InvariantCulture,out var number))left=()=>number;
            else if(token is "True" or "False")left=()=>token=="True";
            else if(Peek()=="(")
            {
                position++;var args=new List<Func<object>>();if(Peek()!=")") {do {args.Add(Parse());if(Peek()!=",")break;position++;}while(true);}Expect(")");
                left=()=>token switch
                {
                    "If"=>Truth(args[0]())?args[1]():args[2](),"Trunc"=>decimal.Truncate((decimal)args[0]()),
                    "DecimalToInteger" or "DecimalToLongInteger"=>decimal.Round((decimal)args[0](),0,MidpointRounding.ToEven),
                    "Abs"=>Math.Abs((decimal)args[0]()),"Mod"=>(decimal)args[0]()%(decimal)args[1](),"IntegerToText"=>((decimal)args[0]()).ToString(CultureInfo.InvariantCulture),
                    "Length"=>(decimal)((string)args[0]()).Length,"Substr"=>((string)args[0]()).Substring((int)(decimal)args[1](),(int)(decimal)args[2]()),
                    "Chr"=>((char)(int)(decimal)args[0]()).ToString(),_=>throw new Exception("Unsupported function "+token)
                };
            }
            else left=()=>Get(token);
            while(Priority(Peek())>=minimum) {var op=tokens[position++];var before=left;var right=Parse(Priority(op)+1);left=()=>Apply(op,before,right);}
            return left;
        }
        var result=Parse();if(position!=tokens.Length)throw new Exception("Trailing expression: "+expression);return result();
    }
    private static object Apply(string op,Func<object> left,Func<object> right)
    {
        if(op=="and")return Truth(left())&&Truth(right());if(op=="or")return Truth(left())||Truth(right());
        var a=left();var b=right();if(op=="=")return Equals(a,b);if(op=="<>")return !Equals(a,b);
        if(op=="+"&&(a is string||b is string))return (string)a+(string)b;
        var x=(decimal)a;var y=(decimal)b;
        return op switch {"+"=>x+y,"-"=>x-y,"*"=>x*y,"/"=>x/y,"<"=>x<y,">"=>x>y,"<="=>x<=y,">="=>x>=y,_=>throw new Exception(op)};
    }
}
