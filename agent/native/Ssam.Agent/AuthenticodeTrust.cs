using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json.Nodes;

namespace Ssam.Agent;

internal static class AuthenticodeTrust
{
    internal sealed record Evidence(bool Valid, string Thumbprint, string Organization, bool CodeSigning, string Root);
    internal static bool Accept(Evidence e, string signer, string owner, IEnumerable<string> roots) => e.Valid && (signer switch
    {
        "owner" => string.Equals(e.Thumbprint, owner, StringComparison.OrdinalIgnoreCase),
        "microsoft" => e.Organization == "Microsoft Corporation" && e.CodeSigning && roots.Contains(e.Root, StringComparer.OrdinalIgnoreCase),
        _ => false
    });
    internal static JsonObject Check(string file, string signer, string owner = BridgeTrust.AuthenticodeThumbprint)
    {
        var e = Inspect(file);
        return new() { ["ok"] = Accept(e, signer, owner, BridgeTrust.MicrosoftRoots), ["signatureValid"] = e.Valid,
            ["thumbprint"] = e.Thumbprint, ["organization"] = e.Organization, ["codeSigning"] = e.CodeSigning, ["root"] = e.Root };
    }
    internal static Evidence Inspect(string file)
    {
        if (!OperatingSystem.IsWindows()) throw new IOException("Authenticode requires Windows");
        var info = new FileInfoData { Size = (uint)Marshal.SizeOf<FileInfoData>(), File = Marshal.StringToCoTaskMemUni(Path.GetFullPath(file)) };
        var pointer = Marshal.AllocHGlobal(Marshal.SizeOf<FileInfoData>()); Marshal.StructureToPtr(info, pointer, false);
        var data = new TrustData { Size = (uint)Marshal.SizeOf<TrustData>(), UI = 2, Choice = 1, File = pointer, Action = 1, Flags = 0x1010 };
        var policy = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        try
        {
            var status = WinVerifyTrust(new IntPtr(-1), ref policy, ref data);
            if (status != 0) return new(false, "", "", false, "");
            var provider = WTHelperProvDataFromStateData(data.State);
            var signer = WTHelperGetProvSignerFromChain(provider, 0, false, 0);
            if (signer == IntPtr.Zero) return new(false, "", "", false, "");
            var signing = Marshal.PtrToStructure<ProviderSigner>(signer);
            var chain = Marshal.PtrToStructure<ChainContext>(signing.Chain);
            var simple = Marshal.PtrToStructure<SimpleChain>(Marshal.ReadIntPtr(chain.Chains));
            if (simple.Count == 0) return new(false, "", "", false, "");
            using var leaf = Certificate(Marshal.ReadIntPtr(simple.Elements));
            using var root = Certificate(Marshal.ReadIntPtr(simple.Elements, checked((int)(simple.Count - 1) * IntPtr.Size)));
            var organizations = leaf.SubjectName.Decode(X500DistinguishedNameFlags.UseNewLines).Split('\n').Select(x => x.Trim()).Where(x => x.StartsWith("O=", StringComparison.Ordinal)).Select(x => x[2..]).ToArray();
            var eku = leaf.Extensions.OfType<X509EnhancedKeyUsageExtension>().Any(x => x.EnhancedKeyUsages.Cast<Oid>().Any(o => o.Value == "1.3.6.1.5.5.7.3.3"));
            return new(true, leaf.Thumbprint, organizations.Length == 1 ? organizations[0] : "", eku, Convert.ToHexString(SHA256.HashData(root.RawData)));
        }
        finally { data.Action = 2; WinVerifyTrust(new IntPtr(-1), ref policy, ref data); Marshal.FreeHGlobal(pointer); Marshal.FreeCoTaskMem(info.File); }
    }
    private static X509Certificate2 Certificate(IntPtr element) => new(Marshal.PtrToStructure<ChainElement>(element).Certificate);
    [StructLayout(LayoutKind.Sequential)] private struct FileInfoData { public uint Size; public IntPtr File, Handle, Subject; }
    [StructLayout(LayoutKind.Sequential)] private struct TrustData { public uint Size; public IntPtr Callback, Client; public uint UI, Revocation, Choice; public IntPtr File; public uint Action; public IntPtr State, Url; public uint Flags, Context; public IntPtr SignatureSettings; }
    [StructLayout(LayoutKind.Sequential)] private struct ProviderSigner { public uint Size; public System.Runtime.InteropServices.ComTypes.FILETIME Time; public uint Count; public IntPtr Certs; public uint Type; public IntPtr Signer; public uint Error, CounterCount; public IntPtr Counters, Chain; }
    [StructLayout(LayoutKind.Sequential)] private struct ChainContext { public uint Size, Error, Info, Count; public IntPtr Chains; }
    [StructLayout(LayoutKind.Sequential)] private struct SimpleChain { public uint Size, Error, Info, Count; public IntPtr Elements; }
    [StructLayout(LayoutKind.Sequential)] private struct ChainElement { public uint Size; public IntPtr Certificate; }
    [DllImport("wintrust.dll", ExactSpelling = true)] private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
    [DllImport("wintrust.dll", ExactSpelling = true)] private static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
    [DllImport("wintrust.dll", ExactSpelling = true)] private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr data, uint signer, [MarshalAs(UnmanagedType.Bool)] bool counter, uint index);
}
