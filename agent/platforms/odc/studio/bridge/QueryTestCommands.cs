using System.Text.Json.Nodes;
using SSAM.QueryTesting;

internal static partial class Bridge
{
    private static readonly QueryTestRunner QueryTests = new(Path.Combine(Root, "journal", "query-tests"));
    private static async Task<object> QueryTest(string argument, Context context)
    {
        try
        {
            var r = JsonNode.Parse(argument)?.AsObject() ?? new JsonObject();
            var result = await QueryTests.Handle(r, async () =>
            {
                ServiceStudio.Presenter.IAggregatorPresenter? selected = null;
                var native = await Ui(() => { selected = Active(r["moduleKey"]!.ToString()); return NativeQueryTest.Prepare(selected, r, Host(selected) ?? ""); });
                return new QueryTestWork(native.Description, native.Send, async () => await Ui(() => { native.Dispose(); return true; }),
                    async () => await Ui(() => { native.AssertSession(Host(selected!) ?? ""); return true; }));
            });
            context.Outcome = result["execution"]?.ToString() == "uncertain" ? "uncertain" : result["ok"]?.GetValue<bool>() == true ? "ok" : result["execution"]?.ToString() == "not-sent" ? "gate_refused" : "native_error";
            context.Note = "query-test " + r["op"] + "; operationId=" + result["operationId"] + "; code=" + result["code"];
            return result;
        }
        catch (Exception error) { context.Outcome = "gate_refused"; context.Note = "query-test invalid request"; return QueryTestContract.Failure(error); }
    }
}
