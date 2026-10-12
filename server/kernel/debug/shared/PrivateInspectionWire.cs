using System.Security.Cryptography;
using System.Text;

// The bootstrap key lives only in the private controller/worker processes.
// The public pipe protocol never carries a plaintext native value in this mode.
internal sealed class PrivateInspectionWire : IDisposable {
    readonly byte[] key;
    readonly byte[] aad;
    bool disposed;
    internal PrivateInspectionWire(string encodedKey, string sessionId) {
        if (!System.Text.RegularExpressions.Regex.IsMatch(encodedKey, "^[a-f0-9]{64}$") ||
            !Guid.TryParseExact(sessionId, "N", out _)) throw new DebugFailure("debug_private_inspection_binding_invalid");
        key = Convert.FromHexString(encodedKey);
        aad = Encoding.UTF8.GetBytes("ssam-server-private-inspection/1|" + sessionId);
    }
    internal object Seal(object envelope) {
        if (disposed) throw new DebugFailure("debug_private_inspection_closed");
        byte[]? clear = null;
        try {
            clear = Encoding.UTF8.GetBytes(Wire.Json(envelope));
            if (clear.Length > 3 * 1024 * 1024) throw new DebugFailure("debug_private_inspection_value_budget");
            var nonce = RandomNumberGenerator.GetBytes(12); var tag = new byte[16]; var ciphertext = new byte[clear.Length];
            using var aes = new AesGcm(key, 16);
            aes.Encrypt(nonce, clear, ciphertext, tag, aad);
            return new { format = "ssam-server-private-inspection/1", nonce = Convert.ToBase64String(nonce),
                tag = Convert.ToBase64String(tag), ciphertext = Convert.ToBase64String(ciphertext) };
        } finally { if (clear != null) CryptographicOperations.ZeroMemory(clear); }
    }
    public void Dispose() { disposed = true; CryptographicOperations.ZeroMemory(key); }
}
