using Anvil.Core;
using Xunit;

namespace Anvil.Tests.Odc;

/// <summary>
/// OdcFeatures.TakeFolder: the Studio's feature provider opens Features.xml of its folder for reading and writing with no
/// sharing and writes it back, so two processes reading one shared &lt;work&gt;\odc-features failed one of them ("being used
/// by another process"; marco-a2 on the copy, marco-a3 on the provider's load). Each process now reads from a numbered folder
/// it owns while it lives: its owner file stays open with no sharing. Here a held owner stands for another live process.
/// No Studio needed.
/// </summary>
public class OdcFeaturesFolderTests
{
    [Fact]
    public void Each_live_owner_reads_its_own_folder_and_an_ended_owners_folder_is_taken_again()
    {
        var root = Path.Combine(Path.GetTempPath(), "anvil-odc-features-" + Guid.NewGuid().ToString("N"));
        try
        {
            using var first = OdcFeatures.TakeFolder(root, out var a);
            var second = OdcFeatures.TakeFolder(root, out var b);
            Assert.Equal(Path.Combine(root, "0"), a);
            Assert.Equal(Path.Combine(root, "1"), b);
            using (OdcFeatures.TakeFolder(root, out var c)) Assert.Equal(Path.Combine(root, "2"), c);

            // The file a provider holds with no sharing in one owner's folder never blocks another owner.
            using (new FileStream(Path.Combine(a, "Features.xml"), FileMode.Create, FileAccess.ReadWrite, FileShare.None))
            {
                File.WriteAllText(Path.Combine(b, "Features.xml"), "second");
                Assert.Equal("second", File.ReadAllText(Path.Combine(b, "Features.xml")));
            }

            second.Dispose(); // the second process ended: its folder is the first free one again
            using (OdcFeatures.TakeFolder(root, out var d)) Assert.Equal(b, d);
            Assert.Equal(3, Directory.GetDirectories(root).Length); // never more folders than owners alive at once
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch (IOException) { }
        }
    }
}
