# Hire — dicionário do modelo de dados

65 entidades de negócio e 46 static entities. Gerado por `scripts/gen_hire_data.py`.

Job único: `tests/jobs/hire-data-model.json`. O merge não publica o módulo.

## Convenções

- Id: Long Integer AutoNumber; entidades públicas com ExposeReadOnly. Apenas actions do Hire_CS poderão escrever por contrato entre módulos.
- ExposeReadOnly não implementa autorização por linha. Serviços futuros devem verificar usuário, organização, equipe e visibilidade antes de devolver dados.
- Todas as relações de negócio usam Identifier + DeleteRule Protect. Relações com User usam Ignore para preservar autoria histórica; desativar usuários em vez de depender de exclusão em cascata.
- CreatedAt/UpdatedAt têm default CurrDateTime(); UpdatedAt deve ser atualizado explicitamente em cada escrita futura. Autorias permitem operações de sistema sem usuário.
- Textos têm tamanho explícito; valores monetários usam Currency(18,2), notas e pesos Decimal(18,4). Datas civis usam Date; instantes usam Date Time em UTC.
- Campo opcional no modelo O11 usa o valor nulo/padrão da plataforma. Ausência de resposta booleana é ausência de ApplicationAnswer, não BooleanValue=False.
- A entrega é somente de dados. Actions futuras implementarão autorização, transações de histórico, validações entre empresas, intervalos de datas/notas, uma candidatura ativa por vaga, imutabilidade após envio e execução de retenção.
- Arquivos são representados por metadados/StorageKey. Nenhum provedor de armazenamento ou envio de mensagens é ativado.

## Índices materializados

Índices únicos (UQ) e de consulta (IX) criados no modelo. A restrição condicional de uma candidatura ativa continua sendo responsabilidade da action transacional.

- **Department** — únicos: OrganizationId,Name; consulta: —.
- **WorkLocation** — únicos: OrganizationId,Name; consulta: —.
- **OrganizationMember** — únicos: OrganizationId,UserId; consulta: —.
- **OrganizationMemberRole** — únicos: OrganizationMemberId,MemberRoleId; consulta: —.
- **JobTeamMember** — únicos: JobOpeningId,OrganizationMemberId,JobTeamRoleId; consulta: —.
- **JobOpening** — únicos: OrganizationId,Code; consulta: OrganizationId,StatusId; RecruiterMemberId,StatusId.
- **JobCompensation** — únicos: JobOpeningId; consulta: —.
- **JobLocation** — únicos: JobOpeningId,WorkLocationId; consulta: —.
- **JobSkill** — únicos: JobOpeningId,SkillId; consulta: —.
- **JobApproval** — únicos: JobOpeningId,Sequence; consulta: —.
- **JobPublication** — únicos: —; consulta: JobOpeningId,StatusId.
- **Candidate** — únicos: —; consulta: OrganizationId,FullName; OrganizationId,IsArchived; UserId.
- **CandidateContact** — únicos: CandidateId,ContactTypeId,NormalizedValue; consulta: NormalizedValue.
- **CandidateSkill** — únicos: CandidateId,SkillId; consulta: —.
- **CandidateLanguage** — únicos: CandidateId,LanguageCode; consulta: —.
- **CandidatePreference** — únicos: CandidateId; consulta: —.
- **TalentPool** — únicos: OrganizationId,Name; consulta: —.
- **TalentPoolCandidate** — únicos: TalentPoolId,CandidateId; consulta: —.
- **Tag** — únicos: OrganizationId,Name; consulta: —.
- **CandidateTag** — únicos: CandidateId,TagId; consulta: —.
- **RecruitmentSource** — únicos: OrganizationId,Name; consulta: —.
- **PipelineTemplate** — únicos: OrganizationId,Name,Version; consulta: —.
- **PipelineTemplateStage** — únicos: PipelineTemplateId,Sequence; consulta: —.
- **JobStage** — únicos: JobOpeningId,Sequence; consulta: —.
- **Application** — únicos: CandidateId,JobOpeningId,AttemptNumber; consulta: JobOpeningId,StatusId,CurrentStageId; OwnerMemberId,StatusId; SubmittedAt.
- **ApplicationStageHistory** — únicos: —; consulta: ApplicationId,ChangedAt.
- **ApplicationStatusHistory** — únicos: —; consulta: ApplicationId,ChangedAt.
- **ApplicationDocument** — únicos: ApplicationId,CandidateDocumentId; consulta: —.
- **OutcomeReason** — únicos: OrganizationId,OutcomeTypeId,Name; consulta: —.
- **JobQuestion** — únicos: JobOpeningId,Sequence; consulta: —.
- **JobQuestionOption** — únicos: JobQuestionId,Sequence; consulta: —.
- **ApplicationAnswer** — únicos: ApplicationId,JobQuestionId; consulta: —.
- **ApplicationAnswerOption** — únicos: ApplicationAnswerId,JobQuestionOptionId; consulta: —.
- **Interview** — únicos: —; consulta: StatusId,StartsAtUtc; ApplicationId,StartsAtUtc.
- **InterviewParticipant** — únicos: InterviewId,OrganizationMemberId; consulta: OrganizationMemberId.
- **ScorecardTemplate** — únicos: OrganizationId,Name,Version; consulta: —.
- **ScorecardCriterion** — únicos: ScorecardTemplateId,Sequence; consulta: —.
- **Evaluation** — únicos: —; consulta: ApplicationId,StatusId; EvaluatorMemberId,StatusId.
- **EvaluationScore** — únicos: EvaluationId,ScorecardCriterionId; consulta: —.
- **Offer** — únicos: —; consulta: ApplicationId,StatusId.
- **OfferVersion** — únicos: OfferId,VersionNumber; consulta: —.
- **Benefit** — únicos: OrganizationId,Name; consulta: —.
- **OfferVersionBenefit** — únicos: OfferVersionId,BenefitId; consulta: —.
- **OfferApproval** — únicos: OfferVersionId,Sequence; consulta: —.
- **Hire** — únicos: ApplicationId; AcceptedOfferVersionId; consulta: —.
- **HireChecklistItem** — únicos: —; consulta: OwnerMemberId,StatusId,DueAt.
- **RecruitmentTask** — únicos: —; consulta: OrganizationId,StatusId,DueAt; AssignedToMemberId,StatusId,DueAt.
- **CommunicationTemplate** — únicos: OrganizationId,Name,ChannelId; consulta: —.
- **CandidateCommunication** — únicos: —; consulta: CandidateId,CreatedAt; ApplicationId,CreatedAt.
- **Notification** — únicos: —; consulta: OrganizationId,UserId,ReadAt,CreatedAt.
- **PrivacyNoticeVersion** — únicos: OrganizationId,Version; consulta: —.
- **CandidatePrivacyRecord** — únicos: —; consulta: CandidateId,PurposeId,RecordedAt.
- **CandidateDataRequest** — únicos: —; consulta: StatusId,RequestedAt.
- **DataRetentionPolicy** — únicos: OrganizationId,RecordCategoryId,TriggerEventId; consulta: —.
- **AuditEvent** — únicos: —; consulta: OrganizationId,OccurredAt; EntityType,RecordIdentifier.
- **IntegrationEvent** — únicos: OrganizationId,IdempotencyKey; consulta: StatusId,NextAttemptAt.
- **Skill** — únicos: OrganizationId,Name; consulta: —.

## Empresa e equipe

### Organization

Empresa contratante e fronteira de acesso aos dados.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| Name | Text | Sim | 200 |
| LegalName | Text | Não | 250 |
| ExternalCode | Text | Não | 50 |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### Department

Área organizacional; ParentDepartmentId deve pertencer à mesma empresa, sem ciclos.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| Name | Text | Sim | 150 |
| ParentDepartmentId | Department Identifier | Não |  |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### WorkLocation

Local de trabalho; CountryCode ISO e TimeZone IANA, validados nas actions.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| Name | Text | Sim | 150 |
| CountryCode | Text | Sim | 2 |
| Region | Text | Não | 100 |
| City | Text | Não | 150 |
| TimeZone | Text | Sim | 100 |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### OrganizationMember

Vínculo do usuário interno com a empresa.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| UserId | User Identifier | Sim |  |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### OrganizationMemberRole

Perfis cumulativos do membro; a autorização será aplicada pelas actions.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationMemberId | OrganizationMember Identifier | Sim |  |
| MemberRoleId | MemberRole Identifier | Sim |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### JobTeamMember

Equipe da vaga; membro e vaga devem pertencer à mesma empresa.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| JobOpeningId | JobOpening Identifier | Sim |  |
| OrganizationMemberId | OrganizationMember Identifier | Sim |  |
| JobTeamRoleId | JobTeamRole Identifier | Sim |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |

## Vagas

### JobOpening

Vaga com uma ou mais posições; Headcount deve ser positivo. Estado independente da publicação.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| DepartmentId | Department Identifier | Sim |  |
| PrimaryLocationId | WorkLocation Identifier | Não |  |
| Code | Text | Sim | 50 |
| Title | Text | Sim | 200 |
| Description | Text | Não | 12000 |
| Responsibilities | Text | Não | 10000 |
| Requirements | Text | Não | 10000 |
| EmploymentTypeId | EmploymentType Identifier | Sim |  |
| WorkModeId | WorkMode Identifier | Sim |  |
| SeniorityId | Seniority Identifier | Não |  |
| StatusId | JobStatus Identifier | Sim | `Entities.JobStatus.Draft` |
| Headcount | Integer | Sim | `1` |
| HiringManagerMemberId | OrganizationMember Identifier | Não |  |
| RecruiterMemberId | OrganizationMember Identifier | Não |  |
| OpenedAt | Date Time | Não |  |
| TargetStartDate | Date | Não |  |
| ClosedAt | Date Time | Não |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### JobCompensation

Faixa remuneratória restrita; mínimo <= máximo; divulgação opcional.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| JobOpeningId | JobOpening Identifier | Sim |  |
| MinimumAmount | Currency | Não |  |
| MaximumAmount | Currency | Não |  |
| CurrencyCode | Text | Sim | 3 |
| PayPeriodId | PayPeriod Identifier | Sim |  |
| IsPublic | Boolean | Sim | `False` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### JobLocation

Locais adicionais aceitos para a vaga.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| JobOpeningId | JobOpening Identifier | Sim |  |
| WorkLocationId | WorkLocation Identifier | Sim |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### JobSkill

Competência exigida; peso não negativo.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| JobOpeningId | JobOpening Identifier | Sim |  |
| SkillId | Skill Identifier | Sim |  |
| MinimumLevelId | ProficiencyLevel Identifier | Não |  |
| IsRequired | Boolean | Sim | `False` |
| Weight | Decimal | Não |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### JobApproval

Aprovação sequencial da abertura da vaga.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| JobOpeningId | JobOpening Identifier | Sim |  |
| Sequence | Integer | Sim | `1` |
| ApproverMemberId | OrganizationMember Identifier | Sim |  |
| StatusId | ApprovalStatus Identifier | Sim | `Entities.ApprovalStatus.Pending` |
| RequestedAt | Date Time | Sim | `CurrDateTime()` |
| DecidedAt | Date Time | Não |  |
| Comment | Text | Não | 4000 |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### JobPublication

Publicação da vaga em um canal; preserva referência externa e histórico.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| JobOpeningId | JobOpening Identifier | Sim |  |
| RecruitmentSourceId | RecruitmentSource Identifier | Sim |  |
| ExternalReference | Text | Não | 200 |
| PublicUrl | Text | Não | 2000 |
| PublishedAt | Date Time | Não |  |
| ExpiresAt | Date Time | Não |  |
| StatusId | PublicationStatus Identifier | Sim | `Entities.PublicationStatus.Draft` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |

## Talentos

### Candidate

Pessoa no contexto da empresa; conta de acesso opcional; sem compartilhamento automático entre empresas.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| UserId | User Identifier | Não |  |
| FullName | Text | Sim | 200 |
| PreferredName | Text | Não | 150 |
| CountryCode | Text | Não | 2 |
| Region | Text | Não | 100 |
| City | Text | Não | 150 |
| ProfessionalSummary | Text | Não | 10000 |
| CurrentTitle | Text | Não | 200 |
| AvailabilityDate | Date | Não |  |
| CreatedSourceId | RecruitmentSource Identifier | Não |  |
| IsArchived | Boolean | Sim | `False` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### CandidateContact

Contato normalizado; um contato principal por tipo será garantido na action.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| CandidateId | Candidate Identifier | Sim |  |
| ContactTypeId | ContactType Identifier | Sim |  |
| Value | Text | Sim | 320 |
| NormalizedValue | Text | Sim | 320 |
| IsPrimary | Boolean | Sim | `False` |
| VerifiedAt | Date Time | Não |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### CandidateLink

Perfil profissional ou portfólio público informado pelo candidato.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| CandidateId | Candidate Identifier | Sim |  |
| LinkTypeId | LinkType Identifier | Sim |  |
| Url | Text | Sim | 2000 |
| Label | Text | Não | 200 |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### CandidateExperience

Experiência profissional; datas e cargo atual precisam ser consistentes.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| CandidateId | Candidate Identifier | Sim |  |
| CompanyName | Text | Sim | 200 |
| JobTitle | Text | Sim | 200 |
| StartedOn | Date | Sim |  |
| EndedOn | Date | Não |  |
| IsCurrent | Boolean | Sim | `False` |
| Description | Text | Não | 8000 |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### CandidateEducation

Formação acadêmica.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| CandidateId | Candidate Identifier | Sim |  |
| Institution | Text | Sim | 200 |
| Course | Text | Sim | 200 |
| EducationLevelId | EducationLevel Identifier | Sim |  |
| StartedOn | Date | Não |  |
| CompletedOn | Date | Não |  |
| IsInProgress | Boolean | Sim | `False` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### CandidateSkill

Competência declarada pelo candidato; anos não negativos.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| CandidateId | Candidate Identifier | Sim |  |
| SkillId | Skill Identifier | Sim |  |
| ProficiencyLevelId | ProficiencyLevel Identifier | Não |  |
| YearsOfExperience | Decimal | Não |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### CandidateLanguage

Idioma informado; LanguageCode deve usar código padronizado.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| CandidateId | Candidate Identifier | Sim |  |
| LanguageCode | Text | Sim | 10 |
| ProficiencyLevelId | LanguageLevel Identifier | Sim |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### CandidateCertification

Certificação profissional; expiração opcional.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| CandidateId | Candidate Identifier | Sim |  |
| Name | Text | Sim | 200 |
| Issuer | Text | Não | 200 |
| IssuedOn | Date | Não |  |
| ExpiresOn | Date | Não |  |
| CredentialUrl | Text | Não | 2000 |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### CandidatePreference

Preferências profissionais atuais do candidato.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| CandidateId | Candidate Identifier | Sim |  |
| DesiredTitle | Text | Não | 200 |
| EmploymentTypeId | EmploymentType Identifier | Não |  |
| WorkModeId | WorkMode Identifier | Não |  |
| SalaryExpectation | Currency | Não |  |
| CurrencyCode | Text | Não | 3 |
| PayPeriodId | PayPeriod Identifier | Não |  |
| WillingToRelocate | Boolean | Sim | `False` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### CandidateDocument

Metadados de arquivo versionado; conteúdo em armazenamento protegido; não sobrescrever versões usadas.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| CandidateId | Candidate Identifier | Sim |  |
| DocumentTypeId | DocumentType Identifier | Sim |  |
| FileName | Text | Sim | 255 |
| MimeType | Text | Sim | 150 |
| SizeBytes | Long Integer | Sim |  |
| StorageKey | Text | Sim | 500 |
| Checksum | Text | Não | 128 |
| Version | Integer | Sim | `1` |
| UploadedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
### TalentPool

Banco de talentos administrado pela empresa.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| Name | Text | Sim | 150 |
| Description | Text | Não | 4000 |
| OwnerMemberId | OrganizationMember Identifier | Sim |  |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### TalentPoolCandidate

Participação do candidato no banco da mesma empresa.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| TalentPoolId | TalentPool Identifier | Sim |  |
| CandidateId | Candidate Identifier | Sim |  |
| AddedByMemberId | OrganizationMember Identifier | Não |  |
| AddedAt | Date Time | Sim | `CurrDateTime()` |
| Note | Text | Não | 4000 |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### Tag

Etiqueta configurável da empresa.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| Name | Text | Sim | 80 |
| Color | Text | Não | 7 |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### CandidateTag

Etiqueta aplicada ao candidato da mesma empresa.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| CandidateId | Candidate Identifier | Sim |  |
| TagId | Tag Identifier | Sim |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |

## Processo seletivo

### RecruitmentSource

Canal de origem configurável da empresa.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| Name | Text | Sim | 150 |
| SourceTypeId | SourceType Identifier | Sim |  |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### PipelineTemplate

Versão do modelo de processo; copiar etapas para a vaga ao instanciar.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| Name | Text | Sim | 150 |
| Version | Integer | Sim | `1` |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### PipelineTemplateStage

Etapa ordenada do template de processo.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| PipelineTemplateId | PipelineTemplate Identifier | Sim |  |
| Name | Text | Sim | 100 |
| StageTypeId | StageType Identifier | Sim |  |
| Sequence | Integer | Sim | `1` |
| TargetDays | Integer | Não |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### JobStage

Etapa própria da vaga; não é alterada por mudanças posteriores no template.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| JobOpeningId | JobOpening Identifier | Sim |  |
| Name | Text | Sim | 100 |
| StageTypeId | StageType Identifier | Sim |  |
| Sequence | Integer | Sim | `1` |
| TargetDays | Integer | Não |  |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### Application

Candidatura por tentativa; apenas uma tentativa ativa por candidato/vaga, garantida na action sob lock.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| CandidateId | Candidate Identifier | Sim |  |
| JobOpeningId | JobOpening Identifier | Sim |  |
| AttemptNumber | Integer | Sim | `1` |
| CurrentStageId | JobStage Identifier | Sim |  |
| StatusId | ApplicationStatus Identifier | Sim | `Entities.ApplicationStatus.Active` |
| RecruitmentSourceId | RecruitmentSource Identifier | Não |  |
| OwnerMemberId | OrganizationMember Identifier | Não |  |
| SubmittedAt | Date Time | Sim | `CurrDateTime()` |
| ClosedAt | Date Time | Não |  |
| OutcomeReasonId | OutcomeReason Identifier | Não |  |
| ReferredByUserId | User Identifier | Não |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### ApplicationStageHistory

Histórico imutável de transições; gravar junto com Application na mesma transação.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| ApplicationId | Application Identifier | Sim |  |
| FromStageId | JobStage Identifier | Não |  |
| ToStageId | JobStage Identifier | Sim |  |
| ChangedAt | Date Time | Sim | `CurrDateTime()` |
| ChangedByUserId | User Identifier | Não |  |
| Reason | Text | Não | 4000 |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
### ApplicationStatusHistory

Histórico imutável de situação e motivo; preserva a etapa da saída.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| ApplicationId | Application Identifier | Sim |  |
| FromStatusId | ApplicationStatus Identifier | Não |  |
| ToStatusId | ApplicationStatus Identifier | Sim |  |
| OutcomeReasonId | OutcomeReason Identifier | Não |  |
| ChangedAt | Date Time | Sim | `CurrDateTime()` |
| ChangedByUserId | User Identifier | Não |  |
| Comment | Text | Não | 4000 |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
### ApplicationDocument

Versão do documento apresentada na candidatura; mesmo candidato em ambos os lados.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| ApplicationId | Application Identifier | Sim |  |
| CandidateDocumentId | CandidateDocument Identifier | Sim |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### ApplicationNote

Anotação interna; visibilidade aplicada pelo serviço, nunca diretamente por filtro na UI.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| ApplicationId | Application Identifier | Sim |  |
| AuthorMemberId | OrganizationMember Identifier | Sim |  |
| Body | Text | Sim | 10000 |
| VisibilityId | NoteVisibility Identifier | Sim | `Entities.NoteVisibility.RecruitingTeam` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### OutcomeReason

Motivo de encerramento configurável da empresa.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| OutcomeTypeId | OutcomeType Identifier | Sim |  |
| Name | Text | Sim | 200 |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |

## Entrevistas e avaliações

### JobQuestion

Pergunta de inscrição; preservar texto/tipo após receber respostas.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| JobOpeningId | JobOpening Identifier | Sim |  |
| Label | Text | Sim | 1000 |
| AnswerTypeId | AnswerType Identifier | Sim |  |
| IsRequired | Boolean | Sim | `False` |
| Sequence | Integer | Sim | `1` |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### JobQuestionOption

Alternativa da pergunta; preservar após receber respostas.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| JobQuestionId | JobQuestion Identifier | Sim |  |
| Label | Text | Sim | 1000 |
| Sequence | Integer | Sim | `1` |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### ApplicationAnswer

Resposta tipada; somente o campo compatível com AnswerType pode ser preenchido.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| ApplicationId | Application Identifier | Sim |  |
| JobQuestionId | JobQuestion Identifier | Sim |  |
| TextValue | Text | Não | 10000 |
| NumberValue | Decimal | Não |  |
| DateValue | Date | Não |  |
| BooleanValue | Boolean | Não |  |
| AnsweredAt | Date Time | Sim | `CurrDateTime()` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### ApplicationAnswerOption

Alternativa selecionada; opção deve pertencer à pergunta respondida.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| ApplicationAnswerId | ApplicationAnswer Identifier | Sim |  |
| JobQuestionOptionId | JobQuestionOption Identifier | Sim |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### Interview

Entrevista; horários UTC e fuso IANA; término posterior ao início.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| ApplicationId | Application Identifier | Sim |  |
| JobStageId | JobStage Identifier | Sim |  |
| InterviewTypeId | InterviewType Identifier | Sim |  |
| StatusId | InterviewStatus Identifier | Sim | `Entities.InterviewStatus.Scheduled` |
| StartsAtUtc | Date Time | Sim |  |
| EndsAtUtc | Date Time | Sim |  |
| TimeZone | Text | Sim | 100 |
| Location | Text | Não | 500 |
| MeetingUrl | Text | Não | 2000 |
| Instructions | Text | Não | 8000 |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### InterviewParticipant

Entrevistador ou observador da entrevista.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| InterviewId | Interview Identifier | Sim |  |
| OrganizationMemberId | OrganizationMember Identifier | Sim |  |
| ParticipantRoleId | ParticipantRole Identifier | Sim | `Entities.ParticipantRole.Interviewer` |
| ResponseStatusId | ParticipantResponse Identifier | Sim | `Entities.ParticipantResponse.Pending` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### ScorecardTemplate

Modelo versionado de avaliação; versão utilizada torna-se imutável.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| Name | Text | Sim | 150 |
| Version | Integer | Sim | `1` |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### ScorecardCriterion

Critério e escala de notas; pesos não negativos e mínimo <= máximo.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| ScorecardTemplateId | ScorecardTemplate Identifier | Sim |  |
| Name | Text | Sim | 150 |
| Description | Text | Não | 4000 |
| Weight | Decimal | Não |  |
| MinimumScore | Decimal | Não |  |
| MaximumScore | Decimal | Não |  |
| Sequence | Integer | Sim | `1` |
| IsRequired | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### Evaluation

Avaliação individual; validar completude ao enviar; impedir edição após submissão.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| ApplicationId | Application Identifier | Sim |  |
| InterviewId | Interview Identifier | Não |  |
| ScorecardTemplateId | ScorecardTemplate Identifier | Sim |  |
| EvaluatorMemberId | OrganizationMember Identifier | Sim |  |
| StatusId | EvaluationStatus Identifier | Sim | `Entities.EvaluationStatus.Draft` |
| RecommendationId | Recommendation Identifier | Não |  |
| Summary | Text | Não | 10000 |
| SubmittedAt | Date Time | Não |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### EvaluationScore

Nota individual do critério, pertencente à versão de scorecard da avaliação.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| EvaluationId | Evaluation Identifier | Sim |  |
| ScorecardCriterionId | ScorecardCriterion Identifier | Sim |  |
| Score | Decimal | Não |  |
| Comment | Text | Não | 4000 |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### Assessment

Teste ou desafio associado à candidatura; integração externa opcional.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| ApplicationId | Application Identifier | Sim |  |
| AssessmentTypeId | AssessmentType Identifier | Sim |  |
| Title | Text | Sim | 200 |
| Provider | Text | Não | 150 |
| ExternalReference | Text | Não | 200 |
| StatusId | AssessmentStatus Identifier | Sim | `Entities.AssessmentStatus.Pending` |
| DueAt | Date Time | Não |  |
| CompletedAt | Date Time | Não |  |
| Score | Decimal | Não |  |
| MaximumScore | Decimal | Não |  |
| ResultUrl | Text | Não | 2000 |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |

## Propostas e contratação

### Offer

Proposta com versões preservadas; CurrentVersionNumber aponta para versão do mesmo Offer.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| ApplicationId | Application Identifier | Sim |  |
| StatusId | OfferStatus Identifier | Sim | `Entities.OfferStatus.Draft` |
| CurrentVersionNumber | Integer | Sim | `1` |
| CreatedByMemberId | OrganizationMember Identifier | Sim |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### OfferVersion

Condições de uma versão; congelar ao enviar; não reutilizar aprovação de outra versão.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OfferId | Offer Identifier | Sim |  |
| VersionNumber | Integer | Sim | `1` |
| JobTitle | Text | Sim | 200 |
| EmploymentTypeId | EmploymentType Identifier | Sim |  |
| WorkLocationId | WorkLocation Identifier | Não |  |
| WorkModeId | WorkMode Identifier | Sim |  |
| SalaryAmount | Currency | Não |  |
| CurrencyCode | Text | Sim | 3 |
| PayPeriodId | PayPeriod Identifier | Sim |  |
| StartDate | Date | Sim |  |
| ExpiresAt | Date Time | Não |  |
| Terms | Text | Não | 20000 |
| SentAt | Date Time | Não |  |
| RespondedAt | Date Time | Não |  |
| CandidateResponseId | OfferResponse Identifier | Não |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### Benefit

Benefício configurável da empresa.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| Name | Text | Sim | 150 |
| Description | Text | Não | 4000 |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### OfferVersionBenefit

Benefícios de uma versão específica da proposta.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OfferVersionId | OfferVersion Identifier | Sim |  |
| BenefitId | Benefit Identifier | Sim |  |
| Description | Text | Não | 4000 |
| Amount | Currency | Não |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### OfferApproval

Aprovação de uma versão específica de proposta.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OfferVersionId | OfferVersion Identifier | Sim |  |
| ApproverMemberId | OrganizationMember Identifier | Sim |  |
| Sequence | Integer | Sim | `1` |
| StatusId | ApprovalStatus Identifier | Sim | `Entities.ApprovalStatus.Pending` |
| DecidedAt | Date Time | Não |  |
| Comment | Text | Não | 4000 |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### Hire

Contratação confirmada e início efetivo; proposta aceita deve pertencer à mesma candidatura.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| ApplicationId | Application Identifier | Sim |  |
| AcceptedOfferVersionId | OfferVersion Identifier | Sim |  |
| StatusId | HireStatus Identifier | Sim | `Entities.HireStatus.Confirmed` |
| ExpectedStartDate | Date | Sim |  |
| ActualStartDate | Date | Não |  |
| ExternalEmployeeId | Text | Não | 100 |
| ConfirmedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### HireChecklistItem

Pendência de admissão.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| HireId | Hire Identifier | Sim |  |
| Title | Text | Sim | 250 |
| OwnerMemberId | OrganizationMember Identifier | Não |  |
| DueAt | Date Time | Não |  |
| StatusId | TaskStatus Identifier | Sim | `Entities.TaskStatus.Open` |
| CompletedAt | Date Time | Não |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |

## Operação e governança

### RecruitmentTask

Tarefa; os contextos opcionais informados devem ser coerentes e da mesma empresa.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| ApplicationId | Application Identifier | Não |  |
| CandidateId | Candidate Identifier | Não |  |
| JobOpeningId | JobOpening Identifier | Não |  |
| Title | Text | Sim | 250 |
| AssignedToMemberId | OrganizationMember Identifier | Não |  |
| DueAt | Date Time | Não |  |
| PriorityId | TaskPriority Identifier | Sim | `Entities.TaskPriority.Normal` |
| StatusId | TaskStatus Identifier | Sim | `Entities.TaskStatus.Open` |
| CompletedAt | Date Time | Não |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### CommunicationTemplate

Modelo de mensagem configurável; envio depende de action futura.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| Name | Text | Sim | 150 |
| ChannelId | CommunicationChannel Identifier | Sim |  |
| Subject | Text | Não | 500 |
| Body | Text | Sim | 20000 |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### CandidateCommunication

Histórico de contato; proteger conteúdo e identificadores de provedor.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| CandidateId | Candidate Identifier | Sim |  |
| ApplicationId | Application Identifier | Não |  |
| ChannelId | CommunicationChannel Identifier | Sim |  |
| DirectionId | CommunicationDirection Identifier | Sim |  |
| Subject | Text | Não | 500 |
| Body | Text | Não | 20000 |
| DeliveryStatusId | DeliveryStatus Identifier | Sim | `Entities.DeliveryStatus.Draft` |
| ProviderMessageId | Text | Não | 250 |
| SentAt | Date Time | Não |  |
| SentByUserId | User Identifier | Não |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### Notification

Aviso interno destinado a um usuário; leitura por destinatário.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| UserId | User Identifier | Sim |  |
| TypeId | NotificationType Identifier | Sim |  |
| Title | Text | Sim | 250 |
| ApplicationId | Application Identifier | Não |  |
| JobOpeningId | JobOpening Identifier | Não |  |
| ReadAt | Date Time | Não |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### PrivacyNoticeVersion

Versão imutável do texto apresentado; não define base jurídica automaticamente.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| Version | Text | Sim | 40 |
| Content | Text | Sim | 40000 |
| EffectiveAt | Date Time | Sim |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
### CandidatePrivacyRecord

Registro imutável da ciência/escolha por finalidade e versão do texto.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| CandidateId | Candidate Identifier | Sim |  |
| PrivacyNoticeVersionId | PrivacyNoticeVersion Identifier | Sim |  |
| PurposeId | PrivacyPurpose Identifier | Sim |  |
| ActionId | PrivacyAction Identifier | Sim |  |
| RecordedAt | Date Time | Sim | `CurrDateTime()` |
| Source | Text | Não | 200 |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
### CandidateDataRequest

Solicitação de dados pessoais; decisão, prazos e execução em fluxo futuro.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| CandidateId | Candidate Identifier | Sim |  |
| RequestTypeId | DataRequestType Identifier | Sim |  |
| StatusId | DataRequestStatus Identifier | Sim | `Entities.DataRequestStatus.Received` |
| RequestedAt | Date Time | Sim | `CurrDateTime()` |
| AssignedToMemberId | OrganizationMember Identifier | Não |  |
| CompletedAt | Date Time | Não |  |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### DataRetentionPolicy

Política configurável; nenhum prazo ou expurgo automático é ativado nesta entrega.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| RecordCategoryId | RecordCategory Identifier | Sim |  |
| RetentionDays | Integer | Sim |  |
| TriggerEventId | RetentionTrigger Identifier | Sim |  |
| DispositionActionId | DispositionAction Identifier | Sim | `Entities.DispositionAction.Review` |
| IsActive | Boolean | Sim | `False` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |
### AuditEvent

Evento imutável; registrar campos alterados sem copiar valores pessoais sensíveis.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| ActorUserId | User Identifier | Não |  |
| Action | Text | Sim | 100 |
| EntityType | Text | Sim | 100 |
| RecordIdentifier | Text | Sim | 100 |
| OccurredAt | Date Time | Sim | `CurrDateTime()` |
| CorrelationId | Text | Não | 100 |
| ChangedFields | Text | Não | 10000 |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
### IntegrationEvent

Outbox de integração; sem chamadas externas nesta entrega; payload protegido.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| EventType | Text | Sim | 100 |
| Payload | Text | Sim | 50000 |
| IdempotencyKey | Text | Sim | 150 |
| StatusId | IntegrationStatus Identifier | Sim | `Entities.IntegrationStatus.Pending` |
| AttemptCount | Integer | Sim | `0` |
| NextAttemptAt | Date Time | Não |  |
| ProcessedAt | Date Time | Não |  |
| LastError | Text | Não | 8000 |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |

## Catálogos configuráveis

### Skill

Competência usada nos requisitos da vaga e no perfil do candidato.

| Campo | Tipo | Obrigatório | Tamanho / default |
|---|---|---|---|
| Id | Long Integer Identifier | Sim | AutoNumber |
| OrganizationId | Organization Identifier | Sim |  |
| Name | Text | Sim | 150 |
| Category | Text | Não | 100 |
| IsActive | Boolean | Sim | `True` |
| CreatedAt | Date Time | Sim | `CurrDateTime()` |
| CreatedByUserId | User Identifier | Não |  |
| UpdatedAt | Date Time | Sim | `CurrDateTime()` |
| UpdatedByUserId | User Identifier | Não |  |

## Static entities

Todas possuem Id Integer AutoNumber, Label e Order. Os códigos dos registros não devem ser renomeados depois de usados.

- **MemberRole**: `Administrator` (Administrador); `Recruiter` (Recrutador); `HiringManager` (Gestor contratante); `Interviewer` (Entrevistador).
- **JobTeamRole**: `LeadRecruiter` (Recrutador responsável); `Recruiter` (Recrutador); `HiringManager` (Gestor contratante); `Interviewer` (Entrevistador).
- **EmploymentType**: `Permanent` (Efetivo); `FixedTerm` (Prazo determinado); `Contractor` (Prestador de serviços); `Internship` (Estágio); `Apprenticeship` (Aprendiz); `Temporary` (Temporário).
- **WorkMode**: `Onsite` (Presencial); `Hybrid` (Híbrido); `Remote` (Remoto).
- **Seniority**: `Intern` (Estagiário); `Junior` (Júnior); `MidLevel` (Pleno); `Senior` (Sênior); `Lead` (Liderança técnica); `Manager` (Gerência); `Executive` (Executivo).
- **JobStatus**: `Draft` (Rascunho); `PendingApproval` (Aguardando aprovação); `Open` (Aberta); `Paused` (Pausada); `Closed` (Encerrada); `Cancelled` (Cancelada).
- **PayPeriod**: `Hourly` (Hora); `Daily` (Dia); `Monthly` (Mês); `Yearly` (Ano).
- **ApprovalStatus**: `Pending` (Pendente); `Approved` (Aprovada); `Rejected` (Rejeitada); `Cancelled` (Cancelada).
- **PublicationStatus**: `Draft` (Rascunho); `Published` (Publicada); `Expired` (Expirada); `Withdrawn` (Retirada); `Failed` (Falhou).
- **ContactType**: `Email` (E-mail); `Mobile` (Celular); `Phone` (Telefone).
- **LinkType**: `LinkedIn` (LinkedIn); `Portfolio` (Portfólio); `GitHub` (GitHub); `Website` (Site); `Other` (Outro).
- **EducationLevel**: `Secondary` (Ensino médio); `Technical` (Técnico); `Associate` (Tecnólogo); `Bachelor` (Graduação); `Specialization` (Especialização); `Master` (Mestrado); `Doctorate` (Doutorado).
- **ProficiencyLevel**: `Beginner` (Iniciante); `Intermediate` (Intermediário); `Advanced` (Avançado); `Expert` (Especialista).
- **LanguageLevel**: `Basic` (Básico); `Intermediate` (Intermediário); `Advanced` (Avançado); `Fluent` (Fluente); `Native` (Nativo).
- **DocumentType**: `Resume` (Currículo); `CoverLetter` (Carta de apresentação); `Portfolio` (Portfólio); `Certificate` (Certificado); `Other` (Outro).
- **SourceType**: `CareerSite` (Portal de carreiras); `JobBoard` (Portal de vagas); `Referral` (Indicação); `Agency` (Agência); `Sourcing` (Busca ativa); `Event` (Evento); `Other` (Outro).
- **StageType**: `Screening` (Triagem); `Interview` (Entrevista); `Assessment` (Teste); `ReferenceCheck` (Referências); `Offer` (Proposta); `Other` (Outra).
- **ApplicationStatus**: `Active` (Ativa); `Rejected` (Rejeitada); `Withdrawn` (Retirada pelo candidato); `Hired` (Contratada); `Cancelled` (Cancelada).
- **NoteVisibility**: `RecruitingTeam` (Equipe de recrutamento); `HiringTeam` (Equipe da vaga); `AuthorOnly` (Somente autor).
- **OutcomeType**: `Rejection` (Rejeição); `Withdrawal` (Desistência); `Cancellation` (Cancelamento); `Hiring` (Contratação).
- **AnswerType**: `ShortText` (Texto curto); `LongText` (Texto longo); `Number` (Número); `Date` (Data); `Boolean` (Sim ou não); `SingleChoice` (Escolha única); `MultipleChoice` (Múltipla escolha).
- **InterviewType**: `Phone` (Telefone); `Video` (Vídeo); `Onsite` (Presencial).
- **InterviewStatus**: `Scheduled` (Agendada); `Confirmed` (Confirmada); `Completed` (Concluída); `Cancelled` (Cancelada); `NoShow` (Não compareceu).
- **ParticipantRole**: `Lead` (Responsável); `Interviewer` (Entrevistador); `Observer` (Observador).
- **ParticipantResponse**: `Pending` (Pendente); `Accepted` (Aceito); `Declined` (Recusado); `Tentative` (Provisório).
- **EvaluationStatus**: `Draft` (Rascunho); `Submitted` (Enviada); `Voided` (Invalidada).
- **Recommendation**: `StrongNo` (Não recomendado); `No` (Pouco recomendado); `Undecided` (Indeciso); `Yes` (Recomendado); `StrongYes` (Muito recomendado).
- **AssessmentType**: `Technical` (Técnico); `CaseStudy` (Estudo de caso); `Language` (Idioma); `WorkSample` (Amostra de trabalho); `Other` (Outro).
- **AssessmentStatus**: `Pending` (Pendente); `Invited` (Convidado); `InProgress` (Em andamento); `Completed` (Concluído); `Expired` (Expirado); `Cancelled` (Cancelado).
- **OfferStatus**: `Draft` (Rascunho); `PendingApproval` (Aguardando aprovação); `Approved` (Aprovada); `Sent` (Enviada); `Accepted` (Aceita); `Declined` (Recusada); `Expired` (Expirada); `Withdrawn` (Retirada).
- **OfferResponse**: `Accepted` (Aceita); `Declined` (Recusada); `Negotiation` (Negociação solicitada).
- **HireStatus**: `Confirmed` (Confirmada); `Started` (Iniciada); `Withdrawn` (Desistência antes do início); `Cancelled` (Cancelada).
- **TaskStatus**: `Open` (Aberta); `InProgress` (Em andamento); `Done` (Concluída); `Cancelled` (Cancelada).
- **TaskPriority**: `Low` (Baixa); `Normal` (Normal); `High` (Alta); `Urgent` (Urgente).
- **CommunicationChannel**: `Email` (E-mail); `Phone` (Telefone); `SMS` (SMS); `WhatsApp` (WhatsApp); `Portal` (Portal).
- **CommunicationDirection**: `Inbound` (Recebida); `Outbound` (Enviada).
- **DeliveryStatus**: `Draft` (Rascunho); `Queued` (Na fila); `Sent` (Enviada); `Delivered` (Entregue); `Received` (Recebida); `Failed` (Falhou); `Cancelled` (Cancelada).
- **NotificationType**: `Application` (Candidatura); `Interview` (Entrevista); `Evaluation` (Avaliação); `Offer` (Proposta); `Task` (Tarefa); `Privacy` (Privacidade); `System` (Sistema).
- **PrivacyPurpose**: `Recruitment` (Processo seletivo); `TalentPool` (Banco de talentos); `Communication` (Comunicação).
- **PrivacyAction**: `Acknowledged` (Ciência registrada); `OptedIn` (Adesão registrada); `OptedOut` (Recusa registrada); `Withdrawn` (Escolha revogada).
- **DataRequestType**: `Access` (Acesso); `Correction` (Correção); `Deletion` (Exclusão); `Export` (Exportação); `Restriction` (Restrição).
- **DataRequestStatus**: `Received` (Recebida); `InReview` (Em análise); `InProgress` (Em execução); `Completed` (Concluída); `Declined` (Indeferida); `Cancelled` (Cancelada).
- **RecordCategory**: `CandidateProfile` (Perfil do candidato); `Application` (Candidatura); `Document` (Documento); `Communication` (Comunicação); `Audit` (Auditoria).
- **RetentionTrigger**: `CandidateArchived` (Candidato arquivado); `ApplicationClosed` (Candidatura encerrada); `LastActivity` (Última atividade); `RecordCreated` (Criação do registro).
- **DispositionAction**: `Review` (Revisão manual); `Anonymize` (Anonimização); `Delete` (Exclusão).
- **IntegrationStatus**: `Pending` (Pendente); `Processing` (Em processamento); `Succeeded` (Concluído); `Retry` (Nova tentativa); `Failed` (Falha definitiva).
