using System.Security.Cryptography;
using System.Text.Json.Nodes;
using OutSystems.Model;
using OutSystems.Model.Enumerations;
using OutSystems.ModelAPILoader;

namespace Anvil.Core;

/// <summary>
/// A blank ODC module of one <see cref="SegmentationKind"/>, created offline by the installed model
/// (IModelServices.CreateESpace with targetPlatform Neo, the call the ODC builder makes for a new module), saved, and
/// loaded back by <see cref="OdcRuntime.Load(byte[])"/>, the load <c>apply</c> uses for its base. No tenant, no template,
/// no Studio: the module has only what the platform puts in a module of that kind, plus the connections asked for.
/// Keys are derived from kind and names, so the same command gives the same identity; dates and the keys of the
/// platform's own children are the platform's, so the bytes differ between runs.
/// </summary>
public static class OdcBlankModule
{
    /// <summary>Connection kinds a blank module can depend on, each built offline by IModelServices with one action
    /// of its own name. Agents and agent manifests require an AI model (a server action of an AI model connection: a
    /// local server action is refused for it); MCP and knowledge base tool references require an action of theirs.</summary>
    public static readonly IReadOnlyList<string> ConnectionKinds = ["ai-model", "mcp", "knowledge-base"];

    /// <param name="connections">"kind:Name" items, kind one of <see cref="ConnectionKinds"/>.</param>
    public static JsonObject Create(ModelHost host, string kind, string name, string outPath, IReadOnlyList<string>? connections = null)
    {
        // Names only: Enum.Parse also takes "7", which would hide a typo behind an unrelated kind.
        if (!Enum.TryParse<SegmentationKind>(kind, ignoreCase: true, out var k) || !Enum.IsDefined(k) || kind.Trim().All(char.IsDigit))
            throw new ArgumentException("unknown --kind '" + kind + "'; one of: " + string.Join(", ", Enum.GetNames<SegmentationKind>()));
        var wanted = (connections ?? []).Select(ParseConnection).ToList();
        var services = Loader.ModelServicesInstance;
        var key = services.NewKeyBasedOn(["anvil-blank", k.ToString(), name]);
        byte[] bytes;
        var dependencies = new JsonArray();
        using (var espace = services.CreateESpace(k, name, key: key, targetPlatform: PlatformServerVersion.Neo, enableTransactions: true,
                   tool: CreatedByTool.AgentExperience, developerId: OdcRuntime.DeveloperId, trackChanges: true, agentName: "Anvil"))
        {
            foreach (var (connectionKind, connectionName) in wanted) dependencies.Add(AddConnection(services, espace, connectionKind, connectionName));
            bytes = espace.Save();
        }
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
        File.WriteAllBytes(outPath, bytes);
        // The proof that apply can take it as base: the same runtime load, then a description of what it holds.
        var snapshot = host.Inspect(bytes);
        return new JsonObject
        {
            ["outPath"] = Path.GetFullPath(outPath), ["kind"] = k.ToString(), ["name"] = snapshot.Name, ["moduleKind"] = snapshot.Kind,
            ["key"] = key.ToString(), ["reloadedKey"] = snapshot.Key, ["bytes"] = bytes.Length,
            ["sha256"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            ["objects"] = snapshot.Objects, ["isValid"] = snapshot.IsValid, ["validation"] = JsonNode.Parse(Json.Serialize(snapshot.Validation, false)),
            ["references"] = JsonNode.Parse(Json.Serialize(snapshot.References, false)), ["connections"] = dependencies,
            ["topObjectTypes"] = JsonNode.Parse(Json.Serialize(snapshot.TopObjectTypes, false)),
        };
    }

    private static (string Kind, string Name) ParseConnection(string spec)
    {
        var parts = spec.Split(':', 2, StringSplitOptions.TrimEntries);
        if (parts.Length != 2 || parts[1].Length == 0 || !ConnectionKinds.Contains(parts[0]))
            throw new ArgumentException("--connection '" + spec + "': use kind:Name, kind one of " + string.Join(", ", ConnectionKinds));
        return (parts[0], parts[1]);
    }

    private static JsonObject AddConnection(IModelServices services, IESpace espace, string kind, string name)
    {
        var key = services.NewKeyBasedOn(["anvil-blank-connection", kind, name]);
        var actionKey = services.NewKeyBasedOn(["anvil-blank-connection-action", kind, name]);
        // AddDependency has one overload per connection type, so each kind is spelled out.
        Action add; string action, connectionKey;
        switch (kind)
        {
            case "ai-model": { var c = services.CreateAIModelConnection(name, key); action = c.CreateAction(name, actionKey).Name; connectionKey = c.Key.ToString()!; add = () => espace.AddDependency(c); break; }
            case "mcp": { var c = services.CreateMCPConnection(name, key); action = c.CreateAction(name, actionKey).Name; connectionKey = c.Key.ToString()!; add = () => espace.AddDependency(c); break; }
            default: { var c = services.CreateKnowledgeBase(name, key); action = c.CreateAction(name, actionKey).Name; connectionKey = c.Key.ToString()!; add = () => espace.AddDependency(c); break; }
        }
        espace.TransactionsManager.ExecuteTransaction("Add " + kind + " connection " + name, (_, _) => { add(); return true; });
        return new JsonObject { ["kind"] = kind, ["connection"] = name, ["connectionKey"] = connectionKey, ["action"] = action };
    }
}
