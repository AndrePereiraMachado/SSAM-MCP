using System.Text.Json.Nodes;
using Avalonia.Threading;
using SSAM.QueryTesting;

namespace Anvil.Bridge;

internal static class QueryTestHandler
{
    private static readonly Lazy<QueryTestRunner> Runner = new(() => new(Path.Combine(Server.StateDirectory, "query-tests")));
    internal static async Task<string> Handle(JsonObject? request)
    {
        var r = request ?? new JsonObject();
        var result = await Runner.Value.Handle(r, async () =>
        {
            ServiceStudio.Presenter.IAggregatorPresenter? selected = null;
            var native = await Ui.Run(() =>
            {
                var matches = Studio.Aggregators().Where(a => a.ActiveESpace?.Key.ToString() == r["moduleKey"]!.ToString()
                    && string.Equals(Studio.EnvironmentHost(a), r["environment"]!.ToString(), StringComparison.OrdinalIgnoreCase)).ToArray();
                if (matches.Length != 1) throw new QueryTestFailure("QUERY_TEST_TARGET_REQUIRED", "Select exactly one open tab for this module and environment; nothing was sent");
                selected = matches[0];
                return NativeQueryTest.Prepare(selected, r, Studio.EnvironmentHost(selected)!);
            }, UiGate.Read, "query_test: prepare");
            return new QueryTestWork(native.Description, native.Send, async () => await Ui.Run(native.Dispose, UiGate.Step, "query_test: dispose"),
                async () => await Ui.Run(() => native.AssertSession(Studio.EnvironmentHost(selected!) ?? ""), UiGate.Read, "query_test: session"));
        });
        return Server.Ok(result);
    }
}
