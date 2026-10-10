using System.Diagnostics;
using System.Reflection;
using OutSystems.Model.DependenciesProviders;
using ServiceStudio;
using ServiceStudio.Common.Observability;
using ServiceStudio.CrashAPI;
using ServiceStudio.Telemetry.Data;
using ServiceStudio.UserSettings;

namespace Anvil.Core;

/// <summary>
/// Prologo do runtime headless do Service Studio (um por processo; Runtime.Instance
/// e singleton). Ordem provada em 2026-09-03:
///   1. StudioAssemblies.Bind (base directory = pasta do Studio)
///   2. ExecutionExtensions.SetInstance (Settings.Save passa por ele; sem provider = NRE)
///   3. Settings.Initialize com pastas de trabalho vazias
///   4. Providers no-op (loggers, tracer)
///   5. new SsamHeadlessRuntime : Runtime.DummyImplementation
///   6. OutSystems.Model.ServicesProvider.Instance.StandaloneInitialize(null) (interno; reflexao)
/// </summary>
public static class HeadlessRuntime
{
    private static readonly object Gate = new();
    private static bool _ready;

    public static bool IsReady => _ready;

    /// <summary>Liberta o aggregator presenter headless de um modulo (ver SsamHeadlessRuntime.ReleaseAggregator).</summary>
    public static int ReleaseAggregator(ServiceStudio.Model.ESpace eSpace) => SsamHeadlessRuntime.ReleaseAggregator(eSpace);
    public static Dictionary<string, int> ReleaseStudioStatics(ServiceStudio.Model.ESpace eSpace) => SsamHeadlessRuntime.ReleaseStudioStatics(eSpace);
    public static int ReleaseLocks(ServiceStudio.Model.ESpace eSpace) => SsamHeadlessRuntime.ReleaseLocks(eSpace);
    /// <summary>The developer id the headless runtime gives the Studio (Ss11Runtime.LoadProfile).</summary>
    public static string DeveloperId => SsamHeadlessRuntime.DeveloperId;
    public static IReadOnlyList<string> StartupNotes { get; private set; } = Array.Empty<string>();

    public static void Ensure(string workDirectory)
    {
        lock (Gate)
        {
            if (_ready) return;
            StudioAssemblies.Bind();
            var notes = new List<string>();
            var sw = Stopwatch.StartNew();

            ExecutionExtensions.SetInstance(new NoopExecution());
            var userDir = Path.Combine(workDirectory, "settings", "user");
            var commonDir = Path.Combine(workDirectory, "settings", "common");
            Directory.CreateDirectory(userDir); Directory.CreateDirectory(commonDir);
            Settings.Initialize(new[] { userDir }, new[] { commonDir }, Array.Empty<string>());
            Providers.Instance.Register<ILoggersProvider>(new NoopLoggers(notes));
            Providers.Instance.Register<ITracerProvider>(new NoopTracerProvider());

            var runtime = new SsamHeadlessRuntime(Array.Empty<string>());
            runtime.RunningUnitTests = true;
            notes.Add($"runtime up in {sw.ElapsedMilliseconds} ms");

            try
            {
                var spType = typeof(OutSystems.Model.IESpace).Assembly.GetType("OutSystems.Model.ServicesProvider")
                    ?? throw new InvalidOperationException("OutSystems.Model.ServicesProvider not found");
                var instance = spType.GetProperty("Instance", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!.GetValue(null)!;
                var init = instance.GetType().GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                    .First(m => m.Name == "StandaloneInitialize");
                var ps = init.GetParameters();
                init.Invoke(instance, ps.Length == 0 ? null : new object?[ps.Length]);
                notes.Add("ServicesProvider.StandaloneInitialize ok");
            }
            catch (Exception ex)
            {
                notes.Add("StandaloneInitialize failed: " + (ex.InnerException ?? ex).Message);
            }
            StartupNotes = notes;
            _ready = true;
        }
    }

    private sealed class SsamHeadlessRuntime : Runtime.DummyImplementation
    {
        public SsamHeadlessRuntime(string[] args) : base(args) { }
        protected override void InitializeIsUnsupportedVersion() { }
        // AbstractObject.SetChangeTracking(creating) pede o developer id ao Runtime; a base
        // busca no aggregator/servidor (nulo sem GUI) -> NRE. O Model API usa a configuracao.
        public override string GetDeveloperId(ServiceStudio.Model.ESpace eSpace) => DeveloperId;
        public static string DeveloperId { get; set; } = Environment.UserName + "@ssam-headless";
        // Merge/refresh de referencias faz Runtime.GetAggregator(espace).DeveloperId (FW MergeChangeTrackingProperties);
        // DummyImplementation devolve null -> NRE. Um MockAggregatorPresenter por espace resolve (DeveloperId nulo e aceito).
        private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<ServiceStudio.Model.ESpace, ServiceStudio.Presenter.Commands.MockAggregatorPresenter> _aggregators = new();
        public override ServiceStudio.Presenter.IBaseAggregatorPresenter GetAggregator(ServiceStudio.Model.ESpace eSpace)
        {
            if (eSpace == null) return null!;
            return _aggregators.GetValue(eSpace, e => new ServiceStudio.Presenter.Commands.MockAggregatorPresenter(e, null, registerAsStaticInstance: false));
        }

        /// <summary>SEGUNDA RAIZ de memoria do worker (medida 2026-09-04): o MockAggregatorPresenter cria PTAEntryPointsList e
        /// TestTenantsManager, que subscrevem os eventos ESTATICOS ESpaceInstances.ESpaceLoad/ESpaceUnload e so os largam no Dispose.
        /// Sem Dispose, a lista de invocacao do evento segura o presenter, e ele o modulo: +2 subscricoes e ~1 MB por pedido
        /// (5 MB com o app de tickets). Dispoe o presenter e os dois servicos e tira-o da tabela.</summary>
        public static int ReleaseAggregator(ServiceStudio.Model.ESpace eSpace)
        {
            if (eSpace == null || !_aggregators.TryGetValue(eSpace, out var agg)) return 0;
            var disposed = 0;
            foreach (var f in agg.GetType().GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.FlattenHierarchy))
            {
                var tn = f.FieldType.Name;
                if (tn is not ("PTAEntryPointsList" or "TestTenantsManager")) continue;
                if (f.GetValue(agg) is IDisposable d) { try { d.Dispose(); disposed++; } catch { /* ja disposto */ } }
            }
            try { agg.Dispose(); disposed++; } catch { /* mock: Dispose parcial e aceitavel */ }
            _aggregators.Remove(eSpace);
            return disposed;
        }

        /// <summary>O que ESpace.Close NAO limpa e retem o modulo inteiro num processo residente (medido 2026-09-04, +1 por pedido cada):
        /// UndoManager.commandsToUndo/commandsPendingClose/OperationsCountAfterSave (o historico guarda o comando "apply job" com todo o
        /// grafo criado), UndoManager.alternativeCommandId e ParsedExpression.rebindActions (por InstanceId). Tudo por reflexao sobre
        /// registos estaticos do Studio; chamar ANTES de dispor o aggregator (o historico e indexado por ele).</summary>
        public static Dictionary<string, int> ReleaseStudioStatics(ServiceStudio.Model.ESpace eSpace)
        {
            var r = new Dictionary<string, int>();
            const BindingFlags any = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
            var fw = typeof(ServiceStudio.Model.ESpace).Assembly;
            var um = fw.GetType("ServiceStudio.Undo.UndoManager");
            if (_aggregators.TryGetValue(eSpace, out var agg))
            {
                try { ServiceStudio.Undo.UndoManager.ClearHistory(agg); r["undoHistory"] = 1; }
                catch (Exception ex) { r["undoHistory:" + (ex.InnerException ?? ex).GetType().Name] = 0; }
            }
            else r["undoHistory:noAggregator"] = 0;
            var id = eSpace.InstanceId;
            try
            {
                if (um?.GetField("alternativeCommandId", any)?.GetValue(null) is System.Collections.IDictionary alt && alt.Contains(id)) { alt.Remove(id); r["alternativeCommandId"] = 1; }
            }
            catch (Exception ex) { r["alternativeCommandId:" + ex.GetType().Name] = 0; }
            try
            {
                var dict = fw.GetType("ServiceStudio.Expressions.ParsedExpression")?.GetField("rebindActions", any)?.GetValue(null);
                if (dict != null)
                {
                    var valueType = dict.GetType().GetGenericArguments()[1];
                    var m = dict.GetType().GetMethod("TryRemove", new[] { typeof(Guid), valueType.MakeByRefType() });
                    var args = new object?[] { id, null };
                    if (m?.Invoke(dict, args) is true) r["rebindActions"] = 1;
                }
            }
            catch (Exception ex) { r["rebindActions:" + (ex.InnerException ?? ex).GetType().Name] = 0; }
            return r;
        }

        /// <summary>Os IModelLock do ESpace registam-se em TransferableReaderWriterLock.Instances (estatico) e so saem no Dispose,
        /// que ESpace.Close nao chama (+1 por pedido). Chamar DEPOIS do Close.</summary>
        public static int ReleaseLocks(ServiceStudio.Model.ESpace eSpace)
        {
            var n = 0;
            foreach (var f in typeof(ServiceStudio.Model.ESpace).GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public))
            {
                if (!f.FieldType.Name.Contains("Lock", StringComparison.Ordinal) || !typeof(IDisposable).IsAssignableFrom(f.FieldType)) continue;
                object? v; try { v = f.GetValue(eSpace); } catch { continue; }
                if (v is IDisposable d) { try { d.Dispose(); n++; } catch { /* ja disposto */ } }
            }
            return n;
        }
    }

    private sealed class NoopLogger : IGeneralLogger
    {
        private readonly List<string> _notes;
        public NoopLogger(List<string> notes) => _notes = notes;
        public LogLevel Verbosity => LogLevel.Error;
        public void Log(LogLevel logLevel, string message, Func<TelemetryParameters>? getParameters = null) { }
        public void Log(LogLevel logLevel, string message, Exception exception, Func<TelemetryParameters>? getParameters = null) { }
        public void LogException(Exception exception, string? extraInfo = null, ExceptionType? exceptionType = null)
        {
            // ruido conhecido: TypeInitializationException ao varrer plugins *SmartAssistant/ScreenTemplates
            if (_notes.Count < 50) _notes.Add($"logged: {exception.GetType().Name}: {exception.Message}");
        }
        public void ClearLog() { }
        public IEnumerable<ILogEntry> GetAllLogEntries() => Array.Empty<ILogEntry>();
        public void LogBulkOperation(string title) { }
        public void LogOperation(string title, string? description = null, Dictionary<string, object>? extraLogInfo = null) { }
        public void Dispose() { }
    }

    private sealed class NoopLoggers : ILoggersProvider
    {
        private readonly NoopLogger _l;
        public NoopLoggers(List<string> notes) => _l = new NoopLogger(notes);
        public IGeneralLogger GeneralLogger => _l;
        public ServiceStudio.Common.Observability.ILogger MergeLogger => _l;
        public ServiceStudio.Common.Observability.ILogger ReferencesManagerLogger => _l;
    }

    private sealed class NoopTracer : ITracer
    {
        public Activity? CurrentActivity => null;
        public Activity? MainActivity => null;
        public Activity? StartActivity(string activityId, string parentId = "") => null;
        public void AddEvent(LogLevel logLevel, string eventInfo, Dictionary<string, object>? attributes = null) { }
        public void ResumePerformanceMeasurements(Activity activity) { }
        public void StopPerformanceMeasurements(Activity activity) { }
        public void DoWithContext(string context, Action action, bool capturePerformanceMetrics = false, string parentId = "", Dictionary<string, object>? extraParameters = null, Action<TimeSpan?>? postAction = null)
        { action(); postAction?.Invoke(null); }
        public T DoWithContext<T>(string context, Func<T> func, bool capturePerformanceMetrics = false, string parentId = "", Dictionary<string, object>? extraParameters = null, Action<TimeSpan?>? postAction = null)
        { var r = func(); postAction?.Invoke(null); return r; }
        public void Dispose() { }
    }

    private sealed class NoopTracerProvider : ITracerProvider
    {
        private readonly NoopTracer _t = new();
        public ITracer Default => _t;
    }

    private sealed class NoopExecution : IExecutionProvider
    {
        public void Execute(Action action, Action<Exception> onError, string context, CrashExperience crashExperience, IExecutionContext executionContext, ExceptionType exceptionType = ExceptionType.None, string? telemetryLabel = null, Dictionary<string, string>? telemetryParameters = null, Func<Exception, bool>? isExpectedError = null)
        {
            try { action(); }
            catch (Exception ex) { if (onError != null) onError(ex); else throw; }
        }
        public TResult Execute<TResult>(Func<TResult> function, Func<Exception, TResult> onError, string context, CrashExperience crashExperience, IExecutionContext executionContext, ExceptionType exceptionType = ExceptionType.None, string? telemetryLabel = null, Dictionary<string, string>? telemetryParameters = null, Func<Exception, bool>? isExpectedError = null)
        {
            try { return function(); }
            catch (Exception ex) { if (onError != null) return onError(ex); throw; }
        }
    }
}
