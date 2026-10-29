using Microsoft.Win32.SafeHandles;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ssam.Agent;

// file.upload, the rules of agent/lib/upload.mjs in the same order, every check before a byte is read: parameters and the
// call's deadline; the path grammar and an extension; credential and key files and the agent's own folders; inside an
// approved folder as text; then the opened handle (Windows: GetFileInformationByHandle and GetFinalPathNameByHandleW, so the
// real path is the one of the object read; macOS: fstat of the handle, the real path by name and the same identity), a
// regular file with one link, inside the approved folder's current real path, within the size limit; one read through
// that handle, hashed; the existing blob transport; exactly {blob}. At most two at a time.
internal sealed class UploadKinds(string dataRoot, string runtimeRoot, Blobs? blobs, Func<long> maxFileBytes)
{
    internal const string Name = "file.upload";
    internal const long MaxBytes = 64L * 1024 * 1024;
    internal const int AuditLines = 1000;
    private static readonly string[] CredentialSegments = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".git"];
    private static readonly Regex CredentialName = new(@"^(?:id_rsa.*|id_ed25519.*|.*\.(?:pem|key|pfx|p12|ppk|kdbx)|\.env|\.env\..*|\.npmrc|\.netrc|credential.*)$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Singleline);
    private readonly SemaphoreSlim parallel = new(2);

    // The name rules of step 3 (agent/lib/upload.mjs nameRefusal): extension of the last segment, credential folders in
    // any segment, credential and key names in the last one.
    private static void NameRefusal(IReadOnlyList<string> segments, string shown)
    {
        var name = segments.Count == 0 ? "" : segments[^1];
        if (!LocalPaths.Extension.IsMatch(LocalPaths.ExtensionOf(name).ToLowerInvariant()))
            throw NotSent("PATH_FORBIDDEN", $"{shown} has no file extension of 1 to 12 letters or digits; only such files are uploaded");
        if (segments.Any(s => CredentialSegments.Contains(s.ToLowerInvariant())) || CredentialName.IsMatch(name))
            throw NotSent("PATH_FORBIDDEN", $"{shown} is a credential or key file; the agent never uploads those");
    }

    internal sealed record Prepared(byte[] Bytes, string Sha256, long Size, int Index, string Relative);

    private static AgentFault NotSent(string code, string message) => new(code, message) { Sent = false };
    private static bool Late(long? deadline) => deadline is long at && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= at;

    // Steps 1 to 6 without the transport. beforeOpen: the check-upload command's test hook (never set by a kind).
    internal Prepared Prepare(JsonObject p, long? deadline, long? welcomeMax = null, Action? beforeOpen = null)
    {
        if (p["path"] is not JsonValue pathValue || !pathValue.TryGetValue<string>(out var file)) throw NotSent("PARAMS_INVALID", "path must be a string");
        if (p["maxBytes"] is not JsonValue maxValue || !maxValue.TryGetValue<long>(out var max) || max < 1 || max > MaxBytes)
            throw NotSent("PARAMS_INVALID", $"maxBytes must be an integer from 1 to {MaxBytes}");
        var limit = Math.Min(max, Math.Min(MaxBytes, welcomeMax is > 0 ? welcomeMax.Value : MaxBytes));
        if (Late(deadline)) throw NotSent("AGENT_TIMEOUT", "The deadline of the call passed before the file was read; nothing was sent");
        LocalPaths.Parsed parsed;
        try { parsed = LocalPaths.Parse(file); } catch (PathRefusal e) { throw NotSent(e.Code, e.Message); }
        var shown = LocalPaths.Quoted(parsed.Normalized);
        NameRefusal(parsed.Segments, shown);
        foreach (var folder in new[] { dataRoot, runtimeRoot })
            if (LocalPaths.Inside(parsed.Normalized, Path.GetFullPath(folder))) throw NotSent("PATH_FORBIDDEN", $"{shown} is inside the SSAM agent folder; the agent never uploads its own files");

        const string advice = "Approve the folder on this computer first: SSAM Agent > Folders SSAM may read, or `ssam-agent roots add --folder <folder>`.";
        var roots = UploadRoots.Read(dataRoot);
        if (roots.Count == 0) throw NotSent("UPLOAD_ROOT_NOT_APPROVED", "No folder is approved for uploads on this computer. " + advice);
        (int Index, UploadRoots.Root Root, string Relative)? found = null;
        for (var i = 0; i < roots.Count && found == null; i++)
            foreach (var basis in new[] { roots[i].Path, roots[i].Real })
                if (LocalPaths.Inside(parsed.Normalized, basis) && !LocalPaths.Same(parsed.Normalized, basis)) { found = (i, roots[i], LocalPaths.Relative(basis, parsed.Normalized)); break; }
        if (found is not { } match) throw NotSent("UPLOAD_ROOT_NOT_APPROVED", $"{shown} is not inside a folder approved for uploads. {advice}");
        string rootReal;
        try { rootReal = NativeFileIdentity.RealDirectory(match.Root.Path); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { throw NotSent("UPLOAD_ROOT_NOT_APPROVED", "The approved folder that holds this path no longer exists; approve it again"); }
        // The approved folder must still be the same folder: its current real path is the recorded one exactly (no link or
        // junction now on the way), that folder is not itself a link or junction, and it has the file identity (volume and
        // file id) recorded when it was approved (a root recorded without one keeps the exact path rule).
        bool sameRoot;
        try
        {
            sameRoot = rootReal == match.Root.Real && (File.GetAttributes(match.Root.Real) & FileAttributes.ReparsePoint) == 0
                && (match.Root.Id == null || NativeFileIdentity.IdentityOf(match.Root.Real) == match.Root.Id);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { sameRoot = false; }
        if (!sameRoot || LocalPaths.Network(rootReal))
            throw NotSent("PATH_LEAVES_ROOT", "The approved folder that holds this path now leads to another place through a link or junction; approve it again");

        beforeOpen?.Invoke();
        SafeFileHandle handle;
        try { handle = File.OpenHandle(parsed.Normalized, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException) { throw NotSent("FILE_NOT_FOUND", $"{shown} does not exist"); }
        catch (UnauthorizedAccessException)
        {
            if (Directory.Exists(parsed.Normalized)) throw NotSent("PATH_FORBIDDEN", $"{shown} is a folder; only files are uploaded");
            throw NotSent("PATH_FORBIDDEN", $"{shown} cannot be opened by this user");
        }
        catch (IOException e) when ((e.HResult & 0xFFFF) is 32 or 33) { throw NotSent("FILE_LOCKED", $"{shown} is locked by another program; close it in the other program and try again"); }
        catch (IOException) { throw NotSent("FILE_LOCKED", $"{shown} could not be opened"); }
        using (handle)
        {
            NativeFileIdentity.Facts facts;
            try { facts = NativeFileIdentity.Of(handle); } catch (IOException) { throw NotSent("PATH_CHANGED", $"{shown} changed while it was being checked; nothing was sent"); }
            if (facts.Directory) throw NotSent("PATH_FORBIDDEN", $"{shown} is a folder; only files are uploaded");
            if (!facts.Regular) throw NotSent("PATH_FORBIDDEN", $"{shown} is not a regular file");
            if (facts.Links > 1) throw NotSent("PATH_FORBIDDEN", $"{shown} is a hard link (the same file has other names); the agent does not upload hard links");
            string real;
            try { real = OperatingSystem.IsWindows() ? NativeFileIdentity.FinalPath(handle) : MacPlatform.RealPath(parsed.Normalized); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { throw NotSent("PATH_CHANGED", $"{shown} changed while it was being checked; nothing was sent"); }
            // EXACT containment (ordinal, with case): both sides are the system's final paths, spelled as on the disk; no case
            // table decides (NTFS keeps folders apart that any table folds together).
            if (LocalPaths.Network(real) || !LocalPaths.InsideExact(real, rootReal) || real.Length <= rootReal.TrimEnd('\\', '/').Length + 1) throw NotSent("PATH_LEAVES_ROOT", $"{shown} leaves the approved folder through a link or junction");
            // The same name rules on the real (long-name) path, component by component below the approved folder, and the
            // agent's folders by their real paths: an 8.3 short name or a link inside the folder cannot hide .env, .git ...
            NameRefusal(real[rootReal.TrimEnd('\\', '/').Length..].Split('\\', '/', StringSplitOptions.RemoveEmptyEntries), shown);
            foreach (var folder in new[] { dataRoot, runtimeRoot })
            {
                string? agentReal = null;
                try { if (Directory.Exists(folder)) agentReal = NativeFileIdentity.RealDirectory(folder); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
                if (agentReal != null && LocalPaths.Inside(real, agentReal)) throw NotSent("PATH_FORBIDDEN", $"{shown} is inside the SSAM agent folder; the agent never uploads its own files");
            }
            if (!OperatingSystem.IsWindows())
            {
                string named;
                try { named = NativeFileIdentity.IdentityOf(real); } catch (IOException) { throw NotSent("PATH_CHANGED", $"{shown} changed while it was being checked; nothing was sent"); }
                if (named != facts.Identity) throw NotSent("PATH_CHANGED", $"{shown} changed while it was being checked; nothing was sent");
            }
            if (facts.Size > limit) throw NotSent("FILE_TOO_LARGE", $"{shown} has {facts.Size} bytes, above the limit of {limit}; nothing was read");
            if (Late(deadline)) throw NotSent("AGENT_TIMEOUT", "The deadline of the call passed before the file was read; nothing was sent");
            var bytes = new byte[facts.Size];
            var offset = 0;
            while (offset < bytes.Length)
            {
                var read = RandomAccess.Read(handle, bytes.AsSpan(offset), offset);
                if (read == 0) break;
                offset += read;
            }
            if (offset != bytes.Length || RandomAccess.Read(handle, new byte[1], bytes.Length) != 0)
                throw NotSent("FILE_CHANGED", $"{shown} changed size while it was being read; nothing was sent");
            return new(bytes, Convert.ToHexStringLower(SHA256.HashData(bytes)), bytes.Length, match.Index, match.Relative);
        }
    }

    internal async Task<JsonNode> Execute(JsonObject p, long? deadline, CancellationToken token)
    {
        if (blobs == null) throw NotSent("BLOB_TRANSFER_FAILED", "No channel for files");
        var wait = deadline is long at ? TimeSpan.FromMilliseconds(Math.Max(0, at - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())) : Timeout.InfiniteTimeSpan;
        if (!await parallel.WaitAsync(wait, token)) throw NotSent("AGENT_TIMEOUT", "The deadline of the call passed while two other uploads were running; nothing was sent");
        try
        {
            var prepared = Prepare(p, deadline, maxFileBytes());
            BlobRef blob;
            try
            {
                using var source = new MemoryStream(prepared.Bytes, false);
                blob = await blobs.Upload(source, token, index => {
                    if (Late(deadline)) throw new AgentFault("AGENT_TIMEOUT", $"The deadline of the call passed after {index} of the file's parts; the server keeps nothing of it")
                        { Sent = index == 0 ? false : null, SentUnknown = index != 0 };
                });
            }
            catch (AgentFault e) when (e.Code != "AGENT_TIMEOUT")
            { throw new AgentFault("BLOB_TRANSFER_FAILED", "The file could not be sent to the server: " + e.Message) { SentUnknown = true }; }
            Record(new JsonObject { ["root"] = prepared.Index, ["relative"] = prepared.Relative, ["size"] = prepared.Size, ["sha256"] = prepared.Sha256 });
            return new JsonObject { ["blob"] = blob.Json() };
        }
        finally { parallel.Release(); }
    }

    // private/uploads.jsonl, the last AuditLines uploads, for the person only; never a reason to fail an upload.
    private void Record(JsonObject entry)
    {
        var file = Path.Combine(dataRoot, "private", "uploads.jsonl");
        try
        {
            var line = new JsonObject { ["at"] = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture) };
            foreach (var pair in entry) line[pair.Key] = pair.Value?.DeepClone();
            lock (parallel)
            {
                File.AppendAllText(file, line.ToJsonString() + "\n");
                var lines = File.ReadAllLines(file).Where(l => l.Length > 0).ToArray();
                if (lines.Length > AuditLines)
                {
                    var temporary = file + "." + Environment.ProcessId + ".tmp";
                    File.WriteAllText(temporary, string.Join("\n", lines[^AuditLines..]) + "\n");
                    File.Move(temporary, file, true);
                }
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }
}
