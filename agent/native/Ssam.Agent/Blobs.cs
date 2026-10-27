using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Ssam.Agent;

internal sealed class AgentFault(string code, string message, bool? executed = false) : Exception(message)
{
    public string Code { get; } = code;
    public bool? Executed { get; } = executed;
    public bool? Sent { get; init; }
}

internal sealed record BlobRef(string Transfer, string Sha256, long Size, int Parts, int PartBytes)
{
    public JsonObject Json() => new() { ["transfer"] = Transfer, ["sha256"] = Sha256, ["size"] = Size, ["parts"] = Parts, ["partBytes"] = PartBytes };
    private static bool Hex(string? value, int length) => value?.Length == length && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    public static BlobRef Parse(JsonNode? node, int maxPartBytes, long maxFileBytes)
    {
        try
        {
            if (node is not JsonObject) throw new InvalidOperationException();
            var transfer = node["transfer"]!.GetValue<string>(); var hash = node["sha256"]!.GetValue<string>();
            var size = node["size"]!.GetValue<long>(); var parts = node["parts"]!.GetValue<int>(); var bytes = node["partBytes"]!.GetValue<int>();
            if (!Hex(transfer, 32) || !Hex(hash, 64) || size < 0 || bytes <= 0 || bytes > maxPartBytes
                || !(parts == (long)Math.Ceiling((double)size / bytes) || size == 0 && parts == 1)) throw new InvalidOperationException();
            if (size > maxFileBytes) throw new AgentFault("FILE_TOO_LARGE", "File exceeds the negotiated limit");
            return new(transfer, hash, size, parts, bytes);
        }
        catch (Exception e) when (e is InvalidOperationException or NullReferenceException or FormatException or OverflowException)
        { throw new AgentFault("TRANSFER_INVALID", "Malformed file reference from the server"); }
    }
}

internal sealed class Blobs(AgentChannel channel)
{
    public const string TemporarySuffix = ".ssam-tmp";
    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    internal static async Task<string> FileHash(string file, CancellationToken token)
    {
        await using var stream = File.OpenRead(file);
        return Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, token));
    }

    public async Task<BlobRef> Upload(Stream source, CancellationToken token)
    {
        var size = source.Length;
        if (size > channel.MaxFileBytes) throw new AgentFault("FILE_TOO_LARGE", "File exceeds the negotiated limit");
        source.Position = 0;
        var hash = Convert.ToHexStringLower(await SHA256.HashDataAsync(source, token));
        source.Position = 0;
        var bytes = channel.PartBytes;
        var reference = new BlobRef(Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16)), hash, size,
            Math.Max(1, (int)Math.Ceiling((double)size / bytes)), bytes);
        for (var index = 0; index < reference.Parts; index++)
        {
            var part = new byte[(int)Math.Min(bytes, size - (long)index * bytes)];
            await source.ReadExactlyAsync(part, token);
            var headers = new Dictionary<string, string> {
                ["x-ssam-part-sha256"] = Hash(part), ["x-ssam-total-sha256"] = hash,
                ["x-ssam-total-size"] = size.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["x-ssam-parts"] = reference.Parts.ToString(System.Globalization.CultureInfo.InvariantCulture)
            };
            var fresh = false;
            for (var attempt = 0; ; attempt++)
            {
                var status = 0;
                try { status = (await channel.Part(HttpMethod.Put, reference.Transfer, index, part, headers, bytes, fresh, token)).Status; }
                catch (Exception e) when (e is HttpRequestException || e is OperationCanceledException && !token.IsCancellationRequested) { }
                if (status is 200 or 204) break;
                if (status is 401 or 403 or 409 or 413 || attempt >= 3) throw new AgentFault("BLOB_TRANSFER_FAILED", "A file part was not accepted by the server", null);
                fresh = status == 0;
                await Task.Delay(250 * (attempt + 1), token);
            }
        }
        return reference;
    }

    public async Task Download(BlobRef reference, string destination, CancellationToken token, Action? beforeCommit = null)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var temporary = destination + "." + Guid.NewGuid().ToString("N") + TemporarySuffix;
        try
        {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long size = 0;
            await using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                for (var index = 0; index < reference.Parts; index++)
                {
                    var fresh = false;
                    for (var attempt = 0; ; attempt++)
                    {
                        PartReply? reply = null;
                        try { reply = await channel.Part(HttpMethod.Get, reference.Transfer, index, null, null, reference.PartBytes, fresh, token); }
                        catch (Exception e) when (e is HttpRequestException || e is OperationCanceledException && !token.IsCancellationRequested) { }
                        if (reply?.Status == 200 && reply.Body.Length <= reference.PartBytes && Hash(reply.Body) == reply.PartSha?.ToLowerInvariant())
                        {
                            size += reply.Body.Length;
                            if (size > reference.Size) throw new AgentFault("BLOB_HASH_MISMATCH", "The downloaded file exceeds its declared size");
                            hash.AppendData(reply.Body);
                            await stream.WriteAsync(reply.Body, token);
                            break;
                        }
                        if (reply?.Status is 401 or 403 or 404 || attempt >= 3)
                            throw new AgentFault(reply?.Status == 200 ? "BLOB_HASH_MISMATCH" : "BLOB_TRANSFER_FAILED", "A file part could not be verified; destination unchanged");
                        fresh = reply == null;
                        await Task.Delay(250 * (attempt + 1), token);
                    }
                }
            }
            if (size != reference.Size || Convert.ToHexStringLower(hash.GetHashAndReset()) != reference.Sha256)
                throw new AgentFault("BLOB_HASH_MISMATCH", "The downloaded file does not match its hash; destination unchanged");
            beforeCommit?.Invoke();
            File.Move(temporary, destination, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}

internal sealed record PartReply(int Status, byte[] Body, string? PartSha);
