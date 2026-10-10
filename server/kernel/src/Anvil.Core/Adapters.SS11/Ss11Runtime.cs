using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// The Service Studio 11 platform adapter: delegates every member of <see cref="IStudioRuntime"/> to the existing
/// SS11 code without changing any of it (HeadlessRuntime, StudioAssemblies, Publisher.Mutate,
/// ReferenceRefresher.ImportSnapshot, VerifyCatalog). Discovered by <see cref="StudioAdapter"/> in the SS11 build.
/// </summary>
public sealed class Ss11Runtime : IStudioRuntime
{
    public string Platform => "ss11";
    public string StudioDirectory => StudioAssemblies.Directory;
    public string IdeVersion => StudioAssemblies.IdeVersion;
    public void Bind(string? studioDirectory = null) => StudioAssemblies.Bind(studioDirectory);
    public void Ensure(string workDirectory) => HeadlessRuntime.Ensure(workDirectory);

    public ESpace Load(byte[] oml) => ESpace.Load(oml, productKey: null, informationForUpgrader: null);

    /// <summary>The overload the one above delegates to (initialLastSavePath and forceModifiedFlag null), plus the token.</summary>
    public ESpace Load(byte[] oml, CancellationToken cancellationToken)
        => ESpace.Load(oml, initialLastSavePath: null, productKey: null, forceModifiedFlag: null, informationForUpgrader: null, cancellationToken: cancellationToken);

    public string LoadProfile => "productKey=;developerId=" + HeadlessRuntime.DeveloperId;

    public byte[] Save(ESpace espace)
    {
        using var ms = espace.SaveToMemoryStream();
        return ms.ToArray();
    }

    /// <summary>ESpace.Load registers every instance in a static Studio dictionary; only Close removes it, and the
    /// aggregator, statics and locks must go too or a resident process keeps every module it ever loaded.</summary>
    public Dictionary<string, int> Release(ESpace? espace)
    {
        var r = new Dictionary<string, int>();
        if (espace == null) return r;
        try { foreach (var kv in HeadlessRuntime.ReleaseStudioStatics(espace)) r[kv.Key] = kv.Value; } catch (Exception ex) { r["statics:" + ex.GetType().Name] = 0; }
        try { r["aggregator"] = HeadlessRuntime.ReleaseAggregator(espace); } catch (Exception ex) { r["aggregator:" + ex.GetType().Name] = 0; }
        try { espace.Close(); r["close"] = 1; } catch (Exception ex) { r["close:" + ex.GetType().Name] = 0; }
        try { r["locks"] = HeadlessRuntime.ReleaseLocks(espace); } catch (Exception ex) { r["locks:" + ex.GetType().Name] = 0; }
        return r;
    }

    public void Mutate(ESpace espace, string description, Action<ESpace> mutation) => Publisher.Mutate(espace, description, mutation);

    public Reference ImportReference(ESpace espace, NativeReferenceSnapshot snapshot, IReadOnlyList<NativeReferenceElement> elements)
        => ReferenceRefresher.ImportSnapshot(espace, snapshot, elements);

    public IReadOnlyList<VerifyDefinition> VerifyDefinitions => VerifyCatalog.All;

    public string? ImportsChild(AbstractObject newParent, AbstractObject source)
    {
        if (newParent is not ServiceStudio.Import.IImportTarget target) return null;
        ServiceStudio.Import.IKindConversion? conversion = null;
        return ServiceStudio.Clone.ObjectCloner.CloneAllowed(source, target, ref conversion) ? conversion?.TargetKind.DisplayName ?? "" : null;
    }

    public OutSystems.Model.IObject MoveObject(OutSystems.Model.IObject source, OutSystems.Model.IObject newParent)
        => ServiceStudio.Runtime.Instance.ModelServices.MoveObject(source, newParent);
}
