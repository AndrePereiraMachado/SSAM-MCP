using OutSystems.Model;
using OutSystems.Model.Enumerations;
using OutSystems.ModelAPILoader;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// The ODC platform adapter: implements <see cref="IStudioRuntime"/> the way SSAM-Hybrid-ODC's headless builder
/// already works (OutSystems.ModelAPILoader: Loader.SetConfiguration, LoadESpace with transactions and change
/// tracking, IESpace.Save, TransactionsManager.ExecuteTransaction). Discovered by StudioAdapter in the ODC build.
/// Public producer signatures acquired by the bridge can be imported into a headless candidate;
/// live refresh still uses refresh-references. The public Verify catalog is read from OutSystems.Model.dll of the
/// installation by the same reader the SS11 adapter uses.
/// </summary>
public sealed class OdcRuntime : IStudioRuntime
{
    private static readonly object Gate = new();
    private static bool _ready;

    public string Platform => "odc";
    public string StudioDirectory => StudioAssembliesOdc.Directory;
    public string IdeVersion => StudioAssembliesOdc.IdeVersion;
    public void Bind(string? studioDirectory = null) => StudioAssembliesOdc.Bind(studioDirectory);

    /// <summary>Developer identity stamped on every change (LastModifiedBy): the request's own (<see cref="WithDeveloperId{T}"/>,
    /// `apply --developer-id`), else ANVIL_DEVELOPER_ID, else a neutral id. Deliveries to a tenant set it to the tenant's
    /// Studio author (the snapshot's developerId), the bridge checks authorship.</summary>
    public static string DeveloperId => RequestDeveloperId.Value ?? Environment.GetEnvironmentVariable("ANVIL_DEVELOPER_ID") ?? "anvil@ssam-hybrid.local";

    private static readonly AsyncLocal<string?> RequestDeveloperId = new();

    /// <summary>B2 (C02): one request of a resident worker runs under its own author. Every load of the request (the base, its
    /// producers) passes this id to LoadESpace, which is what stamps LastModifiedBy (Pa3MbOdcWorkerTests proves two
    /// requests of one process stamp their own ids); the BaseModelCache key carries it in <see cref="LoadProfile"/>, so a
    /// spare loaded for another author is never taken. Null or empty: the process identity, as before.</summary>
    public static T WithDeveloperId<T>(string? developerId, Func<T> body)
    {
        if (string.IsNullOrWhiteSpace(developerId)) return body();
        var previous = RequestDeveloperId.Value;
        RequestDeveloperId.Value = developerId.Trim();
        try { return body(); }
        finally { RequestDeveloperId.Value = previous; }
    }

    public void Ensure(string workDirectory)
    {
        lock (Gate)
        {
            if (_ready) return;
            StudioAssembliesOdc.Bind();
            Directory.CreateDirectory(workDirectory);
            Loader.SetConfiguration(new Configuration { DeveloperId = DeveloperId, StorageStrategy = FileStorageStrategy.InMemory, UseSharedCache = false });
            OdcModelPlugins.Register(Loader.ModelServicesInstance); // model plugins a module requires, from the Studio's cache
            OdcFeatures.Initialize(workDirectory); // aggregates and other model parts ask the feature provider
            _ready = true;
        }
    }

    private const LoadFlags Flags = LoadFlags.SkipUpgrades;
    private const string AgentName = "Anvil";

    // The overload without a token passes CancellationToken.None to this one (IModelServices.LoadESpace).
    public ESpace Load(byte[] oml) => Load(oml, CancellationToken.None);

    public ESpace Load(byte[] oml, CancellationToken cancellationToken)
    {
        Ensure(Path.Combine(Path.GetTempPath(), "anvil-odc"));
        IESpace model;
        try { model = Loader.ModelServicesInstance.LoadESpace(oml, cancellationToken, loadFlags: Flags, enableTransactions: true, developerId: DeveloperId, trackChanges: true, tool: CreatedByTool.AgentExperience, agentName: AgentName); }
        catch (Exception error) when (OdcModelPlugins.Refusal(error, "the module") is { } refusal) { throw refusal; } // a Mobile UI app without MobileUI cached
        return model as ESpace ?? throw new InvalidOperationException("ODC ModelAPILoader returned " + model.GetType().FullName + ", not ServiceStudio.Model.ESpace");
    }

    public string LoadProfile => $"developerId={DeveloperId};loadFlags={Flags};enableTransactions=true;trackChanges=true;agentName={AgentName}";

    public byte[] Save(ESpace espace) => ((IESpace)espace).Save();

    public Dictionary<string, int> Release(ESpace? espace)
    {
        var r = new Dictionary<string, int>();
        if (espace == null) return r;
        try { ((IDisposable)espace).Dispose(); r["dispose"] = 1; } catch (Exception ex) { r["dispose:" + ex.GetType().Name] = 0; }
        return r;
    }

    /// <summary>One native transaction: everything the mutation does enters together or nothing does.</summary>
    public void Mutate(ESpace espace, string description, Action<ESpace> mutation)
        => ((IESpace)espace).TransactionsManager.ExecuteTransaction(description, (_, _) => { mutation(espace); return true; });

    public Reference ImportReference(ESpace espace, NativeReferenceSnapshot snapshot, IReadOnlyList<NativeReferenceElement> elements)
        => OdcReferenceImporter.Import(espace, snapshot, elements);

    private static readonly Lazy<IReadOnlyList<VerifyDefinition>> Verify = new(() =>
    {
        // ODC declares ServiceStudio.Verify.VerifyMessageId and its generated resources in OutSystems.Model.dll
        // (checked on the installed ODC Studio: the resource is not in ServiceStudio.Framework.dll as in SS11).
        StudioAssembliesOdc.Bind();
        return VerifyResources.Extract(Path.Combine(StudioAssembliesOdc.Directory, "OutSystems.Model.dll"), StudioAssembliesOdc.IdeVersion);
    });

    public IReadOnlyList<VerifyDefinition> VerifyDefinitions => Verify.Value;

    public string? ImportsChild(AbstractObject newParent, AbstractObject source)
    {
        if (newParent is not ServiceStudio.Import.IImportTarget target) return null;
        ServiceStudio.Import.IKindConversion? conversion = null;
        return OutSystems.Model.Clone.ObjectCloner.CloneAllowed(source, target, ref conversion) ? conversion?.TargetKind.DisplayName ?? "" : null;
    }

    public OutSystems.Model.IObject MoveObject(OutSystems.Model.IObject source, OutSystems.Model.IObject newParent)
        => Loader.ModelServicesInstance.MoveObject(source, newParent);
}
