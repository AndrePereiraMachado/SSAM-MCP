using System.IO.Compression;
using System.Text.Json.Nodes;
using Anvil.Xif;
using Xunit;

namespace Anvil.Tests;

/// <summary>F4 review A1 and A2. A1: with --confine (hosted) every file a spec names, in every shape the parser accepts
/// (a reference as text, as {file}, one object for the list; a source or resource file, in a list or alone), is
/// PATH_OUTSIDE_WORKSPACE when it is outside the account's folders, with the same answer whether it exists or not and
/// without its content being read. A2: a path inside the extension becomes one folder per segment on every system.</summary>
public sealed class XifConfineTests
{
    private static string Temp(string name)
    {
        var dir = Path.Combine(Path.GetTempPath(), "anvil-xif-confine-" + name + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static JsonNode Spec(string extra) => JsonNode.Parse("""{"name":"ZZHybridXifLab","actions":[{"name":"Add","inputs":[{"name":"Left","type":"Integer"}],"outputs":[{"name":"Result","type":"Integer"}],"body":"Result = Left;"}]""" + extra + "}")!;
    private static string J(string path) => System.Text.Json.JsonSerializer.Serialize(path);

    [Fact]
    public void EveryShapeOfAFileOutsideTheWorkspaceIsRefusedTheSameWayWhetherItExistsOrNot()
    {
        var base_ = Temp("ws");
        try
        {
            var ws = Path.Combine(base_, "customers", "tok_a", "o11");
            var other = Path.Combine(base_, "customers", "tok_b", "o11");
            Directory.CreateDirectory(ws); Directory.CreateDirectory(other);
            var foreign = Path.Combine(other, "Lib.dll");
            File.WriteAllText(foreign, "not a dll");
            var missing = Path.Combine(other, "Missing.dll");
            var text = Path.Combine(other, "notes.txt");
            File.WriteAllText(text, "secret");
            var confine = new[] { ws };
            var shapes = new[]
            {
                ",\"references\":[" + J(foreign) + "]",
                ",\"references\":[{\"file\":" + J(foreign) + "}]",
                ",\"references\":{\"file\":" + J(foreign) + "}",
                ",\"references\":" + J(foreign),
                ",\"sources\":[{\"path\":\"Helpers.cs\",\"file\":" + J(text) + "}]",
                ",\"sources\":{\"path\":\"Helpers.cs\",\"file\":" + J(text) + "}",
                ",\"resources\":[{\"path\":\"Data\\\\n.txt\",\"file\":" + J(text) + ",\"deploy\":\"Ignore\"}]",
                ",\"resources\":{\"path\":\"Data\\\\n.txt\",\"file\":" + J(text) + ",\"deploy\":\"Ignore\"}",
            };
            foreach (var shape in shapes)
            {
                var refusal = Assert.Throws<XifRefusal>(() => XifBuild.Check(Spec(shape), null, confine));
                var problem = Assert.Single(refusal.Problems, p => p.Code == XifPaths.OutsideCode);
                Assert.DoesNotContain("exist", problem.Message);
                Assert.DoesNotContain(refusal.Problems, p => p.Code != XifPaths.OutsideCode && p.Code != XifCodes.SpecInvalid);
            }
            // A file that does not exist answers exactly as one that does: no oracle.
            var a = Assert.Throws<XifRefusal>(() => XifBuild.Check(Spec(",\"references\":[" + J(foreign) + "]"), null, confine));
            var b = Assert.Throws<XifRefusal>(() => XifBuild.Check(Spec(",\"references\":[" + J(missing) + "]"), null, confine));
            Assert.Equal(a.Problems.Select(p => (p.Code, p.Path, p.Message)), b.Problems.Select(p => (p.Code, p.Path, p.Message)));
            // The same spec without confinement (local) is the parser of before: the file is looked at.
            var local = Assert.Throws<XifRefusal>(() => XifBuild.Check(Spec(",\"references\":[" + J(missing) + "]"), null));
            Assert.Contains(local.Problems, p => p.Code == "XIF_SPEC_FILE" && p.Message.Contains("does not exist"));
            // A source inside the workspace passes.
            var inside = Path.Combine(ws, "Helpers.cs");
            File.WriteAllText(inside, "namespace OutSystems.NssZZHybridXifLab { public static class Helpers { } }");
            Assert.Equal(true, XifBuild.Check(Spec(",\"sources\":[{\"path\":\"Helpers.cs\",\"file\":" + J(inside) + "}]"), null, confine)["ok"]!.GetValue<bool>());
            // ".." out of the root is outside.
            var dotted = Path.Combine(ws, "..", "..", "tok_b", "o11", "Lib.dll");
            Assert.Throws<XifRefusal>(() => XifBuild.Check(Spec(",\"references\":[" + J(dotted) + "]"), null, confine));
        }
        finally { Directory.Delete(base_, true); }
    }

    [Fact]
    public void ConfineRootsComeFromTheOptionAndTheVariable()
    {
        Assert.Null(XifPaths.Roots([], null));
        var roots = XifPaths.Roots([Path.GetTempPath()], string.Join(Path.PathSeparator, Path.Combine(Path.GetTempPath(), "a"), Path.Combine(Path.GetTempPath(), "b")))!;
        Assert.Equal(3, roots.Count);
        Assert.Throws<XifRefusal>(() => XifPaths.Roots(["relative"], null));
    }

    [Fact]
    public void APathInsideTheExtensionIsOneFolderPerSegmentWhateverTheSeparator()
    {
        Assert.Equal("/w/out/source/Source/NET/ZZHybridXifLab.cs", XifPaths.Under("/w/out/source", "Source\\NET\\ZZHybridXifLab.cs", '/'));
        Assert.Equal("/w/out/source/Source/NET/Sub/A.cs", XifPaths.Under("/w/out/source/", "Source\\NET/Sub\\A.cs", '/'));
        Assert.Equal(Path.Combine("w", "Source", "NET", "A.cs"), XifPaths.Under("w", "Source\\NET\\A.cs"));
        Assert.Throws<XifRefusal>(() => XifPaths.Under("/w", "Source\\..\\..\\x.cs", '/'));
        Assert.Throws<XifRefusal>(() => XifPaths.Under("/w", "C:\\x.cs", '/'));
    }

    [Fact]
    public void TheStubsOfTheEnvironmentUnzipIntoFoldersNotIntoNamesWithSeparators()
    {
        var dir = Temp("zip");
        try
        {
            var zip = Path.Combine(dir, "stubs.zip");
            using (var archive = ZipFile.Open(zip, ZipArchiveMode.Create))
            {
                using var writer = new StreamWriter(archive.CreateEntry("Source/NET/ZZHybridXifLab.cs").Open());
                writer.Write("// stub");
            }
            var found = XifBuild.Unzip(zip, Path.Combine(dir, "out"), _ => true);
            var (relative, file) = Assert.Single(found);
            Assert.Equal("Source\\NET\\ZZHybridXifLab.cs", relative);
            Assert.Equal(Path.Combine(dir, "out", "Source", "NET", "ZZHybridXifLab.cs"), file);
            Assert.Equal("ZZHybridXifLab.cs", Path.GetFileName(file));
        }
        finally { Directory.Delete(dir, true); }
    }
}
