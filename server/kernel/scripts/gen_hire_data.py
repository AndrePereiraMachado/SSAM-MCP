"""Generate the reviewed Hire recruitment data model and its data dictionary.

Run with Python; output is one deterministic job, delivered as one Studio merge.
No environment access, publication, sample candidates, or business actions.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENTITIES: list[dict] = []
STATICS: list[dict] = []


def catalog(name: str, records: str):
    STATICS.append({"name": name, "public": True,
                    "description": f"Hire: catálogo de {name}; os nomes dos registros são contratos estáveis.",
                    "records": [{"name": r.split("=")[0], "label": r.split("=")[-1]} for r in records.split("|")]})


def a(name, kind="Text", required=False, length=None, default=None, description=None):
    item = {"name": name, "type": kind, "mandatory": required}
    if length is not None: item["length"] = length
    if default is not None: item["default"] = default
    if description: item["description"] = description
    return item


def t(name, length=200, required=False): return a(name, required=required, length=length)
def fk(name, target, required=True, default=None):
    return a(name, target + " Identifier", required, default=f"Entities.{target}.{default}" if default else None)
def flag(name, default=False): return a(name, "Boolean", True, default="True" if default else "False")
def num(name, default=None, required=False): return a(name, "Integer", required, default=str(default) if default is not None else None)
def money(name): return a(name, "Currency")
def dec(name): return a(name, "Decimal")
def dt(name, required=False, now=False): return a(name, "Date Time", required, default="CurrDateTime()" if now else None)
def date(name, required=False): return a(name, "Date", required)
def user(name, required=False): return fk(name, "User", required)
def org(): return fk("OrganizationId", "Organization")


def entity(name, group, description, attrs, *, immutable=False, unique=(), indexes=()):
    names = {x["name"] for x in attrs}
    audit = [dt("CreatedAt", True, True), user("CreatedByUserId")]
    if not immutable: audit += [dt("UpdatedAt", True, True), user("UpdatedByUserId")]
    attrs += [x for x in audit if x["name"] not in names]
    ENTITIES.append({"name": name, "group": group, "description": description,
                     "attributes": attrs, "unique": list(unique), "indexes": list(indexes)})


catalog("MemberRole", "Administrator=Administrador|Recruiter=Recrutador|HiringManager=Gestor contratante|Interviewer=Entrevistador")
catalog("JobTeamRole", "LeadRecruiter=Recrutador responsável|Recruiter=Recrutador|HiringManager=Gestor contratante|Interviewer=Entrevistador")
catalog("EmploymentType", "Permanent=Efetivo|FixedTerm=Prazo determinado|Contractor=Prestador de serviços|Internship=Estágio|Apprenticeship=Aprendiz|Temporary=Temporário")
catalog("WorkMode", "Onsite=Presencial|Hybrid=Híbrido|Remote=Remoto")
catalog("Seniority", "Intern=Estagiário|Junior=Júnior|MidLevel=Pleno|Senior=Sênior|Lead=Liderança técnica|Manager=Gerência|Executive=Executivo")
catalog("JobStatus", "Draft=Rascunho|PendingApproval=Aguardando aprovação|Open=Aberta|Paused=Pausada|Closed=Encerrada|Cancelled=Cancelada")
catalog("PayPeriod", "Hourly=Hora|Daily=Dia|Monthly=Mês|Yearly=Ano")
catalog("ApprovalStatus", "Pending=Pendente|Approved=Aprovada|Rejected=Rejeitada|Cancelled=Cancelada")
catalog("PublicationStatus", "Draft=Rascunho|Published=Publicada|Expired=Expirada|Withdrawn=Retirada|Failed=Falhou")
catalog("ContactType", "Email=E-mail|Mobile=Celular|Phone=Telefone")
catalog("LinkType", "LinkedIn=LinkedIn|Portfolio=Portfólio|GitHub=GitHub|Website=Site|Other=Outro")
catalog("EducationLevel", "Secondary=Ensino médio|Technical=Técnico|Associate=Tecnólogo|Bachelor=Graduação|Specialization=Especialização|Master=Mestrado|Doctorate=Doutorado")
catalog("ProficiencyLevel", "Beginner=Iniciante|Intermediate=Intermediário|Advanced=Avançado|Expert=Especialista")
catalog("LanguageLevel", "Basic=Básico|Intermediate=Intermediário|Advanced=Avançado|Fluent=Fluente|Native=Nativo")
catalog("DocumentType", "Resume=Currículo|CoverLetter=Carta de apresentação|Portfolio=Portfólio|Certificate=Certificado|Other=Outro")
catalog("SourceType", "CareerSite=Portal de carreiras|JobBoard=Portal de vagas|Referral=Indicação|Agency=Agência|Sourcing=Busca ativa|Event=Evento|Other=Outro")
catalog("StageType", "Screening=Triagem|Interview=Entrevista|Assessment=Teste|ReferenceCheck=Referências|Offer=Proposta|Other=Outra")
catalog("ApplicationStatus", "Active=Ativa|Rejected=Rejeitada|Withdrawn=Retirada pelo candidato|Hired=Contratada|Cancelled=Cancelada")
catalog("NoteVisibility", "RecruitingTeam=Equipe de recrutamento|HiringTeam=Equipe da vaga|AuthorOnly=Somente autor")
catalog("OutcomeType", "Rejection=Rejeição|Withdrawal=Desistência|Cancellation=Cancelamento|Hiring=Contratação")
catalog("AnswerType", "ShortText=Texto curto|LongText=Texto longo|Number=Número|Date=Data|Boolean=Sim ou não|SingleChoice=Escolha única|MultipleChoice=Múltipla escolha")
catalog("InterviewType", "Phone=Telefone|Video=Vídeo|Onsite=Presencial")
catalog("InterviewStatus", "Scheduled=Agendada|Confirmed=Confirmada|Completed=Concluída|Cancelled=Cancelada|NoShow=Não compareceu")
catalog("ParticipantRole", "Lead=Responsável|Interviewer=Entrevistador|Observer=Observador")
catalog("ParticipantResponse", "Pending=Pendente|Accepted=Aceito|Declined=Recusado|Tentative=Provisório")
catalog("EvaluationStatus", "Draft=Rascunho|Submitted=Enviada|Voided=Invalidada")
catalog("Recommendation", "StrongNo=Não recomendado|No=Pouco recomendado|Undecided=Indeciso|Yes=Recomendado|StrongYes=Muito recomendado")
catalog("AssessmentType", "Technical=Técnico|CaseStudy=Estudo de caso|Language=Idioma|WorkSample=Amostra de trabalho|Other=Outro")
catalog("AssessmentStatus", "Pending=Pendente|Invited=Convidado|InProgress=Em andamento|Completed=Concluído|Expired=Expirado|Cancelled=Cancelado")
catalog("OfferStatus", "Draft=Rascunho|PendingApproval=Aguardando aprovação|Approved=Aprovada|Sent=Enviada|Accepted=Aceita|Declined=Recusada|Expired=Expirada|Withdrawn=Retirada")
catalog("OfferResponse", "Accepted=Aceita|Declined=Recusada|Negotiation=Negociação solicitada")
catalog("HireStatus", "Confirmed=Confirmada|Started=Iniciada|Withdrawn=Desistência antes do início|Cancelled=Cancelada")
catalog("TaskStatus", "Open=Aberta|InProgress=Em andamento|Done=Concluída|Cancelled=Cancelada")
catalog("TaskPriority", "Low=Baixa|Normal=Normal|High=Alta|Urgent=Urgente")
catalog("CommunicationChannel", "Email=E-mail|Phone=Telefone|SMS=SMS|WhatsApp=WhatsApp|Portal=Portal")
catalog("CommunicationDirection", "Inbound=Recebida|Outbound=Enviada")
catalog("DeliveryStatus", "Draft=Rascunho|Queued=Na fila|Sent=Enviada|Delivered=Entregue|Received=Recebida|Failed=Falhou|Cancelled=Cancelada")
catalog("NotificationType", "Application=Candidatura|Interview=Entrevista|Evaluation=Avaliação|Offer=Proposta|Task=Tarefa|Privacy=Privacidade|System=Sistema")
catalog("PrivacyPurpose", "Recruitment=Processo seletivo|TalentPool=Banco de talentos|Communication=Comunicação")
catalog("PrivacyAction", "Acknowledged=Ciência registrada|OptedIn=Adesão registrada|OptedOut=Recusa registrada|Withdrawn=Escolha revogada")
catalog("DataRequestType", "Access=Acesso|Correction=Correção|Deletion=Exclusão|Export=Exportação|Restriction=Restrição")
catalog("DataRequestStatus", "Received=Recebida|InReview=Em análise|InProgress=Em execução|Completed=Concluída|Declined=Indeferida|Cancelled=Cancelada")
catalog("RecordCategory", "CandidateProfile=Perfil do candidato|Application=Candidatura|Document=Documento|Communication=Comunicação|Audit=Auditoria")
catalog("RetentionTrigger", "CandidateArchived=Candidato arquivado|ApplicationClosed=Candidatura encerrada|LastActivity=Última atividade|RecordCreated=Criação do registro")
catalog("DispositionAction", "Review=Revisão manual|Anonymize=Anonimização|Delete=Exclusão")
catalog("IntegrationStatus", "Pending=Pendente|Processing=Em processamento|Succeeded=Concluído|Retry=Nova tentativa|Failed=Falha definitiva")

G = "Empresa e equipe"
entity("Organization", G, "Empresa contratante e fronteira de acesso aos dados.", [t("Name",200,True),t("LegalName",250),t("ExternalCode",50),flag("IsActive",True)])
entity("Department", G, "Área organizacional; ParentDepartmentId deve pertencer à mesma empresa, sem ciclos.", [org(),t("Name",150,True),fk("ParentDepartmentId","Department",False),flag("IsActive",True)], unique=["OrganizationId,Name"])
entity("WorkLocation", G, "Local de trabalho; CountryCode ISO e TimeZone IANA, validados nas actions.", [org(),t("Name",150,True),t("CountryCode",2,True),t("Region",100),t("City",150),t("TimeZone",100,True),flag("IsActive",True)], unique=["OrganizationId,Name"])
entity("OrganizationMember", G, "Vínculo do usuário interno com a empresa.", [org(),user("UserId",True),flag("IsActive",True)], unique=["OrganizationId,UserId"])
entity("OrganizationMemberRole", G, "Perfis cumulativos do membro; a autorização será aplicada pelas actions.", [fk("OrganizationMemberId","OrganizationMember"),fk("MemberRoleId","MemberRole")], unique=["OrganizationMemberId,MemberRoleId"])
entity("JobTeamMember", G, "Equipe da vaga; membro e vaga devem pertencer à mesma empresa.", [fk("JobOpeningId","JobOpening"),fk("OrganizationMemberId","OrganizationMember"),fk("JobTeamRoleId","JobTeamRole")], unique=["JobOpeningId,OrganizationMemberId,JobTeamRoleId"])

G = "Vagas"
entity("JobOpening",G,"Vaga com uma ou mais posições; Headcount deve ser positivo. Estado independente da publicação.", [org(),fk("DepartmentId","Department"),fk("PrimaryLocationId","WorkLocation",False),t("Code",50,True),t("Title",200,True),t("Description",12000),t("Responsibilities",10000),t("Requirements",10000),fk("EmploymentTypeId","EmploymentType"),fk("WorkModeId","WorkMode"),fk("SeniorityId","Seniority",False),fk("StatusId","JobStatus",default="Draft"),num("Headcount",1,True),fk("HiringManagerMemberId","OrganizationMember",False),fk("RecruiterMemberId","OrganizationMember",False),dt("OpenedAt"),date("TargetStartDate"),dt("ClosedAt")],unique=["OrganizationId,Code"],indexes=["OrganizationId,StatusId","RecruiterMemberId,StatusId"])
entity("JobCompensation",G,"Faixa remuneratória restrita; mínimo <= máximo; divulgação opcional.",[fk("JobOpeningId","JobOpening"),money("MinimumAmount"),money("MaximumAmount"),t("CurrencyCode",3,True),fk("PayPeriodId","PayPeriod"),flag("IsPublic")],unique=["JobOpeningId"])
entity("JobLocation",G,"Locais adicionais aceitos para a vaga.",[fk("JobOpeningId","JobOpening"),fk("WorkLocationId","WorkLocation")],unique=["JobOpeningId,WorkLocationId"])
entity("JobSkill",G,"Competência exigida; peso não negativo.",[fk("JobOpeningId","JobOpening"),fk("SkillId","Skill"),fk("MinimumLevelId","ProficiencyLevel",False),flag("IsRequired"),dec("Weight")],unique=["JobOpeningId,SkillId"])
entity("JobApproval",G,"Aprovação sequencial da abertura da vaga.",[fk("JobOpeningId","JobOpening"),num("Sequence",1,True),fk("ApproverMemberId","OrganizationMember"),fk("StatusId","ApprovalStatus",default="Pending"),dt("RequestedAt",True,True),dt("DecidedAt"),t("Comment",4000)],unique=["JobOpeningId,Sequence"])
entity("JobPublication",G,"Publicação da vaga em um canal; preserva referência externa e histórico.",[fk("JobOpeningId","JobOpening"),fk("RecruitmentSourceId","RecruitmentSource"),t("ExternalReference",200),t("PublicUrl",2000),dt("PublishedAt"),dt("ExpiresAt"),fk("StatusId","PublicationStatus",default="Draft")],indexes=["JobOpeningId,StatusId"])

G = "Talentos"
entity("Candidate",G,"Pessoa no contexto da empresa; conta de acesso opcional; sem compartilhamento automático entre empresas.",[org(),user("UserId"),t("FullName",200,True),t("PreferredName",150),t("CountryCode",2),t("Region",100),t("City",150),t("ProfessionalSummary",10000),t("CurrentTitle",200),date("AvailabilityDate"),fk("CreatedSourceId","RecruitmentSource",False),flag("IsArchived")],indexes=["OrganizationId,FullName","OrganizationId,IsArchived","UserId"])
entity("CandidateContact",G,"Contato normalizado; um contato principal por tipo será garantido na action.",[fk("CandidateId","Candidate"),fk("ContactTypeId","ContactType"),t("Value",320,True),t("NormalizedValue",320,True),flag("IsPrimary"),dt("VerifiedAt")],unique=["CandidateId,ContactTypeId,NormalizedValue"],indexes=["NormalizedValue"])
entity("CandidateLink",G,"Perfil profissional ou portfólio público informado pelo candidato.",[fk("CandidateId","Candidate"),fk("LinkTypeId","LinkType"),t("Url",2000,True),t("Label",200)])
entity("CandidateExperience",G,"Experiência profissional; datas e cargo atual precisam ser consistentes.",[fk("CandidateId","Candidate"),t("CompanyName",200,True),t("JobTitle",200,True),date("StartedOn",True),date("EndedOn"),flag("IsCurrent"),t("Description",8000)])
entity("CandidateEducation",G,"Formação acadêmica.",[fk("CandidateId","Candidate"),t("Institution",200,True),t("Course",200,True),fk("EducationLevelId","EducationLevel"),date("StartedOn"),date("CompletedOn"),flag("IsInProgress")])
entity("CandidateSkill",G,"Competência declarada pelo candidato; anos não negativos.",[fk("CandidateId","Candidate"),fk("SkillId","Skill"),fk("ProficiencyLevelId","ProficiencyLevel",False),dec("YearsOfExperience")],unique=["CandidateId,SkillId"])
entity("CandidateLanguage",G,"Idioma informado; LanguageCode deve usar código padronizado.",[fk("CandidateId","Candidate"),t("LanguageCode",10,True),fk("ProficiencyLevelId","LanguageLevel")],unique=["CandidateId,LanguageCode"])
entity("CandidateCertification",G,"Certificação profissional; expiração opcional.",[fk("CandidateId","Candidate"),t("Name",200,True),t("Issuer",200),date("IssuedOn"),date("ExpiresOn"),t("CredentialUrl",2000)])
entity("CandidatePreference",G,"Preferências profissionais atuais do candidato.",[fk("CandidateId","Candidate"),t("DesiredTitle",200),fk("EmploymentTypeId","EmploymentType",False),fk("WorkModeId","WorkMode",False),money("SalaryExpectation"),t("CurrencyCode",3),fk("PayPeriodId","PayPeriod",False),flag("WillingToRelocate")],unique=["CandidateId"])
entity("CandidateDocument",G,"Metadados de arquivo versionado; conteúdo em armazenamento protegido; não sobrescrever versões usadas.",[fk("CandidateId","Candidate"),fk("DocumentTypeId","DocumentType"),t("FileName",255,True),t("MimeType",150,True),a("SizeBytes","Long Integer",True),t("StorageKey",500,True),t("Checksum",128),num("Version",1,True),dt("UploadedAt",True,True)],immutable=True)
entity("TalentPool",G,"Banco de talentos administrado pela empresa.",[org(),t("Name",150,True),t("Description",4000),fk("OwnerMemberId","OrganizationMember"),flag("IsActive",True)],unique=["OrganizationId,Name"])
entity("TalentPoolCandidate",G,"Participação do candidato no banco da mesma empresa.",[fk("TalentPoolId","TalentPool"),fk("CandidateId","Candidate"),fk("AddedByMemberId","OrganizationMember",False),dt("AddedAt",True,True),t("Note",4000)],unique=["TalentPoolId,CandidateId"])
entity("Tag",G,"Etiqueta configurável da empresa.",[org(),t("Name",80,True),t("Color",7),flag("IsActive",True)],unique=["OrganizationId,Name"])
entity("CandidateTag",G,"Etiqueta aplicada ao candidato da mesma empresa.",[fk("CandidateId","Candidate"),fk("TagId","Tag")],unique=["CandidateId,TagId"])

G = "Processo seletivo"
entity("RecruitmentSource",G,"Canal de origem configurável da empresa.",[org(),t("Name",150,True),fk("SourceTypeId","SourceType"),flag("IsActive",True)],unique=["OrganizationId,Name"])
entity("PipelineTemplate",G,"Versão do modelo de processo; copiar etapas para a vaga ao instanciar.",[org(),t("Name",150,True),num("Version",1,True),flag("IsActive",True)],unique=["OrganizationId,Name,Version"])
entity("PipelineTemplateStage",G,"Etapa ordenada do template de processo.",[fk("PipelineTemplateId","PipelineTemplate"),t("Name",100,True),fk("StageTypeId","StageType"),num("Sequence",1,True),num("TargetDays")],unique=["PipelineTemplateId,Sequence"])
entity("JobStage",G,"Etapa própria da vaga; não é alterada por mudanças posteriores no template.",[fk("JobOpeningId","JobOpening"),t("Name",100,True),fk("StageTypeId","StageType"),num("Sequence",1,True),num("TargetDays"),flag("IsActive",True)],unique=["JobOpeningId,Sequence"])
entity("Application",G,"Candidatura por tentativa; apenas uma tentativa ativa por candidato/vaga, garantida na action sob lock.",[fk("CandidateId","Candidate"),fk("JobOpeningId","JobOpening"),num("AttemptNumber",1,True),fk("CurrentStageId","JobStage"),fk("StatusId","ApplicationStatus",default="Active"),fk("RecruitmentSourceId","RecruitmentSource",False),fk("OwnerMemberId","OrganizationMember",False),dt("SubmittedAt",True,True),dt("ClosedAt"),fk("OutcomeReasonId","OutcomeReason",False),user("ReferredByUserId")],unique=["CandidateId,JobOpeningId,AttemptNumber"],indexes=["JobOpeningId,StatusId,CurrentStageId","OwnerMemberId,StatusId","SubmittedAt"])
entity("ApplicationStageHistory",G,"Histórico imutável de transições; gravar junto com Application na mesma transação.",[fk("ApplicationId","Application"),fk("FromStageId","JobStage",False),fk("ToStageId","JobStage"),dt("ChangedAt",True,True),user("ChangedByUserId"),t("Reason",4000)],immutable=True,indexes=["ApplicationId,ChangedAt"])
entity("ApplicationStatusHistory",G,"Histórico imutável de situação e motivo; preserva a etapa da saída.",[fk("ApplicationId","Application"),fk("FromStatusId","ApplicationStatus",False),fk("ToStatusId","ApplicationStatus"),fk("OutcomeReasonId","OutcomeReason",False),dt("ChangedAt",True,True),user("ChangedByUserId"),t("Comment",4000)],immutable=True,indexes=["ApplicationId,ChangedAt"])
entity("ApplicationDocument",G,"Versão do documento apresentada na candidatura; mesmo candidato em ambos os lados.",[fk("ApplicationId","Application"),fk("CandidateDocumentId","CandidateDocument")],unique=["ApplicationId,CandidateDocumentId"])
entity("ApplicationNote",G,"Anotação interna; visibilidade aplicada pelo serviço, nunca diretamente por filtro na UI.",[fk("ApplicationId","Application"),fk("AuthorMemberId","OrganizationMember"),t("Body",10000,True),fk("VisibilityId","NoteVisibility",default="RecruitingTeam")])
entity("OutcomeReason",G,"Motivo de encerramento configurável da empresa.",[org(),fk("OutcomeTypeId","OutcomeType"),t("Name",200,True),flag("IsActive",True)],unique=["OrganizationId,OutcomeTypeId,Name"])

G = "Entrevistas e avaliações"
entity("JobQuestion",G,"Pergunta de inscrição; preservar texto/tipo após receber respostas.",[fk("JobOpeningId","JobOpening"),t("Label",1000,True),fk("AnswerTypeId","AnswerType"),flag("IsRequired"),num("Sequence",1,True),flag("IsActive",True)],unique=["JobOpeningId,Sequence"])
entity("JobQuestionOption",G,"Alternativa da pergunta; preservar após receber respostas.",[fk("JobQuestionId","JobQuestion"),t("Label",1000,True),num("Sequence",1,True),flag("IsActive",True)],unique=["JobQuestionId,Sequence"])
entity("ApplicationAnswer",G,"Resposta tipada; somente o campo compatível com AnswerType pode ser preenchido.",[fk("ApplicationId","Application"),fk("JobQuestionId","JobQuestion"),t("TextValue",10000),dec("NumberValue"),date("DateValue"),a("BooleanValue","Boolean"),dt("AnsweredAt",True,True)],unique=["ApplicationId,JobQuestionId"])
entity("ApplicationAnswerOption",G,"Alternativa selecionada; opção deve pertencer à pergunta respondida.",[fk("ApplicationAnswerId","ApplicationAnswer"),fk("JobQuestionOptionId","JobQuestionOption")],unique=["ApplicationAnswerId,JobQuestionOptionId"])
entity("Interview",G,"Entrevista; horários UTC e fuso IANA; término posterior ao início.",[fk("ApplicationId","Application"),fk("JobStageId","JobStage"),fk("InterviewTypeId","InterviewType"),fk("StatusId","InterviewStatus",default="Scheduled"),dt("StartsAtUtc",True),dt("EndsAtUtc",True),t("TimeZone",100,True),t("Location",500),t("MeetingUrl",2000),t("Instructions",8000)],indexes=["StatusId,StartsAtUtc","ApplicationId,StartsAtUtc"])
entity("InterviewParticipant",G,"Entrevistador ou observador da entrevista.",[fk("InterviewId","Interview"),fk("OrganizationMemberId","OrganizationMember"),fk("ParticipantRoleId","ParticipantRole",default="Interviewer"),fk("ResponseStatusId","ParticipantResponse",default="Pending")],unique=["InterviewId,OrganizationMemberId"],indexes=["OrganizationMemberId"])
entity("ScorecardTemplate",G,"Modelo versionado de avaliação; versão utilizada torna-se imutável.",[org(),t("Name",150,True),num("Version",1,True),flag("IsActive",True)],unique=["OrganizationId,Name,Version"])
entity("ScorecardCriterion",G,"Critério e escala de notas; pesos não negativos e mínimo <= máximo.",[fk("ScorecardTemplateId","ScorecardTemplate"),t("Name",150,True),t("Description",4000),dec("Weight"),dec("MinimumScore"),dec("MaximumScore"),num("Sequence",1,True),flag("IsRequired",True)],unique=["ScorecardTemplateId,Sequence"])
entity("Evaluation",G,"Avaliação individual; validar completude ao enviar; impedir edição após submissão.",[fk("ApplicationId","Application"),fk("InterviewId","Interview",False),fk("ScorecardTemplateId","ScorecardTemplate"),fk("EvaluatorMemberId","OrganizationMember"),fk("StatusId","EvaluationStatus",default="Draft"),fk("RecommendationId","Recommendation",False),t("Summary",10000),dt("SubmittedAt")],indexes=["ApplicationId,StatusId","EvaluatorMemberId,StatusId"])
entity("EvaluationScore",G,"Nota individual do critério, pertencente à versão de scorecard da avaliação.",[fk("EvaluationId","Evaluation"),fk("ScorecardCriterionId","ScorecardCriterion"),dec("Score"),t("Comment",4000)],unique=["EvaluationId,ScorecardCriterionId"])
entity("Assessment",G,"Teste ou desafio associado à candidatura; integração externa opcional.",[fk("ApplicationId","Application"),fk("AssessmentTypeId","AssessmentType"),t("Title",200,True),t("Provider",150),t("ExternalReference",200),fk("StatusId","AssessmentStatus",default="Pending"),dt("DueAt"),dt("CompletedAt"),dec("Score"),dec("MaximumScore"),t("ResultUrl",2000)])

G = "Propostas e contratação"
entity("Offer",G,"Proposta com versões preservadas; CurrentVersionNumber aponta para versão do mesmo Offer.",[fk("ApplicationId","Application"),fk("StatusId","OfferStatus",default="Draft"),num("CurrentVersionNumber",1,True),fk("CreatedByMemberId","OrganizationMember")],indexes=["ApplicationId,StatusId"])
entity("OfferVersion",G,"Condições de uma versão; congelar ao enviar; não reutilizar aprovação de outra versão.",[fk("OfferId","Offer"),num("VersionNumber",1,True),t("JobTitle",200,True),fk("EmploymentTypeId","EmploymentType"),fk("WorkLocationId","WorkLocation",False),fk("WorkModeId","WorkMode"),money("SalaryAmount"),t("CurrencyCode",3,True),fk("PayPeriodId","PayPeriod"),date("StartDate",True),dt("ExpiresAt"),t("Terms",20000),dt("SentAt"),dt("RespondedAt"),fk("CandidateResponseId","OfferResponse",False)],unique=["OfferId,VersionNumber"])
entity("Benefit",G,"Benefício configurável da empresa.",[org(),t("Name",150,True),t("Description",4000),flag("IsActive",True)],unique=["OrganizationId,Name"])
entity("OfferVersionBenefit",G,"Benefícios de uma versão específica da proposta.",[fk("OfferVersionId","OfferVersion"),fk("BenefitId","Benefit"),t("Description",4000),money("Amount")],unique=["OfferVersionId,BenefitId"])
entity("OfferApproval",G,"Aprovação de uma versão específica de proposta.",[fk("OfferVersionId","OfferVersion"),fk("ApproverMemberId","OrganizationMember"),num("Sequence",1,True),fk("StatusId","ApprovalStatus",default="Pending"),dt("DecidedAt"),t("Comment",4000)],unique=["OfferVersionId,Sequence"])
entity("Hire",G,"Contratação confirmada e início efetivo; proposta aceita deve pertencer à mesma candidatura.",[fk("ApplicationId","Application"),fk("AcceptedOfferVersionId","OfferVersion"),fk("StatusId","HireStatus",default="Confirmed"),date("ExpectedStartDate",True),date("ActualStartDate"),t("ExternalEmployeeId",100),dt("ConfirmedAt",True,True)],unique=["ApplicationId","AcceptedOfferVersionId"])
entity("HireChecklistItem",G,"Pendência de admissão.",[fk("HireId","Hire"),t("Title",250,True),fk("OwnerMemberId","OrganizationMember",False),dt("DueAt"),fk("StatusId","TaskStatus",default="Open"),dt("CompletedAt")],indexes=["OwnerMemberId,StatusId,DueAt"])

G = "Operação e governança"
entity("RecruitmentTask",G,"Tarefa; os contextos opcionais informados devem ser coerentes e da mesma empresa.",[org(),fk("ApplicationId","Application",False),fk("CandidateId","Candidate",False),fk("JobOpeningId","JobOpening",False),t("Title",250,True),fk("AssignedToMemberId","OrganizationMember",False),dt("DueAt"),fk("PriorityId","TaskPriority",default="Normal"),fk("StatusId","TaskStatus",default="Open"),dt("CompletedAt")],indexes=["OrganizationId,StatusId,DueAt","AssignedToMemberId,StatusId,DueAt"])
entity("CommunicationTemplate",G,"Modelo de mensagem configurável; envio depende de action futura.",[org(),t("Name",150,True),fk("ChannelId","CommunicationChannel"),t("Subject",500),t("Body",20000,True),flag("IsActive",True)],unique=["OrganizationId,Name,ChannelId"])
entity("CandidateCommunication",G,"Histórico de contato; proteger conteúdo e identificadores de provedor.",[fk("CandidateId","Candidate"),fk("ApplicationId","Application",False),fk("ChannelId","CommunicationChannel"),fk("DirectionId","CommunicationDirection"),t("Subject",500),t("Body",20000),fk("DeliveryStatusId","DeliveryStatus",default="Draft"),t("ProviderMessageId",250),dt("SentAt"),user("SentByUserId")],indexes=["CandidateId,CreatedAt","ApplicationId,CreatedAt"])
entity("Notification",G,"Aviso interno destinado a um usuário; leitura por destinatário.",[org(),user("UserId",True),fk("TypeId","NotificationType"),t("Title",250,True),fk("ApplicationId","Application",False),fk("JobOpeningId","JobOpening",False),dt("ReadAt")],indexes=["OrganizationId,UserId,ReadAt,CreatedAt"])
entity("PrivacyNoticeVersion",G,"Versão imutável do texto apresentado; não define base jurídica automaticamente.",[org(),t("Version",40,True),t("Content",40000,True),dt("EffectiveAt",True)],immutable=True,unique=["OrganizationId,Version"])
entity("CandidatePrivacyRecord",G,"Registro imutável da ciência/escolha por finalidade e versão do texto.",[fk("CandidateId","Candidate"),fk("PrivacyNoticeVersionId","PrivacyNoticeVersion"),fk("PurposeId","PrivacyPurpose"),fk("ActionId","PrivacyAction"),dt("RecordedAt",True,True),t("Source",200)],immutable=True,indexes=["CandidateId,PurposeId,RecordedAt"])
entity("CandidateDataRequest",G,"Solicitação de dados pessoais; decisão, prazos e execução em fluxo futuro.",[fk("CandidateId","Candidate"),fk("RequestTypeId","DataRequestType"),fk("StatusId","DataRequestStatus",default="Received"),dt("RequestedAt",True,True),fk("AssignedToMemberId","OrganizationMember",False),dt("CompletedAt")],indexes=["StatusId,RequestedAt"])
entity("DataRetentionPolicy",G,"Política configurável; nenhum prazo ou expurgo automático é ativado nesta entrega.",[org(),fk("RecordCategoryId","RecordCategory"),num("RetentionDays",required=True),fk("TriggerEventId","RetentionTrigger"),fk("DispositionActionId","DispositionAction",default="Review"),flag("IsActive")],unique=["OrganizationId,RecordCategoryId,TriggerEventId"])
entity("AuditEvent",G,"Evento imutável; registrar campos alterados sem copiar valores pessoais sensíveis.",[org(),user("ActorUserId"),t("Action",100,True),t("EntityType",100,True),t("RecordIdentifier",100,True),dt("OccurredAt",True,True),t("CorrelationId",100),t("ChangedFields",10000)],immutable=True,indexes=["OrganizationId,OccurredAt","EntityType,RecordIdentifier"])
entity("IntegrationEvent",G,"Outbox de integração; sem chamadas externas nesta entrega; payload protegido.",[org(),t("EventType",100,True),t("Payload",50000,True),t("IdempotencyKey",150,True),fk("StatusId","IntegrationStatus",default="Pending"),num("AttemptCount",0,True),dt("NextAttemptAt"),dt("ProcessedAt"),t("LastError",8000)],unique=["OrganizationId,IdempotencyKey"],indexes=["StatusId,NextAttemptAt"])
entity("Skill","Catálogos configuráveis","Competência usada nos requisitos da vaga e no perfil do candidato.",[org(),t("Name",150,True),t("Category",100),flag("IsActive",True)],unique=["OrganizationId,Name"])


def build():
    assert len(ENTITIES) == 65, len(ENTITIES)
    names = {e["name"] for e in ENTITIES}
    static_names = {s["name"] for s in STATICS}
    assert len(names) == len(ENTITIES) and len(static_names) == len(STATICS)
    assert not names & static_names
    # Every entity/identifier exists before any foreign key is assigned, including self references.
    ops = [{"op": "spec", "data": {"static": STATICS, "entities": [
        {"name": e["name"], "public": True, "readOnly": True, "description": e["description"]}
        for e in ENTITIES]}}]
    for e in ENTITIES:
        ops.append({"op":"set","target":"$"+e["name"],"prop":"UpdateBehavior","value":"Optimized"})
        assert len({x["name"] for x in e["attributes"]}) == len(e["attributes"]), e["name"]
        for attr in e["attributes"]:
            al = f"${e['name']}.{attr['name']}"
            kind = attr["type"]
            if kind.endswith(" Identifier"):
                assert kind[:-11] in names | static_names | {"User"}, (e["name"], attr)
            ops.append({"op":"create","parent":"$"+e["name"],"type":"IEntityAttribute","name":attr["name"],"as":al})
            props = {"DataType":kind,"IsMandatory":attr["mandatory"]}
            for key, prop in (("length","Length"),("default","DefaultValue"),("description","Description")):
                if key in attr: props[prop] = attr[key]
            if kind.endswith(" Identifier"): props["DeleteRule"] = "Ignore" if kind == "User Identifier" else "Protect"
            if kind in ("Currency", "Decimal"): props.update(Length=18, Decimals=2 if kind == "Currency" else 4)
            for prop, value in props.items():ops.append({"op":"set","target":al,"prop":prop,"value":value})
        for fields in e["unique"] + e["indexes"]:
            assert set(fields.split(",")) <= {x["name"] for x in e["attributes"]}, (e["name"],fields)
    for e in ENTITIES:
        for unique, fields_list in ((True, e["unique"]), (False, e["indexes"])):
            for i, fields in enumerate(fields_list, 1):
                ops.append({"op":"create", "parent":"$"+e["name"], "type":"EntityIndex",
                    "name":("UQ_" if unique else "IX_")+str(i).zfill(2),
                    "args":{"unique":unique,"attributes":[f"${e['name']}.{field}" for field in fields.split(",")]}})
    return {"description":f"Hire: 65 entidades de recrutamento e {len(STATICS)} static entities; dados, FKs, defaults e auditoria. Sem actions ou publicação.",
            "base":"tests/fixtures/blank-service.oml","expectValid":True,"expectedMessages":[],"ops":ops}


def documentation():
    lines = ["# Hire — dicionário do modelo de dados", "", f"65 entidades de negócio e {len(STATICS)} static entities. Gerado por `scripts/gen_hire_data.py`.", "",
             "Job único: `tests/jobs/hire-data-model.json`. O merge não publica o módulo.", "",
             "## Convenções", "", "- Id: Long Integer AutoNumber; entidades públicas com ExposeReadOnly. Apenas actions do Hire_CS poderão escrever por contrato entre módulos.",
             "- ExposeReadOnly não implementa autorização por linha. Serviços futuros devem verificar usuário, organização, equipe e visibilidade antes de devolver dados.",
             "- Todas as relações de negócio usam Identifier + DeleteRule Protect. Relações com User usam Ignore para preservar autoria histórica; desativar usuários em vez de depender de exclusão em cascata.",
             "- CreatedAt/UpdatedAt têm default CurrDateTime(); UpdatedAt deve ser atualizado explicitamente em cada escrita futura. Autorias permitem operações de sistema sem usuário.",
             "- Textos têm tamanho explícito; valores monetários usam Currency(18,2), notas e pesos Decimal(18,4). Datas civis usam Date; instantes usam Date Time em UTC.",
             "- Campo opcional no modelo O11 usa o valor nulo/padrão da plataforma. Ausência de resposta booleana é ausência de ApplicationAnswer, não BooleanValue=False.",
             "- A entrega é somente de dados. Actions futuras implementarão autorização, transações de histórico, validações entre empresas, intervalos de datas/notas, uma candidatura ativa por vaga, imutabilidade após envio e execução de retenção.",
             "- Arquivos são representados por metadados/StorageKey. Nenhum provedor de armazenamento ou envio de mensagens é ativado.", "",
             "## Índices materializados", "", "Índices únicos (UQ) e de consulta (IX) criados no modelo. A restrição condicional de uma candidatura ativa continua sendo responsabilidade da action transacional.", ""]
    for e in ENTITIES:
        if e["unique"] or e["indexes"]:
            lines.append(f"- **{e['name']}** — únicos: {'; '.join(e['unique']) or '—'}; consulta: {'; '.join(e['indexes']) or '—'}.")
    last = None
    for e in ENTITIES:
        if e["group"] != last:lines += ["", "## "+e["group"], ""];last=e["group"]
        lines += ["### "+e["name"], "",e["description"],"","| Campo | Tipo | Obrigatório | Tamanho / default |","|---|---|---|---|", "| Id | Long Integer Identifier | Sim | AutoNumber |"]
        for x in e["attributes"]:
            info = str(x.get("length", ""))
            if "default" in x: info += (" / " if info else "") + "`" + x["default"] + "`"
            lines.append(f"| {x['name']} | {x['type']} | {'Sim' if x['mandatory'] else 'Não'} | {info} |")
    lines += ["", "## Static entities", "", "Todas possuem Id Integer AutoNumber, Label e Order. Os códigos dos registros não devem ser renomeados depois de usados.", ""]
    for s in STATICS:lines.append(f"- **{s['name']}**: " + "; ".join(f"`{r['name']}` ({r['label']})" for r in s["records"]) + ".")
    return "\n".join(lines)+"\n"


if __name__ == "__main__":
    job = build()
    (ROOT/"tests/jobs/hire-data-model.json").write_text(json.dumps(job,ensure_ascii=False,indent=1)+"\n",encoding="utf-8")
    (ROOT/"docs/specs/hire-data-model.md").write_text(documentation(),encoding="utf-8")
    print(f"{len(ENTITIES)} entities; {len(STATICS)} statics; {sum(len(e['attributes'])+1 for e in ENTITIES)} attributes; {len(job['ops'])} top-level ops")

