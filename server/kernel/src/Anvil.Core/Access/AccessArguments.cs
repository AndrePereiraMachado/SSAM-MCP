namespace Anvil.Core.Access;

/// <summary>
/// The arguments of `anvil access plan|apply|verify`, parsed strictly: every option of the action is known, an option that
/// takes a value always consumes the next token, and a flag counts only where an option may stand. So the user's
/// authorization words are always the value of --words, whatever they say: words such as "--execute" can never change the
/// mode. Execution is the separate flag --execute; --prepare-only (what the o11_access MCP tool always sends) states the
/// other mode explicitly, and the two together are refused.
/// </summary>
public sealed record AccessArguments(string Action, string? Manifest, string? Work, string? Words, string? Plan, string? OperationId,
    bool Execute, bool PrepareOnly, int? Port, string? DeliverWork, IReadOnlyDictionary<string, string> ModuleBases,
    IReadOnlyList<string> Producers, bool CreateAccounts, bool CreateActive)
{
    // --ss-dir is the CLI-wide Studio installation (Program.Main); it is accepted here so it is never taken for a flag.
    private static readonly string[] Common = ["--work", "--ss-dir"];
    private static readonly Dictionary<string, (string[] Values, string[] Repeated, string[] Flags)> Shapes = new(StringComparer.Ordinal)
    {
        ["plan"] = (["--manifest", .. Common], ["--module-base", "--producer"], ["--create-accounts", "--create-active"]),
        ["apply"] = (["--manifest", "--words", "--plan", "--operation-id", "--port", "--deliver-work", .. Common], [], ["--execute", "--prepare-only"]),
        ["verify"] = (["--manifest", .. Common], [], []),
    };

    public const string Usage = "usage: anvil access plan|apply|verify --manifest <json> ...";

    /// <param name="args">The arguments after the verb `access`: the action first.</param>
    public static AccessArguments Parse(IReadOnlyList<string> args)
    {
        if (args.Count == 0 || !Shapes.TryGetValue(args[0], out var shape)) throw new ArgumentException(Usage);
        var action = args[0];
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        var repeated = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        var flags = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 1; i < args.Count; i++)
        {
            var name = args[i];
            if (action == "plan" && name == "--words") throw new ArgumentException("access plan is offline and takes no authorization words");
            if (shape.Flags.Contains(name))
            {
                if (!flags.Add(name)) throw new ArgumentException($"{name} is given more than once");
                continue;
            }
            var single = shape.Values.Contains(name);
            if (!single && !shape.Repeated.Contains(name))
                throw new ArgumentException(name.StartsWith("--", StringComparison.Ordinal)
                    ? $"access {action} does not take {name} (allowed: {string.Join(", ", shape.Values.Concat(shape.Repeated).Concat(shape.Flags))})"
                    : $"access {action}: unexpected argument at position {i + 1}; every value follows its option");
            if (++i >= args.Count) throw new ArgumentException($"missing value of {name}");
            var value = args[i];
            // The words are the user's, verbatim: whatever they look like, they are only the value of --words.
            if (name != "--words" && value.StartsWith("--", StringComparison.Ordinal)) throw new ArgumentException($"missing value of {name}");
            if (single)
            {
                if (!values.TryAdd(name, value)) throw new ArgumentException($"{name} is given more than once");
            }
            else
            {
                if (!repeated.TryGetValue(name, out var list)) repeated[name] = list = [];
                list.Add(value);
            }
        }
        var execute = flags.Contains("--execute");
        var prepareOnly = flags.Contains("--prepare-only");
        if (execute && prepareOnly) throw new ArgumentException("--execute and --prepare-only exclude each other");
        if (flags.Contains("--create-active") && !flags.Contains("--create-accounts")) throw new ArgumentException("--create-active requires --create-accounts");

        var bases = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var binding in repeated.GetValueOrDefault("--module-base") ?? [])
        {
            var split = binding.IndexOf('=');
            if (split <= 0 || split == binding.Length - 1) throw new ArgumentException("use --module-base Module=<current OML>");
            if (!bases.TryAdd(binding[..split], binding[(split + 1)..])) throw new ArgumentException($"--module-base {binding[..split]} is given more than once");
        }
        int? port = null;
        if (values.TryGetValue("--port", out var portText))
            port = int.TryParse(portText, out var parsed) && parsed is > 0 and < 65536 ? parsed : throw new ArgumentException("--port must be a TCP port number");
        return new AccessArguments(action, values.GetValueOrDefault("--manifest"), values.GetValueOrDefault("--work"), values.GetValueOrDefault("--words"),
            values.GetValueOrDefault("--plan"), values.GetValueOrDefault("--operation-id"), execute, prepareOnly, port, values.GetValueOrDefault("--deliver-work"),
            bases, repeated.GetValueOrDefault("--producer") ?? [], flags.Contains("--create-accounts"), flags.Contains("--create-active"));
    }

    public string NeedManifest() => Manifest ?? throw new ArgumentException("missing --manifest");
}
