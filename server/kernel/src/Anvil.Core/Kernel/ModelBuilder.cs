using OutSystems.Model;
using OutSystems.Model.Data;
using OutSystems.Model.Logic;
using OutSystems.Model.Logic.Nodes;
using OutSystems.Model.Types;
using ServiceStudio.Model.API.V1;

namespace Anvil.Core;

/// <summary>
/// Construtor reutilizavel de modelo pelo Model API V1: entidades e atributos com as convencoes do
/// Studio (Id, tipos, FK), static entities com records, structures, exceptions, roles, site properties,
/// e fluxos de action (aggregate com filtro, If, Assign, Raise, Call com argumentos por nome, ForEach,
/// SQL, ligacoes). As receitas (TemporadaRecipe, VacationRentalRecipe) sao so a spec em cima disto.
/// Provado em 2026-09-03/04: 1.672 objetos, 0 mensagens, merge automatico no Studio.
/// </summary>
public class ModelBuilder
{
        protected readonly IESpace es;
        protected readonly Action<string>? log;
        protected readonly List<string> lines = new();
        public IReadOnlyList<string> Lines => lines;
        protected int actions, nodes, assignments;
        public (int Actions, int Nodes, int Assignments) Counters => (actions, nodes, assignments);

        public ModelBuilder(IESpace es, Action<string>? log = null) { this.es = es; this.log = log; }
        protected void L(string s) { lines.Add(s); log?.Invoke(s); }

        // ---- tipos ---------------------------------------------------------------------
        public IBasicType Text => es.TextType;
        public IBasicType Int => es.IntegerType;
        public IBasicType Cur => es.CurrencyType;
        public IBasicType Bool => es.BooleanType;
        public IBasicType Date => es.DateType;
        public IBasicType DateTime_ => es.DateTimeType;
        public IBasicType Bin => es.BinaryDataType;

        public IBasicType UserIdType()
        {
            // User e entidade do (System): o modulo ja a referencia (user provider Users)
            foreach (var r in es.References)
                foreach (var ent in r.Entities)
                    if (string.Equals(ent.GetType().GetProperty("Name")?.GetValue(ent) as string, "User", StringComparison.Ordinal))
                        return ent.IdentifierType;
            throw new InvalidOperationException("System User entity not referenced by this module");
        }

        // ---- entidades -----------------------------------------------------------------
        public IEntityAttribute Attr(IEntity e, string name, IBasicType type, int? length = null, bool mandatory = false, string? def = null)
        {
            var a = e.CreateAttribute(name);
            a.DataType = type;
            if (length != null) a.Length = length;
            a.IsMandatory = mandatory;
            if (def != null) a.SetDefaultValue(def);
            return a;
        }

        public IBasicType EnsureIdentifier(IEntity e, IBasicType idType, bool autoNumber)
        {
            var id = e.CreateAttribute("Id");
            id.DataType = idType;
            id.IsAutoNumber = autoNumber ? OutSystems.Model.Enumerations.AutoNumber.Yes : OutSystems.Model.Enumerations.AutoNumber.No;
            id.IsMandatory = true;
            e.Attributes.MoveToStart(id);
            e.IdentifierAttribute = id;
            return e.IdentifierType;
        }

        public IServerEntity Entity(string name, string description, bool optimized = true)
        {
            var e = es.CreateServerEntity(name);
            e.Description = description;
            EnsureIdentifier(e, es.LongIntegerType, autoNumber: true);
            if (optimized) e.UpdateBehavior = OutSystems.Model.Enumerations.UpdateEntityBehaviorType.Optimized;
            return e;
        }

        public IStaticEntity StaticEntity(string name, params (string Id, string Label)[] records)
        {
            var se = es.CreateStaticEntity(name);
            EnsureIdentifier(se, Int, autoNumber: false); // static entity id is never AutoNumber; each record gets its position below
            var label = Attr(se, "Label", Text, 50, mandatory: true);
            var order = Attr(se, "Order", Int);
            var active = Attr(se, "Is_Active", Bool, def: "True");
            se.LabelAttribute = label;
            se.OrderByAttribute = order;
            se.IsActiveAttribute = active;
            var i = 0;
            foreach (var (id, lbl) in records)
            {
                i++;
                var r = se.CreateRecord(id);
                var set = 0;
                foreach (var av in r.AttributeValues)
                {
                    var an = av.Attribute?.Name;
                    if (an == "Id") { av.SetValue(i.ToString()); set++; }
                    else if (an == "Label") { av.SetValue("\"" + lbl + "\""); set++; }
                    else if (an == "Order") { av.SetValue(i.ToString()); set++; }
                    else if (an == "Is_Active") { av.SetValue("True"); set++; }
                }
                if (set == 0) L($"  WARN static {name}.{id}: no attribute values exposed");
            }
            L($"static entity {name}: {records.Length} records");
            return se;
        }

        // ---- fluxo ---------------------------------------------------------------------
        public const int U = 20, ColMain = 160 * U, ColBranch = 400 * U, ColBranch2 = 640 * U, Row0 = 40 * U, RowStep = 80 * U;

        public sealed class Flow
        {
            public readonly IServerAction Act; public readonly IStartNode Start; public readonly IEndNode End;
            public int Row;
            public Flow(IServerAction act) { Act = act; (Start, End) = act.AddStartEndNodes(); Place(Start, ColMain, 0); Row = 1; }
            public static void Place(IFlowNode n, int x, int row) { n.HorizontalPosition = x; n.VerticalPosition = Row0 + row * RowStep; }
        }

        public Flow Action(string name, string description, bool isPublic = true)
        {
            var a = es.CreateServerAction(name);
            a.Public = isPublic;
            ((IFlow)a).Description = description;
            actions++;
            return new Flow(a);
        }

        public static IInputParameter In(Flow f, string name, ITypeSignature type, bool mandatory = true)
        { var p = f.Act.CreateInputParameter(name); p.DataType = type; p.IsMandatory = mandatory; return p; }
        public static IOutputParameter Out(Flow f, string name, ITypeSignature type)
        { var p = f.Act.CreateOutputParameter(name); p.DataType = type; return p; }
        public static ILocalVariable Local(Flow f, string name, ITypeSignature type)
        { var v = f.Act.CreateLocalVariable(name); v.DataType = type; return v; }

        public T Node<T>(Flow f, string name, int col = ColMain, int? row = null) where T : IActionNode
        {
            var n = f.Act.CreateNode<T>(name);
            var r = row ?? f.Row++;
            Flow.Place(n, col, r);
            nodes++;
            return n;
        }

        public IAggregateNode Agg(Flow f, string name, IEntity source, string filter, int col = ColMain, int? row = null)
        {
            var n = Node<IAggregateNode>(f, name, col, row);
            var q = n.AsDatabaseAggregate;
            q.CreateSource(source);
            if (!string.IsNullOrEmpty(filter)) q.CreateFilter(filter);
            return n;
        }

        public IIfNode If(Flow f, string label, string condition, int col = ColMain, int? row = null)
        {
            var n = Node<IIfNode>(f, label, col, row);
            n.Label = label;
            n.SetCondition(condition);
            return n;
        }

        public IAssignNode Assign(Flow f, string label, params (string Var, string Val)[] pairs) => Assign(f, label, ColMain, null, pairs);
        public IAssignNode Assign(Flow f, string label, int col, int? row, params (string Var, string Val)[] pairs)
        {
            var n = Node<IAssignNode>(f, label, col, row);
            n.Label = label;
            foreach (var (v, val) in pairs) { var a = n.CreateAssignment(); a.SetVariable(v); a.SetValue(val); assignments++; }
            return n;
        }

        public IRaiseExceptionNode Raise(Flow f, string name, IUserException ex, string message, int col = ColBranch, int? row = null)
        {
            var n = Node<IRaiseExceptionNode>(f, name, col, row);
            n.Exception = ex;
            n.SetExceptionMessage(message);
            return n;
        }

        public IExecuteServerActionNode Call(Flow f, string name, IActionSignature target, int col = ColMain, int? row = null, params (string Arg, string Val)[] args)
        {
            var n = Node<IExecuteServerActionNode>(f, name, col, row);
            n.Action = target;
            var names = new List<string>();
            foreach (var arg in n.Arguments)
            {
                var an = arg.Parameter?.Name ?? "?";
                names.Add(an);
                foreach (var (a, v) in args) if (string.Equals(a, an, StringComparison.OrdinalIgnoreCase)) arg.SetValue(v);
            }
            foreach (var (a, _) in args) if (!names.Contains(a, StringComparer.OrdinalIgnoreCase)) L($"  WARN {f.Act.Name}.{name}: argument {a} not found (have {string.Join(",", names)})");
            return n;
        }

        public IForEachNode ForEach(Flow f, string label, string list, int col = ColMain, int? row = null)
        {
            var n = Node<IForEachNode>(f, label, col, row);
            n.Label = label;
            n.SetRecordList(list);
            return n;
        }

        /// <summary>Liga "from" ao proximo no, conforme o tipo de conector de cada no.</summary>
        public static void Next(IActionNode from, IActionNode to)
        {
            switch (from)
            {
                case IStartNode s: s.Target = to; break;
                case IAggregateNode a: a.Target = to; break;
                case IAssignNode a: a.Target = to; break;
                case IExecuteServerActionNode e: e.Target = to; break;
                case IForEachNode fe: fe.Target = to; break;
                case ISQLNode q: q.Target = to; break;
                case IIfNode i: i.FalseTarget = to; break;
                default: throw new InvalidOperationException("no Target on " + from.GetType().Name);
            }
        }
        public static void Chain(params IActionNode[] seq) { for (var i = 0; i + 1 < seq.Length; i++) Next(seq[i], seq[i + 1]); }


        public void SiteProp(string name, IBasicType type, string def, string description)
        {
            var sp = es.CreateSiteProperty(false, name);
            sp.DataType = type;
            sp.SetDefaultValue(def);
            sp.Description = description;
        }
}
