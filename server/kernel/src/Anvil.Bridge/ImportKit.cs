using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using ServiceStudio.Model;
using ServiceStudio.Presenter.Commands;

namespace Anvil.Bridge;

/// <summary>
/// What IntegrationImportHandler.cs needs beyond the Studio, in one seam (fase4-28 r4-f3-import): the handler file is linked
/// into the thin bridge of the agent pack unchanged, and the thin bridge never references the kernel
/// (docs/O11-BRIDGE-FINA.md section 2.1). Here, in the full bridge, every member delegates to the kernel, so the local path
/// behaves as before the seam, except Mutate (review M2: the quiet command of both bridges). The thin bridge has its own ImportKit (kernel/src/Anvil.Bridge.Thin/ImportKit.cs):
/// the same members on Studio types and the BCL only, its pure parts held equal to these by
/// Anvil.Bridge.Thin.Tests/IntegrationImportThinTests.
/// </summary>
internal static class ImportKit
{
    public const string ImporterNotFound = IntegrationImport.ImporterNotFound;
    public const string ImportFailed = IntegrationImport.ImportFailed;

    /// <summary>Anvil.Core.IntegrationImport.Validate: every reason the bridge must not run the request (empty: it may).</summary>
    public static List<string> Validate(JsonObject? p) => IntegrationImport.Validate(p);

    /// <summary>The copy must be the snapshot of the open module (same key), as merge_from_oml requires of its foreign module.</summary>
    public static void RequireForeignIdentity(string localKey, string foreignKey) => SnapshotRegistry.RequireForeignIdentity(localKey, foreignKey);

    /// <summary>The Name of a model object, or null.</summary>
    public static string? Name(object? o) => TypeResolver.Name(o);

    /// <summary>A change of the detached copy inside one native command of a headless aggregator of that copy (never the
    /// open tab's): PrepareForSave, the command, then the undo history of that aggregator cleared. A failure of the change is
    /// raised after the command, which the SDK rolled back. fase4-28 r4-f3-import (review M2): the kernel's QuietCommand, as in
    /// the thin bridge (this method's text is the thin ImportKit's, IntegrationImportThinTests): an exception of the Studio's
    /// importer never leaves the command, so no "Unexpected Error" dialog opens in the owner's Studio and both bridges answer
    /// the same (Server.Fail "integration_import: ...; nothing was written to the open module").</summary>
    public static void Mutate(ESpace espace, string description, Action<ESpace> mutation)
    {
        typeof(ESpace).GetMethod("PrepareForSave", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public, Type.EmptyTypes)
            ?.Invoke(espace, null);
        using var aggregator = new MockAggregatorPresenter(espace, null, registerAsStaticInstance: false);
        var presenter = new MockPresenter(aggregator);
        QuietCommandFailure? failure;
        try { failure = QuietCommand.Execute(presenter.GetPresenterContext(), description, _ => mutation(espace)); }
        finally
        {
            try { ServiceStudio.Undo.UndoManager.ClearHistory(aggregator); } catch { /* no history for this aggregator */ }
        }
        if (failure != null) throw new QuietCommandException(failure);
    }

    /// <summary>The label of an OpenAPI operation: its operationId, else "VERB /path" (RestOpenApi.Operation.Label).</summary>
    public static string Label(string id, string verb, string path) => new RestOpenApi.Operation(id, verb, path).Label;

    /// <summary>The OpenAPI document with only the chosen operations under paths (RestOpenApi.Filtered).</summary>
    public static string Filtered(string documentPath, string sha256, string text, IReadOnlyList<(string Id, string Verb, string Path)> operations)
    {
        var selected = operations.Select(o => new RestOpenApi.Operation(o.Id, o.Verb, o.Path)).ToList();
        return RestOpenApi.Filtered(new RestOpenApi.OpenApiPlan(documentPath, sha256, text, null, selected, selected, []));
    }
}
