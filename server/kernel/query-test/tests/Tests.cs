using System.Text.Json.Nodes;
using SSAM.QueryTesting;
using Xunit;

public class Tests
{
    [Fact]
    public void OutputPreservesEmptySuccessAndNativeErrorsAndEnforcesTotalBudget()
    {
        var empty=QueryTestOutput.Format(new(),true,"200",null,null,["Id"],[],10,false);
        Assert.True(empty["ok"]!.GetValue<bool>()); Assert.Equal(0,empty["count"]!.GetValue<int>());
        var error=QueryTestOutput.Format(new(),false,"403","permission denied",null,[],[],10,false);
        Assert.False(error["ok"]!.GetValue<bool>()); Assert.Equal("permission denied",error["error"]!.ToString());
        var large=QueryTestOutput.Format(new(),true,"200",null,new string('x',20000),Enumerable.Repeat(new string('漢',600),256).ToArray(),Enumerable.Range(0,510).Select(_=>new[]{new string('漢',10000)}).ToArray(),500,true);
        Assert.True(large["truncated"]!.GetValue<bool>()); Assert.True(large["sqlTruncated"]!.GetValue<bool>());
        Assert.InRange(System.Text.Encoding.UTF8.GetByteCount(large.ToJsonString()),1,QueryTestContract.MaxBytes);
    }
    [Theory]
    [InlineData("SELECT {Order}.[Id] FROM {Order} WHERE {Order}.[Id]=@Id")]
    [InlineData("-- update\n SELECT COUNT(*) FROM {Customer}; /* DELETE */")]
    [InlineData("SELECT 'delete; insert', [update] FROM {Thing}")]
    [InlineData("SELECT a FROM {Thing} WHERE a IN (1,2)")]
    [InlineData("SELECT REPLACE('delete','d','D') FROM {Thing}")]
    [InlineData("SELECT d.[Id] FROM {Thing} d LEFT JOIN (SELECT [Id] FROM {Other}) o ON o.[Id] = d.[Id]")]
    public void SelectSubset(string sql) => QueryTestContract.RequireReadSql(sql);

    [Theory]
    [InlineData("DELETE FROM {Thing}")]
    [InlineData("SELECT 1; DELETE FROM {Thing}")]
    [InlineData("SELECT 1 INTO scratch")]
    [InlineData("WITH changed AS (DELETE FROM x RETURNING *) SELECT * FROM changed")]
    [InlineData("SELECT nextval('counter')")]
    [InlineData("SELECT dbo.count(*) FROM x")]
    [InlineData("SELECT [exec](1)")]
    [InlineData("SELECT mystery_function(1)")]
    [InlineData("SELECT @x = 1")]
    [InlineData("SELECT * FROM x FOR UPDATE")]
    [InlineData("SELECT @@version")]
    [InlineData("SELECT 1 /*")]
    public void EffectsRefuse(string sql) => Assert.Equal("QUERY_TEST_EFFECTS_UNSUPPORTED", Assert.Throws<QueryTestFailure>(() => QueryTestContract.RequireReadSql(sql)).Code);

    [Fact]
    public void LiteralsPreservePrecisionAndEscapeExpressions()
    {
        Assert.Equal("9223372036854775806", QueryTestContract.Literal(JsonValue.Create("9223372036854775806"), "Long Integer"));
        Assert.Equal("\"GetUserId()\"", QueryTestContract.Literal(JsonValue.Create("GetUserId()"), "Text"));
        Assert.Equal("\"a\"\"b\"", QueryTestContract.Literal(JsonValue.Create("a\"b"), "Text"));
        Assert.Equal("#2026-10-07 15:30:00#", QueryTestContract.Literal(JsonValue.Create("2026-10-07T15:30:00"), "Date Time"));
        Assert.Throws<QueryTestFailure>(() => QueryTestContract.Literal(JsonValue.Create("GetUserId()"), "User Identifier"));
        Assert.Throws<QueryTestFailure>(() => QueryTestContract.Literal(JsonValue.Create("2026-99-20"), "Date"));
        Assert.Throws<QueryTestFailure>(() => QueryTestContract.Literal(null, "Integer"));
    }
    private static JsonObject Run() => new() { ["op"] = "run", ["lane"] = "o11", ["operationId"] = Guid.NewGuid().ToString(), ["source"] = Path.Combine(Path.GetTempPath(), "capture.oml"), ["expectedSourceSha256"] = new string('a',64), ["moduleKey"] = "module", ["environment"] = "personal.example", ["query"] = "@query", ["testValues"] = new JsonObject(), ["o11TenantId"] = 0, ["timeoutSeconds"] = 1 };
    private static string Folder() { var path = Path.Combine(Path.GetTempPath(), "ssam-query-tests", Guid.NewGuid().ToString()); Directory.CreateDirectory(path); return path; }
    private static JsonObject Op(JsonObject r, string op) => new() { ["op"] = op, ["operationId"] = r["operationId"]!.DeepClone() };
    private static QueryTestWork Work(Func<JsonObject> send) => new(new() { ["ok"] = true, ["execution"] = "not-sent" }, send, () => Task.CompletedTask);
    private static JsonObject Rows() => new() { ["ok"] = true, ["execution"] = "native-query", ["rows"] = new JsonArray("private-row"), ["sql"] = "private-sql", ["error"] = "private-error" };
    [Fact]
    public async Task ReplayAndRestartNeverResendAndReceiptsExcludePrivateValues()
    {
        var dir = Folder(); var runner = new QueryTestRunner(dir); var r = Run(); var calls = 0;
        Task<QueryTestWork> Prepare() => Task.FromResult(Work(() => { calls++; return Rows(); }));
        Assert.True((await runner.Handle(r, Prepare))["ok"]!.GetValue<bool>());
        await runner.Handle(r, Prepare); await new QueryTestRunner(dir).Handle(r, Prepare);
        Assert.Equal(1,calls);
        var persisted = File.ReadAllText(Path.Combine(dir, r["operationId"] + ".json"));
        Assert.DoesNotContain("private", persisted); Assert.DoesNotContain("testValues", persisted);
    }
    [Fact]
    public async Task TimeoutAndCancelKeepPendingReservationUntilLateResult()
    {
        var dir = Folder(); var runner = new QueryTestRunner(dir); var r = Run();
        using var release = new ManualResetEventSlim(); var entered = new TaskCompletionSource();
        Task<QueryTestWork> Prepare() => Task.FromResult(Work(() => { entered.SetResult(); release.Wait(TimeSpan.FromSeconds(10)); return Rows(); }));
        var pending = runner.Handle(r, Prepare); await entered.Task;
        try
        {
            var timeout = await pending; Assert.Equal("timeout", timeout["waitEnded"]!.ToString());
            var duplicate = await new QueryTestRunner(dir).Handle(Run(), Prepare);
            Assert.Equal("QUERY_TEST_PENDING", duplicate["code"]!.ToString());
            var cancelled = await runner.Handle(Op(r,"cancel"), Prepare);
            Assert.False(cancelled["serverCancelled"]!.GetValue<bool>());
            var restarted = await new QueryTestRunner(dir).Handle(Op(r,"status"), Prepare);
            Assert.Equal("uncertain", restarted["state"]!.ToString());
        }
        finally { release.Set(); }
        JsonObject status = new();
        for (var i=0;i<100;i++) { status = await runner.Handle(Op(r,"status"), Prepare); if(status["state"]?.ToString()=="completed") break; await Task.Delay(10); }
        Assert.Equal("completed",status["state"]!.ToString()); Assert.Equal("private-row",status["rows"]![0]!.ToString());
        Assert.Empty(Directory.GetFiles(dir,"*.pending"));
    }
    [Fact]
    public async Task PreparationFailureIsNotSentButNativeExceptionStaysUncertain()
    {
        var dir=Folder(); var runner=new QueryTestRunner(dir); var r=Run();
        var refused=await runner.Handle(r, () => throw new QueryTestFailure("BAD_CAPTURE","hash differs"));
        Assert.Equal("not-sent",refused["execution"]!.ToString()); Assert.Empty(Directory.GetFiles(dir,"*.pending"));
        var lost=await runner.Handle(Run(), () => Task.FromResult(Work(() => throw new IOException("lost reply"))));
        Assert.Equal("uncertain",lost["state"]!.ToString()); Assert.Single(Directory.GetFiles(dir,"*.pending"));
    }
    [Fact]
    public async Task DescribeAndUnknownStatusCannotSend()
    {
        var runner=new QueryTestRunner(Folder()); var r=Run(); r["op"]="describe";
        var calls=0; var closed=0;
        Task<QueryTestWork> Prepare() => Task.FromResult(new QueryTestWork(new(){["ok"]=true}, () => {calls++;return Rows();}, () => {closed++;return Task.CompletedTask;}));
        await runner.Handle(r,Prepare); Assert.Equal(0,calls); Assert.Equal(1,closed);
        Assert.Equal("QUERY_TEST_NOT_FOUND",(await runner.Handle(Op(r,"status"),Prepare))["code"]!.ToString());
    }
    [Fact]
    public async Task CorruptReceiptIsUncertainAndSessionDriftIsNotSent()
    {
        var dir=Folder(); var runner=new QueryTestRunner(dir); var r=Run(); var sends=0;
        File.WriteAllText(Path.Combine(dir,r["operationId"]+".json"),"incomplete");
        Task<QueryTestWork> Prepare()=>Task.FromResult(Work(()=>{sends++;return Rows();}));
        Assert.Equal("uncertain",(await runner.Handle(r,Prepare))["execution"]!.ToString());
        Assert.Equal(0,sends);
        var next=Run();
        var drift=await runner.Handle(next,()=>Task.FromResult(new QueryTestWork(new(),()=>{sends++;return Rows();},()=>Task.CompletedTask,()=>throw new QueryTestFailure("QUERY_TEST_SESSION_CHANGED","changed"))));
        Assert.Equal("not-sent",drift["execution"]!.ToString()); Assert.Equal(0,sends);
    }
}
