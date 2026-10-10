# Hire — actions de negócio

Especificação gerada por `scripts/gen_hire_actions.py`; job `tests/jobs/hire-business-actions.json`.

Public server actions mantêm a identidade da requisição do consumidor. Não há ActorId público de autorização. As entidades continuam públicas/read-only e não substituem autorização por linha nas actions.

## Limites explícitos da entrega

- Esta entrega não publica o módulo e não ativa timers. As rotinas são actions invocáveis; agendamento exige configuração.
- Provedores de arquivos, inspeção, mensagens, publicação externa e verificação de identidade não estão conectados. Os pontos correspondentes lançam HireConfiguration antes de escrever.
- Execução de privacidade/retenção e lembretes/SLA ainda têm contratos indisponíveis, não implementações operacionais. Não marcar pedidos como concluídos sem executá-los.
- Recrutadores possuem escopo organizacional; entrevistadores podem editar suas avaliações e responder convites. Algumas leituras administrativas exigem perfil de recrutamento.
- Revisão, idempotência, alçadas, reservas, fusões e histórico de agendamento usam dados de apoio incluídos no job.
- A validação do modelo e os testes de contrato não executam os fluxos contra uma base publicada. É necessária homologação funcional antes de uso real.

## Inventário

### Scope_Organization

Privada — Núcleo

Hire: Scope_Organization. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Organization Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_Department

Privada — Núcleo

Hire: Scope_Department. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Department Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_WorkLocation

Privada — Núcleo

Hire: Scope_WorkLocation. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (WorkLocation Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_OrganizationMember

Privada — Núcleo

Hire: Scope_OrganizationMember. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (OrganizationMember Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_JobTeamMember

Privada — Núcleo

Hire: Scope_JobTeamMember. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobTeamMember Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_JobOpening

Privada — Núcleo

Hire: Scope_JobOpening. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobOpening Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_JobApproval

Privada — Núcleo

Hire: Scope_JobApproval. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobApproval Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_JobPublication

Privada — Núcleo

Hire: Scope_JobPublication. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobPublication Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_Candidate

Privada — Núcleo

Hire: Scope_Candidate. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Candidate Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_CandidateDocument

Privada — Núcleo

Hire: Scope_CandidateDocument. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (CandidateDocument Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_TalentPool

Privada — Núcleo

Hire: Scope_TalentPool. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (TalentPool Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_TalentPoolCandidate

Privada — Núcleo

Hire: Scope_TalentPoolCandidate. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (TalentPoolCandidate Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_Tag

Privada — Núcleo

Hire: Scope_Tag. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Tag Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_RecruitmentSource

Privada — Núcleo

Hire: Scope_RecruitmentSource. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (RecruitmentSource Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_PipelineTemplate

Privada — Núcleo

Hire: Scope_PipelineTemplate. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (PipelineTemplate Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_JobStage

Privada — Núcleo

Hire: Scope_JobStage. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobStage Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_Application

Privada — Núcleo

Hire: Scope_Application. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Application Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_ApplicationNote

Privada — Núcleo

Hire: Scope_ApplicationNote. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (ApplicationNote Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_OutcomeReason

Privada — Núcleo

Hire: Scope_OutcomeReason. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (OutcomeReason Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_JobQuestion

Privada — Núcleo

Hire: Scope_JobQuestion. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobQuestion Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_Interview

Privada — Núcleo

Hire: Scope_Interview. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Interview Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_ScorecardTemplate

Privada — Núcleo

Hire: Scope_ScorecardTemplate. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (ScorecardTemplate Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_Evaluation

Privada — Núcleo

Hire: Scope_Evaluation. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Evaluation Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_Assessment

Privada — Núcleo

Hire: Scope_Assessment. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Assessment Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_Offer

Privada — Núcleo

Hire: Scope_Offer. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Offer Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_OfferVersion

Privada — Núcleo

Hire: Scope_OfferVersion. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (OfferVersion Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_Benefit

Privada — Núcleo

Hire: Scope_Benefit. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Benefit Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_OfferApproval

Privada — Núcleo

Hire: Scope_OfferApproval. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (OfferApproval Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_Hire

Privada — Núcleo

Hire: Scope_Hire. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Hire Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_HireChecklistItem

Privada — Núcleo

Hire: Scope_HireChecklistItem. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (HireChecklistItem Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_RecruitmentTask

Privada — Núcleo

Hire: Scope_RecruitmentTask. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (RecruitmentTask Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_CandidateDataRequest

Privada — Núcleo

Hire: Scope_CandidateDataRequest. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (CandidateDataRequest Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_DataRetentionPolicy

Privada — Núcleo

Hire: Scope_DataRetentionPolicy. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (DataRetentionPolicy Identifier).
Saídas: OrganizationId (Organization Identifier).

### Scope_Skill

Privada — Núcleo

Hire: Scope_Skill. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Skill Identifier).
Saídas: OrganizationId (Organization Identifier).

### Access_RequireOrganization

Privada — Núcleo

Hire: Access_RequireOrganization. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), PermissionCode (Text).
Saídas: MemberId (OrganizationMember Identifier), IsAdmin (Boolean), IsRecruiter (Boolean), IsManager (Boolean).

### Concurrency_RequireRevision

Privada — Núcleo

Hire: Concurrency_RequireRevision. Autorizações e invariantes verificadas no servidor.

Entradas: ActualRevision (Integer), ExpectedRevision (Integer).
Saídas: nenhuma.

### Access_RequireJob

Privada — Núcleo

Hire: Access_RequireJob. Autorizações e invariantes verificadas no servidor.

Entradas: JobOpeningId (JobOpening Identifier), PermissionCode (Text).
Saídas: OrganizationId (Organization Identifier), MemberId (OrganizationMember Identifier).

### Access_RequireApplication

Privada — Núcleo

Hire: Access_RequireApplication. Autorizações e invariantes verificadas no servidor.

Entradas: ApplicationId (Application Identifier), PermissionCode (Text).
Saídas: OrganizationId (Organization Identifier), MemberId (OrganizationMember Identifier).

### Access_RequireCandidate

Privada — Núcleo

Hire: Access_RequireCandidate. Autorizações e invariantes verificadas no servidor.

Entradas: CandidateId (Candidate Identifier), PermissionCode (Text).
Saídas: OrganizationId (Organization Identifier), MemberId (OrganizationMember Identifier).

### Audit_Record

Privada — Núcleo

Hire: Audit_Record. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Operation (Text), EntityType (Text), RecordIdentifier (Text).
Saídas: nenhuma.

### Event_Enqueue

Privada — Núcleo

Hire: Event_Enqueue. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), EventType (Text), Payload (Text), EventKey (Text).
Saídas: nenhuma.

### Request_Begin

Privada — Núcleo

Hire: Request_Begin. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Operation (Text), RequestKey (Text), Payload (Text).
Saídas: RequestId (HireRequest Identifier), Completed (Boolean), ResultId (Long Integer).

### Request_Complete

Privada — Núcleo

Hire: Request_Complete. Autorizações e invariantes verificadas no servidor.

Entradas: RequestId (HireRequest Identifier), ResultId (Long Integer).
Saídas: nenhuma.

### Department_Save

Pública — Núcleo

Hire: Department_Save. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (Department), ExpectedRevision (Integer).
Saídas: RecordId (Department Identifier), NewRevision (Integer).

### WorkLocation_Save

Pública — Núcleo

Hire: WorkLocation_Save. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (WorkLocation), ExpectedRevision (Integer).
Saídas: RecordId (WorkLocation Identifier), NewRevision (Integer).

### Skill_Save

Pública — Núcleo

Hire: Skill_Save. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (Skill), ExpectedRevision (Integer).
Saídas: RecordId (Skill Identifier), NewRevision (Integer).

### RecruitmentSource_Save

Pública — Núcleo

Hire: RecruitmentSource_Save. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (RecruitmentSource), ExpectedRevision (Integer).
Saídas: RecordId (RecruitmentSource Identifier), NewRevision (Integer).

### OutcomeReason_Save

Pública — Núcleo

Hire: OutcomeReason_Save. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (OutcomeReason), ExpectedRevision (Integer).
Saídas: RecordId (OutcomeReason Identifier), NewRevision (Integer).

### Benefit_Save

Pública — Núcleo

Hire: Benefit_Save. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (Benefit), ExpectedRevision (Integer).
Saídas: RecordId (Benefit Identifier), NewRevision (Integer).

### TalentPool_Save

Pública — Núcleo

Hire: TalentPool_Save. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (TalentPool), ExpectedRevision (Integer).
Saídas: RecordId (TalentPool Identifier), NewRevision (Integer).

### Organization_Update

Pública — Núcleo

Hire: Organization_Update. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (Organization), ExpectedRevision (Integer).
Saídas: RecordId (Organization Identifier), NewRevision (Integer).

### OrganizationMember_Add

Pública — Núcleo

Hire: OrganizationMember_Add. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), UserId (User Identifier).
Saídas: MemberId (OrganizationMember Identifier).

### OrganizationMember_SetRoles

Pública — Núcleo

Hire: OrganizationMember_SetRoles. Autorizações e invariantes verificadas no servidor.

Entradas: MemberId (OrganizationMember Identifier), AssignedRoles (MemberRole List).
Saídas: nenhuma.

### OrganizationMember_Deactivate

Pública — Núcleo

Hire: OrganizationMember_Deactivate. Autorizações e invariantes verificadas no servidor.

Entradas: MemberId (OrganizationMember Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### JobTeam_AddMember

Pública — Núcleo

Hire: JobTeam_AddMember. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (JobTeamMember), ExpectedRevision (Integer).
Saídas: RecordId (JobTeamMember Identifier), NewRevision (Integer).

### JobTeam_RemoveMember

Pública — Núcleo

Hire: JobTeam_RemoveMember. Autorizações e invariantes verificadas no servidor.

Entradas: ParticipationId (JobTeamMember Identifier).
Saídas: nenhuma.

### PipelineTemplate_CreateVersion

Pública — Núcleo

Hire: PipelineTemplate_CreateVersion. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Name (Text), Children (PipelineTemplateStage List).
Saídas: TemplateId (PipelineTemplate Identifier).

### PipelineTemplate_Activate

Pública — Núcleo

Hire: PipelineTemplate_Activate. Autorizações e invariantes verificadas no servidor.

Entradas: TemplateId (PipelineTemplate Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### ScorecardTemplate_CreateVersion

Pública — Núcleo

Hire: ScorecardTemplate_CreateVersion. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Name (Text), Children (ScorecardCriterion List).
Saídas: TemplateId (ScorecardTemplate Identifier).

### ScorecardTemplate_Activate

Pública — Núcleo

Hire: ScorecardTemplate_Activate. Autorizações e invariantes verificadas no servidor.

Entradas: TemplateId (ScorecardTemplate Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Job_InitializeStages

Pública — Núcleo

Hire: Job_InitializeStages. Autorizações e invariantes verificadas no servidor.

Entradas: JobOpeningId (JobOpening Identifier), TemplateId (PipelineTemplate Identifier).
Saídas: nenhuma.

### Job_UpdateStages

Pública — Núcleo

Hire: Job_UpdateStages. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (JobStage), ExpectedRevision (Integer).
Saídas: RecordId (JobStage Identifier), NewRevision (Integer).

### JobQuestion_Save

Pública — Núcleo

Hire: JobQuestion_Save. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (JobQuestion), ExpectedRevision (Integer), Options (JobQuestionOption List).
Saídas: RecordId (JobQuestion Identifier), NewRevision (Integer).

### Job_CreateDraft

Pública — Núcleo

Hire: Job_CreateDraft. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (JobOpening), ExpectedRevision (Integer).
Saídas: RecordId (JobOpening Identifier), NewRevision (Integer).

### Job_UpdateDraft

Pública — Núcleo

Hire: Job_UpdateDraft. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (JobOpening), ExpectedRevision (Integer).
Saídas: RecordId (JobOpening Identifier), NewRevision (Integer).

### Job_Pause

Pública — Núcleo

Hire: Job_Pause. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobOpening Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### Job_Resume

Pública — Núcleo

Hire: Job_Resume. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobOpening Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Job_Open

Pública — Núcleo

Hire: Job_Open. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobOpening Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Job_Close

Pública — Núcleo

Hire: Job_Close. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobOpening Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### Job_Cancel

Pública — Núcleo

Hire: Job_Cancel. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobOpening Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### Job_SubmitForApproval

Pública — Núcleo

Hire: Job_SubmitForApproval. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobOpening Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Job_Approve

Pública — Núcleo

Hire: Job_Approve. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobApproval Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### Job_Reject

Pública — Núcleo

Hire: Job_Reject. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobApproval Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### Job_ChangeApprovedConditions

Pública — Núcleo

Hire: Job_ChangeApprovedConditions. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobOpening Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### Candidate_Create

Pública — Núcleo

Hire: Candidate_Create. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (Candidate), ExpectedRevision (Integer).
Saídas: RecordId (Candidate Identifier), NewRevision (Integer).

### Candidate_UpdateProfile

Pública — Núcleo

Hire: Candidate_UpdateProfile. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (Candidate), ExpectedRevision (Integer).
Saídas: RecordId (Candidate Identifier), NewRevision (Integer).

### Candidate_Archive

Pública — Núcleo

Hire: Candidate_Archive. Autorizações e invariantes verificadas no servidor.

Entradas: CandidateId (Candidate Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Candidate_Restore

Pública — Núcleo

Hire: Candidate_Restore. Autorizações e invariantes verificadas no servidor.

Entradas: CandidateId (Candidate Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Candidate_FindDuplicates

Pública — Núcleo

Hire: Candidate_FindDuplicates. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), NormalizedContact (Text).
Saídas: Candidates (Candidate List).

### TalentPool_AddCandidate

Pública — Núcleo

Hire: TalentPool_AddCandidate. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (TalentPoolCandidate), ExpectedRevision (Integer).
Saídas: RecordId (TalentPoolCandidate Identifier), NewRevision (Integer).

### TalentPool_RemoveCandidate

Pública — Núcleo

Hire: TalentPool_RemoveCandidate. Autorizações e invariantes verificadas no servidor.

Entradas: ParticipationId (TalentPoolCandidate Identifier).
Saídas: nenhuma.

### Candidate_SetTags

Pública — Núcleo

Hire: Candidate_SetTags. Autorizações e invariantes verificadas no servidor.

Entradas: CandidateId (Candidate Identifier), Tags (Tag List).
Saídas: nenhuma.

### Application_RecordStatus

Privada — Núcleo

Hire: Application_RecordStatus. Autorizações e invariantes verificadas no servidor.

Entradas: ApplicationId (Application Identifier), FromStatusId (ApplicationStatus Identifier), ToStatusId (ApplicationStatus Identifier), ReasonId (OutcomeReason Identifier), Comment (Text).
Saídas: nenhuma.

### Application_RecordStage

Privada — Núcleo

Hire: Application_RecordStage. Autorizações e invariantes verificadas no servidor.

Entradas: ApplicationId (Application Identifier), FromStageId (JobStage Identifier), ToStageId (JobStage Identifier), Reason (Text).
Saídas: nenhuma.

### Application_Submit

Pública — Núcleo

Hire: Application_Submit. Autorizações e invariantes verificadas no servidor.

Entradas: CandidateId (Candidate Identifier), JobOpeningId (JobOpening Identifier), SourceId (RecruitmentSource Identifier), Answers (ApplicationAnswer List), RequestKey (Text), Choices (HireAnswerChoice List).
Saídas: ApplicationId (Application Identifier).

### Application_CreateByRecruiter

Pública — Núcleo

Hire: Application_CreateByRecruiter. Autorizações e invariantes verificadas no servidor.

Entradas: CandidateId (Candidate Identifier), JobOpeningId (JobOpening Identifier), SourceId (RecruitmentSource Identifier), Answers (ApplicationAnswer List), RequestKey (Text), Choices (HireAnswerChoice List).
Saídas: ApplicationId (Application Identifier).

### Application_Reapply

Pública — Núcleo

Hire: Application_Reapply. Autorizações e invariantes verificadas no servidor.

Entradas: CandidateId (Candidate Identifier), JobOpeningId (JobOpening Identifier), SourceId (RecruitmentSource Identifier), Answers (ApplicationAnswer List), RequestKey (Text), Choices (HireAnswerChoice List).
Saídas: ApplicationId (Application Identifier).

### Application_AssignOwner

Pública — Núcleo

Hire: Application_AssignOwner. Autorizações e invariantes verificadas no servidor.

Entradas: ApplicationId (Application Identifier), MemberId (OrganizationMember Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Application_Reject

Pública — Núcleo

Hire: Application_Reject. Autorizações e invariantes verificadas no servidor.

Entradas: ApplicationId (Application Identifier), ReasonId (OutcomeReason Identifier), Comment (Text), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Application_Withdraw

Pública — Núcleo

Hire: Application_Withdraw. Autorizações e invariantes verificadas no servidor.

Entradas: ApplicationId (Application Identifier), ReasonId (OutcomeReason Identifier), Comment (Text), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Application_Reopen

Pública — Núcleo

Hire: Application_Reopen. Autorizações e invariantes verificadas no servidor.

Entradas: ApplicationId (Application Identifier), Reason (Text), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Application_MoveStage

Pública — Núcleo

Hire: Application_MoveStage. Autorizações e invariantes verificadas no servidor.

Entradas: ApplicationId (Application Identifier), ToStageId (JobStage Identifier), Reason (Text), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### ApplicationNote_Create

Pública — Núcleo

Hire: ApplicationNote_Create. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (ApplicationNote), ExpectedRevision (Integer).
Saídas: RecordId (ApplicationNote Identifier), NewRevision (Integer).

### ApplicationNote_Update

Pública — Núcleo

Hire: ApplicationNote_Update. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (ApplicationNote), ExpectedRevision (Integer).
Saídas: RecordId (ApplicationNote Identifier), NewRevision (Integer).

### Interview_Schedule

Pública — Núcleo

Hire: Interview_Schedule. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (Interview), ExpectedRevision (Integer).
Saídas: RecordId (Interview Identifier), NewRevision (Integer).

### Interview_Reschedule

Pública — Núcleo

Hire: Interview_Reschedule. Autorizações e invariantes verificadas no servidor.

Entradas: InterviewId (Interview Identifier), StartsAtUtc (Date Time), EndsAtUtc (Date Time), Reason (Text), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Interview_Cancel

Pública — Núcleo

Hire: Interview_Cancel. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Interview Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### Interview_Complete

Pública — Núcleo

Hire: Interview_Complete. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Interview Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Interview_RecordNoShow

Pública — Núcleo

Hire: Interview_RecordNoShow. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Interview Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### Interview_RespondInvitation

Pública — Núcleo

Hire: Interview_RespondInvitation. Autorizações e invariantes verificadas no servidor.

Entradas: InterviewId (Interview Identifier), ResponseId (ParticipantResponse Identifier).
Saídas: nenhuma.

### Evaluation_Create

Pública — Núcleo

Hire: Evaluation_Create. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (Evaluation), ExpectedRevision (Integer).
Saídas: RecordId (Evaluation Identifier), NewRevision (Integer).

### Evaluation_SaveDraft

Pública — Núcleo

Hire: Evaluation_SaveDraft. Autorizações e invariantes verificadas no servidor.

Entradas: EvaluationId (Evaluation Identifier), Scores (EvaluationScore List), Summary (Text), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Evaluation_Submit

Pública — Núcleo

Hire: Evaluation_Submit. Autorizações e invariantes verificadas no servidor.

Entradas: EvaluationId (Evaluation Identifier), RecommendationId (Recommendation Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Evaluation_Void

Pública — Núcleo

Hire: Evaluation_Void. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Evaluation Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### Evaluation_Consolidate

Pública — Núcleo

Hire: Evaluation_Consolidate. Autorizações e invariantes verificadas no servidor.

Entradas: ApplicationId (Application Identifier).
Saídas: Score (Decimal), EvaluationCount (Integer), PendingCount (Integer).

### Assessment_Assign

Pública — Núcleo

Hire: Assessment_Assign. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (Assessment), ExpectedRevision (Integer).
Saídas: RecordId (Assessment Identifier), NewRevision (Integer).

### Assessment_RecordResult

Pública — Núcleo

Hire: Assessment_RecordResult. Autorizações e invariantes verificadas no servidor.

Entradas: AssessmentId (Assessment Identifier), Score (Decimal), MaximumScore (Decimal), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Assessment_Cancel

Pública — Núcleo

Hire: Assessment_Cancel. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Assessment Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### Offer_CreateDraft

Pública — Núcleo

Hire: Offer_CreateDraft. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (Offer), ExpectedRevision (Integer).
Saídas: RecordId (Offer Identifier), NewRevision (Integer).

### Offer_CreateVersion

Pública — Núcleo

Hire: Offer_CreateVersion. Autorizações e invariantes verificadas no servidor.

Entradas: OfferId (Offer Identifier), Input (OfferVersion), ExpectedRevision (Integer).
Saídas: VersionId (OfferVersion Identifier), NewRevision (Integer).

### Offer_SubmitForApproval

Pública — Núcleo

Hire: Offer_SubmitForApproval. Autorizações e invariantes verificadas no servidor.

Entradas: OfferId (Offer Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Offer_ApproveVersion

Pública — Núcleo

Hire: Offer_ApproveVersion. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (OfferApproval Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### Offer_RejectVersion

Pública — Núcleo

Hire: Offer_RejectVersion. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (OfferApproval Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### Offer_Withdraw

Pública — Núcleo

Hire: Offer_Withdraw. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Offer Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### Offer_Expire

Pública — Núcleo

Hire: Offer_Expire. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Offer Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Offer_Decline

Pública — Núcleo

Hire: Offer_Decline. Autorizações e invariantes verificadas no servidor.

Entradas: VersionId (OfferVersion Identifier), Comment (Text).
Saídas: nenhuma.

### Offer_RequestNegotiation

Pública — Núcleo

Hire: Offer_RequestNegotiation. Autorizações e invariantes verificadas no servidor.

Entradas: VersionId (OfferVersion Identifier), Comment (Text).
Saídas: nenhuma.

### Offer_Accept

Pública — Núcleo

Hire: Offer_Accept. Autorizações e invariantes verificadas no servidor.

Entradas: VersionId (OfferVersion Identifier), RequestKey (Text).
Saídas: nenhuma.

### Hire_Confirm

Pública — Núcleo

Hire: Hire_Confirm. Autorizações e invariantes verificadas no servidor.

Entradas: ApplicationId (Application Identifier), VersionId (OfferVersion Identifier), RequestKey (Text).
Saídas: HireId (Hire Identifier).

### HireChecklist_Create

Pública — Núcleo

Hire: HireChecklist_Create. Autorizações e invariantes verificadas no servidor.

Entradas: HireId (Hire Identifier), Items (HireChecklistItem List).
Saídas: nenhuma.

### Hire_CompleteChecklistItem

Pública — Núcleo

Hire: Hire_CompleteChecklistItem. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (HireChecklistItem Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Hire_RecordStart

Pública — Núcleo

Hire: Hire_RecordStart. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Hire Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Hire_WithdrawBeforeStart

Pública — Núcleo

Hire: Hire_WithdrawBeforeStart. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Hire Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### Hire_Cancel

Pública — Núcleo

Hire: Hire_Cancel. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Hire Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### RecruitmentTask_Create

Pública — Núcleo

Hire: RecruitmentTask_Create. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (RecruitmentTask), ExpectedRevision (Integer).
Saídas: RecordId (RecruitmentTask Identifier), NewRevision (Integer).

### RecruitmentTask_Reassign

Pública — Núcleo

Hire: RecruitmentTask_Reassign. Autorizações e invariantes verificadas no servidor.

Entradas: TaskId (RecruitmentTask Identifier), MemberId (OrganizationMember Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### RecruitmentTask_Complete

Pública — Núcleo

Hire: RecruitmentTask_Complete. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (RecruitmentTask Identifier), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Notification_MarkRead

Pública — Núcleo

Hire: Notification_MarkRead. Autorizações e invariantes verificadas no servidor.

Entradas: NotificationId (Notification Identifier).
Saídas: nenhuma.

### Privacy_RecordChoice

Pública — Núcleo

Hire: Privacy_RecordChoice. Autorizações e invariantes verificadas no servidor.

Entradas: CandidateId (Candidate Identifier), NoticeVersionId (PrivacyNoticeVersion Identifier), PurposeId (PrivacyPurpose Identifier), ChoiceId (PrivacyAction Identifier).
Saídas: PrivacyRecordId (CandidatePrivacyRecord Identifier).

### CandidateDataRequest_Create

Pública — Núcleo

Hire: CandidateDataRequest_Create. Autorizações e invariantes verificadas no servidor.

Entradas: CandidateId (Candidate Identifier), RequestTypeId (DataRequestType Identifier).
Saídas: DataRequestId (CandidateDataRequest Identifier).

### CandidateDataRequest_Decide

Pública — Núcleo

Hire: CandidateDataRequest_Decide. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (CandidateDataRequest Identifier), ExpectedRevision (Integer), Reason (Text).
Saídas: NewRevision (Integer).

### DataRetentionPolicy_Save

Pública — Núcleo

Hire: DataRetentionPolicy_Save. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (DataRetentionPolicy), ExpectedRevision (Integer).
Saídas: RecordId (DataRetentionPolicy Identifier), NewRevision (Integer).

### Job_Search

Pública — Núcleo

Hire: Job_Search. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), StartIndex (Integer), PageSize (Integer).
Saídas: Items (JobOpening List).

### Candidate_Search

Pública — Núcleo

Hire: Candidate_Search. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), StartIndex (Integer), PageSize (Integer).
Saídas: Items (Candidate List).

### Application_Search

Pública — Núcleo

Hire: Application_Search. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), StartIndex (Integer), PageSize (Integer).
Saídas: Items (Application List).

### Interview_GetAgenda

Pública — Núcleo

Hire: Interview_GetAgenda. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), StartIndex (Integer), PageSize (Integer).
Saídas: Items (Interview List).

### Evaluation_GetPending

Pública — Núcleo

Hire: Evaluation_GetPending. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), StartIndex (Integer), PageSize (Integer).
Saídas: Items (Evaluation List).

### RecruitmentTask_GetInbox

Pública — Núcleo

Hire: RecruitmentTask_GetInbox. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), StartIndex (Integer), PageSize (Integer).
Saídas: Items (RecruitmentTask List).

### Job_GetDetail

Pública — Núcleo

Hire: Job_GetDetail. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (JobOpening Identifier).
Saídas: Item (JobOpening).

### Candidate_GetProfile

Pública — Núcleo

Hire: Candidate_GetProfile. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Candidate Identifier).
Saídas: Item (Candidate).

### Application_GetDetail

Pública — Núcleo

Hire: Application_GetDetail. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Application Identifier).
Saídas: Item (Application).

### Offer_GetDetail

Pública — Núcleo

Hire: Offer_GetDetail. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Offer Identifier).
Saídas: Item (Offer).

### Hire_GetDetail

Pública — Núcleo

Hire: Hire_GetDetail. Autorizações e invariantes verificadas no servidor.

Entradas: RecordId (Hire Identifier).
Saídas: Item (Hire).

### TalentPool_GetCandidates

Pública — Núcleo

Hire: TalentPool_GetCandidates. Autorizações e invariantes verificadas no servidor.

Entradas: TalentPoolId (TalentPool Identifier), StartIndex (Integer), PageSize (Integer).
Saídas: Items (Candidate List).

### Application_GetTimeline

Pública — Núcleo

Hire: Application_GetTimeline. Autorizações e invariantes verificadas no servidor.

Entradas: ApplicationId (Application Identifier).
Saídas: StatusHistory (ApplicationStatusHistory List), StageHistory (ApplicationStageHistory List).

### CandidatePortal_GetMyApplications

Pública — Núcleo

Hire: CandidatePortal_GetMyApplications. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), StartIndex (Integer), PageSize (Integer).
Saídas: Items (HirePortalApplication List).

### Recruitment_GetMetrics

Pública — Núcleo

Hire: Recruitment_GetMetrics. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), FromDate (Date Time), ToDate (Date Time).
Saídas: Metrics (HireMetrics).

### Candidate_LinkAccount

Pública — INDISPONÍVEL

INDISPONÍVEL: Verificação de identidade ainda não configurada. Falha antes de alterar dados ou executar efeitos externos.

Entradas: RecordId (Candidate Identifier).
Saídas: nenhuma.

### CandidateDocument_RequestUpload

Pública — INDISPONÍVEL

INDISPONÍVEL: Provedor de arquivos e inspeção não configurado. Falha antes de alterar dados ou executar efeitos externos.

Entradas: RecordId (Candidate Identifier).
Saídas: nenhuma.

### CandidateDocument_ConfirmUpload

Pública — INDISPONÍVEL

INDISPONÍVEL: Provedor de arquivos e inspeção não configurado. Falha antes de alterar dados ou executar efeitos externos.

Entradas: RecordId (Candidate Identifier).
Saídas: nenhuma.

### CandidateDocument_GetDownload

Pública — INDISPONÍVEL

INDISPONÍVEL: Provedor de arquivos não configurado. Falha antes de alterar dados ou executar efeitos externos.

Entradas: RecordId (CandidateDocument Identifier).
Saídas: nenhuma.

### JobPublication_RequestPublish

Pública — INDISPONÍVEL

INDISPONÍVEL: Provedor de publicação não configurado. Falha antes de alterar dados ou executar efeitos externos.

Entradas: RecordId (JobOpening Identifier).
Saídas: nenhuma.

### JobPublication_RequestWithdraw

Pública — INDISPONÍVEL

INDISPONÍVEL: Provedor de publicação não configurado. Falha antes de alterar dados ou executar efeitos externos.

Entradas: RecordId (JobPublication Identifier).
Saídas: nenhuma.

### Offer_Send

Pública — INDISPONÍVEL

INDISPONÍVEL: Provedor de comunicação não configurado. Falha antes de alterar dados ou executar efeitos externos.

Entradas: RecordId (Offer Identifier).
Saídas: nenhuma.

### Communication_RequestSend

Pública — INDISPONÍVEL

INDISPONÍVEL: Provedor de comunicação não configurado. Falha antes de alterar dados ou executar efeitos externos.

Entradas: RecordId (Candidate Identifier).
Saídas: nenhuma.

### Communication_RecordInbound

Pública — INDISPONÍVEL

INDISPONÍVEL: Provedor de comunicação e autenticação de webhook não configurados. Falha antes de alterar dados ou executar efeitos externos.

Entradas: RecordId (Candidate Identifier).
Saídas: nenhuma.

### CandidateDataRequest_Execute

Pública — INDISPONÍVEL

INDISPONÍVEL: Procedimento de tratamento de dados exige configuração aprovada. Falha antes de alterar dados ou executar efeitos externos.

Entradas: RecordId (CandidateDataRequest Identifier).
Saídas: nenhuma.

### Outbox_ProcessBatch

Pública — INDISPONÍVEL

INDISPONÍVEL: rotina não ativada. Não processa nem marca eventos como concluídos.

Entradas: nenhuma.
Saídas: nenhuma.

### Outbox_RetryFailed

Pública — INDISPONÍVEL

INDISPONÍVEL: rotina não ativada. Não processa nem marca eventos como concluídos.

Entradas: nenhuma.
Saídas: nenhuma.

### Interview_SendReminders

Pública — INDISPONÍVEL

INDISPONÍVEL: rotina não ativada. Não processa nem marca eventos como concluídos.

Entradas: nenhuma.
Saídas: nenhuma.

### Evaluation_SendReminders

Pública — INDISPONÍVEL

INDISPONÍVEL: rotina não ativada. Não processa nem marca eventos como concluídos.

Entradas: nenhuma.
Saídas: nenhuma.

### RecruitmentTask_CheckOverdue

Pública — INDISPONÍVEL

INDISPONÍVEL: rotina não ativada. Não processa nem marca eventos como concluídos.

Entradas: nenhuma.
Saídas: nenhuma.

### Application_CheckStageSLA

Pública — INDISPONÍVEL

INDISPONÍVEL: rotina não ativada. Não processa nem marca eventos como concluídos.

Entradas: nenhuma.
Saídas: nenhuma.

### Retention_PlanBatch

Pública — INDISPONÍVEL

INDISPONÍVEL: rotina não ativada. Não processa nem marca eventos como concluídos.

Entradas: nenhuma.
Saídas: nenhuma.

### Retention_ExecuteApprovedBatch

Pública — INDISPONÍVEL

INDISPONÍVEL: rotina não ativada. Não processa nem marca eventos como concluídos.

Entradas: nenhuma.
Saídas: nenhuma.

### Application_SaveAnswers

Pública — Núcleo

Hire: Application_SaveAnswers. Autorizações e invariantes verificadas no servidor.

Entradas: ApplicationId (Application Identifier), Answers (ApplicationAnswer List), Choices (HireAnswerChoice List), ExpectedRevision (Integer).
Saídas: NewRevision (Integer).

### Candidate_MergeDuplicates

Pública — Núcleo

Hire: Candidate_MergeDuplicates. Autorizações e invariantes verificadas no servidor.

Entradas: SurvivorId (Candidate Identifier), DuplicateId (Candidate Identifier), Reason (Text).
Saídas: nenhuma.

### Assessment_ExpirePending

Pública — Núcleo

Hire: Assessment_ExpirePending. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier).
Saídas: Processed (Integer).

### JobPublication_ExpirePending

Pública — Núcleo

Hire: JobPublication_ExpirePending. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier).
Saídas: Processed (Integer).

### Offer_ExpirePending

Pública — Núcleo

Hire: Offer_ExpirePending. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier).
Saídas: Processed (Integer).

### HireApprovalRule_Save

Pública — Núcleo

Hire: HireApprovalRule_Save. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (HireApprovalRule).
Saídas: RecordId (HireApprovalRule Identifier).

### JobStageTransition_Save

Pública — Núcleo

Hire: JobStageTransition_Save. Autorizações e invariantes verificadas no servidor.

Entradas: OrganizationId (Organization Identifier), Input (JobStageTransition).
Saídas: RecordId (JobStageTransition Identifier).


## Dados de apoio

O job acrescenta Revision às 65 entidades de negócio e cria HireRequest, JobApprovalRevision, JobStageTransition, HireApprovalRule, HirePositionReservation, CandidateMergeHistory, InterviewScheduleHistory e JobApprovalHistory. Ciclos anteriores de aprovação são arquivados antes de uma nova submissão.

## Validação

O modelo validado possui 172 actions (127 públicas e 45 privadas), com 18 contratos explicitamente indisponíveis. Oito testes de contrato cobrem identidade, projeção do portal, campos controlados pelo servidor, idempotência, revisão e ausência de efeitos nos pontos indisponíveis. A validação final incremental eliminou os seis erros de expressão remanescentes e terminou com zero mensagens.

## Entrega no SS4

2026-09-05: entregue em um merge ao Hire_CS; 172 server actions e TrueChange sem erros ou avisos. Não publicado. Evidência local: `.local/work/deliver/8743cf27b37a46dcab3347d4625f9e0d/result.json`.
