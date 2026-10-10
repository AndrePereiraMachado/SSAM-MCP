namespace Anvil.Core;

/// <summary>The engine found no clear grid cell for a vertex. The graph is valid;
/// callers keep the flow's current geometry and report the refusal.</summary>
public sealed class FlowLayoutRefusedException(string message) : InvalidOperationException(message);

/// <summary>Geometry only. Removes DFS loop-back edges for ranking, never from the native graph.
/// Joins wait for all forward predecessors; side lanes are reserved until their region ends.</summary>
public static class FlowGraphLayout
{
    public sealed record Vertex(int[] Targets, int? Main = null, bool Terminal = false, bool Handler = false);
    public sealed record Cell(int Row, int Column);

    public static Cell[] Arrange(IReadOnlyList<Vertex> graph, int start)
    {
        var count = graph.Count;
        var state = new int[count];
        var order = new List<int>();
        var forward = Enumerable.Range(0, count).Select(_ => new List<int>()).ToArray();
        var backs = new List<(int From, int To)>();
        void Visit(int n)
        {
            state[n] = 1;
            foreach (var next in graph[n].Targets.Distinct())
            {
                if (next < 0 || next >= count) throw new ArgumentException("Flow edge outside graph");
                if (state[next] == 1) { backs.Add((n, next)); continue; }
                forward[n].Add(next);
                if (state[next] == 0) Visit(next);
            }
            state[n] = 2; order.Add(n);
        }
        // Separate roots (exception handlers/comments) follow the normal flow.
        var roots = new[] { start }.Concat(Enumerable.Range(0, count).Where(n => n != start));
        var sorted = new List<int>();
        foreach (var root in roots)
            if (state[root] == 0)
            {
                order.Clear(); Visit(root); order.Reverse(); sorted.AddRange(order);
            }
        // A disconnected entry may point into the main graph. A stable Kahn pass orders it correctly.
        var incoming = Enumerable.Range(0, count).Select(_ => new List<int>()).ToArray();
        foreach (var n in sorted) foreach (var t in forward[n]) incoming[t].Add(n);
        var priority = sorted.Select((n, i) => (n, i)).ToDictionary(x => x.n, x => x.i);
        var degrees = incoming.Select(p => p.Count).ToArray();
        var ready = new PriorityQueue<int, int>();
        foreach (var n in sorted.Where(n => degrees[n] == 0)) ready.Enqueue(n, priority[n]);
        sorted.Clear();
        while (ready.TryDequeue(out var n, out _))
        {
            sorted.Add(n);
            foreach (var t in forward[n]) if (--degrees[t] == 0) ready.Enqueue(t, priority[t]);
        }
        var rank = sorted.Select((n, i) => (n, i)).ToDictionary(x => x.n, x => x.i);
        var reachable = Enumerable.Range(0, count).Select(_ => new HashSet<int>()).ToArray();
        foreach (var n in sorted.AsEnumerable().Reverse())
            foreach (var t in forward[n])
            {
                reachable[n].Add(t); reachable[n].UnionWith(reachable[t]);
            }
        var main = new int?[count];
        foreach (var n in sorted)
        {
            // A while's cycle must not become the downward continuation just because it is longer.
            var latches = backs.Where(e => e.To == n).Select(e => e.From).ToArray();
            var exits = forward[n].Where(t => !latches.Any(l => t == l || reachable[t].Contains(l))).ToList();
            var choices = latches.Length > 0 && exits.Count > 0 ? exits : forward[n];
            // A direct successor reached by every other branch is the shared
            // continuation, not an empty competing body. Keep that continuation
            // vertical and place optional work beside it. Otherwise a chain of
            // optional assignments drifts one column right at every join.
            // Terminal alternatives still use branch size; loop exits retain
            // their explicit priority.
            bool IsOptionalRegion(int target)
            {
                if (graph[target].Terminal || graph[target].Targets.Length == 0 ||
                    !choices.Where(other => other != target).All(other => reachable[other].Contains(target))) return false;
                var region = choices.Where(other => other != target)
                    .SelectMany(other => reachable[other].Append(other))
                    .Where(v => v != target && !reachable[target].Contains(v)).ToHashSet();
                // A structured side region has one entry and rejoins at the
                // continuation. Arbitrary cross-links need the general layout;
                // they must not be mistaken for an optional branch.
                return region.Count > 0 && region.All(v =>
                    incoming[v].All(parent => parent == n || region.Contains(parent)) &&
                    forward[v].All(next => next == target || region.Contains(next)));
            }
            var continuation = latches.Length == 0 && choices.Count > 1
                ? choices.Where(IsOptionalRegion)
                    .Cast<int?>().FirstOrDefault()
                : null;
            // With two real branch bodies, the larger exclusive body is vertical.
            int BranchSize(int target)
            {
                var shared = choices.Where(t => t != target)
                    .SelectMany(t => reachable[t].Append(t)).ToHashSet();
                return reachable[target].Append(target).Count(t => !shared.Contains(t));
            }
            main[n] = graph[n].Main is int preferred &&
                (choices.Contains(preferred) || backs.Contains((n, preferred))) ? preferred
                : continuation ?? choices.OrderByDescending(BranchSize).Cast<int?>().FirstOrDefault();
        }
        // A linear, exclusive side branch ending in End/Raise is an early exit.
        // Keep its whole chain on the decision's row, one standard cell per node.
        // Recognize the topology, not labels or action names. Shared tails, loops,
        // nested decisions and optional bodies that rejoin use the general layout.
        var horizontalParent = new int?[count];
        foreach (var decision in sorted.Where(n => forward[n].Count == 2 &&
                     graph[n].Main is null && !backs.Any(e => e.To == n)))
        {
            foreach (var side in forward[decision].Where(t => main[decision] != t))
            {
                var chain = new List<(int Node, int Parent)>();
                var parent = decision;
                var node = side;
                while (!graph[node].Handler && incoming[node].Count == 1 &&
                       incoming[node][0] == parent && !backs.Any(e => e.To == node || e.From == node))
                {
                    chain.Add((node, parent));
                    if (graph[node].Terminal && graph[node].Targets.Length == 0)
                    {
                        foreach (var item in chain) horizontalParent[item.Node] = item.Parent;
                        break;
                    }
                    if (forward[node].Count != 1) break;
                    parent = node;
                    node = forward[node][0];
                }
            }
        }
        // Recompute scheduling after deciding which edge is the continuation.
        // Conditional bodies (including an entire loop body) must be positioned
        // before their continuation can reuse the side columns.
        var arrangedSeen = new bool[count];
        var arrangedPriority = new List<int>();
        void Schedule(int n)
        {
            if (arrangedSeen[n]) return;
            arrangedSeen[n] = true;
            foreach (var t in forward[n].OrderBy(t => main[n] == t ? 0 : 1)) Schedule(t);
            order.Add(n);
        }
        foreach (var root in roots)
            if (!arrangedSeen[root]) { order.Clear(); Schedule(root); order.Reverse(); arrangedPriority.AddRange(order); }
        priority = arrangedPriority.Select((n,i)=>(n,i)).ToDictionary(x=>x.n,x=>x.i);
        degrees = incoming.Select(p=>p.Count).ToArray();
        ready.Clear();
        foreach(var n in arrangedPriority.Where(n=>degrees[n]==0)) ready.Enqueue(n,priority[n]);
        sorted.Clear();
        while(ready.TryDequeue(out var n,out _))
        {
            sorted.Add(n);
            foreach(var t in forward[n]) if(--degrees[t]==0) ready.Enqueue(t,priority[t]);
        }
        rank = sorted.Select((n,i)=>(n,i)).ToDictionary(x=>x.n,x=>x.i);
        var cells = new Cell[count];
        var occupied = new HashSet<(int Row, int Column)>();
        var placed = new List<int>();
        var placedEdges = new HashSet<(int From, int To)>();
        var allIncoming = Enumerable.Range(0,count).Select(_=>new List<int>()).ToArray();
        for(var from=0;from<count;from++)
            foreach(var to in graph[from].Targets.Distinct()) allIncoming[to].Add(from);
        var reservations = new List<(int Column, int Until)>();
        var bottom = -2;
        foreach (var n in sorted)
        {
            var index = rank[n];
            reservations.RemoveAll(r => r.Until < index);
            var parents = incoming[n];
            var reservationIndex = -1;
            int column, row;
            if (parents.Count == 0)
            {
                // Handler entries are independent roots. Start them beside the
                // complete main flow, at the same height as its Start node.
                column = graph[n].Handler && n != start && placed.Count > 0
                    ? placed.Max(p => cells[p].Column) + 1 : 0;
                row = graph[n].Handler ? 0 : bottom + 2;
            }
            else
            {
                column = parents.Min(p => cells[p].Column);
                if (parents.Count == 1 && main[parents[0]] != n)
                {
                    var p = parents[0]; column = cells[p].Column + 1;
                    while (reservations.Any(r => r.Column == column) || placed.Any(q => cells[q].Column == column && cells[q].Row >= cells[p].Row)) column++;
                    // Only this branch's exclusive nodes occupy its lane; reuse it after reconvergence.
                    var siblings = forward[p].Where(t => t != n).ToArray();
                    var shared = new HashSet<int>(siblings.SelectMany(t => reachable[t].Append(t)));
                    var exclusive = reachable[n].Append(n).Where(t=>!shared.Contains(t)).ToArray();
                    // A distant shared End does not occupy a branch lane until
                    // the end of the whole action. Keep sibling entry lanes
                    // distinct, then release each lane after its own last node.
                    var until = Math.Max(exclusive.Select(t=>rank[t]).DefaultIfEmpty(index).Max(),
                        siblings.Select(t=>rank[t]).DefaultIfEmpty(index).Max());
                    reservationIndex=reservations.Count;
                    reservations.Add((column, Math.Max(index, until)));
                }
                row = parents.Max(p => cells[p].Row + (parents.Count == 1 && main[p] != n ? 0 : 1));
                // A branch starts one standard step from its decision. Only a
                // loop exit waits for its cycle body; ordinary If continuations
                // do not wait for an independent terminal branch to finish.
                foreach (var p in parents.Where(p => main[p] == n && backs.Any(e => e.To == p)))
                    foreach (var side in forward[p].Where(t => t != n && !reachable[t].Contains(n)))
                    {
                        var branch = reachable[side].Append(side).Where(t=>t!=n && !reachable[n].Contains(t)).ToArray();
                        if (branch.Length>0 && branch.All(t => rank[t] < index))
                            row = Math.Max(row, branch.Max(t => cells[t].Row) + 1);
                    }
            }
            if (horizontalParent[n] is int horizontal)
            {
                column = cells[horizontal].Column + 1;
                row = cells[horizontal].Row;
            }
            // A shared End or another join may receive a long diagonal through
            // an already placed branch. Select a nearby clear grid cell before
            // placing descendants, retaining every execution edge unchanged.
            while (occupied.Contains((row, column))) row++;
            var previousNeighbours = allIncoming[n].Concat(graph[n].Targets)
                .Distinct().Where(t=>cells[t] is not null).ToArray();
            bool Clear(int candidateRow,int candidateColumn)
            {
                if(candidateColumn<0 || occupied.Contains((candidateRow,candidateColumn))) return false;
                if(parents.Any(p=>candidateRow==cells[p].Row && candidateColumn<=cells[p].Column)) return false;
                var candidate=new Cell(candidateRow,candidateColumn);
                foreach(var other in previousNeighbours)
                    foreach(var q in placed)
                        if(q!=other && SegmentPassesNode(candidate,cells[other],cells[q])) return false;
                foreach(var (from,to) in placedEdges)
                    if(SegmentPassesNode(cells[from],cells[to],candidate)) return false;
                return true;
            }
            if(!Clear(row,column))
            {
                var initialRow=row;var initialColumn=column;var found=false;
                // Prefer a small vertical gap over widening the diagram. New
                // columns stay within one column of its existing width.
                var compactRight=Math.Max(column,placed.Count==0?0:placed.Max(p=>cells[p].Column))+1;
                // A shared terminal after nested loops may be hidden behind
                // every existing lane. Exhaust compact positions first, then
                // allow a wider clear cell instead of rejecting a valid graph.
                foreach(var right in new[]{compactRight,compactRight+count})
                {
                    for(var distance=1;distance<=2*count+1 && !found;distance++)
                        for(var dc=0;dc<=Math.Min(distance,right+initialColumn) && !found;dc++)
                            foreach(var candidateColumn in new[]{initialColumn+dc,initialColumn-dc}.Distinct())
                            {
                                var candidateRow=initialRow+distance-dc;
                                if(candidateColumn<initialColumn || candidateColumn>right || !Clear(candidateRow,candidateColumn)) continue;
                                row=candidateRow;column=candidateColumn;found=true;break;
                            }
                    if(found)break;
                }
                if(!found) throw new FlowLayoutRefusedException($"Flow layout could not find a clear grid position for vertex {n} near row {initialRow}, column {initialColumn}");
            }
            occupied.Add((row,column));
            if(reservationIndex>=0) reservations[reservationIndex]=(column,reservations[reservationIndex].Until);
            cells[n] = new Cell(row, column); bottom = Math.Max(bottom, row);
            placed.Add(n);
            foreach(var from in allIncoming[n].Where(t=>cells[t] is not null)) placedEdges.Add((from,n));
            foreach(var to in graph[n].Targets.Where(t=>cells[t] is not null)) placedEdges.Add((n,to));
        }
        return cells;
    }

    private static bool SegmentPassesNode(Cell a,Cell b,Cell node)
    {
        // Native grid: 80 px per column and per row; clear the 12 px icon radius.
        var dx=(double)b.Column-a.Column;var dy=(double)b.Row-a.Row;
        var x=(double)node.Column-a.Column;var y=(double)node.Row-a.Row;
        var length=dx*dx+dy*dy;if(length==0) return false;
        var dot=x*dx+y*dy;if(dot<=0 || dot>=length) return false;
        var cross=x*dy-y*dx;
        return cross*cross < .15*.15*length;
    }
}
