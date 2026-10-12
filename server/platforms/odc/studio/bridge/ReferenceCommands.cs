using System.Security.Cryptography;
using System.Text.Json;
using OutSystems.Model;
using ServiceStudio.ServerCommunications.API;

internal static partial class Bridge
{
    private static async Task<object> ReferenceProducers(string module, Context context)
    {
        Require(!string.IsNullOrWhiteSpace(module), "module is required");
        var selection = await Ui(() => {
            var presenter = Active(module);
            Require(presenter.ServerCommunicationsProvider.IsLoggedIn, "The consumer session is not signed in");
            context.Module = presenter.ActiveESpace.Name;
            context.ModuleKey = presenter.ActiveESpace.Key.ToString();
            return (Presenter: presenter, Host: Host(presenter)!, Before: Capture(presenter.ActiveESpace),
                Service: ((IServerCommunicationsServicesProvider)presenter.ServerCommunicationsProvider).ReferencesService);
        });
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        var producers = selection.Service.ListReferenceable(timeout.Token)
            .Select(r => new { name = r.Name, key = r.Key.ToString() })
            .OrderBy(r => r.name, StringComparer.OrdinalIgnoreCase).ThenBy(r => r.key, StringComparer.Ordinal).ToArray();
        var after = await Ui(() => {
            Require(Host(selection.Presenter) == selection.Host && selection.Presenter.ActiveESpace.Key.ToString() == context.ModuleKey,
                "Consumer session changed during listing");
            Require(selection.Presenter.ServerCommunicationsProvider.IsLoggedIn, "Consumer session is no longer signed in");
            return Capture(selection.Presenter.ActiveESpace);
        });
        Require(after.Sha256 == selection.Before.Sha256, "Consumer changed during listing; capture again before preparing a candidate");
        return new { ok = true, module = context.Module, moduleKey = context.ModuleKey, tenant = selection.Host,
            listedAt = DateTimeOffset.UtcNow.ToString("o"), source = "ReferencesService.ListReferenceable",
            scope = "consumer-session-visible-producers", count = producers.Length, producers,
            sourceSha256 = after.Sha256, consumerUnchanged = true, mergeInvoked = false, publishInvoked = false };
    }

    // Read-only acquisition through the consumer's authenticated native service. No credentials leave the Studio.
    private static async Task<object> ReferenceSnapshot(string argument, Context context)
    {
        using var request = JsonDocument.Parse(argument);
        var module = request.RootElement.GetProperty("module").GetString()!;
        var producer = request.RootElement.GetProperty("producer").GetString()!;
        var output = Path.GetFullPath(request.RootElement.GetProperty("output").GetString()!);
        Require(!string.IsNullOrWhiteSpace(module) && !string.IsNullOrWhiteSpace(producer), "module and producer are required");
        Require(output.EndsWith(".avsig", StringComparison.OrdinalIgnoreCase) && !File.Exists(output), "Use a new .avsig output path");
        var selection = await Ui(() => {
            var presenter = Active(module);
            Require(presenter.ServerCommunicationsProvider.IsLoggedIn, "The consumer session is not signed in");
            context.Module = presenter.ActiveESpace.Name;
            context.ModuleKey = presenter.ActiveESpace.Key.ToString();
            return (Presenter: presenter, Host: Host(presenter)!,
                Before: Capture(presenter.ActiveESpace),
                Service: ((IServerCommunicationsServicesProvider)presenter.ServerCommunicationsProvider).ReferencesService);
        });
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        var candidates = selection.Service.ListReferenceable(timeout.Token)
            .Where(r => r.Key.ToString() == producer || r.Name.Equals(producer, StringComparison.OrdinalIgnoreCase)).ToArray();
        Require(candidates.Length == 1, candidates.Length == 0 ? "Producer is not available to the consumer session: " + producer : "Producer name is ambiguous; select by key: " + producer);
        var info = selection.Service.RefreshReferenceDetails(candidates[0].Key.ToString(), RevisionRequestType.Latest, timeout.Token);
        Require(info != null && info.SignatureBinary?.Length > 0, "Native service returned no public signature");
        // An External Library (capability reference-snapshot:external-library) is exported like a library: its public
        // actions and structures. Bridges before it refused it with a sentence ending in "not extensions or external
        // libraries"; the facade answers that one as BRIDGE_UPGRADE_REQUIRED. An AI model connection (Codex agents) too.
        var kind = info!.ReferenceKind.ToString();
        Require(kind is "eSpace" or "ExternalLibrary" or "AIModelConnection", "This command exports module, library, External Library and AI model signatures, not " + kind + " producers");
        // The bridge's copy of the kernel's reader (PublicSignatureReader.cs): no type of the kernel's namespace.
        var signature = PublicSignatureReader.Read(info.SignatureBinary!);
        Require(info.Key.Equals(candidates[0].Key), "Native service returned a different producer identity");
        Require(info.SignatureHash != Guid.Empty, "Native service returned no published signature identity");
        var elements = signature.Elements;
        Require(elements.Length > 0, "Producer has no supported public elements");
        Require(elements.Select(e => e.Kind + ":" + e.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() == elements.Length,
            "Producer has ambiguous public element names; qualified selection is required");
        var after = await Ui(() => {
            Require(Host(selection.Presenter) == selection.Host && selection.Presenter.ActiveESpace.Key.ToString() == context.ModuleKey,
                "Consumer session changed during acquisition");
            return Capture(selection.Presenter.ActiveESpace);
        });
        Require(after.Sha256 == selection.Before.Sha256, "Consumer changed during acquisition; capture again before preparing a candidate");
        var envelope = new { FormatVersion = 2, Environment = selection.Host, ModuleKey = info.Key.ToString(),
            ApplicationKey = info.AppKey?.ToString() ?? "", ModuleKind = info.ReferenceKind.ToString(),
            ModuleType = kind == "ExternalLibrary" ? "ExternalLibrary" : ((OutSystems.Model.Enumerations.SegmentationKind)(int)info.RuntimeKind).ToString(),
            Name = info.Name, Description = info.Description ?? "", Icon = info.Icon ?? Array.Empty<byte>(),
            JQueryVersion = info.JQueryVersion ?? "", ExtensibilityConfigurations = info.ExtensibilityConfiguration ?? "",
            SignatureHash = info.SignatureHash, SignatureBinary = info.SignatureBinary,
            Digest = info.ModelDigest ?? "", Revision = info.Revision ?? "", Version = info.Version ?? "", Elements = elements };
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        using (var stream = new FileStream(output, FileMode.CreateNew, FileAccess.Write)) JsonSerializer.Serialize(stream, envelope, Json);
        return new { ok = true, path = output, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(output))),
            environment = selection.Host, producer = info.Name, producerKey = info.Key.ToString(), revision = info.Revision,
            elements, consumerUnchanged = true, mergeInvoked = false, publishInvoked = false };
    }

}
