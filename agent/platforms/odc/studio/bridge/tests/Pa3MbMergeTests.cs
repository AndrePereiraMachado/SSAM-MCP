using System.Text.Json.Nodes;
using Xunit;

// Package 3, lane mb, C16: the equivalence gate never answers "uncertain, never repeat it" for a merge that kept only the
// rewrites the ODC Studio makes on every merge (G-1), only errors and security warnings block after the merge (G-2), and
// an uncertain merge says it is integrated (G-3). The dumps are synthetic, with the line shapes of the labs of 2026-10-06
// (18, 21, 22, 24, 30, 38): a block instance named Block1, Max. Records removed from a Data Action refresh, FontAwesome
// icons converted to Phosphor.
public class Pa3MbMergeTests {
    private static readonly IReadOnlySet<string> Owners = new HashSet<string>();
    private static readonly NativeMergeVerification.LayoutAddition[] NoAdditions = Array.Empty<NativeMergeVerification.LayoutAddition>();

    // A MatchTree dump line: a node at depth d ("|    " d-1 times, "+-- "), a property of a node at depth d ("|    " d times,
    // "|         >> "), a connector.
    private static string Node(int depth, string text) => depth == 0 ? text : string.Concat(Enumerable.Repeat("|    ", depth - 1)) + "+-- " + text;
    private static string Prop(int depth, string text) => string.Concat(Enumerable.Repeat("|    ", depth)) + "|         >> " + text;
    private static string Gap(int depth) => string.Concat(Enumerable.Repeat("|    ", depth)) + "|";

    // Lab 22's shape: the screen with a Data Action refresh, a block instance created as Block1 and an icon converted.
    private static string Dump(params string[] extra) => string.Join("\n", new[] {
        Node(0, "(Object App) Shop [DifferenceInLocalMergeUnit]"),
        Node(1, "(Folder) UI Flows"), Gap(1),
        Node(2, "(Object UI Flow) MainFlow [DifferenceInLocalMergeUnit]"), Gap(2),
        Node(3, "(Object Screen) Detail [ChangedInLocal, DifferenceInLocalChildren]"),
        Prop(3, "Screen Content[The Screen content has changed] / Screen Content[] [DifferenceInLocalChildren]"), Gap(3),
        Node(4, "(Object Client Action) AddToCart [None]"), Gap(4),
        Node(5, "(Object Refresh Data) Refresh GetCartSummary [None]"),
        Prop(5, "Max. Records[] / Max. Records[50] [RemovedFromLocal] [Not Visible]"), Gap(3),
        Node(4, "(Object Block) Layouts\\LayoutTopMenu [DifferenceInLocalChildren]"), Gap(4),
        Node(5, "(Object Placeholder Content) MainContent [DifferenceInLocalChildren]"), Gap(5),
        Node(6, "(Object Block) Tag [ChangedInLocal]"),
        Prop(6, "CustomName[] / CustomName[Block1] [RemovedFromLocal] [Not Visible]"),
        Prop(6, "CustomNameIsSuffix[True] / CustomNameIsSuffix[False] [ChangedInLocal] [Not Visible]"),
        Prop(6, "Name[Tag] / Name[Block1] [ChangedInLocal]"), Gap(5),
        Node(6, "(Object Button) AddToCartButton [DifferenceInLocalChildren]"), Gap(6),
        Node(7, "(Object CustomPlaceholderWidget) content [DifferenceInLocalChildren]"), Gap(7),
        Node(8, "(Object Icon) I2 [DifferenceInLocalChildren]"), Gap(8),
        Node(9, "(Object CustomProperty) Icon [ChangedInLocal]"),
        Prop(9, "Icon[shopping-cart] / Icon[cart-plus] [ChangedInLocal]"), Gap(8),
        Node(9, "(Object CustomProperty) Weight [ChangedInLocal]"),
        Prop(9, "Weight[fill] / Weight[regular] [ChangedInLocal]"),
    }.Concat(extra));

    // The Studio's FontAwesome4.0 -> Phosphor2.0 entries the labs met (IconLibraryProvider.GetIconConversionMapping).
    private static readonly Dictionary<string, (string Icon, string Weight)> Table = new() {
        ["cart-plus"] = ("shopping-cart", "fill"), ["shopping-cart"] = ("shopping-cart-simple", "fill"), ["times"] = ("x", ""), ["caret-right"] = ("caret-right", "fill"),
    };
    private static readonly NativeMergeVerification.IconChange[] I2 = { new("I2", "cart-plus", "regular", "shopping-cart", "fill") };

    [Fact]
    public void TheThreeRewritesOfTheLabsAreNamedAndExcused() {
        var dump = Dump();
        var named = NativeMergeVerification.Normalizations(dump, I2);
        Assert.Equal(new[] { NativeMergeVerification.CustomNameTrio, NativeMergeVerification.IconConversion, NativeMergeVerification.RefreshMaxRecordsRemoved },
            named.Select(n => n.Kind).Order(StringComparer.Ordinal).ToArray());
        var trio = named.Single(n => n.Kind == NativeMergeVerification.CustomNameTrio);
        Assert.Equal(("Tag", "Block1"), (trio.Local, trio.Candidate));
        Assert.Equal("shopping-cart/fill", named.Single(n => n.Kind == NativeMergeVerification.IconConversion).Local);
        Assert.All(named, n => Assert.Contains(n.Kind, NativeMergeVerification.Rewrites));
        NativeMergeVerification.Validate(dump, NoAdditions, Owners, normalizations: named, icons: I2);
        // Without them, the same dump is the strict refusal of today.
        Assert.Throws<InvalidOperationException>(() => NativeMergeVerification.Validate(dump, NoAdditions, Owners));
    }

    [Fact]
    public void AnyOtherDifferenceKeepsTheRefusal() {
        var dump = Dump(Gap(5), Node(6, "(Object Container) Box [ChangedInLocal]"), Prop(6, "Style[card] / Style[card-big] [ChangedInLocal]"));
        var named = NativeMergeVerification.Normalizations(dump, I2);
        var refused = Assert.Throws<InvalidOperationException>(() => NativeMergeVerification.Validate(dump, NoAdditions, Owners, normalizations: named, icons: I2));
        Assert.Contains("Box", refused.Message);
    }

    [Fact]
    public void AnIconChangeTheModelsDoNotProveIsNotExcused() {
        var dump = Dump();
        // No proof, or a proof of another change of that widget: the icon lines stay a difference.
        foreach (var icons in new[] { Array.Empty<NativeMergeVerification.IconChange>(), new NativeMergeVerification.IconChange[] { new("I2", "times", "regular", "x", "regular") } }) {
            var named = NativeMergeVerification.Normalizations(dump, icons);
            Assert.DoesNotContain(named, n => n.Kind == NativeMergeVerification.IconConversion);
            Assert.Throws<InvalidOperationException>(() => NativeMergeVerification.Validate(dump, NoAdditions, Owners, normalizations: named, icons: icons));
        }
    }

    [Fact]
    public void ABlockRenamedToAnotherNameIsNotTheTrio() {
        var dump = Dump().Replace("Name[Tag] / Name[Block1]", "Name[Other] / Name[Block1]");
        Assert.DoesNotContain(NativeMergeVerification.Normalizations(dump, I2), n => n.Kind == NativeMergeVerification.CustomNameTrio);
    }

    [Fact]
    public void TheConversionTableProvesOnlyTheChangesItMaps() {
        static NativeMergeVerification.IconFact F(string key, string name, string icon, string weight) => new(key, name, icon, weight);
        var expected = new[] { F("k1", "I2", "cart-plus", "regular"), F("k2", "I3", "times", "regular"), F("k3", "I4", "caret-right", "regular"),
            F("k4", "I5", "heart", "regular"), F("k5", "I6", "cart-plus", "regular") };
        var live = new[] { F("k1", "I2", "shopping-cart", "fill"), F("k2", "I3", "x", "regular"), F("k3", "I4", "caret-right", "fill"),
            F("k4", "I5", "star", "regular"), F("k5", "I6", "shopping-cart", "regular") };
        var proven = NativeMergeVerification.ProveIconConversions(live, expected, Table);
        Assert.Equal(new[] { "I2", "I3", "I4" }, proven.Select(p => p.Name).ToArray());   // heart is not in the table; I6 has the wrong weight
        // Lab 24: an icon whose table weight is empty keeps its weight; the dump has only the Icon line.
        var lab24 = string.Join("\n", Node(0, "(Object App) Shop [DifferenceInLocalMergeUnit]"), Node(1, "(Object Icon) I3 [DifferenceInLocalChildren]"), Gap(1),
            Node(2, "(Object CustomProperty) Icon [ChangedInLocal]"), Prop(2, "Icon[x] / Icon[times] [ChangedInLocal]"));
        var named = NativeMergeVerification.Normalizations(lab24, proven);
        NativeMergeVerification.Validate(lab24, NoAdditions, Owners, normalizations: named, icons: proven);
        // Lab 30: only the weight changed (caret-right keeps its name).
        var lab30 = string.Join("\n", Node(0, "(Object App) Shop [DifferenceInLocalMergeUnit]"), Node(1, "(Object Icon) I4 [DifferenceInLocalChildren]"), Gap(1),
            Node(2, "(Object CustomProperty) Weight [ChangedInLocal]"), Prop(2, "Weight[fill] / Weight[regular] [ChangedInLocal]"));
        NativeMergeVerification.Validate(lab30, NoAdditions, Owners, normalizations: NativeMergeVerification.Normalizations(lab30, proven), icons: proven);
    }

    [Fact]
    public void AWidgetUnderRekeyedWrappersIsTheSameWidget() {
        // Offline replay of labs 22 and 24 (2026-10-06): the merge re-keys the property-owned wrappers above an icon in a
        // button's content (PlaceholderArguments, ChildPlaceholders); the widget keeps its own key, the last segment.
        static NativeMergeVerification.IconFact F(string key, string icon, string weight) => new(key, "I2", icon, weight);
        const string Screen = "/NRWebFlows.f1/NodesShownInESpaceTree.s1/Widgets.w1/PlaceholderArguments.";
        var expected = new[] { F(Screen + "Pt6X29bFA0Cc/ChildWidgets.vUvl/ChildPlaceholders.1BS0t45Pc/ChildWidgets.DTjkum73A0C5", "cart-plus", "regular") };
        var live = new[] { F(Screen + "GTB5NHoAjkSb/ChildWidgets.vUvl/ChildPlaceholders.BfvRuLt4P/ChildWidgets.DTjkum73A0C5", "shopping-cart", "fill") };
        var proven = NativeMergeVerification.ProveIconConversions(live, expected, Table);
        Assert.Equal("I2: cart-plus/regular -> shopping-cart/fill", string.Join(",", proven.Select(p => $"{p.Name}: {p.FromIcon}/{p.FromWeight} -> {p.ToIcon}/{p.ToWeight}")));
        NativeMergeVerification.Validate(Dump(), NoAdditions, Owners, normalizations: NativeMergeVerification.Normalizations(Dump(), proven), icons: proven);
        // Another widget (another own key) is never the proof.
        var other = new[] { F(Screen + "GTB5NHoAjkSb/ChildWidgets.vUvl/ChildPlaceholders.BfvRuLt4P/ChildWidgets.Zz9OtherKey00", "shopping-cart", "fill") };
        Assert.Empty(NativeMergeVerification.ProveIconConversions(other, expected, Table));
    }

    [Fact]
    public void OnlyErrorsAndSecurityWarningsBlockAfterTheMerge() {
        static JsonObject M(string type, string id) => new() { ["type"] = type, ["id"] = id, ["message"] = "m", ["detail"] = "" };
        Assert.False(MergeDiagnostics.BlocksAfterMerge(M("Warning", "UnusedVariable")));
        Assert.False(MergeDiagnostics.BlocksAfterMerge(M("Warning", "MaxRecordsInAggregate")));
        Assert.True(MergeDiagnostics.BlocksAfterMerge(M("Warning", "SQLInjection")));
        Assert.True(MergeDiagnostics.BlocksAfterMerge(M("Error", "AnyError")));
    }

    [Fact]
    public void AnUncertainMergeNeverSaysNeverRepeatWithoutSayingItIsIntegrated() {
        var text = MergeDiagnostics.UncertainMessage("Native property differs from the candidate",
            new[] { new NativeMergeVerification.Divergence("MainFlow/Detail/Box", "Container", "Style", "card", "card-big") });
        Assert.Contains("already integrated", text);
        Assert.Contains("never repeat", text);
    }

    [Fact]
    public void ATemplateIsReusedOnlyForTheSameRevisionAndBytes() {
        var dir = Path.Combine(Path.GetTempPath(), "pa3mb-templates-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        try {
            var bytes = System.Text.Encoding.UTF8.GetBytes("template bytes");
            var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes));
            File.WriteAllBytes(Path.Combine(dir, "Key-r7-" + hash[..12] + ".oml"), bytes);
            Assert.NotNull(TemplateCache.Kept("7-" + hash[..12].ToLowerInvariant(), "7", dir, "Key-r7-"));
            Assert.Null(TemplateCache.Kept("6-" + hash[..12], "7", dir, "Key-r7-"));          // the tenant has a newer revision
            Assert.Null(TemplateCache.Kept("7-000000000000", "7", dir, "Key-r7-"));            // other bytes
            Assert.Null(TemplateCache.Kept(null, "7", dir, "Key-r7-"));
            File.WriteAllBytes(Path.Combine(dir, "Key-r7-" + hash[..12] + ".oml"), new byte[] { 1, 2, 3 });
            Assert.Null(TemplateCache.Kept("7-" + hash[..12], "7", dir, "Key-r7-"));            // the kept file changed on disk
        } finally { Directory.Delete(dir, true); }
    }
}
