using System.Security.Cryptography;

// C25 (capability template-download:have): the template file this bridge kept from an earlier download, for a revision the
// caller already holds. Studio-free, compiled into the bridge and into Bridge.Tests.
internal static class TemplateCache {
    // have: "<revision>-<sha12>" the caller holds; revision: the tenant's latest revision of the template; dir and stem: the
    // bridge's own files, "<dir>\<key>-r<revision>-<SHA12>.oml". The file counts only when the revision is the latest and
    // its bytes still hash to the sha12 prefix; anything else is null and the template is downloaded as always.
    public static string? Kept(string? have, string revision, string dir, string stem) {
        if (string.IsNullOrWhiteSpace(have)) return null;
        var dash = have.LastIndexOf('-');
        if (dash <= 0) return null;
        var (rev, sha) = (have[..dash], have[(dash + 1)..]);
        if (rev != revision || sha.Length != 12 || !sha.All(Uri.IsHexDigit) || !Directory.Exists(dir)) return null;
        var name = stem + sha + ".oml";
        var path = Directory.EnumerateFiles(dir, stem + "*.oml").FirstOrDefault(f => string.Equals(Path.GetFileName(f), name, StringComparison.OrdinalIgnoreCase));
        if (path == null) return null;
        try {
            var hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));
            return hash.StartsWith(sha, StringComparison.OrdinalIgnoreCase) ? path : null;
        } catch (IOException) { return null; }
    }
}
