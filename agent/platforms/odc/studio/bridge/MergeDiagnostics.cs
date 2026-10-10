using System.Text;

// Studio-free diagnostics of the bridge's merge and publish gates, compiled into the bridge and into Bridge.Tests:
// - the answer of a failed command carries the message, never the .NET stack trace (last-error.json keeps it);
// - an uncertain merge names each divergence of the comparison on one line (element, property, local, candidate);
// - the author refusal names what the Studio answered next to what the manifest expects;
// - a validation message names its owner and the nearest ancestor that ssam_map and studio_inspect address by @key.
internal static class MergeDiagnostics {
    // The merge ran (handed off) and the module differs from the candidate outside the known classes: the outcome is
    // uncertain, and the answer lists every divergence instead of a stack trace. Message stays the strict refusal's own
    // line (the journal note and the gate classification read it, never the model text of a divergence); Detailed is the
    // answer's error, with one line per divergence.
    internal sealed class MergeUncertainException : InvalidOperationException {
        public NativeMergeVerification.Divergence[] Divergences { get; }
        public MergeUncertainException(string message, NativeMergeVerification.Divergence[] divergences, Exception? inner = null) : base(FirstLine(message), inner) { Divergences = divergences; }
        public string Detailed => UncertainMessage(Message, Divergences);
    }

    public const int MaxDivergenceLines = 20;

    // G-2 (A03, C16): a new live message after the merge ({type, id, message, detail}) blocks only when it is an error or a
    // security warning (SecurityWarnings.IsSecurity, the kernel's list); every other one is a warning of the receipt.
    public static bool BlocksAfterMerge(System.Text.Json.Nodes.JsonObject? message) {
        var type = message?["type"]?.ToString() ?? "";
        if (type.Contains("Error", StringComparison.Ordinal)) return true;
        return SecurityWarnings.IsSecurity(message?["id"]?.ToString() ?? "", (message?["message"]?.ToString() ?? "") + "|" + (message?["detail"]?.ToString() ?? ""));
    }

    // One line per divergence: "<element> (<kind>): <property> local '<l>' / candidate '<c>'", or the presence of an element.
    public static string Line(NativeMergeVerification.Divergence d) =>
        d.Element + " (" + d.Kind + "): " + (d.Property == null ? "element " + d.Local + " in the module, " + d.Candidate + " in the candidate" : d.Property + " local '" + d.Local + "' / candidate '" + d.Candidate + "'");

    // The message of an uncertain merge: the strict refusal's own first line, then each divergence on its own line.
    public static string UncertainMessage(string strictMessage, NativeMergeVerification.Divergence[] divergences) {
        var text = new StringBuilder(FirstLine(strictMessage));
        if (divergences.Length > 0) {
            text.Append(". Divergences (" + divergences.Length + (divergences.Length >= MaxDivergenceLines ? "+" : "") + "):");
            foreach (var d in divergences.Take(MaxDivergenceLines)) text.Append('\n').Append(Line(d));
        }
        // G-3 (C16): the merge ran, so the module already has the candidate's changes; the text never says "never repeat" alone.
        text.Append("\nThe merge ran and is already integrated in the open module (merged:true): never repeat this delivery; read the evidence (native-equivalence.txt) before any new change.");
        return text.ToString();
    }

    // The error text of a failed command: the message of the exception, never its stack trace. A message that already
    // holds a stack (an inner ToString) is cut at its first frame.
    public static string Answer(Exception error) => WithoutStack(error.Message);
    public static string WithoutStack(string? text) {
        if (string.IsNullOrEmpty(text)) return text ?? "";
        var kept = text.Replace("\r\n", "\n").Split('\n')
            .TakeWhile(line => !line.TrimStart().StartsWith("at ", StringComparison.Ordinal) && !line.StartsWith("--- End of", StringComparison.Ordinal) && !line.StartsWith("   --- End of", StringComparison.Ordinal));
        return string.Join("\n", kept).TrimEnd();
    }
    internal static string FirstLine(string text) => WithoutStack(text).Split('\n')[0].TrimEnd('.');

    // The author gate: the developer id the Studio answers for the open module must be the snapshot author. The refusal
    // shows both sides and the session the module is bound to (tenant, user, logged in), plus every Studio session.
    public static string AuthorMismatch(string expectedAuthor, string expectedTenant, string? observedDeveloper, string? observedTenant, string? observedUser, bool? loggedIn, IEnumerable<string>? sessions = null) {
        var text = "Authenticated author mismatch: expected " + expectedAuthor + " on " + expectedTenant + " (the snapshot author); observed developerId "
            + Quote(observedDeveloper) + " for this module, tenant " + Quote(observedTenant) + ", user " + Quote(observedUser) + ", logged in " + (loggedIn?.ToString().ToLowerInvariant() ?? "unknown") + ".";
        var list = sessions?.Where(s => !string.IsNullOrWhiteSpace(s)).ToArray() ?? Array.Empty<string>();
        if (list.Length > 0) text += " Studio sessions: " + string.Join(", ", list) + ".";
        text += string.IsNullOrEmpty(observedDeveloper) || observedTenant != expectedTenant || loggedIn != true
            ? " The module's Studio session does not answer the snapshot author: sign in to " + expectedTenant + " in the ODC Studio as " + expectedAuthor + ", then repeat this command (nothing was changed)."
            : " The Studio answers another developer for this module: deliver again from a new snapshot (its author is the session's), or sign in as " + expectedAuthor + "; nothing was changed.";
        return text;
    }
    private static string Quote(string? value) => string.IsNullOrEmpty(value) ? "(none)" : value;

    // A node of a model object chain, from a validation message's owner up to the module (the last entry).
    public sealed record ModelNode(string? Key, string Kind, string? Name);
    public sealed record Address(string? OwnerKey, string OwnerPath, string? AddressableKey, string? AddressablePath);
    // Kinds the module map lists only as detail rows or never as an element of its own.
    private static readonly HashSet<string> Unaddressable = new(StringComparer.Ordinal) { "ParsedExpression", "Expression", "CustomProperty", "Argument", "PropertyValue" };
    public static bool IsAddressable(ModelNode node) =>
        !string.IsNullOrWhiteSpace(node.Key) && !node.Key!.Contains('/') && !node.Key.Any(char.IsWhiteSpace) && !Unaddressable.Contains(node.Kind) && !string.IsNullOrWhiteSpace(node.Name);
    // ownerPath and addressablePath read like ModelReader.PathOf ("Kind:Name/Kind:Name", the module itself left out);
    // the addressable entry is the owner itself when it is addressable, else its nearest such ancestor, never the module.
    public static Address Locate(IReadOnlyList<ModelNode> chain) {
        if (chain.Count == 0) return new Address(null, "", null, null);
        string PathFrom(int index) => string.Join("/", Enumerable.Range(index, Math.Max(0, chain.Count - 1 - index)).Reverse().Select(i => chain[i].Kind + ":" + Clip(chain[i].Name)));
        for (var i = 0; i < chain.Count - 1; i++)
            if (IsAddressable(chain[i])) return new Address(chain[0].Key, PathFrom(0), chain[i].Key, PathFrom(i));
        return new Address(chain[0].Key, PathFrom(0), null, null);
    }
    private static string Clip(string? name) => string.IsNullOrEmpty(name) ? "?" : name.Length <= 80 ? name : name[..80];
}
