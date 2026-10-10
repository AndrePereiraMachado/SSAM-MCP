using System.Collections;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.CSharp.Tests;

public class ReferenceEntityTests
{
    private const string Entity = "using Anvil.Authoring; [Entity] public sealed class Row { public long Id { get; set; } public int Quantity { get; set; } } ";
    private static Dictionary<string, object> Rows(params Dictionary<string, object>[] rows) => new() { ["List"] = rows.Cast<object>().ToList() };
    private static Dictionary<string, object> SqlRow(params decimal[] columns) => new() {
        ["List"] = columns.Select((value, index) => (value, index)).ToDictionary(p => "AvC" + p.index, p => (object)p.value) };

    [Fact]
    public void ExplicitUpdateExportsCurrentFieldsAndRetainsCallerIdentity()
    {
        using var call = new ReferencePublicGraphTests.Call(Entity + "public static class Rules { public static Row Commit(IDataSession db, Row value) { value.Quantity++; db.Update(value); return value; } }", "Commit");
        var input = call.New("Row"); input.GetType().GetProperty("Id")!.SetValue(input, 7L);
        input.GetType().GetProperty("Quantity")!.SetValue(input, 4);
        var writes = 0;
        call.DataEffect = (operation, arguments) => {
            if (operation.ContainsKey("get")) return Rows(new Dictionary<string, object>());
            Assert.Equal("Row", operation["update"]!.ToString());
            var record = Assert.IsType<Dictionary<string, object>>(arguments["record"]);
            Assert.Equal(7m, record["Id"]); Assert.Equal(5m, record["Quantity"]); writes++;
            return new();
        };
        Assert.Same(input, call.Invoke(input)); Assert.Equal(5, call.Member(input, "Quantity")); Assert.Equal(1, writes);
    }

    [Fact]
    public void InsertReturnsAnIdentityWithoutMutatingTheSuppliedObject()
    {
        using var call = new ReferencePublicGraphTests.Call(Entity + "public static class Rules { public static Row Create(IDataSession db, Row value) { db.Insert(value); return value; } }", "Create");
        var input = call.New("Row"); var writes = 0;
        call.DataEffect = (operation, arguments) => {
            Assert.Equal("Row", operation["create"]!.ToString());
            Assert.Equal(0m, Assert.IsType<Dictionary<string, object>>(arguments["record"])["Id"]);
            writes++; return new() { ["Id"] = 71m };
        };
        Assert.Same(input, call.Invoke(input)); Assert.Equal(0L, call.Member(input, "Id")); Assert.Equal(1, writes);
    }

    [Fact]
    public void MissingQueryRowReturnsNullAndExistingZeroFieldsRemainAnObject()
    {
        using var call = new ReferencePublicGraphTests.Call(Entity + "public static class Rules { public static Row? Read(IDataSession db) => db.Query<Row>().FirstOrDefault(); }", "Read");
        call.DataEffect = (_, _) => Rows(); Assert.Null(call.Invoke());
        call.DataEffect = (_, _) => Rows(SqlRow(0, 0));
        var row = call.Invoke()!; Assert.Equal(0L, call.Member(row, "Id")); Assert.Equal(0, call.Member(row, "Quantity"));
    }

    [Fact]
    public void QueryProjectionKeepsTwoReferencesToTheSameMaterializedRow()
    {
        using var call = new ReferencePublicGraphTests.Call(Entity + "public sealed record Pair(Row Left, Row Right); public static class Rules { public static Pair Read(IDataSession db) => db.Query<Row>().Select(row => new Pair(row, row)).First(); }", "Read");
        call.DataEffect = (_, _) => Rows(SqlRow(7, 4, 7, 4));
        var pair = call.Invoke()!; var left = call.Member(pair, "Left"); var right = call.Member(pair, "Right");
        Assert.Same(left, right); Assert.Equal(7L, call.Member(left!, "Id"));
    }

    [Fact]
    public void TwoQueryEvaluationsHaveIndependentDetachedObjectIdentities()
    {
        using var call = new ReferencePublicGraphTests.Call(Entity + "public sealed record Pair(Row Left, Row Right); public static class Rules { public static Pair Read(IDataSession db) { var first = db.Query<Row>().First(); var second = db.Query<Row>().First(); first.Quantity = 9; return new Pair(first, second); } }", "Read");
        var reads = 0;
        call.DataEffect = (operation, _) => { Assert.True(operation.ContainsKey("get")); reads++; return Rows(SqlRow(7, 4)); };
        var pair = call.Invoke()!; var left = call.Member(pair, "Left"); var right = call.Member(pair, "Right");
        Assert.NotSame(left, right); Assert.Equal(9, call.Member(left!, "Quantity")); Assert.Equal(4, call.Member(right!, "Quantity")); Assert.Equal(2, reads);
    }

    [Fact]
    public void QueryListMaterializesRowsInAnIndependentMutableCollection()
    {
        using var call = new ReferencePublicGraphTests.Call(Entity + "public static class Rules { public static List<Row> Read(IDataSession db) { var rows = db.Query<Row>().ToList(); rows[0].Quantity = 9; return rows; } }", "Read");
        call.DataEffect = (_, _) => Rows(SqlRow(7, 4), SqlRow(8, 5));
        var rows = Assert.IsAssignableFrom<IList>(call.Invoke()); Assert.Equal(2, rows.Count);
        Assert.Equal(9, call.Member(rows[0]!, "Quantity")); Assert.Equal(5, call.Member(rows[1]!, "Quantity"));
    }

    [Fact]
    public void JoinReusesEachSourceObjectAcrossRowsButKeepsItsTwoSourcesDetached()
    {
        using var call = new ReferencePublicGraphTests.Call(Entity + "public sealed record Pair(Row Left, Row Right); public static class Rules { public static List<Pair> Read(IDataSession db) => db.Query<Row>().Join(db.Query<Row>(), left => left.Quantity, right => right.Quantity, (left, right) => new Pair(left, right)).OrderBy(pair => pair.Left.Id).ThenBy(pair => pair.Right.Id).ToList(); }", "Read");
        call.DataEffect = (operation, _) => {
            Assert.Contains("DENSE_RANK()", operation["statement"]!.ToString());
            return Rows(Joined(1, 1, 1, 1, 1), Joined(1, 2, 2, 1, 2), Joined(2, 1, 3, 2, 1), Joined(2, 2, 4, 2, 2));
        };
        var rows = Assert.IsAssignableFrom<IList>(call.Invoke()); Assert.Equal(4, rows.Count);
        object Member(int row, string field) => call.Member(rows[row]!, field)!;
        Assert.Same(Member(0, "Left"), Member(1, "Left")); Assert.Same(Member(2, "Left"), Member(3, "Left"));
        Assert.Same(Member(0, "Right"), Member(2, "Right")); Assert.Same(Member(1, "Right"), Member(3, "Right"));
        Assert.NotSame(Member(0, "Left"), Member(0, "Right")); Assert.NotSame(rows[0], rows[1]);
    }

    private static Dictionary<string, object> Joined(decimal left, decimal right, params decimal[] ranks)
    {
        var row = SqlRow(left, 10, right, 10);
        var fields = (Dictionary<string, object>)row["List"];
        for (var i = 0; i < ranks.Length; i++) fields.Add("AvOrigin" + i, ranks[i]);
        return row;
    }

    [Fact]
    public void CachedProjectionBeforeJoinAndItsMemberHaveTheSameIdentityOutsideTheCachedParent()
    {
        using var call = new ReferencePublicGraphTests.Call(Entity + "public sealed record Box(Row Item); public sealed record Triple(Box Before, Row Left, Row Right); public static class Rules { public static List<Triple> Read(IDataSession db) => db.Query<Row>().Select(row => new Box(row)).Join(db.Query<Row>(), box => box.Item.Quantity, row => row.Quantity, (box, row) => new Triple(box, box.Item, row)).ToList(); }", "Read");
        call.DataEffect = (_, _) => {
            Dictionary<string, object> Row(decimal right, decimal resultRank)
            {
                var row = SqlRow(1, 10, 1, 10, right, 10); var fields = (Dictionary<string, object>)row["List"];
                fields["AvOrigin0"] = resultRank; fields["AvOrigin1"] = 1m; fields["AvOrigin2"] = 1m; fields["AvOrigin3"] = right;
                return row;
            }
            return Rows(Row(1, 1), Row(2, 2));
        };
        var rows = Assert.IsAssignableFrom<IList>(call.Invoke());
        var first = call.Member(rows[0]!, "Before")!; var second = call.Member(rows[1]!, "Before")!;
        Assert.Same(first, second);
        Assert.Same(call.Member(first, "Item"), call.Member(rows[0]!, "Left"));
        Assert.Same(call.Member(second, "Item"), call.Member(rows[1]!, "Left"));
        Assert.NotSame(rows[0], rows[1]);
    }

    [Fact]
    public void AQueryEvaluatedAgainInsideALoopGetsAFreshIdentityMap()
    {
        using var call = new ReferencePublicGraphTests.Call(Entity + "public sealed record Pair(Row Left, Row Right); public static class Rules { public static List<Pair> Read(IDataSession db) { var result = new List<Pair>(); for (int i = 0; i < 2; i++) { var found = db.Query<Row>().Join(db.Query<Row>(), left => left.Quantity, right => right.Quantity, (left, right) => new Pair(left, right)).ToList(); result.Add(found[0]); } return result; } }", "Read");
        var reads = 0;
        call.DataEffect = (_, _) => { reads++; return Rows(Joined(1, 1, 1, 1, 1)); };
        var rows = Assert.IsAssignableFrom<IList>(call.Invoke()); Assert.Equal(2, rows.Count); Assert.Equal(2, reads);
        Assert.NotSame(rows[0], rows[1]); Assert.NotSame(call.Member(rows[0]!, "Left"), call.Member(rows[1]!, "Left"));
    }
}
