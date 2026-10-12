using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

// Signed upload capabilities remain inside the Studio. The facade receives a
// scoped opaque operation UUID, a public object URI and a file-content proof.
// This class never persists, logs or returns the signed URI. A Studio restart
// loses the capability; that is not permission to repeat the upload.
internal static class PortalMobileUpload {
    internal const int MaxBytes = 1048576;
    private sealed class Entry {
        internal required string Host, User, SignedUri, ObjectUri, ContentSha256;
        internal required int ByteLength;
        internal required DateTimeOffset ExpiresAt;
    }
    private static readonly ConcurrentDictionary<string, Entry> Entries = new(StringComparer.OrdinalIgnoreCase);
    private static PortalCore.Refusal Refuse() => new("MOBILE_UPLOAD_UNAVAILABLE", "The exact private mobile upload is unavailable; inspect the original receipt and never repeat its upload.");
    internal static bool IsBase64Binding(string operationUuid, string value) => Guid.TryParseExact(operationUuid,"D",out _) && value=="urn:ssam:mobile-base64:"+operationUuid;
    internal static bool CheckBinding(string operationUuid, string value) => IsBase64Binding(operationUuid,value) || CheckUri(value).Query.Length==0;
    // This is the observed native conversion's output, not a locally fabricated
    // encoding. Compare canonical bytes before retaining its private save value.
    internal static JsonObject CaptureBase64(string host,string user,string operationUuid,string input,string output,DateTimeOffset now) {
        PortalCore.CheckHost(host);
        if(string.IsNullOrWhiteSpace(user)||!Guid.TryParseExact(operationUuid,"D",out _)||input.Length>1398104||output.Length>1398104)throw Refuse();
        byte[]? expected=null,actual=null;
        try {
            expected=Convert.FromBase64String(input);actual=Convert.FromBase64String(output);
            if(expected.Length is 0 or >MaxBytes||Convert.ToBase64String(expected)!=input||Convert.ToBase64String(actual)!=output
                ||expected.Length!=actual.Length||!CryptographicOperations.FixedTimeEquals(expected,actual))throw Refuse();
            var sha=Convert.ToHexString(SHA256.HashData(actual)).ToLowerInvariant();var binding="urn:ssam:mobile-base64:"+operationUuid;
            Prune(now);
            if(!Entries.TryAdd(operationUuid,new Entry {Host=host,User=user,SignedUri=output,ObjectUri=binding,ContentSha256=sha,ByteLength=actual.Length,ExpiresAt=now.AddMinutes(10)}))throw Refuse();
            return new JsonObject {["uploadOperationUuid"]=operationUuid,["objectUri"]=binding,["transportMode"]="base64",["contentSha256"]=sha,["byteLength"]=actual.Length,["contentVerified"]=true,["signedUriExposed"]=false};
        } catch(PortalCore.Refusal){throw;}catch{throw Refuse();}
        finally {if(expected!=null)CryptographicOperations.ZeroMemory(expected);if(actual!=null)CryptographicOperations.ZeroMemory(actual);}
    }
    internal static Uri CheckUri(string value) {
        if (value.Length > 8192 || !Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0
            || !Regex.IsMatch(uri.Host, @"^plat-[a-z0-9]{1,58}\.s3\.[a-z0-9-]+\.amazonaws\.com$", RegexOptions.CultureInvariant)
            || !Regex.IsMatch(uri.AbsolutePath, @"^/tenants/uploads/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$", RegexOptions.CultureInvariant)
            || value.Contains("REDACTED", StringComparison.OrdinalIgnoreCase)) throw Refuse();
        return uri;
    }
    internal static async Task<JsonObject> Capture(string host, string user, string operationUuid, string base64,
        string signedUri, HttpClient downloadClient, DateTimeOffset now, CancellationToken token) {
        PortalCore.CheckHost(host);
        if (string.IsNullOrWhiteSpace(user) || !Guid.TryParseExact(operationUuid, "D", out _) || base64.Length > 1398104) throw Refuse();
        byte[] expected;
        try { expected = Convert.FromBase64String(base64); } catch { throw Refuse(); }
        if (expected.Length is 0 or > MaxBytes || Convert.ToBase64String(expected) != base64) throw Refuse();
        byte[]? actual=null;
        try {
        var uri = CheckUri(signedUri);
        var query = uri.Query.TrimStart('?').Split('&').Select(part => part.Split('=', 2))
            .Where(parts => parts.Length == 2).GroupBy(parts => parts[0], StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.Select(parts => Uri.UnescapeDataString(parts[1])).ToArray(), StringComparer.OrdinalIgnoreCase);
        if (!query.TryGetValue("X-Amz-Date", out var dates) || dates.Length != 1
            || !DateTimeOffset.TryParseExact(dates[0], "yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal, out var issued)
            || !query.TryGetValue("X-Amz-Expires", out var durations) || durations.Length != 1
            || !int.TryParse(durations[0], out var seconds) || seconds is <= 0 or > 604800
            || !query.TryGetValue("X-Amz-Signature", out var signatures) || signatures.Length != 1 || signatures[0].Length == 0)
            throw Refuse();
        var expiry = issued.AddSeconds(seconds);
        if (expiry <= now) throw Refuse();
        // Never send the Portal client, cookies, bearer or default credentials
        // to S3. The caller supplies a separate no-redirect download client.
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        using var response = await downloadClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
        if ((int)response.StatusCode != 200 || response.RequestMessage?.RequestUri != uri
            || response.Content.Headers.ContentLength is > MaxBytes) throw Refuse();
        await using var stream = await response.Content.ReadAsStreamAsync(token);
        using var bytes = new MemoryStream(); var chunk = new byte[8192];
        int count;
        while ((count = await stream.ReadAsync(chunk, token)) > 0) {
            if (bytes.Length + count > MaxBytes) throw Refuse();
            await bytes.WriteAsync(chunk.AsMemory(0, count), token);
        }
        actual = bytes.ToArray();
        if (actual.Length != expected.Length || !CryptographicOperations.FixedTimeEquals(SHA256.HashData(actual), SHA256.HashData(expected))) throw Refuse();
        var sha = Convert.ToHexString(SHA256.HashData(actual)).ToLowerInvariant();
        var objectUri = uri.GetLeftPart(UriPartial.Path);
        Prune(now);
        if (!Entries.TryAdd(operationUuid, new Entry { Host = host, User = user, SignedUri = signedUri,
            ObjectUri = objectUri, ContentSha256 = sha, ByteLength = actual.Length,
            ExpiresAt = expiry < now.AddMinutes(10) ? expiry : now.AddMinutes(10) })) throw Refuse();
        return new JsonObject { ["uploadOperationUuid"] = operationUuid, ["objectUri"] = objectUri,
            ["contentSha256"] = sha, ["byteLength"] = actual.Length, ["contentVerified"] = true,
            ["signedUriExposed"] = false };
        } finally { CryptographicOperations.ZeroMemory(expected); if(actual!=null)CryptographicOperations.ZeroMemory(actual); }
    }
    // Inspection is read-only; consumption happens only after the save's durable
    // reservation. Host/principal/object binding prevents a different context
    // from consuming the resident capability, including a forged opaque UUID.
    internal static string Resolve(string operationUuid, string host, string user, string objectUri, DateTimeOffset now, bool consume) {
        Prune(now);
        if (!Entries.TryGetValue(operationUuid, out var entry) || entry.Host != host
            || !string.Equals(entry.User, user, StringComparison.OrdinalIgnoreCase) || entry.ObjectUri != objectUri) throw Refuse();
        if (consume && (!Entries.TryRemove(operationUuid, out var removed) || !ReferenceEquals(entry, removed))) throw Refuse();
        return entry.SignedUri;
    }
    private static void Prune(DateTimeOffset now) {
        foreach (var pair in Entries) if (pair.Value.ExpiresAt <= now) Entries.TryRemove(pair.Key, out _);
    }
}
