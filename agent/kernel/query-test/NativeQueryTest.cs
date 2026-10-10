using System.Security.Cryptography;
using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.Enumerations;
using OutSystems.ObjectKeys;
using ServiceStudio.Model;
using ServiceStudio.Model.Interfaces;
using ServiceStudio.Expressions.ExpressionElements;
using ServiceStudio.Presenter;
using ServiceStudio.Presenter.Commands;
using ServiceStudio.ServerCommunications;
#if QUERY_TEST_ODC
using ServiceStudio.ServerCommunications.API;
using OutSystems.Model.Commands;
#else
using ServiceStudio.Commands;
using OutSystems.MetaModel.CompoundKeys;
using ServiceStudio.WeakReferences;
#endif

namespace SSAM.QueryTesting;

/// <summary>Runs inside the authenticated Studio, but edits only a detached, hash-verified capture.
/// Prepare/dispose run on its UI dispatcher; Send uses the native data service off the UI thread.</summary>
public sealed class NativeQueryTest : IDisposable
{
    private readonly ESpace copy;
    private readonly IAggregatorPresenter presenter;
    private readonly object provider;
    private readonly JsonObject request;
    private readonly byte[]? queryBytes;
    private readonly ObjectKey moduleKey;
    private readonly int maxRows;
#if QUERY_TEST_ODC
    private readonly TestQueryParameter[] nativeParameters;
#else
    private readonly CompoundKey compoundKey;
#endif
    public JsonObject Description { get; }
    private NativeQueryTest(ESpace copy, IAggregatorPresenter presenter, IQueryInstanceProvider query, JsonObject request, JsonObject description, byte[]? bytes, object[] values)
    {
        (this.copy, this.presenter, this.request, Description, queryBytes) = (copy, presenter, request, description, bytes);
        moduleKey = copy.Key;
        provider = presenter.ServerCommunicationsProvider;
        maxRows = QueryTestContract.Integer(request, "maxRows", 100, 1, QueryTestContract.MaxRows);
#if QUERY_TEST_ODC
        nativeParameters = bytes == null ? [] : ParametersFor(query).Select((p, i) => new TestQueryParameter(p.AsAbstractObject.Key.AsGuid.ToString(), values[i])).ToArray();
#else
        compoundKey = CompoundKeyCreator.Create(query.AsAbstractObject, copy);
#endif
    }

    public static NativeQueryTest Prepare(IAggregatorPresenter presenter, JsonObject r, string connectedHost)
    {
        QueryTestContract.Validate(r);
#if QUERY_TEST_ODC
        const string lane = "odc";
#else
        const string lane = "o11";
#endif
        if (r["lane"]!.ToString() != lane) throw new QueryTestFailure("QUERY_TEST_LANE_MISMATCH", "Request does not match this bridge");
        if (!string.Equals(connectedHost, r["environment"]!.ToString(), StringComparison.OrdinalIgnoreCase)) throw new QueryTestFailure("QUERY_TEST_ENVIRONMENT_MISMATCH", "Keep the environment connected to the selected module");
        if (!presenter.ServerCommunicationsProvider.IsLoggedIn) throw new QueryTestFailure("QUERY_TEST_LOGIN_REQUIRED", "Sign in to this environment in the existing Studio; no login was opened");
        if (presenter.ActiveESpace?.Key.ToString() != r["moduleKey"]!.ToString()) throw new QueryTestFailure("QUERY_TEST_MODULE_MISMATCH", "The selected tab has another module key");
        var file = QueryTestContract.Required(r, "source");
        if (new FileInfo(file).Length > 128 * 1024 * 1024) throw new QueryTestFailure("QUERY_TEST_SOURCE_LIMIT", "Capture exceeds 128 MiB");
        var bytes = File.ReadAllBytes(file);
        if (!Convert.ToHexString(SHA256.HashData(bytes)).Equals(r["expectedSourceSha256"]!.ToString(), StringComparison.OrdinalIgnoreCase)) throw new QueryTestFailure("QUERY_TEST_SOURCE_CHANGED", "Capture bytes differ from expectedSourceSha256; map the intended capture again");
#if QUERY_TEST_ODC
        var copy = ESpace.Load(bytes, productKey: null, informationForUpgrader: null, loadFlags: LoadFlags.SkipUpgrades);
#else
        var copy = ESpace.Load(bytes, productKey: null, informationForUpgrader: null);
#endif
        try
        {
            if (copy.Key.ToString() != r["moduleKey"]!.ToString()) throw new QueryTestFailure("QUERY_TEST_MODULE_MISMATCH", "Capture belongs to a different module");
            var key = r["query"]!.ToString()[1..];
            var selected = ((IObjectSignature)copy).GetAllDescendantsOfType<IObjectSignature>().Where(o => o.ObjectKey?.ToString() == key).ToArray();
            if (selected.Length != 1 || selected[0] is not IQueryInstanceProvider q) throw new QueryTestFailure("QUERY_TEST_NOT_QUERY", "@key must identify exactly one SQL or Aggregate in this capture");
            if (q is not Nodes.AdvancedQuery && q is not Nodes.AbstractDataSet) throw new QueryTestFailure("QUERY_TEST_NOT_QUERY", "Only native SQL and Aggregate nodes are supported");
            var parameters = ParametersFor(q);
            var details = new JsonArray(parameters.Select(p => (JsonNode)new JsonObject { ["key"] = "@" + p.AsAbstractObject.Key, ["name"] = p.AsAbstractObject.DisplayName, ["type"] = p.Type.Name }).ToArray());
            var description = new JsonObject { ["ok"] = true, ["execution"] = "not-sent", ["lane"] = lane, ["kind"] = q is Nodes.AdvancedQuery ? "sql" : "aggregate", ["query"] = r["query"]!.DeepClone(), ["name"] = q.AsAbstractObject.DisplayName,
                ["moduleKey"] = copy.Key.ToString(), ["environment"] = connectedHost, ["sourceSha256"] = r["expectedSourceSha256"]!.DeepClone(), ["parameters"] = details,
                ["identity"] = "studio-developer", ["appUserAccessValidated"] = false, ["published"] = false, ["requiresExistingDatabaseSchema"] = true,
                ["maxRowsLimit"] = QueryTestContract.MaxRows, ["timeoutMeaning"] = "Stops waiting only; the native synchronous service has no confirmed server cancellation. Read status, do not replay." };
            if (r["op"]!.ToString() == "describe") return new(copy, presenter, q, r, description, null, []);
            if (q is Nodes.AdvancedQuery sql)
            {
                QueryTestContract.RequireReadSql(sql.SQL.GetText());
                if (parameters.Any(p => p is not ServiceStudio.Model.Variables.AdvancedQueryParameter native || native.ExpandInline)) throw new QueryTestFailure("QUERY_TEST_EFFECTS_UNSUPPORTED", "ExpandInline or unknown SQL parameters are not supported by this test entry");
            }
            NativeQueryTest? prepared = null;
            // The detached model still obeys the Studio command/undo protocol. Give it its own
            // unregistered presenter, so test values never enter the open tab's undo history.
            InCopyCommand(copy, () =>
            {
                var supplied = r["testValues"]!.AsObject(); var used = new HashSet<string>(); var values = new List<object>();
                foreach (var p in parameters)
                {
                    var id = "@" + p.AsAbstractObject.Key; var name = p.AsAbstractObject.DisplayName;
                    var hasKey = supplied.ContainsKey(id); var hasName = supplied.ContainsKey(name);
                    if (hasKey && hasName || hasName && parameters.Count(x => x.AsAbstractObject.DisplayName == name) != 1) throw new QueryTestFailure("QUERY_TEST_PARAMETER", "Ambiguous parameter; use only " + id);
                    var selectedName = hasKey ? id : name;
                    if (!supplied.ContainsKey(selectedName)) throw new QueryTestFailure("QUERY_TEST_PARAMETER", "Missing test value for " + name + " (" + id + ")");
                    used.Add(selectedName);
                    p.SetTestValue(QueryTestContract.Literal(supplied[selectedName], p.Type.Name));
                    // Use exactly the native parsed literal. Never evaluate an action or expression to obtain a test value.
                    var expression = p.TestValue?.RootExpressionElement;
                    if (expression == null || !expression.IsValidConstant(p.AsAbstractObject.Scope)) throw new QueryTestFailure("QUERY_TEST_PARAMETER", "Native parser refused the test literal for " + name);
                    // Match the native button's normal path (no modifyQuery callback): DTO text is the
                    // unescaped value. DisplayName would send OutSystems enclosing/doubled quotes as data.
#if QUERY_TEST_ODC
                    values.Add(expression is TextLiteral text ? text.UnescapedValueWithoutEnclosingQuotes : expression is Literal literal ? literal.ActualValue
                        ?? throw new QueryTestFailure("QUERY_TEST_PARAMETER", "No native literal value for " + name) : p.TestValue!.DisplayName);
#endif
                }
                var extra = supplied.Select(x => x.Key).Except(used).ToArray();
                if (extra.Length > 0) throw new QueryTestFailure("QUERY_TEST_PARAMETER", "Unknown test parameter(s): " + string.Join(", ", extra));
                q.TestMaxRecords = QueryTestContract.Integer(r, "maxRows", 100, 1, QueryTestContract.MaxRows);
                if (q is Nodes.AbstractQuery nativeQuery && !TestQuery.IsValidForTestQuery(nativeQuery, out var validation))
                    throw new QueryTestFailure("QUERY_TEST_MODEL_INVALID", validation?.Detail ?? "The native TestQuery validator refused this query");
                var partial = copy.GetBytesForTestQuery(q, out _);
                prepared = new(copy, presenter, q, r, description, partial, values.ToArray());
            });
            return prepared!;
        }
        catch { copy.Close(); throw; }
    }

    public JsonObject Send()
    {
        if (queryBytes == null) throw new InvalidOperationException("Describe cannot execute");
        string[] columns; string[][] rows; string? sql; string? error; string nativeCode;
#if QUERY_TEST_ODC
        var args = new TestQueryArguments { ESpaceKey = moduleKey, PartialOmlWithQuery = queryBytes, MaxRecords = maxRows, QueryParameters = nativeParameters };
        var result = ((IServerCommunicationsServicesProvider)provider).DataService.TestQuery(args);
        columns = result.Columns ?? []; rows = result.Rows ?? []; sql = result.ExecutedSql; error = result.ErrorText; nativeCode = ((int)result.ResultCode).ToString();
        var ok = result.ResultCode == System.Net.HttpStatusCode.OK && string.IsNullOrEmpty(error);
#else
        var nativeProvider = provider as ServerCommunicationsProvider ?? throw new QueryTestFailure("QUERY_TEST_NATIVE_UNAVAILABLE", "The connected Studio provider does not expose TestQuery");
        var response = nativeProvider.TestQuery(moduleKey, request["o11TenantId"]!.GetValue<int>(), queryBytes, compoundKey, maxRows,
            out var resultCode, out var executedSql, out var errorText, out var advancedSql);
        nativeCode = resultCode; sql = string.IsNullOrEmpty(executedSql) ? advancedSql : executedSql; error = errorText;
        columns = []; rows = []; var ok = false;
        if (string.IsNullOrEmpty(error) && !string.IsNullOrEmpty(response))
        {
            // QueryResult is the Studio's XML reader, including its column order and empty result semantics.
            var parsed = new ServiceStudio.Model.QueryResult(response);
            columns = parsed.GetColumnNames(); rows = parsed.Rows;
            ok = columns != null && rows != null;
            columns ??= []; rows ??= [];
        }
#endif
        return QueryTestOutput.Format(Description, ok, nativeCode, error, sql, columns, rows, maxRows, request["includeSql"]?.GetValue<bool>() == true);
    }
    // Called on the UI dispatcher immediately before the native dispatch, after asynchronous preparation.
    public void AssertSession(string connectedHost)
    {
        if (!ReferenceEquals(provider, presenter.ServerCommunicationsProvider) || !presenter.ServerCommunicationsProvider.IsLoggedIn
            || presenter.ActiveESpace?.Key != moduleKey || !string.Equals(connectedHost, request["environment"]!.ToString(), StringComparison.OrdinalIgnoreCase))
            throw new QueryTestFailure("QUERY_TEST_SESSION_CHANGED", "The selected module/provider/environment changed before sending; nothing was executed");
    }
    private static IQueryParameter[] ParametersFor(IQueryInstanceProvider query) => query is Nodes.AdvancedQuery sql
        ? query.Parameters.Where(p => sql.SQL.ReferedObjects.OfType<ServiceStudio.Model.Variables.AdvancedQueryParameter>().Contains(p)).ToArray()
        : query.Parameters.ToArray();
    private static void InCopyCommand(ESpace copy, Action prepare)
    {
        typeof(ESpace).GetMethod("PrepareForSave", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public, Type.EmptyTypes)?.Invoke(copy, null);
        using var isolated = new MockAggregatorPresenter(copy, null, false);
        var owner = new MockPresenter(isolated);
        try { Command.Execute(owner.GetPresenterContext(), "Prepare detached query test", prepare); }
        finally { ServiceStudio.Undo.UndoManager.ClearHistory(isolated); }
    }
    public void Dispose() => copy.Close();
}
