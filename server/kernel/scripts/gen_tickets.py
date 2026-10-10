"""Gera os jobs do app de tickets (data model + 40 server actions + timers + service actions) em tests/jobs/tickets-0N-*.json.

python scripts/gen_tickets.py            # escreve os 8 jobs
Cada job usa como base o anterior (job:tickets-0N-...), para os testes; no SS4 aplicam-se por proof_merge, um a um.
Convencoes do modelo: docs/tasks (data model e actions de tickets, 2026-09-04). Regras: toda mutacao valida, grava, escreve TicketEvent.
"""
from __future__ import annotations

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "jobs"
FIXTURE = "tests/fixtures/blank-service.oml"

S = "Entities.TicketStatus."
P = "Entities.TicketPriority."
EV = "Entities.TicketEventType."
NOW = "CurrDateTime()"


# Expectativas revisadas do Verify; mesma spec gera os mesmos ops e contratos.
EXPECTED = {'tickets-01-data': [{'id': 'UnusedElement',
                      'element': 'Headless_CS (ESpace) / AutoCloseDays (SiteProperty)',
                      'why': 'Configuracao criada na etapa de dados; sera consumida pelas etapas posteriores '
                             'do app de tickets.'},
                     {'id': 'UnusedElement',
                      'element': 'Headless_CS (ESpace) / BlockedExtensions (SiteProperty)',
                      'why': 'Configuracao criada na etapa de dados; sera consumida pelas etapas posteriores '
                             'do app de tickets.'},
                     {'id': 'UnusedElement',
                      'element': 'Headless_CS (ESpace) / DefaultFirstResponseMinutes (SiteProperty)',
                      'why': 'Configuracao criada na etapa de dados; sera consumida pelas etapas posteriores '
                             'do app de tickets.'},
                     {'id': 'UnusedElement',
                      'element': 'Headless_CS (ESpace) / DefaultResolutionMinutes (SiteProperty)',
                      'why': 'Configuracao criada na etapa de dados; sera consumida pelas etapas posteriores '
                             'do app de tickets.'},
                     {'id': 'UnusedElement',
                      'element': 'Headless_CS (ESpace) / MaxAttachmentMB (SiteProperty)',
                      'why': 'Configuracao criada na etapa de dados; sera consumida pelas etapas posteriores '
                             'do app de tickets.'},
                     {'id': 'UnusedElement',
                      'element': 'Headless_CS (ESpace) / ReminderDays (SiteProperty)',
                      'why': 'Configuracao criada na etapa de dados; sera consumida pelas etapas posteriores '
                             'do app de tickets.'}],
 'tickets-02-helpers': [{'id': 'UnusedElement',
                         'element': 'Calendar_AddBusinessMinutes (ServerAction) / BusinessHoursOnly '
                                    '(InputParameter)',
                         'why': 'BusinessHoursOnly ainda nao e consumido pelo calculo simplificado do '
                                'calendario; limitacao explicita a tratar no passo de inputs sem uso.'},
                        {'id': 'UnusedUserAction',
                         'element': 'Headless_CS (ESpace) / Event_Write (ServerAction)',
                         'why': 'Action auxiliar privada criada nesta etapa; os consumidores sao criados nas '
                                'etapas seguintes.'},
                        {'id': 'UnusedUserAction',
                         'element': 'Headless_CS (ESpace) / Notification_Create (ServerAction)',
                         'why': 'Action auxiliar privada criada nesta etapa; os consumidores sao criados nas '
                                'etapas seguintes.'},
                        {'id': 'UnusedUserAction',
                         'element': 'Headless_CS (ESpace) / Sla_ComputeDueDates (ServerAction)',
                         'why': 'Action auxiliar privada criada nesta etapa; os consumidores sao criados nas '
                                'etapas seguintes.'},
                        {'id': 'UnusedUserAction',
                         'element': 'Headless_CS (ESpace) / Ticket_AssertAccess (ServerAction)',
                         'why': 'Action auxiliar privada criada nesta etapa; os consumidores sao criados nas '
                                'etapas seguintes.'},
                        {'id': 'UnusedUserAction',
                         'element': 'Headless_CS (ESpace) / Ticket_CanTransition (ServerAction)',
                         'why': 'Action auxiliar privada criada nesta etapa; os consumidores sao criados nas '
                                'etapas seguintes.'},
                        {'id': 'UnusedUserAction',
                         'element': 'Headless_CS (ESpace) / Ticket_NextNumber (ServerAction)',
                         'why': 'Action auxiliar privada criada nesta etapa; os consumidores sao criados nas '
                                'etapas seguintes.'}],
 'tickets-all': [{'id': 'UnusedElement',
                  'element': 'Calendar_AddBusinessMinutes (ServerAction) / BusinessHoursOnly '
                             '(InputParameter)',
                  'why': 'BusinessHoursOnly ainda nao e consumido pelo calculo simplificado do calendario; '
                         'limitacao explicita a tratar no passo de inputs sem uso.'}]}


class Job:
    def __init__(self, name: str, base: str, desc: str):
        self.name, self.base, self.desc = name, base, desc
        self.ops: list[dict] = []

    def op(self, **kw) -> dict:
        self.ops.append(kw)
        return kw

    def create(self, parent, type_, name=None, alias=None, **extra):
        d = {"op": "create", "parent": parent, "type": type_}
        if name: d["name"] = name
        if alias: d["as"] = alias
        d.update(extra)
        return self.op(**d)

    def set(self, target, prop, value):
        return self.op(op="set", target=target, prop=prop, value=value)

    def save(self):
        path = OUT / f"{self.name}.json"
        path.write_text(json.dumps({"description": self.desc, "base": self.base, "expectValid": True, "expectedMessages": EXPECTED.get(self.name, []), "ops": self.ops}, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"{path.name}: {len(self.ops)} ops")


class Act:
    """Uma action: parametros, variaveis, nos e ligacoes com aliases unicos."""

    def __init__(self, job: Job, name: str, kind: str = "IServerAction", public: bool = True, desc: str = ""):
        self.j, self.n, self.a = job, name, "$" + name
        job.create("@espace", kind, name, self.a)
        if public: job.set(self.a, "Public", True)
        if desc: job.set(self.a, "Description", desc)
        self.k = 0

    def _al(self, tag: str) -> str:
        self.k += 1
        return f"{self.a}_{tag}{self.k}"

    def inp(self, name, type_, mandatory=True):
        al = self.j.create(self.a, "IInputParameter", name, self._al("in"))["as"]
        self.j.set(al, "DataType", type_)
        if not mandatory: self.j.set(al, "IsMandatory", False)
        return al

    def out(self, name, type_):
        al = self.j.create(self.a, "IOutputParameter", name, self._al("out"))["as"]
        self.j.set(al, "DataType", type_)
        return al

    def var(self, name, type_, default=None):
        al = self.j.create(self.a, "ILocalVariable", name, self._al("var"))["as"]
        self.j.set(al, "DataType", type_)
        if default is not None: self.j.set(al, "DefaultValue", default)
        return al

    def start(self):
        return self.j.create(self.a, "IStartNode", None, self._al("start"))["as"]

    def end(self):
        return self.j.create(self.a, "IEndNode", None, self._al("end"))["as"]

    def agg(self, name, sources, filters=(), sort=None, max_records=None, start_index=None):
        al = self.j.create(self.a, "IAggregateNode", name, self._al("agg"))["as"]
        for src in sources:
            self.j.create(al, "IAliasedSource", None, None, args={"dataSource": src})
        for f in filters:
            self.j.create(al, "IFilter", None, None, args={"condition": f})
        if sort:
            attr, direction = sort
            sal = self.j.create(al, "ISort", None, self._al("sort"))["as"]
            self.j.set(sal, "Attribute", attr)
            self.j.set(sal, "SortDirection", direction)
        if max_records is not None: self.j.set(al, "MaxRecords", max_records)
        if start_index is not None: self.j.set(al, "StartIndex", start_index)
        return al

    def assign(self, name, pairs):
        al = self.j.create(self.a, "IAssignNode", name, self._al("asg"))["as"]
        self.j.set(al, "Label", name)
        for var, val in pairs:
            aal = self.j.create(al, "IAssignment", None, self._al("a"))["as"]
            self.j.set(aal, "Variable", var)
            self.j.set(aal, "Value", val)
        return al

    def call(self, name, action, args=None):
        al = self.j.create(self.a, "IExecuteServerActionNode", name, self._al("call"))["as"]
        self.j.set(al, "Action", action)
        for k, v in (args or {}).items():
            self.j.set(f"{al}/{k}", "Value", v)
        return al

    def iff(self, name, cond):
        al = self.j.create(self.a, "IIfNode", name, self._al("if"))["as"]
        self.j.set(al, "Label", name)
        self.j.set(al, "Condition", cond)
        return al

    def raise_(self, name, exc, msg):
        al = self.j.create(self.a, "IRaiseExceptionNode", name, self._al("raise"))["as"]
        self.j.set(al, "Exception", f"IUserException:{exc}")
        self.j.set(al, "ExceptionMessage", msg)
        return al

    def foreach(self, name, record_list):
        al = self.j.create(self.a, "IForEachNode", name, self._al("fe"))["as"]
        self.j.set(al, "Label", name)
        self.j.set(al, "RecordList", record_list)
        return al

    def link(self, a, b, connector=None):
        d = {"op": "link", "from": a, "to": b}
        if connector: d["connector"] = connector
        self.j.op(**d)

    def chain(self, *nodes):
        for a, b in zip(nodes, nodes[1:]):
            self.link(a, b)

    def layout(self):
        self.j.op(op="layout", target=self.a)


def entity_action(entity: str, verb: str) -> str:
    return f"IEntityActionSignature:{verb}{entity}"


def not_found(act: Act, agg: str, what: str):
    """If <agg>.List.Empty -> Raise NotFound. Devolve (if, raise)."""
    i = act.iff(f"{what}Found", f"not {agg_name(agg, act)}.List.Empty")
    r = act.raise_(f"Raise{what}NotFound", "NotFound", f'"{what} not found"')
    act.link(i, r, "FalseTarget")
    return i


def agg_name(alias: str, act: Act) -> str:
    # o nome do no e o que aparece nas expressoes; guardamos no create
    for o in act.j.ops:
        if o.get("as") == alias and o.get("op") == "create":
            return o["name"]
    raise KeyError(alias)


# ---------------------------------------------------------------------------------------------------------------------
# 01 data
# ---------------------------------------------------------------------------------------------------------------------

def job_data() -> Job:
    j = Job("tickets-01-data", FIXTURE, "Tickets: data model (14 entidades, 6 static), structures, site properties, exceptions e roles do app de tickets (warnings: site properties ainda sem uso e sugestoes de UpdateBehavior)")
    spec = {
        "static": [
            {"name": "TicketStatus", "records": [{"name": n} for n in ["New", "Open", "Pending", "Resolved", "Closed", "Cancelled"]]},
            {"name": "TicketPriority", "records": [{"name": n} for n in ["Low", "Medium", "High", "Urgent"]]},
            {"name": "TicketType", "records": [{"name": n} for n in ["Incident", "Request", "Question", "Problem"]]},
            {"name": "TicketChannel", "records": [{"name": n} for n in ["Portal", "Email", "Phone", "Chat", "API"]]},
            {"name": "TicketEventType", "records": [{"name": n} for n in ["Created", "Updated", "StatusChanged", "Assigned", "PriorityChanged", "CommentAdded", "AttachmentAdded", "Escalated", "Reopened", "Merged"]]},
            {"name": "SlaTarget", "records": [{"name": n} for n in ["FirstResponse", "Resolution"]]},
        ],
        "entities": [
            {"name": "Team", "public": True, "attributes": [
                {"name": "Name", "type": "Text", "mandatory": True, "length": 100}, {"name": "Description", "type": "Text", "length": 500},
                {"name": "Email", "type": "Email"}, {"name": "IsActive", "type": "Boolean", "default": "True"}, {"name": "ManagerId", "type": "User Identifier"}]},
            {"name": "TeamMember", "public": True, "attributes": [
                {"name": "TeamId", "type": "Team Identifier", "mandatory": True}, {"name": "UserId", "type": "User Identifier", "mandatory": True},
                {"name": "IsLead", "type": "Boolean"}, {"name": "JoinedOn", "type": "Date Time"}]},
            {"name": "Category", "public": True, "attributes": [
                {"name": "Name", "type": "Text", "mandatory": True, "length": 100}, {"name": "ParentCategoryId", "type": "Category Identifier"},
                {"name": "DefaultTeamId", "type": "Team Identifier"}, {"name": "DefaultPriorityId", "type": "TicketPriority Identifier"},
                {"name": "IsActive", "type": "Boolean", "default": "True"}]},
            {"name": "SlaPolicy", "public": True, "attributes": [
                {"name": "Name", "type": "Text", "length": 100}, {"name": "PriorityId", "type": "TicketPriority Identifier", "mandatory": True},
                {"name": "TargetId", "type": "SlaTarget Identifier", "mandatory": True}, {"name": "Minutes", "type": "Integer", "mandatory": True},
                {"name": "BusinessHoursOnly", "type": "Boolean"}, {"name": "IsActive", "type": "Boolean", "default": "True"}]},
            {"name": "Ticket", "public": True, "attributes": [
                {"name": "Number", "type": "Text", "mandatory": True, "length": 20}, {"name": "Subject", "type": "Text", "mandatory": True, "length": 200},
                {"name": "Description", "type": "Text", "length": 2000}, {"name": "StatusId", "type": "TicketStatus Identifier", "mandatory": True, "default": S + "New"},
                {"name": "PriorityId", "type": "TicketPriority Identifier", "mandatory": True, "default": P + "Medium"}, {"name": "TypeId", "type": "TicketType Identifier", "mandatory": True},
                {"name": "ChannelId", "type": "TicketChannel Identifier"}, {"name": "CategoryId", "type": "Category Identifier"}, {"name": "TeamId", "type": "Team Identifier"},
                {"name": "AssigneeId", "type": "User Identifier"}, {"name": "RequesterId", "type": "User Identifier", "mandatory": True},
                {"name": "CreatedOn", "type": "Date Time", "mandatory": True}, {"name": "CreatedBy", "type": "User Identifier"}, {"name": "UpdatedOn", "type": "Date Time"},
                {"name": "FirstResponseDueOn", "type": "Date Time"}, {"name": "ResolutionDueOn", "type": "Date Time"}, {"name": "FirstRespondedOn", "type": "Date Time"},
                {"name": "ResolvedOn", "type": "Date Time"}, {"name": "ClosedOn", "type": "Date Time"}, {"name": "IsEscalated", "type": "Boolean"},
                {"name": "SatisfactionScore", "type": "Integer"}, {"name": "ParentTicketId", "type": "Ticket Identifier"}]},
            {"name": "TicketComment", "public": True, "attributes": [
                {"name": "TicketId", "type": "Ticket Identifier", "mandatory": True}, {"name": "AuthorId", "type": "User Identifier", "mandatory": True},
                {"name": "Body", "type": "Text", "mandatory": True, "length": 4000}, {"name": "IsInternal", "type": "Boolean"},
                {"name": "CreatedOn", "type": "Date Time"}, {"name": "EditedOn", "type": "Date Time"}]},
            {"name": "TicketAttachment", "public": True, "attributes": [
                {"name": "TicketId", "type": "Ticket Identifier", "mandatory": True}, {"name": "CommentId", "type": "TicketComment Identifier"},
                {"name": "FileName", "type": "Text", "length": 255}, {"name": "MimeType", "type": "Text", "length": 100}, {"name": "SizeBytes", "type": "Long Integer"},
                {"name": "Content", "type": "Binary Data"}, {"name": "UploadedById", "type": "User Identifier"}, {"name": "UploadedOn", "type": "Date Time"}]},
            {"name": "TicketEvent", "public": True, "attributes": [
                {"name": "TicketId", "type": "Ticket Identifier", "mandatory": True}, {"name": "EventTypeId", "type": "TicketEventType Identifier", "mandatory": True},
                {"name": "ActorId", "type": "User Identifier"}, {"name": "OccurredOn", "type": "Date Time", "mandatory": True},
                {"name": "FromValue", "type": "Text", "length": 200}, {"name": "ToValue", "type": "Text", "length": 200}, {"name": "Note", "type": "Text", "length": 500}]},
            {"name": "TicketWatcher", "public": True, "attributes": [
                {"name": "TicketId", "type": "Ticket Identifier", "mandatory": True}, {"name": "UserId", "type": "User Identifier", "mandatory": True}, {"name": "AddedOn", "type": "Date Time"}]},
            {"name": "Tag", "public": True, "attributes": [
                {"name": "Name", "type": "Text", "mandatory": True, "length": 50}, {"name": "Color", "type": "Text", "length": 20}, {"name": "IsActive", "type": "Boolean", "default": "True"}]},
            {"name": "TicketTag", "public": True, "attributes": [
                {"name": "TicketId", "type": "Ticket Identifier", "mandatory": True}, {"name": "TagId", "type": "Tag Identifier", "mandatory": True}]},
            {"name": "CannedResponse", "public": True, "attributes": [
                {"name": "Title", "type": "Text", "mandatory": True, "length": 100}, {"name": "Body", "type": "Text", "length": 4000},
                {"name": "TeamId", "type": "Team Identifier"}, {"name": "IsActive", "type": "Boolean", "default": "True"}]},
            {"name": "Notification", "public": True, "attributes": [
                {"name": "UserId", "type": "User Identifier", "mandatory": True}, {"name": "TicketId", "type": "Ticket Identifier"},
                {"name": "Title", "type": "Text", "length": 200}, {"name": "Body", "type": "Text", "length": 1000}, {"name": "CreatedOn", "type": "Date Time"},
                {"name": "ReadOn", "type": "Date Time"}, {"name": "SentOn", "type": "Date Time"}, {"name": "ChannelId", "type": "TicketChannel Identifier"}]},
            {"name": "TicketSlaBreach", "public": True, "attributes": [
                {"name": "TicketId", "type": "Ticket Identifier", "mandatory": True}, {"name": "TargetId", "type": "SlaTarget Identifier", "mandatory": True},
                {"name": "DueOn", "type": "Date Time"}, {"name": "BreachedOn", "type": "Date Time"}, {"name": "NotifiedOn", "type": "Date Time"}]},
        ],
        "structures": [
            {"name": "TimelineItem", "public": True, "attributes": [
                {"name": "Kind", "type": "Text"}, {"name": "OccurredOn", "type": "Date Time"}, {"name": "ActorId", "type": "User Identifier"},
                {"name": "Text", "type": "Text"}, {"name": "IsInternal", "type": "Boolean"}]},
            {"name": "DashboardMetrics", "public": True, "attributes": [
                {"name": "OpenCount", "type": "Long Integer"}, {"name": "PendingCount", "type": "Long Integer"}, {"name": "ResolvedCount", "type": "Long Integer"},
                {"name": "ClosedCount", "type": "Long Integer"}, {"name": "UrgentCount", "type": "Long Integer"}, {"name": "SlaBreaches", "type": "Long Integer"},
                {"name": "AvgFirstResponseMinutes", "type": "Decimal"}, {"name": "AvgResolutionMinutes", "type": "Decimal"}, {"name": "Backlog", "type": "Long Integer"}]},
        ],
    }
    j.op(op="spec", data=spec)
    for ent in ["Ticket", "CannedResponse", "Notification", "TicketAttachment", "TicketComment"]:
        j.set("$" + ent, "UpdateBehavior", "Optimized")
    for name, type_, default in [("MaxAttachmentMB", "Integer", "10"), ("BlockedExtensions", "Text", '".exe,.bat,.cmd,.js"'), ("AutoCloseDays", "Integer", "7"),
                                 ("ReminderDays", "Integer", "3"), ("DefaultFirstResponseMinutes", "Integer", "480"), ("DefaultResolutionMinutes", "Integer", "2880")]:
        al = j.create("@espace", "ISiteProperty", name, "$sp_" + name)["as"]
        j.set(al, "DataType", type_)
        j.set(al, "DefaultValue", default)
    for name in ["NotFound", "NotAllowed", "InvalidTransition", "ValidationFailed"]:
        j.create("@espace", "IUserException", name, "$ex_" + name)
    for name in ["Agent", "Manager"]:
        j.create("@espace", "IRole", name, "$role_" + name)
    return j


# ---------------------------------------------------------------------------------------------------------------------
# 02 helpers (privadas)
# ---------------------------------------------------------------------------------------------------------------------

def job_helpers() -> Job:
    j = Job("tickets-02-helpers", "job:tickets-01-data", "Tickets: actions auxiliares privadas (evento, notificacao, matriz de transicao, acesso, numero, SLA, permissoes); warnings de actions privadas ainda sem uso")

    a = Act(j, "Event_Write", public=False, desc="Escreve uma linha de TicketEvent")
    for n, t in [("TicketId", "Ticket Identifier"), ("EventTypeId", "TicketEventType Identifier"), ("ActorId", "User Identifier"), ("FromValue", "Text"), ("ToValue", "Text"), ("Note", "Text")]:
        a.inp(n, t, mandatory=n in ("TicketId", "EventTypeId"))
    a.var("E", "TicketEvent")
    s = a.start()
    asg = a.assign("FillEvent", [("E.TicketId", "TicketId"), ("E.EventTypeId", "EventTypeId"), ("E.ActorId", "ActorId"), ("E.OccurredOn", NOW), ("E.FromValue", "FromValue"), ("E.ToValue", "ToValue"), ("E.Note", "Note")])
    c = a.call("CreateTicketEvent", entity_action("TicketEvent", "Create"), {"Source": "E"})
    e = a.end(); a.chain(s, asg, c, e); a.layout()

    a = Act(j, "Notification_Create", public=False, desc="Cria uma notificacao por utilizador da lista")
    a.inp("UserIds", "User Identifier List"); a.inp("TicketId", "Ticket Identifier", False); a.inp("Title", "Text"); a.inp("Body", "Text", False)
    a.var("N", "Notification")
    s = a.start(); fe = a.foreach("EachUser", "UserIds")
    asg = a.assign("FillNotification", [("N.UserId", "UserIds.Current"), ("N.TicketId", "TicketId"), ("N.Title", "Title"), ("N.Body", "Body"), ("N.CreatedOn", NOW), ("N.ChannelId", "Entities.TicketChannel.Portal")])
    c = a.call("CreateNotification", entity_action("Notification", "Create"), {"Source": "N"})
    e = a.end(); a.link(s, fe); a.link(fe, asg, "CycleTarget"); a.link(asg, c); a.link(c, fe); a.link(fe, e); a.layout()

    a = Act(j, "Ticket_CanTransition", public=False, desc="Matriz de transicoes de status")
    a.inp("FromStatusId", "TicketStatus Identifier"); a.inp("ToStatusId", "TicketStatus Identifier"); a.inp("IsManager", "Boolean")
    a.out("Allowed", "Boolean")
    s = a.start()
    cond = (f"(FromStatusId = {S}New and (ToStatusId = {S}Open or ToStatusId = {S}Cancelled)) or "
            f"(FromStatusId = {S}Open and (ToStatusId = {S}Pending or ToStatusId = {S}Resolved or ToStatusId = {S}Cancelled)) or "
            f"(FromStatusId = {S}Pending and (ToStatusId = {S}Open or ToStatusId = {S}Resolved)) or "
            f"(FromStatusId = {S}Resolved and (ToStatusId = {S}Closed or ToStatusId = {S}Open)) or "
            f"(FromStatusId = {S}Closed and ToStatusId = {S}Open and IsManager)")
    asg = a.assign("Decide", [("Allowed", cond)]); e = a.end(); a.chain(s, asg, e); a.layout()

    a = Act(j, "Ticket_NextNumber", public=False, desc="Numero legivel a partir do Id: TCK-000123")
    a.inp("TicketId", "Ticket Identifier"); a.out("Number", "Text"); a.var("L", "Long Integer")
    s = a.start(); asg = a.assign("Format", [("L", "TicketId"), ("Number", '"TCK-" + Substr("000000" + IntegerToText(LongIntegerToInteger(L)), Length("000000" + IntegerToText(LongIntegerToInteger(L))) - 6, 6)')]); e = a.end(); a.chain(s, asg, e); a.layout()

    a = Act(j, "Calendar_AddBusinessMinutes", public=False, desc="Soma minutos (versao 1: calendario corrido; horas uteis ficam para o proximo passo)")
    a.inp("StartOn", "Date Time"); a.inp("Minutes", "Integer"); a.inp("BusinessHoursOnly", "Boolean"); a.out("EndOn", "Date Time")
    s = a.start(); asg = a.assign("Add", [("EndOn", "AddMinutes(StartOn, Minutes)")]); e = a.end(); a.chain(s, asg, e); a.layout()

    a = Act(j, "Sla_ComputeDueDates", public=False, desc="Prazos de primeira resposta e resolucao pela SlaPolicy ativa da prioridade")
    a.inp("PriorityId", "TicketPriority Identifier"); a.inp("StartOn", "Date Time")
    a.out("FirstResponseDueOn", "Date Time"); a.out("ResolutionDueOn", "Date Time")
    s = a.start()
    g1 = a.agg("GetFirstPolicy", ["IServerEntity:SlaPolicy"], ["SlaPolicy.PriorityId = PriorityId", "SlaPolicy.TargetId = Entities.SlaTarget.FirstResponse", "SlaPolicy.IsActive"], max_records="1")
    g2 = a.agg("GetResolutionPolicy", ["IServerEntity:SlaPolicy"], ["SlaPolicy.PriorityId = PriorityId", "SlaPolicy.TargetId = Entities.SlaTarget.Resolution", "SlaPolicy.IsActive"], max_records="1")
    c1 = a.call("AddFirst", "IServerAction:Calendar_AddBusinessMinutes", {"StartOn": "StartOn", "Minutes": "If(GetFirstPolicy.List.Empty, Site.DefaultFirstResponseMinutes, GetFirstPolicy.List.Current.SlaPolicy.Minutes)", "BusinessHoursOnly": "not GetFirstPolicy.List.Empty and GetFirstPolicy.List.Current.SlaPolicy.BusinessHoursOnly"})
    c2 = a.call("AddResolution", "IServerAction:Calendar_AddBusinessMinutes", {"StartOn": "StartOn", "Minutes": "If(GetResolutionPolicy.List.Empty, Site.DefaultResolutionMinutes, GetResolutionPolicy.List.Current.SlaPolicy.Minutes)", "BusinessHoursOnly": "not GetResolutionPolicy.List.Empty and GetResolutionPolicy.List.Current.SlaPolicy.BusinessHoursOnly"})
    asg = a.assign("SetOutputs", [("FirstResponseDueOn", "AddFirst.EndOn"), ("ResolutionDueOn", "AddResolution.EndOn")])
    e = a.end(); a.chain(s, g1, g2, c1, c2, asg, e); a.layout()

    a = Act(j, "User_Permissions", desc="Papeis derivados de TeamMember e Team.ManagerId")
    a.inp("UserId", "User Identifier"); a.out("IsAgent", "Boolean"); a.out("IsManager", "Boolean"); a.out("TeamIds", "Team Identifier List")
    s = a.start()
    g1 = a.agg("GetMemberships", ["IServerEntity:TeamMember"], ["TeamMember.UserId = UserId"])
    g2 = a.agg("GetManaged", ["IServerEntity:Team"], ["Team.ManagerId = UserId", "Team.IsActive"], max_records="1")
    asg = a.assign("SetFlags", [("IsAgent", "not GetMemberships.List.Empty"), ("IsManager", "not GetManaged.List.Empty")])
    fe = a.foreach("EachMembership", "GetMemberships.List")
    ap = a.call("AppendTeam", "IActionSignature:ListAppend", {"List": "TeamIds", "Element": "GetMemberships.List.Current.TeamMember.TeamId"})
    e = a.end(); a.chain(s, g1, g2, asg, fe); a.link(fe, ap, "CycleTarget"); a.link(ap, fe); a.link(fe, e); a.layout()

    a = Act(j, "Ticket_AssertAccess", public=False, desc="Lanca NotAllowed se o viewer nao e requester, assignee nem membro da equipa do ticket")
    a.inp("ViewerId", "User Identifier"); a.inp("TicketId", "Ticket Identifier"); a.inp("Operation", "Text", False)
    s = a.start()
    g = a.agg("GetTicket", ["IServerEntity:Ticket"], ["Ticket.Id = TicketId"], max_records="1")
    nf = not_found(a, g, "Ticket")
    i2 = a.iff("IsOwnerOrAssignee", "GetTicket.List.Current.Ticket.RequesterId = ViewerId or GetTicket.List.Current.Ticket.AssigneeId = ViewerId")
    gm = a.agg("GetMembership", ["IServerEntity:TeamMember"], ["TeamMember.TeamId = GetTicket.List.Current.Ticket.TeamId", "TeamMember.UserId = ViewerId"], max_records="1")
    i3 = a.iff("IsTeamMember", "not GetMembership.List.Empty")
    r = a.raise_("RaiseNotAllowed", "NotAllowed", '"You cannot " + Operation + " this ticket"')
    e = a.end()
    a.chain(s, g, nf); a.link(nf, i2, "TrueTarget"); a.link(i2, e, "TrueTarget"); a.link(i2, gm, "FalseTarget"); a.chain(gm, i3); a.link(i3, e, "TrueTarget"); a.link(i3, r, "FalseTarget"); a.layout()
    return j


# ---------------------------------------------------------------------------------------------------------------------
# 03 lifecycle
# ---------------------------------------------------------------------------------------------------------------------

def get_ticket(a: Act, what="Ticket"):
    g = a.agg("GetTicket", ["IServerEntity:Ticket"], ["Ticket.Id = TicketId"], max_records="1")
    nf = not_found(a, g, what)
    return g, nf


def notify_watchers(a: Act, title: str, body: str):
    """Aggrega watchers do ticket, monta a lista e chama Notification_Create. Devolve (primeiro, ultimo)."""
    a.var("Recipients", "User Identifier List")
    gw = a.agg("GetWatchers", ["IServerEntity:TicketWatcher"], ["TicketWatcher.TicketId = TicketId"])
    fe = a.foreach("EachWatcher", "GetWatchers.List")
    ap = a.call("AppendWatcher", "IActionSignature:ListAppend", {"List": "Recipients", "Element": "GetWatchers.List.Current.TicketWatcher.UserId"})
    nc = a.call("NotifyWatchers", "IServerAction:Notification_Create", {"UserIds": "Recipients", "TicketId": "TicketId", "Title": title, "Body": body})
    a.chain(gw, fe); a.link(fe, ap, "CycleTarget"); a.link(ap, fe); a.link(fe, nc)
    return gw, nc


def job_lifecycle() -> Job:
    j = Job("tickets-03-lifecycle", "job:tickets-02-helpers", "Tickets: ciclo de vida (criar, atualizar, status, atribuir, prioridade, escalar, merge, cancelar, avaliar)")

    a = Act(j, "Ticket_Create", desc="Cria ticket com numero, equipa e prioridade da categoria, SLA, evento, watcher e notificacao a equipa")
    a.inp("Subject", "Text"); a.inp("Description", "Text", False); a.inp("TypeId", "TicketType Identifier"); a.inp("ChannelId", "TicketChannel Identifier", False)
    a.inp("CategoryId", "Category Identifier", False); a.inp("PriorityId", "TicketPriority Identifier", False); a.inp("RequesterId", "User Identifier")
    a.out("TicketId", "Ticket Identifier"); a.out("Number", "Text")
    a.var("T", "Ticket"); a.var("W", "TicketWatcher"); a.var("Recipients", "User Identifier List")
    s = a.start()
    gc = a.agg("GetCategory", ["IServerEntity:Category"], ["Category.Id = CategoryId"], max_records="1")
    v = a.iff("HasSubject", 'Trim(Subject) <> ""'); rv = a.raise_("RaiseNoSubject", "ValidationFailed", '"Subject is required"')
    fill = a.assign("FillTicket", [
        ("T.Subject", "Subject"), ("T.Description", "Description"), ("T.TypeId", "TypeId"), ("T.ChannelId", "If(ChannelId = NullIdentifier(), Entities.TicketChannel.Portal, ChannelId)"),
        ("T.CategoryId", "CategoryId"), ("T.RequesterId", "RequesterId"), ("T.CreatedBy", "RequesterId"), ("T.CreatedOn", NOW), ("T.UpdatedOn", NOW),
        ("T.StatusId", S + "New"), ("T.Number", '"TMP"'),
        ("T.PriorityId", f"If(PriorityId <> NullIdentifier(), PriorityId, If(GetCategory.List.Empty or GetCategory.List.Current.Category.DefaultPriorityId = NullIdentifier(), {P}Medium, GetCategory.List.Current.Category.DefaultPriorityId))"),
        ("T.TeamId", "If(GetCategory.List.Empty, NullIdentifier(), GetCategory.List.Current.Category.DefaultTeamId)")])
    cr = a.call("CreateTicket", entity_action("Ticket", "Create"), {"Source": "T"})
    nn = a.call("NextNumber", "IServerAction:Ticket_NextNumber", {"TicketId": "CreateTicket.Id"})
    sla = a.call("ComputeSla", "IServerAction:Sla_ComputeDueDates", {"PriorityId": "T.PriorityId", "StartOn": "T.CreatedOn"})
    upd = a.assign("SetNumberAndSla", [("T.Id", "CreateTicket.Id"), ("T.Number", "NextNumber.Number"), ("T.FirstResponseDueOn", "ComputeSla.FirstResponseDueOn"), ("T.ResolutionDueOn", "ComputeSla.ResolutionDueOn"), ("TicketId", "CreateTicket.Id"), ("Number", "NextNumber.Number")])
    up = a.call("UpdateTicket", entity_action("Ticket", "Update"), {"Source": "T"})
    ev = a.call("WriteCreated", "IServerAction:Event_Write", {"TicketId": "TicketId", "EventTypeId": EV + "Created", "ActorId": "RequesterId", "FromValue": '""', "ToValue": "Number", "Note": '""'})
    wa = a.assign("FillWatcher", [("W.TicketId", "TicketId"), ("W.UserId", "RequesterId"), ("W.AddedOn", NOW)])
    wc = a.call("CreateWatcher", entity_action("TicketWatcher", "Create"), {"Source": "W"})
    gm = a.agg("GetMembersOfTeam", ["IServerEntity:TeamMember"], ["TeamMember.TeamId = T.TeamId"])
    fe = a.foreach("EachMember", "GetMembersOfTeam.List")
    ap = a.call("AppendMember", "IActionSignature:ListAppend", {"List": "Recipients", "Element": "GetMembersOfTeam.List.Current.TeamMember.UserId"})
    nc = a.call("NotifyTeam", "IServerAction:Notification_Create", {"UserIds": "Recipients", "TicketId": "TicketId", "Title": '"New ticket " + Number', "Body": "Subject"})
    e = a.end()
    a.chain(s, v); a.link(v, rv, "FalseTarget"); a.link(v, gc, "TrueTarget")
    a.chain(gc, fill, cr, nn, sla, upd, up, ev, wa, wc, gm, fe); a.link(fe, ap, "CycleTarget"); a.link(ap, fe); a.link(fe, nc); a.link(nc, e); a.layout()

    a = Act(j, "Ticket_Update", desc="Edita campos livres; recalcula equipa se a categoria mudou e nao ha assignee")
    a.inp("TicketId", "Ticket Identifier"); a.inp("ActorId", "User Identifier"); a.inp("Subject", "Text"); a.inp("Description", "Text", False); a.inp("TypeId", "TicketType Identifier"); a.inp("CategoryId", "Category Identifier", False)
    a.var("T", "Ticket")
    s = a.start(); g, nf = get_ticket(a)
    gc = a.agg("GetCategory", ["IServerEntity:Category"], ["Category.Id = CategoryId"], max_records="1")
    fill = a.assign("Apply", [("T", "GetTicket.List.Current.Ticket"), ("T.Subject", "Subject"), ("T.Description", "Description"), ("T.TypeId", "TypeId"), ("T.CategoryId", "CategoryId"), ("T.UpdatedOn", NOW),
                              ("T.TeamId", "If(CategoryId <> GetTicket.List.Current.Ticket.CategoryId and GetTicket.List.Current.Ticket.AssigneeId = NullIdentifier() and not GetCategory.List.Empty, GetCategory.List.Current.Category.DefaultTeamId, GetTicket.List.Current.Ticket.TeamId)")])
    up = a.call("UpdateTicket", entity_action("Ticket", "Update"), {"Source": "T"})
    ev = a.call("WriteUpdated", "IServerAction:Event_Write", {"TicketId": "TicketId", "EventTypeId": EV + "Updated", "ActorId": "ActorId", "FromValue": "GetTicket.List.Current.Ticket.Subject", "ToValue": "Subject", "Note": '""'})
    e = a.end(); a.chain(s, g, nf); a.link(nf, gc, "TrueTarget"); a.chain(gc, fill, up, ev, e); a.layout()

    a = Act(j, "Ticket_ChangeStatus", desc="Transicao validada pela matriz; datas de resolucao/fecho; evento; notificacao a requester e watchers")
    a.inp("TicketId", "Ticket Identifier"); a.inp("NewStatusId", "TicketStatus Identifier"); a.inp("ActorId", "User Identifier", False); a.inp("Note", "Text", False)
    a.var("T", "Ticket"); a.var("OldStatusId", "TicketStatus Identifier")
    s = a.start(); g, nf = get_ticket(a)
    pm = a.call("Permissions", "IServerAction:User_Permissions", {"UserId": "ActorId"})
    ct = a.call("CanTransition", "IServerAction:Ticket_CanTransition", {"FromStatusId": "GetTicket.List.Current.Ticket.StatusId", "ToStatusId": "NewStatusId", "IsManager": "Permissions.IsManager"})
    ok = a.iff("Allowed", "CanTransition.Allowed"); ri = a.raise_("RaiseInvalid", "InvalidTransition", '"Transition not allowed"')
    fill = a.assign("Apply", [("OldStatusId", "GetTicket.List.Current.Ticket.StatusId"), ("T", "GetTicket.List.Current.Ticket"), ("T.StatusId", "NewStatusId"), ("T.UpdatedOn", NOW),
                              ("T.ResolvedOn", f"If(NewStatusId = {S}Resolved, {NOW}, GetTicket.List.Current.Ticket.ResolvedOn)"),
                              ("T.ClosedOn", f"If(NewStatusId = {S}Closed, {NOW}, GetTicket.List.Current.Ticket.ClosedOn)")])
    up = a.call("UpdateTicket", entity_action("Ticket", "Update"), {"Source": "T"})
    ev = a.call("WriteStatus", "IServerAction:Event_Write", {"TicketId": "TicketId", "EventTypeId": f"If((OldStatusId = {S}Resolved or OldStatusId = {S}Closed) and NewStatusId = {S}Open, {EV}Reopened, {EV}StatusChanged)", "ActorId": "ActorId", "FromValue": "IntegerToText(OldStatusId)", "ToValue": "IntegerToText(NewStatusId)", "Note": "Note"})
    gw, nc = notify_watchers(a, '"Ticket " + T.Number + " changed status"', "Note")
    e = a.end(); a.chain(s, g, nf); a.link(nf, pm, "TrueTarget"); a.chain(pm, ct, ok); a.link(ok, ri, "FalseTarget"); a.link(ok, fill, "TrueTarget"); a.chain(fill, up, ev, gw); a.link(nc, e); a.layout()

    a = Act(j, "Ticket_Assign", desc="Atribui equipa e assignee (tem de ser membro); New passa a Open; evento; notifica o assignee")
    a.inp("TicketId", "Ticket Identifier"); a.inp("TeamId", "Team Identifier"); a.inp("AssigneeId", "User Identifier", False); a.inp("ActorId", "User Identifier", False)
    a.var("T", "Ticket"); a.var("Recipients", "User Identifier List")
    s = a.start(); g, nf = get_ticket(a)
    gm = a.agg("GetMembership", ["IServerEntity:TeamMember"], ["TeamMember.TeamId = TeamId", "TeamMember.UserId = AssigneeId"], max_records="1")
    chk = a.iff("AssigneeOk", "AssigneeId = NullIdentifier() or not GetMembership.List.Empty"); rn = a.raise_("RaiseNotMember", "NotAllowed", '"Assignee is not a member of the team"')
    fill = a.assign("Apply", [("T", "GetTicket.List.Current.Ticket"), ("T.TeamId", "TeamId"), ("T.AssigneeId", "AssigneeId"), ("T.UpdatedOn", NOW), ("T.StatusId", f"If(GetTicket.List.Current.Ticket.StatusId = {S}New, {S}Open, GetTicket.List.Current.Ticket.StatusId)")])
    up = a.call("UpdateTicket", entity_action("Ticket", "Update"), {"Source": "T"})
    ev = a.call("WriteAssigned", "IServerAction:Event_Write", {"TicketId": "TicketId", "EventTypeId": EV + "Assigned", "ActorId": "ActorId", "FromValue": '""', "ToValue": '""', "Note": '""'})
    has = a.iff("HasAssignee", "AssigneeId <> NullIdentifier()")
    ap = a.call("AppendAssignee", "IActionSignature:ListAppend", {"List": "Recipients", "Element": "AssigneeId"})
    nc = a.call("NotifyAssignee", "IServerAction:Notification_Create", {"UserIds": "Recipients", "TicketId": "TicketId", "Title": '"Ticket " + T.Number + " assigned to you"', "Body": "T.Subject"})
    e = a.end(); a.chain(s, g, nf); a.link(nf, gm, "TrueTarget"); a.chain(gm, chk); a.link(chk, rn, "FalseTarget"); a.link(chk, fill, "TrueTarget"); a.chain(fill, up, ev, has); a.link(has, ap, "TrueTarget"); a.link(has, e, "FalseTarget"); a.chain(ap, nc, e); a.layout()

    a = Act(j, "Ticket_ChangePriority", desc="Muda a prioridade e recalcula os prazos de SLA a partir da criacao")
    a.inp("TicketId", "Ticket Identifier"); a.inp("NewPriorityId", "TicketPriority Identifier"); a.inp("ActorId", "User Identifier", False); a.inp("Reason", "Text", False)
    a.var("T", "Ticket")
    s = a.start(); g, nf = get_ticket(a)
    sla = a.call("ComputeSla", "IServerAction:Sla_ComputeDueDates", {"PriorityId": "NewPriorityId", "StartOn": "GetTicket.List.Current.Ticket.CreatedOn"})
    fill = a.assign("Apply", [("T", "GetTicket.List.Current.Ticket"), ("T.PriorityId", "NewPriorityId"), ("T.FirstResponseDueOn", "ComputeSla.FirstResponseDueOn"), ("T.ResolutionDueOn", "ComputeSla.ResolutionDueOn"), ("T.UpdatedOn", NOW)])
    up = a.call("UpdateTicket", entity_action("Ticket", "Update"), {"Source": "T"})
    ev = a.call("WritePriority", "IServerAction:Event_Write", {"TicketId": "TicketId", "EventTypeId": EV + "PriorityChanged", "ActorId": "ActorId", "FromValue": "IntegerToText(GetTicket.List.Current.Ticket.PriorityId)", "ToValue": "IntegerToText(NewPriorityId)", "Note": "Reason"})
    e = a.end(); a.chain(s, g, nf); a.link(nf, sla, "TrueTarget"); a.chain(sla, fill, up, ev, e); a.layout()

    a = Act(j, "Ticket_Escalate", desc="Marca escalado, sobe um nivel de prioridade, avisa o manager da equipa")
    a.inp("TicketId", "Ticket Identifier"); a.inp("ActorId", "User Identifier", False); a.inp("Reason", "Text", False)
    a.var("T", "Ticket"); a.var("Recipients", "User Identifier List")
    s = a.start(); g, nf = get_ticket(a)
    fill = a.assign("MarkEscalated", [("T", "GetTicket.List.Current.Ticket"), ("T.IsEscalated", "True"), ("T.UpdatedOn", NOW)])
    up = a.call("UpdateTicket", entity_action("Ticket", "Update"), {"Source": "T"})
    cp = a.call("RaisePriority", "IServerAction:Ticket_ChangePriority", {"TicketId": "TicketId", "NewPriorityId": f"If(T.PriorityId = {P}Low, {P}Medium, If(T.PriorityId = {P}Medium, {P}High, {P}Urgent))", "ActorId": "ActorId", "Reason": "Reason"})
    ev = a.call("WriteEscalated", "IServerAction:Event_Write", {"TicketId": "TicketId", "EventTypeId": EV + "Escalated", "ActorId": "ActorId", "FromValue": '""', "ToValue": '""', "Note": "Reason"})
    gt = a.agg("GetTeam", ["IServerEntity:Team"], ["Team.Id = T.TeamId"], max_records="1")
    has = a.iff("HasManager", "not GetTeam.List.Empty and GetTeam.List.Current.Team.ManagerId <> NullIdentifier()")
    ap = a.call("AppendManager", "IActionSignature:ListAppend", {"List": "Recipients", "Element": "GetTeam.List.Current.Team.ManagerId"})
    nc = a.call("NotifyManager", "IServerAction:Notification_Create", {"UserIds": "Recipients", "TicketId": "TicketId", "Title": '"Ticket " + T.Number + " escalated"', "Body": "Reason"})
    e = a.end(); a.chain(s, g, nf); a.link(nf, fill, "TrueTarget"); a.chain(fill, up, cp, ev, gt, has); a.link(has, ap, "TrueTarget"); a.link(has, e, "FalseTarget"); a.chain(ap, nc, e); a.layout()

    a = Act(j, "Ticket_Merge", desc="Funde a fonte no alvo: move comentarios, anexos e watchers, fecha a fonte com ParentTicketId")
    a.inp("SourceTicketId", "Ticket Identifier"); a.inp("TargetTicketId", "Ticket Identifier"); a.inp("ActorId", "User Identifier", False)
    a.var("Src", "Ticket"); a.var("C", "TicketComment"); a.var("At", "TicketAttachment"); a.var("W", "TicketWatcher")
    s = a.start()
    gs = a.agg("GetSource", ["IServerEntity:Ticket"], ["Ticket.Id = SourceTicketId"], max_records="1")
    gt = a.agg("GetTarget", ["IServerEntity:Ticket"], ["Ticket.Id = TargetTicketId"], max_records="1")
    both = a.iff("BothFound", "not GetSource.List.Empty and not GetTarget.List.Empty"); rnf = a.raise_("RaiseNotFound", "NotFound", '"Ticket not found"')
    opn = a.iff("BothOpen", f"GetSource.List.Current.Ticket.StatusId <> {S}Closed and GetSource.List.Current.Ticket.StatusId <> {S}Cancelled and GetTarget.List.Current.Ticket.StatusId <> {S}Closed and GetTarget.List.Current.Ticket.StatusId <> {S}Cancelled")
    rit = a.raise_("RaiseClosed", "InvalidTransition", '"Both tickets must be open to merge"')
    gc = a.agg("GetComments", ["IServerEntity:TicketComment"], ["TicketComment.TicketId = SourceTicketId"])
    fc = a.foreach("EachComment", "GetComments.List"); ac = a.assign("MoveComment", [("C", "GetComments.List.Current.TicketComment"), ("C.TicketId", "TargetTicketId")]); uc = a.call("UpdateComment", entity_action("TicketComment", "Update"), {"Source": "C"})
    ga = a.agg("GetAttachments", ["IServerEntity:TicketAttachment"], ["TicketAttachment.TicketId = SourceTicketId"])
    fa = a.foreach("EachAttachment", "GetAttachments.List"); aa = a.assign("MoveAttachment", [("At", "GetAttachments.List.Current.TicketAttachment"), ("At.TicketId", "TargetTicketId")]); ua = a.call("UpdateAttachment", entity_action("TicketAttachment", "Update"), {"Source": "At"})
    gw = a.agg("GetWatchers", ["IServerEntity:TicketWatcher"], ["TicketWatcher.TicketId = SourceTicketId"])
    fw = a.foreach("EachWatcher", "GetWatchers.List"); aw = a.assign("MoveWatcher", [("W", "GetWatchers.List.Current.TicketWatcher"), ("W.TicketId", "TargetTicketId")]); uw = a.call("UpdateWatcher", entity_action("TicketWatcher", "Update"), {"Source": "W"})
    cs = a.assign("CloseSource", [("Src", "GetSource.List.Current.Ticket"), ("Src.StatusId", S + "Closed"), ("Src.ParentTicketId", "TargetTicketId"), ("Src.ClosedOn", NOW), ("Src.UpdatedOn", NOW)])
    us = a.call("UpdateSource", entity_action("Ticket", "Update"), {"Source": "Src"})
    e1 = a.call("WriteMergedSource", "IServerAction:Event_Write", {"TicketId": "SourceTicketId", "EventTypeId": EV + "Merged", "ActorId": "ActorId", "FromValue": "GetSource.List.Current.Ticket.Number", "ToValue": "GetTarget.List.Current.Ticket.Number", "Note": '"Merged into target"'})
    e2 = a.call("WriteMergedTarget", "IServerAction:Event_Write", {"TicketId": "TargetTicketId", "EventTypeId": EV + "Merged", "ActorId": "ActorId", "FromValue": "GetSource.List.Current.Ticket.Number", "ToValue": "GetTarget.List.Current.Ticket.Number", "Note": '"Merged from source"'})
    e = a.end()
    a.chain(s, gs, gt, both); a.link(both, rnf, "FalseTarget"); a.link(both, opn, "TrueTarget"); a.link(opn, rit, "FalseTarget"); a.link(opn, gc, "TrueTarget")
    a.chain(gc, fc); a.link(fc, ac, "CycleTarget"); a.chain(ac, uc); a.link(uc, fc); a.link(fc, ga)
    a.chain(ga, fa); a.link(fa, aa, "CycleTarget"); a.chain(aa, ua); a.link(ua, fa); a.link(fa, gw)
    a.chain(gw, fw); a.link(fw, aw, "CycleTarget"); a.chain(aw, uw); a.link(uw, fw); a.link(fw, cs)
    a.chain(cs, us, e1, e2, e); a.layout()

    a = Act(j, "Ticket_Cancel", desc="Cancela com verificacao de acesso; reusa a transicao")
    a.inp("TicketId", "Ticket Identifier"); a.inp("ActorId", "User Identifier"); a.inp("Reason", "Text", False)
    s = a.start()
    ac = a.call("AssertAccess", "IServerAction:Ticket_AssertAccess", {"ViewerId": "ActorId", "TicketId": "TicketId", "Operation": '"cancel"'})
    cs = a.call("Cancel", "IServerAction:Ticket_ChangeStatus", {"TicketId": "TicketId", "NewStatusId": S + "Cancelled", "ActorId": "ActorId", "Note": "Reason"})
    e = a.end(); a.chain(s, ac, cs, e); a.layout()

    a = Act(j, "Ticket_RateSatisfaction", desc="Avaliacao 1-5 pelo requester, uma vez, so em Resolved/Closed")
    a.inp("TicketId", "Ticket Identifier"); a.inp("RequesterId", "User Identifier"); a.inp("Score", "Integer")
    a.var("T", "Ticket")
    s = a.start(); g, nf = get_ticket(a)
    own = a.iff("IsRequester", "GetTicket.List.Current.Ticket.RequesterId = RequesterId"); rn = a.raise_("RaiseNotRequester", "NotAllowed", '"Only the requester can rate"')
    st = a.iff("IsDone", f"GetTicket.List.Current.Ticket.StatusId = {S}Resolved or GetTicket.List.Current.Ticket.StatusId = {S}Closed"); ri = a.raise_("RaiseNotDone", "InvalidTransition", '"Ticket is not resolved"')
    once = a.iff("NotRated", "GetTicket.List.Current.Ticket.SatisfactionScore = 0"); ro = a.raise_("RaiseRated", "ValidationFailed", '"Already rated"')
    rng = a.iff("ScoreInRange", "Score >= 1 and Score <= 5"); rr = a.raise_("RaiseRange", "ValidationFailed", '"Score must be between 1 and 5"')
    fill = a.assign("Apply", [("T", "GetTicket.List.Current.Ticket"), ("T.SatisfactionScore", "Score"), ("T.UpdatedOn", NOW)])
    up = a.call("UpdateTicket", entity_action("Ticket", "Update"), {"Source": "T"})
    e = a.end(); a.chain(s, g, nf); a.link(nf, own, "TrueTarget"); a.link(own, rn, "FalseTarget"); a.link(own, st, "TrueTarget"); a.link(st, ri, "FalseTarget"); a.link(st, once, "TrueTarget")
    a.link(once, ro, "FalseTarget"); a.link(once, rng, "TrueTarget"); a.link(rng, rr, "FalseTarget"); a.link(rng, fill, "TrueTarget"); a.chain(fill, up, e); a.layout()
    return j


# ---------------------------------------------------------------------------------------------------------------------
# 04 collab
# ---------------------------------------------------------------------------------------------------------------------

def job_collab() -> Job:
    j = Job("tickets-04-collab", "job:tickets-03-lifecycle", "Tickets: comentarios, anexos, watchers, tags e respostas prontas")

    a = Act(j, "Comment_Add", desc="Comentario publico ou interno; primeiro comentario de agente preenche FirstRespondedOn")
    a.inp("TicketId", "Ticket Identifier"); a.inp("AuthorId", "User Identifier"); a.inp("Body", "Text"); a.inp("IsInternal", "Boolean")
    a.out("CommentId", "TicketComment Identifier"); a.var("C", "TicketComment"); a.var("T", "Ticket")
    s = a.start(); g, nf = get_ticket(a)
    isi = a.iff("IsInternalComment", "IsInternal")
    ac = a.call("AssertTeam", "IServerAction:Ticket_AssertAccess", {"ViewerId": "AuthorId", "TicketId": "TicketId", "Operation": '"comment internally on"'})
    fill = a.assign("FillComment", [("C.TicketId", "TicketId"), ("C.AuthorId", "AuthorId"), ("C.Body", "Body"), ("C.IsInternal", "IsInternal"), ("C.CreatedOn", NOW)])
    cr = a.call("CreateComment", entity_action("TicketComment", "Create"), {"Source": "C"})
    so = a.assign("SetOutput", [("CommentId", "CreateComment.Id")])
    fr = a.iff("IsFirstResponse", "not IsInternal and GetTicket.List.Current.Ticket.FirstRespondedOn = NullDate() and AuthorId <> GetTicket.List.Current.Ticket.RequesterId")
    mk = a.assign("MarkFirstResponse", [("T", "GetTicket.List.Current.Ticket"), ("T.FirstRespondedOn", NOW), ("T.UpdatedOn", NOW)])
    up = a.call("UpdateTicket", entity_action("Ticket", "Update"), {"Source": "T"})
    ev = a.call("WriteComment", "IServerAction:Event_Write", {"TicketId": "TicketId", "EventTypeId": EV + "CommentAdded", "ActorId": "AuthorId", "FromValue": '""', "ToValue": "If(IsInternal, \"internal\", \"public\")", "Note": '""'})
    pub = a.iff("IsPublic", "not IsInternal")
    gw, nc = notify_watchers(a, '"New comment on " + GetTicket.List.Current.Ticket.Number', "Body")
    e = a.end()
    a.chain(s, g, nf); a.link(nf, isi, "TrueTarget"); a.link(isi, ac, "TrueTarget"); a.link(ac, fill); a.link(isi, fill, "FalseTarget")
    a.chain(fill, cr, so, fr); a.link(fr, mk, "TrueTarget"); a.chain(mk, up, ev); a.link(fr, ev, "FalseTarget"); a.chain(ev, pub); a.link(pub, gw, "TrueTarget"); a.link(pub, e, "FalseTarget"); a.link(nc, e); a.layout()

    a = Act(j, "Comment_Edit", desc="So o autor, ate 24 h")
    a.inp("CommentId", "TicketComment Identifier"); a.inp("AuthorId", "User Identifier"); a.inp("Body", "Text"); a.var("C", "TicketComment")
    s = a.start(); g = a.agg("GetComment", ["IServerEntity:TicketComment"], ["TicketComment.Id = CommentId"], max_records="1"); nf = not_found(a, g, "Comment")
    own = a.iff("IsAuthor", "GetComment.List.Current.TicketComment.AuthorId = AuthorId"); rn = a.raise_("RaiseNotAuthor", "NotAllowed", '"Only the author can edit"')
    win = a.iff("Within24h", "DiffHours(GetComment.List.Current.TicketComment.CreatedOn, CurrDateTime()) <= 24"); rw = a.raise_("RaiseTooLate", "NotAllowed", '"Comments can only be edited within 24 hours"')
    fill = a.assign("Apply", [("C", "GetComment.List.Current.TicketComment"), ("C.Body", "Body"), ("C.EditedOn", NOW)])
    up = a.call("UpdateComment", entity_action("TicketComment", "Update"), {"Source": "C"})
    e = a.end(); a.chain(s, g, nf); a.link(nf, own, "TrueTarget"); a.link(own, rn, "FalseTarget"); a.link(own, win, "TrueTarget"); a.link(win, rw, "FalseTarget"); a.link(win, fill, "TrueTarget"); a.chain(fill, up, e); a.layout()

    a = Act(j, "Attachment_Add", desc="Anexo com limite de tamanho e extensoes bloqueadas (site properties)")
    a.inp("TicketId", "Ticket Identifier"); a.inp("CommentId", "TicketComment Identifier", False); a.inp("FileName", "Text"); a.inp("MimeType", "Text", False); a.inp("Content", "Binary Data"); a.inp("SizeBytes", "Long Integer"); a.inp("UploaderId", "User Identifier")
    a.out("AttachmentId", "TicketAttachment Identifier"); a.var("A", "TicketAttachment")
    s = a.start(); g, nf = get_ticket(a)
    sz = a.iff("SizeOk", "SizeBytes <= Site.MaxAttachmentMB * 1048576"); rs = a.raise_("RaiseTooBig", "ValidationFailed", '"File exceeds " + IntegerToText(Site.MaxAttachmentMB) + " MB"')
    ex = a.iff("ExtensionOk", 'Index(Site.BlockedExtensions, ToLower(Substr(FileName, Length(FileName) - 4, 4))) < 0'); re_ = a.raise_("RaiseBlocked", "ValidationFailed", '"File type not allowed"')
    fill = a.assign("FillAttachment", [("A.TicketId", "TicketId"), ("A.CommentId", "CommentId"), ("A.FileName", "FileName"), ("A.MimeType", "MimeType"), ("A.SizeBytes", "SizeBytes"), ("A.Content", "Content"), ("A.UploadedById", "UploaderId"), ("A.UploadedOn", NOW)])
    cr = a.call("CreateAttachment", entity_action("TicketAttachment", "Create"), {"Source": "A"})
    so = a.assign("SetOutput", [("AttachmentId", "CreateAttachment.Id")])
    ev = a.call("WriteAttachment", "IServerAction:Event_Write", {"TicketId": "TicketId", "EventTypeId": EV + "AttachmentAdded", "ActorId": "UploaderId", "FromValue": '""', "ToValue": "FileName", "Note": '""'})
    e = a.end(); a.chain(s, g, nf); a.link(nf, sz, "TrueTarget"); a.link(sz, rs, "FalseTarget"); a.link(sz, ex, "TrueTarget"); a.link(ex, re_, "FalseTarget"); a.link(ex, fill, "TrueTarget"); a.chain(fill, cr, so, ev, e); a.layout()

    a = Act(j, "Watcher_Add", desc="Idempotente")
    a.inp("TicketId", "Ticket Identifier"); a.inp("UserId", "User Identifier"); a.var("W", "TicketWatcher")
    s = a.start(); g = a.agg("GetWatcher", ["IServerEntity:TicketWatcher"], ["TicketWatcher.TicketId = TicketId", "TicketWatcher.UserId = UserId"], max_records="1")
    ex = a.iff("Exists", "not GetWatcher.List.Empty"); fill = a.assign("Fill", [("W.TicketId", "TicketId"), ("W.UserId", "UserId"), ("W.AddedOn", NOW)]); cr = a.call("CreateWatcher", entity_action("TicketWatcher", "Create"), {"Source": "W"})
    e = a.end(); a.chain(s, g, ex); a.link(ex, e, "TrueTarget"); a.link(ex, fill, "FalseTarget"); a.chain(fill, cr, e); a.layout()

    a = Act(j, "Watcher_Remove", desc="Idempotente; o requester nunca sai")
    a.inp("TicketId", "Ticket Identifier"); a.inp("UserId", "User Identifier")
    s = a.start(); g, nf = get_ticket(a)
    isr = a.iff("IsRequester", "GetTicket.List.Current.Ticket.RequesterId = UserId")
    gw = a.agg("GetWatcher", ["IServerEntity:TicketWatcher"], ["TicketWatcher.TicketId = TicketId", "TicketWatcher.UserId = UserId"], max_records="1")
    ex = a.iff("Exists", "not GetWatcher.List.Empty"); de = a.call("DeleteWatcher", entity_action("TicketWatcher", "Delete"), {"Id": "GetWatcher.List.Current.TicketWatcher.Id"})
    e = a.end(); a.chain(s, g, nf); a.link(nf, isr, "TrueTarget"); a.link(isr, e, "TrueTarget"); a.link(isr, gw, "FalseTarget"); a.chain(gw, ex); a.link(ex, de, "TrueTarget"); a.link(ex, e, "FalseTarget"); a.link(de, e); a.layout()

    a = Act(j, "Tag_Apply", desc="So tags ativas; idempotente")
    a.inp("TicketId", "Ticket Identifier"); a.inp("TagId", "Tag Identifier"); a.var("TT", "TicketTag")
    s = a.start(); gt = a.agg("GetTag", ["IServerEntity:Tag"], ["Tag.Id = TagId", "Tag.IsActive"], max_records="1")
    ok = a.iff("TagActive", "not GetTag.List.Empty"); rt = a.raise_("RaiseTag", "ValidationFailed", '"Tag not found or inactive"')
    gtt = a.agg("GetTicketTag", ["IServerEntity:TicketTag"], ["TicketTag.TicketId = TicketId", "TicketTag.TagId = TagId"], max_records="1")
    ex = a.iff("Exists", "not GetTicketTag.List.Empty"); fill = a.assign("Fill", [("TT.TicketId", "TicketId"), ("TT.TagId", "TagId")]); cr = a.call("CreateTicketTag", entity_action("TicketTag", "Create"), {"Source": "TT"})
    e = a.end(); a.chain(s, gt, ok); a.link(ok, rt, "FalseTarget"); a.link(ok, gtt, "TrueTarget"); a.chain(gtt, ex); a.link(ex, e, "TrueTarget"); a.link(ex, fill, "FalseTarget"); a.chain(fill, cr, e); a.layout()

    a = Act(j, "Tag_Remove", desc="Idempotente")
    a.inp("TicketId", "Ticket Identifier"); a.inp("TagId", "Tag Identifier")
    s = a.start(); gtt = a.agg("GetTicketTag", ["IServerEntity:TicketTag"], ["TicketTag.TicketId = TicketId", "TicketTag.TagId = TagId"], max_records="1")
    ex = a.iff("Exists", "not GetTicketTag.List.Empty"); de = a.call("DeleteTicketTag", entity_action("TicketTag", "Delete"), {"Id": "GetTicketTag.List.Current.TicketTag.Id"})
    e = a.end(); a.chain(s, gtt, ex); a.link(ex, de, "TrueTarget"); a.link(ex, e, "FalseTarget"); a.link(de, e); a.layout()

    a = Act(j, "CannedResponse_Render", desc="Substitui {RequesterName}, {TicketNumber} e {AgentName}")
    a.inp("CannedResponseId", "CannedResponse Identifier"); a.inp("TicketId", "Ticket Identifier"); a.out("Body", "Text")
    s = a.start(); gc = a.agg("GetCanned", ["IServerEntity:CannedResponse"], ["CannedResponse.Id = CannedResponseId"], max_records="1"); nf = not_found(a, gc, "CannedResponse")
    g, nf2 = get_ticket(a)
    gr = a.agg("GetRequester", ["IEntitySignature:User"], ["User.Id = GetTicket.List.Current.Ticket.RequesterId"], max_records="1")
    ga = a.agg("GetAgent", ["IEntitySignature:User"], ["User.Id = GetTicket.List.Current.Ticket.AssigneeId"], max_records="1")
    asg = a.assign("Render", [("Body", 'Replace(Replace(Replace(GetCanned.List.Current.CannedResponse.Body, "{RequesterName}", If(GetRequester.List.Empty, "", GetRequester.List.Current.User.Name)), "{TicketNumber}", GetTicket.List.Current.Ticket.Number), "{AgentName}", If(GetAgent.List.Empty, "", GetAgent.List.Current.User.Name))')])
    e = a.end(); a.chain(s, gc, nf); a.link(nf, g, "TrueTarget"); a.chain(g, nf2); a.link(nf2, gr, "TrueTarget"); a.chain(gr, ga, asg, e); a.layout()
    return j


# ---------------------------------------------------------------------------------------------------------------------
# 05 org
# ---------------------------------------------------------------------------------------------------------------------

def job_org() -> Job:
    j = Job("tickets-05-org", "job:tickets-04-collab", "Tickets: equipas, membros, categorias e politicas de SLA")

    a = Act(j, "Team_Create"); a.inp("Name", "Text"); a.inp("Description", "Text", False); a.inp("Email", "Email", False); a.inp("ManagerId", "User Identifier", False); a.out("TeamId", "Team Identifier"); a.var("T", "Team")
    s = a.start(); fill = a.assign("Fill", [("T.Name", "Name"), ("T.Description", "Description"), ("T.Email", "Email"), ("T.ManagerId", "ManagerId"), ("T.IsActive", "True")]); cr = a.call("CreateTeam", entity_action("Team", "Create"), {"Source": "T"}); so = a.assign("SetOutput", [("TeamId", "CreateTeam.Id")]); e = a.end(); a.chain(s, fill, cr, so, e); a.layout()

    a = Act(j, "Team_Update"); a.inp("TeamId", "Team Identifier"); a.inp("Name", "Text"); a.inp("Description", "Text", False); a.inp("Email", "Email", False); a.inp("ManagerId", "User Identifier", False); a.var("T", "Team")
    s = a.start(); g = a.agg("GetTeam", ["IServerEntity:Team"], ["Team.Id = TeamId"], max_records="1"); nf = not_found(a, g, "Team")
    fill = a.assign("Apply", [("T", "GetTeam.List.Current.Team"), ("T.Name", "Name"), ("T.Description", "Description"), ("T.Email", "Email"), ("T.ManagerId", "ManagerId")]); up = a.call("UpdateTeam", entity_action("Team", "Update"), {"Source": "T"}); e = a.end(); a.chain(s, g, nf); a.link(nf, fill, "TrueTarget"); a.chain(fill, up, e); a.layout()

    a = Act(j, "Team_Deactivate", desc="Exige zero tickets abertos ou uma equipa para onde reatribuir")
    a.inp("TeamId", "Team Identifier"); a.inp("ReassignToTeamId", "Team Identifier", False); a.inp("ActorId", "User Identifier", False); a.var("T", "Team"); a.var("Tk", "Ticket")
    s = a.start(); g = a.agg("GetTeam", ["IServerEntity:Team"], ["Team.Id = TeamId"], max_records="1"); nf = not_found(a, g, "Team")
    go = a.agg("GetOpenTickets", ["IServerEntity:Ticket"], ["Ticket.TeamId = TeamId", f"Ticket.StatusId <> {S}Closed", f"Ticket.StatusId <> {S}Cancelled"])
    chk = a.iff("CanDeactivate", "GetOpenTickets.List.Empty or ReassignToTeamId <> NullIdentifier()"); rv = a.raise_("RaiseOpen", "ValidationFailed", '"Team has open tickets: pass ReassignToTeamId"')
    fe = a.foreach("EachOpen", "GetOpenTickets.List"); mv = a.assign("Reassign", [("Tk", "GetOpenTickets.List.Current.Ticket"), ("Tk.TeamId", "ReassignToTeamId"), ("Tk.AssigneeId", "NullIdentifier()"), ("Tk.UpdatedOn", NOW)]); up = a.call("UpdateTicket", entity_action("Ticket", "Update"), {"Source": "Tk"})
    ev = a.call("WriteAssigned", "IServerAction:Event_Write", {"TicketId": "Tk.Id", "EventTypeId": EV + "Assigned", "ActorId": "ActorId", "FromValue": '""', "ToValue": '""', "Note": '"Team deactivated"'})
    de = a.assign("Deactivate", [("T", "GetTeam.List.Current.Team"), ("T.IsActive", "False")]); ut = a.call("UpdateTeam", entity_action("Team", "Update"), {"Source": "T"})
    e = a.end(); a.chain(s, g, nf); a.link(nf, go, "TrueTarget"); a.chain(go, chk); a.link(chk, rv, "FalseTarget"); a.link(chk, fe, "TrueTarget"); a.link(fe, mv, "CycleTarget"); a.chain(mv, up, ev); a.link(ev, fe); a.link(fe, de); a.chain(de, ut, e); a.layout()

    a = Act(j, "TeamMember_Add"); a.inp("TeamId", "Team Identifier"); a.inp("UserId", "User Identifier"); a.inp("IsLead", "Boolean"); a.var("M", "TeamMember")
    s = a.start(); g = a.agg("GetMember", ["IServerEntity:TeamMember"], ["TeamMember.TeamId = TeamId", "TeamMember.UserId = UserId"], max_records="1")
    ex = a.iff("Exists", "not GetMember.List.Empty"); fill = a.assign("Fill", [("M.TeamId", "TeamId"), ("M.UserId", "UserId"), ("M.IsLead", "IsLead"), ("M.JoinedOn", NOW)]); cr = a.call("CreateMember", entity_action("TeamMember", "Create"), {"Source": "M"})
    e = a.end(); a.chain(s, g, ex); a.link(ex, e, "TrueTarget"); a.link(ex, fill, "FalseTarget"); a.chain(fill, cr, e); a.layout()

    a = Act(j, "TeamMember_Remove", desc="Reatribui os tickets abertos do membro ao lead (ou deixa sem assignee)")
    a.inp("TeamId", "Team Identifier"); a.inp("UserId", "User Identifier"); a.inp("ActorId", "User Identifier", False); a.var("Tk", "Ticket")
    s = a.start(); g = a.agg("GetMember", ["IServerEntity:TeamMember"], ["TeamMember.TeamId = TeamId", "TeamMember.UserId = UserId"], max_records="1")
    ex = a.iff("Exists", "not GetMember.List.Empty")
    gl = a.agg("GetLead", ["IServerEntity:TeamMember"], ["TeamMember.TeamId = TeamId", "TeamMember.IsLead", "TeamMember.UserId <> UserId"], max_records="1")
    go = a.agg("GetOpenTickets", ["IServerEntity:Ticket"], ["Ticket.TeamId = TeamId", "Ticket.AssigneeId = UserId", f"Ticket.StatusId <> {S}Closed", f"Ticket.StatusId <> {S}Cancelled"])
    fe = a.foreach("EachOpen", "GetOpenTickets.List"); mv = a.assign("Reassign", [("Tk", "GetOpenTickets.List.Current.Ticket"), ("Tk.AssigneeId", "If(GetLead.List.Empty, NullIdentifier(), GetLead.List.Current.TeamMember.UserId)"), ("Tk.UpdatedOn", NOW)]); up = a.call("UpdateTicket", entity_action("Ticket", "Update"), {"Source": "Tk"})
    ev = a.call("WriteAssigned", "IServerAction:Event_Write", {"TicketId": "Tk.Id", "EventTypeId": EV + "Assigned", "ActorId": "ActorId", "FromValue": '""', "ToValue": '""', "Note": '"Member removed"'})
    de = a.call("DeleteMember", entity_action("TeamMember", "Delete"), {"Id": "GetMember.List.Current.TeamMember.Id"})
    e = a.end(); a.chain(s, g, ex); a.link(ex, e, "FalseTarget"); a.link(ex, gl, "TrueTarget"); a.chain(gl, go, fe); a.link(fe, mv, "CycleTarget"); a.chain(mv, up, ev); a.link(ev, fe); a.link(fe, de); a.chain(de, e); a.layout()

    a = Act(j, "Category_Create", desc="Profundidade maxima 3")
    a.inp("Name", "Text"); a.inp("ParentCategoryId", "Category Identifier", False); a.inp("DefaultTeamId", "Team Identifier", False); a.inp("DefaultPriorityId", "TicketPriority Identifier", False); a.out("CategoryId", "Category Identifier"); a.var("C", "Category")
    s = a.start(); gp = a.agg("GetParent", ["IServerEntity:Category"], ["Category.Id = ParentCategoryId"], max_records="1")
    gg = a.agg("GetGrandParent", ["IServerEntity:Category"], ["Category.Id = GetParent.List.Current.Category.ParentCategoryId"], max_records="1")
    dp = a.iff("DepthOk", "GetGrandParent.List.Empty or GetGrandParent.List.Current.Category.ParentCategoryId = NullIdentifier()"); rd = a.raise_("RaiseDepth", "ValidationFailed", '"Categories can only nest 3 levels"')
    fill = a.assign("Fill", [("C.Name", "Name"), ("C.ParentCategoryId", "ParentCategoryId"), ("C.DefaultTeamId", "DefaultTeamId"), ("C.DefaultPriorityId", "DefaultPriorityId"), ("C.IsActive", "True")]); cr = a.call("CreateCategory", entity_action("Category", "Create"), {"Source": "C"}); so = a.assign("SetOutput", [("CategoryId", "CreateCategory.Id")])
    e = a.end(); a.chain(s, gp, gg, dp); a.link(dp, rd, "FalseTarget"); a.link(dp, fill, "TrueTarget"); a.chain(fill, cr, so, e); a.layout()

    a = Act(j, "Category_Update"); a.inp("CategoryId", "Category Identifier"); a.inp("Name", "Text"); a.inp("ParentCategoryId", "Category Identifier", False); a.inp("DefaultTeamId", "Team Identifier", False); a.inp("DefaultPriorityId", "TicketPriority Identifier", False); a.var("C", "Category")
    s = a.start(); g = a.agg("GetCategory", ["IServerEntity:Category"], ["Category.Id = CategoryId"], max_records="1"); nf = not_found(a, g, "Category")
    slf = a.iff("NotSelfParent", "ParentCategoryId <> CategoryId"); rs = a.raise_("RaiseSelf", "ValidationFailed", '"A category cannot be its own parent"')
    fill = a.assign("Apply", [("C", "GetCategory.List.Current.Category"), ("C.Name", "Name"), ("C.ParentCategoryId", "ParentCategoryId"), ("C.DefaultTeamId", "DefaultTeamId"), ("C.DefaultPriorityId", "DefaultPriorityId")]); up = a.call("UpdateCategory", entity_action("Category", "Update"), {"Source": "C"})
    e = a.end(); a.chain(s, g, nf); a.link(nf, slf, "TrueTarget"); a.link(slf, rs, "FalseTarget"); a.link(slf, fill, "TrueTarget"); a.chain(fill, up, e); a.layout()

    a = Act(j, "Category_Deactivate", desc="So sem filhos ativos"); a.inp("CategoryId", "Category Identifier"); a.var("C", "Category")
    s = a.start(); g = a.agg("GetCategory", ["IServerEntity:Category"], ["Category.Id = CategoryId"], max_records="1"); nf = not_found(a, g, "Category")
    gc = a.agg("GetChildren", ["IServerEntity:Category"], ["Category.ParentCategoryId = CategoryId", "Category.IsActive"], max_records="1")
    ok = a.iff("NoChildren", "GetChildren.List.Empty"); rc = a.raise_("RaiseChildren", "ValidationFailed", '"Deactivate the child categories first"')
    fill = a.assign("Apply", [("C", "GetCategory.List.Current.Category"), ("C.IsActive", "False")]); up = a.call("UpdateCategory", entity_action("Category", "Update"), {"Source": "C"})
    e = a.end(); a.chain(s, g, nf); a.link(nf, gc, "TrueTarget"); a.chain(gc, ok); a.link(ok, rc, "FalseTarget"); a.link(ok, fill, "TrueTarget"); a.chain(fill, up, e); a.layout()

    a = Act(j, "SlaPolicy_Upsert", desc="Uma politica ativa por (prioridade, alvo)")
    a.inp("PriorityId", "TicketPriority Identifier"); a.inp("TargetId", "SlaTarget Identifier"); a.inp("Minutes", "Integer"); a.inp("BusinessHoursOnly", "Boolean"); a.out("SlaPolicyId", "SlaPolicy Identifier"); a.var("Pol", "SlaPolicy")
    s = a.start(); g = a.agg("GetPolicy", ["IServerEntity:SlaPolicy"], ["SlaPolicy.PriorityId = PriorityId", "SlaPolicy.TargetId = TargetId", "SlaPolicy.IsActive"], max_records="1")
    ex = a.iff("Exists", "not GetPolicy.List.Empty")
    fu = a.assign("ApplyExisting", [("Pol", "GetPolicy.List.Current.SlaPolicy"), ("Pol.Minutes", "Minutes"), ("Pol.BusinessHoursOnly", "BusinessHoursOnly")])
    fn = a.assign("FillNew", [("Pol.PriorityId", "PriorityId"), ("Pol.TargetId", "TargetId"), ("Pol.Minutes", "Minutes"), ("Pol.BusinessHoursOnly", "BusinessHoursOnly"), ("Pol.IsActive", "True"), ("Pol.Name", '"SLA " + IntegerToText(PriorityId) + "/" + IntegerToText(TargetId)')])
    cu = a.call("SavePolicy", entity_action("SlaPolicy", "CreateOrUpdate"), {"Source": "Pol"}); so = a.assign("SetOutput", [("SlaPolicyId", "SavePolicy.Id")])
    e = a.end(); a.chain(s, g, ex); a.link(ex, fu, "TrueTarget"); a.link(ex, fn, "FalseTarget"); a.link(fu, cu); a.link(fn, cu); a.chain(cu, so, e); a.layout()
    return j


# ---------------------------------------------------------------------------------------------------------------------
# 06 SLA, automacao e timers
# ---------------------------------------------------------------------------------------------------------------------

def job_sla() -> Job:
    j = Job("tickets-06-sla", "job:tickets-05-org", "Tickets: verificacao de SLA, auto-close, auto-assign, despacho de notificacoes, lembretes e os timers")

    a = Act(j, "Sla_CheckBreaches", desc="Timer: cria TicketSlaBreach para prazos vencidos e escala na primeira vez")
    a.out("BreachedCount", "Integer"); a.var("B", "TicketSlaBreach")
    s = a.start()
    g1 = a.agg("GetOverdueResolution", ["IServerEntity:Ticket"], [f"Ticket.ResolutionDueOn < {NOW}", f"Ticket.StatusId <> {S}Resolved", f"Ticket.StatusId <> {S}Closed", f"Ticket.StatusId <> {S}Cancelled"])
    f1 = a.foreach("EachOverdue", "GetOverdueResolution.List")
    gb = a.agg("GetBreach", ["IServerEntity:TicketSlaBreach"], ["TicketSlaBreach.TicketId = GetOverdueResolution.List.Current.Ticket.Id", "TicketSlaBreach.TargetId = Entities.SlaTarget.Resolution"], max_records="1")
    nb = a.iff("NoBreachYet", "GetBreach.List.Empty")
    fb = a.assign("FillBreach", [("B.TicketId", "GetOverdueResolution.List.Current.Ticket.Id"), ("B.TargetId", "Entities.SlaTarget.Resolution"), ("B.DueOn", "GetOverdueResolution.List.Current.Ticket.ResolutionDueOn"), ("B.BreachedOn", NOW), ("B.NotifiedOn", NOW), ("BreachedCount", "BreachedCount + 1")])
    cb = a.call("CreateBreach", entity_action("TicketSlaBreach", "Create"), {"Source": "B"})
    es = a.call("Escalate", "IServerAction:Ticket_Escalate", {"TicketId": "GetOverdueResolution.List.Current.Ticket.Id", "ActorId": "NullIdentifier()", "Reason": '"Resolution SLA breached"'})
    g2 = a.agg("GetOverdueFirst", ["IServerEntity:Ticket"], [f"Ticket.FirstResponseDueOn < {NOW}", "Ticket.FirstRespondedOn = NullDate()", f"Ticket.StatusId <> {S}Resolved", f"Ticket.StatusId <> {S}Closed", f"Ticket.StatusId <> {S}Cancelled"])
    f2 = a.foreach("EachOverdueFirst", "GetOverdueFirst.List")
    gb2 = a.agg("GetFirstBreach", ["IServerEntity:TicketSlaBreach"], ["TicketSlaBreach.TicketId = GetOverdueFirst.List.Current.Ticket.Id", "TicketSlaBreach.TargetId = Entities.SlaTarget.FirstResponse"], max_records="1")
    nb2 = a.iff("NoFirstBreachYet", "GetFirstBreach.List.Empty")
    fb2 = a.assign("FillFirstBreach", [("B.TicketId", "GetOverdueFirst.List.Current.Ticket.Id"), ("B.TargetId", "Entities.SlaTarget.FirstResponse"), ("B.DueOn", "GetOverdueFirst.List.Current.Ticket.FirstResponseDueOn"), ("B.BreachedOn", NOW), ("B.NotifiedOn", NOW), ("BreachedCount", "BreachedCount + 1")])
    cb2 = a.call("CreateFirstBreach", entity_action("TicketSlaBreach", "Create"), {"Source": "B"})
    e = a.end()
    a.chain(s, g1, f1); a.link(f1, gb, "CycleTarget"); a.chain(gb, nb); a.link(nb, fb, "TrueTarget"); a.chain(fb, cb, es); a.link(es, f1); a.link(nb, f1, "FalseTarget"); a.link(f1, g2)
    a.chain(g2, f2); a.link(f2, gb2, "CycleTarget"); a.chain(gb2, nb2); a.link(nb2, fb2, "TrueTarget"); a.chain(fb2, cb2); a.link(cb2, f2); a.link(nb2, f2, "FalseTarget"); a.link(f2, e); a.layout()

    a = Act(j, "Ticket_AutoClose", desc="Timer: Resolved ha mais de AutoCloseDays passa a Closed e pede avaliacao")
    a.out("ClosedCount", "Integer"); a.var("Recipients", "User Identifier List")
    s = a.start(); g = a.agg("GetResolved", ["IServerEntity:Ticket"], [f"Ticket.StatusId = {S}Resolved", f"Ticket.ResolvedOn < AddDays({NOW}, -Site.AutoCloseDays)"])
    fe = a.foreach("EachResolved", "GetResolved.List")
    cs = a.call("Close", "IServerAction:Ticket_ChangeStatus", {"TicketId": "GetResolved.List.Current.Ticket.Id", "NewStatusId": S + "Closed", "ActorId": "NullIdentifier()", "Note": '"Closed automatically"'})
    cl = a.call("ClearRecipients", "IActionSignature:ListClear", {"List": "Recipients"})
    ap = a.call("AppendRequester", "IActionSignature:ListAppend", {"List": "Recipients", "Element": "GetResolved.List.Current.Ticket.RequesterId"})
    nc = a.call("AskRating", "IServerAction:Notification_Create", {"UserIds": "Recipients", "TicketId": "GetResolved.List.Current.Ticket.Id", "Title": '"How did we do on " + GetResolved.List.Current.Ticket.Number + "?"', "Body": '"Please rate your ticket"'})
    inc = a.assign("Count", [("ClosedCount", "ClosedCount + 1")])
    e = a.end(); a.chain(s, g, fe); a.link(fe, cs, "CycleTarget"); a.chain(cs, cl, ap, nc, inc); a.link(inc, fe); a.link(fe, e); a.layout()

    a = Act(j, "Ticket_AutoAssign", desc="Membro da equipa com menos tickets abertos")
    a.inp("TicketId", "Ticket Identifier"); a.out("AssigneeId", "User Identifier"); a.var("Best", "Long Integer", "999999")
    s = a.start(); g, nf = get_ticket(a)
    gm = a.agg("GetMembers", ["IServerEntity:TeamMember"], ["TeamMember.TeamId = GetTicket.List.Current.Ticket.TeamId"])
    fe = a.foreach("EachMember", "GetMembers.List")
    go = a.agg("GetOpenCount", ["IServerEntity:Ticket"], ["Ticket.AssigneeId = GetMembers.List.Current.TeamMember.UserId", f"Ticket.StatusId <> {S}Resolved", f"Ticket.StatusId <> {S}Closed", f"Ticket.StatusId <> {S}Cancelled"])
    lt = a.iff("Fewer", "GetOpenCount.Count < Best"); pk = a.assign("Pick", [("Best", "GetOpenCount.Count"), ("AssigneeId", "GetMembers.List.Current.TeamMember.UserId")])
    has = a.iff("Found", "AssigneeId <> NullIdentifier()")
    asg = a.call("Assign", "IServerAction:Ticket_Assign", {"TicketId": "TicketId", "TeamId": "GetTicket.List.Current.Ticket.TeamId", "AssigneeId": "AssigneeId", "ActorId": "NullIdentifier()"})
    e = a.end(); a.chain(s, g, nf); a.link(nf, gm, "TrueTarget"); a.chain(gm, fe); a.link(fe, go, "CycleTarget"); a.chain(go, lt); a.link(lt, pk, "TrueTarget"); a.link(pk, fe); a.link(lt, fe, "FalseTarget"); a.link(fe, has); a.link(has, asg, "TrueTarget"); a.link(has, e, "FalseTarget"); a.link(asg, e); a.layout()

    a = Act(j, "Notification_Dispatch", desc="Timer: marca como enviadas as notificacoes pendentes (o envio por email fica no modulo de UI/email)")
    a.out("SentCount", "Integer"); a.var("N", "Notification")
    s = a.start(); g = a.agg("GetPending", ["IServerEntity:Notification"], ["Notification.SentOn = NullDate()"], max_records="500")
    fe = a.foreach("EachPending", "GetPending.List"); mk = a.assign("MarkSent", [("N", "GetPending.List.Current.Notification"), ("N.SentOn", NOW), ("SentCount", "SentCount + 1")]); up = a.call("UpdateNotification", entity_action("Notification", "Update"), {"Source": "N"})
    e = a.end(); a.chain(s, g, fe); a.link(fe, mk, "CycleTarget"); a.chain(mk, up); a.link(up, fe); a.link(fe, e); a.layout()

    a = Act(j, "Ticket_Reminders", desc="Timer: Pending parados lembram o requester; Open parados lembram o assignee")
    a.var("Recipients", "User Identifier List")
    s = a.start()
    g1 = a.agg("GetStalePending", ["IServerEntity:Ticket"], [f"Ticket.StatusId = {S}Pending", f"Ticket.UpdatedOn < AddDays({NOW}, -Site.ReminderDays)"])
    f1 = a.foreach("EachPending", "GetStalePending.List"); c1 = a.call("Clear1", "IActionSignature:ListClear", {"List": "Recipients"}); a1 = a.call("AppendRequester", "IActionSignature:ListAppend", {"List": "Recipients", "Element": "GetStalePending.List.Current.Ticket.RequesterId"})
    n1 = a.call("RemindRequester", "IServerAction:Notification_Create", {"UserIds": "Recipients", "TicketId": "GetStalePending.List.Current.Ticket.Id", "Title": '"We are waiting for you on " + GetStalePending.List.Current.Ticket.Number', "Body": '""'})
    g2 = a.agg("GetStaleOpen", ["IServerEntity:Ticket"], [f"Ticket.StatusId = {S}Open", f"Ticket.UpdatedOn < AddDays({NOW}, -Site.ReminderDays)", "Ticket.AssigneeId <> NullIdentifier()"])
    f2 = a.foreach("EachOpen", "GetStaleOpen.List"); c2 = a.call("Clear2", "IActionSignature:ListClear", {"List": "Recipients"}); a2 = a.call("AppendAssignee", "IActionSignature:ListAppend", {"List": "Recipients", "Element": "GetStaleOpen.List.Current.Ticket.AssigneeId"})
    n2 = a.call("RemindAssignee", "IServerAction:Notification_Create", {"UserIds": "Recipients", "TicketId": "GetStaleOpen.List.Current.Ticket.Id", "Title": '"Ticket " + GetStaleOpen.List.Current.Ticket.Number + " has no activity"', "Body": '""'})
    e = a.end(); a.chain(s, g1, f1); a.link(f1, c1, "CycleTarget"); a.chain(c1, a1, n1); a.link(n1, f1); a.link(f1, g2); a.chain(g2, f2); a.link(f2, c2, "CycleTarget"); a.chain(c2, a2, n2); a.link(n2, f2); a.link(f2, e); a.layout()

    for name, action, desc in [("SlaCheckTimer", "Sla_CheckBreaches", "A cada 5 minutos"), ("AutoCloseTimer", "Ticket_AutoClose", "Diario"), ("NotificationDispatchTimer", "Notification_Dispatch", "A cada minuto"), ("RemindersTimer", "Ticket_Reminders", "Diario")]:
        al = j.create("@espace", "ITimer", name, "$timer_" + name)["as"]
        j.set(al, "Action", f"IServerAction:{action}")
        j.set(al, "Description", desc)
    return j


# ---------------------------------------------------------------------------------------------------------------------
# 07 leitura
# ---------------------------------------------------------------------------------------------------------------------

def job_read() -> Job:
    j = Job("tickets-07-read", "job:tickets-06-sla", "Tickets: leituras para telas e relatorios (get com permissoes, pesquisa, timeline, dashboard)")

    a = Act(j, "Ticket_Get", desc="Ticket + permissoes do viewer + transicoes permitidas")
    a.inp("TicketId", "Ticket Identifier"); a.inp("ViewerId", "User Identifier")
    a.out("Ticket", "Ticket"); a.out("Found", "Boolean"); a.out("CanEdit", "Boolean"); a.out("CanClose", "Boolean"); a.out("AllowedTransitions", "TicketStatus Identifier List")
    s = a.start(); g = a.agg("GetTicket", ["IServerEntity:Ticket"], ["Ticket.Id = TicketId"], max_records="1")
    fnd = a.iff("Found", "not GetTicket.List.Empty"); nf = a.assign("NotFound", [("Found", "False")])
    pm = a.call("Permissions", "IServerAction:User_Permissions", {"UserId": "ViewerId"})
    fill = a.assign("Fill", [("Found", "True"), ("Ticket", "GetTicket.List.Current.Ticket"), ("CanEdit", "Permissions.IsAgent or GetTicket.List.Current.Ticket.RequesterId = ViewerId"), ("CanClose", "Permissions.IsManager or GetTicket.List.Current.Ticket.AssigneeId = ViewerId")])
    gs = a.agg("GetStatuses", ["IServerEntity:TicketStatus"], [])
    fe = a.foreach("EachStatus", "GetStatuses.List")
    ct = a.call("CanTransition", "IServerAction:Ticket_CanTransition", {"FromStatusId": "Ticket.StatusId", "ToStatusId": "GetStatuses.List.Current.TicketStatus.Id", "IsManager": "Permissions.IsManager"})
    ok = a.iff("Allowed", "CanTransition.Allowed"); ap = a.call("AppendStatus", "IActionSignature:ListAppend", {"List": "AllowedTransitions", "Element": "GetStatuses.List.Current.TicketStatus.Id"})
    e = a.end(); a.chain(s, g, fnd); a.link(fnd, nf, "FalseTarget"); a.link(nf, e); a.link(fnd, pm, "TrueTarget"); a.chain(pm, fill, gs, fe); a.link(fe, ct, "CycleTarget"); a.chain(ct, ok); a.link(ok, ap, "TrueTarget"); a.link(ap, fe); a.link(ok, fe, "FalseTarget"); a.link(fe, e); a.layout()

    a = Act(j, "Ticket_Search", desc="Pesquisa paginada com filtros opcionais e visibilidade (requester ve os seus; agente e manager veem tudo)")
    for n, t in [("Search", "Text"), ("StatusId", "TicketStatus Identifier"), ("PriorityId", "TicketPriority Identifier"), ("TeamId", "Team Identifier"), ("AssigneeId", "User Identifier"), ("RequesterId", "User Identifier"), ("CategoryId", "Category Identifier"), ("FromDate", "Date Time"), ("ToDate", "Date Time")]:
        a.inp(n, t, False)
    a.inp("ViewerId", "User Identifier"); a.inp("StartIndex", "Integer", False); a.inp("MaxRecords", "Integer", False)
    a.out("Tickets", "Ticket List"); a.out("Count", "Long Integer")
    s = a.start(); pm = a.call("Permissions", "IServerAction:User_Permissions", {"UserId": "ViewerId"})
    g = a.agg("SearchTickets", ["IServerEntity:Ticket"], [
        'Search = "" or Ticket.Subject like "%" + Search + "%" or Ticket.Number like "%" + Search + "%"',
        "StatusId = NullIdentifier() or Ticket.StatusId = StatusId", "PriorityId = NullIdentifier() or Ticket.PriorityId = PriorityId",
        "TeamId = NullIdentifier() or Ticket.TeamId = TeamId", "AssigneeId = NullIdentifier() or Ticket.AssigneeId = AssigneeId",
        "RequesterId = NullIdentifier() or Ticket.RequesterId = RequesterId", "CategoryId = NullIdentifier() or Ticket.CategoryId = CategoryId",
        "FromDate = NullDate() or Ticket.CreatedOn >= FromDate", "ToDate = NullDate() or Ticket.CreatedOn <= ToDate",
        "Permissions.IsAgent or Permissions.IsManager or Ticket.RequesterId = ViewerId"],
        sort=("Ticket.CreatedOn", "Descending"), max_records="If(MaxRecords <= 0, 50, MaxRecords)", start_index="StartIndex")
    so = a.assign("SetOutputs", [("Tickets", "SearchTickets.List"), ("Count", "SearchTickets.Count")])
    e = a.end(); a.chain(s, pm, g, so, e); a.layout()

    a = Act(j, "Ticket_Timeline", desc="Comentarios (internos so para a equipa) e eventos numa lista unica")
    a.inp("TicketId", "Ticket Identifier"); a.inp("ViewerId", "User Identifier"); a.out("Items", "TimelineItem List"); a.var("I", "TimelineItem")
    s = a.start(); pm = a.call("Permissions", "IServerAction:User_Permissions", {"UserId": "ViewerId"})
    gc = a.agg("GetComments", ["IServerEntity:TicketComment"], ["TicketComment.TicketId = TicketId", "not TicketComment.IsInternal or Permissions.IsAgent"], sort=("TicketComment.CreatedOn", "Ascending"))
    fc = a.foreach("EachComment", "GetComments.List"); ic = a.assign("CommentItem", [("I.Kind", '"comment"'), ("I.OccurredOn", "GetComments.List.Current.TicketComment.CreatedOn"), ("I.ActorId", "GetComments.List.Current.TicketComment.AuthorId"), ("I.Text", "GetComments.List.Current.TicketComment.Body"), ("I.IsInternal", "GetComments.List.Current.TicketComment.IsInternal")])
    ac = a.call("AppendComment", "IActionSignature:ListAppend", {"List": "Items", "Element": "I"})
    ge = a.agg("GetEvents", ["IServerEntity:TicketEvent"], ["TicketEvent.TicketId = TicketId"], sort=("TicketEvent.OccurredOn", "Ascending"))
    fe = a.foreach("EachEvent", "GetEvents.List"); ie = a.assign("EventItem", [("I.Kind", '"event"'), ("I.OccurredOn", "GetEvents.List.Current.TicketEvent.OccurredOn"), ("I.ActorId", "GetEvents.List.Current.TicketEvent.ActorId"), ("I.Text", 'GetEvents.List.Current.TicketEvent.FromValue + " -> " + GetEvents.List.Current.TicketEvent.ToValue + " " + GetEvents.List.Current.TicketEvent.Note'), ("I.IsInternal", "False")])
    ae = a.call("AppendEvent", "IActionSignature:ListAppend", {"List": "Items", "Element": "I"})
    e = a.end(); a.chain(s, pm, gc, fc); a.link(fc, ic, "CycleTarget"); a.chain(ic, ac); a.link(ac, fc); a.link(fc, ge); a.chain(ge, fe); a.link(fe, ie, "CycleTarget"); a.chain(ie, ae); a.link(ae, fe); a.link(fe, e); a.layout()

    a = Act(j, "Dashboard_Metrics", desc="Contagens por status, urgentes, brechas de SLA, medias de resposta e resolucao no periodo")
    a.inp("TeamId", "Team Identifier", False); a.inp("FromDate", "Date Time", False); a.inp("ToDate", "Date Time", False); a.out("Metrics", "DashboardMetrics")
    a.var("SumFirst", "Decimal"); a.var("NFirst", "Integer"); a.var("SumRes", "Decimal"); a.var("NRes", "Integer")
    s = a.start()
    team = "TeamId = NullIdentifier() or Ticket.TeamId = TeamId"; period = ["FromDate = NullDate() or Ticket.CreatedOn >= FromDate", "ToDate = NullDate() or Ticket.CreatedOn <= ToDate"]
    g1 = a.agg("GetOpen", ["IServerEntity:Ticket"], [team, f"Ticket.StatusId = {S}Open or Ticket.StatusId = {S}New"] + period)
    g2 = a.agg("GetPending", ["IServerEntity:Ticket"], [team, f"Ticket.StatusId = {S}Pending"] + period)
    g3 = a.agg("GetResolved", ["IServerEntity:Ticket"], [team, f"Ticket.StatusId = {S}Resolved"] + period)
    g4 = a.agg("GetClosed", ["IServerEntity:Ticket"], [team, f"Ticket.StatusId = {S}Closed"] + period)
    g5 = a.agg("GetUrgent", ["IServerEntity:Ticket"], [team, f"Ticket.PriorityId = {P}Urgent", f"Ticket.StatusId <> {S}Closed", f"Ticket.StatusId <> {S}Cancelled"])
    g6 = a.agg("GetBreaches", ["IServerEntity:TicketSlaBreach", "IServerEntity:Ticket"], ["TicketSlaBreach.TicketId = Ticket.Id", team] + period)
    g7 = a.agg("GetDone", ["IServerEntity:Ticket"], [team, "Ticket.ResolvedOn <> NullDate()"] + period)
    fe = a.foreach("EachDone", "GetDone.List")
    acc = a.assign("Accumulate", [("SumRes", "SumRes + DiffMinutes(GetDone.List.Current.Ticket.CreatedOn, GetDone.List.Current.Ticket.ResolvedOn)"), ("NRes", "NRes + 1"),
                                  ("SumFirst", "If(GetDone.List.Current.Ticket.FirstRespondedOn = NullDate(), SumFirst, SumFirst + DiffMinutes(GetDone.List.Current.Ticket.CreatedOn, GetDone.List.Current.Ticket.FirstRespondedOn))"),
                                  ("NFirst", "If(GetDone.List.Current.Ticket.FirstRespondedOn = NullDate(), NFirst, NFirst + 1)")])
    fill = a.assign("FillMetrics", [("Metrics.OpenCount", "GetOpen.Count"), ("Metrics.PendingCount", "GetPending.Count"), ("Metrics.ResolvedCount", "GetResolved.Count"), ("Metrics.ClosedCount", "GetClosed.Count"),
                                    ("Metrics.UrgentCount", "GetUrgent.Count"), ("Metrics.SlaBreaches", "GetBreaches.Count"), ("Metrics.Backlog", "GetOpen.Count + GetPending.Count"),
                                    ("Metrics.AvgFirstResponseMinutes", "If(NFirst = 0, 0, SumFirst / NFirst)"), ("Metrics.AvgResolutionMinutes", "If(NRes = 0, 0, SumRes / NRes)")])
    e = a.end(); a.chain(s, g1, g2, g3, g4, g5, g6, g7, fe); a.link(fe, acc, "CycleTarget"); a.link(acc, fe); a.link(fe, fill); a.link(fill, e); a.layout()
    return j


# ---------------------------------------------------------------------------------------------------------------------
# 08 service actions (exposicao remota)
# ---------------------------------------------------------------------------------------------------------------------

def job_services() -> Job:
    j = Job("tickets-08-services", "job:tickets-07-read", "Tickets: service actions para portais e integracoes (create, comment, change status, get)")

    a = Act(j, "Tickets_Create", kind="IServiceAction", desc="Cria um ticket (remoto)")
    for n, t, m in [("Subject", "Text", True), ("Description", "Text", False), ("TypeId", "TicketType Identifier", True), ("CategoryId", "Category Identifier", False), ("PriorityId", "TicketPriority Identifier", False), ("RequesterId", "User Identifier", True)]:
        a.inp(n, t, m)
    a.out("TicketId", "Ticket Identifier"); a.out("Number", "Text")
    s = a.start(); c = a.call("Create", "IServerAction:Ticket_Create", {"Subject": "Subject", "Description": "Description", "TypeId": "TypeId", "ChannelId": "Entities.TicketChannel.API", "CategoryId": "CategoryId", "PriorityId": "PriorityId", "RequesterId": "RequesterId"})
    so = a.assign("SetOutputs", [("TicketId", "Create.TicketId"), ("Number", "Create.Number")]); e = a.end(); a.chain(s, c, so, e); a.layout()

    a = Act(j, "Tickets_Comment", kind="IServiceAction", desc="Comentario publico (remoto)")
    a.inp("TicketId", "Ticket Identifier"); a.inp("AuthorId", "User Identifier"); a.inp("Body", "Text"); a.out("CommentId", "TicketComment Identifier")
    s = a.start(); c = a.call("Comment", "IServerAction:Comment_Add", {"TicketId": "TicketId", "AuthorId": "AuthorId", "Body": "Body", "IsInternal": "False"}); so = a.assign("SetOutput", [("CommentId", "Comment.CommentId")]); e = a.end(); a.chain(s, c, so, e); a.layout()

    a = Act(j, "Tickets_ChangeStatus", kind="IServiceAction", desc="Transicao de status (remoto)")
    a.inp("TicketId", "Ticket Identifier"); a.inp("NewStatusId", "TicketStatus Identifier"); a.inp("ActorId", "User Identifier"); a.inp("Note", "Text", False)
    s = a.start(); c = a.call("Change", "IServerAction:Ticket_ChangeStatus", {"TicketId": "TicketId", "NewStatusId": "NewStatusId", "ActorId": "ActorId", "Note": "Note"}); e = a.end(); a.chain(s, c, e); a.layout()

    a = Act(j, "Tickets_Get", kind="IServiceAction", desc="Ticket com permissoes (remoto)")
    a.inp("TicketId", "Ticket Identifier"); a.inp("ViewerId", "User Identifier"); a.out("Ticket", "Ticket"); a.out("Found", "Boolean"); a.out("CanEdit", "Boolean"); a.out("CanClose", "Boolean")
    s = a.start(); c = a.call("Get", "IServerAction:Ticket_Get", {"TicketId": "TicketId", "ViewerId": "ViewerId"}); so = a.assign("SetOutputs", [("Ticket", "Get.Ticket"), ("Found", "Get.Found"), ("CanEdit", "Get.CanEdit"), ("CanClose", "Get.CanClose")]); e = a.end(); a.chain(s, c, so, e); a.layout()
    return j


if __name__ == "__main__":
    jobs = [job_data(), job_helpers(), job_lifecycle(), job_collab(), job_org(), job_sla(), job_read(), job_services()]
    for job in jobs:
        job.save()
    # job COMPOSTO: o campo jobs concatena as 8 partes (mesma ordem) numa unica transacao => entrega com UM merge
    composite = {
        "description": "App de tickets INTEIRO num job so: o campo jobs concatena os 8 jobs tickets-01..08 (mesma ordem) numa unica transacao, para uma entrega com UM merge; e o mesmo conteudo dos 8 jobs, sem copiar ops",
        "base": "tests/fixtures/blank-service.oml",
        "jobs": ["job:" + job.name for job in jobs],
        "expectValid": True,
        "expectedMessages": EXPECTED["tickets-all"],
    }
    (OUT / "tickets-all.json").write_text(json.dumps(composite, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print("tickets-all.json (composto):", len(jobs), "partes")
